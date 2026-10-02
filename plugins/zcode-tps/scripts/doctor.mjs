#!/usr/bin/env node
// 自检:检查插件运行依赖的各个环节,定位"速率行不见了"之类的问题。
// 用法:
//   node scripts/doctor.mjs           人类可读
//   node scripts/doctor.mjs --json    JSON(供程序消费)
// 退出码:存在 ❌ 项时为 1,否则 0。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectSchema, parseBool as parseBoolLoose, readConfig, querySettings, stateFile, healthFile, supportsNode, validId, parseJson, resolveTimezone, formatInZone, HOOK_PROMPT, HOOK_STOP } from "./runtime.mjs";

// 显示时区:配置优先,配置不可读时回退默认;与速率行/报表共用一套配置
function displayTimezone() {
  try { return resolveTimezone(process.env.ZCODE_TPS_TIMEZONE ?? readConfig().timezone); }
  catch { return resolveTimezone(process.env.ZCODE_TPS_TIMEZONE); }
}

const HOME = os.homedir();
const DB_PATH =
  process.env.ZCODE_USAGE_DB || path.join(HOME, ".zcode", "cli", "db", "db.sqlite");
// 可选列由 runtime 与查询共享;缺 turn_id 时会话累计仍可用,轮次信息未知。
// v0.4.1 起轮次/会话累计改由 model_usage 聚合,turn_usage 表不再被读取——以下检查仅供参考
const TURN_COLS = [
  "session_id", "status", "input_tokens", "output_tokens", "reasoning_tokens",
  "cache_creation_input_tokens", "cache_read_input_tokens",
  "computed_total_tokens", "duration_ms", "model_request_count", "completed_at",
];

function nodeVersionCheck() {
  const ok = supportsNode(process.versions.node);
  return {
    name: "Node 版本",
    level: "error",
    ok,
    detail: `当前 ${process.versions.node},需要 Node 22.13+、23.4+ 或 24+(无需 SQLite 实验启动参数)`,
    hint: ok ? null : "升级 Node 后重试:nvm install 22 / 官网安装最新 LTS",
  };
}

async function dbCheck() {
  const core = (ok, detail, hint) => ({ name: "usage 数据库", level: "error", ok, detail, hint });
  if (!fs.existsSync(DB_PATH)) {
    return [core(false,
      `未找到 ${DB_PATH}`,
      "若 ZCode 数据不在默认位置,设置环境变量 ZCODE_USAGE_DB 指向 db.sqlite")];
  }
  let db;
  try {
    // 动态加载,避免不支持 node:sqlite 的 Node 在 import 阶段就崩
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    try { db.exec("PRAGMA busy_timeout = 2000"); } catch {}
  } catch (e) {
    return [core(false,
      `无法只读打开 ${DB_PATH}: ${e.message}`,
      "确认文件为 SQLite 格式且未被独占锁定")];
  }
  try {
    const schema = inspectSchema(db);
    const cols = [...schema.columns];
    if (!cols.length) {
      return [core(false, "model_usage 表不存在", "ZCode 版本过旧或尚未产生用量数据;发一条消息后再试")];
    }
    const missing = schema.missing;
    if (missing.length) {
      return [core(false,
        `model_usage 缺少列: ${missing.join(", ")}`,
        "ZCode 版本变更了表结构,请升级插件或反馈 issue")];
    }
    const last = db
      .prepare("SELECT completed_at FROM model_usage WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1")
      .get();
    // 异常类型(TEXT 等)与未来时间戳不得渲染成 NaN/负数年龄;按审计 P2-1 显式标注
    let ageLabel = "无";
    if (last && Number.isFinite(last.completed_at)) {
      const ageMin = Math.round((Date.now() - last.completed_at) / 60000);
      ageLabel = ageMin < 0 ? "时间在未来(时钟偏差或脏数据)" : `${ageMin} 分钟前`;
    }
    const out = [core(true,
      `核心列完整;最近完成样本 ${ageLabel}`,
      null)];
    out.push(cols.includes("trace_id")
      ? { name: "子代理归因列(trace_id)", level: "warn", ok: true, detail: "存在,子代理可并入会话统计", hint: null }
      : { name: "子代理归因列(trace_id)", level: "warn", ok: false, detail: "列缺失,子代理无法归因(会话均/累计退回纯主对话口径)", hint: "旧库无此列;升级 ZCode 后恢复,核心速率不受影响" });
    out.push(cols.includes("turn_id")
      ? { name: "轮次关联列(turn_id)", level: "warn", ok: true, detail: "存在,轮均速率可用", hint: null }
      : { name: "轮次关联列(turn_id)", level: "warn", ok: false, detail: "列缺失,轮次与轮次数未知;会话累计和速率仍可用", hint: "旧库无此列;升级 ZCode 后恢复" });
    out.push({ name: "缓存写入列(cache_creation_input_tokens)", level: "warn",
      ok: cols.includes("cache_creation_input_tokens"),
      detail: cols.includes("cache_creation_input_tokens") ? "存在" : "列缺失,缓存写入量未知;总量与缓存命中率仍可用", hint: null });
    return out;
  } catch (e) {
    return [core(false, `查询失败: ${e.message}`, "检查数据库锁定状态或表结构")];
  } finally {
    db.close();
  }
}

