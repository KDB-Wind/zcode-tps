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
import os from "node:os";
import path from "node:path";

// 跨平台默认路径(macOS/Linux: ~/.zcode/...;Windows: %USERPROFILE%\.zcode\...),可用 ZCODE_USAGE_DB 覆盖
const DB_PATH =
  process.env.ZCODE_USAGE_DB ||
  path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const HIST = Number(process.env.TOKEN_RATE_HIST) || 60;         // history 曲线点数(最近请求明细)
const MIN_GEN_MS = Number(process.env.TOKEN_RATE_MIN_MS) || 200;      // 有效样本:最短生成耗时
const MAX_GEN_MS = Number(process.env.TOKEN_RATE_MAX_MS) || 3_600_000; // 有效样本:最长生成耗时(1h)

function query(sessionId) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    // 未显式指定会话时,取最近一次完成请求所属的会话 = 当前会话
    let sid = sessionId;
    let scoped = sessionId ? "explicit" : "auto";
    if (!sid) {
      const row = db
        .prepare("SELECT session_id FROM model_usage WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1")
        .get();
      sid = row ? row.session_id : null;
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
    const session = {
      requests: sumRow.n ?? 0,
      samples: aggrRow?.n ?? 0,
      avgTps: aggrRow?.n ? Math.round((aggrRow.tok / aggrRow.gen) * 10000) / 10 : null,
      totalOutput: sumRow.o ?? 0,
      totalReasoning: sumRow.r ?? 0,
      totalInput: sumRow.i ?? 0,
      totalCacheRead: sumRow.c ?? 0,
    };

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
    parts.push(`会话 ${fmtK(r.usage.total)} tok`);
    if (r.cacheHit != null) parts.push(`缓存 ${r.cacheHit}%`);
  }
  parts.push(`⏱ ${t}`);
  return parts.join(" · ");
}

// --- CLI ---
if (process.argv[1] && process.argv[1].endsWith("token-rate.mjs")) {
  const json = process.argv.includes("--json");
  const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  const r = query(sid);
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(formatLine(r));
    const s = r.session;
    if (s) {
      console.log(`请求累计(含进行中轮):输出 ${s.totalOutput}${s.totalReasoning ? `(+${s.totalReasoning} 思考)` : ""} tok · 输入 ${fmtK(s.totalInput)} tok(其中缓存读 ${fmtK(s.totalCacheRead)}) · 请求 ${s.requests} 次`);
    }
    if (r.turn) {
      const t = r.turn;
      console.log(`上一轮(已完成):输入 ${fmtK(t.input)} + 输出 ${fmtK(t.output)} = ${fmtK(t.total)} tok · ${t.requests} 次请求 / ${(t.durationMs / 1000).toFixed(1)}s · 缓存命中 ${t.cacheHit ?? "-"}%`);
    }
    if (r.usage) {
      console.log(`会话用量(已完成轮):${r.usage.turns} 轮 · 总计 ${fmtK(r.usage.total)} tok(输入 ${fmtK(r.usage.input)} / 输出 ${fmtK(r.usage.output)}${r.usage.reasoning ? ` / 思考 ${fmtK(r.usage.reasoning)}` : ""}) · 缓存命中率 ${r.cacheHit ?? "-"}%`);
    }
  }
}

export { query, formatLine };
