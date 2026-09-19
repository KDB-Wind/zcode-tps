#!/usr/bin/env node
// Stop hook:回合结束时(而非下一次发消息时)显示速率行,补上单轮会话的显示空窗。
// 背景:UserPromptSubmit 采样天然滞后一轮;用户发一条消息让 agent 执行长任务时,该轮回复
// 末尾没有任何统计,要等第二条消息才看得到。Stop 时机拿到的恰是刚结束这轮的完整数据。
// 机制:ZCode Stop hook 接受 {"decision":"block","reason":...}——reason 作为指令驱动模型
// 在本轮回复末尾原样补一行统计后立即结束。代价是每次显示多一次小模型调用,因此默认关闭:
// 配置 ~/.zcode/zcode-tps.config.json 写 {"turnEndLine": true} 开启;主开关 tokenRateLine:false 时同样停用。
// 开启后 prompt-submit 不再注入显示行(其采样滞后一轮,会与本行重复),显示职责整体移到回合结束。
// 防循环(双保险,任一命中即放行;循环=hook 反复 block 导致模型反复续跑):
// 1) 输入 stop_hook_active=true(宿主标记本次结束已是 Stop 续跑的结果);
// 2) last-shown 水位文件的 pending 标记:本 hook block 过一次后,下一次 Stop 一律放行。
// 任何失败(配置/查询/写入)一律静默放行,绝不因本 hook 阻塞或拖慢回合结束。
import fs from "node:fs";
import { readConfig, parseBool, parseJson, lastShownFile, writeState, recordHealth, startHealth, validId } from "../scripts/runtime.mjs";

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

const input = await readStdinJson();
const sid = input.session_id || process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
const run = startHealth(sid);
const complete = update => recordHealth({ ...run, hook: "stop", ...update, durationMs: Date.now() - run.startedAt });

try {
  const cfg = readConfig();
  if (!parseBool(cfg.tokenRateLine, true) || !parseBool(cfg.turnEndLine, false)) {
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
  if (shown?.pending) {
    writeState(file, { ...shown, pending: false, ts: Date.now() });
    complete({ status: "ok", resolvedSessionId: validId(sid) ? sid : null, error: null, warnings: [] });
    process.exit(0);
  }
  const { query, formatLine, resolveRateFields } = await import("../scripts/token-rate.mjs");
  const result = query(sid || null, { includeSubagents: parseBool(cfg.includeSubagents, true), timezone: cfg.timezone });
  const lastCompletedAt = result.coverage?.lastCompletedAt ?? null;
  // 无会话/无已完成请求时不驱动模型补行;同会话数据无新增(水位未前进)也不重复显示
  if (!result.sessionId || lastCompletedAt == null ||
      (shown && shown.sessionId === result.sessionId && Number(shown.shownAt) >= lastCompletedAt)) {
    complete({ status: "ok", resolvedSessionId: result.sessionId, lastSuccessAt: Date.now(),
      sampledAt: result.sampledAt, error: null, warnings: result.warnings });
    process.exit(0);
  }
  // 先落水位再输出:writeState 失败会走外层 catch 静默放行,不会出现"无水位的 block"
  writeState(file, { sessionId: result.sessionId, shownAt: lastCompletedAt, pending: true, ts: Date.now(), source: "stop" });
  complete({ status: "ok", resolvedSessionId: result.sessionId, lastSuccessAt: Date.now(),
    sampledAt: result.sampledAt, error: null, warnings: result.warnings });
  const line = formatLine(result, resolveRateFields(cfg.rateLineFields));
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: "本回合已结束。请立即在回复末尾用 Markdown 引用块原样附上下面这行统计(数字是数据库采样值,勿改写、勿计算、不要附采样说明),除该引用块外不输出任何其他内容,不要再调用任何工具,然后结束。\n> " + line,
  }));
} catch {
  process.exit(0);
}
