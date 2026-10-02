// 0.6.0 诊断引擎(spec §4/§5/§6/§7/§8/§9/§11):
//   - queryDetailed(sessionId, options):异步入口;调用方管理连接时须传入同一只读事务,
//     基础结果与全部诊断模块共享同一数据库快照(§11.1)。
//   - runDetailsParent / runDetailsWorker:CLI 的有界子进程模式——worker 在同一事务内完成基础
//     查询后先经 IPC 交付基础结果,再逐项交付完成的模块;超时由父进程终止,保留已交付部分,
//     未完成模块记 timeout,不输出半个累加桶(§11.2)。stdout 只有一个最终 JSON 对象。
// 证据边界以 docs/DATA-CONTRACT-0.6.0.md 为准:语义未验证的能力必须 unavailable/partial,
// 不以猜测填满字段;无证据不等于 0(contract-unverified 不可伪装 no-data,§9.2)。
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { validId, parseBool, querySettings } from "./runtime.mjs";

// token-rate.mjs 只能惰性加载:其 CLI 段位于顶层评估中,静态/提前导入会形成
// "token-rate 评估暂停等待 diagnostics → diagnostics 静态等待 token-rate 完成"的循环评估死锁。
// queryDetailed 等入口先 loadTokenRate() 再调用同步构建函数。
let TR = null;
async function loadTokenRate() {
  if (!TR) TR = await import("./token-rate.mjs");
  return TR;
}

export const DIAGNOSTICS_VERSION = 1;
// 契约标识:能力状态引用的验证基线;schema 变化时必须先更新 DATA-CONTRACT 再改此处。
export const CONTRACT_ID = "DATA-CONTRACT-0.6.0@2026-10-02";
export const DETAIL_MODULES = ["workflow", "reliability", "timing", "reconciliation"];
// reasonCode 集合(spec §9.2):schema-missing 缺表/列;contract-unverified 语义未验证;
// association-ambiguous 归属歧义;no-session 无有效会话;no-data 明确范围内确认无行;
// invalid-data 数据非法;timeout 预算耗尽;query-error 查询失败。
const WORKER_SCRIPT = fileURLToPath(new URL("./token-rate.mjs", import.meta.url));
const CLEANUP_RESERVE_MS = 500; // 超时后等待子进程退出并关闭资源的预留(§11.2 ≤500ms)
const MAX_GROUPS = 50;          // 模型/分组展示上限,超出合并为 other(§7)
const MAX_RUNS = 50;            // workflow run 列表上限(§5 有界输出)
const MAX_ERROR_VALUES = 10;    // error_type/code 脱敏统计基数上限(§6.1)

// ---- 小工具 ----
const clip = (v, n = 40) => {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001F\u007F]/g, "?"); // 控制字符不得污染报表(§6.1)
  return s.length > n ? s.slice(0, n) + "…" : s;
};
const runDisplayId = (raw) =>
  `run-${createHash("sha256").update(String(raw)).digest("base64url").slice(0, 10)}`; // 脱敏显示标识(§5)
const tableColumns = (db, table) => {
  try { return new Set(db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((c) => c.name)); }
  catch { return new Set(); }
};
// 分片参数拼接:组合 WHERE 时参数必须按 SQL 文本出现顺序展开
const frag = (sql, params = []) => ({ sql, params });
const orAll = (frags) => ({
  sql: frags.map((f) => `(${f.sql})`).join(" OR "),
  params: frags.flatMap((f) => f.params),
});
const moduleStatus = (status, data = null, extra = {}) => ({ status, data, warnings: [], ...extra });

export function parseDetailModules(raw) {
  const names = String(raw).split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  if (!names.length) return { ok: false, message: "--details 模块名单为空;可用: " + DETAIL_MODULES.join(", ") };
  const unknown = names.filter((n) => !DETAIL_MODULES.includes(n));
  if (unknown.length) return { ok: false, message: `未知 details 模块: ${unknown.join(", ")};可用: ${DETAIL_MODULES.join(", ")}`, unknown };
  return { ok: true, modules: [...new Set(names)] };
}

// ---- 能力探测(仅基于 PRAGMA;缺字段/未知映射时能力降级,基础查询不受影响,§3.2) ----
function probeCapabilities(db) {
  const mu = tableColumns(db, "model_usage");
  const dwfRun = tableColumns(db, "dwf_run");
  const dwfActor = tableColumns(db, "dwf_actor");
  const tu = tableColumns(db, "turn_usage");
  const workflowOk = dwfRun.has("id") && dwfRun.has("parent_session_id")
    && dwfActor.has("run_id") && dwfActor.has("session_id");
  const tuRequired = ["session_id", "turn_id", "input_tokens", "output_tokens", "model_request_count"];
  const tuOk = tuRequired.every((c) => tu.has(c));
  return {
    contract: CONTRACT_ID,
    rowIdentity: { status: "ok", method: "model_usage.id 主键(DATA-CONTRACT §1)" },
    traceAssociation: mu.has("trace_id")
      ? { status: "ok", method: "trace_id 与 root main_turn 共享(DATA-CONTRACT §4.1)" }
      : { status: "unavailable", reasonCode: "schema-missing", note: "model_usage 缺少 trace_id" },
    workflowAssociation: workflowOk
      ? { status: "ok", method: "dwf_run.parent_session_id → dwf_actor.session_id → model_usage.session_id(DATA-CONTRACT §4.2)" }
      : { status: "unavailable", reasonCode: "schema-missing", note: "dwf_run/dwf_actor 缺少归属键列" },
    turnUsageReconciliation: tuOk
      ? { status: "ok", method: "(session_id, turn_id) 复合主键,同快照精确比较整数 token(DATA-CONTRACT §7)" }
      : { status: "unavailable", reasonCode: "schema-missing", note: "turn_usage 缺少比较所需列" },
    retryAttempts: mu.has("logical_request_id")
      ? { status: "ok", method: "logical_request_id 分组 + attempt_index 有效性(DATA-CONTRACT §5)", retention: "观测:每个逻辑请求仅留存最终行,attempt_index 恒 0;失败尝试不留行" }
      : { status: "unavailable", reasonCode: "schema-missing", note: "model_usage 缺少 logical_request_id" },
    // 本问快照(wrapUpSample):默认关闭且未经真实宿主验收,任何版本不得宣称有效(§10.3)
    currentPrompt: { status: "unavailable", reasonCode: "contract-unverified",
      note: "wrapUpSample 默认关闭;hook stdin 的 turnId 运行时传递未验证,0.6.0 不返回本问数据" },
  };
}

