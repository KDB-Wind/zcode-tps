// 最小回归测试:验证 usage 库结构异常时的降级行为与查询口径。
// 运行:node test/degrade.test.mjs(需要 Node >= 22.5,零第三方依赖)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-tps-test-"));
const SCRIPT = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..", "plugins", "zcode-tps", "scripts", "token-rate.mjs"
);
const SID = "sess_test";

function createModelUsage(db) {
  db.exec(`CREATE TABLE model_usage (
    turn_id TEXT, session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
    output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER,
    cache_read_input_tokens INTEGER, trace_id TEXT, first_token_at INTEGER,
    completed_at INTEGER, time_to_first_token_ms INTEGER)`);
}

function insertRequest(db, { t0, out = 100, ttft = 200, gen = 1000, input = 1000, cacheRead = 900, turnId = null, qs = "main_turn", sess = SID, status = "completed", trace = null }) {
  db.prepare(
    `INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(turnId, sess, status, qs, "test-model", out, 0, input, cacheRead, trace,
        gen == null ? null : t0, gen == null ? t0 + 5000 : t0 + gen, ttft);
}

async function loadWith(dbPath) {
  process.env.ZCODE_USAGE_DB = dbPath;
  // query string 使 ESM 缓存失效,每个用例拿到读取新 env 的全新模块实例
  return import(pathToFileURL(SCRIPT).href + "?case=" + Math.random());
}

// ---- 用例 1:库里只有 model_usage(无 turn_usage 表)→ 核心速率仍工作,turn/usage 优雅置空 ----
{
  const dbPath = path.join(tmp, "no-turn-usage.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  const t0 = 1_000_000;
  insertRequest(db, { t0: t0 + 200, out: 120, ttft: 200, gen: 1000 });   // 较新,有效 → 120 tok/s
  insertRequest(db, { t0: t0 + 100, out: 50,  ttft: null, gen: null });  // 缺流式时间但 completed_at 最新 → 无效,应被跳过
  insertRequest(db, { t0: t0,       out: 60,  ttft: 100, gen: 2000 });   // 最早,有效 → 30 tok/s
  db.close();

  const { query, formatLine } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.turn, null, "无 turn_usage 表时 turn 应为 null");
  assert.equal(r.usage, null, "无 turn_usage 表时 usage 应为 null");
  assert.equal(r.cacheHit, null, "无 turn_usage 表时 cacheHit 应为 null");
  assert.equal(r.latest.tokPerSec, 30, "latest 应取最新一条有效记录(跳过缺失时间戳的行)");
  assert.equal(r.history.length, 3, "history 应包含全部请求");
  assert.ok(formatLine(r).includes("⚡"), "降级时速率行仍可格式化");
}

// ---- 用例 2:turn_usage 存在 → 本轮/会话累计/缓存命中率正常计算,且区分加权与算术平均 ----
{
  const dbPath = path.join(tmp, "with-turn-usage.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 1000, input: 800, cacheRead: 700, turnId: "turn_test" });
  insertRequest(db, { t0: 3_000_000, out: 100, ttft: 100, gen: 9000, input: 800, cacheRead: 700, turnId: "turn_test" });
  db.exec(`CREATE TABLE turn_usage (turn_id TEXT, session_id TEXT, status TEXT, completed_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
    computed_total_tokens INTEGER, duration_ms INTEGER, model_request_count INTEGER)`);
  db.prepare(`INSERT INTO turn_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("turn_test", SID, "completed", 2_000_000, 800, 100, 0, 0, 700, 900, 5000, 1);
  db.close();

  const { query, formatLine } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.turn.total, 900);
  assert.equal(r.turn.cacheHit, 87.5);
  // 100tok/1s + 100tok/9s → 加权 = 200/10s = 20;算术平均会是 (11.1+11.1)/2? 不,两条速率不同,
  // 算术平均 = (100+11.1)/2 ≈ 55.6 —— 用 20 断言可区分两种算法
  assert.equal(r.turn.avgTps, 20, "轮级速率应为加权口径 200tok÷10s=20,而非算术平均≈55.6");
  assert.equal(r.usage.turns, 1);
  assert.equal(r.usage.total, 900);
  assert.equal(r.cacheHit, 87.5);
  const line = formatLine(r);
  assert.ok(line.includes("ctx 800"), "首字后应附上下文规模");
  assert.ok(line.includes("读 800"), "上轮应使用'读'口径标注输入(避免误读为消耗)");
  assert.ok(line.includes("(出 100)"), "上轮应标注生成量");
  assert.equal(r.session.avgTps, 20, "会话级速率应为加权口径");
  assert.ok(Math.abs(r.latest.tokPerSec - 11.1) < 0.1, "最近应为最新请求的瞬时速率 100/9s");
}

