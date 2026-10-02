// 0.6.0 诊断测试夹具:按 docs/DATA-CONTRACT-0.6.0.md 的真实宿主列构造合成库。
// 仅在临时目录创建;期望值(oracle)由夹具定义显式给出,不复制生产聚合函数(spec §12)。
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const T0 = 1_700_000_000_000;

export const MODEL_USAGE_DDL = `CREATE TABLE model_usage (
  id TEXT PRIMARY KEY, logical_request_id TEXT, attempt_index INTEGER, session_id TEXT, turn_id TEXT, trace_id TEXT,
  span_id TEXT, assistant_message_id TEXT, parent_user_message_id TEXT, query_source TEXT, provider_id TEXT, model_id TEXT,
  variant TEXT, agent TEXT, mode TEXT, task_type TEXT, status TEXT, started_at INTEGER, first_token_at INTEGER,
  completed_at INTEGER, duration_ms INTEGER, time_to_first_token_ms INTEGER, finish_reason TEXT, tool_call_count INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER,
  cache_read_input_tokens INTEGER, provider_total_tokens INTEGER, computed_total_tokens INTEGER, retry_count INTEGER,
  retryable INTEGER, cancelled_by_user INTEGER, context_exceeded INTEGER, error_type TEXT, error_code TEXT,
  error_message TEXT, raw_usage_json TEXT, provider_metadata_json TEXT)`;

const INDEX_DDL = `CREATE INDEX model_usage_session_turn_idx ON model_usage(session_id, turn_id);
  CREATE INDEX model_usage_trace_idx ON model_usage(trace_id);`;

const TURN_USAGE_DDL = `CREATE TABLE turn_usage (
    session_id TEXT NOT NULL, turn_id TEXT NOT NULL, trace_id TEXT, user_message_id TEXT, status TEXT,
    started_at INTEGER, first_model_start_at INTEGER, first_token_at INTEGER, completed_at INTEGER,
    duration_ms INTEGER, time_to_first_token_ms INTEGER, model_request_count INTEGER, model_retry_count INTEGER,
    tool_call_count INTEGER, tool_error_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
    computed_total_tokens INTEGER, retryable INTEGER, cancelled_by_user INTEGER, context_exceeded INTEGER,
    error_type TEXT, error_code TEXT, PRIMARY KEY (session_id, turn_id));`;

const DWF_DDL = `CREATE TABLE dwf_run (id TEXT PRIMARY KEY, parent_session_id TEXT, cwd TEXT, name TEXT, script_text TEXT,
    script_hash TEXT, args_json TEXT, tool_call_id TEXT, resumed_from TEXT, caps_max_concurrency INTEGER,
    spent_tokens INTEGER, status TEXT, result_json TEXT, failure_json TEXT, time_created INTEGER, time_updated INTEGER);
  CREATE TABLE dwf_actor (id INTEGER PRIMARY KEY, run_id TEXT, site_id TEXT, ordinal INTEGER, name TEXT,
    persona_json TEXT, resolved_model TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER);
  CREATE TABLE dwf_node (id INTEGER PRIMARY KEY, run_id TEXT, site_id TEXT, ordinal INTEGER, kind TEXT,
    actor_site_id TEXT, actor_ordinal INTEGER, actor_seq INTEGER, input_hash TEXT, input_json TEXT, status TEXT,
    result_json TEXT, error_json TEXT, stats_json TEXT, message_boundary INTEGER, artifact_id TEXT,
    time_created INTEGER, time_updated INTEGER);
  CREATE TABLE dwf_event (id INTEGER PRIMARY KEY, run_id TEXT, sequence INTEGER, type TEXT, payload_json TEXT, time_created INTEGER);
  CREATE TABLE workflow_run (id TEXT PRIMARY KEY, parent_session_id TEXT, status TEXT, spent_tokens INTEGER);`;

let counter = 0;
export function resetIdCounter() { counter = 0; }

