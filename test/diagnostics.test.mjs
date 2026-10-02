// 0.6.0 诊断验收测试(spec §12 矩阵:A01–A04、R01–R03、T01–T02、U01–U02、B01–B02 + C01/C02 兼容)。
// fixture 仅在临时目录创建;真实用量库只读、不触碰。期望值来自 diagnostics-fixture.mjs 的显式 oracle。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDiagnosticsFixture, turnUsageScenario, createDb, insertRowsHelper, row } from "./diagnostics-fixture.mjs";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "plugins", "zcode-tps", "scripts", "token-rate.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ownedDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-tps-diag-"));
  ownedDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of ownedDirs) {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("zcode-tps-diag-"));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function runCli(args, { env = {}, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const startedAt = Date.now();
    child.on("close", (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(out.trim()); } catch {}
      resolve({ code, json, out, err, elapsed: Date.now() - startedAt });
    });
  });
}

// 进程内入口(同一只读事务);moduleGate 用于确定性超时注入
async function detailed(dbPath, sessionId, opts = {}) {
  const { queryDetailed } = await import("../plugins/zcode-tps/scripts/diagnostics.mjs");
  return queryDetailed(sessionId, { dbPath, modules: opts.modules, deadline: opts.deadline, moduleGate: opts.moduleGate });
}

test("A01/A02: 互斥账本守恒 —— trace+dwf 双路径、多 event、同父 run 每行只计一次", async () => {
  const dir = tmpDir();
  const fx = buildDiagnosticsFixture(dir);
  const r = await detailed(fx.dbPath, fx.root);
  const d = r.diagnostics;
  assert.equal(d.version, 1);
  assert.equal(d.status, "ok");
  assert.ok(d.snapshotId);
  const acc = d.accounting;
  // 五桶 = oracle
  for (const [name, want] of Object.entries(fx.expected.buckets)) {
    const b = acc.buckets[name];
    assert.equal(b.requests, want.requests, `bucket ${name} requests`);
    assert.equal(b.input, want.input, `bucket ${name} input`);
    assert.equal(b.output, want.output, `bucket ${name} output`);
    assert.equal(b.total, want.input + want.output, `bucket ${name} total=input+output`);
    assert.equal(b.quality.tokensComplete, true);
  }
  // 守恒:桶之和 = observedUsage(spec §4.3)
  const sum = Object.values(acc.buckets).reduce((a, b) => ({ requests: a.requests + b.requests, input: a.input + b.input, output: a.output + b.output, total: (a.total ?? 0) + b.total }), { requests: 0, input: 0, output: 0, total: 0 });
  assert.deepEqual({ requests: acc.observedUsage.requests, input: acc.observedUsage.input, output: acc.observedUsage.output, total: acc.observedUsage.total }, { requests: sum.requests, input: sum.input, output: sum.output, total: sum.total });
  assert.deepEqual({ requests: acc.observedUsage.requests, input: acc.observedUsage.input, output: acc.observedUsage.output, total: acc.observedUsage.total }, fx.expected.observed);
  // 歧义候选不计入总量
  assert.equal(acc.ambiguousCandidates.requests, fx.expected.ambiguous.requests);
  // workflow run 守恒:run 之和 = workflow 桶
  const wf = d.workflow;
  assert.equal(wf.status, "ok");
  assert.equal(wf.data.totals.conservation, "run 之和 = workflow 桶");
  for (const [rid, want] of Object.entries(fx.expected.workflowRuns)) {
    // runs 按 time_created DESC:amb-a(9) > 0(5) > 2(3) > 1(1)
    const idx = ["dwfrun-amb-a", "dwfrun-0", "dwfrun-2", "dwfrun-1"].indexOf(rid);
    const run = wf.data.runs[idx];
    assert.ok(run, `run ${rid} 在列表中`);
    assert.equal(run.requests, want.requests, `run ${rid} requests`);
    if (want.input !== undefined) { assert.equal(run.input, want.input, `run ${rid} input`); assert.equal(run.output, want.output, `run ${rid} output`); }
  }
  assert.equal(wf.data.unattributedTraceLinkedRows, fx.expected.unattributedTraceLinkedRows);
  assert.equal(wf.data.nodeLevelBreakdown.status, "unavailable");
  // A02:workflow_child 归 workflow 桶(0.5.5 会落 auxiliary);旧 session.total 不扩大(C01 兼容)
  assert.equal(acc.buckets.workflow.requests, 3);
  // 与事件数量无关:4 个 dwf_event 不产生第 4 行
  assert.equal(fx.dwf.events.length, 4);
});

