// 确定性合成用量库生成器(仅供 benchmark/测试;绝不打开或修改真实用量库)。
// 分布依据 docs/ZCODE-3.11.2-COMPATIBILITY-AND-REPAIR-PLAN.md 的真实库观察:
// 输入中位 ~49k-231k(对数均匀 1k-400k)、输出中位 ~300(对数均匀 50-4000)、TTFT 8-12s 量级、
// 缓存命中多在 90-99%、main_turn ~92%/subagent ~6%/辅助 ~2%、少量 error/零输出/NULL duration 行。
// mulberry32 固定种子 → 同参数生成完全一致的库,基准可复现。

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MODEL_USAGE_DDL = `CREATE TABLE model_usage (
  turn_id TEXT, session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
  output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER,
  cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
  trace_id TEXT, provider_id TEXT, started_at INTEGER, first_token_at INTEGER,
  completed_at INTEGER, duration_ms INTEGER, time_to_first_token_ms INTEGER)`;

// 与生产 db.sqlite 完全一致的索引(只读探查得;benchmark 仅在自建合成库上创建)
export function createRealIndexes(db) {
  db.exec(`CREATE INDEX bench_query_source ON model_usage(query_source);
    CREATE INDEX bench_trace ON model_usage(trace_id);
    CREATE INDEX bench_session_turn ON model_usage(session_id, turn_id);
    CREATE INDEX bench_started_model ON model_usage(started_at, provider_id, model_id);`);
}

// 旧 benchmark(PERFORMANCE.md 2026-09-07)使用的实验索引,仅作历史对照
export function createLegacyFixtureIndexes(db) {
  db.exec(`CREATE INDEX bench_legacy_session ON model_usage(session_id, status, query_source, completed_at);
    CREATE INDEX bench_legacy_trace ON model_usage(trace_id, status, query_source);`);
}

export function dropBenchIndexes(db) {
  db.exec(`DROP INDEX IF EXISTS bench_query_source; DROP INDEX IF EXISTS bench_trace;
    DROP INDEX IF EXISTS bench_session_turn; DROP INDEX IF EXISTS bench_started_model;
    DROP INDEX IF EXISTS bench_legacy_session; DROP INDEX IF EXISTS bench_legacy_trace;`);
}