// ---- SQL 分片(基于 DATA-CONTRACT 已验证的归属路径;trace 弱关联必须做歧义检测) ----
function scopeFragments(tr, db, sid, caps) {
  const { validIdSql, AUX_CLASS } = tr;
  const mu = "model_usage";
  const mainTraces = frag(
    `trace_id IN (SELECT DISTINCT trace_id FROM ${mu} WHERE session_id = ? AND query_source = 'main_turn' AND ${validIdSql("trace_id")})`,
    [sid]);
  // 多 root trace:同一 trace 的 main_turn 落在 ≥2 个会话 → 该 trace 的库外行不可归属(spec §4.2/A03)
  const multiRoot = frag(
    `trace_id IN (SELECT trace_id FROM ${mu} WHERE query_source = 'main_turn' AND ${validIdSql("trace_id")}
       AND trace_id IN (SELECT DISTINCT trace_id FROM ${mu} WHERE session_id = ? AND query_source = 'main_turn' AND ${validIdSql("trace_id")})
       GROUP BY trace_id HAVING COUNT(DISTINCT session_id) > 1)`,
    [sid]);
  const actorClaim = caps.workflowAssociation.status === "ok"
    ? frag(`session_id IN (SELECT session_id FROM dwf_actor WHERE run_id IN (SELECT id FROM dwf_run WHERE parent_session_id = ?))`, [sid])
    : frag("0"); // 无验证键时 actor 链为空集:workflow 行全部落入 unclassified/歧义,不补 0(A04)
  const auxList = Object.keys(AUX_CLASS).map((s) => `'${s.replace(/'/g, "''")}'`).join(", ");
  const nonBlankSrc = `query_source IS NOT NULL AND TRIM(query_source, ' ') != ''`;

  const main = frag(`session_id = ? AND query_source = 'main_turn'`, [sid]);
  const workflow = frag(`query_source = 'workflow_child' AND (${actorClaim.sql})`, actorClaim.params);
  const subagent = frag(
    `query_source = 'subagent' AND (session_id = ? OR (${mainTraces.sql} AND NOT (${multiRoot.sql})))`,
    [sid, ...mainTraces.params, ...multiRoot.params]);
  const auxiliary = frag(
    `query_source IN (${auxList}) AND (session_id = ? OR (${mainTraces.sql} AND NOT (${multiRoot.sql})))`,
    [sid, ...mainTraces.params, ...multiRoot.params]);
  const unclassified = orAll([
    // in-session 未知来源(含 NULL/空白;已知内部来源归 auxiliary,spec §4.2)
    frag(`session_id = ? AND query_source != 'main_turn' AND query_source != 'subagent' AND query_source != 'workflow_child'
            AND (query_source IS NULL OR query_source NOT IN (${auxList}))`, [sid]),
    // in-session workflow_child 但无 actor 链归属 → workflow 细分不可证(A04;actorClaim 为空桩时 NOT(0) 恒真)
    frag(`session_id = ? AND query_source = 'workflow_child' AND NOT (${actorClaim.sql})`, [sid, ...actorClaim.params]),
    // 库外 trace 弱关联的未知来源 / 未验证 workflow_child
    frag(`session_id <> ? AND ${nonBlankSrc} AND query_source NOT IN ('main_turn', 'subagent', 'workflow_child', ${auxList})
            AND ${mainTraces.sql} AND NOT (${multiRoot.sql})`, [sid, ...mainTraces.params, ...multiRoot.params]),
    frag(`session_id <> ? AND query_source = 'workflow_child' AND NOT (${actorClaim.sql}) AND ${mainTraces.sql} AND NOT (${multiRoot.sql})`,
      [sid, ...actorClaim.params, ...mainTraces.params, ...multiRoot.params]),
  ]);
  const ambiguous = frag(
    `session_id <> ? AND ${mainTraces.sql} AND (${multiRoot.sql}) AND NOT (query_source = 'workflow_child' AND (${actorClaim.sql}))`,
    [sid, ...mainTraces.params, ...multiRoot.params, ...actorClaim.params]);
  return { main, workflow, subagent, auxiliary, unclassified, ambiguous, mainTraces, multiRoot, actorClaim };
}

// ---- 桶聚合:单遍条件聚合,质量按字段给出 known/missing/invalid(spec §4.3) ----
const TOKEN_FIELDS = [
  ["input", "input_tokens"], ["output", "output_tokens"], ["reasoning", "reasoning_tokens"],
  ["cacheRead", "cache_read_input_tokens"], ["cacheCreation", "cache_creation_input_tokens"],
];

function bucketAggregate(tr, db, where, extraParams = []) {
  const { validNumSql, sumOk } = tr;
  const params = [...where.params, ...extraParams];
  const qualitySql = TOKEN_FIELDS.map(([name, col]) =>
    `, SUM(CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END) ${name}_missing,` +
    ` SUM(CASE WHEN ${col} IS NOT NULL AND NOT (${validNumSql(col)}) THEN 1 ELSE 0 END) ${name}_invalid`).join("");
  const row = db.prepare(
    `SELECT COUNT(*) requests, ${sumOk("input_tokens")} input, ${sumOk("output_tokens")} output,
       ${sumOk("reasoning_tokens")} reasoning, ${sumOk("cache_read_input_tokens")} cacheRead,
       ${sumOk("cache_creation_input_tokens")} cacheCreation${qualitySql}
     FROM model_usage WHERE ${where.sql}`
  ).get(...params);
  const fields = {};
  let invalidOrMissing = 0;
  for (const [name] of TOKEN_FIELDS) {
    const missing = row[`${name}_missing`] ?? 0;
    const invalid = row[`${name}_invalid`] ?? 0;
    invalidOrMissing += missing + invalid;
    fields[name] = { knownRows: (row.requests ?? 0) - missing - invalid, missingRows: missing, invalidRows: invalid };
  }
  const statusRows = db.prepare(
    `SELECT status, COUNT(*) n FROM model_usage WHERE ${where.sql} GROUP BY status ORDER BY n DESC`
  ).all(...params);
  return {
    requests: row.requests ?? 0,
    input: row.input ?? 0, output: row.output ?? 0, reasoning: row.reasoning ?? 0,
    cacheRead: row.cacheRead ?? 0, cacheCreation: row.cacheCreation ?? 0,
    total: (row.input ?? 0) + (row.output ?? 0),
    statusCounts: statusRows.map((r) => ({ status: r.status, requests: r.n,
      known: r.status === "completed" || r.status === "error" || r.status === "cancelled" })),
    quality: { tokensComplete: invalidOrMissing === 0, fields,
      note: invalidOrMissing ? "已知部分:存在缺失/非法 token 字段,对应值按 0 计,不冒充完整账单" : null },
  };
}

function addAggregates(target, source) {
  for (const k of ["requests", "input", "output", "reasoning", "cacheRead", "cacheCreation"]) {
    target[k] = (target[k] ?? 0) + (source[k] ?? 0);
  }
  target.total = target.input + target.output;
  return target;
}