test("A03: 两个 root 命中同一 trace/actor 会话 → 明确歧义,不误归", async () => {
  const dir = tmpDir();
  const fx = buildDiagnosticsFixture(dir);
  const main = await detailed(fx.dbPath, fx.root);
  const other = await detailed(fx.dbPath, fx.other);
  assert.equal(main.diagnostics.accounting.ambiguousCandidates.requests, 3); // amb1 + wamb + o1(多 root 命中)
  // sMain 的 subagent 桶不含 tr-amb 行;w9(另一 root)完全不在 sMain 账内
  assert.equal(main.diagnostics.accounting.buckets.subagent.requests, 1);
  assert.equal(main.diagnostics.accounting.buckets.unclassified.requests, 2); // x1 + w0(w9 被其他 root 的 actor 链证明归属)
  // sOther:main=o1、workflow=w9、歧义=amb1+wamb+m18
  const o = other.diagnostics.accounting;
  assert.deepEqual(
    { observed: o.observedUsage.requests, workflow: o.buckets.workflow.requests, ambiguous: o.ambiguousCandidates.requests },
    { observed: fx.expected.otherRoot.observed.requests, workflow: fx.expected.otherRoot.workflow.requests, ambiguous: fx.expected.otherRoot.ambiguous.requests });
  assert.equal(o.buckets.workflow.input, fx.expected.otherRoot.workflow.input);
});

test("A04: dwf 缺表 → workflow 能力 unavailable,行入 unclassified 不补 0,基础正常", async () => {
  const dir = tmpDir();
  const fx = buildDiagnosticsFixture(dir);
  const r = await detailed(fx.dbPathNoDwf, fx.root);
  const d = r.diagnostics;
  assert.equal(d.workflow.status, "unavailable");
  assert.equal(d.workflow.reasonCode, "schema-missing");
  const acc = d.accounting;
  assert.deepEqual(
    { requests: acc.buckets.unclassified.requests, input: acc.buckets.unclassified.input, output: acc.buckets.unclassified.output },
    fx.expected.noDwf.unclassified);
  assert.equal(acc.ambiguousCandidates.requests, fx.expected.noDwf.ambiguous.requests);
  assert.equal(acc.buckets.workflow.requests, 0);
  // 守恒仍成立
  const sum = Object.values(acc.buckets).reduce((a, b) => a + b.requests, 0);
  assert.equal(acc.observedUsage.requests, sum);
  // 基础查询不受影响(与全表变体一致)
  const full = await detailed(fx.dbPath, fx.root);
  assert.deepEqual(
    { i: full.usage?.input, o: full.usage?.output, s: full.session?.total },
    { i: r.usage?.input, o: r.usage?.output, s: r.session?.total });
  // unknown source → unclassified(spec §4.2:unknown source 会话归属明确仍入 unclassified)
  assert.ok(acc.buckets.unclassified.requests >= 2);
});

test("R01: 失败已记录用量计入一次;成功与失败同集合,不叠加『额外成本』", async () => {
  const dir = tmpDir();
  const fx = buildDiagnosticsFixture(dir);
  const r = await detailed(fx.dbPath, fx.root);
  const d = r.diagnostics;
  const rel = d.reliability;
  assert.equal(rel.status, "ok");
  const sc = Object.fromEntries(rel.data.statusCounts.map((s) => [s.status, s.requests]));
  assert.deepEqual(
    { completed: sc.completed ?? 0, error: sc.error ?? 0, cancelled: sc.cancelled ?? 0 },
    fx.expected.statusCounts);
  const f = rel.data.failedRecordedUsage;
  assert.deepEqual({ requests: f.requests, input: f.input, output: f.output, total: f.total }, fx.expected.failedRecordedUsage);
  // observedUsage = completed 行已记录 + 失败已记录(一次)
  const completed = rel.data.statusCounts.filter((s) => s.status === "completed").reduce((a, s) => a + s.total, 0);
  assert.equal(d.accounting.observedUsage.total, completed + f.total);
  // R01 原始数字:同会话 error(20+5)与 success(30+10)都在 main 桶;
  // 兼容口径(0.5.5 completed 主用量,不含子代理)= 902 ≠ 诊断 observed 1198
  const { query } = await import("../plugins/zcode-tps/scripts/token-rate.mjs");
  const base = query(fx.root, { dbPath: fx.dbPath, includeSubagents: false });
  assert.equal(base.usage.input + base.usage.output, fx.expected.compat.total);
  assert.equal(base.session.requests, fx.expected.compat.requests);
  assert.notEqual(base.usage.input + base.usage.output, d.accounting.observedUsage.total);
});

