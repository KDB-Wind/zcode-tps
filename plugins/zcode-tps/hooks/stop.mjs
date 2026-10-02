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
// 0.5.5 可信度修复(审核 F02–F06 + 复核 R01–R04):
// - 健康记录按 会话+hook 分文件:关闭态/失败不再覆盖 prompt 链路的诊断(F02);
// - 异常路径记录 error 终态与原因,健康记录区分 stdin/查询/全程耗时(R03);
// - 全程统一预算(默认 7s < 宿主 8s):stdin 等待、查询、通知确认与终态写入共享同一条 deadline;
//   同步 SQLite 无法从同线程中断,查询放入有界子进程,超时终止,墙钟上限不再依赖锁等待叠加(R03);
// - 通知等待退出码:非零退出/信号 = 提交失败,不落水位,下次 Stop 重试(R01);
// - 去重水位按会话哈希独立文件,并发 Stop 互不覆盖(R04);旧共享多槽文件只作迁移读;
// - 同会话"比较→发送→写水位"以原子 claim 串行化:相同内容不重复发送,旧采样晚完成
//   不倒写新水位;事务锁保护占用/回收/释放,拿不到锁即让位,进程退出自动释放互斥;
// - 指纹覆盖实际展示所需的原始聚合(速率分母/缓存分子/最新请求/字段选择),不只哈希四舍五入后的行文本(R02)。
// 任何失败静默放行(exit 0),绝不阻塞回合结束。
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireClaim, assertClaimOwner, releaseClaim } from "../scripts/claim.mjs";
import {
  readConfig, parseBool, parseJson, resolveTurnEndMode, lastShownFile, shownSlotFile, notifiedOnceFile,
  writeState, recordHealth, startHealth, submitNotify, validId, HOOK_STOP,
} from "../scripts/runtime.mjs";

const QUERY_SCRIPT = fileURLToPath(new URL("../scripts/token-rate.mjs", import.meta.url));

// ---- 全程预算(R03):宿主给 Stop 的超时为 8s(hooks.json),hook 自身按 7s 统筹
// stdin 等待、查询、通知确认与终态写入,预留 ~1s 进程启动/宿主终止余量。各环节按
// 剩余预算收缩,任何单项变慢都会压缩后续预算而不是叠加到 8s 之外。
const HOOK_BUDGET_MS = 7000;
const STDIN_LIMIT_MS = 1500;          // 正常宿主写入小 JSON 后立即关闭;悬挂 stdin 超时销毁按无输入处理
const STDIN_LIMIT_DISABLED_MS = 300;  // 关闭态只需尽力抓 sid,不等满全限时
const NOTIFY_CONFIRM_DEFAULT_MS = 2000;
const NOTIFY_CONFIRM_MAX_MS = 3000;
const WRITE_RESERVE_MS = 400;         // 水位/健康记录落盘余量
const MIN_QUERY_MS = 800;             // 查询子进程至少分到的预算(正常查询远小于此)

const entryAt = Date.now();
const deadline = entryAt + HOOK_BUDGET_MS;
const remainMs = () => deadline - Date.now();
const rawConfirm = Number(process.env.ZCODE_TPS_NOTIFY_CONFIRM_MS);
const NOTIFY_CONFIRM_MS = Number.isFinite(rawConfirm) && rawConfirm >= 200 && rawConfirm <= NOTIFY_CONFIRM_MAX_MS
  ? rawConfirm : NOTIFY_CONFIRM_DEFAULT_MS;

