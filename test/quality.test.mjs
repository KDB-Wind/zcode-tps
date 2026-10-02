// 0.5.5 可信度修复回归(F01–F10,docs/GPT审核报告-20260930.md):
// F01 部分索引误选 / F02 健康记录跨 hook 覆盖 / F03 Stop 异常无终态 / F04 macOS 通知转义 /
// F05 未提交先记成功 / F06 单槽水位 / F07 TTFT 校验 / F08 超范围日期 / F09 空白 turn_id / F10 token 类型校验。
// 运行:node --test test/quality.test.mjs(需要 Node >= 22.13,零第三方依赖)

import assert from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL, fileURLToPath } from "node:url";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-tps-quality-"));
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(root, "plugins", "zcode-tps", "scripts", "token-rate.mjs");
const RUNTIME = path.join(root, "plugins", "zcode-tps", "scripts", "runtime.mjs");
const STOP = path.join(root, "plugins", "zcode-tps", "hooks", "stop.mjs");
const DOCTOR = path.join(root, "plugins", "zcode-tps", "scripts", "doctor.mjs");
process.env.ZCODE_TPS_CONFIG = path.join(tmp, "config.json");
process.env.ZCODE_TPS_LAST_SESSION = path.join(tmp, "last-session.json");
process.env.ZCODE_TPS_HEALTH = path.join(tmp, "health.json");

const DDL = `CREATE TABLE model_usage (
  turn_id TEXT, session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
  output_tokens, reasoning_tokens, input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
  trace_id TEXT, started_at INTEGER, first_token_at INTEGER,
  completed_at, duration_ms, time_to_first_token_ms)`;

