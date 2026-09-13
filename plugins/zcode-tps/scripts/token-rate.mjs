#!/usr/bin/env node
// Token 输出速率与用量统计:从 ZCode 自身的 usage 数据库(model_usage 表)计算。
// 基于 shy3130/zcode-tps-monitor 0.7.0 (MIT) 修改:增加本轮 token、会话累计、缓存命中率。
// 用法:
//   node token-rate.mjs            速率行 + 会话统计(人类可读)
//   node token-rate.mjs --json     JSON 输出
//   ZCODE_SESSION_ID=xxx node ...  只统计指定会话
//   ZCODE_USAGE_DB=/path/db.sqlite 指定数据库路径(默认按用户主目录解析)
// 只读打开 WAL 数据库,不影响运行中的客户端。

// Runtime warnings remain on stderr; importing this module must not alter other warning listeners.

let DatabaseSync;
let sqliteError;
try { ({ DatabaseSync } = await import("node:sqlite")); }
catch (e) { sqliteError = e; }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectSchema, parseBool, querySettings, readConfig, validId, validIdSql, parseJson, resolveTimezone, formatInZone, zoneOffsetLabel } from "./runtime.mjs";

// 跨平台默认路径(macOS/Linux: ~/.zcode/...;Windows: %USERPROFILE%\.zcode\...),可用 ZCODE_USAGE_DB 覆盖
const DB_PATH =
  process.env.ZCODE_USAGE_DB ||
  path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
// 仅用于 /tps 的 0.3 旧值对比,不可复用新的总时长门槛。
const LEGACY_MIN_GEN_MS = 200;
const LEGACY_MAX_GEN_MS = 3_600_000;
const DURATION_SQL = "COALESCE(duration_ms, completed_at - started_at)";
// Decode 窗口:请求总时长减去首 token 等待;TTFT 缺失时回退 first_token_at - started_at,两者皆缺则为 NULL(不参与统计)。
// 与智谱官方"高峰期平均 Decode 速度"同口径:只计纯生成阶段,排队/预填充不计入分母。
const DECODE_SQL = "COALESCE(time_to_first_token_ms, first_token_at - started_at)";
// 请求级 Decode 有效性的解码窗口下限:总时长已过 MIN_DURATION_MS 门槛,但几乎全花在等待首字时解码窗口过短,速率失真。
const DECODE_MIN_MS = 200;

function rateTps(tokens, durationMs) {
  return Math.round((tokens / durationMs) * 10000) / 10;
}

function readLastSessionState(file) {
  try {
    const st = parseJson(fs.readFileSync(file, "utf8"));
    if (st && validId(st.sessionId)) return st;
  } catch {}
  return null;
}

// S1:自动会话识别必须优先 main_turn,不能被更新的子代理行劫持。
// 顺序:显式 sid > 两小时内的 last-session 文件 > 最新 main_turn > 最新任意行。
function resolveAutoSid(db, lastSessionFile) {
  const st = readLastSessionState(lastSessionFile);
  if (st) {
    const ageMs = Date.now() - (Number(st.ts) || 0);
    // Fresh hook state also identifies a new session with no usage yet. Old/future state never pins a session.
    if (ageMs >= 0 && ageMs < 2 * 3600 * 1000) return { sid: st.sessionId, scoped: "file" };
  }
  try {
    const row = db
      .prepare("SELECT session_id FROM model_usage WHERE status = 'completed' AND query_source = 'main_turn' AND " + validIdSql("session_id") + " ORDER BY completed_at DESC LIMIT 1")
      .get();
    if (row && row.session_id) return { sid: row.session_id, scoped: "auto-main" };
  } catch (e) { if (isBusyError(e)) throw e; }
  const row = db
    .prepare("SELECT session_id FROM model_usage WHERE status = 'completed' AND " + validIdSql("session_id") + " ORDER BY completed_at DESC LIMIT 1")
    .get();
  return { sid: row ? row.session_id : null, scoped: "auto" };
}

