// Synthetic benchmark matrix only: creates its own DBs and indexes, never opens the user's usage DB.
// 矩阵:库规模(默认 5k/100k/1M 行;可传位置参数只跑一档)× 索引场景(无 / 旧基准实验索引 / 生产真实索引)
// × 查询模式(典型会话/最大会话/自动识别)× 冷(子进程首查)/ 热(进程内 7 次)。
// ZCODE_TPS_BENCH_SCRIPT=<token-rate.mjs 路径> 可对另一版本脚本跑同一矩阵(优化前后对比用)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { generateUsageDb, createRealIndexes, createLegacyFixtureIndexes, dropBenchIndexes } from "./fixture.mjs";

const SCRIPT = process.env.ZCODE_TPS_BENCH_SCRIPT ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "zcode-tps", "scripts", "token-rate.mjs");
const arg = process.argv[2] !== undefined ? Number(process.argv[2]) : null;
if (arg !== null && (!Number.isInteger(arg) || arg < 1000 || arg > 5_000_000)) {
  throw new Error("row count must be an integer between 1000 and 5000000");
}
const tiers = arg ? [arg] : [5_000, 100_000, 1_000_000];
const HOT_SAMPLES = 7;
const COLD_RUNS = 3;
const originalEnv = { ...process.env };
const results = [];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(s.length * 0.95) - 1];
};
const mb = (b) => Math.round(b / 1048576 * 10) / 10;

async function loadScript(tag) {
  return import(pathToFileURL(SCRIPT).href + "?bench=" + tag + Math.random());
}

// 冷查询:全新子进程,包含模块加载与首次连接/页缓存读取;stdout 为 { firstQueryMs, requests }
function coldQuery(env, tag) {
  const out = [];
  for (let i = 0; i < COLD_RUNS; i++) {
    const r = spawnSync(process.execPath, ["-e", COLD_SNIPPET], {
      env: { ...env, BENCH_TAG: tag + Math.random() },
      encoding: "utf8", timeout: 120_000,
    });
    if (r.status !== 0) throw new Error("cold query failed: " + r.stderr.slice(-400));
    out.push(JSON.parse(r.stdout));
  }
  return {
    firstQueryMs: +median(out.map((o) => o.firstQueryMs)).toFixed(1),
    requests: out[0].requests,
  };
}

const COLD_SNIPPET = `
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
const { pathToFileURL } = await import("node:url");
const mod = await import(pathToFileURL(process.env.BENCH_SCRIPT).href + "?cold=" + Math.random());
const t0 = performance.now();
const r = mod.query(process.env.BENCH_SID === "(auto)" ? null : process.env.BENCH_SID);
process.stdout.write(JSON.stringify({ firstQueryMs: performance.now() - t0, requests: r.session.requests }));
`;

