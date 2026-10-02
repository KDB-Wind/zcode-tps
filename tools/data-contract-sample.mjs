#!/usr/bin/env node
// M0 数据契约采样(zcode-tps 0.6.0 spec §3.2):对宿主用量库做只读 PRAGMA/SELECT 采样,
// 产出脱敏证据 JSON,作为 docs/DATA-CONTRACT-0.6.0.md 的依据。
// 硬性约束:
//   - 只读打开,单只读事务;不执行任何写入/DDL/ANALYZE/journal 修改(spec §2.1.3)。
//   - 内容类列(payload/json/content/message/text/raw/metadata/error_message 等)只记录"列存在",
//     不采样其值;error_type/error_code 允许采样但截断至 40 字符、限基数(spec §3.2)。
//   - 一切 ID 值经确定性 sha256 短别名脱敏:同值同别名,保留关联关系,不输出真实 ID。
//   - 限制行数:样本行 ≤ --sample,窗口分析 ≤ --window(按 rowid 取最近)。
// 用法:node tools/data-contract-sample.mjs [--out <file>] [--window N] [--sample N]
// 默认输出 <系统临时目录>/zcode-tps-m0-evidence-<时间戳>.json(不入库)。

let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); }
catch (e) { console.error(`node:sqlite 不可用,需要 Node 22.13+/24+: ${e.message}`); process.exit(1); }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const argVal = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const WINDOW = Math.max(1, Number(argVal("--window", 20000)));
const SAMPLE = Math.max(1, Number(argVal("--sample", 3)));
const OUT = argVal("--out", path.join(os.tmpdir(), `zcode-tps-m0-evidence-${Date.now()}.json`));
const DB_PATH =
  process.env.ZCODE_USAGE_DB ||
  path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");

// ---- 脱敏:确定性短别名,同值同别名 → 关联关系保留 ----
const aliasMap = new Map();
function alias(kind, value) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  const key = `${kind}|${s}`;
  let a = aliasMap.get(key);
  if (!a) {
    a = `${kind}-${createHash("sha256").update(s).digest("base64url").slice(0, 8)}`;
    aliasMap.set(key, a);
  }
  return a;
}
// 内容类列:按列名过滤采样(名称本身记录在 schema 中,不视为内容泄露)
const CONTENT_COL = /(payload|json|content|message|prompt|text|body|raw|metadata|desc|note|summary|title|error_message|input$)/i;
const safeCols = (cols) => cols.filter((c) => !CONTENT_COL.test(c.name));
const clip = (v, n = 40) => (typeof v === "string" && v.length > n ? v.slice(0, n) + "…" : v);

const db = new DatabaseSync(DB_PATH, { readOnly: true });
db.exec("PRAGMA busy_timeout = 3000");