// 生成 model_usage + 同量级 message/part 表(真实库 part:model_usage ≈ 4.5:1)。
// 返回 { bigSession, typicalSession, expected: Map<sid,{requests,total}> } —— expected 仅含
// completed 主对话与可归因子代理(与插件 session 口径一致的总量 oracle)。
export function generateUsageDb(db, { rows = 100_000, seed = 42 } = {}) {
  const rnd = mulberry32(seed);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(MODEL_USAGE_DDL);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, kind TEXT, created_at INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, type TEXT, created_at INTEGER)`);

  const insert = db.prepare(`INSERT INTO model_usage (
      turn_id,session_id,status,query_source,model_id,output_tokens,reasoning_tokens,
      input_tokens,cache_read_input_tokens,cache_creation_input_tokens,trace_id,provider_id,
      started_at,first_token_at,completed_at,duration_ms,time_to_first_token_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const AUX_SOURCES = ["session_title", "goal_summary_title", "compact", "target_completion_verification"];
  const BIG = "sBIG";
  const nOther = Math.max(16, Math.floor(rows / 250));
  const T0 = 1_757_000_000_000; // 近似 30 天窗口
  const expected = new Map();
  const bump = (sid, requests, total) => {
    const e = expected.get(sid) ?? { requests: 0, total: 0 };
    e.requests += requests; e.total += total;
    expected.set(sid, e);
  };
  const sessionRowCount = new Map();
  const counters = new Map();

  // trace/turn 按会话内每 5/3 行分桶,且桶首行(第 0 槽)强制 main_turn+completed:
  // 保证"可归因子代理"的 trace 必然出现在同会话的 main_turn 行上,与插件的 trace 归因口径一致。
  db.exec("BEGIN");
  for (let i = 0; i < rows; i++) {
    const isBig = rnd() < 0.02;
    let sess = isBig ? BIG : "s" + Math.floor(rnd() * nOther);
    if (rnd() < 0.002) sess = " "; // 极少量空白会话(应被识别排除)
    sessionRowCount.set(sess, (sessionRowCount.get(sess) ?? 0) + 1);
    const n = counters.get(sess) ?? 0;
    counters.set(sess, n + 1);
    const bucket = Math.floor(n / 5), slot = n % 5;
    const trace = "tr-" + sess + "-" + bucket;
    const turn = "t-" + sess + "-" + Math.floor(n / 3);
    const r = rnd();
    const qs = slot === 0 ? "main_turn"
      : r < 0.90 ? "main_turn" : r < 0.975 ? "subagent" : AUX_SOURCES[Math.floor(rnd() * AUX_SOURCES.length)];
    const status = slot === 0 ? "completed" : rnd() < 0.98 ? "completed" : "error";
    const model = rnd() < 0.8 ? "glm-4.7" : "glm-5.3";
    const input = Math.round(1000 * Math.exp(rnd() * Math.log(400)));
    const cacheFrac = rnd() < 0.85 ? 0.9 + 0.09 * rnd() : 0.3 + 0.4 * rnd();
    const cacheRead = Math.round(input * cacheFrac);
    let out = Math.round(50 * Math.exp(rnd() * Math.log(80)));
    if (rnd() < 0.01) out = 0; // 零输出 completed 行:计入用量、不计速率
    const reasoning = Math.round(out * rnd() * 0.6);
    const ttft = Math.round(2000 + rnd() * 12000);
    const gen = Math.round((out / (15 + 50 * rnd())) * 1000); // 15-65 tok/s 生成段
    const durRaw = rnd() < 0.02 ? null : ttft + gen;
    const durFinal = Math.max(durRaw ?? ttft + gen, 600); // 控制短行占比(仍留少量 <500ms 行)
    const durStored = rnd() < 0.02 ? null : durFinal;
    const ttftStored = rnd() < 0.03 ? null : ttft;
    const firstAt = rnd() < 0.04 ? null : T0 + i * 2500 + ttft;
    const jitter = Math.round(rnd() * 80_000);
    const started = T0 + i * 2500 - jitter;
    const durForCompleted = durStored ?? durFinal;
    const completed = started + durForCompleted;
    const completedStored = rnd() < 0.005 ? null : completed; // 少量无法回退时长的行
    let traceOut = trace, turnOut = turn;
    if (qs === "subagent" && rnd() < 0.2) traceOut = "trOther" + i; // 不可归因子代理
    if (qs !== "main_turn" && qs !== "subagent") turnOut = null;
    if (rnd() < 0.005) turnOut = null;

    insert.run(
      turnOut, sess, status, qs, model, out, reasoning, input, cacheRead, 0, traceOut,
      rnd() < 0.95 ? "zai" : "other", started, firstAt, completedStored, durStored, ttftStored,
    );
    if (status !== "completed") continue;
    if (qs === "main_turn") {
      bump(sess, 1, input + out);
    } else if (qs === "subagent" && traceOut === trace && slot !== 0) {
      bump(sess, 1, input + out); // 桶首行保证同会话存在携带该 trace 的 completed main_turn 行
    }
  }
  db.exec("COMMIT");

  // message 1:1、part 4:1(集合式插入,构造真实库的页缓存压力;插件不读取这两表)。
  // 注意 SQLite 中 || 优先级高于 *,拼接前必须给算术表达式加括号。
  db.exec(`INSERT INTO message SELECT 'm' || rowid, session_id, 'assistant', completed_at FROM model_usage;
    INSERT INTO part SELECT 'p' || (rowid * 4), 'm' || rowid, 'text', completed_at FROM model_usage;
    INSERT INTO part SELECT 'p' || (rowid * 4 + 1), 'm' || rowid, 'reasoning', completed_at FROM model_usage;
    INSERT INTO part SELECT 'p' || (rowid * 4 + 2), 'm' || rowid, 'tool', completed_at FROM model_usage;
    INSERT INTO part SELECT 'p' || (rowid * 4 + 3), 'm' || rowid, 'text', completed_at FROM model_usage;`);

  // typical 会话:行数最接近中位数且 ≥ 50 行的普通会话
  const counts = [...sessionRowCount.entries()].filter(([s, c]) => s !== BIG && c >= 50).map(([, c]) => c).sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 50;
  let typical = null, bestDiff = Infinity;
  for (const [s, c] of sessionRowCount) {
    if (s === BIG || c < 50) continue;
    const d = Math.abs(c - median);
    if (d < bestDiff) { bestDiff = d; typical = s; }
  }
  if (!typical) typical = [...sessionRowCount.keys()].find((s) => s !== BIG) ?? BIG;
  return { bigSession: BIG, typicalSession: typical, expected };
}
