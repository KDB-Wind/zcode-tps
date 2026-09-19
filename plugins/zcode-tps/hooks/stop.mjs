#!/usr/bin/env node
// Stop hook:回合结束时(而非下一次发消息时)显示速率行,补上单轮会话的显示空窗。
// 背景:UserPromptSubmit 采样天然滞后一轮;用户发一条消息让 agent 执行长任务时,该轮回复
// 末尾没有任何统计,要等第二条消息才看得到。Stop 时机拿到的恰是刚结束这轮的完整数据。
// 两种模式(turnEndLine,默认 false):
//   true/"block" — 输出 {"decision":"block","reason":...} 让模型在本轮回复末尾补一行统计;
//                  代价是一次续跑模型调用,且 ZCode 会把该回合折叠为"已工作"摘要条。
//   "notify"     — 弹系统通知(Windows toast / macOS osascript / Linux notify-send)显示统计;
//                  完全不动会话流,零续跑调用。数据未前进时不重复弹。
// ZCode 平台特性(2026-09-19 源码确证):Stop block 续跑结束后不会再触发第二次 Stop;
// systemMessage 字段在不 block 时被忽略,纯 additionalContext 只写消息历史不显示——
// 因此"会话流内立即显示"只有续跑一条路,避免折叠只能走通知。
// 防循环(仅 block 模式需要,双保险任一命中即放行;循环=反复 block 导致反复续跑):
// 1) 输入 stop_hook_active=true(宿主标记本次结束已是 Stop 续跑的结果);
// 2) last-shown 水位文件的 pending 标记:block 过一次后,下一次 Stop 一律放行;
//    续跑收尾可能不触发第二次 Stop,由 prompt-submit 在每条用户消息时兜底复位。
// 任何失败(配置/查询/通知/写入)一律静默放行,绝不阻塞或拖慢回合结束。
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
function sendNotify(line) {
  if (process.env.ZCODE_TPS_NOTIFY_SUPPRESS === "1") return;
  try {
    let command, args;
    if (process.platform === "win32") {
      // Windows.UI.Notifications 免依赖 toast;AppId 复用 PowerShell 的已注册身份,否则不显示。
      const script =
        "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null;" +
        "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);" +
        "$x=$t.GetElementsByTagName('text').Item(0);$x.AppendChild($t.CreateTextNode('zcode-tps'))|Out-Null;" +
        "$x=$t.GetElementsByTagName('text').Item(1);$x.AppendChild($t.CreateTextNode(" + JSON.stringify(line) + "))|Out-Null;" +
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($t))";
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
  const mode = resolveTurnEndMode(cfg.turnEndLine);
  if (!parseBool(cfg.tokenRateLine, true) || mode === "off") {
    complete({ status: "disabled", error: null, warnings: [] });
    process.exit(0);
  }
  if (input.stop_hook_active === true) {
    complete({ status: "ok", resolvedSessionId: validId(sid) ? sid : null, error: null, warnings: [] });
    process.exit(0);
  }
  const file = lastShownFile();
  const shown = readShown(file);
  // pending:上一次 Stop 已 block 过。补行续跑正常结束时本分支放行并复位;若 ZCode 未再触发
  // Stop(实测行为),prompt-submit 会在下一条用户消息时兜底复位,不会永久吃掉显示。
  // notify 模式从不写 pending,不受影响。
  if (shown?.pending) {
    writeState(file, { ...shown, pending: false, ts: Date.now() });
    complete({ status: "ok", resolvedSessionId: validId(sid) ? sid : null, error: null, warnings: [] });
    process.exit(0);
  }
  const { query, formatLine, resolveRateFields } = await import("../scripts/token-rate.mjs");
  const result = query(sid || null, { includeSubagents: parseBool(cfg.includeSubagents, true), timezone: cfg.timezone });
  const lastCompletedAt = result.coverage?.lastCompletedAt ?? null;
  // 无会话/无已完成请求时不显示;同会话数据无新增(水位未前进)也不重复显示
  if (!result.sessionId || lastCompletedAt == null ||
      (shown && shown.sessionId === result.sessionId && Number(shown.shownAt) >= lastCompletedAt)) {
    complete({ status: "ok", resolvedSessionId: result.sessionId, lastSuccessAt: Date.now(),
      sampledAt: result.sampledAt, error: null, warnings: result.warnings });
    process.exit(0);
  }
  const line = formatLine(result, resolveRateFields(cfg.rateLineFields));
  if (mode === "notify") {
    // 先落水位再弹通知:写失败走外层 catch 放行,不会出现"无水位的重复通知";不写 pending(notify 无循环风险)
    writeState(file, { sessionId: result.sessionId, shownAt: lastCompletedAt, pending: false, ts: Date.now(), source: "stop-notify" });
    complete({ status: "ok", resolvedSessionId: result.sessionId, lastSuccessAt: Date.now(),
      sampledAt: result.sampledAt, error: null, warnings: result.warnings });
    sendNotify(line);
    process.exit(0);
  }
  // block 模式:先落水位再输出,writeState 失败会走外层 catch 静默放行,不会出现"无水位的 block"
  writeState(file, { sessionId: result.sessionId, shownAt: lastCompletedAt, pending: true, ts: Date.now(), source: "stop" });
  complete({ status: "ok", resolvedSessionId: result.sessionId, lastSuccessAt: Date.now(),
    sampledAt: result.sampledAt, error: null, warnings: result.warnings });
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: "本回合已结束。请立即在回复末尾用 Markdown 引用块原样附上下面这行统计(数字是数据库采样值,勿改写、勿计算、不要附采样说明),除该引用块外不输出任何其他内容,不要再调用任何工具,然后结束。\n> " + line,
  }));
} catch {
  process.exit(0);
}
