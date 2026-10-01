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

// ================= Stop hook:F03 异常终态 / F02 链路隔离 / F05 提交失败 / F06 多槽水位 / stdin 限时限长 =================
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
  const healthBase = process.env.ZCODE_TPS_HEALTH; // 与 readHealth 在同一进程 env 下解析,路径一致
  const promptHook = path.join(root, "plugins", "zcode-tps", "hooks", "prompt-submit.mjs");
  const { healthFile, HOOK_PROMPT, HOOK_STOP } = await import(pathToFileURL(RUNTIME).href + "?q-hook");

  const runHook = (hookFile, { cfg, sid = "sqa", db = dbPath, stdin = {}, extraEnv = {}, realNotify = false } = {}) => {
    const env = {
      ...process.env, ZCODE_USAGE_DB: db, ZCODE_SESSION_ID: sid, ZCODE_TPS_CONFIG: cfg,
      ZCODE_TPS_HEALTH: healthBase, ZCODE_TPS_LAST_SHOWN: shownFile,
      ZCODE_TPS_LAST_SESSION: path.join(tmp, "quality-last.json"),
      ZCODE_TPS_NOTIFY_SUPPRESS: "1", ...extraEnv,
    };
    if (realNotify) delete env.ZCODE_TPS_NOTIFY_SUPPRESS;
    return execFileSync(process.execPath, [hookFile], {
      env, input: JSON.stringify({ session_id: sid, ...stdin }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  };
  const runStop = (opts) => runHook(STOP, opts);
  const readHealth = (sid, hook) => JSON.parse(fs.readFileSync(healthFile(sid, hook), "utf8"));

  // F03:缺库/不可打开 → 退出 0、stdout 空,但健康记录必须是 error 终态(旧实现残留 running/error=null)
  let out = runStop({ cfg: cfgOn, db: path.join(tmp, "no-such-dir", "db.sqlite") });
  assert.equal(out, "", "任何失败静默放行");
  let h = readHealth("sqa", HOOK_STOP);
  assert.equal(h.status, "error", "缺库必须留下 error 终态");
  assert.ok(typeof h.error === "string" && h.error.length > 0, "error 必须带原因");
  assert.ok(Number.isFinite(h.durationMs), "error 终态带耗时");

  // F03(补):配置损坏 → 同样有 error 终态(startHealth 先于读配置)
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

  // F05:通知命令不可用(ZCODE_TPS_NOTIFY_BIN 指向缺失路径 → spawn ENOENT,跨平台确定)
  // (Windows 上清空 PATH 不可靠:CreateProcess 会搜索系统目录,实测仍能找到 powershell)
  const missingBin = path.join(tmp, "definitely-missing-notifier" + (process.platform === "win32" ? ".exe" : ""));
  out = runStop({ cfg: cfgOn, realNotify: true, extraEnv: { ZCODE_TPS_NOTIFY_BIN: missingBin } });
  assert.equal(out, "");
  h = readHealth("sqa", HOOK_STOP);
  assert.equal(h.status, "notify-failed", "提交失败必须区分于成功(旧实现未提交已记 ok)");
  assert.match(h.error, /通知提交失败/);
  assert.ok(!fs.existsSync(shownFile), "提交失败不得落水位(下次 Stop 重试)");

  // doctor:提交失败四态中的"通知提交失败"可诊断
  const docOut = execFileSync(process.execPath, [DOCTOR, "--json"], {
    env: { ...process.env, ZCODE_SESSION_ID: "sqa", ZCODE_TPS_HEALTH: healthBase,
      ZCODE_TPS_CONFIG: cfgOn, ZCODE_TPS_LAST_SESSION: path.join(tmp, "quality-last.json") },
    encoding: "utf8",
  });
  const stopCheck = JSON.parse(docOut).checks.find((c) => c.name === "通知链路(Stop)");
  assert.equal(stopCheck.ok, false);
  assert.match(stopCheck.detail, /通知提交失败/);

  // F05(续):命令恢复可用(suppress)后重试成功 → ok + 水位前进
  out = runStop({ cfg: cfgOn });
  assert.equal(out, "");
  h = readHealth("sqa", HOOK_STOP);
  assert.equal(h.status, "ok");
  assert.equal(h.notified, true);
  assert.equal(h.notifyStatus, "suppressed", "suppress 须如实标注,不冒充已提交");
  assert.ok(fs.existsSync(shownFile), "成功后水位落盘");

  // F06:子代理并入改变展示内容 → 指纹变化 → 再次通知(旧实现水位不动,变化被拦截)
  {
    const db2 = new DatabaseSync(dbPath);
    insert(db2, { t0: 9_000_000, out: 200, ttft: 100, dur: 1000, qs: "subagent", sess: "sq_child", trace: "TQA" });
    db2.close();
    const before = JSON.parse(fs.readFileSync(shownFile, "utf8")).sessions.sqa;
    runStop({ cfg: cfgOn });
    const after = JSON.parse(fs.readFileSync(shownFile, "utf8")).sessions.sqa;
    assert.notEqual(after.fingerprint, before.fingerprint, "子代理并入后指纹必须变化");
    assert.equal(readHealth("sqa", HOOK_STOP).notified, true);
  }

  // F06:A→B→A 无新增 → A 槽不动,不重复通知(旧实现 A 的水位会被再次提交刷新)
  {
    const db2 = new DatabaseSync(dbPath);
    insert(db2, { t0: 5_000_000, out: 100, ttft: 100, dur: 1000, sess: "sqb", trace: "TQB" });
    db2.close();
    runStop({ cfg: cfgOn, sid: "sqb" });
    const shown = JSON.parse(fs.readFileSync(shownFile, "utf8"));
    assert.ok(shown.sessions.sqb, "B 会话独立槽位");
    const aBefore = shown.sessions.sqa;
    runStop({ cfg: cfgOn, sid: "sqa" });
    const aAfter = JSON.parse(fs.readFileSync(shownFile, "utf8")).sessions.sqa;
    assert.equal(aAfter.ts, aBefore.ts, "A 无新增时重复 Stop 不得改写其槽位(A→B→A 场景)");
  }

  // F06(迁移):旧单槽水位文件 → 迁移为多槽,至多多通知一次
  {
    fs.writeFileSync(shownFile, JSON.stringify({ sessionId: "sqa", shownAt: 1_001_100, ts: 1 }));
    runStop({ cfg: cfgOn });
    const shown = JSON.parse(fs.readFileSync(shownFile, "utf8"));
    assert.equal(shown.version, 2);
    assert.ok(shown.sessions.sqa, "旧水位迁移为该会话槽位");
    assert.equal(shown.everNotified, true, "旧文件已通知过,不再重复写注册表权限");
    runStop({ cfg: cfgOn });
    const shown2 = JSON.parse(fs.readFileSync(shownFile, "utf8"));
    assert.equal(shown2.sessions.sqa.ts, shown.sessions.sqa.ts, "迁移后指纹稳定,不反复通知");
  }

  // stdin 限时长:宿主异常保持 stdin 开启,关闭态也要在限时内退出(旧实现会挂到 8s 宿主超时)
  {
    const child = spawn(process.execPath, [STOP], {
      env: { ...process.env, ZCODE_USAGE_DB: dbPath, ZCODE_SESSION_ID: "sqa", ZCODE_TPS_CONFIG: cfgOff,
        ZCODE_TPS_HEALTH: healthBase, ZCODE_TPS_LAST_SHOWN: shownFile,
        ZCODE_TPS_LAST_SESSION: path.join(tmp, "quality-last.json") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {}); // 子进程限时销毁 stdin 后,父端残余写入报 EOF 属预期
    child.stdin.write('{"session_id":"sqa"'); // 不结束输入
    const closed = once(child, "close");
    const start = Date.now();
    const [code] = await Promise.race([closed, delay(5000).then(() => [-9])]);
    assert.equal(code, 0, "stdin 悬挂时进程仍须自行退出");
    assert.ok(Date.now() - start < 4500, "退出时间受 stdin 上限约束(约 1.5s + 查询),不得挂满 8s");
    try { child.kill(); } catch {}
  }

  // stdin 限长度:超过 64KB 的输入按无输入处理,不崩溃
  {
    const child = spawn(process.execPath, [STOP], {
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
console.log("quality 0.5.5 修复回归全部通过 ✅(F01 部分索引 / F02 链路隔离 / F03 异常终态 / F04 通知构造 / F05 提交结果 / F06 多槽水位 / F07 TTFT / F08 坏日期 / F09 空白轮 / F10 token 类型 / stdin 限时限长)");
