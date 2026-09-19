#!/usr/bin/env node
// Stop hook:回合结束时弹系统通知显示速率行,补上单轮会话的显示空窗。
// 背景:UserPromptSubmit 采样天然滞后一轮;用户发一条消息让 agent 执行长任务时,
// 该轮回复末尾看不到任何统计。Stop 时机拿到的恰是刚结束这轮的完整数据。
// 设计约束(2026-09-19 源码确证):ZCode 的 Stop hook 若驱动模型续跑(block),
// 会把整个回合折叠为"已工作"摘要条——统计可见而回答主体被藏起,已按用户裁决弃用该形态。
// 因此本 hook 只发系统通知(Windows toast / macOS 通知中心 / Linux notify-send,零依赖),
// 不动会话流、零续跑调用;对话流内的历史记录仍由 UserPromptSubmit 注入行负责(照常注入)。
// 配置 turnEndLine(默认 false):true/"notify"/"toast" 开启通知,false/off 关闭。
// 数据未前进(水位 coverage.lastCompletedAt 未更新)时不重复通知;任何失败静默放行,绝不阻塞回合结束。
import fs from "node:fs";
import { spawn } from "node:child_process";
import { readConfig, parseBool, parseJson, resolveTurnEndMode, lastShownFile, writeState, recordHealth, startHealth, validId } from "../scripts/runtime.mjs";

async function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {};
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function readShown(file) {
  try {
    const v = parseJson(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

// 系统通知:detached spawn,hook 立即退出不等结果;任何平台失败静默。
// 测试与 CI 设 ZCODE_TPS_NOTIFY_SUPPRESS=1 跳过真实弹窗。
// Windows 首次通知前写 HKCU 注册表开启 PowerShell AUMID 的横幅权限(新机器默认可能为关,
// 静默 toast 会被丢弃);仅 ensurePermission=true(首条通知)时写入,之后尊重用户在系统设置里的开关。
function sendNotify(line, ensurePermission) {
  if (process.env.ZCODE_TPS_NOTIFY_SUPPRESS === "1") return;
  try {
    let command, args;
    if (process.platform === "win32") {
      const aumid = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
      // Windows.UI.Notifications 免依赖 toast;AppId 复用 PowerShell 的已注册身份,否则不显示。
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
      command = "powershell";
      args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64")];
    } else if (process.platform === "darwin") {
      command = "osascript";
      args = ["-e", `display notification ${JSON.stringify(line).replace(/"/g, '\\"')} with title "zcode-tps"`];
    } else {
      command = "notify-send";
      args = ["zcode-tps", line];
    }
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

const input = await readStdinJson();
const sid = input.session_id || process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
const run = startHealth(sid);
const complete = update => recordHealth({ ...run, hook: "stop", ...update, durationMs: Date.now() - run.startedAt });

try {
  const cfg = readConfig();
  if (!parseBool(cfg.tokenRateLine, true) || resolveTurnEndMode(cfg.turnEndLine) !== "notify") {
    complete({ status: "disabled", error: null, warnings: [] });
    process.exit(0);
  }
  const file = lastShownFile();
  const shown = readShown(file);
  const { query, formatLine, resolveRateFields } = await import("../scripts/token-rate.mjs");
  const result = query(sid || null, { includeSubagents: parseBool(cfg.includeSubagents, true), timezone: cfg.timezone });
  const lastCompletedAt = result.coverage?.lastCompletedAt ?? null;
  // 无会话/无已完成请求时不通知;同会话数据无新增(水位未前进)也不重复通知
  if (!result.sessionId || lastCompletedAt == null ||
      (shown && shown.sessionId === result.sessionId && Number(shown.shownAt) >= lastCompletedAt)) {
    complete({ status: "ok", resolvedSessionId: result.sessionId, lastSuccessAt: Date.now(),
      sampledAt: result.sampledAt, error: null, warnings: result.warnings });
    process.exit(0);
  }
  // 先落水位再弹通知:写失败走外层 catch 静默放行,不会出现"无水位的重复通知"
  writeState(file, { sessionId: result.sessionId, shownAt: lastCompletedAt, ts: Date.now(), source: "stop" });
  complete({ status: "ok", resolvedSessionId: result.sessionId, lastSuccessAt: Date.now(),
    sampledAt: result.sampledAt, error: null, warnings: result.warnings });
  sendNotify(formatLine(result, resolveRateFields(cfg.rateLineFields)), !shown);
} catch {
  process.exit(0);
}
