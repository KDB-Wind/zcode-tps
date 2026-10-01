#!/usr/bin/env node
// Stop hook:回合结束时弹系统通知显示速率行,补上单轮会话的显示空窗。
// 背景:UserPromptSubmit 采样天然滞后一轮;用户发一条消息让 agent 执行长任务时,
// 该轮回复末尾看不到任何统计。Stop 时机拿到的是"已落库的 completed 快照"(通常恰为刚结束的轮次,
// 但宿主最终 usage 若在 Stop 之后才提交,则不含那部分;采样值不宣称完整)。
// 设计约束(2026-09-19 源码确证):ZCode 的 Stop hook 若驱动模型续跑(block),
// 会把整个回合折叠为"已工作"摘要条——统计可见而回答主体被藏起,已按用户裁决弃用该形态。
// 因此本 hook 只发系统通知(Windows toast / macOS 通知中心 / Linux notify-send,零依赖),
// 不动会话流、零续跑调用;对话流内的历史记录仍由 UserPromptSubmit 注入行负责(照常注入)。
// 配置 turnEndLine(默认 false):true/"notify"/"toast" 开启通知,false/off 关闭。
//
// 0.5.5 可信度修复(审核 F02–F06):
// - 健康记录按 会话+hook 分文件:关闭态/失败不再覆盖 prompt 链路的诊断;
// - 关闭态在读配置后尽早退出,只写自己通道的状态;
// - 异常路径记录 error 终态与原因(此前 running 残留);
// - 通知先提交、确认结果后落水位:提交失败不前进水位,下回合 Stop 自然重试;
// - 去重水位按会话多槽保存,并对"实际展示范围的稳定指纹"比对(子代理并入/会话切换不误判);
// - stdin 限时/限长,宿主异常不关 stdin 时不会挂满 hook 预算。
// 任何失败静默放行(exit 0),绝不阻塞回合结束。
import fs from "node:fs";
import {
  readConfig, parseBool, parseJson, resolveTurnEndMode, lastShownFile, writeState,
  recordHealth, startHealth, submitNotify, validId, HOOK_STOP,
} from "../scripts/runtime.mjs";

// stdin 限时/限长(默认 1.5s / 64KB):正常宿主在 Stop 时写入小 JSON 后关闭;
// 若宿主异常保持 stdin 开启,超时销毁流并按无输入处理,不挂 8s 宿主超时。
async function readStdinJson({ limitMs = 1500, maxBytes = 65536 } = {}) {
  let timer = null;
  let timedOut = false;
  try {
    if (process.stdin.isTTY) return {};
    timer = setTimeout(() => { timedOut = true; try { process.stdin.destroy(); } catch {} }, limitMs);
    timer.unref?.();
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > maxBytes) break;
        chunks.push(chunk);
      }
    } catch {} // 超时销毁引发的流错误按"无输入"处理
    if (timedOut || size > maxBytes) return {};
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {};
    const v = parseJson(raw); // BOM 容忍,与其它状态文件读取一致
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- 去重水位(F06):按会话多槽 + 展示范围稳定指纹 ----
// 语义:同一会话"展示的统计内容"变化时通知一次;内容未变(哪怕切走再切回)不重复通知。
// 指纹只含数据本体(覆盖主对话+子代理+轮次的展示范围),排除 sampledAt 等每次变化的字段。
// 兼容:旧单槽文件 {sessionId, shownAt} 迁移为该会话的已知水位(指纹视为未知,至多多通知一次)。
const SHOWN_MAX_SESSIONS = 32;

