#!/usr/bin/env node
// UserPromptSubmit hook: 每次用户发消息时
// 1) 记录"用户最后所处的会话"到状态文件(切会话后第一条消息即跟随)
// 2) 从 ZCode usage 数据库读取真实 token 速率/用量,注入为上下文。输出必须为严格 JSON。
// 可选配置 ~/.zcode/zcode-tps.config.json:{"tokenRateLine": false} 可关闭速率行注入。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, formatLine, parseBool, resolveRateFields } from "../scripts/token-rate.mjs";

const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
if (sid) {
  try {
    const file = process.env.ZCODE_TPS_LAST_SESSION ||
      path.join(os.homedir(), ".zcode", "zcode-tps.last-session.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ sessionId: sid, ts: Date.now(), source: "prompt-submit" })
    );
  } catch {}
}

const QUOTE_HINT =
  "\n(用户要求:每条回复的末尾都用 Markdown 引用块原样附上上面整行内容——即在新行行首加「> 」再跟内容,使其渲染为浅色引用样式,不要省略、不要改写数字,引用块里只放这一行,不要追加任何链接或后缀)";

function readConfig() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".zcode", "zcode-tps.config.json"), "utf8")
    );
  } catch {
    return {};
  }
}

function emit(ctx) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } })
  );
}

try {
  const cfg = readConfig();
  if (!parseBool(cfg.tokenRateLine, true)) {
    emit("");
  } else {
    // includeSubagents 默认开启(缺省视为 true):trace 归因把主会话派生的子代理请求并入会话统计
    // rateLineFields 自定义速率行字段(默认 rates/session/cache 三段,"all"=全部六段)
    const fields = resolveRateFields(cfg.rateLineFields);
    emit(formatLine(query(sid || null, { includeSubagents: parseBool(cfg.includeSubagents, true) }), fields) + QUOTE_HINT);
  }
} catch {
  emit("");
}