// ---- accounting:互斥账本(分片互斥即并集去重;先分类,再汇总;§4.2) ----
function buildAccounting(tr, db, sid, caps, frags) {
  const buckets = {};
  const basis = {
    main: "session_id = root 且 query_source=main_turn",
    workflow: "dwf_run.parent_session_id → dwf_actor.session_id(权威链;trace 仅交叉验证)",
    subagent: "query_source=subagent 且 session=root 或与 root main_turn 共享 trace(多 root trace 已剔除)",
    auxiliary: "已知内部来源(session_title/goal_summary_title/compact/target_completion_verification)",
    unclassified: "与 root 相关但来源类别未知或 workflow 归属不可证",
  };
  for (const name of ["main", "workflow", "subagent", "auxiliary", "unclassified"]) {
    const agg = bucketAggregate(tr, db, frags[name]);
    agg.associationBasis = basis[name];
    buckets[name] = agg;
  }
  const observed = addAggregates({ requests: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheCreation: 0 }, buckets.main);
  for (const name of ["workflow", "subagent", "auxiliary", "unclassified"]) addAggregates(observed, buckets[name]);
  const tokensComplete = ["main", "workflow", "subagent", "auxiliary", "unclassified"].every((b) =>
    TOKEN_FIELDS.every(([n]) => buckets[b].quality.fields[n].missingRows + buckets[b].quality.fields[n].invalidRows === 0));

  const ambAgg = bucketAggregate(tr, db, frags.ambiguous);
  const ambiguousCandidates = ambAgg.requests
    ? { requests: ambAgg.requests, input: ambAgg.input, output: ambAgg.output, total: ambAgg.total,
        reason: "association-ambiguous",
        note: "这些行与多个 root 的 main_turn 共享 trace(或归属冲突),不纳入任何 root 总量;数量与已知用量仅作提示" }
    : { requests: 0, note: "明确范围内确认无歧义候选行" };

  return {
    scope: {
      rootSessionId: sid,
      sources: ["main_turn", "subagent", "workflow_child", "auxiliary(已知内部来源)", "unclassified(未知来源)"],
      statusRange: "库内留存的全部状态(completed/error/cancelled 及未映射状态,未映射单列)",
      retention: "仅库内留存行;已清理/未落库历史不可见;失败已记录用量不解释为额外收费",
      subagents: "诊断范围始终包含可归属的子代理与 workflow 行(与 includeSubagents 配置无关;兼容范围另见 session.scope)",
      note: "observedUsage 是『相关请求已记录用量』,不是 session.total 也不是全部历史真实消耗;缺少关联证据不等于已证明无 workflow",
    },
    observedUsage: { ...observed, quality: observedQuality(buckets), tokensComplete,
      text: "相关请求已记录用量(互斥分类守恒:五桶之和 = observedUsage)" },
    buckets,
    ambiguousCandidates,
    classification: { order: ["main", "workflow", "subagent", "auxiliary", "unclassified"],
      conflicts: [], // 结构上按 source 互斥;未来出现跨类冲突时在此记录并保留 main(spec §4.2)
      note: "分类顺序固定;逻辑请求 ID 不用于去重(一次逻辑请求可多次尝试,DATA-CONTRACT §5)" },
  };
}

function observedQuality(buckets) {
  const fields = {};
  for (const [name] of TOKEN_FIELDS) {
    let known = 0, missing = 0, invalid = 0;
    for (const b of Object.values(buckets)) {
      known += b.quality.fields[name].knownRows;
      missing += b.quality.fields[name].missingRows;
      invalid += b.quality.fields[name].invalidRows;
    }
    fields[name] = { knownRows: known, missingRows: missing, invalidRows: invalid };
  }
  return { fields };
}

// ---- workflow 模块(§5):run 列表 + 归属质量;无验证键时 unavailable ----
function buildWorkflow(tr, db, sid, caps, frags) {
  const { validIdSql } = tr;
  const out = moduleStatus("unavailable", null, { reasonCode: "contract-unverified" });
  if (caps.workflowAssociation.status !== "ok") {
    out.status = "unavailable";
    out.reasonCode = "schema-missing";
    out.warnings.push("dwf_run/dwf_actor 缺少已验证的归属键列;workflow 分账不可用,相关行保留在 unclassified,不补 0");
    return out;
  }
  const runs = db.prepare(
    `SELECT id rid, status, spent_tokens, time_created, time_updated,
       (SELECT COUNT(*) FROM dwf_actor a WHERE a.run_id = r.id) actors
     FROM dwf_run r WHERE parent_session_id = ? ORDER BY time_created DESC`
  ).all(sid);
  const runRows = [];
  const budgeted = runs.slice(0, MAX_RUNS);
  let workflowTotals = { requests: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheCreation: 0 };
  for (const r of budgeted) {
    const agg = bucketAggregate(tr, db, frag(
      `query_source = 'workflow_child' AND session_id IN (SELECT session_id FROM dwf_actor WHERE run_id = ?)`, [r.rid]));
    addAggregates(workflowTotals, agg);
    runRows.push({
      runId: runDisplayId(r.rid),
      status: r.status ?? null,
      actors: r.actors ?? 0,
      associationQuality: (r.actors ?? 0) > 0 ? "actor-chain(已验证)" : "no-actor(无 actor 映射,行数为 0;spent_tokens 为宿主上报摘要,不与 usage 相加)",
      requests: agg.requests, input: agg.input, output: agg.output, reasoning: agg.reasoning,
      cacheRead: agg.cacheRead, cacheCreation: agg.cacheCreation, total: agg.total,
      quality: agg.quality,
      reportedSpentTokens: typeof r.spent_tokens === "number" && Number.isFinite(r.spent_tokens) && r.spent_tokens >= 0 ? r.spent_tokens : null,
    });
  }
  // 守恒检查:run 之和必须等于 workflow 桶(同一行集合;§4.3)
  const bucketAgg = bucketAggregate(tr, db, frags.workflow);
  const conservationOk = runRows.reduce((s, r) => s + r.requests, 0) === bucketAgg.requests;
  const unattributed = db.prepare(
    `SELECT COUNT(*) n FROM model_usage WHERE query_source = 'workflow_child' AND session_id <> ? AND
       trace_id IN (SELECT DISTINCT trace_id FROM model_usage WHERE session_id = ? AND query_source = 'main_turn' AND ${validIdSql("trace_id")})
       AND NOT (${frags.actorClaim.sql})`
  ).all(sid, sid, ...frags.actorClaim.params)[0]?.n ?? 0;
  out.status = conservationOk ? "ok" : "partial";
  if (conservationOk) delete out.reasonCode; else out.reasonCode = "invalid-data";
  out.data = {
    associationPaths: ["dwf_run.parent_session_id → dwf_actor.session_id → model_usage.session_id(query_source=workflow_child)"],
    rootSessionId: sid,
    runs: runRows,
    runCountTotal: runs.length,
    truncatedRuns: Math.max(0, runs.length - budgeted.length),
    totals: { ...workflowTotals, total: workflowTotals.input + workflowTotals.output, conservation: conservationOk ? "run 之和 = workflow 桶" : "run 之和与 workflow 桶不一致,见 warnings" },
    unattributedTraceLinkedRows: unattributed,
    unattributedNote: "仅与当前 root 有 trace 弱关联、无 actor 链归属的 workflow_child 行数(已计入 unclassified,不冒充 workflow)",
    nodeLevelBreakdown: { status: "unavailable", reasonCode: "contract-unverified",
      note: "dwf_node/dwf_event 无指向 usage 行的链接列(DATA-CONTRACT §4.2),节点细分不提供" },
  };
  if (!conservationOk) out.warnings.push("run 级聚合与 workflow 桶守恒失败:存在跨 run 行归属异常,明细被标记 partial");
  if (runs.length > MAX_RUNS) out.warnings.push(`run 数超过 ${MAX_RUNS},仅展示最近 ${MAX_RUNS} 个,其余计入 runCountTotal`);
  return out;
}