// S3:读锁等待 + 忙时重试一次。ZCode 写库期间(WAL checkpoint)只读连接可能撞 SQLITE_BUSY,
// 钩子每消息同步执行且超时 8s,直接抛错会导致本轮速率行静默丢失,等 150ms 重试一次可扛住短暂 contention。
const BUSY_TIMEOUT_MS = 2000;
const BUSY_RETRY_WAIT_MS = 150;

function openDb() {
  if (sqliteError) throw new Error(`node:sqlite 不可用,请使用 Node 22.13+ 或 24+: ${sqliteError.message}`);
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
  if (sessionId != null && !validId(sessionId)) throw new Error("显式会话 sessionId 必须为非空字符串");
  // includeSubagents:把主会话派生的子代理(subagent)请求并入会话级统计,默认开启。
  // 归因键为 trace_id(主回复与其全部子代理共享同一 trace;parent/turn 字段经验证不指向主会话)。
  // timezone:显示时区配置(默认 Asia/Shanghai,可设 "UTC"/"system"/IANA 名),环境变量 ZCODE_TPS_TIMEZONE 优先。
  const includeSub = parseBool(opts.includeSubagents, true);
  const timezoneOption = process.env.ZCODE_TPS_TIMEZONE ?? opts.timezone;
  const lastSessionFile =
    opts.lastSessionFile ||
    process.env.ZCODE_TPS_LAST_SESSION ||
    path.join(os.homedir(), ".zcode", "zcode-tps.last-session.json");
  return withBusyRetry(() => queryOnce(sessionId, includeSub, lastSessionFile, timezoneOption));
}