test("R02/R03: 逻辑请求与尝试 —— error→success 两有效尝试;reported 摘要单列;坏组不产出准确指标", async () => {
  const dir = tmpDir();
  const fx = buildDiagnosticsFixture(dir);
  const r = await detailed(fx.dbPath, fx.root);
  const retry = r.diagnostics.reliability.data.retry;
  assert.equal(retry.status, "ok");
  assert.deepEqual(
    { rows: retry.reported.rowsWithRetryCount, max: retry.reported.maxRetryCountObserved, invalid: retry.reported.invalidValues },
    { rows: fx.expected.retry.rowsWithRetryCount, max: fx.expected.retry.maxRetryCountObserved, invalid: 0 });
  const a = retry.attempts;
  assert.deepEqual(
    { attemptRows: a.attemptRows, grouped: a.groupedAttemptRows, ungrouped: a.ungroupedAttemptRows,
      logical: a.logicalRequestsObserved, retried: a.retriedLogicalRequestsObserved, additional: a.additionalAttemptsObserved,
      flagged: a.groupQuality.flaggedGroups },
    { attemptRows: fx.expected.retry.attemptRows, grouped: fx.expected.retry.groupedAttemptRows, ungrouped: fx.expected.retry.ungroupedAttemptRows,
      logical: fx.expected.retry.logicalRequestsObserved, retried: fx.expected.retry.retriedLogicalRequestsObserved, additional: fx.expected.retry.additionalAttemptsObserved,
      flagged: fx.expected.retry.flaggedGroups });
  // token 不因坏组被删:observedUsage 与 R01 相同
  assert.equal(r.diagnostics.accounting.observedUsage.requests, fx.expected.observed.requests);
});

test("T01/T02: TTFT 来源与质量计数;非法显式值不偷偷回退;provider 不合并;零样本组不出现", async () => {
  const dir = tmpDir();
  const fx = buildDiagnosticsFixture(dir);
  const r = await detailed(fx.dbPath, fx.root);
  const t = r.diagnostics.timing;
  assert.equal(t.status, "ok");
  const want = fx.expected.timing;
  assert.deepEqual(
    { candidates: t.data.candidates, direct: t.data.ttft.direct, derived: t.data.ttft.derived,
      invalid: t.data.ttft.invalid, missing: t.data.ttft.missing, samples: t.data.ttft.validSamples },
    { candidates: want.candidates, direct: want.direct, derived: want.derived, invalid: want.invalid, missing: want.missing, samples: want.validSamples });
  assert.equal(t.data.ttft.mean, want.mean);
  assert.equal(t.data.ttft.median, want.median);
  assert.equal(t.data.ttft.p90, want.p90);
  assert.deepEqual({ samples: t.data.decode.validSamples, num: t.data.decode.numeratorOutputTokens, den: t.data.decode.denominatorDecodeMs },
    { samples: want.decode.samples, num: want.decode.numerator, den: want.decode.denominator });
  const groups = Object.fromEntries(t.data.byModel.ttft.groups.map((g) => [`${g.provider}|${g.model}`, g]));
  for (const [key, w] of Object.entries(want.ttftGroups)) {
    const g = groups[key];
    assert.ok(g, `分组 ${key} 存在(不跨 provider 合并)`);
    assert.deepEqual({ n: g.samples, mean: g.mean, median: g.median, p90: g.p90 }, { n: w.n, mean: w.mean, median: w.median, p90: w.p90 });
  }
  assert.equal(t.data.byModel.ttft.groups.length, Object.keys(want.ttftGroups).length, "无效样本的组不出现(零样本 → 无组)");
  const dg = Object.fromEntries(t.data.byModel.decode.groups.map((g) => [`${g.provider}|${g.model}`, g]));
  for (const [key, w] of Object.entries(want.decodeGroups)) {
    assert.equal(dg[key]?.samples, w.n, `decode 分组 ${key}`);
    assert.equal(dg[key]?.mean, w.mean, `decode 分组均值 ${key}`);
  }
});

