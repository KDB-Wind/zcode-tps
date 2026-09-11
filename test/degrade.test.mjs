// 最小回归测试:验证 usage 库结构异常时的降级行为与查询口径。
// 运行:node test/degrade.test.mjs(需要 Node >= 22.13,零第三方依赖)

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL, fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-tps-test-"));
const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "plugins", "zcode-tps", "scripts", "token-rate.mjs"
);
const HOOK = path.join(path.dirname(SCRIPT), "..", "hooks", "prompt-submit.mjs");
const SID = "sess_test";
process.env.ZCODE_TPS_CONFIG = path.join(tmp, "config.json");
process.env.ZCODE_TPS_LAST_SESSION = path.join(tmp, "last-session.json");
process.env.ZCODE_TPS_HEALTH = path.join(tmp, "health.json");

function createModelUsage(db) {
  db.exec(`CREATE TABLE model_usage (
    turn_id TEXT, session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
    output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER,
    cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
    trace_id TEXT, started_at INTEGER, first_token_at INTEGER,
    completed_at INTEGER, duration_ms INTEGER, time_to_first_token_ms INTEGER)`);
}

function insertRequest(db, {
  t0, out = 100, reasoning = 0, ttft = 200, gen = 1000, durMs,
  startedAt, firstAt, completedAt, input = 1000, cacheRead = 900,
  turnId = "turn_default", qs = "main_turn", sess = SID, status = "completed", trace = null,
}) {
  const start = startedAt !== undefined ? startedAt : t0;
  const first = firstAt !== undefined
    ? firstAt
    : Number.isFinite(start) && Number.isFinite(ttft) ? start + ttft : null;
  const wallDur = Number.isFinite(ttft) && Number.isFinite(gen)
    ? ttft + gen
    : Number.isFinite(durMs) ? durMs : null;
  const completed = completedAt !== undefined
    ? completedAt
    : Number.isFinite(start) && Number.isFinite(wallDur) ? start + wallDur : null;
  const storedDur = durMs !== undefined ? durMs : wallDur;
  db.prepare(
    `INSERT INTO model_usage (
       turn_id,session_id,status,query_source,model_id,
       output_tokens,reasoning_tokens,input_tokens,cache_read_input_tokens,trace_id,
       started_at,first_token_at,completed_at,duration_ms,time_to_first_token_ms
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(turnId, sess, status, qs, "test-model", out, reasoning, input, cacheRead, trace,
        start, first, completed, storedDur, Number.isFinite(ttft) ? ttft : null);
}

async function loadWith(dbPath) {
  process.env.ZCODE_USAGE_DB = dbPath;
  // query string 使 ESM 缓存失效,每个用例拿到读取新 env 的全新模块实例
  return import(pathToFileURL(SCRIPT).href + "?case=" + Math.random());
}

// ---- 用例 1:库里只有 model_usage(无 turn_usage 表)→ 轮次/会话/缓存全部由 model_usage 聚合 ----
{
  const dbPath = path.join(tmp, "no-turn-usage.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  const t0 = 1_000_000;
  insertRequest(db, { t0: t0 + 200, out: 120, ttft: 200, gen: 1000 });
  insertRequest(db, { t0: t0 + 100, out: 50, ttft: null, gen: null,
                      startedAt: null, firstAt: null, completedAt: t0 + 5000, durMs: null }); // 最新但无总时长
  insertRequest(db, { t0, out: 60, ttft: 100, gen: 2000 });
  db.close();

  const { query, formatLine } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.turn.requests, 3, "三条请求拥有同一明确 turn_id,聚合为一轮");
  assert.equal(r.turn.total, 3230, "total = Σ(input+output) = 3000+230");
  assert.equal(r.usage.turns, 1);
  assert.equal(r.usage.total, 3230);
  assert.equal(r.cacheHit, 90, "缓存命中率 = 2700/3000");
  assert.equal(r.latest.tokPerSec, 28.6, "latest 应取最新一条有效记录(60tok/2.1s)");
  assert.equal(r.history.length, 3, "history 应包含全部请求");
  assert.ok(formatLine(r).includes("⚡"), "降级时速率行仍可格式化");
}

// ---- 用例 2:按 turn_id 聚合 → 本轮/会话累计/缓存命中率正常计算,且区分加权与算术平均 ----
{
  const dbPath = path.join(tmp, "with-turn-usage.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 900, durMs: 1000, input: 800, cacheRead: 700, turnId: "turn_test" });
  insertRequest(db, { t0: 3_000_000, out: 100, ttft: 100, gen: 8900, durMs: 9000, input: 800, cacheRead: 700, turnId: "turn_test" });
  db.close();

  const { query, formatLine } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.turn.requests, 2);
  assert.equal(r.turn.input, 1600);
  assert.equal(r.turn.total, 1800, "total = Σ(input+output)");
  assert.equal(r.turn.cacheHit, 87.5);
  // 100tok/1s + 100tok/9s → 加权 = 200/10s = 20;算术平均会是 (11.1+11.1)/2? 不,两条速率不同,
  // 算术平均 = (100+11.1)/2 ≈ 55.6 —— 用 20 断言可区分两种算法
  assert.equal(r.turn.avgTps, 20, "轮级速率应为加权口径 200tok÷10s=20,而非算术平均≈55.6");
  assert.equal(r.usage.turns, 1);
  assert.equal(r.usage.total, 1800);
  assert.equal(r.cacheHit, 87.5);
  const line = formatLine(r, "all");
  assert.ok(line.includes("ctx 800"), "首字后应附上下文规模");
  assert.ok(line.includes("读 1.6k"), "上轮应使用'读'口径标注输入(避免误读为消耗)");
  assert.ok(line.includes("(出 200)"), "上轮应标注生成量");
  assert.equal(r.session.avgTps, 20, "会话级速率应为加权口径");
  assert.ok(Math.abs(r.latest.tokPerSec - 11.1) < 0.1, "最近应为最新请求的瞬时速率 100/9s");
}

// ---- 用例 3:turn_usage 表存在但列结构变更 → 完全不影响(v0.4.1 起不再读取该表) ----
{
  const dbPath = path.join(tmp, "bad-turn-usage.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 1000 });
  db.exec(`CREATE TABLE turn_usage (foo TEXT)`); // 错误结构
  db.close();

  const { query, formatLine } = await loadWith(dbPath);
  const r = query(SID);
  assert.ok(r.turn, "turn 应改由 model_usage 聚合,不受 turn_usage 结构影响");
  assert.ok(r.usage, "usage 应改由 model_usage 聚合");
  assert.ok(r.latest.tokPerSec > 0, "结构变更时 tok/s 仍应可用");
  assert.ok(formatLine(r).includes("⚡"));
}

// ---- 用例 4:history 与统计窗口分离(history 应多于窗口 N=5) ----
{
  const dbPath = path.join(tmp, "many-rows.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  for (let i = 0; i < 7; i++) {
    insertRequest(db, { t0: 1_000_000 + i * 10_000, out: 100 + i, ttft: 100, gen: 900, durMs: 1000 });
  }
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.history.length, 7, "history 应返回窗口外全部记录");
  assert.ok(r.history[0].completedAt > r.history[r.history.length - 1].completedAt, "history[0] 应为最新(按时间倒序)");
  assert.ok(Math.abs(r.session.avgTps - 103) < 0.01, "会话级速率应为加权口径 (100+…+106)/7s = 103");
  assert.equal(r.latest.outputTokens, 106, "latest 应是最新一条");
}

// ---- 用例 5:模型请求总时长恰为上限 → JS 与 SQL 用同一半开区间,一致排除 ----
{
  const dbPath = path.join(tmp, "max-boundary.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 3600, ttft: 100, gen: 3_599_900, durMs: 3_600_000 });
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.latest.tokPerSec, null, "请求级:dur == MAX_DURATION_MS 应判无效(JS 半开区间)");
  assert.equal(r.session.avgTps, null, "会话聚合:边界行不得计入(SQL 半开区间,与请求级一致)");
  assert.equal(r.session.samples, 0);
}

// ---- 用例 6:会话无 main_turn 请求 → 轮级聚合应继承回退策略 ----
{
  const dbPath = path.join(tmp, "fallback.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 900, durMs: 1000, turnId: "turn_x", qs: "session_title" });
  db.exec(`CREATE TABLE turn_usage (turn_id TEXT, session_id TEXT, status TEXT, completed_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
    computed_total_tokens INTEGER, duration_ms INTEGER, model_request_count INTEGER)`);
  db.prepare(`INSERT INTO turn_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("turn_x", SID, "completed", 2_000_000, 100, 100, 0, 0, 0, 200, 1000, 1);
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.latest.tokPerSec, 100, "回退后应统计非 main_turn 请求");
  assert.equal(r.turn.avgTps, 100, "轮级聚合应继承回退策略(旧实现固定 main_turn 会得到 undefined)");
  assert.equal(r.session.avgTps, 100, "会话聚合同样走回退");
}

