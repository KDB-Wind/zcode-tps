#!/usr/bin/env node
// SessionStart hook:
// 1) 记录"用户最后所处的会话"到状态文件(供 /tps-doctor 自检钩子是否已注册)
// 2) 注入一行使用提示(严格 JSON 输出)

import { readConfig, parseBool, stateFile, writeState, validId } from "../scripts/runtime.mjs";

const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
if (validId(sid)) {
  try {
    writeState(stateFile(), { sessionId: sid, ts: Date.now(), source: "session-start" });
  } catch {}
}

let hint = "";
try {
  if (parseBool(readConfig().tokenRateLine, true)) {
    hint = "[zcode-tps] 已加载。仅在本条用户消息附带新速率行时,在回复末尾原样引用该行,不要复用历史数字。数据为发送消息时库内留存的已完成请求,通常对应上一轮。命令:/tps 查看报表、/tps-doctor 自检。";
  }
} catch {} // Config problems are diagnosed by prompt-submit/doctor.

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: hint,
    },
  })
);