async function readStdinJson({ limitMs = STDIN_LIMIT_MS, maxBytes = 65536 } = {}) {
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

// ---- 去重水位(F06/R04):按会话哈希独立文件 ----
// 语义:同一会话"展示的统计内容"变化时通知一次;内容未变(哪怕切走再切回)不重复通知。
// 每会话一个文件,不同会话并发的 Stop 读改写互不覆盖(旧共享多槽文件存在跨会话覆盖竞态)。
// 兼容:0.5.4 共享多槽/单槽文件仅作迁移读(指纹视为未知,至多多通知一次),不再写入。
function readLegacyShown(file) {
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

function slotFrom(slot) {
  return slot
    ? {
        fingerprint: typeof slot.fingerprint === "string" ? slot.fingerprint : null,
        shownAt: Number(slot.shownAt) || 0,
        ts: Number(slot.ts) || 0, // 水位写入时刻:占用后重验的"更新采样已提交"判据(§12.3)
      }
    : null;
}

function readShownSlot(sessionId) {
  const file = shownSlotFile(sessionId);
  if (file) {
    try {
      const v = parseJson(fs.readFileSync(file, "utf8"));
      if (v && typeof v === "object" && v.sessionId === sessionId) return slotFrom(v);
    } catch {} // 损坏水位按无水位处理,重建
  }
  const legacy = readLegacyShown(lastShownFile());
  return legacy ? slotFrom(legacy.sessions?.[sessionId]) : null;
}

function writeShownSlot(sessionId, fingerprint, shownAt) {
  const file = shownSlotFile(sessionId);
  if (!file) return;
  writeState(file, { version: 3, sessionId, shownAt, fingerprint, ts: Date.now(), source: "stop" });
}

// claim.mjs 使用独立状态库的事务锁保护整个生命周期,JSON 只作诊断/迁移。
const claimPath = (sessionId) => {
  const f = shownSlotFile(sessionId);
  return f ? `${f}.claim` : null;
};

// "曾成功通知过"标记:决定是否在首次通知前补写 Windows 注册表横幅权限(幂等,仅一次)
function everNotified() {
  try { fs.accessSync(notifiedOnceFile()); return true; } catch {}
  const legacy = readLegacyShown(lastShownFile());
  return !!(legacy && (legacy.everNotified || Object.keys(legacy.sessions).length > 0));
}
function markNotifiedOnce() {
  try { writeState(notifiedOnceFile(), { ts: Date.now() }); } catch {}
}

// ---- 展示范围稳定指纹(F06/R02) ----
// 覆盖实际展示所需的原始聚合值:e2e/Decode 的分子与时长分母、主统计 input/cacheRead、
// 轮次/最新请求标识、字段选择与时区,外加格式化行本身(所见即所比)。排除 sampledAt。
// 原始聚合不经四舍五入:总量不变的 duration/TTFT/cache 回填会改变速率与缓存率,必须触发通知。
function shownFingerprint(r, fields, line) {
  const s = r.session ?? {}, u = r.usage ?? {}, t = r.turn ?? {}, l = r.latest ?? {};
  return JSON.stringify([
    3,
    r.sessionId ?? null, s.scope ?? null, fields.join(","), r.timezone ?? null,
    r.coverage?.lastCompletedAt ?? null,
    s.requests ?? 0, s.samples ?? 0, s.totalInput ?? 0, s.totalOutput ?? 0, s.totalCacheRead ?? 0,
    s.avgTps ?? null, s.decodeSamples ?? 0, s.decodeTps ?? null,
    s.e2eOutputTokens ?? null, s.e2eDurationMs ?? null, s.decodeOutputTokens ?? null, s.decodeDurationMs ?? null,
    u.input ?? null, u.output ?? null, u.cacheRead ?? null, r.cacheHit ?? null,
    t.turnId ?? null, t.requests ?? 0, t.durationMs ?? 0, t.input ?? 0, t.output ?? 0,
    t.avgTps ?? null, t.cacheHit ?? null, t.completedAt ?? null,
    l.completedAt ?? null, l.durMs ?? null, l.tokPerSec ?? null, l.ttftMs ?? null, l.inputTokens ?? 0,
    line,
  ]);
}

// ---- 有界查询子进程(R03) ----
// 同线程 setTimeout 无法中断同步 SQLite(锁等待按语句叠加曾实测 6.5s+),查询放进子进程,
// 超出剩余预算直接终止:hook 的墙钟上限由本函数的 timeoutMs 硬性保证,与库内锁行为无关。
// 子进程即 token-rate CLI(--json),自身按 ZCODE_SESSION_ID/配置/环境变量执行同一查询逻辑。
function queryViaChild(sid, timeoutMs) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (validId(sid)) env.ZCODE_SESSION_ID = sid;
    else { delete env.ZCODE_SESSION_ID; delete env.CLAUDE_SESSION_ID; }
    let child;
    try {
      child = spawn(process.execPath, [QUERY_SCRIPT, "--json"], {
        env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
    } catch (e) {
      resolve({ error: `查询子进程无法启动: ${e?.message ?? e}` });
      return;
    }
    let out = "", errText = "", settled = false, timer = null;
    const finish = (v) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(v); };
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ error: `查询超时(${Math.round(timeoutMs)}ms 内未完成,已终止查询子进程;用量库可能被持续锁定)` });
    }, Math.max(0, timeoutMs));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { errText += d; });
    child.once("error", (e) => finish({ error: `查询子进程启动失败: ${e?.code ?? e?.message ?? e}` }));
    child.once("close", (code) => {
      const raw = out.trim();
      let v = null;
      try { v = raw ? parseJson(raw) : null; } catch { v = null; }
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if (v.error) finish({ error: String(v.error) });
        else finish({ result: v });
      } else {
        finish({ error: `查询子进程输出不可解析(退出码 ${code})${errText ? ":" + errText.trim().slice(0, 200) : ""}` });
      }
    });
  });
}