async function turnTableCheck() {
  let db;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    try { db.exec("PRAGMA busy_timeout = 2000"); } catch {}
  } catch {
    return { name: "turn_usage 表", level: "warn", ok: true, detail: "跳过(数据库不可读,上一项已报错)", hint: null };
  }
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    if (!tables.includes("turn_usage")) {
      return { name: "turn_usage 表", level: "warn", ok: true, detail: "表不存在(无影响)", hint: "v0.4.1 起轮次/会话累计已改由 model_usage 聚合,不再依赖该表" };
    }
    const cols = db.prepare("PRAGMA table_info(turn_usage)").all().map((c) => c.name);
    const missing = TURN_COLS.filter((c) => !cols.includes(c));
    if (missing.length) {
      return { name: "turn_usage 表", level: "warn", ok: true, detail: `列结构与插件预期不同(无影响)`, hint: "v0.4.1 起不再读取该表;此检查仅供参考" };
    }
    return { name: "turn_usage 表", level: "warn", ok: true, detail: "表结构完整(仅供参考,v0.4.1 起不再读取)", hint: null };
  } catch (e) {
    return { name: "turn_usage 表", level: "warn", ok: false, detail: `参考检查失败: ${e.message}`, hint: null };
  } finally {
    db.close();
  }
}

function stateFileCheck() {
  try {
    const st = parseJson(fs.readFileSync(stateFile(), "utf8"));
    if (!st || !validId(st.sessionId) || !Number.isFinite(st.ts)) throw new Error("invalid state");
    const ageMs = Date.now() - st.ts;
    const fresh = ageMs >= 0 && ageMs < 2 * 3600 * 1000;
    const age = Math.round(ageMs / 60000);
    return {
      name: "会话状态文件",
      level: "warn",
      ok: fresh,
      detail: `存在,sessionId=${String(st.sessionId).slice(0, 8)}…,更新于 ${age} 分钟前;仅证明状态曾写入`,
      hint: fresh ? null : "状态已过期或时间异常;自动识别将回退数据库,发送新消息可刷新",
    };
  } catch {
    return {
      name: "会话状态文件",
      level: "warn",
      ok: false,
      detail: "不存在或不可读",
      hint: "发送新消息后重试;检查插件安装、状态路径和写入权限,安装/更新后需重开会话",
    };
  }
}

function configCheck() {
  try {
    const cfg = readConfig();
    querySettings();
    const off = !parseBoolLoose(cfg.tokenRateLine, true);
    return {
      name: "配置文件",
      level: "error",
      ok: true,
      detail: off ? "tokenRateLine=false,速率行注入已关闭(属预期)" : "已读取,注入开启",
      hint: off ? "如需恢复注入,删除该文件或改回 true" : null,
    };
  } catch (e) {
    return { name: "配置文件", level: "error", ok: false, detail: e.message, hint: "修正配置 JSON 对象或 TOKEN_RATE_* 环境变量后重试" };
  }
}

// ---- hook 链路诊断(0.5.5 起 prompt 与 stop 分文件、分链路展示) ----
// 健康记录按 会话+hook 隔离(F02):Stop 的 disabled/error 不再掩盖 prompt 的采集错误。
function resolveHealthSessionId() {
  let sessionId = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  if (sessionId == null) {
    try {
      const st = parseJson(fs.readFileSync(stateFile(), "utf8"));
      const age = Date.now() - st.ts;
      if (validId(st.sessionId) && age >= 0 && age < 2 * 3600 * 1000) sessionId = st.sessionId;
    } catch {}
  }
  return sessionId;
}

function readHealthRecord(sessionId, hook) {
  try {
    const h = parseJson(fs.readFileSync(healthFile(sessionId, hook), "utf8"));
    if (!h || typeof h !== "object") return null;
    if (sessionId != null && h.sessionId !== sessionId) return null; // 其他会话的记录不冒充本会话
    return h;
  } catch { return null; }
}