function queryOnce(sessionId, includeSub, lastSessionFile, timezoneOption) {
  const { history: HIST, min: MIN_DURATION_MS, max: MAX_DURATION_MS } = querySettings();
  const db = openDb();
  try {
    db.exec("BEGIN");
    const schema = inspectSchema(db);
    if (schema.missing.length) throw new Error(`model_usage 缺少列: ${schema.missing.join(", ")}`);
    const sampledAt = Date.now();
    const warnings = [...schema.warnings];
    const timezone = resolveTimezone(timezoneOption, warnings);
    const utcOffset = zoneOffsetLabel(timezone, sampledAt);
    const inZone = (ms) => formatInZone(ms, timezone);
    // 未显式指定会话时,按 resolveAutoSid 回退链识别当前会话(见上)
    let sid = sessionId;
    let scoped = sessionId ? "explicit" : "auto";
    if (!sid) {
      const r = resolveAutoSid(db, lastSessionFile);
      sid = r.sid;
      scoped = r.scoped;
    }
    const args = sid ? [sid] : [];
    const sessionFilter = sid ? " AND session_id = ?" : " AND 0";
    if (!sid) warnings.push("无法识别有效会话,未汇总其他会话数据");
    const base =
      `SELECT ${schema.columns.has("turn_id") ? "NULLIF(turn_id, '')" : "NULL"} turn_id, model_id, output_tokens, reasoning_tokens, input_tokens, cache_read_input_tokens,` +
      ` ${schema.columns.has("cache_creation_input_tokens") ? "cache_creation_input_tokens" : "NULL"} cache_creation_input_tokens, first_token_at, completed_at, time_to_first_token_ms, status,` +
      ` ${DURATION_SQL} dur_ms, ${DURATION_SQL} - ${DECODE_SQL} dec_ms` +
      " FROM model_usage WHERE status = 'completed' AND query_source = 'main_turn'";
    // 主对话优先:无 main_turn 数据时回退为全部请求
    const hasMain = db
      .prepare(base + sessionFilter + " LIMIT 1")
      .get(...args);
    const scopeSql = hasMain
      ? base + sessionFilter
      : base.replace(" AND query_source = 'main_turn'", "") + sessionFilter;
    // History only limits detail rows; latest/aggregates query the entire retained scope.
    const histRows = db.prepare(scopeSql + " ORDER BY completed_at DESC LIMIT ?").all(...args, HIST);
    const mapRequest = (r) => {
      const tok = r.output_tokens ?? 0;
      const reasoning = r.reasoning_tokens ?? 0;
      // first-token 只用于 0.3 旧值与 TTFT;0.4 headline 可统计无流式 token 事件的完成请求。
      const hasTime = Number.isFinite(r.first_token_at) && Number.isFinite(r.completed_at) && r.completed_at > r.first_token_at;
      const genMs = hasTime ? r.completed_at - r.first_token_at : null; // 纯生成耗时(不含首 token 等待)
      const durMs = Number.isFinite(r.dur_ms) ? r.dur_ms : null;
      // ZCode/Responses 的 reasoning_tokens 是 output_tokens breakdown,不能再相加。
      const valid = durMs != null && durMs >= MIN_DURATION_MS && durMs < MAX_DURATION_MS && tok > 0;
      const legacyTokens = tok + reasoning;
      const legacyValid = genMs != null && genMs >= LEGACY_MIN_GEN_MS && genMs < LEGACY_MAX_GEN_MS && legacyTokens > 0;
      const decMs = Number.isFinite(r.dec_ms) ? r.dec_ms : null;
      return {
        turnId: r.turn_id,
        model: r.model_id,
        outputTokens: tok,
        reasoningTokens: reasoning,
        inputTokens: r.input_tokens ?? 0,
        cacheRead: r.cache_read_input_tokens ?? 0,
        ttftMs: Number.isFinite(r.time_to_first_token_ms) ? r.time_to_first_token_ms : null,
        genMs,
        durMs,
        tokPerSec: valid ? rateTps(tok, durMs) : null,
        // Decode 速度:纯生成阶段(剔除首字等待);TTFT 缺失且无法回退时为 null
        decodeTps: valid && decMs != null && decMs >= DECODE_MIN_MS ? rateTps(tok, decMs) : null,
        // 严格复现 0.3 错误公式,只用于迁移对比;不代表可解释的物理 burst。
        legacyTps: legacyValid ? rateTps(legacyTokens, genMs) : null,
        completedAt: r.completed_at,
      };
    };
    const items = histRows.map(mapRequest);
    // 预格式化时间字段(*Text):/tps 报表直接引用,避免模型自行把时间戳换算成 UTC
    for (const it of items) it.completedAtText = inZone(it.completedAt);
    // 展示用 latest 优先取最近一条新口径有效记录;无 first-token 但总时长有效的完成请求可入选。
    const latestRow = db.prepare("SELECT * FROM (" + scopeSql + ") WHERE dur_ms >= ? AND dur_ms < ? AND output_tokens > 0 ORDER BY completed_at DESC LIMIT 1")
      .get(...args, MIN_DURATION_MS, MAX_DURATION_MS);
    const latest = latestRow ? mapRequest(latestRow) : items[0] ?? null;
    if (latest && latest.completedAtText == null) latest.completedAtText = inZone(latest.completedAt);
    // 会话累计 token 用独立 SUM(不受流式有效性限制)
    const sumRow = db
      .prepare(
        "SELECT COUNT(*) n, SUM(output_tokens) o, SUM(reasoning_tokens) r," +
        " SUM(input_tokens) i, SUM(cache_read_input_tokens) c, SUM(cache_creation_input_tokens) cc," +
        " COUNT(DISTINCT turn_id) turns, SUM(CASE WHEN turn_id IS NULL THEN 1 ELSE 0 END) unknown_turn_requests," +
        " MIN(completed_at) first_at, MAX(completed_at) last_at FROM (" + scopeSql + ")"
      )
      .get(...args);
    // 会话级请求服务时长加权速率:Σprovider 总输出 ÷ Σ模型请求端到端时长。
    // output 已含 reasoning breakdown;有效性与 JS 端使用同一半开区间。
    const aggrRow = db
      .prepare(
        "SELECT COUNT(*) n, SUM(output_tokens) tok, SUM(dur_ms) dur FROM (" + scopeSql + ")" +
        " WHERE dur_ms >= ? AND dur_ms < ? AND output_tokens > 0"
      )
      .get(...args, MIN_DURATION_MS, MAX_DURATION_MS);
    // Decode(纯生成)会话聚合:与 e2e 有效样本同一请求集,分母剔除首字等待;dec_ms > 0 同时排除无法回退 TTFT 的行
    const decodeRow = db
      .prepare(
        "SELECT COUNT(*) n, SUM(output_tokens) tok, SUM(dec_ms) dec FROM (" + scopeSql + ")" +
        " WHERE dur_ms >= ? AND dur_ms < ? AND output_tokens > 0 AND dec_ms > 0"
      )
      .get(...args, MIN_DURATION_MS, MAX_DURATION_MS);

    // ---- 子代理归因:trace_id 与主会话 main_turn 请求相同的 subagent 请求 ----
    // 独立降级边界:trace 列缺失等情况只影响子代理口径,主对话统计不受影响
    let subAggr = null;
    let subSum = null;
    let subDecodeRow = null;
    if (includeSub && sid && schema.columns.has("trace_id")) {
      try {
        // 注意:不能用 base 包裹子查询(base 的列清单不含 trace_id),直接过滤 model_usage
        const traceListSql =
          "SELECT DISTINCT trace_id FROM model_usage" +
          " WHERE status = 'completed' AND query_source = 'main_turn'" +
          " AND session_id = ? AND " + validIdSql("trace_id");
        const subScopeSql =
          "SELECT output_tokens, reasoning_tokens, input_tokens, cache_read_input_tokens," +
          ` ${DURATION_SQL} dur_ms, ${DURATION_SQL} - ${DECODE_SQL} dec_ms FROM model_usage` +
          " WHERE status = 'completed' AND query_source = 'subagent' AND " + validIdSql("trace_id") +
          " AND trace_id IN (" + traceListSql + ")";
        subAggr = db
          .prepare(
            "SELECT COUNT(*) n, SUM(output_tokens) tok, SUM(dur_ms) dur FROM (" + subScopeSql + ")" +
            " WHERE dur_ms >= ? AND dur_ms < ? AND output_tokens > 0"
          )
          .get(sid, MIN_DURATION_MS, MAX_DURATION_MS);
        subDecodeRow = db
          .prepare(
            "SELECT COUNT(*) n, SUM(output_tokens) tok, SUM(dec_ms) dec FROM (" + subScopeSql + ")" +
            " WHERE dur_ms >= ? AND dur_ms < ? AND output_tokens > 0 AND dec_ms > 0"
          )
          .get(sid, MIN_DURATION_MS, MAX_DURATION_MS);
        // 累计与有效速率样本解耦:即使全部子请求 output=0/时长无效,请求与 token 仍归因。
        subSum = db
          .prepare(
            "SELECT COUNT(*) n, SUM(output_tokens) o, SUM(reasoning_tokens) r," +
            " SUM(input_tokens) i, SUM(cache_read_input_tokens) c FROM (" + subScopeSql + ")"
          )
          .get(sid);
      } catch (e) {
        if (isBusyError(e)) throw e; // 忙时交由外层 withBusyRetry 重试,不在此静默吞掉
        subAggr = null;
        subSum = null;
        warnings.push(`子代理归因失败: ${e.message}`);
      }
    }
    const useSub = !!(includeSub && subSum?.n);

    const session = {
      requests: (sumRow.n ?? 0) + (useSub ? subSum.n : 0),
      // S2:有效样本数须与 avgTps 口径一致(含并入的子代理有效请求)
      samples: (aggrRow?.n ?? 0) + (useSub ? subAggr?.n ?? 0 : 0),
      avgTps: null,
      includesSubagents: useSub,
      subagent: useSub
        ? {
            requests: subSum.n ?? 0,
            output: subSum.o ?? 0,
            reasoning: subSum.r ?? 0,
            input: subSum.i ?? 0,
            cacheRead: subSum.c ?? 0,
            avgTps: subAggr?.n && subAggr.dur ? rateTps(subAggr.tok, subAggr.dur) : null,
          }
        : null,
      totalOutput: (sumRow.o ?? 0) + (useSub ? subSum.o ?? 0 : 0),
      totalReasoning: (sumRow.r ?? 0) + (useSub ? subSum.r ?? 0 : 0),
      totalInput: (sumRow.i ?? 0) + (useSub ? subSum.i ?? 0 : 0),
      totalCacheRead: (sumRow.c ?? 0) + (useSub ? subSum.c ?? 0 : 0),
    };
    {
      // 会话均:主对话 + (可选)子代理,统一加权口径
      const tok = (aggrRow?.tok ?? 0) + (useSub ? subAggr?.tok ?? 0 : 0);
      const dur = (aggrRow?.dur ?? 0) + (useSub ? subAggr?.dur ?? 0 : 0);
      const n = (aggrRow?.n ?? 0) + (useSub ? subAggr?.n ?? 0 : 0);
      if (n && dur) session.avgTps = rateTps(tok, dur);
    }
    {
      // Decode 会话均:同一有效样本集,分母剔除首字等待;与官方"高峰期平均 Decode 速度"同口径
      const tok = (decodeRow?.tok ?? 0) + (useSub ? subDecodeRow?.tok ?? 0 : 0);
      const dur = (decodeRow?.dec ?? 0) + (useSub ? subDecodeRow?.dec ?? 0 : 0);
      const n = (decodeRow?.n ?? 0) + (useSub ? subDecodeRow?.n ?? 0 : 0);
      session.decodeSamples = n;
      session.decodeTps = n && dur ? rateTps(tok, dur) : null;
    }

    // Only aggregate the latest observed turn. NULL IDs carry no reliable grouping information.
    // A completed request does not prove that its containing turn has finished.
    const latestTurnId = histRows[0]?.turn_id;
    const validSql = "dur_ms >= ? AND dur_ms < ? AND output_tokens > 0";
    const g = latestTurnId == null ? null : db.prepare(
      "SELECT COUNT(*) requests, SUM(input_tokens) i, SUM(output_tokens) o," +
      " SUM(reasoning_tokens) r, SUM(cache_read_input_tokens) cr, SUM(cache_creation_input_tokens) cc," +
      " MAX(completed_at) completed_at," +
      ` SUM(CASE WHEN ${validSql} THEN output_tokens ELSE 0 END) vtok,` +
      ` SUM(CASE WHEN ${validSql} THEN dur_ms ELSE 0 END) vdur` +
      " FROM (" + scopeSql + ") WHERE turn_id = ?"
    ).get(MIN_DURATION_MS, MAX_DURATION_MS, MIN_DURATION_MS, MAX_DURATION_MS, ...args, latestTurnId);
    let turn = null;
    if (g) {
      turn = {
        turnId: latestTurnId,
        completion: "unknown",
        input: g.i ?? 0,
        output: g.o ?? 0,
        reasoning: g.r ?? 0,
        cacheRead: g.cr ?? 0,
        cacheCreation: schema.columns.has("cache_creation_input_tokens") ? g.cc ?? 0 : null,
        total: (g.i ?? 0) + (g.o ?? 0),
        durationMs: g.vdur ?? 0,
        requests: g.requests ?? 0,
        completedAt: g.completed_at,
        avgTps: g.vdur ? rateTps(g.vtok, g.vdur) : null,
        cacheHit: g.i ? Math.round(((g.cr ?? 0) / g.i) * 1000) / 10 : null,
      };
      turn.completedAtText = inZone(turn.completedAt);
    }

    const usage = sumRow.n
      ? {
          scope: hasMain ? "main_turn" : "session_all",
          turns: sumRow.unknown_turn_requests ? null : sumRow.turns,
          knownTurns: sumRow.turns,
          unknownTurnRequests: sumRow.unknown_turn_requests ?? 0,
          input: sumRow.i ?? 0,
          output: sumRow.o ?? 0,
          reasoning: sumRow.r ?? 0,
          cacheRead: sumRow.c ?? 0,
          cacheCreation: schema.columns.has("cache_creation_input_tokens") ? sumRow.cc ?? 0 : null,
          total: (sumRow.i ?? 0) + (sumRow.o ?? 0),
        }
      : null;
    const cacheHit = usage && usage.input
      ? Math.round((usage.cacheRead / usage.input) * 1000) / 10
      : null;

    if (sumRow.unknown_turn_requests) warnings.push(`${sumRow.unknown_turn_requests} 条请求缺少 turn_id,轮次数未知`);
    session.scope = !sid ? "unknown" : useSub ? "main_turn+subagent" : hasMain ? "main_turn" : "session_all";
    session.total = session.totalInput + session.totalOutput;
    session.cacheHit = session.totalInput ? Math.round(session.totalCacheRead / session.totalInput * 1000) / 10 : null;
    const coverage = { retainedOnly: true, status: "completed", scope: usage?.scope ?? session.scope,
      firstCompletedAt: sumRow.first_at ?? null, lastCompletedAt: sumRow.last_at ?? null,
      firstCompletedAtText: inZone(sumRow.first_at), lastCompletedAtText: inZone(sumRow.last_at) };
    db.exec("COMMIT");
    return { sessionId: sid, scoped, sampledAt, sampledAtText: inZone(sampledAt),
      timezone, utcOffset, coverage, warnings, latest, session, turn, usage, cacheHit, history: items };
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

// F1:速率行字段名单。默认四段(rates/decode/session/cache);配置 rateLineFields 自定义顺序与组合,
// "all" 展开全部七段(标准顺序)。未知字段忽略,空名单/非法值回落默认,保证行恒非空。
const RATE_SEGMENTS = ["rates", "decode", "ttft", "turn", "session", "cache", "time"];
const DEFAULT_RATE_FIELDS = ["rates", "decode", "session", "cache"];

function resolveRateFields(v) {
  if (v === undefined || v === null) return DEFAULT_RATE_FIELDS.slice();
  if (typeof v === "string") {
    if (v.trim().toLowerCase() === "all") return RATE_SEGMENTS.slice();
    return DEFAULT_RATE_FIELDS.slice();
  }
  if (Array.isArray(v)) {
    const names = v.map((x) => String(x).trim().toLowerCase());
    if (names.includes("all")) return RATE_SEGMENTS.slice();
    const known = [...new Set(names.filter((x) => RATE_SEGMENTS.includes(x)))];
    return known.length ? known : DEFAULT_RATE_FIELDS.slice();
  }
  return DEFAULT_RATE_FIELDS.slice();
}

function formatLine(r, fields) {
  const l = r.latest;
  if (!l) return r.sessionId == null ? "会话未知,暂无可归属的统计" : "暂无已完成的模型请求";
  // 含日期:会话跨零点时纯 HH:mm:ss 有歧义;时区跟随查询配置,不依赖系统设置
  const t = l.completedAtText ?? formatInZone(l.completedAt, r.timezone);
  const list = resolveRateFields(fields);
  const parts = [];
  for (const id of list) {
    if (id === "rates") {
      // 端到端速度只显示一个数:最近一轮。请求级波动大、会话均会被拥堵期历史拖偏(长会话失真),
      // 都移出紧凑行(仍见 JSON 与 /tps 报表);降级链 轮均→会话均→最近请求 保证 ⚡ 恒有值且标签跟源。
      const [label, v] = r.turn?.avgTps != null ? ["最近轮均", r.turn.avgTps]
        : r.session?.avgTps != null ? ["会话均", r.session.avgTps]
        : l.tokPerSec != null ? ["最近", l.tokPerSec]
        : ["最近轮均", null];
      parts.push(`⚡ ${label} ${v ?? "-"} tok/s`);
    } else if (id === "decode") {
      // Decode 速度:会话加权纯生成速率(剔除首字等待),与智谱官方"高峰期平均 Decode 速度"同口径。
      // 单请求波动大不上行;请求级速度保留在 JSON decodeTps、CLI 明细与 /tps 报表
      if (r.session?.decodeTps != null) parts.push(`Decode ${r.session.decodeTps} tok/s`);
    } else if (id === "ttft") {
      if (l.ttftMs != null) {
        // 附上最后请求的上下文规模:首字延迟与它强相关,帮助区分"模型慢"和"上下文大"
        const ctx = l.inputTokens ? `·ctx ${fmtK(l.inputTokens)}` : "";
        parts.push(`首字 ${(l.ttftMs / 1000).toFixed(1)}s${ctx}`);
      }
    } else if (id === "turn") {
      if (r.turn) parts.push(`最近轮 读 ${fmtK(r.turn.input)}(出 ${fmtK(r.turn.output)})`);
    } else if (id === "session") {
      if (r.usage) {
        // S2:会话均已并入子代理时,会话 tok 仍是主对话口径,须标注避免误导
        const scopeSuffix = r.session?.includesSubagents ? "(主)" : "";
        parts.push(`会话 ${fmtK(r.usage.total)} tok${scopeSuffix}`);
      }
    } else if (id === "cache") {
      if (r.usage && r.cacheHit != null) {
        const scopeSuffix = r.session?.includesSubagents ? "(主)" : "";
        parts.push(`缓存 ${r.cacheHit}%${scopeSuffix}`);
      }
    } else if (id === "time") {
      parts.push(`⏱ ${t}`);
    }
  }
  // 所选字段无数据时回落默认名单,保证注入行恒有内容可引用
  if (!parts.length && list.join() !== DEFAULT_RATE_FIELDS.join()) return formatLine(r, DEFAULT_RATE_FIELDS);
  return parts.join(" · ");
}

// --- CLI ---
if (process.argv[1] && process.argv[1].endsWith("token-rate.mjs")) {
  const json = process.argv.includes("--json");
  const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  let cfg;
  const r = (() => {
    try {
      cfg = readConfig();
      return { ok: true, value: query(sid, { includeSubagents: parseBool(cfg.includeSubagents, true), timezone: cfg.timezone }) };
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
      console.log(formatLine(q, resolveRateFields(cfg.rateLineFields)));
      const s = q.session;
      if (s) {
        console.log(`请求累计(含进行中轮):输出 ${s.totalOutput}${s.totalReasoning ? `(其中 ${s.totalReasoning} 思考)` : ""} tok · 输入 ${fmtK(s.totalInput)} tok(其中缓存读 ${fmtK(s.totalCacheRead)}) · 请求 ${s.requests} 次`);
      }
      if (q.turn) {
        const t = q.turn;
        console.log(`最近轮次(已完成请求,整轮状态未知):输入 ${fmtK(t.input)} + 输出 ${fmtK(t.output)} = ${fmtK(t.total)} tok · ${t.requests} 次请求 / 有效请求服务时长 ${(t.durationMs / 1000).toFixed(1)}s · 缓存命中 ${t.cacheHit ?? "-"}%`);
      }
      if (q.usage) {
        const scopeNote = q.usage.scope === "main_turn" ? "主对话" : "当前会话全部请求来源";
        console.log(`会话用量(库内留存的已完成请求,${scopeNote}):${q.usage.turns == null ? "轮次数未知" : q.usage.turns + " 个已观察轮次"} · 总计 ${fmtK(q.usage.total)} tok(输入 ${fmtK(q.usage.input)} / 输出 ${fmtK(q.usage.output)}${q.usage.reasoning ? ` / 其中思考 ${fmtK(q.usage.reasoning)}` : ""}) · 缓存命中率 ${q.cacheHit ?? "-"}%`);
      }
      if (q.session) {
        // Decode 与官方"高峰期平均 Decode 速度"同口径:剔除首字等待,排队/预填充不计入分母
        const smp = q.session.samples || 0;
        console.log(`Decode 速度(纯生成,剔除首字等待):最近 ${q.latest?.decodeTps ?? "-"} · 会话加权 ${q.session.decodeTps ?? "-"} tok/s(有效样本 ${q.session.decodeSamples ?? 0}/${smp},TTFT 缺失且无法回退的请求不参与)`);
      }
      if (q.session.subagent) {
        console.log(`子代理归因:并入 ${q.session.subagent.requests} 次请求 / 输出 ${fmtK(q.session.subagent.output)} tok(子代理均 ${q.session.subagent.avgTps ?? "-"} tok/s) · 配置 includeSubagents:false 可切回纯主对话口径`);
      }
      const zone = q.timezone ?? resolveTimezone(cfg.timezone);
      console.log(`采样时间:${q.sampledAtText ?? formatInZone(q.sampledAt, zone)}(${zone} ${q.utcOffset ?? zoneOffsetLabel(zone, q.sampledAt)})`);
      for (const warning of q.warnings) console.log(`⚠️ ${warning}`);
    }
  }
}

export { query, formatLine, openDb, withBusyRetry, parseBool, resolveRateFields, RATE_SEGMENTS, DEFAULT_RATE_FIELDS };
