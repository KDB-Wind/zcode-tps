// Per-session notification claim. SQLite owns the mutex; JSON is diagnostic metadata.
// Never unlink the guard database: its filesystem identity is part of the lock protocol.
import fs from "node:fs";
import path from "node:path";
import { parseJson, validId, writeState } from "./runtime.mjs";

export const CLAIM_GRACE_MS = 15000;
const GUARD_PROTOCOL = "sqlite-v1";

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== "ESRCH"; } // Permission errors must not steal a live legacy claim.
}

function isBusy(e) {
  return [5, 6].includes(Number(e?.errcode) & 255);
}

function closeGuard(db) {
  if (!db) return;
  try { db.exec("ROLLBACK"); } catch {} // No transaction after initialization / a failed BEGIN.
  db.close();
}

function readMetadata(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
  let owner;
  try { owner = parseJson(raw); } catch {} // Interrupted old writer may leave empty/truncated JSON.
  if (owner && typeof owner === "object" && !Array.isArray(owner)) {
    if (owner.guard === GUARD_PROTOCOL) return owner;
    if (validId(owner.runId) && Number.isInteger(owner.pid) && owner.pid > 0 &&
        typeof owner.ts === "number" && Number.isFinite(owner.ts)) return owner;
  }
  // Only legacy/unrecognized metadata needs a grace period. Complete new records are
  // atomically published under the guard, so acquiring the guard proves them abandoned.
  const age = Date.now() - fs.statSync(file).mtimeMs;
  return { incomplete: true, young: age < CLAIM_GRACE_MS };
}

export async function acquireClaim(file, runId) {
  if (!validId(file) || !validId(runId)) throw new Error("占用锁路径与 runId 必须有效");
  let db;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(`${file}.sqlite`);
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("CREATE TABLE IF NOT EXISTS claim_guard (id INTEGER PRIMARY KEY)");
    db.exec("BEGIN IMMEDIATE");
    // Recovery and publication use the SAME mutex as notification and release.
    // A contender cannot read a stale owner and then remove a replacement claim.
    const previous = readMetadata(file);
    const legacyBlocked = previous?.incomplete ? previous.young
      : previous && previous.guard !== GUARD_PROTOCOL && pidAlive(previous.pid);
    if (legacyBlocked) {
      closeGuard(db);
      db = null;
      return null;
    }
    writeState(file, { guard: GUARD_PROTOCOL, runId, pid: process.pid, ts: Date.now() });
    return { file, runId, db, released: false };
  } catch (e) {
    closeGuard(db);
    if (isBusy(e)) return null; // Only actual mutex contention is "locked".
    throw new Error(`占用锁失败(${e.code ?? "I/O"}): ${e.message}`, { cause: e });
  }
}

export function assertClaimOwner(claim) {
  if (!claim || claim.released) throw new Error("占用锁已释放，不能发送通知或提交水位");
  const owner = readMetadata(claim.file);
  if (owner?.guard !== GUARD_PROTOCOL || owner.runId !== claim.runId || owner.pid !== process.pid) {
    throw new Error("占用锁 owner 已变化，禁止发送、提交或删除其他 owner 的记录");
  }
}

export function releaseClaim(claim) {
  if (!claim || claim.released) return;
  try {
    // Owner check and unlink are protected by the still-held SQLite transaction.
    assertClaimOwner(claim);
    fs.unlinkSync(claim.file);
  } finally {
    claim.released = true;
    closeGuard(claim.db);
  }
}