// ---- reliability 模块(§6):状态/失败已记录用量/重叠特征/脱敏错误统计/retry 摘要 ----
function buildReliability(tr, db, caps, unionWhereRaw) {
  const { validNumSql, sumOk } = tr;
  const out = moduleStatus("unavailable", null, { reasonCode: "contract-unverified" });
  // 追加 AND 条件需要整体括号:避免 OR 优先级把条件只挂在最后一个分片上
  const scope = { sql: `(${unionWhereRaw.sql})`, params: unionWhereRaw.params };
  const qualitySql = TOKEN_FIELDS.map(([name, col]) =>
    `, SUM(CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END) ${name}_missing,
       SUM(CASE WHEN ${col} IS NOT NULL AND NOT (${validNumSql(col)}) THEN 1 ELSE 0 END) ${name}_invalid`).join("");
  const statusRows = db.prepare(
    `SELECT status, COUNT(*) requests, ${sumOk("input_tokens")} input, ${sumOk("output_tokens")} output,
       ${sumOk("reasoning_tokens")} reasoning, ${sumOk("cache_read_input_tokens")} cacheRead,
       ${sumOk("cache_creation_input_tokens")} cacheCreation${qualitySql}
     FROM model_usage WHERE ${scope.sql} GROUP BY status ORDER BY requests DESC`
  ).all(...scope.params);
  const knownStatuses = new Set(["completed", "error", "cancelled"]);
  const statusCounts = statusRows.map((r) => {
    const fields = {};
    for (const [name] of TOKEN_FIELDS) fields[name] = {
      knownRows: (r.requests ?? 0) - (r[`${name}_missing`] ?? 0) - (r[`${name}_invalid`] ?? 0),
      missingRows: r[`${name}_missing`] ?? 0, invalidRows: r[`${name}_invalid`] ?? 0 };
    return { status: r.status, known: knownStatuses.has(r.status), requests: r.requests ?? 0,
      input: r.input ?? 0, output: r.output ?? 0, reasoning: r.reasoning ?? 0,
      cacheRead: r.cacheRead ?? 0, cacheCreation: r.cacheCreation ?? 0,
      total: (r.input ?? 0) + (r.output ?? 0), quality: { fields,
        tokensComplete: Object.values(fields).every((f) => f.missingRows + f.invalidRows === 0) } };
  });
  const failed = statusCounts.filter((s) => s.status !== "completed");
  const failedUsage = failed.reduce((a, s) => ({ requests: a.requests + s.requests, input: a.input + s.input,
    output: a.output + s.output }), { requests: 0, input: 0, output: 0 });
  failedUsage.total = failedUsage.input + failedUsage.output;
  const flagCount = (col) => db.prepare(
    `SELECT COUNT(*) n FROM model_usage WHERE ${scope.sql} AND ${col} = 1`
  ).all(...scope.params)[0]?.n ?? 0;
  const sanitizedTop = (col) => {
    try {
      return db.prepare(
        `SELECT ${col} v, COUNT(*) n FROM model_usage WHERE ${scope.sql} AND ${col} IS NOT NULL GROUP BY ${col} ORDER BY n DESC LIMIT ${MAX_ERROR_VALUES}`
      ).all(...scope.params).map((r) => ({ value: clip(r.v), requests: r.n }));
    } catch { return []; }
  };
  const unterminated = db.prepare(
    `SELECT COUNT(*) n FROM model_usage WHERE ${scope.sql} AND completed_at IS NULL`
  ).all(...scope.params)[0]?.n ?? 0;
  out.status = "ok";
  out.data = {
    scopeNote: "诊断范围(与 accounting 相同行集合);requests 是 usage 行数,不是任务/轮次/逻辑请求数",
    statusCounts,
    unmappedStatusNote: statusCounts.some((s) => !s.known)
      ? "存在未映射的 raw status(已单列,未假设其语义);不能仅凭 completed_at 非空归为 completed" : null,
    failedRecordedUsage: { ...failedUsage,
      note: "失败行有已记录 input/output 即计入一次;无 token 则报缺失,不从成功请求推算;不是额外收费" },
    unterminatedRows: { requests: unterminated, note: unterminated ? "未终止行的 token 可能回填,不当最终消耗" : "明确范围内无未终止行" },
    overlappingFlags: {
      note: "cancelled_by_user / retryable / context_exceeded 是可重叠特征,不是可加的状态桶",
      cancelledByUser: flagCount("cancelled_by_user"),
      retryable: flagCount("retryable"),
      contextExceeded: flagCount("context_exceeded"),
    },
    errorTypes: { values: sanitizedTop("error_type"),
      note: "error_type 在成功行上也非空(逻辑请求的历史错误记录在最终行,DATA-CONTRACT §3);类别脱敏统计,error_message 不输出" },
    errorCodes: { values: sanitizedTop("error_code"), note: "error_code 当前宿主全 NULL(观测)" },
    retry: buildRetrySummary(tr, db, caps, scope),
  };
  if (out.status === "ok") delete out.reasonCode;
  return out;
}