// 行构造:显式给出断言所需字段,其余与宿主语义一致的默认(可覆盖)
export function row(overrides = {}) {
  counter += 1;
  const id = overrides.id ?? `u${String(counter).padStart(4, "0")}`;
  const dur = overrides.duration_ms ?? 800;
  const started = overrides.started_at ?? (T0 + counter * 10);
  const ttft = overrides.time_to_first_token_ms;
  const firstToken = overrides.first_token_at !== undefined
    ? overrides.first_token_at
    : (typeof ttft === "number" ? started + ttft : null);
  return {
    id,
    logical_request_id: overrides.logical_request_id ?? `l-${id}`,
    attempt_index: overrides.attempt_index !== undefined ? overrides.attempt_index : 0,
    session_id: overrides.session_id ?? "sess-main",
    turn_id: overrides.turn_id ?? null,
    trace_id: overrides.trace_id ?? null,
    query_source: overrides.query_source ?? "main_turn",
    provider_id: overrides.provider_id ?? "provA",
    model_id: overrides.model_id ?? "GLM-5.3",
    status: overrides.status ?? "completed",
    started_at: started,
    first_token_at: firstToken,
    completed_at: overrides.completed_at ?? started + dur,
    duration_ms: dur,
    time_to_first_token_ms: ttft !== undefined ? ttft : null,
    input_tokens: overrides.input_tokens ?? 0,
    output_tokens: overrides.output_tokens ?? 0,
    reasoning_tokens: overrides.reasoning_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: overrides.cache_read_input_tokens ?? 0,
    retry_count: overrides.retry_count ?? 0,
    retryable: overrides.retryable ?? 0,
    cancelled_by_user: overrides.cancelled_by_user ?? 0,
    context_exceeded: 0,
    error_type: overrides.error_type ?? null,
    error_code: null,
  };
}

const MU_COLS = ["id", "logical_request_id", "attempt_index", "session_id", "turn_id", "trace_id", "query_source",
  "provider_id", "model_id", "status", "started_at", "first_token_at", "completed_at", "duration_ms",
  "time_to_first_token_ms", "input_tokens", "output_tokens", "reasoning_tokens", "cache_creation_input_tokens",
  "cache_read_input_tokens", "retry_count", "retryable", "cancelled_by_user", "context_exceeded", "error_type", "error_code"];

function insertRows(db, rows) {
  const stmt = db.prepare(`INSERT INTO model_usage (${MU_COLS.join(",")}) VALUES (${MU_COLS.map(() => "?").join(",")})`);
  for (const r of rows) stmt.run(...MU_COLS.map((c) => r[c] ?? null));
}

export function insertRowsHelper(db, rows) { insertRows(db, rows); }

function turnUsageRow(overrides = {}) {
  return {
    session_id: overrides.session_id, turn_id: overrides.turn_id, trace_id: overrides.trace_id ?? null,
    user_message_id: overrides.user_message_id ?? null, status: overrides.status ?? "completed",
    started_at: overrides.started_at ?? T0, first_model_start_at: null, first_token_at: null,
    completed_at: overrides.completed_at ?? T0 + 5000, duration_ms: overrides.duration_ms ?? 1000,
    time_to_first_token_ms: overrides.time_to_first_token_ms ?? null,
    model_request_count: overrides.model_request_count ?? 1, model_retry_count: overrides.model_retry_count ?? 0,
    tool_call_count: 0, tool_error_count: 0,
    input_tokens: overrides.input_tokens ?? 0, output_tokens: overrides.output_tokens ?? 0,
    reasoning_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: overrides.cache_read_input_tokens ?? 0,
    computed_total_tokens: (overrides.input_tokens ?? 0) + (overrides.output_tokens ?? 0),
    retryable: 0, cancelled_by_user: 0, context_exceeded: 0, error_type: null, error_code: null,
  };
}

