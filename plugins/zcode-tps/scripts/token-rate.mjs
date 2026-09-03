#!/usr/bin/env node
// Token 输出速率与用量统计:从 ZCode 自身的 usage 数据库(model_usage / turn_usage 表)计算。
// 基于 shy3130/zcode-tps-monitor 0.7.0 (MIT) 修改:增加本轮 token、会话累计、缓存命中率。
// 用法:
//   node token-rate.mjs            速率行 + 会话统计(人类可读)
//   node token-rate.mjs --json     JSON 输出
//   ZCODE_SESSION_ID=xxx node ...  只统计指定会话
//   ZCODE_USAGE_DB=/path/db.sqlite 指定数据库路径(默认按用户主目录解析)
// 只读打开 WAL 数据库,不影响运行中的客户端。

// 抑制 node:sqlite 的 ExperimentalWarning 噪音:必须在动态 import 之前接管 warning 通道
// (静态 import 的内置模块在模块体执行前就已求值,届时再监听就晚了)。
process.removeAllListeners("warning");
process.on("warning", () => {});

const { DatabaseSync } = await import("node:sqlite");
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 跨平台默认路径(macOS/Linux: ~/.zcode/...;Windows: %USERPROFILE%\.zcode\...),可用 ZCODE_USAGE_DB 覆盖
const DB_PATH =
  process.env.ZCODE_USAGE_DB ||
  path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const HIST = Number(process.env.TOKEN_RATE_HIST) || 60;         // history 曲线点数(最近请求明细)
const MIN_GEN_MS = Number(process.env.TOKEN_RATE_MIN_MS) || 200;      // 有效样本:最短生成耗时
const MAX_GEN_MS = Number(process.env.TOKEN_RATE_MAX_MS) || 3_600_000; // 有效样本:最长生成耗时(1h)

function readLastSessionState(file) {
  try {
    const st = JSON.parse(fs.readFileSync(file, "utf8"));
    if (st && typeof st.sessionId === "string" && st.sessionId) return st;
  } catch {}
  return null;
}

// S1:自动会话识别必须优先 main_turn,不能被更新的子代理行劫持。
// 顺序:显式 sid > last-session 文件(新会话/同会话,以时间新鲜度+是否有数据判断) > 最新 main_turn > 最新任意行。
function resolveAutoSid(db, lastSessionFile) {
  const st = readLastSessionState(lastSessionFile);
  if (st) {
    let hasData = false;
    try {
      hasData = !!db.prepare("SELECT 1 FROM model_usage WHERE session_id = ? LIMIT 1").get(st.sessionId);
    } catch {}
    if (!hasData) {
      try {
        hasData = !!db.prepare("SELECT 1 FROM turn_usage WHERE session_id = ? LIMIT 1").get(st.sessionId);
      } catch {}
    }
    const ageMs = Date.now() - (Number(st.ts) || 0);
    // 有数据直接采用;无数据仅当文件很新(新会话,钩子刚写入)时采用,避免陈旧文件屏蔽正常回退
    if (hasData || ageMs < 2 * 3600 * 1000) return { sid: st.sessionId, scoped: "file" };
  }
  try {
    const row = db
      .prepare("SELECT session_id FROM model_usage WHERE status = 'completed' AND query_source = 'main_turn' ORDER BY completed_at DESC LIMIT 1")
      .get();
    if (row && row.session_id) return { sid: row.session_id, scoped: "auto-main" };
  } catch {}
  const row = db
    .prepare("SELECT session_id FROM model_usage WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1")
    .get();
  return { sid: row ? row.session_id : null, scoped: "auto" };
}

// S3:读锁等待 + 忙时重试一次。ZCode 写库期间(WAL checkpoint)只读连接可能撞 SQLITE_BUSY,
// 钩子每消息同步执行且超时 8s,直接抛错会导致本轮速率行静默丢失,等 150ms 重试一次可扛住短暂 contention。
const BUSY_TIMEOUT_MS = 2000;
const BUSY_RETRY_WAIT_MS = 150;

function openDb() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch {}
  return db;
}

function isBusyError(e) {
  const s = `${e?.code ?? ""} ${e?.message ?? ""}`;
  return /BUSY|LOCKED/i.test(s);
}

function sleepMsSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

function withBusyRetry(fn) {
  try {
    return fn();
  } catch (e) {
    if (!isBusyError(e)) throw e;
    sleepMsSync(BUSY_RETRY_WAIT_MS);
    return fn();
  }
}

function query(sessionId, opts = {}) {
  // includeSubagents:把主会话派生的子代理(subagent)请求并入会话级统计,默认开启。
  // 归因键为 trace_id(主回复与其全部子代理共享同一 trace;parent/turn 字段经验证不指向主会话)。
  const includeSub = opts.includeSubagents !== false;
  const lastSessionFile =
    opts.lastSessionFile ||
    process.env.ZCODE_TPS_LAST_SESSION ||
    path.join(os.homedir(), ".zcode", "zcode-tps.last-session.json");
  return withBusyRetry(() => queryOnce(sessionId, includeSub, lastSessionFile));
}

function queryOnce(sessionId, includeSub, lastSessionFile) {
  const db = openDb();
  try {
    // 未显式指定会话时,按 resolveAutoSid 回退链识别当前会话(见上)
    let sid = sessionId;
    let scoped = sessionId ? "explicit" : "auto";
    if (!sid) {
      const r = resolveAutoSid(db, lastSessionFile);
      sid = r.sid;
      scoped = r.scoped;
    }
    const args = [];
    const base =
      "SELECT model_id, output_tokens, reasoning_tokens, input_tokens, cache_read_input_tokens," +
      " first_token_at, completed_at, time_to_first_token_ms, status" +
      " FROM model_usage WHERE status = 'completed' AND query_source = 'main_turn'";
    if (sid) {
      args.push(sid);
    }
    // 主对话优先:无 main_turn 数据时回退为全部请求
    const hasMain = db
      .prepare(base + (sid ? " AND session_id = ?" : "") + " LIMIT 1")
      .get(...(sid ? [sid] : []));
    const scopeSql = hasMain
      ? base + " AND session_id = ?"
      : base.replace(" AND query_source = 'main_turn'", "") + (sid ? " AND session_id = ?" : "");
    // 曲线历史(大窗口)与统计(小窗口)分别查询,刷新/重开不丢
    const histRows = db.prepare(scopeSql + " ORDER BY completed_at DESC LIMIT ?").all(...args, HIST);
    const items = histRows.map((r) => {
      const tok = r.output_tokens ?? 0;
      const reasoning = r.reasoning_tokens ?? 0;
      // 部分行(如非流式/中断请求)缺 first_token_at,须判无效
      const hasTime = Number.isFinite(r.first_token_at) && Number.isFinite(r.completed_at) && r.completed_at > r.first_token_at;
      const genMs = hasTime ? r.completed_at - r.first_token_at : null; // 纯生成耗时(不含首 token 等待)
      // 速率分子含思考 token:思考内容同样是流式输出,ZCode 未单独记录时该列为 0,行为不变
      const rateTokens = tok + reasoning;
      const valid = genMs != null && genMs >= MIN_GEN_MS && genMs < MAX_GEN_MS && rateTokens > 0;
      return {
        model: r.model_id,
        outputTokens: tok,
        reasoningTokens: reasoning,
        inputTokens: r.input_tokens ?? 0,
        cacheRead: r.cache_read_input_tokens ?? 0,
        ttftMs: Number.isFinite(r.time_to_first_token_ms) ? r.time_to_first_token_ms : null,
        genMs,
        tokPerSec: valid ? Math.round((rateTokens / genMs) * 10000) / 10 : null,
        completedAt: r.completed_at,
      };
    });
    // 展示用 latest 优先取最近一条"有效"记录,避免在途/缺字段行顶掉头条
    const latest = (items.find((i) => i.tokPerSec != null)) ?? items[0] ?? null;
    // 会话累计 token 用独立 SUM(不受流式有效性限制)
    const sumRow = db
      .prepare(
        "SELECT COUNT(*) n, SUM(output_tokens) o, SUM(reasoning_tokens) r," +
        " SUM(input_tokens) i, SUM(cache_read_input_tokens) c FROM (" + scopeSql + ")"
      )
      .get(...args);
    // 会话级加权速率:Σ(输出+思考) ÷ Σ(纯生成时长),只统计有效请求,覆盖全量行(不受 HIST 窗口限制)
    // 有效性边界与 JS 端保持同一半开区间 [MIN_GEN_MS, MAX_GEN_MS),参数化传入
    const aggrRow = db
      .prepare(
        "SELECT COUNT(*) n, SUM(output_tokens + reasoning_tokens) tok," +
        " SUM(completed_at - first_token_at) gen FROM (" + scopeSql + ")" +
        " WHERE first_token_at IS NOT NULL AND completed_at > first_token_at" +
        " AND (completed_at - first_token_at) >= ? AND (completed_at - first_token_at) < ?" +
        " AND (output_tokens + reasoning_tokens) > 0"
      )
      .get(...args, MIN_GEN_MS, MAX_GEN_MS);

    // ---- 子代理归因:trace_id 与主会话 main_turn 请求相同的 subagent 请求 ----
    // 独立降级边界:trace 列缺失等情况只影响子代理口径,主对话统计不受影响
    let subAggr = null;
    let subSum = null;
    if (includeSub && sid) {
      try {
        // 注意:不能用 base 包裹子查询(base 的列清单不含 trace_id),直接过滤 model_usage
        const traceListSql =
          "SELECT DISTINCT trace_id FROM model_usage" +
          " WHERE status = 'completed' AND query_source = 'main_turn'" +
          " AND session_id = ? AND trace_id IS NOT NULL";
        subAggr = db
          .prepare(
            "SELECT COUNT(*) n, SUM(output_tokens + reasoning_tokens) tok," +
            " SUM(completed_at - first_token_at) gen FROM model_usage" +
            " WHERE status = 'completed' AND query_source = 'subagent' AND trace_id IS NOT NULL" +
            " AND trace_id IN (" + traceListSql + ")" +
            " AND first_token_at IS NOT NULL AND completed_at > first_token_at" +
            " AND (completed_at - first_token_at) >= ? AND (completed_at - first_token_at) < ?" +
            " AND (output_tokens + reasoning_tokens) > 0"
          )
          .get(sid, MIN_GEN_MS, MAX_GEN_MS);
        if (subAggr?.n) {
          subSum = db
            .prepare(
              "SELECT COUNT(*) n, SUM(output_tokens) o, SUM(reasoning_tokens) r," +
              " SUM(input_tokens) i, SUM(cache_read_input_tokens) c FROM model_usage" +
              " WHERE status = 'completed' AND query_source = 'subagent' AND trace_id IS NOT NULL" +
              " AND trace_id IN (" + traceListSql + ")"
            )
            .get(sid);
        }
      } catch {
        subAggr = null;
        subSum = null; // trace 归因不可用时静默降级
      }
    }
    const useSub = !!(includeSub && subAggr?.n && subSum);

    const session = {
      requests: (sumRow.n ?? 0) + (useSub ? subSum.n : 0),
      // S2:有效样本数须与 avgTps 口径一致(含并入的子代理有效请求)
      samples: (aggrRow?.n ?? 0) + (useSub ? subAggr.n ?? 0 : 0),
      avgTps: null,
      includesSubagents: useSub,
      subagent: useSub
        ? {
            requests: subSum.n ?? 0,
            output: subSum.o ?? 0,
            reasoning: subSum.r ?? 0,
            input: subSum.i ?? 0,
            cacheRead: subSum.c ?? 0,
            avgTps: subAggr.gen ? Math.round((subAggr.tok / subAggr.gen) * 10000) / 10 : null,
          }
        : null,
      totalOutput: (sumRow.o ?? 0) + (useSub ? subSum.o ?? 0 : 0),
      totalReasoning: (sumRow.r ?? 0) + (useSub ? subSum.r ?? 0 : 0),
      totalInput: (sumRow.i ?? 0) + (useSub ? subSum.i ?? 0 : 0),
      totalCacheRead: (sumRow.c ?? 0) + (useSub ? subSum.c ?? 0 : 0),
    };
    {
      // 会话均:主对话 + (可选)子代理,统一加权口径
      const tok = (aggrRow?.tok ?? 0) + (useSub ? subAggr.tok : 0);
      const gen = (aggrRow?.gen ?? 0) + (useSub ? subAggr.gen : 0);
      const n = (aggrRow?.n ?? 0) + (useSub ? subAggr.n : 0);
      if (n) session.avgTps = Math.round((tok / gen) * 10000) / 10;
    }

    // ---- turn_usage:上一轮与会话累计(输入含缓存读,computed_total = 输入 + 输出) ----
    // 独立降级边界:表缺失/列变更只影响这三项,tok/s 等核心指标不受影响
    let turn = null;
    let usage = null;
    let cacheHit = null;
    if (sid) {
      try {
        const t = db
        .prepare(
          "SELECT turn_id, input_tokens i, output_tokens o, reasoning_tokens r," +
          " cache_creation_input_tokens cc, cache_read_input_tokens cr, computed_total_tokens total," +
          " duration_ms dur, model_request_count reqs, completed_at" +
          " FROM turn_usage WHERE session_id = ? AND status = 'completed'" +
          " ORDER BY completed_at DESC LIMIT 1"
        )
        .get(sid);
      if (t && Number.isFinite(t.total) && t.total > 0) {
        turn = {
          turnId: t.turn_id,
          input: t.i ?? 0,
          output: t.o ?? 0,
          reasoning: t.r ?? 0,
          cacheRead: t.cr ?? 0,
          cacheCreation: t.cc ?? 0,
          total: t.total,
          durationMs: t.dur,
          requests: t.reqs,
          completedAt: t.completed_at,
          cacheHit: t.i ? Math.round(((t.cr ?? 0) / t.i) * 1000) / 10 : null,
        };
        // 轮次级加权速率:该轮全部有效请求的 Σ(输出+思考) ÷ Σ(纯生成时长)
        // 复用 scopeSql 以继承"无 main_turn 数据时回退全部请求"的策略
        const ta = db
          .prepare(
            "SELECT COUNT(*) n, SUM(output_tokens + reasoning_tokens) tok," +
            " SUM(completed_at - first_token_at) gen FROM (" + scopeSql + " AND turn_id = ?)" +
            " WHERE first_token_at IS NOT NULL AND completed_at > first_token_at" +
            " AND (completed_at - first_token_at) >= ? AND (completed_at - first_token_at) < ?" +
            " AND (output_tokens + reasoning_tokens) > 0"
          )
          .get(...args, t.turn_id, MIN_GEN_MS, MAX_GEN_MS);
        if (ta?.n) turn.avgTps = Math.round((ta.tok / ta.gen) * 10000) / 10;
      }
      const u = db
        .prepare(
          "SELECT COUNT(*) turns, SUM(input_tokens) i, SUM(output_tokens) o, SUM(reasoning_tokens) r," +
          " SUM(cache_creation_input_tokens) cc, SUM(cache_read_input_tokens) cr," +
          " SUM(computed_total_tokens) total FROM turn_usage WHERE session_id = ? AND status = 'completed'"
        )
        .get(sid);
      if (u && Number.isFinite(u.turns) && u.turns > 0) {
        usage = {
          // S2:turn_usage 无子代理归因,恒为主对话口径(与含子的 session.avgTps 区分)
          scope: "main_turn",
          turns: u.turns,
          input: u.i ?? 0,
          output: u.o ?? 0,
          reasoning: u.r ?? 0,
          cacheRead: u.cr ?? 0,
          cacheCreation: u.cc ?? 0,
          total: u.total ?? 0,
        };
        cacheHit = usage.input ? Math.round((usage.cacheRead / usage.input) * 1000) / 10 : null;
      }
      } catch {
        // turn_usage 表缺失或结构变更:仅放弃本轮/会话累计/缓存命中率三项,核心速率不受影响
      }
    }

    return { sessionId: sid, scoped, latest, session, turn, usage, cacheHit, history: items };
  } finally {
    db.close();
  }
}