// retry 子能力(§6.2):reported 摘要始终提供;尝试分组指标仅在 lrid 契约验证后开放
function buildRetrySummary(tr, db, caps, scope) {
  const { validNumSql, validIdSql } = tr;
  if (!caps.retryAttempts || caps.retryAttempts.status !== "ok") {
    return { status: "unavailable", reasonCode: "schema-missing",
      note: "model_usage 缺少 logical_request_id,尝试分组指标不可用" };
  }
  const scopeSql = `FROM model_usage WHERE ${scope.sql}`;
  const reported = db.prepare(
    `SELECT SUM(CASE WHEN ${validNumSql("retry_count")} AND retry_count > 0 THEN 1 ELSE 0 END) rows_with_retry,
       MAX(CASE WHEN ${validNumSql("retry_count")} THEN retry_count END) max_reported,
       SUM(CASE WHEN retry_count IS NOT NULL AND NOT (${validNumSql("retry_count")}) THEN 1 ELSE 0 END) invalid_values
     ${scopeSql}`
  ).all(...scope.params)[0] ?? {};
  // 分组:仅 validId(lrid) 的行进入组;重复/缺失/非法 attempt_index 的组被标记,不产出准确重试指标(R03)
  const g = db.prepare(
    `WITH scope AS MATERIALIZED (SELECT logical_request_id lrid, attempt_index ai, session_id, provider_id ${scopeSql}),
       grp AS (SELECT lrid, COUNT(*) rows_n,
         COUNT(DISTINCT CASE WHEN typeof(ai) = 'integer' AND ai >= 0 THEN ai END) valid_attempts,
         SUM(CASE WHEN ai IS NULL THEN 1 ELSE 0 END) missing_ai,
         SUM(CASE WHEN ai IS NOT NULL AND NOT (typeof(ai) = 'integer' AND ai >= 0) THEN 1 ELSE 0 END) invalid_ai,
         COUNT(DISTINCT session_id) sessions, COUNT(DISTINCT provider_id) providers
       FROM scope WHERE ${validIdSql("lrid")} GROUP BY lrid)
     SELECT COUNT(*) groups_total, COALESCE(SUM(rows_n), 0) grouped_rows,
       COALESCE(SUM(CASE WHEN missing_ai = 0 AND invalid_ai = 0 AND rows_n = valid_attempts AND valid_attempts > 1 THEN 1 ELSE 0 END), 0) retried_clean,
       COALESCE(SUM(CASE WHEN missing_ai = 0 AND invalid_ai = 0 AND rows_n = valid_attempts AND valid_attempts > 1 THEN valid_attempts - 1 ELSE 0 END), 0) additional_clean,
       COALESCE(SUM(CASE WHEN missing_ai > 0 OR invalid_ai > 0 OR rows_n > valid_attempts THEN 1 ELSE 0 END), 0) flagged_groups,
       COALESCE(SUM(CASE WHEN sessions > 1 THEN 1 ELSE 0 END), 0) multi_session_groups,
       COALESCE(SUM(CASE WHEN providers > 1 THEN 1 ELSE 0 END), 0) multi_provider_groups
     FROM grp`
  ).all(...scope.params)[0] ?? {};
  const attemptRows = db.prepare(`SELECT COUNT(*) n ${scopeSql}`).all(...scope.params)[0]?.n ?? 0;
  const ungroupedRows = db.prepare(
    `SELECT COUNT(*) n ${scopeSql} AND (logical_request_id IS NULL OR NOT ${validIdSql("logical_request_id")})`
  ).all(...scope.params)[0]?.n ?? 0;
  const attempts = {
    attemptRows,
    groupedAttemptRows: (g.grouped_rows ?? 0),
    ungroupedAttemptRows: ungroupedRows,
    logicalRequestsObserved: g.groups_total ?? 0,
    retriedLogicalRequestsObserved: g.retried_clean ?? 0,
    additionalAttemptsObserved: g.additional_clean ?? 0,
    groupQuality: {
      flaggedGroups: g.flagged_groups ?? 0,
      multiSessionGroups: g.multi_session_groups ?? 0,
      multiProviderGroups: g.multi_provider_groups ?? 0,
      note: "重复/缺失/非法 attempt_index 的组不产出准确重试指标;其 token 行仍按原样计入账本,不删除行『修正』数据(R03)",
    },
    retentionNote: "attemptRows 是库内留存行数:当前宿主每逻辑请求仅留存 1 行(DATA-CONTRACT §5),观察到的额外尝试为 0 不代表未发生重试",
  };
  return {
    status: "ok",
    reported: {
      rowsWithRetryCount: reported.rows_with_retry ?? 0,
      maxRetryCountObserved: reported.max_reported ?? null,
      invalidValues: reported.invalid_values ?? 0,
      note: "宿主上报值:最终行记录该逻辑请求的重试历史;失败尝试不留行(DATA-CONTRACT §5),不与观察尝试数相加,不推测丢失尝试",
    },
    attempts,
  };
}

