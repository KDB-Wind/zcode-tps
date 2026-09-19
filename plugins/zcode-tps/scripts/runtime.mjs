// Shared contracts; deliberately independent of node:sqlite so doctor can explain unsupported runtimes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const validId = value => typeof value === "string" && value.trim().length > 0;
// Match JavaScript trim whitespace without changing nonblank identifiers or relying on SQLite's space-only trim.
const ID_WHITESPACE = "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
export const validIdSql = column => `typeof(${column}) = 'text' AND length(trim(${column}, ${ID_WHITESPACE})) > 0`;
// NULL/空白文本归一为统一标签的 SQL 表达式(空白集与 validIdSql 一致);标签必须是带引号的 SQL 字面量。
export const blankLabelSql = (column, label) => `COALESCE(NULLIF(trim(${column}, ${ID_WHITESPACE}), ''), ${label})`;
export const parseJson = raw => JSON.parse(raw.replace(/^\uFEFF/, ""));

export const REQUIRED_COLS = [
  "session_id", "status", "query_source", "model_id", "output_tokens", "reasoning_tokens",
  "input_tokens", "cache_read_input_tokens", "started_at", "first_token_at",
  "completed_at", "duration_ms", "time_to_first_token_ms",
];
export const OPTIONAL_COLS = ["turn_id", "cache_creation_input_tokens", "trace_id"];
export function supportsNode(version) {
  const [major, minor] = version.split(".").map(Number);
  return major >= 24 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
}
export function inspectSchema(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(model_usage)").all().map(c => c.name));
  return { columns, missing: REQUIRED_COLS.filter(c => !columns.has(c)),
    warnings: OPTIONAL_COLS.filter(c => !columns.has(c)).map(c => `model_usage 缺少可选列 ${c}`) };
}

export function parseBool(v, def) {
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

export const stateFile = () => process.env.ZCODE_TPS_LAST_SESSION || path.join(os.homedir(), ".zcode", "zcode-tps.last-session.json");
// Stop hook 已展示水位(coverage.lastCompletedAt):回合结束显示行与发消息注入的去重依据
export const lastShownFile = () => process.env.ZCODE_TPS_LAST_SHOWN || path.join(os.homedir(), ".zcode", "zcode-tps.last-shown.json");
// turnEndLine 两态:false/off 关闭;true/"notify"/"toast" 回合结束弹系统通知。
// (曾经的 block 续跑补行形态已按用户裁决移除:ZCode 会把续跑回合折叠为摘要条,回答主体不可见。)
export function resolveTurnEndMode(v) {
  if (v === true || v === 1) return "notify";
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "on", "yes", "notify", "toast"].includes(s)) return "notify";
  }
  return "off";
}
export const configFile = () => process.env.ZCODE_TPS_CONFIG || path.join(os.homedir(), ".zcode", "zcode-tps.config.json");
export function healthFile(sessionId) {
  const base = process.env.ZCODE_TPS_HEALTH || `${stateFile()}.health.json`;
  return validId(sessionId) ? `${base}.${createHash("sha256").update(sessionId).digest("hex")}.json` : base;
}

export function readConfig() {
  let raw;
  try { raw = fs.readFileSync(configFile(), "utf8"); }
  catch (e) { if (e.code === "ENOENT") return {}; throw e; }
  const cfg = parseJson(raw);
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("配置必须为 JSON 对象");
  return cfg;
}

