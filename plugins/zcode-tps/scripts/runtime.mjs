// Shared contracts; deliberately independent of node:sqlite so doctor can explain unsupported runtimes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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
// 健康记录按 会话+hook 类型 分文件(F02):Stop 的 disabled/error 不再覆盖 prompt 的诊断,
// 交错完成的两个 hook 互不合并。hook 为空时保留旧版"仅按会话"路径(迁移读,不再写入)。
export const HOOK_PROMPT = "prompt";
export const HOOK_STOP = "stop";
export function healthFile(sessionId, hook) {
  const base = process.env.ZCODE_TPS_HEALTH || `${stateFile()}.health.json`;
  let suffix = "";
  if (validId(sessionId)) suffix += `.${createHash("sha256").update(sessionId).digest("hex")}`;
  if (hook) suffix += `.${hook}`;
  return suffix ? `${base}${suffix}.json` : base;
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

// ECMAScript 可表示的最大日期毫秒(±8.64e15)。超出范围的有限数值 new Date() 得 Invalid Date,
// Intl 格式化抛 RangeError "Invalid time value" —— 一条坏 completed_at 不能拖垮整份报表(F08)。
export const MAX_DATE_MS = 8_640_000_000_000_000;
export const validEpoch = ms => typeof ms === "number" && Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS;

// 毫秒时间戳 → 配置时区的 "YYYY-MM-DD HH:mm:ss";withDate=false 仅 "HH:mm:ss"。
// 非有限时间或超出 Date 可表示范围返回 null(不抛错,F08)。
export function formatInZone(ms, tz, withDate = true) {
  if (!validEpoch(ms)) return null;
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
  // F02:文件按 会话+hook 隔离;update.hook 缺失时退回旧版会话文件(兼容读,不推荐新写入)
  const file = healthFile(update.sessionId, update.hook);
  try {
    let previous = {};
    try { previous = parseJson(fs.readFileSync(file, "utf8")) || {}; } catch {}
    if (previous.sessionId !== update.sessionId || (update.hook && previous.hook !== update.hook)) previous = {};
    // A late completion must not replace a newer run already observed for this session+hook.
    if (update.status !== "running" && previous.runId && previous.runId !== update.runId) return;
    const record = { ...previous, ...update, ts: Date.now() };
    writeState(file, record);
  } catch {} // Diagnostics must not break the hook JSON contract.
}

export function startHealth(sessionId, hook = null) {
  const run = { sessionId: validId(sessionId) ? sessionId : null, hook,
    runId: randomUUID(), pid: process.pid, startedAt: Date.now() };
  recordHealth({ ...run, status: "running", durationMs: null, sampledAt: null, error: null, warnings: [] });
  return run;
}

// ---- 系统通知(Stop hook 用;构造与提交分离,便于单测命令构造) ----
// Windows:Windows.UI.Notifications 免依赖 toast,AppId 复用 PowerShell 已注册 AUMID;
// 首条通知前写 HKCU 开启横幅权限(新机器默认可能为关,静默 toast 被丢弃;仅 ensurePermission=true 时写,之后尊重用户设置)。
// macOS:AppleScript `on run` + argv 传参 —— 文本经参数传入,不做字符串转义(F04:JSON 转义会破坏 AppleScript 字符串边界)。
// Linux:notify-send 参数即文本。
export function buildNotifyCommand(line, { ensurePermission = false, platform = process.platform } = {}) {
  // 诊断/测试用覆盖:指定通知可执行文件(如缺失的路径)可确定性验证提交失败路径;
  // 覆盖时参数形如 notify-send(标题在前),不构造平台脚本。
  const override = process.env.ZCODE_TPS_NOTIFY_BIN;
  if (override) return { command: override, args: ["zcode-tps", line] };
  if (platform === "win32") {
    const aumid = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
    const perm = ensurePermission
      ? "$p='HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\" + aumid + "';" +
        "if(-not(Test-Path $p)){New-Item $p -Force|Out-Null};" +
        "Set-ItemProperty $p -Name Enabled -Value 1 -Type DWord;" +
        "Set-ItemProperty $p -Name ShowBanner -Value 1 -Type DWord;" +
        "Set-ItemProperty $p -Name ShowInActionCenter -Value 1 -Type DWord;"
      : "";
    const script =
      perm +
      "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null;" +
      "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);" +
      "$x=$t.GetElementsByTagName('text').Item(0);$x.AppendChild($t.CreateTextNode('zcode-tps'))|Out-Null;" +
      "$x=$t.GetElementsByTagName('text').Item(1);$x.AppendChild($t.CreateTextNode(" + JSON.stringify(line) + "))|Out-Null;" +
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + aumid + "').Show([Windows.UI.Notifications.ToastNotification]::new($t))";
    return { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")] };
  }
  if (platform === "darwin") {
    return { command: "osascript", args: [
      "-e", "on run {message, title}\n display notification message with title title\n end run",
      line, "zcode-tps",
    ] };
  }
  return { command: "notify-send", args: ["zcode-tps", line] };
}

// 提交通知并如实报告提交结果(F05):detached 子进程不阻塞回合,但等待有界的拉起确认——
// spawn 成功/"error"(如命令缺失)。返回:
//   "suppressed"(测试抑制)/ "submitted"(子进程已拉起)/ "unknown"(限时内未确认,按已提交处理但如实标注)/
//   "failed:<原因>"(拉起失败;水位不前进,下次 Stop 自然重试)
// 提交成功只承诺命令已提交,不保证用户看到横幅(通知权限由系统与用户设置决定)。
export function submitNotify({ line, ensurePermission = false, confirmMs = 250 } = {}) {
  if (process.env.ZCODE_TPS_NOTIFY_SUPPRESS === "1") return Promise.resolve("suppressed");
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (status) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(status); } };
    try {
      const { command, args } = buildNotifyCommand(line, { ensurePermission });
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
      timer = setTimeout(() => done("unknown"), confirmMs);
      child.once("spawn", () => done("submitted"));
      child.once("error", (e) => done(`failed:${e?.code ?? e?.message ?? "spawn error"}`));
      child.unref();
    } catch (e) {
      done(`failed:${e?.message ?? e}`);
    }
  });
}