// ---- timing 模块(§7):TTFT/Decode 与 provider+model 分组;基础范围 = completed main_turn ----
function buildTiming(tr, db, sid, caps, { min, max }) {
  const { validNumSql, finiteNumSql, DURATION_SQL, DECODE_MIN_MS } = tr;
  const out = moduleStatus("unavailable", null, { reasonCode: "query-error" });
  const durExpr = DURATION_SQL;
  const explicit = "time_to_first_token_ms";
  const derived = "first_token_at - started_at";
  const validDur = validNumSql(durExpr);
  // TTFT 使用值:显式合法优先;显式非法不静默回退(§7);回退仅当显式为 NULL 且两端均为有限数值
  const ttftUse = `CASE
    WHEN ${validNumSql(explicit)} AND ${validDur} AND ${explicit} <= ${durExpr} THEN ${explicit}
    WHEN ${explicit} IS NULL AND ${finiteNumSql("first_token_at")} AND ${finiteNumSql("started_at")}
      AND ${validDur} AND ${derived} >= 0 AND ${derived} <= ${durExpr} THEN ${derived}
    ELSE NULL END`;
  const baseCte = `WITH s AS MATERIALIZED (SELECT ${durExpr} dur_ms, ${ttftUse} ttft_val, ${explicit} ttft_raw,
      first_token_at, started_at, output_tokens, provider_id, model_id
    FROM model_usage WHERE session_id = ? AND status = 'completed' AND query_source = 'main_turn')`;
  const derivedCond = `ttft_raw IS NULL AND ${finiteNumSql("first_token_at")} AND ${finiteNumSql("started_at")}`;
  const row = db.prepare(
    `${baseCte} SELECT COUNT(*) candidates,
      SUM(CASE WHEN ttft_val IS NOT NULL AND ttft_raw IS NOT NULL THEN 1 ELSE 0 END) direct,
      SUM(CASE WHEN ttft_val IS NOT NULL AND ttft_raw IS NULL THEN 1 ELSE 0 END) derived,
      SUM(CASE WHEN ttft_val IS NULL AND (ttft_raw IS NOT NULL OR (${derivedCond})) THEN 1 ELSE 0 END) invalid,
      SUM(CASE WHEN ttft_val IS NULL AND ttft_raw IS NULL AND NOT (${derivedCond}) THEN 1 ELSE 0 END) missing,
      SUM(CASE WHEN ${validNumSql("dur_ms")} AND dur_ms >= ? AND dur_ms < ? AND ${validNumSql("output_tokens")} AND output_tokens > 0 THEN 1 ELSE 0 END) v_samples,
      SUM(CASE WHEN ${validNumSql("dur_ms")} AND dur_ms >= ? AND dur_ms < ? AND ${validNumSql("output_tokens")} AND output_tokens > 0 AND ${validNumSql("ttft_val")} AND ttft_val <= dur_ms AND dur_ms - ttft_val >= ${DECODE_MIN_MS} THEN 1 ELSE 0 END) d_samples,
      SUM(CASE WHEN ${validNumSql("dur_ms")} AND dur_ms >= ? AND dur_ms < ? AND ${validNumSql("output_tokens")} AND output_tokens > 0 AND ${validNumSql("ttft_val")} AND ttft_val <= dur_ms AND dur_ms - ttft_val >= ${DECODE_MIN_MS} THEN output_tokens ELSE 0 END) d_num,
      SUM(CASE WHEN ${validNumSql("dur_ms")} AND dur_ms >= ? AND dur_ms < ? AND ${validNumSql("output_tokens")} AND output_tokens > 0 AND ${validNumSql("ttft_val")} AND ttft_val <= dur_ms AND dur_ms - ttft_val >= ${DECODE_MIN_MS} THEN dur_ms - ttft_val ELSE 0 END) d_den
    FROM s`
  ).get(sid, min, max, min, max, min, max, min, max);
  const tStats = db.prepare(
    `${baseCte}, t AS (SELECT ttft_val v FROM s WHERE ttft_val IS NOT NULL),
       tw AS (SELECT v, ROW_NUMBER() OVER (ORDER BY v) rn, COUNT(*) OVER () cnt, AVG(v) OVER () mean FROM t)
     SELECT (SELECT COUNT(*) FROM t) n, (SELECT AVG(v) FROM t) mean,
       (SELECT v FROM tw WHERE rn = CAST(CEIL(0.5 * cnt) AS INTEGER)) median,
       (SELECT v FROM tw WHERE rn = CAST(CEIL(0.9 * cnt) AS INTEGER)) p90`
  ).get(sid);
  const groupQuery = (valueExpr, extraWhere) => db.prepare(
    `${baseCte}, g AS (SELECT COALESCE(NULLIF(TRIM(provider_id), ''), '(unknown)') provider,
        COALESCE(NULLIF(TRIM(model_id), ''), '(unknown)') model, ${valueExpr} v FROM s WHERE ${extraWhere}),
       gw AS (SELECT provider, model, v, ROW_NUMBER() OVER (PARTITION BY provider, model ORDER BY v) rn,
        COUNT(*) OVER (PARTITION BY provider, model) cnt, AVG(v) OVER (PARTITION BY provider, model) gmean FROM g)
     SELECT provider, model, MAX(cnt) n, MAX(gmean) mean,
       MAX(CASE WHEN rn = CAST(CEIL(0.5 * cnt) AS INTEGER) THEN v END) median,
       MAX(CASE WHEN rn = CAST(CEIL(0.9 * cnt) AS INTEGER) THEN v END) p90
     FROM gw GROUP BY provider, model ORDER BY n DESC, model LIMIT ${MAX_GROUPS + 1}`
  );
  const ttftGroups = tStats.n ? groupQuery("ttft_val", "ttft_val IS NOT NULL").all(sid) : [];
  const D = `${validNumSql("dur_ms")} AND dur_ms >= ? AND dur_ms < ? AND ${validNumSql("output_tokens")} AND output_tokens > 0 AND ${validNumSql("ttft_val")} AND ttft_val <= dur_ms AND dur_ms - ttft_val >= ${DECODE_MIN_MS}`;
  const decodeGroups = row.d_samples ? db.prepare(
    `${baseCte}, g AS (SELECT COALESCE(NULLIF(TRIM(provider_id), ''), '(unknown)') provider,
        COALESCE(NULLIF(TRIM(model_id), ''), '(unknown)') model, output_tokens * 1000.0 / (dur_ms - ttft_val) v FROM s WHERE ${D}),
       gw AS (SELECT provider, model, v, ROW_NUMBER() OVER (PARTITION BY provider, model ORDER BY v) rn,
        COUNT(*) OVER (PARTITION BY provider, model) cnt, AVG(v) OVER (PARTITION BY provider, model) gmean FROM g)
     SELECT provider, model, MAX(cnt) n, MAX(gmean) mean,
       MAX(CASE WHEN rn = CAST(CEIL(0.5 * cnt) AS INTEGER) THEN v END) median,
       MAX(CASE WHEN rn = CAST(CEIL(0.9 * cnt) AS INTEGER) THEN v END) p90
     FROM gw GROUP BY provider, model ORDER BY n DESC, model LIMIT ${MAX_GROUPS + 1}`
  ).all(sid, min, max).map((r) => ({ provider: r.provider, model: r.model, samples: r.n,
    mean: r.mean != null ? Math.round(r.mean * 10) / 10 : null,
    median: r.median != null ? Math.round(r.median * 10) / 10 : null,
    p90: r.p90 != null ? Math.round(r.p90 * 10) / 10 : null })) : [];
  const splitGroups = (groups) => ({
    groups: groups.slice(0, MAX_GROUPS).map((g) => ({ ...g,
      mean: g.mean != null ? Math.round(g.mean * 10) / 10 : null,
      median: g.median != null ? Math.round(g.median * 10) / 10 : null,
      p90: g.p90 != null ? Math.round(g.p90 * 10) / 10 : null })),
    other: groups.length > MAX_GROUPS ? { note: `超过 ${MAX_GROUPS} 组的部分合并为 other(合并规则:按样本数取前 ${MAX_GROUPS} 组,其余不再细分)`, groups: groups.length - MAX_GROUPS } : null,
  });
  out.status = "ok";
  out.data = {
    scopeNote: "基础范围 = completed main_turn(与 0.5.5 decodeStats 对齐);TTFT 是首 token 等待,不是 HTTP TTFB",
    candidates: row.candidates ?? 0,
    ttft: {
      direct: row.direct ?? 0, derived: row.derived ?? 0, invalid: row.invalid ?? 0, missing: row.missing ?? 0,
      validSamples: tStats.n ?? 0,
      mean: tStats.mean != null ? Math.round(tStats.mean * 10) / 10 : null,
      median: tStats.median != null ? Math.round(tStats.median) : null,
      p90: tStats.p90 != null ? Math.round(tStats.p90) : null,
      note: "mean 为请求算术均值,median/p90 为 nearest-rank;非 token 加权;零输出行也可有有效等待",
    },
    decode: {
      validSamples: row.d_samples ?? 0, e2eSamples: row.v_samples ?? 0,
      numeratorOutputTokens: row.d_num ?? 0, denominatorDecodeMs: row.d_den ?? 0,
      note: "有效集与 §4.4 相同(解码窗口 ≥200ms);分子分母为原始值",
    },
    byModel: { ttft: splitGroups(ttftGroups), decode: decodeGroups.length ? splitGroups(decodeGroups) : { groups: [], other: null },
      note: "provider_id+model_id 分组;同名 model 不跨 provider 合并;缺 provider 归入 (unknown);零样本组不出现(仅有样本的组)" },
  };
  if (out.status === "ok") delete out.reasonCode;
  return out;
}