// ---- 主流程 ----
// 配置先行(R03):关闭态在等待 stdin 之前即可判定,用短限时抓 sid 后立即退出;
// 配置损坏不能提前退出——须走完整路径留下 error 终态(F03,任何失败都有终态与原因)。
let cfg = null;
let cfgError = null;
try { cfg = readConfig(); } catch (e) { cfgError = e; }
const disabled = !cfgError && (!parseBool(cfg.tokenRateLine, true) || resolveTurnEndMode(cfg.turnEndLine) !== "notify");

const stdinLimit = disabled
  ? STDIN_LIMIT_DISABLED_MS
  : Math.max(200, Math.min(STDIN_LIMIT_MS, remainMs() - (NOTIFY_CONFIRM_MAX_MS + WRITE_RESERVE_MS + MIN_QUERY_MS)));
const stdinStart = Date.now();
const input = await readStdinJson({ limitMs: stdinLimit });
const stdinMs = Date.now() - stdinStart;
const sid = input.session_id || process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";

// 健康记录按 会话+hook 分文件(F02);stdin/查询/全程耗时分段记录(R03)
const run = startHealth(sid, HOOK_STOP);
let queryMs = null;
let heldClaim = null; // 同会话占用锁(持有中;所有退出路径必须释放,含异常路径)
const complete = (update) => {
  try {
    recordHealth({ ...run, ...update, stdinMs, queryMs,
      durationMs: Date.now() - run.startedAt, totalMs: Date.now() - entryAt });
  } catch {}
};