// 共享:running 状态的活性与超时解释 + 基础明细
function describeRun(h, zone) {
  let status = h.status ?? "未知";
  if (status === "running") {
    let alive = true;
    if (Number.isInteger(h.pid) && h.pid > 0) {
      try { process.kill(h.pid, 0); } catch (e) { if (e.code === "ESRCH") alive = false; }
    }
    status = !alive || Date.now() - h.startedAt >= 8000 ? "采集中断或超时(未记录完成)" : "采集中(尚未完成)";
  }
  const last = h.lastSuccessAt ? `${formatInZone(h.lastSuccessAt, zone)} (${zone})` : "无记录";
  const extra = `${h.error ? ";" + h.error : ""}${h.warnings?.length ? ";" + h.warnings.join(";") : ""}`;
  return { status, detail: `${status};耗时 ${h.durationMs ?? "未知"}ms;最后成功 ${last}${extra}` };
}

// 通知命令执行结果的如实描述(R01 起有退出码确认);未知值不冒充成功
function describeNotifyStatus(s) {
  if (s === "ok") return "命令正常退出";
  if (s === "suppressed") return "测试抑制";
  if (s === "unknown") return "限时内未确认退出";
  if (typeof s === "string" && s.startsWith("failed:")) return `失败(${s.slice("failed:".length)})`;
  return s ?? "未知确认";
}

function healthChecks() {
  const sessionId = resolveHealthSessionId();
  const zone = displayTimezone();
  const fresh = (h) => {
    const age = Date.now() - h.ts;
    return Number.isFinite(age) && age >= 0 && age < 2 * 3600 * 1000;
  };

  // 注入链路(UserPromptSubmit):默认显示行的采集
  const promptName = "注入链路采集(UserPromptSubmit)";
  const hp = sessionId != null && !validId(sessionId) ? null : readHealthRecord(sessionId, HOOK_PROMPT);
  const promptCheck = (() => {
    if (!hp) return { name: promptName, level: "warn", ok: false, sessionId,
      detail: `会话 ${sessionId ?? "未知"} 无有效采集记录`,
      hint: "发送一条消息后重查;插件安装/更新后需重开会话(hooks 会话启动时加载)" };
    const run = describeRun(hp, zone);
    const ok = fresh(hp) && ["ok", "disabled"].includes(hp.status) && !hp.warnings?.length;
    return { name: promptName, level: "warn", ok, sessionId: hp.sessionId ?? null, runId: hp.runId ?? null, status: hp.status,
      detail: `会话 ${hp.sessionId ?? "未知"};${run.detail}`,
      hint: fresh(hp) ? "这是最近一次 hook 的结果,并非当前会话注册状态的证明" : "记录过期或时间异常,发送新消息后重试" };
  })();

  // 通知链路(Stop):按本次 run 的状态分支渲染(R05)——error/running 不得出现"采集成功"字样,
  // 通知动作只解释真正成功的那次运行(startHealth 已清空上一轮的 notified/notifyStatus)。
  const stopName = "通知链路(Stop)";
  const hs = sessionId != null && !validId(sessionId) ? null : readHealthRecord(sessionId, HOOK_STOP);
  const stopCheck = (() => {
    if (!hs) return { name: stopName, level: "warn", ok: true, sessionId,
      detail: `会话 ${sessionId ?? "未知"} 未观察到 Stop hook 运行`,
      hint: "回合结束过至少会留下记录(含关闭态);无记录可能为插件刚更新未重开会话,或宿主未触发 Stop——以记录为准,不预设" };
    const run = describeRun(hs, zone);
    const scope = `会话 ${hs.sessionId ?? "未知"};`;
    if (hs.status === "disabled") return { name: stopName, level: "warn", ok: true, sessionId: hs.sessionId ?? null, status: hs.status,
      detail: `${scope}通知关闭(turnEndLine 未开启,属预期);${run.detail}`,
      hint: "需要回合结束通知时,配置 turnEndLine 为 true" };
    if (hs.status === "notify-failed") return { name: stopName, level: "warn", ok: false, sessionId: hs.sessionId ?? null, status: hs.status,
      detail: `${scope}通知提交失败;${run.detail}`,
      hint: "通知命令执行失败;检查平台通知命令可用性(powershell/osascript/notify-send),下次回合结束会自动重试" };
    if (hs.status === "error") return { name: stopName, level: "warn", ok: false, sessionId: hs.sessionId ?? null, status: hs.status,
      detail: `${scope}采集失败;${run.detail}`,
      hint: "本次采集未能完成,多为用量库被锁定或不可读;随下次回合结束自动重试,持续失败可运行 /tps 查看查询错误" };
    if (hs.status === "running") return { name: stopName, level: "warn", ok: false, sessionId: hs.sessionId ?? null, status: hs.status,
      detail: `${scope}${run.detail}`,
      hint: /中断|超时/.test(run.status) ? "上次运行未记录完成(可能被宿主超时终止);结束新回合后重查" : "采集仍在进行;稍后重查" };
    const ok = fresh(hs) && hs.status === "ok";
    let notify;
    if (hs.notified) notify = `通知已提交(${describeNotifyStatus(hs.notifyStatus)})`;
    else if (hs.skipReason === "locked") notify = "同会话另一回合结束处理中,本次让位";
    else if (hs.skipReason === "concurrent") notify = "相同内容已被并发通知,本次让位";
    else if (hs.skipReason === "stale") notify = "已有更新的并发通知,本次让位";
    else notify = "无新增数据,未通知";
    return { name: stopName, level: "warn", ok, sessionId: hs.sessionId ?? null, status: hs.status,
      detail: `${scope}采集成功;${notify};${run.detail}`,
      // P3 对齐:提示语按本次通知结果区分,unknown 不得被解释为"命令执行完成(退出码 0)"
      hint: hs.notified && hs.notifyStatus === "ok"
        ? "提交通知只承诺命令执行完成(退出码 0),横幅是否可见由系统通知权限与用户设置决定"
        : hs.notified && hs.notifyStatus === "unknown"
        ? "通知命令限时内未退出,按已提交处理且不自动重发(避免重复弹窗);结果已如实记录"
        : hs.notified && hs.notifyStatus === "suppressed"
        ? "测试抑制模式,未调用真实系统通知"
        : null };
  })();

  return [promptCheck, stopCheck];
}

