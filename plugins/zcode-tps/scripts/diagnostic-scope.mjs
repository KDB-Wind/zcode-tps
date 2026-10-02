// 诊断专用 SQL 适配层:只读 CTE、按 session/trace 索引取候选,不改变默认查询。
const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
export function hasUniqueKey(db, table, columns) {
  const same = (actual) => actual.length === columns.length && columns.every((c) => actual.includes(c));
  const info = db.prepare("PRAGMA table_info(" + quote(table) + ")").all();
  const pk = info.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  if (same(pk)) return true;
  return db.prepare("PRAGMA index_list(" + quote(table) + ")").all().some((i) => i.unique && !i.partial &&
    same(db.prepare("PRAGMA index_info(" + quote(i.name) + ")").all().map((c) => c.name)));
}
const COLUMNS = ["id", "session_id", "turn_id", "trace_id", "query_source", "status", "provider_id", "model_id",
  "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
  "logical_request_id", "attempt_index", "retry_count", "retryable", "cancelled_by_user", "context_exceeded",
  "error_type", "error_code", "started_at", "first_token_at", "completed_at", "duration_ms", "time_to_first_token_ms"];
// 选择 session/trace 范围而非低选择性的 source 索引:WHERE 的 +query_source 不参与 source 索引匹配。
// 可选列投影 NULL;不碰内容列。不 materialize 全库,SQLite 可内联并沿原索引取行。
export function normalizeDiagnosticsDb(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(model_usage)").all().map((c) => c.name));
  const projection = COLUMNS.map((c) => columns.has(c) ? quote(c) : "NULL AS " + quote(c)).join(",");
  return { columns, projection, db: withScope(db, "diagnostic_scope AS (SELECT " + projection + " FROM model_usage)") };
}
function withScope(db, prefix, params = []) {
  return { prepare(sql) {
    if (!/\bFROM model_usage\b/.test(sql)) return db.prepare(sql);
    sql = sql.replace(/\bFROM model_usage\b/g, "FROM diagnostic_scope");
    const query = /^\s*WITH\s/i.test(sql)
      ? "WITH " + prefix + ", " + sql.replace(/^\s*WITH\s/i, "")
      : "WITH " + prefix + " " + sql;
    const stmt = db.prepare(query);
    return Object.fromEntries(["get", "all"].map((m) => [m, (...args) => stmt[m](...params, ...args)]));
  } };
}
export function buildDiagnosticScope(tr, db, sid, caps, normalized) {
  const traceOk = caps.traceAssociation.status === "ok";
  const actorOk = caps.workflowAssociation.status === "ok";
  const trace = traceOk
    ? "root_traces AS MATERIALIZED (SELECT DISTINCT trace_id FROM model_usage WHERE session_id = ? AND +query_source = 'main_turn' AND " + tr.validIdSql("trace_id") + "), " +
      "multi_traces AS MATERIALIZED (SELECT trace_id FROM model_usage WHERE trace_id IN (SELECT trace_id FROM root_traces) AND +query_source = 'main_turn' GROUP BY trace_id HAVING COUNT(DISTINCT session_id) > 1)"
    : "root_traces AS (SELECT NULL trace_id WHERE 0), multi_traces AS (SELECT NULL trace_id WHERE 0)";
  const actors = actorOk
    ? "root_actors AS MATERIALIZED (SELECT DISTINCT a.session_id FROM dwf_actor a JOIN dwf_run r ON a.run_id = r.id WHERE r.parent_session_id = ? AND a.session_id IS NOT NULL), " +
      "other_actors AS MATERIALIZED (SELECT DISTINCT a.session_id FROM dwf_actor a JOIN dwf_run r ON a.run_id = r.id WHERE (r.parent_session_id IS NULL OR r.parent_session_id IS NOT ?) AND a.session_id IN " +
      (traceOk ? "(SELECT session_id FROM root_actors UNION SELECT DISTINCT session_id FROM model_usage WHERE trace_id IN (SELECT trace_id FROM root_traces)))" : "(SELECT session_id FROM root_actors))")
    : "root_actors AS (SELECT NULL session_id WHERE 0), other_actors AS (SELECT NULL session_id WHERE 0)";
  const setup = trace + ", " + actors;
  const params = [...(traceOk ? [sid] : []), ...(actorOk ? [sid, sid] : [])];
  const related = "session_id = ? OR session_id IN (SELECT session_id FROM root_actors)" +
    (traceOk ? " OR trace_id IN (SELECT trace_id FROM root_traces)" : "");
  // TEXT PRIMARY KEY 在 SQLite 中可为 NULL。不能把无法按 ID 回连的相关行静默丢掉。
  const nulls = db.prepare("WITH " + setup + " SELECT COUNT(*) n FROM model_usage WHERE id IS NULL AND (" + related + ")").get(...params, sid).n;
  if (nulls) throw Object.assign(new Error("相关范围存在 NULL model_usage.id,无法证明账本去重"), { reasonCode: "invalid-data" });
  const aux = Object.keys(tr.AUX_CLASS).map((s) => "'" + s.replaceAll("'", "''") + "'").join(",");
  const prefix = setup + ", " + [
    "candidate_ids AS MATERIALIZED (SELECT id FROM model_usage WHERE session_id = ?",
    "UNION SELECT id FROM model_usage WHERE session_id IN (SELECT session_id FROM root_actors)",
    traceOk ? "UNION SELECT id FROM model_usage WHERE trace_id IN (SELECT trace_id FROM root_traces)" : "",
    "), candidate_rows AS MATERIALIZED (SELECT " + normalized.projection + " FROM model_usage WHERE id IN (SELECT id FROM candidate_ids)),",
    "diagnostic_scope AS MATERIALIZED (SELECT *, CASE",
    "WHEN session_id = ? AND +query_source = 'main_turn' THEN 'main'",
    "WHEN session_id IS NOT ? AND session_id IN (SELECT session_id FROM root_actors) AND session_id IN (SELECT session_id FROM other_actors) THEN 'ambiguous'",
    "WHEN query_source = 'workflow_child' AND session_id IN (SELECT session_id FROM root_actors) AND session_id NOT IN (SELECT session_id FROM other_actors) THEN 'workflow'",
    "WHEN session_id IS NOT ? AND session_id IN (SELECT session_id FROM other_actors) THEN 'foreign'",
    "WHEN session_id IS NOT ? AND trace_id IN (SELECT trace_id FROM multi_traces) THEN 'ambiguous'",
    "WHEN session_id IS NOT ? AND +query_source = 'main_turn' THEN 'foreign'",
    "WHEN query_source = 'subagent' THEN 'subagent'",
    "WHEN query_source IN (" + aux + ") THEN 'auxiliary'",
    "ELSE 'unclassified' END bucket FROM candidate_rows)"
  ].join(" ");
  params.push(sid, sid, sid, sid, sid, sid);
  const frag = (sql) => ({ sql, params: [] });
  return { db: withScope(db, prefix, params), main: frag("bucket = 'main'"), workflow: frag("bucket = 'workflow'"),
    subagent: frag("bucket = 'subagent'"), auxiliary: frag("bucket = 'auxiliary'"), unclassified: frag("bucket = 'unclassified'"),
    ambiguous: frag("bucket = 'ambiguous'"), observed: frag("bucket NOT IN ('ambiguous','foreign')"),
    candidates: frag("1"), foreign: frag("bucket = 'foreign'") };
}
