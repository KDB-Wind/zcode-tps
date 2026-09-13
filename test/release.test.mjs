import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { querySettings, supportsNode, healthFile, startHealth, recordHealth } from "../plugins/zcode-tps/scripts/runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-tps-release-"));
const originalEnv = { ...process.env };
let count = 0;
async function fixture(name, run) {
  const file = path.join(tmp, `${name}.sqlite`);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE model_usage (
    turn_id TEXT, session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
    output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER,
    cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
    trace_id TEXT, started_at INTEGER, first_token_at INTEGER,
    completed_at INTEGER, duration_ms INTEGER, time_to_first_token_ms INTEGER)`);
  const insert = (v = {}) => {
    const dur = v.dur ?? 1000, time = v.time ?? 1000;
    const ttft = v.ttft === undefined ? 100 : v.ttft; // null = 列缺失
    const first = v.first !== undefined ? v.first : (ttft == null ? null : time - dur + ttft);
    return db.prepare("INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      v.turn === undefined ? "turn1" : v.turn, v.sid === undefined ? "s" : v.sid, "completed", v.source ?? "main_turn", "m",
      v.out ?? 100, v.reasoning ?? 0, v.input ?? 1000, v.cacheRead ?? 900, 0, v.trace === undefined ? "trace1" : v.trace,
      time - dur, first, time, dur, ttft);
  };
  process.env.ZCODE_USAGE_DB = file;
  process.env.ZCODE_TPS_LAST_SESSION = path.join(tmp, "last.json");
  process.env.ZCODE_TPS_CONFIG = path.join(tmp, "config.json");
  process.env.ZCODE_TPS_HEALTH = path.join(tmp, "health.json");
  const load = async (script = "token-rate") => import(pathToFileURL(path.join(root,
    "plugins/zcode-tps/scripts", `${script}.mjs`)).href + `?fixture=${name}-${Math.random()}`);
  try { await run({ db, insert, load, file }); count++; }
  finally { db.close(); }
}

try {
  await fixture("preserve-warnings", async ({ load }) => {
    const warnings = [];
    const listener = w => warnings.push(w.message);
    process.on("warning", listener);
    try {
      await load(); await load("doctor");
      assert.ok(process.listeners("warning").includes(listener));
      process.emitWarning("unrelated warning probe", "ReviewWarning");
      await delay(0);
      assert.ok(warnings.includes("unrelated warning probe"));
    } finally { process.off("warning", listener); }
  });
  await fixture("invalid-session-scope", async ({ db, insert, load }) => {
    insert({ sid: "a", out: 100 }); insert({ sid: "b", out: 200, time: 2000 });
    insert({ sid: null, out: 300, time: 3000 });
    insert({ sid: " \t\n", out: 400, time: 4000 });
    const { query } = await load();
    let r = query(null);
    assert.equal(r.sessionId, "b");
    assert.equal(r.session.totalOutput, 200);
    db.exec("DELETE FROM model_usage WHERE session_id IN ('a', 'b')");
    r = query(null);
    assert.equal(r.sessionId, null);
    assert.equal(r.session.requests, 0);
    assert.equal(r.session.scope, "unknown");
    assert.equal(r.usage, null);
    assert.ok(r.warnings.some(w => /会话/.test(w)));
    assert.throws(() => query(" \t"), /session|会话/i);
  });
  await fixture("blank-traces", async ({ insert, load }) => {
    const { query } = await load();
    for (const trace of [null, "", " \t\n", "\u00a0\u3000"]) {
      insert({ trace, out: 100 });
      insert({ trace, sid: "other", source: "subagent", out: 900 });
    }
    assert.equal(query("s").session.totalOutput, 400);
    assert.equal(query("s").session.includesSubagents, false);
    insert({ trace: "valid", out: 100 });
    insert({ trace: "valid", sid: "child", source: "subagent", out: 200 });
    assert.equal(query("s").session.totalOutput, 700);
  });
  await fixture("totals", async ({ insert, load }) => {
    insert({ out: 1807, reasoning: 1711 });
    const r = (await load()).query("s");
    assert.equal(r.turn.total, 2807);
    assert.equal(r.usage.total, 2807);
    assert.equal(r.usage.total, r.usage.input + r.usage.output);
  });
  for (const column of ["turn_id", "cache_creation_input_tokens", "trace_id"]) {
    await fixture(`optional-${column}`, async ({ db, insert, load }) => {
      insert();
      db.exec(`ALTER TABLE model_usage DROP COLUMN ${column}`);
      const report = await (await load("doctor")).runDoctor();
      assert.equal(report.checks.find(c => c.name === "usage 数据库").ok, true);
      const r = (await load()).query("s");
      assert.equal(r.session.avgTps, 100);
      assert.equal(r.usage.total, 1100);
      assert.ok(r.warnings.some(w => w.includes(column)));
      if (column === "turn_id") {
        assert.equal(r.turn, null);
        assert.equal(r.usage.turns, null);
      }
      if (column === "cache_creation_input_tokens") {
        assert.equal(r.turn.cacheCreation, null);
        assert.equal(r.usage.cacheCreation, null);
      }
    });
  }
  await fixture("unknown-turns", async ({ insert, load }) => {
    insert({ turn: "known" });
    insert({ turn: null, time: 2000 });
    insert({ turn: "", time: 3000 });
    const r = (await load()).query("s");
    assert.equal(r.turn, null);
    assert.equal(r.usage.turns, null);
    assert.equal(r.usage.knownTurns, 1);
    assert.equal(r.usage.unknownTurnRequests, 2);
    assert.equal(r.usage.total, 3300);
  });
  await fixture("old-state", async ({ insert, load }) => {
    insert({ sid: "old" }); insert({ sid: "new", time: 2000 });
    fs.writeFileSync(process.env.ZCODE_TPS_LAST_SESSION,
      JSON.stringify({ sessionId: "old", ts: Date.now() - 30 * 86400000 }));
    const { query } = await load();
    assert.equal(query(null).sessionId, "new");
    fs.writeFileSync(process.env.ZCODE_TPS_LAST_SESSION,
      JSON.stringify({ sessionId: "old", ts: Date.now() + 86400000 }));
    assert.equal(query(null).sessionId, "new");
    assert.equal(query("old").sessionId, "old");
  });
  await fixture("latest-outside-history", async ({ insert, load }) => {
    insert();
    for (let n = 1; n <= 60; n++) insert({ out: 0, time: 1000 + n * 1000 });
    const r = (await load()).query("s");
    assert.equal(r.history.length, 60);
    assert.equal(r.latest.tokPerSec, 100);
    assert.equal(r.latest.completedAt, 1000);
  });
  await fixture("scope-and-snapshot", async ({ insert, load }) => {
    insert({ source: "other" });
    const { query } = await load();
    const before = Date.now(); const r = query("s");
    assert.equal(r.usage.scope, "session_all");
    assert.ok(r.sampledAt >= before && r.sampledAt <= Date.now());
    assert.equal(r.coverage.retainedOnly, true);
    assert.equal(r.turn.completion, "unknown");
  });
  await fixture("wal-snapshot", async ({ db, insert, load }) => {
    db.exec("PRAGMA journal_mode=WAL");
    insert();
    const { query } = await load();
    const prepare = DatabaseSync.prototype.prepare;
    let wrote = false;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      if (this !== db && sql === "PRAGMA table_info(model_usage)" && !wrote) {
        return { all: (...args) => {
          const rows = statement.all(...args);
          // A writer commits after the report's first read, before its remaining queries.
          wrote = true;
          insert({ time: 2000 });
          return rows;
        } };
      }
      return statement;
    };
    try {
      const r = query("s");
      assert.equal(wrote, true);
      assert.equal(r.history.length, 1);
      assert.equal(r.session.requests, 1);
      assert.equal(r.usage.total, 1100);
    } finally { DatabaseSync.prototype.prepare = prepare; }
    assert.equal(query("s").usage.total, 2200, "next snapshot sees the writer commit");
  });
  await fixture("empty-latest-turn", async ({ insert, load }) => {
    insert({ turn: "previous" });
    insert({ turn: "latest", out: 0, input: 0, cacheRead: 0, time: 2000 });
    const r = (await load()).query("s");
    assert.equal(r.turn.turnId, "latest");
    assert.equal(r.turn.avgTps, null);
    assert.equal(r.latest.turnId, "previous");
    assert.equal(r.turn.completion, "unknown");
  });
  await fixture("hook-and-cli", async ({ insert, load }) => {
    insert({ out: 1807, reasoning: 1711 });
    const invoke = (relative, args = [], nodeArgs = []) => {
      const child = spawnSync(process.execPath, [...nodeArgs, path.join(root, "plugins/zcode-tps", relative), ...args], {
        env: { ...process.env, ZCODE_SESSION_ID: "s" }, encoding: "utf8", timeout: 10000,
      });
      assert.equal(child.error, undefined);
      return { ...child, json: JSON.parse(child.stdout) };
    };
    const hook = () => invoke("hooks/prompt-submit.mjs");
    const start = () => invoke("hooks/session-start.mjs");
    let child = hook();
    assert.equal(child.status, 0);
    assert.equal(child.json.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(child.json.hookSpecificOutput.additionalContext, /采样时间/);
    let health = JSON.parse(fs.readFileSync(process.env.ZCODE_TPS_HEALTH));
    assert.equal(health.status, "ok");
    const successfulAt = health.lastSuccessAt;
    const { runDoctor } = await load("doctor");
    let report = await runDoctor();
    assert.equal(report.failed, 0);
    assert.equal(report.checks.find(c => c.name === "会话状态文件").ok, true);
    assert.equal(report.checks.find(c => c.name === "最近采集").ok, true);

    fs.writeFileSync(process.env.ZCODE_TPS_CONFIG, '{"tokenRateLine":"false"}');
    assert.equal(hook().json.hookSpecificOutput.additionalContext, "");
    assert.equal(start().json.hookSpecificOutput.additionalContext, "");
    assert.equal(JSON.parse(fs.readFileSync(process.env.ZCODE_TPS_HEALTH)).status, "disabled");

    for (const config of ['{"tokenRateLine":', 'null', '[]']) {
      fs.writeFileSync(process.env.ZCODE_TPS_CONFIG, config);
      assert.equal(hook().json.hookSpecificOutput.additionalContext, "");
      health = JSON.parse(fs.readFileSync(process.env.ZCODE_TPS_HEALTH));
      assert.equal(health.status, "error");
      assert.ok(health.error);
      assert.equal(health.lastSuccessAt, successfulAt);
      child = invoke("scripts/token-rate.mjs", ["--json"]);
      assert.equal(child.status, 1);
      assert.ok(child.json.error);
      report = await runDoctor();
      assert.equal(report.checks.find(c => c.name === "配置文件").ok, false);
    }
    fs.writeFileSync(process.env.ZCODE_TPS_CONFIG, '\uFEFF{"tokenRateLine":true}');
    assert.match(hook().json.hookSpecificOutput.additionalContext, /采样时间/);
    assert.equal(invoke("scripts/token-rate.mjs", ["--json"]).json.usage.total, 2807);
    assert.equal((await runDoctor()).checks.find(c => c.name === "配置文件").ok, true);
    fs.unlinkSync(process.env.ZCODE_TPS_CONFIG);
    process.env.TOKEN_RATE_HIST = "1.5";
    child = invoke("scripts/token-rate.mjs", ["--json"]);
    assert.equal(child.status, 1);
    assert.match(child.json.error, /TOKEN_RATE_HIST/);
    assert.equal(hook().json.hookSpecificOutput.additionalContext, "");
    report = await runDoctor();
    assert.equal(report.checks.find(c => c.name === "配置文件").ok, false);
    delete process.env.TOKEN_RATE_HIST;
    child = invoke("scripts/token-rate.mjs", ["--json"]);
    assert.equal(child.json.usage.total, 2807);
    child = invoke("scripts/token-rate.mjs", ["--json"], ["--no-experimental-sqlite"]);
    assert.equal(child.status, 1);
    assert.match(child.json.error, /node:sqlite/);
    child = invoke("hooks/prompt-submit.mjs", [], ["--no-experimental-sqlite"]);
    assert.equal(child.status, 0);
    assert.equal(child.json.hookSpecificOutput.additionalContext, "");
  });
  await fixture("terminated-hook", async ({ db, insert, load }) => {
    insert();
    const hook = path.join(root, "plugins/zcode-tps/hooks/prompt-submit.mjs");
    const env = { ...process.env, ZCODE_SESSION_ID: "s" };
    const first = spawnSync(process.execPath, [hook], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(first.status, 0);
    const previous = JSON.parse(fs.readFileSync(healthFile("s")));
    db.exec("BEGIN EXCLUSIVE");
    const child = spawn(process.execPath, [hook], { env, stdio: "ignore" });
    const closed = once(child, "close");
    try {
      let running;
      const deadline = Date.now() + 5000;
      do {
        await delay(20);
        running = JSON.parse(fs.readFileSync(healthFile("s")));
      } while (running.runId === previous.runId && Date.now() < deadline);
      assert.notEqual(running.runId, previous.runId, "hook must persist its start before querying a locked DB");
      assert.equal(running.status, "running");
      assert.equal(running.lastSuccessAt, previous.lastSuccessAt);
    } finally {
      child.kill();
      await closed;
      db.exec("ROLLBACK");
    }
    const report = await (await load("doctor")).runDoctor();
    const check = report.checks.find(c => c.name === "最近采集");
    assert.equal(check.ok, false);
    assert.equal(check.status, "running");
    assert.match(check.detail, /中断或超时/);
  });
  await fixture("session-health", async ({ load }) => {
    const { runDoctor } = await load("doctor");
    const forSession = async sid => {
      const previous = process.env.ZCODE_SESSION_ID;
      process.env.ZCODE_SESSION_ID = sid;
      try { return (await runDoctor()).checks.find(c => c.name === "最近采集"); }
      finally {
        if (previous === undefined) delete process.env.ZCODE_SESSION_ID;
        else process.env.ZCODE_SESSION_ID = previous;
      }
    };
    const a = startHealth("window-a");
    recordHealth({ ...a, status: "ok", lastSuccessAt: Date.now(), durationMs: 5, warnings: [] });
    const b = startHealth("window-b");
    recordHealth({ ...b, status: "error", error: "test failure", durationMs: 10 });
    assert.equal((await forSession("window-a")).ok, true);
    assert.equal((await forSession("window-b")).ok, false);
    assert.equal((await forSession("window-never-run")).ok, false);
    assert.equal(JSON.parse(fs.readFileSync(healthFile("window-b"))).lastSuccessAt, undefined);
    assert.equal((await forSession("window-b")).sessionId, "window-b");
    const oldRun = startHealth("window-a");
    const newRun = startHealth("window-a");
    recordHealth({ ...oldRun, status: "ok", durationMs: 999 });
    assert.equal(JSON.parse(fs.readFileSync(healthFile("window-a"))).runId, newRun.runId);
    assert.equal((await forSession("window-a")).ok, false);
    assert.match((await forSession("window-a")).detail, /采集中/);
    assert.notEqual(healthFile("../window-a"), healthFile("window-a"));
    assert.equal(path.dirname(healthFile("../window-a")), tmp, "session IDs cannot escape the health directory");
  });
  await fixture("timezone-display", async ({ insert, load }) => {
    insert({ time: 1000 });
    const runtimeHref = pathToFileURL(path.join(root, "plugins/zcode-tps/scripts/runtime.mjs")).href;
    const { formatInZone, resolveTimezone, zoneOffsetLabel } = await import(runtimeHref);
    // 纯函数:同一毫秒时间戳在不同时区的预格式化字符串(ICU 时区名大小写不敏感)
    assert.equal(formatInZone(0), "1970-01-01 08:00:00");
    assert.equal(formatInZone(0, "UTC"), "1970-01-01 00:00:00");
    assert.equal(formatInZone(0, "utc", false), "00:00:00");
    assert.equal(formatInZone("not-a-number"), null);
    assert.equal(zoneOffsetLabel("Asia/Shanghai"), "UTC+8");
    assert.equal(zoneOffsetLabel("UTC"), "UTC");
    assert.ok(/^[A-Za-z][\w+-]*\/[\w+-]+$|^[A-Za-z]+$/.test(resolveTimezone("system")), "system 解析为合法时区");
    const warns = [];
    assert.equal(resolveTimezone("Mars/Olympus", warns), "Asia/Shanghai");
    assert.ok(warns.some(w => /timezone 配置无效/.test(w)));
    const { query } = await load();
    const runChild = (relative, envExtra = {}, scriptArgs = []) => spawnSync(process.execPath,
      [path.join(root, "plugins/zcode-tps", relative), ...scriptArgs], {
        env: { ...process.env, ZCODE_SESSION_ID: "s", ...envExtra }, encoding: "utf8", timeout: 10000 });
    // 进程内:timezone 选项透传(配置→query 的接线由下方 CLI/hook 子进程覆盖)
    const r = query("s", { timezone: "UTC" });
    assert.equal(r.timezone, "UTC");
    assert.equal(r.utcOffset, "UTC");
    assert.match(r.sampledAtText, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(r.sampledAtText, formatInZone(r.sampledAt, "UTC"));
    assert.equal(r.latest.completedAtText, "1970-01-01 00:00:01");
    assert.equal(r.history[0].completedAtText, r.latest.completedAtText);
    assert.equal(r.turn.completedAtText, r.latest.completedAtText);
    assert.equal(r.coverage.lastCompletedAtText, r.latest.completedAtText);
    // 无效选项回退默认并进入 warnings
    const bad = query("s", { timezone: "Mars/Olympus" });
    assert.equal(bad.timezone, "Asia/Shanghai");
    assert.ok(bad.warnings.some(w => /timezone 配置无效/.test(w)));
    // CLI 读取配置文件;环境变量优先于配置(配置为无效值)
    fs.writeFileSync(process.env.ZCODE_TPS_CONFIG, '{"timezone":"UTC"}');
    const cli = JSON.parse(runChild("scripts/token-rate.mjs", {}, ["--json"]).stdout);
    assert.equal(cli.timezone, "UTC");
    assert.equal(cli.sampledAtText, formatInZone(cli.sampledAt, "UTC"));
    fs.writeFileSync(process.env.ZCODE_TPS_CONFIG, '{"timezone":"Mars/Olympus"}');
    const cliEnv = JSON.parse(runChild("scripts/token-rate.mjs", { ZCODE_TPS_TIMEZONE: "UTC" }, ["--json"]).stdout);
    assert.equal(cliEnv.timezone, "UTC");
    // hook 注入提示按配置时区显示(无效配置回退默认),不再是 ISO Z 字符串
    const child = runChild("hooks/prompt-submit.mjs");
    assert.equal(child.status, 0);
    const ctx = JSON.parse(child.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /\[zcode-tps 采样时间:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\(Asia\/Shanghai UTC\+8\);/);
    assert.doesNotMatch(ctx, /采样时间:\d{4}-\d{2}-\d{2}T/);
    count += 1;
    console.log("timezone-display 用例通过");
  });
  await fixture("decode-speed", async ({ db, insert, load }) => {
    // 三条主对话:ttft 全缺(不参与 decode) / 默认 dur1000-ttft100(解码窗口 900ms) / ttft 回退 first-started
    insert({ out: 500, ttft: null, dur: 1500, time: 2000 });
    insert({ out: 90, time: 3000 });                                   // decode 90/0.9s = 100
    insert({ out: 200, ttft: 900, dur: 2000, time: 5000 });            // decode 200/1.1s ≈ 181.8
    db.prepare("INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "turn1", "s", "completed", "main_turn", "m", 100, 0, 1000, 900, 0, "trace1",
      6000 - 1000, 5800, 6000, 1000, null);                            // ttft 列缺失,first-started 回退 800ms → decode 100/0.2s = 500
    const { query, formatLine } = await load();
    const r = query("s");
    // 请求级:最新有效请求是 TTFT 回推行(first-started=800ms,解码窗口 200ms 恰过下限)
    assert.equal(r.latest.decodeTps, 500);
    assert.deepEqual(r.history.map(h => h.decodeTps), [500, 181.8, 100, null]);
    // 会话加权 decode:(90+200+100)/(0.9+1.1+0.2) = 390/2.2 ≈ 177.3;ttft 全缺的 500tok 行不参与
    assert.equal(r.session.decodeTps, 177.3);
    assert.equal(r.session.decodeSamples, 3);
    assert.equal(r.session.samples, 4, "e2e 有效样本仍含 ttft 缺失行");
    // 速率行:decode 段默认出现,只显示会话加权(单请求波动大不上行)
    assert.ok(formatLine(r).includes("Decode 177.3 tok/s"));
    assert.equal(formatLine(r, ["decode"]), "Decode 177.3 tok/s");
    assert.ok(!formatLine(r).includes("Decode 最近"), "请求级 decode 不进紧凑行");
    // 请求级 Decode 分布(基础范围,不含子代理;窗口>=200ms):有序 [100, 181.8, 500]
    assert.deepEqual(r.decodeStats, { samples: 3, mean: 260.6, median: 181.8, p90: 181.8 });
    // 子代理 decode 并入会话口径
    insert({ out: 100, source: "subagent", sid: "child", trace: "trace1", time: 7000 });
    assert.equal(query("s").decodeStats.samples, 3, "分布统计不含子代理");
    const withSub = query("s");
    assert.equal(withSub.session.decodeTps, 158.1);  // (390+100)/(2.2+0.9)
    assert.equal(withSub.session.decodeSamples, 4);
    // 全部请求 ttft 缺失时 decode 段整体消失,行回落其他段
    db.exec("UPDATE model_usage SET time_to_first_token_ms = NULL, first_token_at = NULL");
    const none = query("s");
    assert.equal(none.decodeStats, null);
    assert.equal(none.session.decodeTps, null);
    assert.ok(!formatLine(none, ["decode"]).includes("Decode"));
    assert.ok(formatLine(none).includes("⚡"), "decode 无数据时默认行仍渲染其余段");
    count += 1;
    console.log("decode-speed 用例通过");
  });
  assert.deepEqual(querySettings({}), { history: 60, min: 500, max: 3600000 });
  for (const value of ["-1", "0", "1.5", "Infinity", "1001", "garbage", ""]) {
    assert.throws(() => querySettings({ TOKEN_RATE_HIST: value }), /TOKEN_RATE_HIST/);
  }
  assert.throws(() => querySettings({ TOKEN_RATE_MIN_MS: "1000", TOKEN_RATE_MAX_MS: "500" }), /必须小于/);
  assert.throws(() => querySettings({ TOKEN_RATE_MIN_MS: "NaN" }), /TOKEN_RATE_MIN_MS/);
  assert.throws(() => querySettings({ TOKEN_RATE_MAX_MS: "Infinity" }), /TOKEN_RATE_MAX_MS/);
  for (const v of ["20.19.0", "22.5.0", "22.12.0", "23.3.0"]) assert.equal(supportsNode(v), false);
  for (const v of ["22.13.0", "23.4.0", "24.0.0", "26.0.0"]) assert.equal(supportsNode(v), true);
  count += 2;
  const versions = [
    JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version,
    JSON.parse(fs.readFileSync(path.join(root, "marketplace.json"))).plugins[0].version,
    JSON.parse(fs.readFileSync(path.join(root, "plugins/zcode-tps/.zcode-plugin/plugin.json"))).version,
  ];
  assert.deepEqual(versions, ["0.5.1", "0.5.1", "0.5.1"]);
  console.log(`release ${count} 个用例通过`);
} finally {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  // Only files created inside our mkdtemp directory are removed.
  for (const name of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, name));
  fs.rmdirSync(tmp);
}