// ---- 能力诊断(--details,0.6.0):仅 PRAGMA 级 schema 探测,不做重报表/全库关联(§9.3)。
// 可选能力缺失为提示(warn),不改变退出码;与诊断运行时共用同一 probeCapabilities 口径。
async function capabilityChecks() {
  if (!process.argv.includes("--details")) return [];
  let db = null;
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    try { db.exec("PRAGMA busy_timeout = 2000"); } catch {}
    const { probeCapabilities, CONTRACT_ID } = await import("./diagnostics.mjs");
    const caps = probeCapabilities(db);
    const labels = {
      rowIdentity: "能力:usage 行身份(id 主键)",
      traceAssociation: "能力:子代理 trace 归因",
      workflowAssociation: "能力:workflow 归属(actor 链)",
      turnUsageReconciliation: "能力:turn_usage 对账",
      retryAttempts: "能力:retry 尝试分组(lrid)",
      reportedRetries: "能力:retry 宿主上报值",
      currentPrompt: "能力:本问快照(wrapUpSample)",
    };
    return Object.entries(caps).filter(([k]) => labels[k]).map(([k, v]) => ({
      name: labels[k], level: "warn", ok: v.status === "ok",
      detail: v.status === "ok" ? `可用(${v.method ?? "已验证"})` : `不可用(${v.reasonCode ?? v.status})${v.note ? ":" + v.note : ""}`,
      hint: v.status === "ok" ? `契约:${CONTRACT_ID}` : "可选能力缺失只影响对应诊断章节,基础统计不受影响",
    }));
  } catch (e) {
    return [{ name: "能力诊断(--details)", level: "warn", ok: false,
      detail: `探测失败: ${e.message}`, hint: "不影响基础自检;诊断报表可用性以 /tps 实际输出为准" }];
  } finally {
    try { db?.close(); } catch {}
  }
}

export async function runDoctor() {
  const results = [];
  results.push(nodeVersionCheck());
  results.push(...(await dbCheck()));
  results.push(await turnTableCheck());
  results.push(stateFileCheck());
  results.push(configCheck());
  results.push(...healthChecks());
  results.push(...(await capabilityChecks()));
  const failed = results.filter((r) => !r.ok && r.level !== "warn").length;
  const warnings = results.filter((r) => !r.ok && r.level === "warn").length;
  return { checks: results, failed, warnings };
}

export { parseBoolLoose };

// --- CLI ---
if (process.argv[1] && process.argv[1].endsWith("doctor.mjs")) {
  const report = await runDoctor();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const c of report.checks) {
      const icon = c.ok ? "✅" : c.level === "warn" ? "⚠️" : "❌";
      console.log(`${icon} ${c.name}:${c.detail}`);
      if (c.hint) console.log(`   ↳ ${c.hint}`);
    }
    // O1:warn 只提示降级,不计失败;退出码只看 error
    if (report.failed) console.log(`\n${report.failed} 项未通过${report.warnings ? `,${report.warnings} 项警告(功能降级但可用)` : ""}`);
    else console.log(report.warnings ? `\n全部通过(附 ${report.warnings} 项警告,功能降级但可用)` : "\n全部通过");
  }
  process.exitCode = report.failed ? 1 : 0;
}