// ---- reconciliation 模块(§8):最近已观察主轮;同快照;整数精确比较 ----
function buildReconciliation(tr, db, sid, caps, base) {
  const { sumOk } = tr;
  const out = moduleStatus("unavailable", null, { reasonCode: "contract-unverified" });
  if (!caps.turnUsageReconciliation || caps.turnUsageReconciliation.status !== "ok") {
    out.status = "unavailable";
    out.reasonCode = "schema-missing";
    out.warnings.push("turn_usage 缺少比较所需列/表;对账不可用,不影响基础查询与健康检查");
    return out;
  }
  const turnId = base.turn?.turnId ?? null;
  if (turnId == null) {
    out.status = "unavailable";
    out.reasonCode = "no-data";
    out.data = { note: "明确范围内无最近已观察且 ID 有效的主轮,不对账" };
    return out;
  }
  const tuCols = tableColumns(db, "turn_usage");
  const tuRow = db.prepare(`SELECT * FROM turn_usage WHERE session_id = ? AND turn_id = ?`).get(sid, turnId);
  if (!tuRow) {
    out.status = "ok";
    delete out.reasonCode;
    out.data = {
      turnId, result: "missing-aggregate",
      note: "该轮在 turn_usage 无聚合行(可能尚未聚合/回填;单次快照不同不定性数据损坏,回填后重查可变 matched)",
    };
    return out;
  }
  const mu = db.prepare(
    `SELECT COUNT(*) requests,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) completed_requests,
       ${sumOk("input_tokens")} input, ${sumOk("output_tokens")} output, ${sumOk("reasoning_tokens")} reasoning,
       ${sumOk("cache_read_input_tokens")} cacheRead, ${sumOk("cache_creation_input_tokens")} cacheCreation
     FROM model_usage WHERE session_id = ? AND turn_id = ?`
  ).get(sid, turnId);
  // 比较面:token 总和取 completed 行(证据:turn_usage 与 completed 行聚合精确相等,DATA-CONTRACT §7);
  // 行数与 model_request_count 按全部状态行比较。
  const compareDefs = [
    ["model_request_count", "requests", tuRow.model_request_count, mu.requests],
    ["input_tokens", "input", tuRow.input_tokens, mu.input],
    ["output_tokens", "output", tuRow.output_tokens, mu.output],
    ["reasoning_tokens", "reasoning", tuCols.has("reasoning_tokens") ? tuRow.reasoning_tokens : undefined, mu.reasoning],
    ["cache_read_input_tokens", "cacheRead", tuCols.has("cache_read_input_tokens") ? tuRow.cache_read_input_tokens : undefined, mu.cacheRead],
    ["cache_creation_input_tokens", "cacheCreation", tuCols.has("cache_creation_input_tokens") ? tuRow.cache_creation_input_tokens : undefined, mu.cacheCreation],
  ];
  const comparedFields = [];
  let anyInvalid = false, anyDifferent = false;
  for (const [tuField, muField, tuVal, muVal] of compareDefs) {
    if (tuVal === undefined) continue; // turn_usage 缺该列 → 跳过,不算 invalid
    const tuInt = typeof tuVal === "number" && Number.isInteger(tuVal);
    const muInt = typeof muVal === "number" && Number.isInteger(muVal);
    const invalid = !tuInt || !muInt;
    const different = tuInt && muInt && muVal !== tuVal;
    if (invalid) anyInvalid = true;
    if (different) anyDifferent = true;
    comparedFields.push({ field: tuField, modelUsage: muVal, turnUsage: tuVal,
      delta: tuInt && muInt ? muVal - tuVal : null,
      note: invalid ? "存在非整数值,字段不参与精确比较" : different ? `delta = model_usage − turn_usage = ${muVal - tuVal};当前快照不一致,可能尚未回填,不定性损坏` : null });
  }
  out.status = "ok";
  out.data = {
    turnId,
    result: anyInvalid ? "invalid" : anyDifferent ? "different" : "matched",
    comparedFields,
    modelUsage: { requests: mu.requests ?? 0, completedRequests: mu.completed_requests ?? 0,
      scopeNote: "同 (session,turn) 键下全部 usage 行;token 求和限 completed 行(非 completed 行已记录量不计入比较面,失败用量见 reliability)" },
    turnUsage: { status: tuRow.status ?? null, modelRequestCount: tuRow.model_request_count ?? null,
      note: "turn_usage 行级 status 是轮级状态,与请求状态不同" },
    scopeNote: "仅比较同键主轮聚合;不与含 workflow/子代理的会话总数比较;两表不可相加,turn_usage 不成为主数据源",
    snapshotNote: "同一只读事务快照内读取;排除两次独立读取的采样差,但不排除宿主异步聚合滞后",
  };
  if (out.status === "ok") delete out.reasonCode;
  return out;
}

// ---- 状态聚合(§9.2):全部 ok=ok;全部 unavailable=unavailable;全部 error=error;其余 partial ----
export function aggregateStatus(statuses) {
  const s = [...new Set(statuses)];
  if (s.length === 1) return s[0];
  if (s.every((x) => x === "unavailable")) return "unavailable";
  if (s.every((x) => x === "error")) return "error";
  return "partial";
}

// ---- 组装诊断封包 ----
async function buildDiagnostics(tr, db, base, options) {
  const { modules, notify, deadline, moduleGate, min, max } = options;
  const sid = base.sessionId;
  const caps = probeCapabilities(db);
  const requested = modules && modules.length ? modules : [...DETAIL_MODULES];
  const remaining = () => deadline == null || Date.now() < deadline;
  const timeoutModule = (name) => moduleStatus("error", null, { reasonCode: "timeout",
    warnings: [`预算内未完成 ${name} 模块;已终止,不输出半个累加桶`] });

  const envelope = {
    version: DIAGNOSTICS_VERSION,
    snapshotId: randomUUID(),
    sampledAt: base.sampledAt,
    sampledAtText: base.sampledAtText,
    rootSessionId: sid,
    scope: null,
    status: "ok",
    capabilities: caps,
    accounting: null,
    workflow: { status: "not-requested", data: null, warnings: [] },
    reliability: { status: "not-requested", data: null, warnings: [] },
    timing: { status: "not-requested", data: null, warnings: [] },
    reconciliation: { status: "not-requested", data: null, warnings: [] },
    warnings: [],
  };
  if (!sid) {
    envelope.scope = { rootSessionId: null, note: "未解析到有效会话;诊断不可用,不自动汇总全库" };
    for (const name of requested) envelope[name] = moduleStatus("unavailable", null, { reasonCode: "no-session",
      warnings: ["诊断必须解析到有效 session;缺省保持原识别链,失败即 unavailable(§9.1)"] });
    envelope.status = aggregateStatus(requested.map((n) => envelope[n].status));
    return envelope;
  }
  envelope.scope = {
    rootSessionId: sid,
    statusRange: "库内留存的全部状态",
    retention: "仅库内留存行",
    note: "诊断范围与兼容范围(0.5.5 默认行)分别注明;includeSubagents 只影响兼容范围",
  };
  notify?.({ type: "meta", payload: { version: envelope.version, snapshotId: envelope.snapshotId,
    sampledAt: envelope.sampledAt, sampledAtText: envelope.sampledAtText, rootSessionId: envelope.rootSessionId,
    scope: envelope.scope, capabilities: caps, requestedModules: requested } });

  const needsAccounting = requested.includes("workflow") || requested.includes("reliability");
  let frags = null;
  if (needsAccounting) {
    if (!remaining()) { markTimeoutAll(envelope, requested, ["workflow", "reliability"]); }
    else {
      frags = scopeFragments(tr, db, sid, caps);
      envelope.accounting = buildAccounting(tr, db, sid, caps, frags);
      notify?.({ type: "accounting", payload: envelope.accounting });
      if (requested.includes("workflow")) {
        if (moduleGate) await moduleGate("workflow");
        if (!remaining()) envelope.workflow = timeoutModule("workflow");
        else { envelope.workflow = buildWorkflow(tr, db, sid, caps, frags); notify?.({ type: "module", name: "workflow", payload: envelope.workflow }); }
      }
      if (requested.includes("reliability")) {
        if (moduleGate) await moduleGate("reliability");
        if (!remaining()) envelope.reliability = timeoutModule("reliability");
        else {
          envelope.reliability = buildReliability(tr, db, caps, orAll([
            frags.main, frags.workflow, frags.subagent, frags.auxiliary, frags.unclassified,
          ]));
          notify?.({ type: "module", name: "reliability", payload: envelope.reliability });
        }
      }
    }
  }
  if (requested.includes("timing")) {
    if (moduleGate) await moduleGate("timing");
    if (!remaining()) envelope.timing = timeoutModule("timing");
    else { envelope.timing = buildTiming(tr, db, sid, caps, { min, max }); notify?.({ type: "module", name: "timing", payload: envelope.timing }); }
  }
  if (requested.includes("reconciliation")) {
    if (moduleGate) await moduleGate("reconciliation");
    if (!remaining()) envelope.reconciliation = timeoutModule("reconciliation");
    else { envelope.reconciliation = buildReconciliation(tr, db, sid, caps, base); notify?.({ type: "module", name: "reconciliation", payload: envelope.reconciliation }); }
  }
  if (sid && !envelope.accounting) {
    envelope.accountingNote = needsAccounting
      ? "预算内未完成账本计算(已终止,不输出半个累加桶)"
      : "workflow/reliability 未请求;互斥分账未计算(请求其一即返回 accounting)";
  }
  envelope.status = aggregateStatus(requested.map((n) => envelope[n].status));
  return envelope;
}