const out = { meta: {}, tables: {}, modelUsage: {}, turnUsage: {}, dwfTables: {}, workflowTables: {}, associations: {}, notes: [] };
try {
  db.exec("BEGIN"); // 单只读事务:所有证据来自同一快照
  out.meta = {
    sampledAt: new Date().toISOString(),
    dbPathBasename: path.basename(DB_PATH),
    dbSizeBytes: fs.statSync(DB_PATH).size,
    sqliteVersion: db.prepare("SELECT sqlite_version() v").get().v,
    nodeVersion: process.version,
    window: WINDOW,
    sample: SAMPLE,
  };

  // ---- 全库对象清单与兴趣表 schema ----
  const objects = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  out.meta.objects = objects.map((o) => ({ type: o.type, name: o.name }));
  const tableNames = objects.filter((o) => o.type === "table").map((o) => o.name);
  const interest = tableNames.filter((t) => t === "model_usage" || t === "turn_usage" || /^dwf_/.test(t) || /^workflow/.test(t));

  const pragmaCols = (t) => db.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all()
    .map((c) => ({ name: c.name, type: c.type, notnull: !!c.notnull, pk: c.pk, dflt: c.dflt_value }));
  const pragmaIndexes = (t) => {
    const idxs = [];
    for (const idx of db.prepare(`PRAGMA index_list(${JSON.stringify(t)})`).all()) {
      const info = db.prepare(`PRAGMA index_info(${JSON.stringify(idx.name)})`).all().map((c) => c.name);
      idxs.push({ name: idx.name, unique: !!idx.unique, partial: !!idx.partial, origin: idx.origin, columns: info });
    }
    return idxs;
  };
  const pragmaFks = (t) => db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(t)})`).all()
    .map((f) => ({ table: f.table, from: f.from, to: f.to }));

  const rowCount = (t) => { try { return db.prepare(`SELECT COUNT(*) n FROM ${JSON.stringify(t)}`).get().n; } catch { return null; } };

  // WITHOUT ROWID 表没有 rowid,采样排序降级为无序(仍限行数)
  const rowidOkCache = new Map();
  function orderRecent(t) {
    if (!rowidOkCache.has(t)) {
      try { db.prepare(`SELECT rowid FROM ${JSON.stringify(t)} LIMIT 1`).get(); rowidOkCache.set(t, true); }
      catch { rowidOkCache.set(t, false); }
    }
    return rowidOkCache.get(t) ? "ORDER BY rowid DESC" : "";
  }

  for (const t of interest) {
    const entry = { columns: pragmaCols(t), indexes: pragmaIndexes(t), foreignKeys: pragmaFks(t), rowCount: rowCount(t) };
    entry.contentColumns = entry.columns.filter((c) => CONTENT_COL.test(c.name)).map((c) => c.name);
    const schemaHash = createHash("sha256").update(JSON.stringify(entry.columns.map((c) => `${c.name}:${c.type}:${c.pk}:${c.notnull}`))).digest("base64url").slice(0, 12);
    entry.schemaHash = schemaHash;
    out.tables[t] = entry;
  }

  // ---- 通用:按列名的"链接发现"(非空率/基数),勾出关联图候选边 ----
  const LINK_COL = /session|trace|turn|usage|request|run$|run_|node|actor|event|parent|root|attempt|status/i;  function linkDiscovery(t, entry) {
    const cands = safeCols(entry.columns).filter((c) => LINK_COL.test(c.name));
    const found = {};
    for (const c of cands) {
      try {
        const r = db.prepare(`SELECT COUNT(${JSON.stringify(c.name)}) nn, COUNT(DISTINCT ${JSON.stringify(c.name)}) nd FROM ${JSON.stringify(t)}`).get();
        found[c.name] = { nonNull: r.nn, distinct: r.nd };
      } catch (e) { found[c.name] = { error: e.message }; }
    }
    return found;
  }

  // ---- model_usage 深查 ----
  const MU = "model_usage";
  const muCols = out.tables[MU].columns.map((c) => c.name);
  const has = (c) => muCols.includes(c);
  const mu = out.modelUsage;

  // 身份:id 列主键/唯一性证据
  mu.identity = {
    columns: out.tables[MU].columns,
    indexes: out.tables[MU].indexes,
    rowidTable: true,
    idColumnExists: has("id"),
  };
  if (has("id")) {
    const r = db.prepare(`SELECT COUNT(*) n, COUNT(DISTINCT id) nid, SUM(CASE WHEN id IS NULL THEN 1 ELSE 0 END) null_id FROM ${MU}`).get();
    mu.identity.idStats = { rows: r.n, distinctId: r.nid, nullId: r.null_id, duplicates: r.n - r.nid - r.null_id };
  }

  // 状态与落库时序:一次全表扫描
  mu.statusSemantics = db.prepare(
    `SELECT status, COUNT(*) n,
      SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) has_completed_at,
      SUM(CASE WHEN output_tokens IS NOT NULL THEN 1 ELSE 0 END) has_output,
      SUM(CASE WHEN input_tokens IS NOT NULL THEN 1 ELSE 0 END) has_input,
      SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END) has_duration,
      SUM(CASE WHEN completed_at IS NOT NULL AND output_tokens IS NOT NULL THEN 1 ELSE 0 END) done_with_output
     FROM ${MU} GROUP BY status ORDER BY n DESC`
  ).all();
  mu.querySourceDistribution = db.prepare(
    `SELECT COALESCE(NULLIF(TRIM(query_source), ''), '(blank)') src, COUNT(*) n FROM ${MU} GROUP BY src ORDER BY n DESC`
  ).all();
  mu.providerDistribution = has("provider_id")
    ? db.prepare(`SELECT COALESCE(NULLIF(TRIM(provider_id), ''), '(blank)') p, COUNT(*) n FROM ${MU} GROUP BY p ORDER BY n DESC`).all()
    : null;
  mu.modelDistribution = db.prepare(
    `SELECT COALESCE(NULLIF(TRIM(model_id), ''), '(blank)') m, COUNT(*) n FROM ${MU} GROUP BY m ORDER BY n DESC LIMIT 20`
  ).all();

  // 布尔/错误/重试特征列的存在性与取值
  mu.flagColumns = {};
  for (const c of ["cancelled_by_user", "retryable", "context_exceeded"]) {
    if (has(c)) {
      try {
        mu.flagColumns[c] = db.prepare(`SELECT ${JSON.stringify(c)} v, COUNT(*) n FROM ${MU} GROUP BY v ORDER BY n DESC LIMIT 6`).all();
      } catch (e) { mu.flagColumns[c] = { error: e.message }; }
    }
  }
  for (const c of ["error_type", "error_code", "retry_count", "attempt_index"]) {
    if (has(c)) {
      try {
        mu.flagColumns[c] = db.prepare(`SELECT ${JSON.stringify(c)} v, COUNT(*) n FROM ${MU} WHERE ${JSON.stringify(c)} IS NOT NULL GROUP BY v ORDER BY n DESC LIMIT 12`)
          .all().map((r) => ({ v: clip(r.v), n: r.n }));
      } catch (e) { mu.flagColumns[c] = { error: e.message }; }
    }
  }

  // ---- 最近窗口(按 rowid)分析:retry/logical/trace/TTFT ----
  const safeNames = safeCols(out.tables[MU].columns).map((c) => c.name);
  const win = `SELECT ${safeNames.map((n) => JSON.stringify(n)).join(", ")} FROM ${MU} ORDER BY rowid DESC LIMIT ${WINDOW}`;
  const w = out.modelUsage.recentWindow = {};

  if (has("logical_request_id")) {
    const lrid = "logical_request_id";
    w.logicalRequest = {};
    const r = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN ${lrid} IS NOT NULL THEN 1 ELSE 0 END) with_lrid, COUNT(DISTINCT ${lrid}) lrids FROM (${win})`).get();
    Object.assign(w.logicalRequest, r);
    w.logicalRequest.multiSessionLrids = db.prepare(
      `SELECT ${lrid} k, COUNT(DISTINCT session_id) sessions, COUNT(*) rows FROM (${win})
       WHERE ${lrid} IS NOT NULL GROUP BY k HAVING sessions > 1 ORDER BY rows DESC LIMIT 5`
    ).all().map((r) => ({ lrid: alias("lrid", r.k), sessions: r.sessions, rows: r.rows }));
    w.logicalRequest.multiProviderLrids = has("provider_id")
      ? db.prepare(
          `SELECT ${lrid} k, COUNT(DISTINCT provider_id) providers, COUNT(*) rows FROM (${win})
           WHERE ${lrid} IS NOT NULL GROUP BY k HAVING providers > 1 ORDER BY rows DESC LIMIT 5`
        ).all().map((r) => ({ lrid: alias("lrid", r.k), providers: r.providers, rows: r.rows }))
      : null;
    w.logicalRequest.groupsByAttemptCount = db.prepare(
      `SELECT attempts, COUNT(*) groups FROM (
         SELECT ${lrid} k, COUNT(DISTINCT attempt_index) attempts FROM (${win})
         WHERE ${lrid} IS NOT NULL GROUP BY k
       ) GROUP BY attempts ORDER BY attempts LIMIT 10`
    ).all();
    w.logicalRequest.attemptIndexValues = has("attempt_index")
      ? db.prepare(`SELECT attempt_index v, COUNT(*) n FROM (${win}) WHERE ${lrid} IS NOT NULL GROUP BY v ORDER BY v LIMIT 12`).all()
      : null;
    w.logicalRequest.duplicateLridAttempt = has("attempt_index")
      ? db.prepare(
          `SELECT ${lrid} k, attempt_index a, COUNT(*) c FROM (${win})
           WHERE ${lrid} IS NOT NULL AND attempt_index IS NOT NULL GROUP BY k, a HAVING c > 1 LIMIT 5`
        ).all().map((r) => ({ lrid: alias("lrid", r.k), attemptIndex: r.a, rows: r.c }))
      : null;
    w.logicalRequest.nullAttemptIndexRows = has("attempt_index")
      ? db.prepare(`SELECT COUNT(*) n FROM (${win}) WHERE ${lrid} IS NOT NULL AND attempt_index IS NULL`).get().n
      : null;
    w.logicalRequest.lridMissing = db.prepare(`SELECT COUNT(*) n FROM (${win}) WHERE ${lrid} IS NULL`).get().n;
    // retry_count 与观察尝试数的对照(语义验证核心证据)
    if (has("retry_count") && has("attempt_index")) {
      w.logicalRequest.retryCountVsAttempts = db.prepare(
        `SELECT attempts, retry_count, COUNT(*) groups FROM (
           SELECT ${lrid} k, COUNT(DISTINCT attempt_index) attempts, MAX(retry_count) retry_count
           FROM (${win}) WHERE ${lrid} IS NOT NULL GROUP BY k
         ) GROUP BY attempts, retry_count ORDER BY attempts, retry_count LIMIT 20`
      ).all();
    }
    w.logicalRequest.samples = db.prepare(
      `SELECT id, ${lrid} lrid, attempt_index, retry_count, status, query_source, session_id, provider_id, started_at, completed_at
       FROM (${win}) WHERE ${lrid} IS NOT NULL LIMIT 6`
    ).all().map((r) => ({
      id: alias("uid", r.id), lrid: alias("lrid", r.lrid), attemptIndex: r.attempt_index, retryCount: r.retry_count,
      status: r.status, querySource: r.query_source, session: alias("sess", r.session_id), provider: r.provider_id,
      startedAt: r.started_at, completedAt: r.completed_at,
    })).filter((r) => r.id !== null);
  }

  // trace 跨会话/多请求证据
  if (has("trace_id")) {
    w.trace = {};
    w.trace.multiSessionTraces = db.prepare(
      `SELECT trace_id k, COUNT(DISTINCT session_id) sessions, COUNT(*) rows, COUNT(DISTINCT query_source) srcs
       FROM (${win}) WHERE trace_id IS NOT NULL AND TRIM(trace_id) != '' GROUP BY k HAVING sessions > 1 LIMIT 5`
    ).all().map((r) => ({ trace: alias("tr", r.k), sessions: r.sessions, rows: r.rows, sources: r.srcs }));
    w.trace.subagentWithMainTrace = has("query_source")
      ? db.prepare(
          `SELECT COUNT(*) n FROM (${win}) s WHERE s.query_source = 'subagent' AND s.trace_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM (${win}) m WHERE m.trace_id = s.trace_id AND m.query_source = 'main_turn')`
        ).get().n
      : null;
    w.trace.subagentTotal = db.prepare(`SELECT COUNT(*) n FROM (${win}) WHERE query_source = 'subagent'`).get().n;
  }

  // TTFT 证据
  if (has("time_to_first_token_ms")) {
    w.ttft = db.prepare(
      `SELECT
        SUM(CASE WHEN time_to_first_token_ms IS NOT NULL THEN 1 ELSE 0 END) explicit_present,
        SUM(CASE WHEN time_to_first_token_ms IS NOT NULL AND (typeof(time_to_first_token_ms) NOT IN ('integer','real')
             OR time_to_first_token_ms < 0 OR time_to_first_token_ms >= 9e999) THEN 1 ELSE 0 END) explicit_invalid,
        SUM(CASE WHEN time_to_first_token_ms IS NULL AND first_token_at IS NOT NULL AND started_at IS NOT NULL
             AND typeof(first_token_at) IN ('integer','real') AND typeof(started_at) IN ('integer','real') THEN 1 ELSE 0 END) fallback_eligible,
        SUM(CASE WHEN time_to_first_token_ms IS NOT NULL AND first_token_at IS NOT NULL AND started_at IS NOT NULL
             AND typeof(first_token_at) IN ('integer','real') AND typeof(started_at) IN ('integer','real') THEN 1 ELSE 0 END) both_present
       FROM (${win})`
    ).get();
    if (w.ttft.both_present > 0) {
      w.ttft.samples = db.prepare(
        `SELECT time_to_first_token_ms ttft, first_token_at - started_at delta, duration_ms dur
         FROM (${win}) WHERE time_to_first_token_ms IS NOT NULL AND first_token_at IS NOT NULL AND started_at IS NOT NULL
           AND typeof(first_token_at) IN ('integer','real') AND typeof(started_at) IN ('integer','real')
           AND typeof(time_to_first_token_ms) IN ('integer','real') LIMIT 6`
      ).all();
    }
  }

  // turn_id 非空率
  if (has("turn_id")) {
    const r = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN turn_id IS NOT NULL AND TRIM(turn_id) != '' THEN 1 ELSE 0 END) with_turn FROM (${win})`).get();
    w.turnId = { rows: r.n, withTurnId: r.with_turn };
    w.turnId.turnsPerSessionSample = db.prepare(
      `SELECT session_id s, COUNT(DISTINCT turn_id) turns, COUNT(*) rows FROM (${win})
       WHERE turn_id IS NOT NULL AND TRIM(turn_id) != '' GROUP BY s ORDER BY rows DESC LIMIT 3`
    ).all().map((r) => ({ session: alias("sess", r.s), turns: r.turns, rows: r.rows }));
  }

  // 样本行(全安全列,别名化)
  out.modelUsage.samples = db.prepare(
    `SELECT ${safeNames.map((n) => JSON.stringify(n)).join(", ")} FROM ${MU} ORDER BY rowid DESC LIMIT ${SAMPLE}`
  ).all().map((row) => {
    const o = {};
    for (const [k, v] of Object.entries(row)) {
      if (/session_id|trace_id|turn_id|logical_request_id|^id$/i.test(k)) o[k] = alias(k === "id" ? "uid" : k.replace(/_id$/, "").replace("logical_request", "lrid"), v);
      else o[k] = clip(v);
    }
    return o;
  });

  // ---- workflow_child 归属证据(workflow 分账的核心契约) ----
  if (has("query_source")) {
    const wf = out.modelUsage.workflowChild = {};
    wf.statusBySource = db.prepare(
      `SELECT query_source src, status st, COUNT(*) n FROM model_usage
       WHERE query_source NOT IN ('main_turn', 'subagent') GROUP BY src, st ORDER BY src, n DESC`
    ).all();
    wf.sessionOverlap = db.prepare(
      `SELECT COUNT(DISTINCT session_id) wf_sessions,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM model_usage g WHERE g.session_id = model_usage.session_id AND g.query_source = 'main_turn') THEN 1 ELSE 0 END) rows_same_session_has_main,
         SUM(CASE WHEN turn_id IS NOT NULL AND TRIM(turn_id) != '' THEN 1 ELSE 0 END) with_turn,
         SUM(CASE WHEN trace_id IS NOT NULL AND TRIM(trace_id) != '' THEN 1 ELSE 0 END) with_trace
       FROM model_usage WHERE query_source = 'workflow_child'`
    ).get();
    // workflow_child 与同 session 同 turn 的 main_turn 是否共享键(同轮归属证据)
    wf.turnKeySample = db.prepare(
      `SELECT session_id s, turn_id t, COUNT(*) n FROM model_usage
       WHERE query_source = 'workflow_child' AND turn_id IS NOT NULL AND TRIM(turn_id) != ''
       GROUP BY s, t ORDER BY n DESC LIMIT 5`
    ).all().map((r) => ({
      session: alias("sess", r.s), turn: alias("turn", r.t), wfRows: r.n,
      mainRowsSameTurn: (() => { try { return db.prepare(`SELECT COUNT(*) n FROM model_usage WHERE session_id = ? AND turn_id = ? AND query_source = 'main_turn'`).get(r.s, r.t).n; } catch { return null; } })(),
      subagentRowsSameTurn: (() => { try { return db.prepare(`SELECT COUNT(*) n FROM model_usage WHERE session_id = ? AND turn_id = ? AND query_source = 'subagent'`).get(r.s, r.t).n; } catch { return null; } })(),
    }));
    wf.samples = db.prepare(
      `SELECT id, session_id, turn_id, trace_id, status, model_id, input_tokens, output_tokens, started_at, completed_at
       FROM model_usage WHERE query_source = 'workflow_child' ORDER BY rowid DESC LIMIT 5`
    ).all().map((r) => ({
      id: alias("uid", r.id), session: alias("sess", r.session_id), turn: alias("turn", r.turn_id),
      trace: alias("tr", r.trace_id), status: r.status, model: r.model_id,
      input: r.input_tokens, output: r.output_tokens, startedAt: r.started_at, completedAt: r.completed_at,
    }));
    // workflow_child 的 trace 是否也出现在 main_turn 行上(同 trace 双路径风险)
    wf.traceOverlapWithMain = db.prepare(
      `SELECT COUNT(*) n FROM model_usage w
       WHERE w.query_source = 'workflow_child' AND w.trace_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM model_usage m WHERE m.trace_id = w.trace_id AND m.query_source = 'main_turn')`
    ).get().n;
  }

  // ---- 全表 logical_request_id 重查(窗口可能遗漏旧重试组) ----
  if (has("logical_request_id")) {
    const lrid = "logical_request_id";
    out.modelUsage.logicalRequestFullTable = db.prepare(
      `SELECT COUNT(*) n, COUNT(DISTINCT ${lrid}) lrids, SUM(CASE WHEN ${lrid} IS NULL THEN 1 ELSE 0 END) null_lrid FROM model_usage`
    ).get();
    out.modelUsage.logicalRequestMultiRowGroups = db.prepare(
      `SELECT ${lrid} k, COUNT(*) rows, COUNT(DISTINCT session_id) sessions, COUNT(DISTINCT attempt_index) attempts
       FROM model_usage WHERE ${lrid} IS NOT NULL GROUP BY k HAVING rows > 1 ORDER BY rows DESC LIMIT 8`
    ).all().map((r) => ({ lrid: alias("lrid", r.k), rows: r.rows, sessions: r.sessions, attempts: r.attempts }));
  }

  // ---- turn_usage 深查 ----
  if (out.tables.turn_usage) {
    const tu = out.turnUsage;
    tu.columns = out.tables.turn_usage.columns;
    const tuc = tu.columns.map((c) => c.name);
    const tuHas = (c) => tuc.includes(c);
    const tuSafe = safeCols(tu.columns).map((c) => c.name);
    tu.samples = tuSafe.length
      ? db.prepare(`SELECT ${tuSafe.map((n) => JSON.stringify(n)).join(", ")} FROM turn_usage ${orderRecent("turn_usage")} LIMIT ${SAMPLE}`)
          .all().map((row) => {
            const o = {};
            for (const [k, v] of Object.entries(row)) {
              if (/session|turn|run|request/i.test(k) && (typeof v === "string" || typeof v === "number")) o[k] = alias("tu-" + k, v);
              else o[k] = clip(v);
            }
            return o;
          })
      : [];
    // 键与粒度
    const sessKey = tuc.find((c) => /session_id/i.test(c));
    const turnKey = tuc.find((c) => /^turn/.test(c) || /turn_id/i.test(c));
    if (sessKey && turnKey) {
      tu.granularity = {};
      tu.granularity.rowsPerKey = db.prepare(
        `SELECT per_key, COUNT(*) keys FROM (
           SELECT COUNT(*) per_key FROM turn_usage GROUP BY ${JSON.stringify(sessKey)}, ${JSON.stringify(turnKey)}
         ) GROUP BY per_key ORDER BY per_key LIMIT 10`
      ).all();
      // 最近一个键的明细,验证每键多行时按什么拆分(model? source?)
      const last = db.prepare(`SELECT ${JSON.stringify(sessKey)} s, ${JSON.stringify(turnKey)} t, COUNT(*) n FROM turn_usage GROUP BY s, t ORDER BY s, t DESC LIMIT 1`).get();
      if (last) {
        tu.granularity.sampleKey = { session: alias("tu-" + sessKey, last.s), turn: alias("tu-" + turnKey, last.t), rows: last.n };
        if (tuSafe.length) {
          tu.granularity.sampleKeyRows = db.prepare(
            `SELECT ${tuSafe.map((n) => JSON.stringify(n)).join(", ")} FROM turn_usage
             WHERE ${JSON.stringify(sessKey)} = ? AND ${JSON.stringify(turnKey)} = ? LIMIT 10`
          ).all(last.s, last.t).map((row) => {
            const o = {};
            for (const [k, v] of Object.entries(row)) {
              if (/session|turn|run|request/i.test(k) && (typeof v === "string" || typeof v === "number")) o[k] = alias("tu-" + k, v);
              else o[k] = clip(v);
            }
            return o;
          });
        }
      }
      // 对照:同一 (session, turn) 的 model_usage 主对话聚合(对账语义预验证,U01)
      if (has("session_id") && has("turn_id") && tuHas("session_id")) {
        const tk = turnKey;
        try {
          const cmp = db.prepare(
            `SELECT ${JSON.stringify(sessKey)} s, ${JSON.stringify(tk)} t, COUNT(*) n FROM turn_usage GROUP BY s, t ORDER BY n DESC LIMIT 3`
          ).all();
          const comparisons = [];
          const tuValueCols = tuc.filter((c) => /token|request|retry|status|duration/i.test(c) && !CONTENT_COL.test(c));
          for (const key of cmp) {
            const muAgg = db.prepare(
              `SELECT COUNT(*) n,
                 SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) completed_n,
                 SUM(CASE WHEN status = 'completed' AND input_tokens IS NOT NULL THEN input_tokens ELSE 0 END) inp,
                 SUM(CASE WHEN status = 'completed' AND output_tokens IS NOT NULL THEN output_tokens ELSE 0 END) outp
               FROM model_usage WHERE session_id = ? AND turn_id = ?`
            ).get(key.s, key.t);
            const tuRow = db.prepare(
              `SELECT ${tuValueCols.map((n) => JSON.stringify(n)).join(", ")} FROM turn_usage WHERE ${JSON.stringify(sessKey)} = ? AND ${JSON.stringify(tk)} = ? LIMIT 1`
            ).get(key.s, key.t);
            comparisons.push({
              session: alias("tu-" + sessKey, key.s), turn: alias("tu-" + tk, key.t), turnUsageRows: key.n,
              modelUsageRows: muAgg.n, modelUsageCompleted: muAgg.completed_n,
              modelUsageInput: muAgg.inp, modelUsageOutput: muAgg.outp,
              turnUsageValues: tuRow,
            });
          }
          out.turnUsage.crossCheckSample = comparisons;
          out.turnUsage.keyOverlap = {
            turnUsageKeys: db.prepare(
              `SELECT COUNT(*) n FROM turn_usage t WHERE t.${JSON.stringify(turnKey)} IS NOT NULL AND EXISTS (
                 SELECT 1 FROM model_usage m WHERE m.session_id = t.${JSON.stringify(sessKey)} AND m.turn_id = t.${JSON.stringify(turnKey)})`
            ).get().n,
            turnUsageKeysTotal: db.prepare(
              `SELECT COUNT(*) n FROM turn_usage t WHERE t.${JSON.stringify(turnKey)} IS NOT NULL`
            ).get().n,
          };
          out.turnUsage.statusDistribution = db.prepare(`SELECT status, COUNT(*) n FROM turn_usage GROUP BY status ORDER BY n DESC`).all();
        } catch (e) { out.turnUsage.crossCheckError = e.message; }
      }
    }
  }

  // ---- dwf_* / workflow_* 表:链接发现与样本 ----
  for (const t of interest.filter((x) => /^dwf_/.test(x))) {
    const entry = out.tables[t];
    const safe = safeCols(entry.columns).map((c) => c.name);
    const rec = { linkColumns: linkDiscovery(t, entry) };
    if (safe.length) {
      rec.samples = db.prepare(`SELECT ${safe.map((n) => JSON.stringify(n)).join(", ")} FROM ${JSON.stringify(t)} ${orderRecent(t)} LIMIT ${SAMPLE}`)
        .all().map((row) => {
          const o = {};
          for (const [k, v] of Object.entries(row)) {
            if (/session|turn|run|node|actor|usage|request|trace/i.test(k) && (typeof v === "string" || typeof v === "number")) o[k] = alias(t + "." + k, v);
            else o[k] = clip(v, 60);
          }
          return o;
        });
    }
    // 事件类型分布(仅计数,不取 payload)
    const typeCol = entry.columns.map((c) => c.name).find((c) => /type|kind|event|action/i.test(c) && !CONTENT_COL.test(c));
    if (typeCol) {
      try {
        rec.typeDistribution = db.prepare(`SELECT ${JSON.stringify(typeCol)} v, COUNT(*) n FROM ${JSON.stringify(t)} GROUP BY v ORDER BY n DESC LIMIT 12`)
          .all().map((r) => ({ v: clip(r.v, 60), n: r.n }));
      } catch (e) { rec.typeDistribution = { error: e.message }; }
    }
    out.dwfTables[t] = rec;
  }
  for (const t of interest.filter((x) => /^workflow/.test(x))) {
    const entry = out.tables[t];
    const safe = safeCols(entry.columns).map((c) => c.name);
    const rec = { linkColumns: linkDiscovery(t, entry) };
    if (safe.length) {
      rec.samples = db.prepare(`SELECT ${safe.map((n) => JSON.stringify(n)).join(", ")} FROM ${JSON.stringify(t)} ${orderRecent(t)} LIMIT ${SAMPLE}`)
        .all().map((row) => {
          const o = {};
          for (const [k, v] of Object.entries(row)) {
            if (/session|turn|run|node|actor|usage|request|trace/i.test(k) && (typeof v === "string" || typeof v === "number")) o[k] = alias(t + "." + k, v);
            else o[k] = clip(v, 60);
          }
          return o;
        });
    }
    const typeCol = entry.columns.map((c) => c.name).find((c) => /type|kind|event|action|status/i.test(c) && !CONTENT_COL.test(c));
    if (typeCol) {
      try {
        rec.typeDistribution = db.prepare(`SELECT ${JSON.stringify(typeCol)} v, COUNT(*) n FROM ${JSON.stringify(t)} GROUP BY v ORDER BY n DESC LIMIT 12`)
          .all().map((r) => ({ v: clip(r.v, 60), n: r.n }));
      } catch (e) { rec.typeDistribution = { error: e.message }; }
    }
    out.workflowTables[t] = rec;
  }

  // ---- 关联验证:workflow 运行是否连到 model_usage ----
  const assoc = out.associations;
  // 1) workflow_run / dwf_run 有无 session 列 → run→session→model_usage 路径
  for (const t of ["workflow_run", "dwf_run"]) {
    if (!out.tables[t]) continue;
    const cols = out.tables[t].columns.map((c) => c.name);
    const sessCol = cols.find((c) => /session_id/i.test(c));
    assoc[t] = { hasSessionColumn: sessCol ?? null };
    if (sessCol) {
      try {
        const r = db.prepare(`SELECT COUNT(*) n, COUNT(DISTINCT ${JSON.stringify(sessCol)}) ns, SUM(CASE WHEN ${JSON.stringify(sessCol)} IS NULL THEN 1 ELSE 0 END) null_sess FROM ${JSON.stringify(t)}`).get();
        assoc[t].sessionLink = r;
        // 样本 run 的 session 是否在 model_usage 出现过
        const sample = db.prepare(`SELECT DISTINCT ${JSON.stringify(sessCol)} s FROM ${JSON.stringify(t)} WHERE ${JSON.stringify(sessCol)} IS NOT NULL LIMIT 3`).all();
        assoc[t].sampleSessionsInModelUsage = sample.map((x) => ({
          session: alias(t + "." + sessCol, x.s),
          modelUsageRows: (() => { try { return db.prepare(`SELECT COUNT(*) n FROM model_usage WHERE session_id = ?`).get(x.s).n; } catch { return null; } })(),
        }));
      } catch (e) { assoc[t].error = e.message; }
    }
    // run→node/actor 链
    const runCol = cols.find((c) => /run_id|run$|id$/.test(c) && c !== sessCol);
    assoc[t].idColumn = runCol ?? null;
  }
  // 2) dwf_node / workflow 节点 → model_usage 行的连接键(usage_id? request_id? trace?)
  for (const t of ["dwf_node", "workflow_activity", "workflow_event", "dwf_actor"]) {
    if (!out.tables[t]) continue;
    const cols = out.tables[t].columns.map((c) => c.name);
    const usageLink = cols.filter((c) => /usage|request|trace|model/i.test(c));
    assoc[t] = { candidateUsageLinks: usageLink };
    for (const c of usageLink.slice(0, 3)) {
      try {
        const r = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN ${JSON.stringify(c)} IS NOT NULL THEN 1 ELSE 0 END) nn FROM ${JSON.stringify(t)}`).get();
        assoc[t][c] = r;
        // 该列的值是否命中 model_usage.id
        if (has("id")) {
          const hit = db.prepare(
            `SELECT COUNT(*) n FROM ${JSON.stringify(t)} x WHERE x.${JSON.stringify(c)} IS NOT NULL AND EXISTS (SELECT 1 FROM model_usage m WHERE m.id = x.${JSON.stringify(c)})`
          ).get();
          assoc[t][c].hitsModelUsageId = hit.n;
        }
      } catch (e) { assoc[t][c] = { error: e.message }; }
    }
  }

  // ---- 契约探针(M0 结论所依赖的决定性证据;全部只读) ----
  const probes = out.associations.contractProbes = {};
  try {
    // subagent 行是否与主会话同 session(trace 之外还有无归属依据)
    probes.subagentSameSessionRows = db.prepare(
      `SELECT COUNT(*) n FROM model_usage s WHERE s.query_source = 'subagent' AND EXISTS (
         SELECT 1 FROM model_usage m WHERE m.trace_id = s.trace_id AND m.query_source = 'main_turn' AND m.session_id = s.session_id)`
    ).get().n;
    probes.subagentSessionHasMainRows = db.prepare(
      `SELECT COUNT(*) n FROM model_usage s WHERE s.query_source = 'subagent' AND EXISTS (
         SELECT 1 FROM model_usage m WHERE m.session_id = s.session_id AND m.query_source = 'main_turn')`
    ).get().n;
    // A03 现实检查:同一 trace 的 main_turn 是否落在多个 session
    probes.multiMainRootTraces = db.prepare(
      `SELECT COUNT(*) n FROM (SELECT trace_id FROM model_usage WHERE query_source = 'main_turn' AND trace_id IS NOT NULL
         GROUP BY trace_id HAVING COUNT(DISTINCT session_id) > 1)`
    ).get().n;
    // attempt_index 取值(是否恒 0)与 cache_creation/provider_total/computed_total 语义
    probes.attemptIndexValues = db.prepare(`SELECT attempt_index v, COUNT(*) n FROM model_usage GROUP BY v ORDER BY v LIMIT 6`).all();
    probes.cacheCreationValues = db.prepare(`SELECT cache_creation_input_tokens v, COUNT(*) n FROM model_usage GROUP BY v ORDER BY n DESC LIMIT 4`).all();
    probes.totalsSemantics = db.prepare(
      `SELECT SUM(CASE WHEN computed_total_tokens = input_tokens + output_tokens THEN 1 ELSE 0 END) eq_in_out,
         SUM(CASE WHEN computed_total_tokens IS NOT NULL AND computed_total_tokens != input_tokens + output_tokens THEN 1 ELSE 0 END) neq,
         SUM(CASE WHEN provider_total_tokens IS NOT NULL THEN 1 ELSE 0 END) prov_present,
         SUM(CASE WHEN provider_total_tokens = input_tokens + output_tokens THEN 1 ELSE 0 END) prov_eq_in_out
       FROM model_usage`
    ).get();
    // error_type 在成功行上也非空(逻辑请求的历史错误记录在最终行)
    probes.errorTypeByStatus = db.prepare(
      `SELECT status, COUNT(*) n FROM model_usage WHERE error_type IS NOT NULL GROUP BY status`
    ).all();
    // run→actor→usage 链与 trace 交叉路径;多 run 共享父会话的歧义实例
    if (out.tables.dwf_run && out.tables.dwf_actor) {
      probes.dwfRunChain = db.prepare(
        `SELECT r.id rid, r.status, r.spent_tokens,
           (SELECT COUNT(*) FROM dwf_actor a WHERE a.run_id = r.id) actors,
           (SELECT COUNT(*) FROM model_usage m WHERE m.session_id IN (SELECT session_id FROM dwf_actor WHERE run_id = r.id)
              AND m.query_source = 'workflow_child') wf_rows_via_actor
         FROM dwf_run r ORDER BY r.time_created`
      ).all().map((r) => ({ run: alias("dwfrun", r.rid), status: r.status, spentTokens: r.spent_tokens, actors: r.actors, wfRowsViaActor: r.wf_rows_via_actor }));
      probes.wfSessionsCoveredByActor = db.prepare(
        `SELECT (SELECT COUNT(DISTINCT session_id) FROM model_usage WHERE query_source = 'workflow_child') wf_sessions,
           (SELECT COUNT(DISTINCT session_id) FROM model_usage WHERE query_source = 'workflow_child'
              AND session_id IN (SELECT session_id FROM dwf_actor WHERE session_id IS NOT NULL)) covered`
      ).get();
      probes.dwfTracePathForRun = db.prepare(
        `SELECT r.id rid,
           (SELECT COUNT(*) FROM model_usage w WHERE w.query_source = 'workflow_child' AND w.trace_id IN (
              SELECT DISTINCT trace_id FROM model_usage WHERE session_id = r.parent_session_id
                AND query_source = 'main_turn' AND trace_id IS NOT NULL)) wf_rows_via_trace
         FROM dwf_run r`
      ).all().map((r) => ({ run: alias("dwfrun", r.rid), wfRowsViaTrace: r.wf_rows_via_trace }));
    }
    // workflow 轮的 turn_usage 与 model_usage 逐字段对照(期望可能不相等)
    if (out.tables.turn_usage) {
      probes.wfTurnUsageVsModelUsage = db.prepare(
        `SELECT t.session_id sid, t.model_request_count req, t.input_tokens tu_in, t.output_tokens tu_out,
           (SELECT SUM(m.input_tokens) FROM model_usage m WHERE m.session_id = t.session_id AND m.turn_id = t.turn_id) mu_in,
           (SELECT SUM(m.output_tokens) FROM model_usage m WHERE m.session_id = t.session_id AND m.turn_id = t.turn_id) mu_out
         FROM turn_usage t
         WHERE EXISTS (SELECT 1 FROM model_usage m WHERE m.session_id = t.session_id AND m.turn_id = t.turn_id AND m.query_source = 'workflow_child')
         LIMIT 4`
      ).all().map((r) => ({ session: alias("sess", r.sid), req: r.req, tuIn: r.tu_in, tuOut: r.tu_out, muIn: r.mu_in, muOut: r.mu_out }));
      probes.turnUsageSessionKinds = db.prepare(
        `SELECT CASE WHEN session_id LIKE 'sess_subagent%' THEN 'subagent_session'
                     WHEN session_id LIKE 'sess_dwf%' THEN 'dwf_session' ELSE 'other' END k, COUNT(*) n
         FROM turn_usage GROUP BY k`
      ).all();
      probes.turnUsageOrphanKeys = db.prepare(
        `SELECT COUNT(*) n FROM turn_usage t WHERE NOT EXISTS (
           SELECT 1 FROM model_usage m WHERE m.session_id = t.session_id AND m.turn_id = t.turn_id)`
      ).get().n;
      // 回填时序:turn_usage.completed_at 与该轮最晚 model_usage.completed_at 的先后
      probes.turnUsageVsModelUsageTime = db.prepare(
        `SELECT COUNT(*) n,
           SUM(CASE WHEN t.completed_at >= (SELECT MAX(m.completed_at) FROM model_usage m
                 WHERE m.session_id = t.session_id AND m.turn_id = t.turn_id) THEN 1 ELSE 0 END) tu_not_before_mu,
           SUM(CASE WHEN t.completed_at < (SELECT MAX(m.completed_at) FROM model_usage m
                 WHERE m.session_id = t.session_id AND m.turn_id = t.turn_id) THEN 1 ELSE 0 END) tu_before_last_mu
         FROM turn_usage t WHERE EXISTS (
           SELECT 1 FROM model_usage m WHERE m.session_id = t.session_id AND m.turn_id = t.turn_id)`
      ).get();
      // user_message_id → message 表外键证据
      try {
        probes.turnUsageUserMessageId = db.prepare(
          `SELECT (SELECT COUNT(*) FROM turn_usage WHERE user_message_id IS NOT NULL) non_null,
             (SELECT COUNT(*) FROM turn_usage t WHERE t.user_message_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM message m WHERE m.id = t.user_message_id)) hits_message_id`
          ).get();
      } catch (e) { probes.turnUsageUserMessageId = { error: e.message }; }
    }
  } catch (e) { probes.error = e.message; }

  db.exec("COMMIT");
} catch (e) {
  try { db.exec("ROLLBACK"); } catch {}
  out.notes.push(`采样中断: ${e.message}`);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(`采样失败已写出部分证据: ${OUT}\n${e.stack}`);
  process.exit(1);
} finally {
  db.close();
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
// ---- 摘要(stdout 仅摘要,证据在文件)----
const mu = out.modelUsage;
console.log(`证据文件: ${OUT}`);
console.log(`表: ${Object.keys(out.tables).join(", ")}`);
console.log(`model_usage 行数: ${out.tables.model_usage?.rowCount}`);
if (mu.identity?.idStats) console.log(`id: distinct=${mu.identity.idStats.distinctId} null=${mu.identity.idStats.nullId} dup=${mu.identity.idStats.duplicates}`);
console.log(`status: ${JSON.stringify(mu.statusSemantics?.map((r) => `${r.status}:${r.n}`))}`);
console.log(`query_source: ${JSON.stringify(mu.querySourceDistribution?.map((r) => `${r.src}:${r.n}`))}`);
if (mu.recentWindow?.logicalRequest) {
  const L = mu.recentWindow.logicalRequest;
  console.log(`lrid: rows=${L.n} with=${L.with_lrid} distinct=${L.lrids} multiSession=${L.multiSessionLrids?.length ?? 0} multiProvider=${L.multiProviderLrids?.length ?? 0} dupAttempt=${L.duplicateLridAttempt?.length ?? 0}`);
  console.log(`groupsByAttempts: ${JSON.stringify(L.groupsByAttemptCount)}`);
  if (L.retryCountVsAttempts) console.log(`retryVsAttempts: ${JSON.stringify(L.retryCountVsAttempts)}`);
}
if (mu.recentWindow?.ttft) console.log(`ttft: ${JSON.stringify(mu.recentWindow.ttft)}`);
console.log(`turn_usage: rows=${out.tables.turn_usage?.rowCount} granularity=${JSON.stringify(out.turnUsage?.granularity?.rowsPerKey)} crossCheck=${JSON.stringify(out.turnUsage?.crossCheckSample)}`);
for (const [t, rec] of Object.entries(out.associations)) {
  console.log(`assoc ${t}: ${JSON.stringify(rec).slice(0, 300)}`);
}