// 原始插入:不依赖列类型声明,DDL 中 token/时间列故意不带类型(动态类型可写文本/超大数)
function insert(db, {
  t0 = 1_000_000, out = 100, reasoning = 0, ttft = 100, dur = 1000, completedAt,
  input = 800, cacheRead = 700, turnId = "turn_q", qs = "main_turn", sess = "sq",
  status = "completed", trace = null, sid,
} = {}) {
  db.prepare(`INSERT INTO model_usage (
      turn_id,session_id,status,query_source,model_id,output_tokens,reasoning_tokens,
      input_tokens,cache_read_input_tokens,cache_creation_input_tokens,trace_id,started_at,first_token_at,
      completed_at,duration_ms,time_to_first_token_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(turnId, sid ?? sess, status, qs, "m", out, reasoning, input, cacheRead, 0, trace,
         t0, ttft == null ? null : t0 + ttft,
         completedAt !== undefined ? completedAt : t0 + dur, dur, ttft);
}

function makeDb(name) {
  const dbPath = path.join(tmp, name);
  const db = new DatabaseSync(dbPath);
  db.exec(DDL);
  return { db, dbPath };
}

async function loadWith(dbPath) {
  process.env.ZCODE_USAGE_DB = dbPath;
  return import(pathToFileURL(SCRIPT).href + "?q=" + Math.random());
}

// ================= F01:强制索引只选普通索引,部分索引不再令查询失败 =================
{
  const { db, dbPath } = makeDb("partial-index.sqlite");
  insert(db, { trace: "T1" });
  insert(db, { t0: 2_000_000, out: 50, qs: "session_title", input: 200, cacheRead: 0, trace: "TA" });
  // 部分索引:可覆盖主请求,却覆盖不了 auxiliary 的"排除 main_turn"条件 —— 旧实现 INDEXED BY 会 no query solution
  db.exec(`CREATE INDEX partial_main ON model_usage(session_id, query_source, status, completed_at)
             WHERE query_source = 'main_turn'`);
  db.close();

  const { query, pickSessionIndex } = await loadWith(dbPath);
  assert.equal(pickSessionIndex(new DatabaseSync(dbPath, { readOnly: true })), null,
    "仅有部分索引时不得强制使用");
  const r = query("sq");
  assert.equal(r.session.requests, 1);
  assert.equal(r.usage.total, 900);
  assert.equal(r.auxiliary.requests, 1, "辅助查询同样不得被部分索引拖垮");
  assert.ok(!r.warnings.some((w) => /no query solution|索引强制/.test(w)));
  new DatabaseSync(dbPath, { readOnly: true }).close();
}
{
  // 普通索引 + 更高评分部分索引并存:选普通索引,结果一致
  const { db, dbPath } = makeDb("mixed-index.sqlite");
  insert(db);
  db.exec(`CREATE INDEX plain_idx ON model_usage(session_id)`);
  db.exec(`CREATE INDEX partial_hi ON model_usage(session_id, status, query_source, completed_at)
             WHERE query_source = 'main_turn'`);
  db.close();
  const { query, pickSessionIndex } = await loadWith(dbPath);
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(pickSessionIndex(ro), "plain_idx", "部分索引即使评分更高也不得选中");
  ro.close();
  assert.equal(query("sq").usage.total, 900);
}
{
  // 无索引 / 特殊字符索引名(含双引号):标识符引用正确
  const { db, dbPath } = makeDb("quote-index.sqlite");
  insert(db);
  db.exec(`CREATE INDEX "we""ird-idx" ON model_usage(session_id, turn_id)`);
  db.close();
  const { query, pickSessionIndex, quoteIdent } = await loadWith(dbPath);
  assert.equal(quoteIdent('a"b'), '"a""b"', "标识符引用须转义内嵌双引号");
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(pickSessionIndex(ro), 'we"ird-idx');
  ro.close();
  assert.equal(query("sq").usage.total, 900, "特殊字符索引名下查询照常");
}

// ================= F07:TTFT 类型与物理范围校验(负数/文本/越界不得虚构解码窗口) =================
{
  const { db, dbPath } = makeDb("ttft-invalid.sqlite");
  insert(db, { t0: 1_000_000, out: 100, ttft: -1000, dur: 1000 });      // 负 TTFT:dec=dur+1000=2000 > dur
  insert(db, { t0: 2_000_000, out: 100, ttft: "bad", dur: 1000 });      // 文本 TTFT:SQL 算术会把文本当 0
  insert(db, { t0: 3_000_000, out: 100, ttft: 1000, dur: 1000 });       // ttft == dur:dec=0
  insert(db, { t0: 4_000_000, out: 100, ttft: 1200, dur: 1000 });       // ttft > dur
  insert(db, { t0: 5_000_000, out: 100, ttft: 0, dur: 1000 });          // ttft=0 合法,但 dec=1000≥200 → 参与
  db.close();
  const { query } = await loadWith(dbPath);
  const r = query("sq");
  assert.equal(r.session.samples, 5, "端到端样本不受 TTFT 坏值影响(范围不同,不应被踢出 e2e)");
  assert.equal(r.session.decodeSamples, 1, "仅 ttft=0 的行参与 Decode(其余 TTFT 物理非法)");
  assert.equal(r.session.decodeTps, 100);
  const byCompleted = Object.fromEntries(r.history.map((h) => [h.completedAt, h]));
  assert.equal(byCompleted[1_001_000].decodeTps, null, "负 TTFT 不得虚构 2s 解码窗口");
  assert.equal(byCompleted[1_001_000].ttftMs, null, "负 TTFT 不得显示为合法首字时长");
  assert.equal(byCompleted[2_001_000].decodeTps, null, "文本 TTFT 不得按 0 等待混入");
  assert.equal(byCompleted[3_001_000].decodeTps, null, "ttft == dur 解码窗口为 0");
  assert.equal(byCompleted[4_001_000].decodeTps, null, "ttft > dur 物理非法");
  assert.equal(byCompleted[5_001_000].decodeTps, 100, "ttft=0 合法且窗口达标,参与 Decode");
}
{
  // 文本 TTFT 行:history 与会话 Decode 一致排除;ttft 段不显示
  const { db, dbPath } = makeDb("ttft-text.sqlite");
  insert(db, { t0: 1_000_000, out: 100, ttft: 100, dur: 1000 });
  insert(db, { t0: 2_000_000, out: 100, ttft: "bad", dur: 1000 });
  db.close();
  const { query, formatLine } = await loadWith(dbPath);
  const r = query("sq");
  assert.equal(r.session.samples, 2);
  assert.equal(r.session.decodeSamples, 1, "文本 TTFT 不得按 0 等待混入 Decode");
  assert.equal(r.session.decodeTps, 111.1, "唯一解码窗口 900ms:100/0.9s");
  const bad = r.history[0];
  assert.equal(bad.completedAt, 2_001_000);
  assert.equal(bad.decodeTps, null);
  assert.equal(bad.ttftMs, null);
  assert.equal(r.history[1].ttftMs, 100, "合法 TTFT 行照常保留首字时长");
  assert.ok(!formatLine(r, ["ttft"]).includes("首字"), "latest 恰为坏 TTFT 行时 ttft 段静默跳过(可选段语义)");
}

// ================= F08:超出 Date 范围的完成时间不得拖垮整份报表 =================
{
  const { db, dbPath } = makeDb("invalid-date.sqlite");
  insert(db, { t0: 1_000_000, out: 100, ttft: 100, dur: 1000 });
  insert(db, { t0: 2_000_000, out: 100, ttft: 100, dur: 1000, completedAt: 8_640_000_000_000_001 });
  db.close();
  const { query, formatLine } = await loadWith(dbPath);
  const r = query("sq");
  assert.equal(r.session.requests, 2, "超范围日期行仍计入请求与用量");
  assert.equal(r.usage.total, 1800);
  assert.ok(r.warnings.some((w) => /完成时间非法/.test(w)), "坏日期必须告警可见");
  const bad = r.history[0];
  assert.equal(bad.completedAtText, null, "不可表示日期格式化为 null 而非抛 RangeError");
  assert.ok(!formatLine(r, ["time"]).includes("null"), "时间段不得渲染 '⏱ null'");
  assert.ok(formatLine(r).includes("⚡"), "报表其余部分照常");
}

// ================= F09:空白 turn_id 判为未知轮,不虚构轮次 =================
{
  const { db, dbPath } = makeDb("blank-turn.sqlite");
  insert(db, { turnId: " \t　", t0: 1_000_000 });   // ASCII 空白 + 全角空格
  db.close();
  const { query } = await loadWith(dbPath);
  const r = query("sq");
  assert.equal(r.turn, null, "纯空白 turn_id 不得成为已知轮");
  assert.equal(r.usage.turns, null, "轮次数未知");
  assert.equal(r.usage.knownTurns, 0);
  assert.equal(r.usage.unknownTurnRequests, 1);
  assert.equal(r.usage.total, 900, "累计照常保留");
}
{
  // 合法但带前后空格的 ID:保留原值,不 trim 合并成同一轮
  const { db, dbPath } = makeDb("spacey-turn.sqlite");
  insert(db, { turnId: "turn_a", t0: 1_000_000 });
  insert(db, { turnId: " turn_a", t0: 2_000_000 });
  db.close();
  const { query } = await loadWith(dbPath);
  const r = query("sq");
  assert.equal(r.usage.knownTurns, 2, "带空格的合法 ID 是不同轮次,不得合并");
  assert.equal(r.turn.turnId, " turn_a", "最新轮保留原始 ID(不 trim)");
}

// ================= F10:token 字段类型校验,JS 与 SQL 样本一致 =================
{
  const { db, dbPath } = makeDb("text-token.sqlite");
  insert(db, { t0: 1_000_000, out: 100, ttft: 100, dur: 1000 });            // 唯一有效样本
  insert(db, { t0: 2_000_000, out: "bad", ttft: 100, dur: 1000 });          // 文本 output
  insert(db, { t0: 3_000_000, out: -50, ttft: 100, dur: 1000 });            // 负 output
  insert(db, { t0: 4_000_000, out: 100, ttft: 100, dur: 1000, input: 100, cacheRead: 500 }); // cacheRead>input
  db.close();
  const { query } = await loadWith(dbPath);
  const r = query("sq");
  assert.equal(r.session.requests, 4, "坏 token 行仍是已完成请求,计数保留");
  assert.equal(r.session.samples, 2, "文本/负 output 不得进入速率样本(SQL 文本>0 恒真的旧缺陷已修)");
  assert.equal(r.session.avgTps, 100, "会话均不受坏值污染(旧实现会得 50)");
  assert.equal(r.turn.avgTps, 100, "最近轮均同样排除坏值");
  assert.equal(r.usage.input, 800 + 800 + 800 + 100, "input 均合法,照常累计");
  assert.equal(r.usage.output, 100 + 0 + 0 + 100, "文本/负 output 用量按 0 计(不虚构,不静默)");
  assert.ok(r.warnings.some((w) => /token 字段非合法数值/.test(w)), "坏 token 行必须告警");
  assert.ok(r.warnings.some((w) => /cache_read_input_tokens 大于/.test(w)), "cacheRead>input 必须告警");
  const bad = r.history.find((h) => h.completedAt === 2_001_000);
  assert.equal(bad.tokPerSec, null, "history 坏行的速率与 SQL 口径一致");
  assert.equal(bad.decodeTps, null);
}

// ================= Stop hook:F02 链路隔离 / F03 异常终态 / F05+R01 通知退出码 / F06+R02/R04 指纹与水位 / R03 全程预算 / stdin 限时限长 =================
{
  const dbPath = path.join(tmp, "stop-quality.sqlite");
  const { db } = makeDb("stop-quality.sqlite");
  insert(db, { sess: "sqa", trace: "TQA" });
  db.close();
  const cfgOn = path.join(tmp, "stop-on.json");
  fs.writeFileSync(cfgOn, JSON.stringify({ turnEndLine: true }));
  const cfgOff = path.join(tmp, "stop-off.json");
  fs.writeFileSync(cfgOff, JSON.stringify({}));
  const cfgBroken = path.join(tmp, "stop-broken.json");
  const shownFile = path.join(tmp, "quality-shown.json");
  process.env.ZCODE_TPS_LAST_SHOWN = shownFile; // 测试进程与 stop 子进程按同一路径解析水位文件
  const healthBase = process.env.ZCODE_TPS_HEALTH; // 与 readHealth 在同一进程 env 下解析,路径一致
  const promptHook = path.join(root, "plugins", "zcode-tps", "hooks", "prompt-submit.mjs");
  const { healthFile, shownSlotFile, HOOK_PROMPT, HOOK_STOP } = await import(pathToFileURL(RUNTIME).href + "?q-hook");
  const slotFile = (sid) => shownSlotFile(sid);
  const readSlot = (sid) => JSON.parse(fs.readFileSync(slotFile(sid), "utf8"));

  // 可控通知命令(R01):覆盖命令的参数恰为 ["zcode-tps", line],cwd 内放一个名为 zcode-tps 的
  // 脚本,以 ZCODE_TPS_NOTIFY_BIN=node 运行即执行它;QSLEEP/QEXIT 控制退出时机与退出码,
  // QCOUNT 把每次真实调用追加到计数文件(§12.3 并发去重断言"命令恰好执行一次")。
  fs.writeFileSync(path.join(tmp, "zcode-tps"),
    "const fs=require('fs');" +
    "const ms=Number(process.env.QSLEEP||0);const ec=Number(process.env.QEXIT||0);" +
    "const go=()=>{if(process.env.QCOUNT){try{fs.appendFileSync(process.env.QCOUNT,'1\\n')}catch{}}process.exit(ec)};" +
    "if(ms){setTimeout(go,ms)}else{go()}\n");

  const runHook = (hookFile, { cfg, sid = "sqa", db = dbPath, stdin = {}, extraEnv = {}, realNotify = false } = {}) => {
    const env = {
      ...process.env, ZCODE_USAGE_DB: db, ZCODE_SESSION_ID: sid, ZCODE_TPS_CONFIG: cfg,
      ZCODE_TPS_HEALTH: healthBase, ZCODE_TPS_LAST_SHOWN: shownFile,
      ZCODE_TPS_LAST_SESSION: path.join(tmp, "quality-last.json"),
      ZCODE_TPS_NOTIFY_SUPPRESS: "1", ...extraEnv,
    };
    if (realNotify) delete env.ZCODE_TPS_NOTIFY_SUPPRESS;
    return execFileSync(process.execPath, [hookFile], {
      env, cwd: tmp, input: JSON.stringify({ session_id: sid, ...stdin }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  };
  const runStop = (opts) => runHook(STOP, opts);
  const readHealth = (sid, hook) => JSON.parse(fs.readFileSync(healthFile(sid, hook), "utf8"));
  const doctorStopCheck = (sid) => {
    const out = execFileSync(process.execPath, [DOCTOR, "--json"], {
      env: { ...process.env, ZCODE_SESSION_ID: sid, ZCODE_TPS_HEALTH: healthBase,
        ZCODE_TPS_CONFIG: cfgOn, ZCODE_TPS_LAST_SESSION: path.join(tmp, "quality-last.json") },
      encoding: "utf8",
    });
    return JSON.parse(out).checks.find((c) => c.name === "通知链路(Stop)");
  };
  const spawnStop = (sid, { extraEnv = {}, hang = false } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STOP], {
      cwd: tmp,
      env: { ...process.env, ZCODE_USAGE_DB: dbPath, ZCODE_SESSION_ID: sid, ZCODE_TPS_CONFIG: cfgOn,
        ZCODE_TPS_HEALTH: healthBase, ZCODE_TPS_LAST_SHOWN: shownFile,
        ZCODE_TPS_LAST_SESSION: path.join(tmp, "quality-last.json"), ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {}); // 子进程限时销毁 stdin 后,父端残余写入报 EOF 属预期
    child.stderr.setEncoding("utf8");
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`stop exit ${code}:${err}`))));
    if (hang) child.stdin.write('{"session_id":"' + sid + '"'); // 不结束输入
    else child.stdin.end(JSON.stringify({ session_id: sid }));
  });

  // F03:缺库/不可打开 → 退出 0、stdout 空,但健康记录必须是 error 终态(查询子进程失败同样落终态)
  let out = runStop({ cfg: cfgOn, db: path.join(tmp, "no-such-dir", "db.sqlite") });
  assert.equal(out, "", "任何失败静默放行");
  let h = readHealth("sqa", HOOK_STOP);
  assert.equal(h.status, "error", "缺库必须留下 error 终态");
  assert.ok(typeof h.error === "string" && h.error.length > 0, "error 必须带原因");
  assert.ok(Number.isFinite(h.durationMs), "error 终态带耗时");
  assert.ok(Number.isFinite(h.totalMs) && h.totalMs >= h.durationMs, "全程耗时须覆盖 stdin 等前置步骤(R03)");
  // R05:error 终态不得渲染"采集成功",也不得带入上一轮通知结果
  let stopCheck = doctorStopCheck("sqa");
  assert.equal(stopCheck.ok, false);
  assert.match(stopCheck.detail, /采集失败/);
  assert.ok(!stopCheck.detail.includes("采集成功"), "error 不得写采集成功(R05)");
  assert.ok(!stopCheck.detail.includes("通知已提交"), "新 run 不得带入上一轮通知结果(R05)");

  // F03(补):配置损坏 → 同样有 error 终态(不提前退出,完整路径留终态)
  fs.writeFileSync(cfgBroken, "{not-json");
  runStop({ cfg: cfgBroken });
  assert.equal(readHealth("sqa", HOOK_STOP).status, "error", "配置损坏也须记录终态");

  // F02:prompt 链路 error 不被随后 disabled 的 Stop 抹掉(旧实现会覆盖成 disabled/ok)
  fs.writeFileSync(cfgBroken, '{"tokenRateLine":');
  runHook(promptHook, { cfg: cfgBroken });
  assert.equal(readHealth("sqa", HOOK_PROMPT).status, "error");
  runStop({ cfg: cfgOff });   // 默认关闭的 Stop
  assert.equal(readHealth("sqa", HOOK_STOP).status, "disabled");
  assert.equal(readHealth("sqa", HOOK_PROMPT).status, "error", "disabled 的 Stop 不得掩盖 prompt 的 error(F02)");
  fs.rmSync(shownFile, { force: true });
  for (const sid of ["sqa", "sqb", "sqc", "sqd", "sqf"]) fs.rmSync(slotFile(sid), { force: true });

  // F05:通知命令不存在(ZCODE_TPS_NOTIFY_BIN 指向缺失路径 → spawn ENOENT,跨平台确定)
  // (Windows 上清空 PATH 不可靠:CreateProcess 会搜索系统目录,实测仍能找到 powershell)
  const missingBin = path.join(tmp, "definitely-missing-notifier" + (process.platform === "win32" ? ".exe" : ""));
  out = runStop({ cfg: cfgOn, realNotify: true, extraEnv: { ZCODE_TPS_NOTIFY_BIN: missingBin } });
  assert.equal(out, "");
  h = readHealth("sqa", HOOK_STOP);
  assert.equal(h.status, "notify-failed", "命令缺失必须判失败(旧实现未提交已记 ok)");
  assert.match(h.error, /ENOENT/);
  assert.ok(!fs.existsSync(slotFile("sqa")), "提交失败不得落水位(下次 Stop 重试)");

  // R01:通知命令非零退出 → notify-failed,不落水位(审核复现:旧实现只确认拉起,exit 1 仍记 ok)
  out = runStop({ cfg: cfgOn, realNotify: true, extraEnv: { ZCODE_TPS_NOTIFY_BIN: process.execPath, QEXIT: "1" } });
  assert.equal(out, "");
  h = readHealth("sqa", HOOK_STOP);
  assert.equal(h.status, "notify-failed", "非零退出必须判失败");
  assert.match(h.error, /exit 1/);
  assert.ok(!fs.existsSync(slotFile("sqa")), "非零退出不得落水位(下次 Stop 重试)");
  stopCheck = doctorStopCheck("sqa");
  assert.equal(stopCheck.ok, false);
  assert.match(stopCheck.detail, /通知提交失败/);

  // R01:退出码 0 → ok + 水位前进
  out = runStop({ cfg: cfgOn, realNotify: true, extraEnv: { ZCODE_TPS_NOTIFY_BIN: process.execPath, QEXIT: "0" } });
  h = readHealth("sqa", HOOK_STOP);
  assert.equal(h.status, "ok");
  assert.equal(h.notified, true);
  assert.equal(h.notifyStatus, "ok", "退出码 0 = 命令执行完成");
  assert.ok(fs.existsSync(slotFile("sqa")), "成功后水位落盘");

  // R01:退出码 3 → failed:exit 3,水位不动(需新数据才会走通知路径)
  {
    const db2 = new DatabaseSync(dbPath);
    insert(db2, { t0: 6_000_000, out: 150, ttft: 100, dur: 1000, sess: "sqa", trace: "TQA" });
    db2.close();
    const slotBefore = readSlot("sqa");
    out = runStop({ cfg: cfgOn, realNotify: true, extraEnv: { ZCODE_TPS_NOTIFY_BIN: process.execPath, QEXIT: "3" } });
    h = readHealth("sqa", HOOK_STOP);
    assert.equal(h.status, "notify-failed");
    assert.match(h.error, /exit 3/);
    assert.deepEqual(readSlot("sqa"), slotBefore, "失败重试期间水位不得改写");
  }

  // R01:限时内未退出 → unknown:如实标注、水位前进(避免对可能已展示的通知重复弹窗)
  {
    const db2 = new DatabaseSync(dbPath);
    insert(db2, { t0: 7_000_000, out: 300, ttft: 100, dur: 1000, sess: "sqa", trace: "TQA" });
    db2.close();
    const shownBefore = readSlot("sqa").shownAt;
    out = runStop({ cfg: cfgOn, realNotify: true,
      extraEnv: { ZCODE_TPS_NOTIFY_BIN: process.execPath, QSLEEP: "1500", QEXIT: "0", ZCODE_TPS_NOTIFY_CONFIRM_MS: "300" } });
    h = readHealth("sqa", HOOK_STOP);
    assert.equal(h.status, "ok");
    assert.equal(h.notified, true);
    assert.equal(h.notifyStatus, "unknown", "超时按已提交处理但如实标注");
    assert.ok(readSlot("sqa").shownAt > shownBefore, "unknown 水位前进(有界策略:不重试以免重复弹窗)");
    stopCheck = doctorStopCheck("sqa");
    assert.match(stopCheck.detail, /限时内未确认退出/);
  }

  // R02:指纹必须覆盖速率分母与缓存分子(审核复现:单请求 out=100/input=800/cacheRead=700/dur=1000)
  {
    const fpDb = path.join(tmp, "fingerprint.sqlite");
    { const { db: d } = makeDb("fingerprint.sqlite"); insert(d, { sess: "sqf" }); d.close(); }
    const cfgFp = path.join(tmp, "fp-on.json");
    fs.writeFileSync(cfgFp, JSON.stringify({ turnEndLine: true }));
    const runFp = () => runStop({ cfg: cfgFp, sid: "sqf", db: fpDb, realNotify: true,
      extraEnv: { ZCODE_TPS_NOTIFY_BIN: process.execPath, QEXIT: "0" } });
    runFp();
    assert.equal(readHealth("sqf", HOOK_STOP).notified, true, "首次通知");
    // 只回填 duration(1000→2000):token/完成时间全不变,轮均 100→50、Decode 111.1→52.6
    let db2 = new DatabaseSync(fpDb);
    db2.exec("UPDATE model_usage SET duration_ms = 2000");
    db2.close();
    runFp();
    assert.equal(readHealth("sqf", HOOK_STOP).notified, true, "时长回填改变展示速率,必须再次通知(R02)");
    // 再只回填 cacheRead(700→400):缓存 87.5%→50%
    db2 = new DatabaseSync(fpDb);
    db2.exec("UPDATE model_usage SET cache_read_input_tokens = 400");
    db2.close();
    runFp();
    assert.equal(readHealth("sqf", HOOK_STOP).notified, true, "缓存分子回填改变缓存率,必须再次通知(R02)");
    // 快照不再变化 → 不重复通知
    runFp();
    assert.equal(readHealth("sqf", HOOK_STOP).notified, false, "稳定快照不重复通知");
  }

  // F06:子代理并入改变展示内容 → 指纹变化 → 再次通知(旧实现水位不动,变化被拦截)
  {
    const db2 = new DatabaseSync(dbPath);
    insert(db2, { t0: 9_000_000, out: 200, ttft: 100, dur: 1000, qs: "subagent", sess: "sq_child", trace: "TQA" });
    db2.close();
    const before = readSlot("sqa");
    runStop({ cfg: cfgOn });
    const after = readSlot("sqa");
    assert.notEqual(after.fingerprint, before.fingerprint, "子代理并入后指纹必须变化");
    assert.equal(readHealth("sqa", HOOK_STOP).notified, true);
    assert.equal(readHealth("sqa", HOOK_STOP).notifyStatus, "suppressed", "suppress 须如实标注,不冒充已提交");
  }

  // F06:A→B→A 无新增 → A 水位不动,不重复通知;B 为独立文件(R04)
  {
    const db2 = new DatabaseSync(dbPath);
    insert(db2, { t0: 5_000_000, out: 100, ttft: 100, dur: 1000, sess: "sqb", trace: "TQB" });
    db2.close();
    runStop({ cfg: cfgOn, sid: "sqb" });
    assert.ok(fs.existsSync(slotFile("sqb")), "B 会话独立水位文件(R04)");
    const aBefore = readSlot("sqa");
    runStop({ cfg: cfgOn, sid: "sqa" });
    assert.equal(readSlot("sqa").ts, aBefore.ts, "A 无新增时重复 Stop 不得改写其水位(A→B→A 场景)");
  }

  // R04:并发 Stop(A/B 同时提交)→ 两个会话的水位都保留(旧共享多槽文件实测 3/3 只剩 B)
  {
    const db2 = new DatabaseSync(dbPath);
    insert(db2, { t0: 11_000_000, out: 100, ttft: 100, dur: 1000, sess: "sqc", trace: "TQC" });
    insert(db2, { t0: 12_000_000, out: 100, ttft: 100, dur: 1000, sess: "sqd", trace: "TQD" });
    db2.close();
    // 通知命令慢退出 + 确认限时,把两个 Stop 的"通知-写水位"窗口拉宽到数百毫秒重叠
    const env = { ZCODE_TPS_NOTIFY_BIN: process.execPath, QSLEEP: "800", QEXIT: "0", ZCODE_TPS_NOTIFY_CONFIRM_MS: "600" };
    await Promise.all([spawnStop("sqc", { extraEnv: env }), spawnStop("sqd", { extraEnv: env })]);
    assert.ok(fs.existsSync(slotFile("sqc")) && fs.existsSync(slotFile("sqd")), "并发 Stop 后两个会话水位都在(R04)");
    assert.equal(readHealth("sqc", HOOK_STOP).status, "ok");
    assert.equal(readHealth("sqd", HOOK_STOP).status, "ok");
  }

  // ---- §12.3:同会话原子占用与防倒写(跨会话 R04 之外的既定验收项) ----
  {
    const cDb = path.join(tmp, "concurrent.sqlite");
    { const { db: d } = makeDb("concurrent.sqlite"); insert(d, { sess: "sconc", trace: "TC" }); d.close(); }
    const cfgC = path.join(tmp, "conc-on.json");
    fs.writeFileSync(cfgC, JSON.stringify({ turnEndLine: true }));
    const countFile = path.join(tmp, "notify-count.txt");
    const calls = () => (fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8").trim().split("\n").filter(Boolean).length : 0);
    const cEnv = (over = {}) => ({ ZCODE_TPS_NOTIFY_BIN: process.execPath, QCOUNT: countFile, QEXIT: "0", ...over });
    const runC = (over) => runStop({ cfg: cfgC, sid: "sconc", db: cDb, realNotify: true, extraEnv: cEnv(over) });
    const spawnC = (over) => spawnStop("sconc", { extraEnv: { ZCODE_TPS_CONFIG: cfgC, ZCODE_USAGE_DB: cDb, ...cEnv(over) } });
    const slotC = slotFile("sconc");
    const claimC = `${slotC}.claim`;

    // 复现 A:同会话相同快照并发 ×3,通知命令恰好各执行一次(旧实现 3/3 执行两次)
    for (let round = 1; round <= 3; round++) {
      fs.rmSync(slotC, { force: true }); fs.rmSync(claimC, { force: true }); fs.rmSync(countFile, { force: true });
      await Promise.all([spawnC({ QSLEEP: "800" }), spawnC({ QSLEEP: "800" })]);
      assert.equal(calls(), 1, `第 ${round} 轮同会话并发 Stop 通知命令恰好执行一次`);
      assert.ok(fs.existsSync(slotC), "占用者完成通知并落水位");
      assert.ok(!fs.existsSync(claimC), "锁已释放");
    }

    // 复现 B(倒写):旧采样慢通知期间数据前进 → 并发者让位,不倒写、不重复
    {
      fs.rmSync(slotC, { force: true }); fs.rmSync(claimC, { force: true }); fs.rmSync(countFile, { force: true });
      const slow = spawnC({ QSLEEP: "1500" });
      await delay(500); // 慢通知者已持锁、正在通知旧内容
      const d2 = new DatabaseSync(cDb);
      d2.exec("UPDATE model_usage SET output_tokens = 200"); // 数据前进(回填,completed_at 不变)
      d2.close();
      await spawnC(); // 并发者:拿不到锁(或让位),不发送不写水位
      await slow;
      assert.equal(calls(), 1, "持锁期间并发者让位,旧内容只通知一次");
      const v1 = JSON.parse(fs.readFileSync(slotC, "utf8"));
      // 第三个 Stop:新数据尚未通知过 → 通知一次并前进水位(不倒写回旧指纹)
      await runC();
      assert.equal(calls(), 2, "新数据由下一个 Stop 通知一次");
      const v2 = JSON.parse(fs.readFileSync(slotC, "utf8"));
      assert.notEqual(v2.fingerprint, v1.fingerprint, "水位前进到新指纹,未被旧结果倒写");
      // 第四个 Stop:快照不再变化 → 不重复通知(旧实现此处会因倒写多通知一次)
      await runC();
      assert.equal(calls(), 2, "快照不变不重复通知");
    }

    // ts 让位(交错:并发者在本次采样开始之后才完成写入)——拖住查询,期间写入"更新"水位
    {
      fs.rmSync(slotC, { force: true }); fs.rmSync(claimC, { force: true });
      const lock = new DatabaseSync(cDb);
      lock.exec("BEGIN EXCLUSIVE");
      const p = spawnC();
      await delay(500); // 被测 Stop 正在查询中(busy 等待)
      const manual = JSON.stringify({ version: 3, sessionId: "sconc", shownAt: 999,
        fingerprint: "manual-newer", ts: Date.now(), source: "stop" });
      fs.writeFileSync(slotC, manual); // 模拟并发者基于更新采样完成的通知写入
      lock.exec("ROLLBACK"); lock.close();
      await p;
      assert.equal(fs.readFileSync(slotC, "utf8"), manual, "旧采样不得倒写并发者刚写入的水位(ts 让位)");
      const h = readHealth("sconc", HOOK_STOP);
      assert.equal(h.notified, false);
      assert.equal(h.skipReason, "stale");
    }

    // claim 残留:持有者已死 → 回收后照常通知;持有者存活 → 让位且不删他人锁;失败释放可重试
    {
      fs.rmSync(slotC, { force: true }); fs.rmSync(claimC, { force: true }); fs.rmSync(countFile, { force: true });
      const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
      await once(dead, "close");
      fs.writeFileSync(claimC, JSON.stringify({ runId: "dead", pid: dead.pid, ts: Date.now() }));
      await runC();
      assert.equal(calls(), 1, "死 pid 残留锁被回收,通知照常");
      assert.ok(!fs.existsSync(claimC), "成功路径释放锁");

      fs.rmSync(slotC, { force: true });
      fs.writeFileSync(claimC, JSON.stringify({ runId: "live", pid: process.pid, ts: Date.now() }));
      await runC();
      assert.equal(calls(), 1, "活持有者持锁期间让位不通知");
      assert.equal(readHealth("sconc", HOOK_STOP).skipReason, "locked");
      assert.ok(fs.existsSync(claimC), "不得删除他人持有的锁");

      fs.rmSync(slotC, { force: true }); fs.rmSync(claimC, { force: true });
      await runC({ QEXIT: "1" });
      assert.ok(!fs.existsSync(claimC), "notify-failed 释放锁,允许下次重试");
      assert.equal(readHealth("sconc", HOOK_STOP).status, "notify-failed");
      const failedCalls = calls();
      await runC();
      assert.equal(calls(), failedCalls + 1, "锁释放后重试通知成功(失败尝试本身也算一次命令调用)");
    }

    // §13 E01:pause the old-claim reader at the exact recovery boundary. The second
    // process must fail to acquire the SAME guard, not replace the claim under that reader.
    {
      fs.rmSync(slotC, { force: true }); fs.rmSync(claimC, { force: true }); fs.rmSync(countFile, { force: true });
      const dead = execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim();
      fs.writeFileSync(claimC, JSON.stringify({ runId: "dead", pid: Number(dead), ts: Date.now() }));
      const marker = path.join(tmp, "recovery-read");
      const resume = path.join(tmp, "recovery-resume");
      const preload = path.join(tmp, "recovery-pause.mjs");
      fs.writeFileSync(preload, `import fs from "node:fs";
        const read = fs.readFileSync;
        fs.readFileSync = function(file, ...args) {
          const raw = read.call(fs, file, ...args);
          if (String(file) === process.env.CLAIM_TEST_FILE && JSON.parse(String(raw)).runId === "dead") {
            fs.writeFileSync(process.env.CLAIM_TEST_MARK, "ready");
            const deadline = Date.now() + 4000;
            while (!fs.existsSync(process.env.CLAIM_TEST_RESUME)) {
              if (Date.now() > deadline) throw new Error("recovery pause timeout");
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
          }
          return raw;
        };`);
      const paused = spawnC({ NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        CLAIM_TEST_FILE: claimC, CLAIM_TEST_MARK: marker, CLAIM_TEST_RESUME: resume, QSLEEP: "800" });
      try {
        const deadline = Date.now() + 3000;
        while (!fs.existsSync(marker) && Date.now() < deadline) await delay(10);
        assert.ok(fs.existsSync(marker), "first recovery contender reached the controlled boundary");
        await spawnC();
        assert.equal(readHealth("sconc", HOOK_STOP).skipReason, "locked");
        assert.equal(JSON.parse(fs.readFileSync(claimC, "utf8")).runId, "dead", "contender did not replace the observed claim");
        assert.equal(calls(), 0, "contender did not start a notification");
      } finally {
        fs.writeFileSync(resume, "go");
        await paused;
      }
      assert.equal(calls(), 1, "exactly one notification after concurrent recovery");
      assert.ok(!fs.existsSync(claimC), "effective owner released its own metadata");
    }

    // §13 E02:young incomplete legacy records are protected; aged records can recover.
    for (const raw of ["", '{"runId":', "[]"]) {
      fs.rmSync(slotC, { force: true });
      fs.writeFileSync(claimC, raw);
      const before = calls();
      runC();
      assert.equal(calls(), before, "do not steal an incomplete legacy writer during its grace period");
      assert.equal(readHealth("sconc", HOOK_STOP).skipReason, "locked");
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(claimC, old, old);
      runC();
      assert.equal(calls(), before + 1, "aged empty/truncated/unrecognized metadata does not block forever");
      assert.ok(!fs.existsSync(claimC));
    }

    // OS lock recovery:kill an actual holder BEFORE atomic metadata publication.
    // No shared JSON is created in that window, and closing the killed connection releases the guard.
    {
      const worker = path.join(tmp, "claim-crash-worker.mjs");
      const crashClaim = path.join(tmp, "crash.claim");
      const claimant = pathToFileURL(path.join(root, "plugins/zcode-tps/scripts/claim.mjs")).href;
      fs.writeFileSync(worker, `import fs from "node:fs";
        const { acquireClaim } = await import(${JSON.stringify(claimant)});
        const rename = fs.renameSync;
        fs.renameSync = function(from, to) {
          if (to === process.env.CLAIM_TEST_FILE) {
            process.send("publishing");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
          }
          return rename.call(fs, from, to);
        };
        await acquireClaim(process.env.CLAIM_TEST_FILE, "crash-owner");`);
      const child = spawn(process.execPath, [worker], {
        env: { ...process.env, CLAIM_TEST_FILE: crashClaim }, stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      const closed = once(child, "close");
      let timeout;
      try {
        const ready = await Promise.race([once(child, "message"), new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("claim worker did not reach publication")), 3000);
        })]);
        assert.equal(ready[0], "publishing");
        const { acquireClaim, releaseClaim } = await import(claimant);
        assert.equal(await acquireClaim(crashClaim, "contender"), null, "live OS mutex cannot be stolen");
        child.kill(); await closed;
        const recovered = await acquireClaim(crashClaim, "after-crash");
        assert.ok(recovered, "killed writer releases its OS lock without waiting for a JSON timeout");
        releaseClaim(recovered);
        const replacement = await acquireClaim(crashClaim, "replacement");
        releaseClaim(recovered); // An obsolete release must not unlink the replacement's record.
        assert.equal(JSON.parse(fs.readFileSync(crashClaim, "utf8")).runId, "replacement");
        releaseClaim(replacement);
        const changed = await acquireClaim(crashClaim, "changed-owner");
        const foreign = JSON.stringify({ guard: "sqlite-v1", runId: "foreign", pid: process.pid, ts: Date.now() });
        fs.writeFileSync(crashClaim, foreign); // Fault injection: ownership metadata replaced outside the protocol.
        assert.throws(() => releaseClaim(changed), /owner 已变化/);
        assert.equal(fs.readFileSync(crashClaim, "utf8"), foreign, "release never deletes another owner's record");
        const afterFault = await acquireClaim(crashClaim, "after-fault");
        assert.ok(afterFault, "failed owner validation still closes the old connection");
        releaseClaim(afterFault);
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
      }
    }

    // §13 E03:initialize new state directories and report non-contention I/O errors.
    {
      const freshBase = path.join(tmp, "new-state-directory", "shown.json");
      const freshSlot = freshBase + slotFile("sqa").slice(shownFile.length);
      runStop({ cfg: cfgOn, realNotify: true,
        extraEnv: { ZCODE_TPS_LAST_SHOWN: freshBase, ...cEnv() } });
      assert.equal(readHealth("sqa", HOOK_STOP).notifyStatus, "ok");
      assert.ok(fs.existsSync(freshSlot), "first use creates parent directory and writes watermark");
      const obstruction = path.join(tmp, "parent-is-file");
      fs.writeFileSync(obstruction, "not a directory");
      runStop({ cfg: cfgOn, extraEnv: { ZCODE_TPS_LAST_SHOWN: path.join(obstruction, "shown.json") } });
      const failed = readHealth("sqa", HOOK_STOP);
      assert.equal(failed.status, "error", "filesystem failure must not masquerade as a competing owner");
      assert.equal(failed.skipReason, null);
      assert.match(failed.error, /占用锁失败.*(EEXIST|ENOTDIR)/);
      const corruptBase = path.join(tmp, "corrupt-state", "shown.json");
      const corruptSlot = corruptBase + slotFile("sqa").slice(shownFile.length);
      fs.mkdirSync(path.dirname(corruptSlot), { recursive: true });
      fs.writeFileSync(`${corruptSlot}.claim.sqlite`, "not a SQLite database");
      runStop({ cfg: cfgOn, extraEnv: { ZCODE_TPS_LAST_SHOWN: corruptBase } });
      assert.equal(readHealth("sqa", HOOK_STOP).status, "error", "a damaged guard is not mutex contention");
      assert.match(readHealth("sqa", HOOK_STOP).error, /not a database/);
    }
  }

  // F06(迁移):旧共享多槽文件 → 迁移读为独立文件,共享文件本身不再写入
  {
    const legacy = JSON.stringify({ version: 2, everNotified: true,
      sessions: { sqa: { shownAt: 1_001_100, fingerprint: "legacy", ts: 5 } } });
    fs.writeFileSync(shownFile, legacy);
    fs.rmSync(slotFile("sqa"), { force: true });
    runStop({ cfg: cfgOn });
    assert.ok(fs.existsSync(slotFile("sqa")), "旧共享水位迁移为该会话独立文件");
    assert.equal(fs.readFileSync(shownFile, "utf8"), legacy, "共享文件只作迁移读,不再写入(R04)");
    const s1 = readSlot("sqa").ts;
    runStop({ cfg: cfgOn });
    assert.equal(readSlot("sqa").ts, s1, "迁移后指纹稳定,不反复通知");
  }

  // stdin 限时长:宿主异常保持 stdin 开启——关闭态走短限时,不等全限时(R03)
  {
    const start = Date.now();
    await spawnStop("sqa", { extraEnv: { ZCODE_TPS_CONFIG: cfgOff }, hang: true });
    assert.ok(Date.now() - start < 1600, "关闭态悬挂 stdin 须在短限时内退出(约 300ms,不得等 1.5s 全限时)");
    assert.equal(readHealth("sqa", HOOK_STOP).status, "disabled");
  }

  // R03:开启态悬挂 stdin + 正常库 → stdin 超时按无输入处理,env sid 兜底,流程照常 ok
  {
    const start = Date.now();
    await spawnStop("sqb", { hang: true });
    assert.ok(Date.now() - start < 4000, "悬挂 stdin + 正常查询须远小于宿主 8s 预算");
    assert.equal(readHealth("sqb", HOOK_STOP).status, "ok");
    assert.ok(readHealth("sqb", HOOK_STOP).stdinMs >= 1400, "stdin 等待计入分段耗时");
  }

  // R03:悬挂 stdin + 持续独占锁 → 查询子进程按剩余预算终止,墙钟硬性有界,终态 error 不残留 running
  {
    const lock = new DatabaseSync(dbPath); // 默认 DELETE journal:BEGIN EXCLUSIVE 阻塞只读连接
    lock.exec("BEGIN EXCLUSIVE");
    try {
      const start = Date.now();
      await Promise.race([spawnStop("sqa", { hang: true }), delay(9500).then(() => { throw new Error("stop 未在 9.5s 内退出"); })]);
      const wall = Date.now() - start;
      assert.ok(wall < 7500, `全程墙钟 ${wall}ms 必须显著小于宿主 8s 预算(审核复现旧实现 8095ms)`);
      h = readHealth("sqa", HOOK_STOP);
      assert.equal(h.status, "error", "预算内无法完成 → error 终态,不残留 running");
      assert.match(h.error, /查询超时/, "子进程终止原因可诊断");
      assert.ok(h.stdinMs >= 1400, "输入等待与查询共享同一预算");
      assert.ok(Number.isFinite(h.queryMs) && h.queryMs > 0, "查询耗时分段记录");
      assert.ok(Number.isFinite(h.totalMs) && h.totalMs < 7500);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
  }

  // R05:running 记录显示"采集中",不写采集成功
  {
    const { startHealth } = await import(pathToFileURL(RUNTIME).href + "?q-run");
    startHealth("sqrun", HOOK_STOP);
    const c = doctorStopCheck("sqrun");
    assert.equal(c.ok, false);
    assert.match(c.detail, /采集中/);
    assert.ok(!c.detail.includes("采集成功"));
  }

  // stdin 限长度:超过 64KB 的输入按无输入处理,不崩溃
  {
    const child = spawn(process.execPath, [STOP], {
      cwd: tmp,
      env: { ...process.env, ZCODE_USAGE_DB: dbPath, ZCODE_SESSION_ID: "sqa", ZCODE_TPS_CONFIG: cfgOff,
        ZCODE_TPS_HEALTH: healthBase, ZCODE_TPS_LAST_SHOWN: shownFile,
        ZCODE_TPS_LAST_SESSION: path.join(tmp, "quality-last.json") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {}); // 超长输入触发子进程主动断开,父端写入失败属预期
    child.stdin.write("x".repeat(200_000));
    child.stdin.end();
    const [code] = await once(child, "close");
    assert.equal(code, 0);
    assert.equal(readHealth("sqa", HOOK_STOP).status, "disabled", "超长输入按无输入降级");
  }
}

// ================= F04:macOS 通知 argv 传参,不再破坏 AppleScript 字符串边界 =================
{
  const { buildNotifyCommand } = await import(pathToFileURL(RUNTIME).href + "?q-notify");
  const tricky = '含"引号\'单引号\\反斜杠\n换行 emoji 🚀';
  const mac = buildNotifyCommand(tricky, { platform: "darwin" });
  assert.equal(mac.command, "osascript");
  assert.equal(mac.args[0], "-e");
  assert.ok(mac.args[1].includes("on run"), "使用固定 run handler,文本不进脚本源码");
  assert.equal(mac.args[2], tricky, "文本经 argv 原样传入(旧实现会在边界前残留反斜杠)");
  assert.equal(mac.args[3], "zcode-tps");
  // win:编码命令可解码回原脚本(结构不变,文本经 JSON 字符串进入 PowerShell 单引号字面量)
  const win = buildNotifyCommand("line", { platform: "win32" });
  assert.equal(win.command, "powershell");
  const decoded = Buffer.from(win.args.at(-1), "base64").toString("utf16le");
  assert.ok(decoded.includes("CreateTextNode("), "Windows toast 脚本结构不变");
  const linux = buildNotifyCommand("line", { platform: "linux" });
  assert.equal(linux.command, "notify-send");
  assert.deepEqual(linux.args, ["zcode-tps", "line"]);
  // ensurePermission 开关只影响 Windows 脚本前缀
  const winPerm = buildNotifyCommand("line", { platform: "win32", ensurePermission: true });
  const decodedPerm = Buffer.from(winPerm.args.at(-1), "base64").toString("utf16le");
  assert.ok(decodedPerm.includes("Set-ItemProperty"), "ensurePermission 时写注册表横幅权限");
  assert.ok(!decoded.includes("Set-ItemProperty"), "非首次不写注册表");
  // submitNotify:suppress 环境变量原样返回状态;缺失命令确定性返回 failed(跨平台)
  const prevSup = process.env.ZCODE_TPS_NOTIFY_SUPPRESS;
  const prevBin = process.env.ZCODE_TPS_NOTIFY_BIN;
  process.env.ZCODE_TPS_NOTIFY_SUPPRESS = "1";
  const { submitNotify } = await import(pathToFileURL(RUNTIME).href + "?q-submit");
  assert.equal(await submitNotify({ line: "test" }), "suppressed");
  delete process.env.ZCODE_TPS_NOTIFY_SUPPRESS;
  process.env.ZCODE_TPS_NOTIFY_BIN = path.join(tmp, "no-such-notifier-bin");
  assert.match(await submitNotify({ line: "test" }), /^failed:/,
    "命令缺失必须返回 failed 而非冒充提交成功");
  if (prevSup === undefined) delete process.env.ZCODE_TPS_NOTIFY_SUPPRESS; else process.env.ZCODE_TPS_NOTIFY_SUPPRESS = prevSup;
  if (prevBin === undefined) delete process.env.ZCODE_TPS_NOTIFY_BIN; else process.env.ZCODE_TPS_NOTIFY_BIN = prevBin;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("quality 0.5.5 修复回归全部通过 ✅(F01 部分索引 / F02 链路隔离 / F03 异常终态 / F04 通知构造 / F05+R01 通知退出码 / F06+R02/R04 指纹与独立水位 / F07 TTFT / F08 坏日期 / F09 空白轮 / F10 token 类型 / R03 全程预算 / R05 诊断文案 / stdin 限时长)");