function markTimeoutAll(envelope, requested, names) {
  for (const name of requested.filter((n) => names.includes(n))) {
    envelope[name] = moduleStatus("error", null, { reasonCode: "timeout", warnings: ["预算耗尽,模块未执行"] });
  }
}

// ---- 公共异步入口(§9.1):进程内执行,基础与模块同一只读事务 ----
export async function queryDetailed(sessionId, options = {}) {
  if (sessionId != null && !validId(sessionId)) throw new Error("显式会话 sessionId 必须为非空字符串");
  const tr = await loadTokenRate();
  const { openDb, queryOnceInTxn } = tr;
  const { history, min, max } = querySettings(); // 门禁一致性:min/max 与快速路径同源
  const db = openDb(options.dbPath);
  try {
    db.exec("BEGIN");
    try {
      const lastSessionFile = options.lastSessionFile
        || process.env.ZCODE_TPS_LAST_SESSION
        || path.join(os.homedir(), ".zcode", "zcode-tps.last-session.json");
      const base = queryOnceInTxn(db, sessionId ?? null, parseBool(options.includeSubagents, true), lastSessionFile,
        process.env.ZCODE_TPS_TIMEZONE ?? options.timezone, true);
      options.notify?.({ type: "base", payload: base });
      const diagnostics = await buildDiagnostics(tr, db, base, {
        modules: options.modules, notify: options.notify, deadline: options.deadline,
        moduleGate: options.moduleGate, min, max,
      });
      db.exec("COMMIT");
      return { ...base, diagnostics };
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      throw e;
    }
  } finally {
    db.close();
  }
}

// ---- 有界子进程模式(§11.2) ----
const isIpcAvailable = () => typeof process.send === "function";
const sendSafe = (msg) => { try { process.send(msg); } catch {} };

export function runDetailsWorker() {
  if (!isIpcAvailable()) { process.exit(1); }
  let running = false;
  process.on("message", (m) => {
    if (!m || m.tps !== "run" || running) return;
    running = true;
    handleWorkerRun(m).catch((e) => {
      sendSafe({ tps: "fatal", error: e?.message ?? String(e) });
      process.exitCode = 1;
    });
  });
  sendSafe({ tps: "ready" });
  // 不 process.exit:IPC message 监听维持事件循环;run 结束、通道排空后自然退出,
  // 避免 process.exit 截断最后一条 IPC 消息。
}

async function handleWorkerRun(m) {
  const budget = Number(process.env.ZCODE_TPS_DETAILS_BUDGET_MS) || 5000;
  const deadline = Date.now() + Math.max(200, budget - 200); // worker 内软预算略先于父进程硬预算
  try {
    await queryDetailed(m.sessionId, {
      modules: m.modules, timezone: m.timezone, includeSubagents: m.includeSubagents,
      dbPath: m.dbPath, deadline,
      notify: (evt) => sendSafe({ tps: evt.type, ...evt }),
    });
    sendSafe({ tps: "done" });
  } catch (e) {
    sendSafe({ tps: "fatal", error: e?.message ?? String(e) });
    process.exitCode = 1;
  }
}

// 父进程:入口预算(默认 5s)+ 清理预留(≤500ms);超时终止子进程,保留已交付部分(§11.2)
export async function runDetailsParent({ sessionId, modules, timezone, includeSubagents, dbPath }) {
  const budget = Number(process.env.ZCODE_TPS_DETAILS_BUDGET_MS) || 5000;
  const startedAt = Date.now();
  let child;
  try {
    child = spawn(process.execPath, [WORKER_SCRIPT, "--details-worker"], {
      stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true,
    });
  } catch (e) {
    console.log(JSON.stringify({ error: `详情子进程无法启动: ${e?.message ?? e}`, db: dbPath }, null, 2));
    return 1;
  }
  const state = { base: null, meta: null, accounting: null, modules: new Map(), fatal: null, done: false, closed: false };
  child.on("message", (m) => {
    if (!m || !m.tps) return;
    if (m.tps === "base") state.base = m.payload;
    else if (m.tps === "meta") state.meta = m.payload;
    else if (m.tps === "accounting") state.accounting = m.payload;
    else if (m.tps === "module") state.modules.set(m.name, m.payload);
    else if (m.tps === "fatal") state.fatal = m.error;
    else if (m.tps === "done") state.done = true;
  });
  child.on("error", (e) => { state.fatal = state.fatal ?? `详情子进程错误: ${e?.message ?? e}`; });
  // 任务派发:worker 顶层代码先就绪,再接收 run 消息(§11.2 同事务交付顺序由 worker 内保证)
  child.send({ tps: "run", sessionId, modules, timezone, includeSubagents, dbPath });
  const timedOut = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, Math.max(100, CLEANUP_RESERVE_MS - 200));
      finish(true);
    }, Math.max(200, budget));
    child.on("close", () => { state.closed = true; finish(false); });
  });
  if (!state.closed) {
    // 清理预留:等待子进程退出,最多 CLEANUP_RESERVE_MS
    await new Promise((resolve) => {
      const t = setTimeout(() => resolve(), CLEANUP_RESERVE_MS);
      child.once("close", () => { clearTimeout(t); resolve(); });
    });
  }
  const elapsed = Date.now() - startedAt;
  if (!state.base) {
    const error = state.fatal ?? `详情查询超时(${elapsed}ms 内基础查询未完成,已终止详情子进程;用量库可能被持续锁定或数据过大)`;
    console.log(JSON.stringify({ error, db: dbPath }, null, 2));
    return 1;
  }
  const diagnostics = {
    ...(state.meta ?? { version: DIAGNOSTICS_VERSION, capabilities: probeCapabilitiesUnavailable(), requestedModules: modules }),
    accounting: state.accounting ?? null,
    workflow: { status: "not-requested", data: null, warnings: [] },
    reliability: { status: "not-requested", data: null, warnings: [] },
    timing: { status: "not-requested", data: null, warnings: [] },
    reconciliation: { status: "not-requested", data: null, warnings: [] },
  };
  const requested = state.meta?.requestedModules ?? modules;
  for (const name of requested) {
    diagnostics[name] = state.modules.get(name) ?? moduleStatus("error", null, { reasonCode: "timeout",
      warnings: [`预算内未完成 ${name} 模块;已终止,不输出半个累加桶(实际用时 ${elapsed}ms)`] });
  }
  diagnostics.status = aggregateStatus(requested.map((n) => diagnostics[n].status));
  state.base.diagnostics = diagnostics;
  console.log(JSON.stringify(state.base, null, 2));
  return 0;
}

function probeCapabilitiesUnavailable() {
  return { contract: CONTRACT_ID, note: "meta 消息未及送达(超时),能力列表不可用" };
}
