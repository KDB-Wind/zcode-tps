// doctor 分级回归测试:可选列/表缺失只 warn,不计 failed;核心缺失才 error。
// 运行:node test/doctor.test.mjs(需要 Node >= 22.5,零第三方依赖)
// 注意:仅断言数据库相关检查项;会话状态/配置文件项读取真实家目录,不作断言。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-tps-doctor-"));
const DOC = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..", "plugins", "zcode-tps", "scripts", "doctor.mjs"
);

const MODEL_COLS = (extra) =>
  `turn_id TEXT, session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
   output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER,
   cache_read_input_tokens INTEGER, ${extra} first_token_at INTEGER,
   completed_at INTEGER, time_to_first_token_ms INTEGER`;
const TURN_DDL = `CREATE TABLE turn_usage (turn_id TEXT, session_id TEXT, status TEXT, completed_at INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
  cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
  computed_total_tokens INTEGER, duration_ms INTEGER, model_request_count INTEGER)`;

function makeDb(name, { trace = true, turnId = true, turnTable = true } = {}) {
  const dbPath = path.join(tmp, name);
  const db = new DatabaseSync(dbPath);
  const extra = `${trace ? "trace_id TEXT," : ""}${turnId ? "" : ""}`;
  let ddl = MODEL_COLS(extra);
  if (!turnId) ddl = ddl.replace("turn_id TEXT, ", "");
  db.exec(`CREATE TABLE model_usage (${ddl})`);
  if (turnTable) db.exec(TURN_DDL);
  db.close();
  return dbPath;
}

async function diagnose(dbPath) {
  process.env.ZCODE_USAGE_DB = dbPath;
  const { runDoctor } = await import(pathToFileURL(DOC).href + "?case=" + Math.random());
  const report = await runDoctor();
  return Object.fromEntries(report.checks.map((c) => [c.name, c]));
}

// 仅统计数据库相关检查(会话状态/配置文件读取真实家目录,不受本测试控制,不计入)
const DB_CHECKS = ["usage 数据库", "子代理归因列(trace_id)", "轮次关联列(turn_id)", "turn_usage 表"];

function warns(report) {
  return Object.values(report).filter((c) => DB_CHECKS.includes(c.name) && !c.ok && c.level === "warn").length;
}

function failed(report) {
  return Object.values(report).filter((c) => DB_CHECKS.includes(c.name) && !c.ok && c.level !== "warn").length;
}

// ---- 用例 1:完整结构 → 全过,无警告 ----
{
  const byName = await diagnose(makeDb("full.sqlite"));
  assert.equal(byName["usage 数据库"].ok, true);
  assert.equal(byName["子代理归因列(trace_id)"].ok, true);
  assert.equal(byName["轮次关联列(turn_id)"].ok, true);
  assert.equal(byName["turn_usage 表"].ok, true);
  assert.equal(failed(byName), 0);
  assert.equal(warns(byName), 0);
}

// ---- 用例 2:缺 trace_id → 仅该项 warn,failed 为 0 ----
{
  const byName = await diagnose(makeDb("no-trace.sqlite", { trace: false }));
  assert.equal(byName["usage 数据库"].ok, true, "核心列完整时核心检查应通过");
  assert.equal(byName["子代理归因列(trace_id)"].ok, false);
  assert.equal(byName["子代理归因列(trace_id)"].level, "warn");
  assert.equal(failed(byName), 0, "warn 不应计入 failed");
}

// ---- 用例 3:缺 turn_id → 仅该项 warn ----
{
  const byName = await diagnose(makeDb("no-turnid.sqlite", { turnId: false }));
  assert.equal(byName["usage 数据库"].ok, true);
  assert.equal(byName["轮次关联列(turn_id)"].ok, false);
  assert.equal(byName["轮次关联列(turn_id)"].level, "warn");
  assert.equal(failed(byName), 0);
}

// ---- 用例 4:缺 turn_usage 表 → warn,failed 为 0 ----
{
  const byName = await diagnose(makeDb("no-turn.sqlite", { turnTable: false }));
  assert.equal(byName["turn_usage 表"].ok, false);
  assert.equal(byName["turn_usage 表"].level, "warn");
  assert.equal(failed(byName), 0);
}

// ---- 用例 5:库路径不存在 → error,failed > 0 ----
{
  const byName = await diagnose(path.join(tmp, "no-such-dir", "db.sqlite"));
  assert.equal(byName["usage 数据库"].ok, false);
  assert.equal(byName["usage 数据库"].level, "error");
  assert.ok(failed(byName) > 0);
}

// ---- 用例 6:parseBool 双副本一致性(防漂移) ----
{
  const { parseBoolLoose } = await import(pathToFileURL(DOC).href + "?case=parity" + Math.random());
  process.env.ZCODE_USAGE_DB = makeDb("parity.sqlite");
  const { parseBool } = await import(pathToFileURL(
    path.join(path.dirname(DOC), "token-rate.mjs")).href + "?case=parity" + Math.random());
  for (const v of [true, false, "true", "false", "FALSE", "0", "1", "off", "on", "no", "yes", undefined, null, 0, 1, "x"]) {
    assert.equal(parseBoolLoose(v, true), parseBool(v, true), `parseBool 分歧于 ${JSON.stringify(v)}`);
    assert.equal(parseBoolLoose(v, false), parseBool(v, false), `parseBool 分歧于 ${JSON.stringify(v)}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("doctor 6 个用例通过 ✅(分级 error/warn / 可选列检查 / 布尔一致性)");