test("U01: turn_usage 同快照对账 —— matched/different/missing/backfill 后重查", async () => {
  const dir = tmpDir();
  // matched
  {
    const file = path.join(dir, "u-matched.sqlite");
    const { rows, tu } = turnUsageScenario("matched");
    const db = createDb(file); insertRowsHelper(db, rows);
    db.prepare(`INSERT INTO turn_usage (session_id,turn_id,trace_id,status,completed_at,duration_ms,model_request_count,input_tokens,output_tokens,reasoning_tokens,cache_creation_input_tokens,cache_read_input_tokens,computed_total_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("sess-u", "tU1", "tr-u", "completed", Date.now() + 5000, 1000, 1, 50, 25, 0, 0, 40, 75);
    db.close();
    const r = await detailed(file, "sess-u");
    const rec = r.diagnostics.reconciliation;
    assert.equal(rec.status, "ok");
    assert.equal(rec.data.result, "matched");
    assert.equal(rec.data.turnId, "tU1");
    assert.ok(rec.data.comparedFields.length >= 6);
    assert.ok(rec.data.comparedFields.every((f) => f.delta === 0));
  }
  // different:delta = model_usage − turn_usage,方向明确
  {
    const file = path.join(dir, "u-diff.sqlite");
    const { rows } = turnUsageScenario("different");
    const db = createDb(file); insertRowsHelper(db, rows);
    db.prepare(`INSERT INTO turn_usage (session_id,turn_id,status,completed_at,duration_ms,model_request_count,input_tokens,output_tokens,reasoning_tokens,cache_creation_input_tokens,cache_read_input_tokens,computed_total_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("sess-u", "tU1", "completed", Date.now() + 5000, 1000, 1, 50, 30, 0, 0, 40, 80);
    db.close();
    const r = await detailed(file, "sess-u");
    const rec = r.diagnostics.reconciliation;
    assert.equal(rec.data.result, "different");
    const outField = rec.data.comparedFields.find((f) => f.field === "output_tokens");
    assert.equal(outField.delta, -5); // 25 − 30
    assert.match(outField.note, /可能尚未回填/);
  }
  // missing → 回填后重查变 matched(不缓存错误结论)
  {
    const file = path.join(dir, "u-backfill.sqlite");
    const { rows } = turnUsageScenario("missing");
    const db = createDb(file); insertRowsHelper(db, rows); db.close();
    const r1 = await detailed(file, "sess-u");
    assert.equal(r1.diagnostics.reconciliation.data.result, "missing-aggregate");
    const { DatabaseSync } = await import("node:sqlite");
    const db2 = new DatabaseSync(file);
    db2.prepare(`INSERT INTO turn_usage (session_id,turn_id,status,completed_at,duration_ms,model_request_count,input_tokens,output_tokens,reasoning_tokens,cache_creation_input_tokens,cache_read_input_tokens,computed_total_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("sess-u", "tU1", "completed", Date.now() + 5000, 1000, 1, 50, 25, 0, 0, 40, 75);
    db2.close();
    const r2 = await detailed(file, "sess-u");
    assert.equal(r2.diagnostics.reconciliation.data.result, "matched");
  }
  // 主夹具:最新轮 matched
  {
    const fx = buildDiagnosticsFixture(dir);
    const r = await detailed(fx.dbPath, fx.root);
    assert.equal(r.diagnostics.reconciliation.data.result, fx.expected.recon.result);
  }
});

test("U02: turn_usage 缺表 → unavailable(schema-missing);非法整数值 → invalid,不强行比较", async () => {
  const dir = tmpDir();
  const fx = buildDiagnosticsFixture(dir);
  const noTu = await detailed(fx.dbPathNoTu, fx.root);
  assert.equal(noTu.diagnostics.reconciliation.status, "unavailable");
  assert.equal(noTu.diagnostics.reconciliation.reasonCode, "schema-missing");
  assert.equal(noTu.diagnostics.capabilities.turnUsageReconciliation.status, "unavailable");
  // 基础健康不受缺表影响
  assert.equal(noTu.diagnostics.status, "partial");
  assert.ok(noTu.usage !== undefined);
  // 非法值
  const file = path.join(dir, "u-invalid.sqlite");
  const { rows } = turnUsageScenario("invalid");
  const db = createDb(file); insertRowsHelper(db, rows);
  db.prepare(`INSERT INTO turn_usage (session_id,turn_id,status,completed_at,duration_ms,model_request_count,input_tokens,output_tokens,computed_total_tokens) VALUES (?,?,?,?,?,?,?,?,?)`).run("sess-u", "tU1", "completed", Date.now() + 5000, 1000, 1, "oops", 25, 75);
  db.close();
  const r = await detailed(file, "sess-u");
  const rec = r.diagnostics.reconciliation;
  assert.equal(rec.data.result, "invalid");
  assert.ok(rec.data.comparedFields.find((f) => f.field === "input_tokens").note.includes("非整数"));
});

test("B01: 持续库锁 → 预算内退出错误结构;API 注入 deadline → 模块 timeout 不出半个桶", async () => {
  const dir = tmpDir();
  const fx = buildDiagnosticsFixture(dir);
  // 库锁:另一个连接持 BEGIN EXCLUSIVE(delete 日志模式下会阻塞读取)
  const { DatabaseSync } = await import("node:sqlite");
  const locker = new DatabaseSync(fx.dbPath);
  locker.exec("BEGIN EXCLUSIVE");
  const locked = await runCli(["--json", "--session", fx.root, "--details"], {
    env: { ZCODE_USAGE_DB: fx.dbPath, ZCODE_TPS_DETAILS_BUDGET_MS: "800" }, timeoutMs: 15000,
  });
  assert.equal(locked.code, 1);
  assert.ok(locked.json?.error, "锁定时返回错误结构");
  assert.ok(locked.elapsed < 5000, `预算内退出(实际 ${locked.elapsed}ms)`);
  try { locker.exec("ROLLBACK"); } catch {}
  locker.close();
  // 正常库 + 足够预算 → 完整报表
  const ok = await runCli(["--json", "--session", fx.root, "--details"], {
    env: { ZCODE_USAGE_DB: fx.dbPath, ZCODE_TPS_DETAILS_BUDGET_MS: "30000" }, timeoutMs: 40000,
  });
  assert.equal(ok.code, 0);
  assert.equal(ok.json?.diagnostics?.status, "ok");
  // 模块超时:deadline 注入(确定性),workflow 立即完成,reliability 阻塞超预算
  const r = await detailed(fx.dbPath, fx.root, {
    deadline: Date.now() + 400,
    moduleGate: async (name) => { if (name === "reliability") await sleep(700); },
    modules: ["workflow", "reliability"],
  });
  assert.equal(r.diagnostics.workflow.status, "ok");
  assert.equal(r.diagnostics.reliability.status, "error");
  assert.equal(r.diagnostics.reliability.reasonCode, "timeout");
  assert.equal(r.diagnostics.reliability.data, null);
  assert.equal(r.diagnostics.status, "partial");
});

test("B02: 高基数有界;非法标识符安全;BOM 配置;输出机器可解析", async () => {
  const dir = tmpDir();
  const fx = buildDiagnosticsFixture(dir);
  const r = await detailed(fx.dbPathHc, "sess-hc");
  const t = r.diagnostics.timing;
  assert.equal(t.data.byModel.ttft.groups.length, fx.expected.hc.ttftGroups);
  assert.equal(t.data.byModel.ttft.other.groups, fx.expected.hc.ttftOther);
  const rel = r.diagnostics.reliability;
  assert.equal(rel.data.errorTypes.values.length, fx.expected.hc.errorTypes);
  // 高基数下基础与账本仍守恒
  assert.equal(r.diagnostics.accounting.observedUsage.requests, 72);
  // 非法标识符:绑定参数 + 引用标识符,不注入、不抛错(全模块请求以覆盖 accounting)
  const cli = await runCli(["--json", "--session", "sess'; --", "--details"], {
    env: { ZCODE_USAGE_DB: fx.dbPath, ZCODE_TPS_DETAILS_BUDGET_MS: "30000" }, timeoutMs: 40000,
  });
  assert.equal(cli.code, 0);
  assert.equal(cli.json?.diagnostics?.accounting?.observedUsage?.requests, 0, "未知会话确认无行 → 真实 0");
  // BOM 配置可解析;无值/未知 details 模块 → 结构化参数错误
  const cfgFile = path.join(dir, "cfg.json");
  fs.writeFileSync(cfgFile, "\uFEFF" + JSON.stringify({ rateLineFields: ["rates"] }));
  const bom = await runCli(["--json", "--session", fx.root], {
    env: { ZCODE_USAGE_DB: fx.dbPath, ZCODE_TPS_CONFIG: cfgFile }, timeoutMs: 30000,
  });
  assert.equal(bom.code, 0);
  assert.ok(bom.json?.session);
  const bad = await runCli(["--json", "--session", fx.root, "--details", "bogus"], {
    env: { ZCODE_USAGE_DB: fx.dbPath }, timeoutMs: 30000,
  });
  assert.equal(bad.code, 1);
  assert.ok(bad.json?.parameterError);
  const empty = await runCli(["--json", "--session", fx.root, "--details", ""], {
    env: { ZCODE_USAGE_DB: fx.dbPath }, timeoutMs: 30000,
  });
  assert.equal(empty.code, 1);
  const noJson = await runCli(["--session", fx.root, "--details"], {
    env: { ZCODE_USAGE_DB: fx.dbPath }, timeoutMs: 30000,
  });
  assert.equal(noJson.code, 1);
});

test("C01/C02(诊断侧): 默认行为不变 —— includeSubagents 只影响兼容范围;老字段语义不变", async () => {
  const dir = tmpDir();
  const fx = buildDiagnosticsFixture(dir);
  const { query } = await import("../plugins/zcode-tps/scripts/token-rate.mjs");
  const withSub = query(fx.root, { dbPath: fx.dbPath, includeSubagents: true });
  const noSub = query(fx.root, { dbPath: fx.dbPath, includeSubagents: false });
  // 兼容口径:completed main_turn
  assert.deepEqual({ requests: noSub.usage.input + noSub.usage.output, input: noSub.usage.input, output: noSub.usage.output },
    { requests: fx.expected.compat.total, input: fx.expected.compat.input, output: fx.expected.compat.output });
  // 子代理并入只影响 session(兼容范围),usage 仍是主对话
  assert.equal(withSub.session.includesSubagents, true);
  assert.equal(withSub.usage.total, noSub.usage.total);
  // 0.5.5 兼容 trace 归因不含多 root 过滤:sub1(100)+amb1(10) 都并入(tr-amb 命中 m18);
  // 多 root 歧义剔除是 0.6.0 诊断账本的新行为,A03 已单独验证 —— 兼容行为必须保持不变
  assert.equal(withSub.session.total, fx.expected.compat.total + 110);
  // 诊断范围与兼容范围分别注明(spec §4.1)
  const r = await detailed(fx.dbPath, fx.root);
  assert.match(r.diagnostics.scope.note, /兼容范围/);
  assert.match(r.diagnostics.accounting.scope.note, /session\.total/);
  // currentPrompt 能力:默认关闭且 unsupported(spec §10.3)
  assert.equal(r.diagnostics.capabilities.currentPrompt.status, "unavailable");
  assert.equal(r.diagnostics.capabilities.currentPrompt.reasonCode, "contract-unverified");
});

function simpleFixture(rows, setup = () => {}) {
  const file = path.join(tmpDir(), "probe.sqlite");
  const db = createDb(file);
  insertRowsHelper(db, rows);
  setup(db);
  db.close();
  return file;
}
const rootRow = (extra = {}) => row({ session_id: "S", turn_id: "T", trace_id: "trace-S", input_tokens: 10, output_tokens: 2, time_to_first_token_ms: 100, ...extra });
const claim = (db, run, parent, session) => {
  db.prepare("INSERT INTO dwf_run(id,parent_session_id,time_created) VALUES(?,?,?)").run(run, parent, 1);
  db.prepare("INSERT INTO dwf_actor(run_id,session_id) VALUES(?,?)").run(run, session);
};

test("D01: NULL/空白/未知来源完整覆盖;所有非主来源双 root claim 均排除", async () => {
  const rows = [rootRow(), ...[null, "  ", "future_source"].map((source) => ({ ...rootRow(), query_source: source }))];
  for (const source of ["subagent", "compact", "future_source", "workflow_child"]) {
    rows.push(rootRow({ session_id: "CH", query_source: source }));
  }
  const file = simpleFixture(rows, (db) => { claim(db, "r-S", "S", "CH"); claim(db, "r-X", "X", "CH"); });
  const d = (await detailed(file, "S")).diagnostics;
  assert.equal(d.accounting.observedUsage.requests, 4);
  assert.equal(d.accounting.buckets.unclassified.requests, 3);
  assert.equal(d.accounting.ambiguousCandidates.requests, 4);
  assert.deepEqual(d.accounting.coverage, { candidateRows: 8, observedRows: 4, ambiguousRows: 4, foreignRows: 0, complete: true });
  const nullSession = simpleFixture([rootRow(), rootRow({ session_id: "OTHER" }),
    { ...rootRow(), session_id: null, query_source: null }]);
  const nd = (await detailed(nullSession, "S")).diagnostics.accounting;
  assert.equal(nd.observedUsage.requests, 1);
  assert.equal(nd.ambiguousCandidates.requests, 2);
});

test("D02: 可选字段逐项缺失/无唯一行 ID/NULL ID,能力诚实降级", async () => {
  for (const column of ["trace_id", "cache_creation_input_tokens", "provider_id", "retry_count", "logical_request_id", "attempt_index", "retryable", "error_type"]) {
    const file = simpleFixture([rootRow()], (db) => {
      if (column === "trace_id") db.exec("DROP INDEX model_usage_trace_idx");
      db.exec("ALTER TABLE model_usage DROP COLUMN " + column);
    });
    const d = (await detailed(file, "S")).diagnostics;
    assert.ok(d.accounting, column + ": 不丢基础账本");
    for (const n of ["workflow", "reliability", "timing", "reconciliation"]) assert.notEqual(d[n].reasonCode, "timeout", column);
    if (column === "cache_creation_input_tokens") {
      assert.equal(d.accounting.observedUsage.tokensComplete, false);
      assert.equal(d.accounting.buckets.main.quality.fields.cacheCreation.missingRows, 1);
    }
    if (column === "logical_request_id") {
      assert.equal(d.reliability.data.retry.reported.rowsWithRetryCount, 0);
      assert.equal(d.reliability.data.retry.attempts.status, "unavailable");
    }
    if (column === "provider_id") {
      assert.equal(d.timing.status, "partial");
      assert.equal(d.timing.data.byModel.ttft.groups.length, 1);
      assert.equal(d.timing.data.byModel.ttft.groups[0].provider, "(unknown)");
    }
    if (column === "retry_count") assert.equal(d.reliability.data.retry.reported.rowsWithRetryCount, null);
    if (column === "retryable") assert.equal(d.reliability.data.overlappingFlags.retryable, null);
  }
  for (const noId of [false, true]) {
    const file = simpleFixture([rootRow()], (db) => {
      const cols = db.prepare("PRAGMA table_info(model_usage)").all().map((c) => c.name).filter((c) => !noId || c !== "id");
      db.exec("CREATE TABLE mu_copy AS SELECT " + cols.join(",") + " FROM model_usage; DROP TABLE model_usage; ALTER TABLE mu_copy RENAME TO model_usage");
    });
    const d = (await detailed(file, "S")).diagnostics;
    assert.equal(d.capabilities.rowIdentity.status, "unavailable");
    assert.equal(d.accounting, null);
    assert.equal(d.workflow.reasonCode, "schema-missing");
    assert.equal(d.timing.status, "ok");
  }
  const file = simpleFixture([{ ...rootRow(), id: null }]);
  const d = (await detailed(file, "S")).diagnostics;
  assert.equal(d.accountingError.reasonCode, "invalid-data");
  assert.equal(d.timing.status, "ok");
  const minimalRun = simpleFixture([rootRow()], (db) => {
    claim(db, "unused", "S", "CH");
    for (const col of ["status", "spent_tokens", "time_created", "time_updated"]) db.exec("ALTER TABLE dwf_run DROP COLUMN " + col);
  });
  const w = (await detailed(minimalRun, "S")).diagnostics.workflow;
  assert.equal(w.status, "partial");
  assert.equal(w.data.runs[0].reportedSpentTokens, null);
});

test("D03: 局部异常不影响后续模块;CLI 无会话终态不伪装 timeout", async () => {
  const file = simpleFixture([rootRow()]);
  const { queryDetailed } = await import("../plugins/zcode-tps/scripts/diagnostics.mjs");
  const r = await queryDetailed("S", { dbPath: file, moduleGate: (n) => {
    if (n === "workflow") throw new Error("independent injected SQL failure");
  } });
  assert.equal(r.diagnostics.workflow.reasonCode, "query-error");
  assert.match(r.diagnostics.workflow.warnings[0], /independent injected/);
  assert.equal(r.diagnostics.reliability.status, "ok");
  assert.equal(r.diagnostics.timing.status, "ok");
  const empty = simpleFixture([]);
  const cli = await runCli(["--json", "--details"], { env: { ZCODE_USAGE_DB: empty, ZCODE_SESSION_ID: "", CLAUDE_SESSION_ID: "",
    ZCODE_TPS_LAST_SESSION: path.join(tmpDir(), "absent.json") } });
  assert.equal(cli.code, 0);
  assert.equal(cli.json.diagnostics.status, "unavailable");
  for (const n of ["workflow", "reliability", "timing", "reconciliation"]) assert.equal(cli.json.diagnostics[n].reasonCode, "no-session");
});

test("D04: 源行非法/缺失、负数、超安全整数及空比较集合不得 matched", async () => {
  for (const value of ["bad", null, -1]) {
    const file = simpleFixture([{ ...rootRow(), input_tokens: value }], (db) =>
      db.prepare("INSERT INTO turn_usage(session_id,turn_id,model_request_count,input_tokens,output_tokens) VALUES('S','T',1,0,2)").run());
    const rec = (await detailed(file, "S")).diagnostics.reconciliation;
    assert.notEqual(rec.data.result, "matched");
    assert.ok(rec.data.comparedFields.every((f) => f.field !== "input_tokens" || f.delta === null));
  }
  const file = simpleFixture([rootRow()], (db) => db.prepare("INSERT INTO turn_usage(session_id,turn_id) VALUES('S','T')").run());
  const rec = (await detailed(file, "S")).diagnostics.reconciliation;
  assert.equal(rec.data.result, "incomplete");
  assert.equal(rec.data.comparedFields.length, 0);
  const unsafe = simpleFixture([{ ...rootRow(), input_tokens: 9007199254740992 }]);
  await assert.rejects(detailed(unsafe, "S"), /too large/); // node:sqlite 在基础读取即拒绝不安全整数,不产出 matched。
  const unsafeTu = simpleFixture([rootRow()], (db) => db.prepare(
    "INSERT INTO turn_usage(session_id,turn_id,model_request_count,input_tokens,output_tokens) VALUES('S','T',1,9007199254740992,2)").run());
  const unsafeRec = (await detailed(unsafeTu, "S")).diagnostics.reconciliation;
  assert.equal(unsafeRec.reasonCode, "query-error");
  assert.equal(unsafeRec.data, null);
});

test("D05: 跨 session/provider 的相同 logical ID 不产生准确重试;行用量仍保留", async () => {
  const file = simpleFixture([rootRow({ logical_request_id: "L", attempt_index: 0 }),
    rootRow({ session_id: "CH", query_source: "subagent", provider_id: "other", logical_request_id: "L", attempt_index: 1 })]);
  const d = (await detailed(file, "S")).diagnostics;
  const a = d.reliability.data.retry.attempts;
  assert.equal(a.retriedLogicalRequestsObserved, 0);
  assert.equal(a.additionalAttemptsObserved, 0);
  assert.equal(a.groupQuality.flaggedGroups, 1);
  assert.equal(a.groupQuality.multiSessionGroups, 1);
  assert.equal(a.groupQuality.multiProviderGroups, 1);
  assert.equal(d.accounting.observedUsage.requests, 2);
  assert.equal(d.reliability.data.retry.status, "partial");
});

test("D06: 同 root 多 run claim 总量唯一,歧义行不分配;截断 run 不截断总量", async () => {
  const file = simpleFixture([rootRow(), rootRow({ session_id: "WF", query_source: "workflow_child" })], (db) => {
    claim(db, "A", "S", "WF"); claim(db, "B", "S", "WF");
  });
  const d = (await detailed(file, "S")).diagnostics;
  assert.equal(d.workflow.status, "partial");
  assert.equal(d.workflow.data.totals.requests, 1);
  assert.equal(d.workflow.data.totals.total, 12);
  assert.equal(d.workflow.data.unallocated.requests, 1);
  assert.ok(d.workflow.data.runs.every((r) => r.requests === 0));
  assert.equal(d.workflow.data.totals.conservationOk, true);
  const rows = [rootRow(), ...Array.from({ length: 51 }, (_, i) => rootRow({ session_id: "WF" + i, query_source: "workflow_child" }))];
  const many = simpleFixture(rows, (db) => { for (let i = 0; i < 51; i++) claim(db, "run" + i, "S", "WF" + i); });
  const w = (await detailed(many, "S")).diagnostics.workflow.data;
  assert.equal(w.runs.length, 50);
  assert.equal(w.totals.requests, 51);
  assert.equal(w.omittedRunsUsage.requests, 1);
  assert.equal(w.totals.conservationOk, true);
});

test("D07: current/prompt-key/未知 flag/含等号 details 一律结构化拒绝", async () => {
  for (const args of [["--current"], ["--prompt-key", "missing"], ["--details", "workflow=invalid"], ["--wat"], ["--session", "S", "--session", "S"]]) {
    const result = await runCli(["--json", ...args], { env: { ZCODE_USAGE_DB: path.join(tmpDir(), "absent.sqlite") } });
    assert.equal(result.code, 1);
    assert.ok(result.json.parameterError);
    assert.equal(result.json.session, undefined);
  }
});

test("D08: 采样工具所有关联 ID 脱敏,跨表同值同别名,内容列不读取", async () => {
  const dir = tmpDir(), evidence = path.join(dir, "evidence.json");
  const secret = "PRIVATE_IDENTIFIER_D08";
  const file = simpleFixture([rootRow({ id: secret, session_id: secret, turn_id: secret, trace_id: secret, provider_id: secret, model_id: secret })], (db) => {
    db.prepare("INSERT INTO turn_usage(session_id,turn_id,trace_id,user_message_id) VALUES(?,?,?,?)").run(secret, secret, secret, secret);
    db.prepare("INSERT INTO dwf_run(id,parent_session_id,tool_call_id,resumed_from,script_text) VALUES(?,?,?,?,?)").run(secret, secret, secret, secret, "PRIVATE_CONTENT_D08");
    db.prepare("INSERT INTO dwf_actor(run_id,session_id,site_id) VALUES(?,?,?)").run(secret, secret, secret);
    db.prepare("UPDATE model_usage SET span_id=?,assistant_message_id=?,error_message=?").run(secret, secret, "PRIVATE_CONTENT_D08");
  });
  const tool = path.join(HERE, "..", "tools", "data-contract-sample.mjs");
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [tool, "--out", evidence, "--sample", "3", "--window", "10"],
      { env: { ...process.env, ZCODE_USAGE_DB: file }, windowsHide: true, stdio: "ignore" });
    child.on("error", (e) => resolve({ error: e }));
    child.on("close", (code) => resolve({ code }));
  });
  assert.equal(result.code, 0);
  const raw = fs.readFileSync(evidence, "utf8");
  assert.ok(!raw.includes(secret));
  assert.ok(!raw.includes("PRIVATE_CONTENT_D08"));
  const e = JSON.parse(raw);
  assert.equal(e.turnUsage.samples[0].session_id, e.turnUsage.samples[0].trace_id);
  assert.equal(e.dwfTables.dwf_run.samples[0].id, e.turnUsage.samples[0].session_id);
  assert.equal(e.turnUsage.samples[0].model_request_count, null, "计数不能被误当 ID 哈希");
});

test("P3: 未映射/进行中用量保留在账本,不冒充失败", async () => {
  const file = simpleFixture([rootRow(), { ...rootRow(), status: "running", completed_at: null, input_tokens: 100, output_tokens: 20 }]);
  const d = (await detailed(file, "S")).diagnostics;
  assert.equal(d.reliability.data.failedRecordedUsage.requests, 0);
  assert.equal(d.reliability.data.nonFinalOrUnmappedUsage[0].total, 120);
  assert.equal(d.reliability.data.unterminatedRows.requests, 1);
  assert.equal(d.accounting.observedUsage.requests, 2);
});
