// Synthetic benchmark only: creates its own DB and indexes, never opens the user's usage DB.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

const rows = Number(process.argv[2] ?? 100000);
if (!Number.isInteger(rows) || rows < 100 || rows > 1000000 || rows % 100 !== 0) {
  throw new Error("row count must be a multiple of 100 between 100 and 1000000");
}
const originalEnv = { ...process.env };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-tps-benchmark-"));
const file = path.join(tmp, "fixture.sqlite");
const db = new DatabaseSync(file);
try {
  db.exec(`CREATE TABLE model_usage (
    turn_id TEXT, session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
    output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER,
    cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
    trace_id TEXT, started_at INTEGER, first_token_at INTEGER,
    completed_at INTEGER, duration_ms INTEGER, time_to_first_token_ms INTEGER)`);
  const insert = db.prepare("INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < rows; i++) {
    const main = "s" + Math.floor(i / 5) % 20;
    const sub = i % 5 === 4;
    const turn = "t" + Math.floor(i / 100);
    insert.run(turn, sub ? "child-" + main : main, "completed", sub ? "subagent" : "main_turn",
      "fixture-model", 100, 20, 1000, 900, 0, main + "-" + turn, i * 1000,
      i * 1000 + 100, i * 1000 + 1000, 1000, 100);
  }
  db.exec("COMMIT");
  process.env.ZCODE_USAGE_DB = file;
  for (const key of ["TOKEN_RATE_HIST", "TOKEN_RATE_MIN_MS", "TOKEN_RATE_MAX_MS"]) delete process.env[key];
  const { query } = await import("../plugins/zcode-tps/scripts/token-rate.mjs");
  const measure = label => {
    query("s0"); // Warmup is excluded from the samples.
    const times = [];
    let result;
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      result = query("s0");
      times.push(performance.now() - start);
    }
    assert.equal(result.session.requests, rows / 20);
    assert.equal(result.session.total, rows / 20 * 1100);
    assert.equal(result.session.avgTps, 100);
    assert.ok(result.history.length <= 60);
    times.sort((a, b) => a - b);
    return { label, samples: times.length, medianMs: +times[3].toFixed(1),
      p95Ms: +times[Math.ceil(times.length * .95) - 1].toFixed(1), attributedRequests: result.session.requests };
  };
  const timings = [measure("no_indexes")];
  db.exec(`CREATE INDEX fixture_session ON model_usage(session_id, status, query_source, completed_at);
    CREATE INDEX fixture_trace ON model_usage(trace_id, status, query_source);`);
  timings.push(measure("fixture_indexes"));
  db.exec("BEGIN EXCLUSIVE");
  const lockedAt = performance.now();
  let lockError;
  try { query("s0"); }
  catch (e) { lockError = e.message; }
  finally { db.exec("ROLLBACK"); }
  assert.match(lockError ?? "", /locked|busy/i);
  console.log(JSON.stringify({ node: process.version, platform: process.platform, rows,
    mainSessions: 20, timings, persistentExclusiveLock: {
      elapsedMs: +(performance.now() - lockedAt).toFixed(1), error: lockError,
    }, note: "Synthetic DB, warmed query-only samples; excludes Node startup/hook IO and does not establish real-host latency." }, null, 2));
} finally {
  db.close();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  for (const name of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, name));
  fs.rmdirSync(tmp);
}