// ---- 用例 7:子代理归因 —— 同 trace 的 subagent 请求并入会话口径(默认开启),异 trace/error 排除 ----
{
  const dbPath = path.join(tmp, "subagent.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 900, durMs: 1000, input: 800, cacheRead: 700, trace: "T1" });
  insertRequest(db, { t0: 2_000_000, out: 200, ttft: 100, gen: 900, durMs: 1000, input: 900, cacheRead: 800, trace: "T1",
                      qs: "subagent", sess: "sess_sub_1" });
  insertRequest(db, { t0: 3_000_000, out: 500, ttft: 100, gen: 900, durMs: 1000, input: 900, cacheRead: 800, trace: "T9",
                      qs: "subagent", sess: "sess_sub_2" });   // 异 trace → 不归因
  insertRequest(db, { t0: 4_000_000, out: 999, ttft: 100, gen: 900, durMs: 1000, input: 900, cacheRead: 800, trace: "T1",
                      qs: "subagent", sess: "sess_sub_1", status: "error" }); // error → 排除
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);   // 默认 includeSubagents: true
  assert.equal(r.session.requests, 2, "主请求 1 + 可归因子代理 1(error/异 trace 排除)");
  assert.equal(r.session.totalOutput, 300, "100(主) + 200(同 trace 子代理)");
  assert.equal(r.session.subagent.requests, 1, "子代理明细只含可归因行");
  assert.equal(r.session.includesSubagents, true);
  assert.equal(r.session.avgTps, 150, "加权并入:300tok ÷ 2s = 150");

  const off = query(SID, { includeSubagents: false });
  assert.equal(off.session.requests, 1, "开关关闭:仅主请求");
  assert.equal(off.session.totalOutput, 100);
  assert.equal(off.session.subagent, null);
  assert.equal(off.session.includesSubagents, false);
}