for (const rows of tiers) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-tps-bench-"));
  try {
    const file = path.join(tmp, "fixture.sqlite");
    const genDb = new DatabaseSync(file);
    const gen = generateUsageDb(genDb, { rows });
    // 被测脚本在模块加载时读取进程环境,必须直接设置( finally 中整体还原 )
    process.env.ZCODE_USAGE_DB = file;
    process.env.ZCODE_TPS_CONFIG = path.join(tmp, "config.json");
    process.env.ZCODE_TPS_LAST_SESSION = path.join(tmp, "last-session.json");
    process.env.ZCODE_TPS_HEALTH = path.join(tmp, "health.json");
    delete process.env.TOKEN_RATE_HIST; delete process.env.TOKEN_RATE_MIN_MS; delete process.env.TOKEN_RATE_MAX_MS;
    const env = {
      ...process.env,
      BENCH_SCRIPT: SCRIPT,
    };
    const modes = [
      ["typical", gen.typicalSession],
      ["big", gen.bigSession],
      ["auto", "(auto)"],
    ];
    const tierResult = { rows, genTimeInfo: { sessions: gen.expected.size, bigSession: gen.bigSession, typicalSession: gen.typicalSession }, scenarios: [] };

    const scenarioSteps = [
      ["no_indexes", null],
      ["legacy_fixture_indexes", createLegacyFixtureIndexes],
      ["real_indexes", (db) => { dropBenchIndexes(db); createRealIndexes(db); }],
    ];
    for (const [label, setup] of scenarioSteps) {
      if (setup) setup(genDb);
      const { query } = await loadScript(label + rows);
      // oracle:插件 session 口径(主对话 + 可归因子代理)与生成器期望精确一致
      const probe = query(gen.bigSession);
      const exp = gen.expected.get(gen.bigSession);
      assert.equal(probe.session.requests, exp.requests, "attributed requests");
      assert.equal(probe.session.total, exp.total, "attributed total");
      assert.ok(probe.history.length <= 60);
      const scenarioData = { label, oracle: { requests: exp.requests, total: exp.total }, modes: [] };
      for (const [modeName, sid] of modes) {
        const querySid = sid === "(auto)" ? null : sid;
        query(querySid); // warmup excluded
        const times = [];
        let memBefore = process.memoryUsage();
        let result;
        for (let i = 0; i < HOT_SAMPLES; i++) {
          const start = performance.now();
          result = query(querySid);
          times.push(performance.now() - start);
        }
        const memAfter = process.memoryUsage();
        scenarioData.modes.push({
          mode: modeName,
          hot: { medianMs: +median(times).toFixed(1), p95Ms: +p95(times).toFixed(1), samples: times.length },
          memory: { rssDeltaMb: mb(memAfter.rss - memBefore.rss), heapDeltaMb: mb(memAfter.heapUsed - memBefore.heapUsed) },
          cold: modeName === "typical" ? undefined : coldQuery({ ...env, BENCH_SID: sid }, "c" + label + rows),
        });
      }
      tierResult.scenarios.push(scenarioData);
    }

    if (rows === Math.max(...tiers)) {
      // WAL 模式下读走快照、几乎不被写者阻塞;为测量 busy_timeout 预算的最坏路径(与 0.4.2 基线可比),
      // 锁场景切回 DELETE 回滚日志后再持独占锁。
      genDb.exec("PRAGMA journal_mode=DELETE");
      genDb.exec("BEGIN EXCLUSIVE");
      const lockedAt = performance.now();
      let lockError;
      try {
        const { query } = await loadScript("lock" + rows);
        query(gen.bigSession);
      } catch (e) { lockError = e.message; }
      finally { genDb.exec("ROLLBACK"); }
      assert.match(lockError ?? "", /locked|busy/i);
      tierResult.persistentExclusiveLock = { elapsedMs: +(performance.now() - lockedAt).toFixed(1), error: lockError };
    }
    results.push(tierResult);
    genDb.close();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    cleanupTmp(tmp);
  }
}

// Windows:SQLite 句柄释放可能略滞后于 close(),对 unlink 做短暂重试;仍失败则保留目录并在输出中报告
function cleanupTmp(tmp, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try {
      for (const name of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, name));
      fs.rmdirSync(tmp);
      return;
    } catch (e) {
      if (i === attempts - 1) {
        results.push({ warning: `temp dir not removable (left for OS cleanup): ${tmp}: ${e.message}` });
        return;
      }
      sleepSync(250);
    }
  }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

console.log(JSON.stringify({
  node: process.version, platform: process.platform,
  script: SCRIPT, rowsPerTier: tiers, hotSamples: HOT_SAMPLES, coldRuns: COLD_RUNS,
  matrix: results,
  note: "Synthetic DBs with realistic token/cache/source distributions (test/fixture.mjs, seeded). " +
    "hot = in-process medians excluding warmup; cold = median of fresh subprocess first queries (includes module load + first connection). " +
    "memory = rss/heap delta across the hot batch, indicative only. real_indexes mirrors the production model_usage indexes. " +
    "Does not establish real-host latency; hook budget remains 8s.",
}, null, 2));
