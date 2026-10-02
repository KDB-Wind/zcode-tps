#!/usr/bin/env node
// 合成数据,不会打开宿主库。默认百万行;可用 --rows 100000 做快速性能检查。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { createDb } from "../test/diagnostics-fixture.mjs";
import { query } from "../plugins/zcode-tps/scripts/token-rate.mjs";
import { DETAIL_MODULES } from "../plugins/zcode-tps/scripts/diagnostics.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv.indexOf("--rows");
const count = arg < 0 ? 1_000_000 : Number(process.argv[arg + 1]);
if (!Number.isSafeInteger(count) || count < 10_000 || count > 2_000_000) throw new Error("--rows 需为 10000–2000000 整数");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-tps-benchmark-"));
const file = path.join(dir, "fixture.sqlite");
let db;
try {
  db = createDb(file);
  db.exec("CREATE INDEX mu_source ON model_usage(query_source); CREATE INDEX mu_started_provider_model ON model_usage(started_at,provider_id,model_id)");
  db.exec("BEGIN");
  db.prepare([
    "WITH RECURSIVE seq(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM seq WHERE n+1 < ?)",
    "INSERT INTO model_usage(id,session_id,turn_id,trace_id,query_source,provider_id,model_id,status,started_at,first_token_at,completed_at,duration_ms,time_to_first_token_ms,",
    "input_tokens,output_tokens,reasoning_tokens,cache_read_input_tokens,cache_creation_input_tokens,logical_request_id,attempt_index,retry_count,retryable,cancelled_by_user,context_exceeded)",
    "SELECT 'u'||n, CASE WHEN n<1000 THEN 'S' ELSE 'H'||(n/1000) END, 'T'||(n/10), 'trace-'||(n/1000),",
    "'main_turn','P','M','completed',1700000000000+n*10,1700000000100+n*10,1700000001000+n*10,1000,100,",
    "100,20,0,50,0,'L'||n,0,0,0,0,0 FROM seq"
  ].join(" ")).run(count);
  db.exec("COMMIT");
  db.close(); db = null;
  const baselineDir = path.join(dir, "baseline");
  fs.mkdirSync(baselineDir);
  for (const name of ["token-rate.mjs", "runtime.mjs"]) {
    const old = spawnSync("git", ["show", "b95e0d2:plugins/zcode-tps/scripts/" + name], { cwd: root, encoding: "utf8", windowsHide: true });
    if (old.status !== 0) throw new Error("无法读取 0.5.5 基线 b95e0d2: " + old.stderr);
    fs.writeFileSync(path.join(baselineDir, name), old.stdout);
  }
  // 0.5.5 不接受 opts.dbPath;其 DB_PATH 在模块导入时读取环境变量。
  const savedDbPath = process.env.ZCODE_USAGE_DB;
  process.env.ZCODE_USAGE_DB = file;
  let oldQuery;
  try { oldQuery = (await import(pathToFileURL(path.join(baselineDir, "token-rate.mjs")).href)).query; }
  finally {
    if (savedDbPath === undefined) delete process.env.ZCODE_USAGE_DB;
    else process.env.ZCODE_USAGE_DB = savedDbPath;
  }
  const options = { dbPath: file, lastSessionFile: path.join(dir, "absent-session.json") };
  function checkSame(sid) {
    const extract = (r) => ({ sid: r.sessionId, requests: r.session.requests, sessionTotal: r.session.total,
      input: r.usage?.input, output: r.usage?.output });
    assert.deepEqual(extract(oldQuery(sid, options)), extract(query(sid, options)), "两版本必须读取同一合成库及范围");
  }
  checkSame("S");
  const hot = (fn, sid = "S") => {
    fn(sid, options);
    const samples = Array.from({ length: 7 }, () => { const t = performance.now(); fn(sid, options); return performance.now() - t; }).sort((a, b) => a - b);
    return Math.round(samples[3] * 10) / 10;
  };
  const fastBaselineMs = hot(oldQuery), fastCurrentMs = hot(query);
  const fastMatrix = [];
  function measureFast(indexes) {
    for (const [mode, sid] of [["typical", "H20"], ["largest", "S"], ["auto", null]]) {
      checkSame(sid);
      const baselineMs = hot(oldQuery, sid), currentMs = hot(query, sid);
      fastMatrix.push({ indexes, mode, baselineMs, currentMs, deltaMs: Math.round((currentMs - baselineMs) * 10) / 10,
        investigationThresholdMs: Math.round(Math.max(baselineMs * 0.2, 30) * 10) / 10 });
    }
  }
  async function details() {
    const started = performance.now(), stages = {};
    return await new Promise((resolve, reject) => {
      const worker = spawn(process.execPath, [path.join(root, "plugins/zcode-tps/scripts/token-rate.mjs"), "--details-worker"], {
        stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
        env: { ...process.env, ZCODE_TPS_DETAILS_BUDGET_MS: "5000" },
      });
      let result, fatal, killed = false;
      const timer = setTimeout(() => { killed = true; worker.kill(); }, 5000);
      worker.on("error", reject);
      worker.on("message", (m) => {
        const key = m.tps === "module" ? m.name : m.tps;
        stages[key] = Math.round(performance.now() - started);
        if (m.tps === "done") result = m.diagnostics;
        if (m.tps === "fatal") fatal = m.error;
      });
      worker.on("close", () => {
        clearTimeout(timer);
        resolve({ elapsedMs: Math.round(performance.now() - started), stages, timedOut: killed, error: fatal ?? null,
          status: result?.status ?? "partial", modules: result ? Object.fromEntries(DETAIL_MODULES.map((n) => [n, result[n].status])) : null });
      });
      worker.send({ tps: "run", sessionId: "S", modules: DETAIL_MODULES, includeSubagents: true, dbPath: file });
    });
  }
  const cases = [];
  async function measure(name) {
    const samples = [];
    for (let i = 0; i < 3; i++) samples.push(await details());
    cases.push({ name, samples });
    process.stderr.write(name + ": " + samples.map((s) => s.elapsedMs + "ms/" + s.status).join(", ") + "\n");
  }
  await measure("typical-1000");
  db = new (await import("node:sqlite")).DatabaseSync(file);
  db.exec("UPDATE model_usage SET session_id='S',trace_id='trace-0' WHERE rowid BETWEEN 1001 AND 10000");
  db.close(); db = null;
  await measure("large-10000");
  db = new (await import("node:sqlite")).DatabaseSync(file);
  db.exec("UPDATE model_usage SET session_id='WF',query_source='workflow_child',retry_count=2 WHERE rowid BETWEEN 1001 AND 1500");
  db.exec("UPDATE model_usage SET logical_request_id='retry-'||(rowid/2),attempt_index=rowid%2 WHERE rowid BETWEEN 1501 AND 1600");
  db.exec("INSERT INTO dwf_run(id,parent_session_id) VALUES('RUN','S'); INSERT INTO dwf_actor(run_id,session_id) VALUES('RUN','WF')");
  db.close(); db = null;
  await measure("workflow-retry-10000");
  measureFast("real");
  db = new (await import("node:sqlite")).DatabaseSync(file);
  db.exec("UPDATE model_usage SET session_id='H'||((rowid-1)/1000),trace_id='trace-'||((rowid-1)/1000) WHERE rowid BETWEEN 1001 AND 10000");
  db.exec("DROP INDEX model_usage_session_turn_idx; DROP INDEX model_usage_trace_idx; DROP INDEX mu_source; DROP INDEX mu_started_provider_model");
  db.close(); db = null;
  await measure("no-secondary-index-1000");
  measureFast("no-index");
  // 再加实际父进程 CLI 墙钟验证(有索引典型场景在上方已测 worker 分段)。
  db = new (await import("node:sqlite")).DatabaseSync(file);
  db.exec("CREATE INDEX model_usage_session_turn_idx ON model_usage(session_id,turn_id); CREATE INDEX model_usage_trace_idx ON model_usage(trace_id); CREATE INDEX mu_source ON model_usage(query_source); CREATE INDEX mu_started_provider_model ON model_usage(started_at,provider_id,model_id)");
  db.close(); db = null;
  const cliWallStart = performance.now();
  const cli = spawnSync(process.execPath, [path.join(root, "plugins/zcode-tps/scripts/token-rate.mjs"), "--json", "--session", "S", "--details"],
    { windowsHide: true, encoding: "utf8", timeout: 6000, env: { ...process.env, ZCODE_USAGE_DB: file, ZCODE_TPS_CONFIG: path.join(dir, "absent-config.json"), ZCODE_TPS_DETAILS_BUDGET_MS: "5000" } });
  const cliWallMs = Math.round(performance.now() - cliWallStart);
  const cliResult = JSON.parse(cli.stdout);
  if (cli.status !== 0 || cliResult.diagnostics.status !== "ok" || cliWallMs > 2000) process.exitCode = 1;
  const report = { node: process.version, rows: count, targetTypicalRows: 1000, targetLargeRows: 10000,
    budgetMs: 5000, fastBaselineMs, fastCurrentMs, fastMatrix, actualCli: { elapsedMs: cliWallMs, status: cliResult.diagnostics.status }, cases };
  console.log(JSON.stringify(report, null, 2));
  if (cases[0].samples.some((s) => s.status !== "ok" || s.elapsedMs > 2000)) process.exitCode = 1;
} finally {
  db?.close();
  if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith("zcode-tps-benchmark-")) throw new Error("拒绝清理非本次临时目录");
  fs.rmSync(dir, { recursive: true, force: true });
}