function insertTurnUsage(db, rows) {
  const cols = Object.keys(rows[0]);
  const stmt = db.prepare(`INSERT INTO turn_usage (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  for (const r of rows) stmt.run(...cols.map((c) => r[c] ?? null));
}

export function createDb(file, { withDwf = true, withTurnUsage = true } = {}) {
  const db = new DatabaseSync(file);
  db.exec(MODEL_USAGE_DDL);
  db.exec(INDEX_DDL);
  if (withTurnUsage) db.exec(TURN_USAGE_DDL);
  if (withDwf) db.exec(DWF_DDL);
  return db;
}

// sMain 主夹具行集(期望值见 buildDiagnosticsFixture().expected;改行必改 oracle)
export function mainSessionRows() {
  const rows = [];
  // R01:同会话 completed 30/10 + error 20/5(诊断已记录 65 = 40+25;兼容 completed 主用量 40)
  rows.push(row({ id: "m1", turn_id: "t-r01", trace_id: "tr-1b", input_tokens: 30, output_tokens: 10, duration_ms: 800, time_to_first_token_ms: 600, completed_at: T0 + 100 }));
  rows.push(row({ id: "m2", turn_id: "t-r01", trace_id: "tr-1b", status: "error", input_tokens: 20, output_tokens: 5, duration_ms: 700, time_to_first_token_ms: 200, error_type: "rate_limited", completed_at: T0 + 110 }));
  // T01/T02:timing 样本(turn t-time,trace tr-1)
  rows.push(row({ id: "m3", turn_id: "t-time", trace_id: "tr-1", input_tokens: 100, output_tokens: 200, duration_ms: 1000, time_to_first_token_ms: 500, provider_id: "provA", completed_at: T0 + 200 }));
  rows.push(row({ id: "m4", turn_id: "t-time", trace_id: "tr-1", input_tokens: 50, output_tokens: 0, duration_ms: 800, time_to_first_token_ms: 300, provider_id: "provA", completed_at: T0 + 205 })); // 零输出:TTFT 有效、Decode 不计
  rows.push(row({ id: "m5", turn_id: "t-time", trace_id: "tr-1", input_tokens: 10, output_tokens: 30, duration_ms: 900, time_to_first_token_ms: -5, provider_id: "provB", completed_at: T0 + 210 })); // 显式负值 → invalid,不回退
  rows.push(row({ id: "m6", turn_id: "t-time", trace_id: "tr-1", input_tokens: 10, output_tokens: 30, duration_ms: 1000, time_to_first_token_ms: 2000, completed_at: T0 + 215 })); // ttft>dur → invalid
  rows.push(row({ id: "m7", turn_id: "t-time", trace_id: "tr-1", input_tokens: 10, output_tokens: 30, duration_ms: 1000, time_to_first_token_ms: "abc", completed_at: T0 + 220 })); // 文本 → invalid
  rows.push(row({ id: "m8", turn_id: "t-time", trace_id: "tr-1", input_tokens: 45, output_tokens: 50, duration_ms: 900, time_to_first_token_ms: null, started_at: T0 + 2250, first_token_at: T0 + 2650, provider_id: "provA", completed_at: T0 + 3150 })); // 派生 TTFT=400
  rows.push(row({ id: "m9", turn_id: "t-time", trace_id: "tr-1", input_tokens: 35, output_tokens: 40, duration_ms: 800, time_to_first_token_ms: 700, provider_id: "provA", completed_at: T0 + 3200 })); // 解码窗口 100 → 只进 TTFT
  rows.push(row({ id: "m10", turn_id: "t-time", trace_id: "tr-1", input_tokens: 10, output_tokens: 10, duration_ms: 800, time_to_first_token_ms: null, retry_count: 5, completed_at: T0 + 3250 })); // R03 reported 摘要
  rows.push(row({ id: "m11", turn_id: "t-time", trace_id: "tr-1", input_tokens: 9, output_tokens: 4, duration_ms: 800, logical_request_id: "l-r02", attempt_index: 1, completed_at: T0 + 3300 })); // R02 成功尝试
  rows.push(row({ id: "m12", turn_id: "t-time", trace_id: "tr-1", status: "error", input_tokens: 7, output_tokens: 3, duration_ms: 700, logical_request_id: "l-r02", attempt_index: 0, completed_at: T0 + 3350 })); // R02 失败尝试
  rows.push(row({ id: "m13", turn_id: "t-time", trace_id: "tr-1", input_tokens: 4, output_tokens: 2, duration_ms: 800, logical_request_id: "l-dup", attempt_index: 0, completed_at: T0 + 3400 })); // R03 重复 ai
  rows.push(row({ id: "m14", turn_id: "t-time", trace_id: "tr-1", input_tokens: 6, output_tokens: 2, duration_ms: 800, logical_request_id: "l-dup", attempt_index: 0, completed_at: T0 + 3450 }));
  rows.push(row({ id: "m15", turn_id: "t-time", trace_id: "tr-1", input_tokens: 8, output_tokens: 2, duration_ms: 800, logical_request_id: "l-noai", attempt_index: null, completed_at: T0 + 3500 })); // R03 缺失 ai
  // 对账:最新轮 matched(m16)
  rows.push(row({ id: "m16", turn_id: "t-rec-match", trace_id: "tr-2", input_tokens: 111, output_tokens: 22, duration_ms: 5000, time_to_first_token_ms: 1000, cache_read_input_tokens: 90, completed_at: T0 + 9000 }));
  rows.push(row({ id: "m17", turn_id: "t-rec-diff", trace_id: "tr-3", input_tokens: 10, output_tokens: 20, duration_ms: 1000, time_to_first_token_ms: 300, provider_id: "provB", completed_at: T0 + 8000 }));
  // A03:多 root trace(tr-amb 同时出现在 sMain 与 sess-other 的 main_turn)
  rows.push(row({ id: "m18", turn_id: "t-amb", trace_id: "tr-amb", input_tokens: 1, output_tokens: 1, duration_ms: 500, time_to_first_token_ms: 100, provider_id: "provB", completed_at: T0 + 3400 })); // 对 sOther 而言是歧义行
  // auxiliary(已知内部来源)
  rows.push(row({ id: "a1", query_source: "session_title", input_tokens: 11, output_tokens: 7, duration_ms: 600, completed_at: T0 + 3600 }));
  rows.push(row({ id: "a2", query_source: "compact", input_tokens: 5, output_tokens: 2, duration_ms: 600, completed_at: T0 + 3650 }));
  // unclassified:未知来源 + 会话内未归属 workflow_child(A04)
  rows.push(row({ id: "x1", query_source: "mystery_source", input_tokens: 3, output_tokens: 1, duration_ms: 500, completed_at: T0 + 3700 }));
  rows.push(row({ id: "w0", query_source: "workflow_child", input_tokens: 6, output_tokens: 4, duration_ms: 500, completed_at: T0 + 3750 }));
  // subagent(trace 归因;tr-1 单 root)
  rows.push(row({ id: "sub1", session_id: "sess-sub-1", query_source: "subagent", trace_id: "tr-1", input_tokens: 40, output_tokens: 60, duration_ms: 900, completed_at: T0 + 3800 }));
  // A03 歧义:tr-amb 的 subagent 行(属于哪个 root 不可判)
  rows.push(row({ id: "amb1", session_id: "sess-sub-amb", query_source: "subagent", trace_id: "tr-amb", input_tokens: 8, output_tokens: 2, duration_ms: 500, completed_at: T0 + 3850 }));
  // workflow:actor 链归属(r1/r2 → sMain),w1 与主对话共享 trace tr-1(双路径不重复计)
  rows.push(row({ id: "w1", session_id: "sess-dwf-a1", query_source: "workflow_child", trace_id: "tr-1", input_tokens: 70, output_tokens: 30, duration_ms: 900, completed_at: T0 + 3900 }));
  rows.push(row({ id: "w2", session_id: "sess-dwf-a1", query_source: "workflow_child", status: "error", input_tokens: 5, output_tokens: 1, duration_ms: 400, completed_at: T0 + 3950 }));
  rows.push(row({ id: "w3", session_id: "sess-dwf-a2", query_source: "workflow_child", input_tokens: 10, output_tokens: 6, duration_ms: 500, completed_at: T0 + 4000 }));
  // r9 属于另一个 root(sess-other);w9 与 sMain 主对话共享 trace,但对 sMain 不可归属
  rows.push(row({ id: "w9", session_id: "sess-dwf-a9", query_source: "workflow_child", trace_id: "tr-1", input_tokens: 99, output_tokens: 99, duration_ms: 500, completed_at: T0 + 4100 }));
  // 双 root 同时 claim 的 actor 会话 → 歧义
  rows.push(row({ id: "wamb", session_id: "sess-dwf-amb", query_source: "workflow_child", trace_id: "tr-1", input_tokens: 12, output_tokens: 8, duration_ms: 500, completed_at: T0 + 4200 }));
  // 另一个 root 的主对话(A03/A04 对照)
  rows.push(row({ id: "o1", session_id: "sess-other", turn_id: "t-o1", trace_id: "tr-amb", input_tokens: 5, output_tokens: 5, duration_ms: 600, time_to_first_token_ms: 150, completed_at: T0 + 3300 }));
  return rows;
}

export function dwfRows() {
  return {
    runs: [
      { id: "dwfrun-1", parent_session_id: "sess-main", status: "completed", spent_tokens: 100, resumed_from: null, time_created: 1, time_updated: 2 },
      { id: "dwfrun-2", parent_session_id: "sess-main", status: "completed", spent_tokens: 50, resumed_from: "dwfrun-1", time_created: 3, time_updated: 4 },
      { id: "dwfrun-0", parent_session_id: "sess-main", status: "completed", spent_tokens: 0, resumed_from: null, time_created: 5, time_updated: 6 },
      { id: "dwfrun-9", parent_session_id: "sess-other", status: "completed", spent_tokens: 9, resumed_from: null, time_created: 7, time_updated: 8 },
      { id: "dwfrun-amb-a", parent_session_id: "sess-main", status: "completed", spent_tokens: 1, resumed_from: null, time_created: 9, time_updated: 10 },
      { id: "dwfrun-amb-b", parent_session_id: "sess-other", status: "completed", spent_tokens: 1, resumed_from: null, time_created: 11, time_updated: 12 },
    ],
    actors: [
      { id: 1, run_id: "dwfrun-1", session_id: "sess-dwf-a1" },
      { id: 2, run_id: "dwfrun-2", session_id: "sess-dwf-a2" },
      { id: 3, run_id: "dwfrun-9", session_id: "sess-dwf-a9" },
      { id: 4, run_id: "dwfrun-amb-a", session_id: "sess-dwf-amb" },
      { id: 5, run_id: "dwfrun-amb-b", session_id: "sess-dwf-amb" }, // 双 root claim 同一 actor 会话
    ],
    events: [
      { id: 1, run_id: "dwfrun-1", sequence: 1, type: "node-queued", payload_json: null, time_created: 1 },
      { id: 2, run_id: "dwfrun-1", sequence: 2, type: "node-executing", payload_json: null, time_created: 2 },
      { id: 3, run_id: "dwfrun-1", sequence: 3, type: "usage-updated", payload_json: null, time_created: 3 },
      { id: 4, run_id: "dwfrun-1", sequence: 4, type: "node-settled", payload_json: null, time_created: 4 },
    ],
  };
}

// U01 专用小库:matched/different/missing/backfill/invalid
export function turnUsageScenario(kind) {
  resetIdCounter();
  const rows = [
    row({ id: "u1", session_id: "sess-u", turn_id: "tU1", trace_id: "tr-u", input_tokens: 50, output_tokens: 25, cache_read_input_tokens: 40, duration_ms: 1000, time_to_first_token_ms: 200, completed_at: T0 + 100 }),
  ];
  const tu = [];
  if (kind === "matched" || kind === "different" || kind === "invalid") {
    const output = kind === "different" ? 30 : 25;
    const input = kind === "invalid" ? "oops" : 50;
    tu.push(turnUsageRow({ session_id: "sess-u", turn_id: "tU1", trace_id: "tr-u", input_tokens: input, output_tokens: output, model_request_count: 1, cache_read_input_tokens: 40 }));
  } // kind === "missing"/"backfill":先不建 turn_usage 行
  return { rows, tu, turnUsageRow };
}

// B02 高基数:60 个 model + 12 种 error_type(在独立会话,不干扰主 oracle)
export function highCardinalityRows() {
  resetIdCounter();
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push(row({ id: `hc${i}`, session_id: "sess-hc", turn_id: "t-hc", trace_id: `tr-hc-${i % 7}`,
      model_id: `model-${i}`, provider_id: `p${i % 3}`, input_tokens: 1, output_tokens: 1,
      duration_ms: 500, time_to_first_token_ms: 100, completed_at: T0 + 100 + i }));
  }
  for (let i = 0; i < 12; i++) {
    rows.push(row({ id: `et${i}`, session_id: "sess-hc", turn_id: "t-hc", input_tokens: 1, output_tokens: 1,
      duration_ms: 500, time_to_first_token_ms: null, error_type: `et-${i}`, completed_at: T0 + 200 + i }));
  }
  return rows;
}

function writeFixture(file, { rows, tuRows = [], withDwf, withTurnUsage, dwf }) {
  const db = createDb(file, { withDwf, withTurnUsage });
  insertRows(db, rows);
  if (withTurnUsage && tuRows.length) insertTurnUsage(db, tuRows);
  if (withDwf) {
    const ir = db.prepare("INSERT INTO dwf_run (id,parent_session_id,status,spent_tokens,resumed_from,time_created,time_updated) VALUES (?,?,?,?,?,?,?)");
    for (const x of dwf.runs) ir.run(x.id, x.parent_session_id, x.status, x.spent_tokens, x.resumed_from, x.time_created, x.time_updated);
    const ia = db.prepare("INSERT INTO dwf_actor (id,run_id,session_id) VALUES (?,?,?)");
    for (const x of dwf.actors) ia.run(x.id, x.run_id, x.session_id);
    const ie = db.prepare("INSERT INTO dwf_event (id,run_id,sequence,type,payload_json,time_created) VALUES (?,?,?,?,?,?)");
    for (const x of dwf.events) ie.run(x.id, x.run_id, x.sequence, x.type, x.payload_json, x.time_created);
  }
  db.close();
  return file;
}

// 完整夹具:主库(全表)+ 无 dwf 变体 + 无 turn_usage 变体 + 高基数库;期望值 oracle
export function buildDiagnosticsFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  resetIdCounter();
  const rows = mainSessionRows();
  const dwf = dwfRows();
  const tuMain = [
    turnUsageRow({ session_id: "sess-main", turn_id: "t-rec-match", trace_id: "tr-2", input_tokens: 111, output_tokens: 22, model_request_count: 1, cache_read_input_tokens: 90, duration_ms: 5000, time_to_first_token_ms: 1000 }),
  ];

  const main = writeFixture(path.join(dir, "main.sqlite"), { rows, tuRows: tuMain, withDwf: true, withTurnUsage: true, dwf });
  const noDwf = writeFixture(path.join(dir, "no-dwf.sqlite"), { rows, tuRows: tuMain, withDwf: false, withTurnUsage: true, dwf });
  const noTu = writeFixture(path.join(dir, "no-tu.sqlite"), { rows, tuRows: [], withDwf: true, withTurnUsage: false, dwf });
  const hc = writeFixture(path.join(dir, "hc.sqlite"), { rows: highCardinalityRows(), withDwf: false, withTurnUsage: true, dwf: { runs: [], actors: [], events: [] } });

  return {
    dbPath: main, dbPathNoDwf: noDwf, dbPathNoTu: noTu, dbPathHc: hc, dwf,
    root: "sess-main", other: "sess-other",
    expected: {
      observed: { requests: 26, input: 626, output: 572, total: 1198 },
      buckets: {
        main: { requests: 18, input: 476, output: 461 },
        workflow: { requests: 3, input: 85, output: 37 },
        subagent: { requests: 1, input: 40, output: 60 },
        auxiliary: { requests: 2, input: 16, output: 9 },
        unclassified: { requests: 2, input: 9, output: 5 },
      },
      ambiguous: { requests: 3, input: 25, output: 15 }, // amb1 + wamb + o1(多 root trace 命中,不纳入任何 root)
      statusCounts: { completed: 23, error: 3, cancelled: 0 },
      failedRecordedUsage: { requests: 3, input: 32, output: 9, total: 41 },
      retry: { rowsWithRetryCount: 1, maxRetryCountObserved: 5, attemptRows: 26, groupedAttemptRows: 26,
        ungroupedAttemptRows: 0, logicalRequestsObserved: 24, retriedLogicalRequestsObserved: 1,
        additionalAttemptsObserved: 1, flaggedGroups: 2 },
      timing: { candidates: 16, direct: 7, derived: 1, invalid: 3, missing: 5, validSamples: 8,
        mean: 487.5, median: 400, p90: 1000,
        decode: { samples: 6, numerator: 303, denominator: 6300 },
        ttftGroups: {
          "provA|GLM-5.3": { n: 6, mean: 583.3, median: 500, p90: 1000 },
          "provB|GLM-5.3": { n: 2, mean: 200, median: 100, p90: 300 },
        },
        decodeGroups: {
          "provA|GLM-5.3": { n: 4, mean: 138.9 },
          "provB|GLM-5.3": { n: 2, mean: 15.5 },
        },
      },
      workflowRuns: { "dwfrun-1": { requests: 2, input: 75, output: 31 }, "dwfrun-2": { requests: 1, input: 10, output: 6 },
        "dwfrun-0": { requests: 0 }, "dwfrun-amb-a": { requests: 0 } },
      unattributedTraceLinkedRows: 1, // w9(另一 root 的 run,trace 弱命中但不可归属)
      otherRoot: { observed: { requests: 2 }, workflow: { requests: 1, input: 99, output: 99 }, ambiguous: { requests: 3 } }, // 歧义:amb1+wamb+m18
      compat: { // 0.5.5 兼容口径(completed main_turn,不含子代理):m2/m12 为 error 被排除
        requests: 16, input: 449, output: 453, total: 902,
      },
      noDwf: {
        workflowStatus: "unavailable", workflowReason: "schema-missing",
        unclassified: { requests: 5, input: 190, output: 142 }, // x1+w0+w1+wamb+w9(w2/w3 无 trace 无关联;无 dwf 时其余按 trace 弱关联入 unclassified)
        ambiguous: { requests: 2 }, // amb1 + o1(trace 歧义仍可判;wamb 双 claim 不可判)
      },
      recon: { result: "matched", turnId: "t-rec-match" },
      hc: { ttftGroups: 50, ttftOther: 10, errorTypes: 10 },
    },
  };
}