// ---- 用例 8:model_usage 缺 trace_id 列(旧库) → 子代理归因静默降级,其余指标不受影响 ----
{
  const dbPath = path.join(tmp, "no-trace.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE model_usage (
    turn_id TEXT, session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
    output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER,
    cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
    started_at INTEGER, first_token_at INTEGER,
    completed_at INTEGER, duration_ms INTEGER, time_to_first_token_ms INTEGER)`);   // 无 trace_id
  db.prepare(`INSERT INTO model_usage (turn_id,session_id,status,query_source,model_id,
              output_tokens,reasoning_tokens,input_tokens,cache_read_input_tokens,
              started_at,first_token_at,completed_at,duration_ms,time_to_first_token_ms)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(null, SID, "completed", "main_turn", "test-model", 100, 0, 800, 700,
         1_000_000, 1_000_100, 1_001_000, 1000, 100);
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.latest.tokPerSec, 100, "主对话指标不受影响");
  assert.equal(r.session.subagent, null, "trace 归因不可用时子代理口径置空");
  assert.equal(r.session.requests, 1);
}

// ---- 用例 9:auto 识别优先 main_turn,不被更新的子代理行劫持(S1) ----
{
  const dbPath = path.join(tmp, "auto-main.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 1000, trace: "T1" });
  insertRequest(db, { t0: 2_000_000, out: 200, ttft: 100, gen: 1000, trace: "T1",
                      qs: "subagent", sess: "sess_sub_1" }); // 更新但非主会话
  db.close();

  process.env.ZCODE_TPS_LAST_SESSION = path.join(tmp, "no-such-file.json");
  const { query } = await loadWith(dbPath);
  const r = query(null);
  assert.equal(r.sessionId, SID, "auto 应选中最新 main_turn 会话,而非更新的子代理会话");
  assert.equal(r.scoped, "auto-main");
  delete process.env.ZCODE_TPS_LAST_SESSION;
}

// ---- 用例 10:last-session 文件回退(S1):新会话(新鲜无数据)采用文件,陈旧文件回退 DB ----
{
  const dbPath = path.join(tmp, "auto-file.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 1000 });
  db.close();

  const { query } = await loadWith(dbPath);
  const fresh = path.join(tmp, "fresh.json");
  fs.writeFileSync(fresh, JSON.stringify({ sessionId: "sess_NEW", ts: Date.now(), source: "test" }));
  let r = query(null, { lastSessionFile: fresh });
  assert.equal(r.sessionId, "sess_NEW", "新鲜文件(新会话)应优先采用,即使库中无该会话数据");
  assert.equal(r.scoped, "file");

  const stale = path.join(tmp, "stale.json");
  fs.writeFileSync(stale, JSON.stringify({ sessionId: "sess_GONE", ts: Date.now() - 30 * 86400 * 1000, source: "test" }));
  r = query(null, { lastSessionFile: stale });
  assert.equal(r.sessionId, SID, "陈旧无数据文件应回退到最新 main_turn 会话");
  assert.equal(r.scoped, "auto-main");
}

// ---- 用例 11:子代理并入时口径对齐(S2):samples 含子有效请求,展示标注主对话口径 ----
{
  const dbPath = path.join(tmp, "scope.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 1000, input: 800, cacheRead: 700, turnId: "turn_s", trace: "T1" });
  insertRequest(db, { t0: 2_000_000, out: 200, ttft: 100, gen: 1000, input: 900, cacheRead: 800, trace: "T1",
                      qs: "subagent", sess: "sess_sub_1" });
  db.exec(`CREATE TABLE turn_usage (turn_id TEXT, session_id TEXT, status TEXT, completed_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
    computed_total_tokens INTEGER, duration_ms INTEGER, model_request_count INTEGER)`);
  db.prepare(`INSERT INTO turn_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("turn_s", SID, "completed", 3_000_000, 800, 100, 0, 0, 700, 900, 5000, 1);
  db.close();

  const { query, formatLine } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.session.includesSubagents, true);
  assert.equal(r.session.samples, 2, "samples 应与 avgTps 口径一致(含子代理有效请求)");
  assert.equal(r.usage.scope, "main_turn", "存在 main_turn 时 usage 为主对话口径");
  const line = formatLine(r);
  assert.ok(line.includes("tok(主)"), "并入子代理时会话 tok 须标注主对话口径");
  assert.ok(line.includes("缓存") && line.includes("%(主)"), "并入子代理时缓存命中率须标注主对话口径");

  const pure = query(SID, { includeSubagents: false });
  assert.ok(!formatLine(pure).includes("(主)"), "纯主对话口径时展示应与旧版一致(无标注)");
}

// ---- 用例 12:openDb 设置 busy_timeout(S3),读不因短暂写锁直接失败 ----
{
  const dbPath = path.join(tmp, "busy.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  db.close();

  process.env.ZCODE_USAGE_DB = dbPath;
  const { openDb } = await import(pathToFileURL(SCRIPT).href + "?case=busy" + Math.random());
  const odb = openDb();
  try {
    const row = odb.prepare("PRAGMA busy_timeout").get();
    assert.equal(row.timeout, 2000, "只读连接应设置 2s 锁等待");
  } finally {
    odb.close();
  }
}

// ---- 用例 13:withBusyRetry 遇 BUSY/LOCKED 重试一次,非忙错误直抛(S3) ----
{
  const { withBusyRetry } = await import(pathToFileURL(SCRIPT).href + "?case=retry" + Math.random());
  let calls = 0;
  const r = withBusyRetry(() => {
    calls++;
    if (calls === 1) { const e = new Error("database is locked"); e.code = "SQLITE_BUSY"; throw e; }
    return "ok";
  });
  assert.equal(r, "ok");
  assert.equal(calls, 2, "忙时应等待后重试一次");

  let otherCalls = 0;
  assert.throws(() => withBusyRetry(() => { otherCalls++; throw new Error("no such table: x"); }), /no such table/);
  assert.equal(otherCalls, 1, "非忙错误不应重试");
}

// ---- 用例 14:配置布尔归一化(O7):"false" 等字符串写法同样生效 ----
{
  const { parseBool } = await import(pathToFileURL(SCRIPT).href + "?case=parsebool" + Math.random());
  assert.equal(parseBool("false", true), false);
  assert.equal(parseBool("FALSE", true), false);
  assert.equal(parseBool("0", true), false);
  assert.equal(parseBool("off", true), false);
  assert.equal(parseBool(undefined, true), true);
  assert.equal(parseBool(undefined, false), false);
  assert.equal(parseBool("yes", false), true);
  assert.equal(parseBool("x", true), true, "未知值回落默认,避免误关");

  const dbPath = path.join(tmp, "boolstr.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 1000, trace: "T1" });
  insertRequest(db, { t0: 2_000_000, out: 200, ttft: 100, gen: 1000, trace: "T1",
                      qs: "subagent", sess: "sess_sub_1" });
  db.close();

  process.env.ZCODE_USAGE_DB = dbPath;
  const { query } = await loadWith(dbPath);
  const off = query(SID, { includeSubagents: "false" });
  assert.equal(off.session.includesSubagents, false, "字符串 false 应关闭子代理归因");
  assert.equal(off.session.requests, 1);
}

// ---- 用例 15:CLI 库不可用时 --json 输出 error 对象而非堆栈(S3) ----
{
  let out = "";
  try {
    out = execFileSync(process.execPath, [SCRIPT, "--json"], {
      env: { ...process.env, ZCODE_USAGE_DB: path.join(tmp, "no-such-dir", "db.sqlite") },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    out = (e.stdout || "").toString(); // 非零退出码时从异常对象取 stdout
  }
  const j = JSON.parse(out);
  assert.ok(j.error, "--json 失败时 stdout 应为含 error 的 JSON");
  assert.ok(j.db, "错误对象应带出数据库路径以便排查");
}

// ---- 用例 17:字段名单解析(F1) ----
{
  const { resolveRateFields } = await import(pathToFileURL(SCRIPT).href + "?case=fields" + Math.random());
  const eq = (a, b) => assert.deepEqual(a, b);
  eq(resolveRateFields(undefined), ["rates", "session", "cache"]);
  eq(resolveRateFields(null), ["rates", "session", "cache"]);
  eq(resolveRateFields("all"), ["rates", "ttft", "turn", "session", "cache", "time"]);
  eq(resolveRateFields("ALL"), ["rates", "ttft", "turn", "session", "cache", "time"]);
  eq(resolveRateFields(["time", "rates"]), ["time", "rates"]);
  eq(resolveRateFields(["all"]), ["rates", "ttft", "turn", "session", "cache", "time"]);
  eq(resolveRateFields(["rates", "ALL"]), ["rates", "ttft", "turn", "session", "cache", "time"]);
  eq(resolveRateFields(["rates", "nope", "rates"]), ["rates"]);
  eq(resolveRateFields([]), ["rates", "session", "cache"]);
  eq(resolveRateFields(42), ["rates", "session", "cache"]);
}

// ---- 用例 18:默认三段 + 自定义顺序/回落(F1) ----
{
  const dbPath = path.join(tmp, "fields.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 1000, input: 800, cacheRead: 700, turnId: "turn_f" });
  db.exec(`CREATE TABLE turn_usage (turn_id TEXT, session_id TEXT, status TEXT, completed_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
    computed_total_tokens INTEGER, duration_ms INTEGER, model_request_count INTEGER)`);
  db.prepare(`INSERT INTO turn_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("turn_f", SID, "completed", 2_000_000, 800, 100, 0, 0, 700, 900, 5000, 1);
  db.close();

  const { query, formatLine } = await loadWith(dbPath);
  const r = query(SID);
  const def = formatLine(r);
  assert.ok(def.includes("⚡") && def.includes("会话 900 tok") && def.includes("缓存 87.5%"));
  assert.ok(!def.includes("首字") && !def.includes("最近轮 读") && !def.includes("⏱") && !def.includes("ctx"));

  const custom = formatLine(r, ["time", "rates"]);
  assert.ok(custom.startsWith("⏱"), "应尊重自定义顺序");
  assert.ok(custom.includes("⚡") && !custom.includes("会话 "), "未选字段不应出现(注意速率组内的会话均不算)");

  const all = formatLine(r, "all");
  for (const s of ["⚡", "首字", "最近轮 读", "会话 900 tok", "缓存 87.5%", "⏱"]) {
    assert.ok(all.includes(s), `"all" 应含 ${s}`);
  }
  // 无数据的字段被跳过至空时回落默认名单,行恒非空
  const empty = formatLine({ ...r, latest: { ...r.latest, ttftMs: null }, turn: null, usage: null, cacheHit: null }, ["ttft", "turn"]);
  assert.ok(empty.includes("⚡"), "所选字段无数据时应回落默认渲染");
}

// ---- 用例 19:turn_id 为 NULL 时不推测轮次;会话累计仍可用 ----
{
  const dbPath = path.join(tmp, "null-turn.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 900, durMs: 1000, turnId: null });
  db.exec(`CREATE TABLE turn_usage (turn_id TEXT, session_id TEXT, status TEXT, completed_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
    computed_total_tokens INTEGER, duration_ms INTEGER, model_request_count INTEGER)`);
  db.prepare(`INSERT INTO turn_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(null, SID, "completed", 2_000_000, 800, 100, 0, 0, 700, 900, 5000, 1);
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.turn, null, "NULL turn_id 不能证明轮次关系");
  assert.equal(r.usage.turns, null);
  assert.equal(r.usage.total, 1100);
  assert.equal(r.session.avgTps, 100);
}

// ---- 用例 20:Responses output 已含 reasoning;headline 不得重复加,history 保留 0.3 旧值 ----
{
  const dbPath = path.join(tmp, "responses-semantics.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, {
    t0: 1_000_000, out: 1807, reasoning: 1711, ttft: 12_283, gen: 477, durMs: 12_760,
  });
  db.close();

  const { query, formatLine } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.latest.tokPerSec, 141.6, "headline 应为 1807/12.760s,reasoning 已包含在 output 中");
  assert.equal(r.latest.legacyTps, 7375.3, "legacyTps 仅复现 0.3 的重复计数旧公式");
  assert.equal(r.latest.durMs, 12_760);
  assert.equal(r.latest.genMs, 477);
  assert.equal(r.session.avgTps, 141.6);
  assert.ok(formatLine(r).includes("最近 141.6"), "formatLine 应透传新 headline 速率");
}

// ---- 用例 21:零输出不计速率,但 main/subagent 请求与 token 累计不得消失 ----
{
  const dbPath = path.join(tmp, "zero-output.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 900, durMs: 1000,
                      input: 1000, turnId: "turn_zero", trace: "TZ" });
  insertRequest(db, { t0: 2_000_000, out: 0, reasoning: 0, ttft: 100, gen: 900, durMs: 1000,
                      input: 300, turnId: "turn_zero", trace: "TZ" });
  insertRequest(db, { t0: 3_000_000, out: 0, reasoning: 0, ttft: 100, gen: 900, durMs: 1000,
                      input: 400, trace: "TZ", qs: "subagent", sess: "sess_sub_zero" });
  db.exec(`CREATE TABLE turn_usage (turn_id TEXT, session_id TEXT, status TEXT, completed_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
    computed_total_tokens INTEGER, duration_ms INTEGER, model_request_count INTEGER)`);
  db.prepare(`INSERT INTO turn_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("turn_zero", SID, "completed", 4_000_000, 1300, 100, 0, 0, 0, 1400, 2000, 2);
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.latest.outputTokens, 100, "较新的零输出 main 行应被 latest 跳过");
  assert.equal(r.session.samples, 1, "仅有输出的 main 请求计入样本");
  assert.equal(r.session.avgTps, 100);
  assert.equal(r.turn.avgTps, 100, "轮均同样排除零输出请求");
  assert.equal(r.session.requests, 3, "两个 main + 一个归因 subagent 均须保留在累计请求数");
  assert.equal(r.session.totalInput, 1700);
  assert.ok(r.session.subagent, "即使 subagent 无有效速率,累计明细仍须存在");
  assert.equal(r.session.subagent.requests, 1);
  assert.equal(r.session.subagent.avgTps, null);
}

// ---- 用例 22:duration_ms 行级 NULL 时,latest/session/turn/subagent 都回退时间戳差 ----
{
  const dbPath = path.join(tmp, "duration-fallback.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 900, durMs: null,
                      turnId: "turn_fallback", trace: "TF" });
  insertRequest(db, { t0: 2_000_000, out: 200, ttft: 100, gen: 900, durMs: null,
                      trace: "TF", qs: "subagent", sess: "sess_sub_fallback" });
  db.exec(`CREATE TABLE turn_usage (turn_id TEXT, session_id TEXT, status TEXT, completed_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
    computed_total_tokens INTEGER, duration_ms INTEGER, model_request_count INTEGER)`);
  db.prepare(`INSERT INTO turn_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("turn_fallback", SID, "completed", 3_000_000, 1000, 100, 0, 0, 0, 1100, 1000, 1);
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.latest.durMs, 1000);
  assert.equal(r.latest.tokPerSec, 100);
  assert.equal(r.turn.avgTps, 100);
  assert.equal(r.session.subagent.avgTps, 200);
  assert.equal(r.session.avgTps, 150);
  assert.equal(r.session.samples, 2);
}

// ---- 用例 23:无 first-token 但总时长有效的新样本应纳入,legacy/TTFT 保持空 ----
{
  const dbPath = path.join(tmp, "no-first-valid-duration.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: null, gen: null, durMs: 1000,
                      firstAt: null, completedAt: 1_001_000 });
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.latest.tokPerSec, 100);
  assert.equal(r.latest.durMs, 1000);
  assert.equal(r.latest.genMs, null);
  assert.equal(r.latest.legacyTps, null);
  assert.equal(r.latest.ttftMs, null);
  assert.equal(r.session.avgTps, 100);
  assert.equal(r.session.samples, 1);
}

// ---- 用例 24:总时长无法生成时无效;有旧有效行则跳过,全无效仍保留 history[0] ----
{
  const dbPath = path.join(tmp, "invalid-duration.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 900, durMs: 1000 });
  insertRequest(db, { t0: 2_000_000, out: 50, ttft: null, gen: null, durMs: null,
                      startedAt: null, firstAt: null, completedAt: 2_005_000 });
  db.close();

  const { query } = await loadWith(dbPath);
  let r = query(SID);
  assert.equal(r.latest.outputTokens, 100);
  assert.equal(r.session.samples, 1);

  const onlyPath = path.join(tmp, "only-invalid-duration.sqlite");
  const only = new DatabaseSync(onlyPath);
  createModelUsage(only);
  insertRequest(only, { t0: 1_000_000, out: 50, ttft: null, gen: null, durMs: null,
                        startedAt: null, firstAt: null, completedAt: 1_005_000 });
  only.close();
  ({ query: r } = await loadWith(onlyPath));
  const result = r(SID);
  assert.equal(result.latest.outputTokens, 50);
  assert.equal(result.latest.tokPerSec, null);
  assert.equal(result.session.samples, 0);
  assert.equal(result.session.avgTps, null);
}

// ---- 用例 25:总时长边界与 TOKEN_RATE_MIN_MS 显式覆盖 ----
{
  const dbPath = path.join(tmp, "duration-boundaries.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 40, ttft: 100, gen: 300, durMs: 400 });
  insertRequest(db, { t0: 2_000_000, out: 50, ttft: 100, gen: 400, durMs: 500 });
  insertRequest(db, { t0: 3_000_000, out: 3600, ttft: 100, gen: 3_599_900, durMs: 3_600_000 });
  db.close();

  delete process.env.TOKEN_RATE_MIN_MS;
  let { query } = await loadWith(dbPath);
  let r = query(SID);
  assert.equal(r.session.samples, 1);
  assert.equal(r.session.avgTps, 100);
  assert.equal(r.latest.durMs, 500);

  process.env.TOKEN_RATE_MIN_MS = "400";
  ({ query } = await loadWith(dbPath));
  r = query(SID);
  assert.equal(r.session.samples, 2, "显式旧配置值 400ms 应继续生效");
  assert.equal(r.session.avgTps, 100);

  process.env.TOKEN_RATE_MAX_MS = "500";
  ({ query } = await loadWith(dbPath));
  r = query(SID);
  assert.equal(r.session.samples, 1, "显式 MAX=500ms 应按总时长半开区间排除 500ms 行");
  assert.equal(r.latest.durMs, 400);
  delete process.env.TOKEN_RATE_MIN_MS;
  delete process.env.TOKEN_RATE_MAX_MS;
}

// ---- 用例 26:duration_ms 非 NULL 时优先于 completed-started ----
{
  const dbPath = path.join(tmp, "duration-precedence.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 900, durMs: 1000,
                      completedAt: 1_010_000 });
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.latest.durMs, 1000);
  assert.equal(r.latest.tokPerSec, 100);
  assert.equal(r.session.avgTps, 100);
}

// ---- 用例 27:核心列缺失时 query 失败,hook 仍输出严格 JSON 空注入 ----
{
  const dbPath = path.join(tmp, "hook-missing-duration.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE model_usage (
    turn_id TEXT, session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
    output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER,
    cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
    trace_id TEXT, first_token_at INTEGER,
    completed_at INTEGER, time_to_first_token_ms INTEGER)`);   // 无 started_at/duration_ms
  db.prepare(`INSERT INTO model_usage (turn_id,session_id,status,query_source,model_id,
              output_tokens,reasoning_tokens,input_tokens,cache_read_input_tokens,
              cache_creation_input_tokens,trace_id,first_token_at,completed_at,time_to_first_token_ms)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(null, SID, "completed", "main_turn", "test-model", 100, 0, 1000, 900, null, null,
         1_000_100, 1_001_000, 100);
  db.close();

  const { query } = await loadWith(dbPath);
  assert.throws(() => query(SID), /duration_ms|started_at/);
  const stateFile = path.join(tmp, "hook-state", "last-session.json");
  const stdout = execFileSync(process.execPath, [HOOK], {
    env: {
      ...process.env,
      ZCODE_USAGE_DB: dbPath,
      ZCODE_SESSION_ID: SID,
      ZCODE_TPS_LAST_SESSION: stateFile,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const payload = JSON.parse(stdout);
  assert.deepEqual(Object.keys(payload), ["hookSpecificOutput"]);
  assert.equal(payload.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(payload.hookSpecificOutput.additionalContext, "");
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).sessionId, SID,
               "hook 状态写入必须使用测试隔离路径");
}

// ---- 用例 28:跨重启恢复的会话 —— turn_usage 冻结在旧数据时,轮次/会话仍取到 model_usage 的新鲜值 ----
// 真实场景:ZCode 对重启后恢复的会话不再写 turn_usage 行(实测滞后 2.9 天),旧实现会把
// 三天前的"上轮/会话 tok/缓存命中率"当作当前数据显示。v0.4.1 起以 model_usage 为单一数据源。
{
  const dbPath = path.join(tmp, "resumed-stale.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  db.exec(`CREATE TABLE turn_usage (turn_id TEXT, session_id TEXT, status TEXT, completed_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
    computed_total_tokens INTEGER, duration_ms INTEGER, model_request_count INTEGER)`);
  db.prepare(`INSERT INTO turn_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("turn_old", SID, "completed", 1_000_000, 100, 100, 0, 0, 0, 200, 1000, 1); // 冻结的旧数据
  // 今天(恢复后)的新轮次:model_usage 有行,turn_usage 无对应行
  insertRequest(db, { t0: 9_000_000, out: 150, ttft: 100, gen: 900, durMs: 1000,
                      input: 2000, cacheRead: 1800, turnId: "turn_today" });
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.turn.turnId, "turn_today", "上轮必须是今天的新轮次,而非 turn_usage 里的陈旧行");
  assert.equal(r.turn.total, 2150, "上轮 token 应来自 model_usage 的新鲜聚合(2000+150)");
  assert.equal(r.usage.turns, 1, "轮次数按 model_usage 的 turn_id 分组");
  assert.equal(r.usage.total, 2150, "会话累计不得冻结在 turn_usage 的旧值");
  assert.equal(r.cacheHit, 90, "缓存命中率 = 1800/2000(新鲜口径)");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("全部 28 个用例通过 ✅(请求端到端口径 / 0.3 旧值 / duration 回退与边界 / 零输出 / 无 first-token / 子代理累计 / hook 契约 / model_usage 单一数据源)");
