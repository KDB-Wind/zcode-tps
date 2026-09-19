#!/usr/bin/env node
// UserPromptSubmit hook: 每次用户发消息时
// 1) 记录"用户最后所处的会话"到状态文件(切会话后第一条消息即跟随)
// 2) 从 ZCode usage 数据库读取真实 token 速率/用量,注入为上下文。输出必须为严格 JSON。
// 可选配置 ~/.zcode/zcode-tps.config.json:{"tokenRateLine": false} 可关闭速率行注入;
// {"turnEndLine": true} 改由回合结束(Stop hook)显示,本 hook 让位不再注入(见下方分支)。

import fs from "node:fs";
import { readConfig, parseBool, resolveTurnEndMode, stateFile, lastShownFile, writeState, recordHealth, startHealth, validId } from "../scripts/runtime.mjs";

const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
const run = startHealth(sid);
const complete = update => recordHealth({ ...run, ...update, durationMs: Date.now() - run.startedAt });
if (validId(sid)) {
  try {
    writeState(stateFile(), { sessionId: sid, ts: Date.now(), source: "prompt-submit" });
  } catch {}
}
// Stop hook 的补行续跑结束后,ZCode 实测不会再触发第二次 Stop(2026-09-19 本机验证),
// 水位 pending 标记会残留并吃掉下一回合的显示。每条用户消息时兜底复位;Stop 侧的
// 续跑放行分支保留,两者语义一致(block 仍至多一次)。复位与显示开关无关,必须无条件执行。
try {
  const shownPath = lastShownFile();
  const shown = JSON.parse(fs.readFileSync(shownPath, "utf8"));
  if (shown && shown.pending === true) {
    writeState(shownPath, { ...shown, pending: false, ts: Date.now(), source: "prompt-submit" });
  }
} catch {}

const QUOTE_HINT =
  "\n[zcode-tps 显示规则:仅本条回复末尾用 Markdown 引用块原样附上本次上下文的首行,不要附上采样说明。数字是数据库采样值,勿改写。后续消息若未提供新速率行,不要复用历史行。]";

function emit(ctx) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } })
  );
}

try {
  const cfg = readConfig();
  if (!parseBool(cfg.tokenRateLine, true)) {
    complete({ status: "disabled", error: null, warnings: [] });
    emit("");
  } else if (resolveTurnEndMode(cfg.turnEndLine) !== "off") {
    // 回合结束行(turnEndLine 的 block/notify 模式)接管显示:发消息时的注入采样滞后一轮,
    // 会与回合结束的显示重复,故让位。会话识别状态与健康记录仍照常写入。
    complete({ status: "disabled", error: null, warnings: [] });
    emit("");
  } else {
    // includeSubagents 默认开启(缺省视为 true):trace 归因把主会话派生的子代理请求并入会话统计
    // rateLineFields 自定义速率行字段(默认 rates/decode/session/cache 4段,"all"=全部8段)
    // timezone 显示时区(默认 Asia/Shanghai,可设 "UTC"/"system"/IANA 名,环境变量 ZCODE_TPS_TIMEZONE 优先)
    const { query, formatLine, resolveRateFields } = await import("../scripts/token-rate.mjs");
    const fields = resolveRateFields(cfg.rateLineFields);
    const result = query(sid || null, { includeSubagents: parseBool(cfg.includeSubagents, true), timezone: cfg.timezone });
    const sampleHint = `\n[zcode-tps 采样时间:${result.sampledAtText ?? new Date(result.sampledAt).toISOString()}(${result.timezone ?? "UTC"} ${result.utcOffset ?? "UTC"});统计仅覆盖库内留存的已完成请求,最近轮次可能未结束。]`;
    const context = formatLine(result, fields) + sampleHint + QUOTE_HINT;
    complete({ status: "ok", resolvedSessionId: result.sessionId,
      lastSuccessAt: Date.now(), sampledAt: result.sampledAt, error: null, warnings: result.warnings });
    emit(context);
  }
} catch (e) {
  complete({ status: "error", error: e.message, warnings: [] });
  emit("");
}