try {
  if (cfgError) throw cfgError;
  if (disabled) {
    complete({ status: "disabled", error: null, warnings: [] });
    process.exit(0);
  }
  const { formatLine, resolveRateFields } = await import("../scripts/token-rate.mjs");
  const fields = resolveRateFields(cfg.rateLineFields);
  const queryBudget = Math.max(MIN_QUERY_MS, remainMs() - (NOTIFY_CONFIRM_MAX_MS + WRITE_RESERVE_MS));
  const queryStart = Date.now();
  const q = await queryViaChild(sid, queryBudget);
  queryMs = Date.now() - queryStart;
  if (q.error) {
    complete({ status: "error", error: q.error, warnings: [] });
    process.exit(0);
  }
  const result = q.result;
  const lastCompletedAt = result.coverage?.lastCompletedAt ?? null;
  const line = formatLine(result, fields);
  const fingerprint = shownFingerprint(result, fields, line);
  const slot = readShownSlot(result.sessionId);
  // 无会话/无已完成请求时不通知;同会话展示内容未变化(指纹一致)也不重复通知
  if (!result.sessionId || lastCompletedAt == null || (slot && slot.fingerprint === fingerprint)) {
    complete({ status: "ok", resolvedSessionId: result.sessionId ?? null, lastSuccessAt: Date.now(),
      sampledAt: result.sampledAt, notified: false, error: null, warnings: result.warnings });
    process.exit(0);
  }
  // F05/R01:先提交并确认退出结果,成功后才落水位——非零退出/信号不前进水位,下回合 Stop 自然重试。
  // (代价:通知已提交但水位写失败时可能重复通知一次;按 F05 裁定,重试机会优先于严格一次。)
  // ensurePermission 仅首次:注册表开启横幅权限只做一次,之后尊重用户系统设置。
  // §12.3:同会话原子占用——比较→发送→写水位只允许一个持有者;占用后重验,
  // 拿到锁的旧采样不再覆盖新结果(倒写),相同内容不被并发重复发送。
  const claim = claimPath(result.sessionId);
  const acquired = await acquireClaim(claim, run.runId);
  if (!acquired) {
    complete({ status: "ok", resolvedSessionId: result.sessionId ?? null, lastSuccessAt: Date.now(),
      sampledAt: result.sampledAt, notified: false, skipReason: "locked",
      error: null, warnings: result.warnings });
    process.exit(0);
  }
  heldClaim = acquired;
  // 占用后重验:并发者可能恰在本 run 查询期间完成了通知与写入
  const reread = readShownSlot(result.sessionId);
  let skipReason = null;
  if (reread && reread.fingerprint === fingerprint) skipReason = "concurrent";      // 相同内容已被并发通知
  else if (reread && (reread.shownAt ?? 0) > lastCompletedAt) skipReason = "stale"; // 已有更新的完成水位
  else if (reread && (reread.ts ?? 0) > queryStart) skipReason = "stale";           // 已有基于更新采样的提交
  if (skipReason) {
    releaseClaim(heldClaim);
    heldClaim = null;
    complete({ status: "ok", resolvedSessionId: result.sessionId ?? null, lastSuccessAt: Date.now(),
      sampledAt: result.sampledAt, notified: false, skipReason,
      error: null, warnings: result.warnings });
    process.exit(0);
  }
  const confirmMs = Math.max(200, Math.min(NOTIFY_CONFIRM_MS, remainMs() - WRITE_RESERVE_MS));
  assertClaimOwner(heldClaim);
  const notifyStatus = await submitNotify({ line, ensurePermission: !everNotified(), confirmMs });
  if (typeof notifyStatus === "string" && notifyStatus.startsWith("failed")) {
    releaseClaim(heldClaim);
    heldClaim = null;
    complete({ status: "notify-failed", error: `通知提交失败(${notifyStatus.slice("failed:".length)});水位未前进,下次 Stop 重试`,
      sampledAt: result.sampledAt, warnings: result.warnings });
    process.exit(0);
  }
  assertClaimOwner(heldClaim);
  writeShownSlot(result.sessionId, fingerprint, lastCompletedAt);
  markNotifiedOnce();
  releaseClaim(heldClaim);
  heldClaim = null;
  complete({ status: "ok", resolvedSessionId: result.sessionId ?? null, lastSuccessAt: Date.now(),
    sampledAt: result.sampledAt, notified: true, notifyStatus, error: null, warnings: result.warnings });
} catch (e) {
  // F03:可捕获的失败必须记录终态与原因;宿主强制终止(SIGKILL)才会残留 running
  // 进程强杀时 SQLite 的 OS 锁会释放;JSON 残留由下一占用者在事务内恢复。
  let error = e?.message ?? String(e);
  try { if (heldClaim) releaseClaim(heldClaim); }
  catch (cleanup) { error += `;占用锁清理失败: ${cleanup.message}`; }
  complete({ status: "error", error, warnings: [] });
  process.exit(0);
}