function fmtK(n) {
  if (n == null) return "-";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 10000) return Math.round(n / 1000) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function formatLine(r) {
  const l = r.latest;
  if (!l) return "暂无已完成的模型请求";
  const t = new Date(l.completedAt).toLocaleTimeString("zh-CN", { hour12: false });
  // 三级加权速率:请求级(最近一次) / 轮次级(上一轮全部有效请求) / 会话级(全部有效请求)
  const rates = [];
  if (l.tokPerSec != null) rates.push(`最近 ${l.tokPerSec}`);
  if (r.turn?.avgTps != null) rates.push(`上轮均 ${r.turn.avgTps}`);
  if (r.session?.avgTps != null) rates.push(`会话均 ${r.session.avgTps}`);
  const parts = [`⚡ ${rates.length ? rates.join(" · ") : "-"} tok/s`];
  if (l.ttftMs != null) {
    // 附上最后请求的上下文规模:首字延迟与它强相关,帮助区分"模型慢"和"上下文大"
    const ctx = l.inputTokens ? `·ctx ${fmtK(l.inputTokens)}` : "";
    parts.push(`首字 ${(l.ttftMs / 1000).toFixed(1)}s${ctx}`);
  }
  if (r.turn) parts.push(`上轮 读 ${fmtK(r.turn.input)}(出 ${fmtK(r.turn.output)})`);
  if (r.usage) {
    // S2:会话均已并入子代理时,会话 tok/缓存仍是主对话口径,须标注避免误导
    const scopeSuffix = r.session?.includesSubagents ? "(主)" : "";
    parts.push(`会话 ${fmtK(r.usage.total)} tok${scopeSuffix}`);
    if (r.cacheHit != null) parts.push(`缓存 ${r.cacheHit}%${scopeSuffix}`);
  }
  parts.push(`⏱ ${t}`);
  return parts.join(" · ");
}

