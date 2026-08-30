// 最小回归测试:验证 usage 库结构异常时的降级行为与查询口径。
// 运行:node test/degrade.test.mjs(需要 Node >= 22.5,零第三方依赖)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-tps-plus-test-"));
const SCRIPT = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..", "plugins", "zcode-tps-plus", "scripts", "token-rate.mjs"
);
const SID = "sess_test";

function createModelUsage(db) {
  db.exec(`CREATE TABLE model_usage (
    session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
    output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER,
    cache_read_input_tokens INTEGER, first_token_at INTEGER,
    completed_at INTEGER, time_to_first_token_ms INTEGER)`);
}

function insertRequest(db, { t0, out = 100, ttft = 200, gen = 1000, input = 1000, cacheRead = 900 }) {
  db.prepare(
    `INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(SID, "completed", "main_turn", "test-model", out, 0, input, cacheRead,
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

// ---- 用例 2:turn_usage 存在 → 本轮/会话累计/缓存命中率正常计算 ----
{
  const dbPath = path.join(tmp, "with-turn-usage.sqlite");
  const db = new DatabaseSync(dbPath);
  createModelUsage(db);
  insertRequest(db, { t0: 1_000_000, out: 100, ttft: 100, gen: 1000, input: 800, cacheRead: 700 });
  db.exec(`CREATE TABLE turn_usage (turn_id TEXT, session_id TEXT, status TEXT, completed_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
    computed_total_tokens INTEGER, duration_ms INTEGER, model_request_count INTEGER)`);
  db.prepare(`INSERT INTO turn_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("turn_test", SID, "completed", 2_000_000, 800, 100, 0, 0, 700, 900, 5000, 1);
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.turn.total, 900);
  assert.equal(r.turn.cacheHit, 87.5);
  assert.equal(r.usage.turns, 1);
  assert.equal(r.usage.total, 900);
  assert.equal(r.cacheHit, 87.5);
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
  assert.equal(r.session.samples, 5, "均值/峰值统计窗口应为最近 5 条");
  assert.equal(r.latest.outputTokens, 106, "latest 应是最新一条");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("全部 4 个用例通过 ✅");
