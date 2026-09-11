#!/usr/bin/env node
// 自检:检查插件运行依赖的各个环节,定位"速率行不见了"之类的问题。
// 用法:
//   node scripts/doctor.mjs           人类可读
//   node scripts/doctor.mjs --json    JSON(供程序消费)
// 退出码:存在 ❌ 项时为 1,否则 0。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectSchema, parseBool as parseBoolLoose, readConfig, querySettings, stateFile, healthFile, supportsNode, validId, parseJson } from "./runtime.mjs";

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
    const ageMin = last ? Math.round((Date.now() - last.completed_at) / 60000) : null;
    const out = [core(true,
      `核心列完整;最近完成样本 ${ageMin == null ? "无" : ageMin + " 分钟前"}`,
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

function healthCheck() {
  let sessionId = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  if (sessionId == null) {
    try {
      const st = parseJson(fs.readFileSync(stateFile(), "utf8"));
      const age = Date.now() - st.ts;
      if (validId(st.sessionId) && age >= 0 && age < 2 * 3600 * 1000) sessionId = st.sessionId;
    } catch {}
  }
  try {
    if (sessionId != null && !validId(sessionId)) throw new Error("invalid session");
    let h;
    try { h = parseJson(fs.readFileSync(healthFile(sessionId), "utf8")); }
    catch {
      h = parseJson(fs.readFileSync(healthFile(), "utf8"));
    }
    // Global/legacy records are a fallback only for the same explicitly selected session.
    if (sessionId != null && h.sessionId !== sessionId) throw new Error("different session");
    const age = Date.now() - h.ts;
    const fresh = Number.isFinite(age) && age >= 0 && age < 2 * 3600 * 1000;
    const ok = fresh && ["ok", "disabled"].includes(h.status) && !h.warnings?.length;
    let status = h.status ?? "未知";
    if (status === "running") {
      let alive = true;
      if (Number.isInteger(h.pid) && h.pid > 0) {
        try { process.kill(h.pid, 0); } catch (e) { if (e.code === "ESRCH") alive = false; }
      }
      status = !alive || Date.now() - h.startedAt >= 8000 ? "采集中断或超时(未记录完成)" : "采集中(尚未完成)";
    }
    return { name: "最近采集", level: "warn", ok,
      sessionId: h.sessionId ?? null, runId: h.runId ?? null, status: h.status,
      detail: `会话 ${h.sessionId ?? "未知"};${status};耗时 ${h.durationMs ?? "未知"}ms;最后成功 ${h.lastSuccessAt ? new Date(h.lastSuccessAt).toISOString() : "无记录"}${h.error ? ";" + h.error : ""}${h.warnings?.length ? ";" + h.warnings.join(";") : ""}`,
      hint: fresh ? "这是最近一次 hook 的结果,并非当前会话注册状态的证明" : "记录过期或时间异常,发送新消息后重试" };
  } catch {
    return { name: "最近采集", level: "warn", ok: false, sessionId,
      detail: `会话 ${sessionId ?? "未知"} 无有效采集记录`, hint: "发送一条消息后检查;其他会话的成功记录不会替代当前会话" };
  }
}

export async function runDoctor() {
  const results = [];
  results.push(nodeVersionCheck());
  results.push(...(await dbCheck()));
  results.push(await turnTableCheck());
  results.push(stateFileCheck());
  results.push(configCheck());
  results.push(healthCheck());
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