// --- CLI ---
if (process.argv[1] && process.argv[1].endsWith("token-rate.mjs")) {
  const json = process.argv.includes("--json");
  const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  const cfg = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".zcode", "zcode-tps.config.json"), "utf8"));
    } catch {
      return {};
    }
  })();
  const r = (() => {
    try {
      return { ok: true, value: query(sid, { includeSubagents: cfg.includeSubagents !== false }) };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  })();
  if (!r.ok) {
    // S3:优雅错误——/tps agent 只消费 stdout,--json 仍给机器可解析的错误对象而非堆栈
    if (json) {
      console.log(JSON.stringify({ error: r.error, db: DB_PATH }, null, 2));
    } else {
      console.error(`token-rate 查询失败:${r.error}`);
      console.error(`数据库:${DB_PATH}(可用 ZCODE_USAGE_DB 指定,自检见 /tps-doctor)`);
    }
    process.exitCode = 1;
  } else {
    const q = r.value;
    if (json) {
      console.log(JSON.stringify(q, null, 2));
    } else {
      console.log(formatLine(q));
      const s = q.session;
      if (s) {
        console.log(`请求累计(含进行中轮):输出 ${s.totalOutput}${s.totalReasoning ? `(+${s.totalReasoning} 思考)` : ""} tok · 输入 ${fmtK(s.totalInput)} tok(其中缓存读 ${fmtK(s.totalCacheRead)}) · 请求 ${s.requests} 次`);
      }
      if (q.turn) {
        const t = q.turn;
        console.log(`上一轮(已完成):输入 ${fmtK(t.input)} + 输出 ${fmtK(t.output)} = ${fmtK(t.total)} tok · ${t.requests} 次请求 / ${(t.durationMs / 1000).toFixed(1)}s · 缓存命中 ${t.cacheHit ?? "-"}%`);
      }
      if (q.usage) {
        const scopeNote = q.session?.includesSubagents ? ",主对话口径" : "";
        console.log(`会话用量(已完成轮${scopeNote}):${q.usage.turns} 轮 · 总计 ${fmtK(q.usage.total)} tok(输入 ${fmtK(q.usage.input)} / 输出 ${fmtK(q.usage.output)}${q.usage.reasoning ? ` / 思考 ${fmtK(q.usage.reasoning)}` : ""}) · 缓存命中率 ${q.cacheHit ?? "-"}%`);
      }
      if (q.session.subagent) {
        console.log(`子代理归因:并入 ${q.session.subagent.requests} 次请求 / 输出 ${fmtK(q.session.subagent.output)} tok(子代理均 ${q.session.subagent.avgTps ?? "-"} tok/s) · 配置 includeSubagents:false 可切回纯主对话口径`);
      }
    }
  }
}

export { query, formatLine, openDb, withBusyRetry };
