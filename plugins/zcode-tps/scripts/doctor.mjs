#!/usr/bin/env node
// 自检:检查插件运行依赖的各个环节,定位"速率行不见了"之类的问题。
// 用法:
//   node scripts/doctor.mjs           人类可读
//   node scripts/doctor.mjs --json    JSON(供程序消费)
// 退出码:存在 ❌ 项时为 1,否则 0。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.removeAllListeners("warning");
process.on("warning", () => {});

const HOME = os.homedir();
const DB_PATH =
  process.env.ZCODE_USAGE_DB || path.join(HOME, ".zcode", "cli", "db", "db.sqlite");
const STATE_FILE = path.join(HOME, ".zcode", "zcode-tps.last-session.json");
const CONFIG_FILE = path.join(HOME, ".zcode", "zcode-tps.config.json");

// 钩子查询依赖的列(model_usage 表);缺失即核心指标不可用,计 error
const REQUIRED_COLS = [
  "session_id", "status", "query_source", "model_id",
  "output_tokens", "reasoning_tokens", "input_tokens", "cache_read_input_tokens",
  "started_at", "first_token_at", "completed_at", "duration_ms", "time_to_first_token_ms",
];
// O1/O2:可选列缺失只降级(静默走回退路径),计 warn,不影响退出码
// trace_id 缺失→子代理归因关闭;turn_id 缺失→轮均不可用(本轮/会话累计不受影响,见 token-rate 内层降级)
// v0.4.1 起轮次/会话累计改由 model_usage 聚合,turn_usage 表不再被读取——以下检查仅供参考
const TURN_COLS = [
  "session_id", "status", "input_tokens", "output_tokens", "reasoning_tokens",
  "cache_creation_input_tokens", "cache_read_input_tokens",
  "computed_total_tokens", "duration_ms", "model_request_count", "completed_at",
];

function nodeVersionCheck() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  const ok = maj > 22 || (maj === 22 && min >= 5);
  return {
    name: "Node 版本",
    level: "error",
    ok,
    detail: `当前 ${process.versions.node},需要 ≥ 22.5(内置 node:sqlite)`,
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
    const cols = db.prepare("PRAGMA table_info(model_usage)").all().map((c) => c.name);
    if (!cols.length) {
      return [core(false, "model_usage 表不存在", "ZCode 版本过旧或尚未产生用量数据;发一条消息后再试")];
    }
    const missing = REQUIRED_COLS.filter((c) => !cols.includes(c));
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
      `表结构完整;最近完成样本 ${ageMin == null ? "无" : ageMin + " 分钟前"}`,
      null)];
    out.push(cols.includes("trace_id")
      ? { name: "子代理归因列(trace_id)", level: "warn", ok: true, detail: "存在,子代理可并入会话统计", hint: null }
      : { name: "子代理归因列(trace_id)", level: "warn", ok: false, detail: "列缺失,子代理无法归因(会话均/累计退回纯主对话口径)", hint: "旧库无此列;升级 ZCode 后恢复,核心速率不受影响" });
    out.push(cols.includes("turn_id")
      ? { name: "轮次关联列(turn_id)", level: "warn", ok: true, detail: "存在,轮均速率可用", hint: null }
      : { name: "轮次关联列(turn_id)", level: "warn", ok: false, detail: "列缺失,上轮均不可用(上轮/会话累计仍可用)", hint: "旧库无此列;升级 ZCode 后恢复" });
    return out;
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
  } finally {
    db.close();
  }
}

function stateFileCheck() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const age = Math.round((Date.now() - (st.ts || 0)) / 60000);
    return {
      name: "会话状态文件",
      level: "error",
      ok: true,
      detail: `存在,sessionId=${String(st.sessionId).slice(0, 8)}…,更新于 ${age} 分钟前`,
      hint: null,
    };
  } catch {
    return {
      name: "会话状态文件",
      level: "error",
      ok: false,
      detail: "不存在或不可读",
      hint: "钩子未运行过:确认插件已安装且会话已重开(钩子在安装/更新后需新会话才注册)",
    };
  }
}

function configCheck() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const off = !parseBoolLoose(cfg.tokenRateLine, true);
    return {
      name: "配置文件",
      level: "error",
      ok: true,
      detail: off ? "tokenRateLine=false,速率行注入已关闭(属预期)" : "已读取,注入开启",
      hint: off ? "如需恢复注入,删除该文件或改回 true" : null,
    };
  } catch {
    return { name: "配置文件", level: "error", ok: true, detail: "未配置(默认注入开启)", hint: null };
  }
}

// O7 复用口径:doctor 不依赖 token-rate(旧 Node 兼容),此处保留最小布尔解析副本
function parseBoolLoose(v, def) {
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["false", "0", "off", "no", "disable", "disabled"].includes(s)) return false;
    if (["true", "1", "on", "yes", "enable", "enabled"].includes(s)) return true;
  }
  return def;
}

export async function runDoctor() {
  const results = [];
  results.push(nodeVersionCheck());
  results.push(...(await dbCheck()));
  results.push(await turnTableCheck());
  results.push(stateFileCheck());
  results.push(configCheck());
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