// ---- 用例 3:turn_usage 存在但列结构变更 → 仍只降级三项,不抛异常 ----
{
  const dbPath = path.join(tmp, "bad-turn-usage.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 1000 });
  db.exec(`CREATE TABLE turn_usage (foo TEXT)`); // 错误结构
  db.close();

  const { query, formatLine } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.turn, null);
  assert.equal(r.usage, null);
  assert.ok(r.latest.tokPerSec > 0, "结构变更时 tok/s 仍应可用");
  assert.ok(formatLine(r).includes("⚡"));
}

// ---- 用例 4:history 与统计窗口分离(history 应多于窗口 N=5) ----
{
  const dbPath = path.join(tmp, "many-rows.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  for (let i = 0; i < 7; i++) {
    insertRequest(db, { t0: 1_000_000 + i * 10_000, out: 100 + i, ttft: 100, gen: 1000 });
  }
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.history.length, 7, "history 应返回窗口外全部记录");
  assert.ok(r.history[0].completedAt > r.history[r.history.length - 1].completedAt, "history[0] 应为最新(按时间倒序)");
  assert.ok(Math.abs(r.session.avgTps - 103) < 0.01, "会话级速率应为加权口径 (100+…+106)/7s = 103");
  assert.equal(r.latest.outputTokens, 106, "latest 应是最新一条");
}

// ---- 用例 5:纯生成时长恰为 MAX_GEN_MS → JS 与 SQL 用同一半开区间,一致排除 ----
{
  const dbPath = path.join(tmp, "max-boundary.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 3600, ttft: 100, gen: 3_600_000 }); // == MAX_GEN_MS
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.latest.tokPerSec, null, "请求级:gen == MAX_GEN_MS 应判无效(JS 半开区间)");
  assert.equal(r.session.avgTps, null, "会话聚合:边界行不得计入(SQL 半开区间,与请求级一致)");
  assert.equal(r.session.samples, 0);
}

// ---- 用例 6:会话无 main_turn 请求 → 轮级聚合应继承回退策略 ----
{
  const dbPath = path.join(tmp, "fallback.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 1000, turnId: "turn_x", qs: "session_title" });
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
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 1000, input: 800, cacheRead: 700, trace: "T1" });
  insertRequest(db, { t0: 2_000_000, out: 200, ttft: 100, gen: 1000, input: 900, cacheRead: 800, trace: "T1",
                      qs: "subagent", sess: "sess_sub_1" });
  insertRequest(db, { t0: 3_000_000, out: 500, ttft: 100, gen: 1000, input: 900, cacheRead: 800, trace: "T9",
                      qs: "subagent", sess: "sess_sub_2" });   // 异 trace → 不归因
  insertRequest(db, { t0: 4_000_000, out: 999, ttft: 100, gen: 1000, input: 900, cacheRead: 800, trace: "T1",
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
    cache_read_input_tokens INTEGER, first_token_at INTEGER,
    completed_at INTEGER, time_to_first_token_ms INTEGER)`);   // 无 trace_id
  db.prepare(`INSERT INTO model_usage (turn_id,session_id,status,query_source,model_id,
              output_tokens,reasoning_tokens,input_tokens,cache_read_input_tokens,
              first_token_at,completed_at,time_to_first_token_ms)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(null, SID, "completed", "main_turn", "test-model", 100, 0, 800, 700, 1_000_000, 1_001_000, 100);
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.latest.tokPerSec, 100, "主对话指标不受影响");
  assert.equal(r.session.subagent, null, "trace 归因不可用时子代理口径置空");
  assert.equal(r.session.requests, 1);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("全部 8 个用例通过 ✅(降级边界 / 加权口径 / 顺序 / 回退策略 / 子代理归因)");
