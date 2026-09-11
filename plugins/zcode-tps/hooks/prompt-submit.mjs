#!/usr/bin/env node
// UserPromptSubmit hook: 每次用户发消息时
// 1) 记录"用户最后所处的会话"到状态文件(切会话后第一条消息即跟随)
// 2) 从 ZCode usage 数据库读取真实 token 速率/用量,注入为上下文。输出必须为严格 JSON。
// 可选配置 ~/.zcode/zcode-tps.config.json:{"tokenRateLine": false} 可关闭速率行注入。

import { readConfig, parseBool, stateFile, writeState, recordHealth, startHealth, validId } from "../scripts/runtime.mjs";

const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
const run = startHealth(sid);
const complete = update => recordHealth({ ...run, ...update, durationMs: Date.now() - run.startedAt });
if (validId(sid)) {
  try {
    writeState(stateFile(), { sessionId: sid, ts: Date.now(), source: "prompt-submit" });
  } catch {}
}

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
  } else {
    // includeSubagents 默认开启(缺省视为 true):trace 归因把主会话派生的子代理请求并入会话统计
    // rateLineFields 自定义速率行字段(默认 rates/session/cache 三段,"all"=全部六段)
    const { query, formatLine, resolveRateFields } = await import("../scripts/token-rate.mjs");
    const fields = resolveRateFields(cfg.rateLineFields);
    const result = query(sid || null, { includeSubagents: parseBool(cfg.includeSubagents, true) });
    const sampleHint = `\n[zcode-tps 采样时间:${new Date(result.sampledAt).toISOString()};统计仅覆盖库内留存的已完成请求,最近轮次可能未结束。]`;
    const context = formatLine(result, fields) + sampleHint + QUOTE_HINT;
    complete({ status: "ok", resolvedSessionId: result.sessionId,
      lastSuccessAt: Date.now(), sampledAt: result.sampledAt, error: null, warnings: result.warnings });
    emit(context);
  }
} catch (e) {
  complete({ status: "error", error: e.message, warnings: [] });
  emit("");
}