export function querySettings(env = process.env) {
  const positive = (key, fallback) => {
    if (env[key] === undefined) return fallback;
    const n = Number(env[key]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} 必须为有限正数`);
    return n;
  };
  const history = positive("TOKEN_RATE_HIST", 60);
  if (!Number.isInteger(history) || history > 1000) throw new Error("TOKEN_RATE_HIST 必须为 1–1000 的整数");
  const min = positive("TOKEN_RATE_MIN_MS", 500);
  const max = positive("TOKEN_RATE_MAX_MS", 3_600_000);
  if (min >= max) throw new Error("TOKEN_RATE_MIN_MS 必须小于 TOKEN_RATE_MAX_MS");
  return { history, min, max };
}

// 时区显示:数据库时间戳无时区语义,UTC 字符串只是 toISOString() 的格式化选择。
// 默认 Asia/Shanghai;配置可设 "UTC"、"system"(跟随系统)或任意 IANA 时区名。
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

function isValidZone(zone) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; }
  catch { return false; }
}

// 无效配置回退默认并推入 warnings(调用方提供数组时),时间显示永不因配置失败。
export function resolveTimezone(value, warnings = null) {
  const raw = typeof value === "string" ? value.trim() : "";
  let candidate = raw || DEFAULT_TIMEZONE;
  if (candidate.toLowerCase() === "system") {
    let sys;
    try { sys = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
    candidate = sys && isValidZone(sys) ? sys : DEFAULT_TIMEZONE;
  }
  if (!isValidZone(candidate)) {
    if (Array.isArray(warnings)) warnings.push(`timezone 配置无效:${raw},已回退 ${DEFAULT_TIMEZONE}`);
    candidate = DEFAULT_TIMEZONE;
  }
  return isValidZone(candidate) ? candidate : "UTC";
}

const zoneFormatterCache = new Map();
function zoneFormatter(tz, withDate) {
  const key = `${tz}|${withDate ? "d" : "t"}`;
  let f = zoneFormatterCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12: false,
      ...(withDate ? { year: "numeric", month: "2-digit", day: "2-digit" } : {}),
      hour: "2-digit", minute: "2-digit", second: "2-digit" });
    zoneFormatterCache.set(key, f);
  }
  return f;
}

// 毫秒时间戳 → 配置时区的 "YYYY-MM-DD HH:mm:ss";withDate=false 仅 "HH:mm:ss"。非有限时间返回 null。
export function formatInZone(ms, tz, withDate = true) {
  if (!Number.isFinite(ms)) return null;
  const zone = resolveTimezone(tz);
  const parts = {};
  for (const p of zoneFormatter(zone, withDate).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const time = `${parts.hour}:${parts.minute}:${parts.second}`;
  return withDate ? `${parts.year}-${parts.month}-${parts.day} ${time}` : time;
}

// 时区相对 UTC 的偏移标签,如 "UTC+8"、"UTC+5:30";零偏移为 "UTC"。
export function zoneOffsetLabel(tz, ms = Date.now()) {
  const zone = resolveTimezone(tz);
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" });
    const name = f.formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "";
    const label = name === "GMT" ? "UTC" : name.replace(/^GMT/, "UTC");
    return label === "UTC+0" ? "UTC" : label;
  } catch { return "UTC"; }
}

export function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value));
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

export function recordHealth(update) {
  const file = healthFile(update.sessionId);
  try {
    let previous = {};
    try { previous = parseJson(fs.readFileSync(file, "utf8")) || {}; } catch {}
    if (previous.sessionId !== update.sessionId) previous = {};
    // A late completion must not replace a newer run already observed for this session.
    if (update.status !== "running" && previous.runId && previous.runId !== update.runId) return;
    const record = { ...previous, ...update, ts: Date.now() };
    writeState(file, record);
    if (file !== healthFile()) {
      let latest = {};
      try { latest = parseJson(fs.readFileSync(healthFile(), "utf8")) || {}; } catch {}
      if (!latest.startedAt || latest.startedAt <= record.startedAt) writeState(healthFile(), record);
    }
  } catch {} // Diagnostics must not break the hook JSON contract.
}

export function startHealth(sessionId) {
  const run = { sessionId: validId(sessionId) ? sessionId : null,
    runId: randomUUID(), pid: process.pid, startedAt: Date.now() };
  recordHealth({ ...run, status: "running", durationMs: null, sampledAt: null, error: null, warnings: [] });
  return run;
}