function readShown(file) {
  try {
    const v = parseJson(fs.readFileSync(file, "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    if (v.sessions && typeof v.sessions === "object") {
      return { version: 2, everNotified: !!v.everNotified, sessions: v.sessions };
    }
    if (validId(v.sessionId)) {
      return { version: 2, everNotified: true, sessions: { [v.sessionId]: { shownAt: Number(v.shownAt) || 0 } } };
    }
    return { version: 2, everNotified: false, sessions: {} };
  } catch {
    return null;
  }
}

function shownFingerprint(r) {
  return JSON.stringify([
    r.coverage?.lastCompletedAt ?? null,
    r.session?.requests ?? 0,
    r.session?.totalInput ?? 0,
    r.session?.totalOutput ?? 0,
    r.session?.decodeSamples ?? 0,
    r.usage?.total ?? null,
    r.turn?.turnId ?? null,
    r.turn?.total ?? null,
  ]);
}

function writeShown(file, shown, sessionId, fingerprint, shownAt) {
  const sessions = { ...(shown?.sessions ?? {}) };
  sessions[sessionId] = { shownAt, fingerprint, ts: Date.now(), source: "stop" };
  // 会话槽上限:按 ts 淘汰最旧,避免长期使用下文件无限增长
  const keys = Object.keys(sessions);
  if (keys.length > SHOWN_MAX_SESSIONS) {
    for (const k of keys.sort((a, b) => (sessions[a].ts ?? 0) - (sessions[b].ts ?? 0)).slice(0, keys.length - SHOWN_MAX_SESSIONS)) {
      delete sessions[k];
    }
  }
  writeState(file, { version: 2, everNotified: true, sessions });
}

const input = await readStdinJson();
const sid = input.session_id || process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";

// startHealth 先于一切可能失败的步骤:配置损坏/缺库等任何异常都必须留下 error 终态(F03)。
// 健康记录按 会话+hook 分文件(F02),此处写入不覆盖 prompt 链路的诊断。
const run = startHealth(sid, HOOK_STOP);
const complete = (update) => {
  try { recordHealth({ ...run, ...update, durationMs: Date.now() - run.startedAt }); } catch {}
};

try {
  const cfg = readConfig();
  // 关闭态尽早退出:只更新自己通道(Stop)的健康状态,不碰 prompt 链路的诊断文件
  if (!parseBool(cfg.tokenRateLine, true) || resolveTurnEndMode(cfg.turnEndLine) !== "notify") {
    complete({ status: "disabled", error: null, warnings: [] });
    process.exit(0);
  }
  const file = lastShownFile();
  const shown = readShown(file);
  const { query, formatLine, resolveRateFields } = await import("../scripts/token-rate.mjs");
  const result = query(sid || null, { includeSubagents: parseBool(cfg.includeSubagents, true), timezone: cfg.timezone });
  const lastCompletedAt = result.coverage?.lastCompletedAt ?? null;
  const fingerprint = shownFingerprint(result);
  const slot = shown?.sessions?.[result.sessionId];
  // 无会话/无已完成请求时不通知;同会话展示内容未变化(指纹一致)也不重复通知
  if (!result.sessionId || lastCompletedAt == null || (slot && slot.fingerprint === fingerprint)) {
    complete({ status: "ok", resolvedSessionId: result.sessionId, lastSuccessAt: Date.now(),
      sampledAt: result.sampledAt, notified: false, error: null, warnings: result.warnings });
    process.exit(0);
  }
  // F05:先提交通知并确认结果,成功后才落水位——提交失败不前进水位,下回合 Stop 自然重试。
  // (代价:通知已提交但水位写失败时可能重复通知一次;按 F05 裁定,重试机会优先于严格一次。)
  // ensurePermission 仅首次:注册表开启横幅权限只做一次,之后尊重用户系统设置。
  const notifyStatus = await submitNotify({
    line: formatLine(result, resolveRateFields(cfg.rateLineFields)),
    ensurePermission: !(shown && (shown.everNotified || Object.keys(shown.sessions).length > 0)),
  });
  if (typeof notifyStatus === "string" && notifyStatus.startsWith("failed")) {
    complete({ status: "notify-failed", error: `通知提交失败(${notifyStatus.slice("failed:".length)});水位未前进,下次 Stop 重试`,
      sampledAt: result.sampledAt, warnings: result.warnings });
    process.exit(0);
  }
  writeShown(file, shown, result.sessionId, fingerprint, lastCompletedAt);
  complete({ status: "ok", resolvedSessionId: result.sessionId, lastSuccessAt: Date.now(),
    sampledAt: result.sampledAt, notified: true, notifyStatus, error: null, warnings: result.warnings });
} catch (e) {
  // F03:可捕获的失败必须记录终态与原因;宿主强制终止(SIGKILL)才会残留 running
  complete({ status: "error", error: e?.message ?? String(e), warnings: [] });
  process.exit(0);
}
