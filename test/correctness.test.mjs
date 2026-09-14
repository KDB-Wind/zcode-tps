// v0.5.3 审计轮回归测试(docs/audit-20260914.md §8 修复单)。
// 运行:node test/correctness.test.mjs(需要 Node >= 22.13,零第三方依赖)
// 覆盖:P1-1 查询语句数上限 / P1-3 空白 query_source 可见性 / P2-1 doctor 时间戳类型守卫 / P2-2 表不存在文案。
// T3 正确性矩阵(三类库 × 异常样本)也落在本文件,见 runMatrix()。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL, fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-tps-correctness-"));
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(root, "plugins", "zcode-tps", "scripts", "token-rate.mjs");
const DOC = path.join(root, "plugins", "zcode-tps", "scripts", "doctor.mjs");
const SID = "sess_c";
process.env.ZCODE_TPS_CONFIG = path.join(tmp, "config.json");
process.env.ZCODE_TPS_LAST_SESSION = path.join(tmp, "last-session.json");
process.env.ZCODE_TPS_HEALTH = path.join(tmp, "health.json");

const DDL = `CREATE TABLE model_usage (
  turn_id TEXT, session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
  output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER,
  cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
  trace_id TEXT, started_at INTEGER, first_token_at INTEGER,
  completed_at INTEGER, duration_ms INTEGER, time_to_first_token_ms INTEGER)`;

function createDb(name) {
  const dbPath = path.join(tmp, name);
  const db = new DatabaseSync(dbPath);
  db.exec(DDL);
  return { db, dbPath };
}

function insert(db, {
  t0 = 1_000_000, out = 100, reasoning = 0, ttft = 100, gen = 900, durMs = 1000,
  input = 800, cacheRead = 700, turnId = "turn_c", qs = "main_turn", sess = SID,
  status = "completed", trace = null, completedAt, firstAt,
}) {
  db.prepare(`INSERT INTO model_usage (
      turn_id,session_id,status,query_source,model_id,output_tokens,reasoning_tokens,
      input_tokens,cache_read_input_tokens,trace_id,started_at,first_token_at,
      completed_at,duration_ms,time_to_first_token_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(turnId, sess, status, qs, "test-model", out, reasoning, input, cacheRead, trace,
         t0, firstAt !== undefined ? firstAt : t0 + ttft,
         completedAt !== undefined ? completedAt : t0 + durMs, durMs, ttft);
}

async function loadWith(dbPath, script = SCRIPT) {
  process.env.ZCODE_USAGE_DB = dbPath;
  return import(pathToFileURL(script).href + "?case=" + Math.random());
}

// ---- P1-1:单次 query() 对 model_usage 发起的 SELECT 语句数必须收敛(现为 13 条,目标 ≤ 8) ----
{
  const { db, dbPath } = createDb("scan-count.sqlite");
  insert(db, { trace: "T1", turnId: "t1" });
  insert(db, { trace: "T1", turnId: "t1", t0: 2_000_000, qs: "subagent", sess: "sess_sub" });
  db.close();

  process.env.ZCODE_USAGE_DB = dbPath;
  const mod = await import(pathToFileURL(SCRIPT).href + "?case=scan" + Math.random());
  const prepare = DatabaseSync.prototype.prepare;
  let selects = 0;
  DatabaseSync.prototype.prepare = function (sql) {
    if (typeof sql === "string" && sql.trim().toUpperCase().startsWith("SELECT")) selects++;
    return prepare.call(this, sql);
  };
  try {
    const r = mod.query(SID); // 显式 sid:不含 auto 识别的 2 条,审计口径 13 条
    assert.equal(r.session.requests, 2, "前置:子代理已并入,计数场景有效");
    assert.ok(r.decodeStats, "前置:存在解码样本,decodeStats 语句计入");
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  assert.ok(selects <= 8, `单次 query 的 SELECT 语句数应 ≤ 8(含聚合合并),实测 ${selects}`);
  console.log(`P1-1 查询语句数收敛通过(SELECT × ${selects})`);
}

// ---- P1-3:NULL/空白 query_source 的 completed 请求必须可见(auxiliary 单列 + 告警),不得静默消失 ----
{
  const { db, dbPath } = createDb("blank-source.sqlite");
  insert(db, { turnId: "t1" });                                  // 正常主请求
  insert(db, { turnId: "t2", qs: null, t0: 3_000_000, out: 50, input: 300, cacheRead: 0 });   // NULL 来源
  insert(db, { turnId: "t3", qs: "   ", t0: 4_000_000, out: 30, input: 200, cacheRead: 0 });  // 空白来源
  db.close();

  const { query } = await loadWith(dbPath);
  const r = query(SID);
  assert.equal(r.session.requests, 1, "主统计仍严格 main_turn,空白来源不得混入");
  assert.ok(r.auxiliary, "存在非 main/sub 请求时 auxiliary 必须存在");
  const missing = r.auxiliary.groups.find((g) => g.source === "(缺失)");
  assert.ok(missing, "NULL/空白 query_source 应以 (缺失) 组单列,组=" + JSON.stringify(r.auxiliary.groups));
  assert.equal(missing.class, "unknown");
  assert.equal(missing.requests, 2, "NULL 与空白来源各 1 条,共 2 条");
  assert.equal(missing.input, 500);
  assert.equal(missing.output, 80);
  assert.ok(r.warnings.some((w) => /缺少 query_source/.test(w)),
    "应有专用告警提示来源缺失,warnings=" + JSON.stringify(r.warnings));
  console.log("P1-3 空白 query_source 可见性通过");
}

// ---- P2-2:model_usage 表不存在时,错误必须明确"表不存在"而非误导性"缺少列" ----
{
  const dbPath = path.join(tmp, "no-model-usage.sqlite");
  const other = new DatabaseSync(dbPath);
  other.exec("CREATE TABLE tasks (id TEXT)"); // 诸如 tasks-index.sqlite 的其他库
  other.close();

  const { query } = await loadWith(dbPath);
  assert.throws(() => query(SID), /model_usage 表不存在/, "错误信息应区分 表不存在 与 缺少列");
  console.log("P2-2 表不存在文案通过");
}

// ---- P2-1:doctor 对 TEXT 等异常 completed_at 不得显示 "NaN 分钟前" ----
{
  const dbPath = path.join(tmp, "text-time.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(DDL);
  db.prepare(`INSERT INTO model_usage (
      turn_id,session_id,status,query_source,model_id,output_tokens,reasoning_tokens,
      input_tokens,cache_read_input_tokens,trace_id,started_at,first_token_at,
      completed_at,duration_ms,time_to_first_token_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("t1", SID, "completed", "main_turn", "test-model", 100, 0, 800, 700, null,
         1_000_000, 1_000_100, "not-a-number", 1000, 100);
  db.close();

  process.env.ZCODE_USAGE_DB = dbPath;
  const { runDoctor } = await loadWith(dbPath, DOC);
  const report = await runDoctor();
  const core = report.checks.find((c) => c.name === "usage 数据库");
  assert.equal(core.ok, true, "核心列完整时核心检查应通过");
  assert.doesNotMatch(core.detail, /NaN/, "异常时间戳不得渲染 NaN,detail=" + core.detail);
  console.log("P2-1 doctor 时间戳守卫通过");
}

// ---- T3 正确性矩阵:三类库(tasks-index / cli db / opencode.db 形状)× 七种异常 ----
// 逐格验证:不崩溃(抛错即合理降级)、输出合理、静默降级有日志;结果表打印供 docs 归档。
{
  const now = Date.now();
  const TASKS_DDL = `CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace TEXT, title TEXT, status TEXT, updated_at INTEGER);
    CREATE TABLE automations (id TEXT PRIMARY KEY, due INTEGER);`;
  const OPENCODE_DDL = `CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, created_at INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, type TEXT, data TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT);`;

  function buildShape(db, shape, anomaly) {
    if (shape === "tasks-index") { db.exec(TASKS_DDL); return; }
    if (shape === "opencode") { db.exec(OPENCODE_DDL); return; }
    // cli-db 形状:model_usage + 周边表
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT);`);
    db.exec(DDL);
    if (anomaly === "missing-required-col") db.exec("ALTER TABLE model_usage DROP COLUMN duration_ms");
    if (anomaly === "extra-unknown-col") {
      db.exec("ALTER TABLE model_usage ADD COLUMN zcode_new_col TEXT; ALTER TABLE model_usage ADD COLUMN zcode_new_num INTEGER");
    }
    if (anomaly === "normal" || anomaly === "extra-unknown-col" || anomaly === "huge-text" || anomaly === "future-timestamp") {
      const t0 = anomaly === "future-timestamp" ? now + 30 * 86400_000 : 1_000_000;
      const huge = anomaly === "huge-text" ? "M".repeat(1_000_000) : "test-model";
      const hugeTurn = anomaly === "huge-text" ? "T".repeat(200_000) : "turn_m";
      const extraCols = anomaly === "extra-unknown-col" ? ",zcode_new_col,zcode_new_num" : "";
      const insertSql = `INSERT INTO model_usage (
          turn_id,session_id,status,query_source,model_id,output_tokens,reasoning_tokens,
          input_tokens,cache_read_input_tokens,cache_creation_input_tokens,trace_id,started_at,first_token_at,
          completed_at,duration_ms,time_to_first_token_ms${extraCols}
        ) VALUES (${new Array(16 + (extraCols ? 2 : 0)).fill("?").join(",")})`;
      const row1 = [hugeTurn, SID, "completed", "main_turn", huge, 100, 0, 800, 700, 0, "TR1", t0, t0 + 100, t0 + 1000, 1000, 100];
      if (extraCols) row1.push("new", 7);
      db.prepare(insertSql).run(...row1);
      db.prepare(`INSERT INTO model_usage (
          turn_id,session_id,status,query_source,model_id,output_tokens,reasoning_tokens,
          input_tokens,cache_read_input_tokens,cache_creation_input_tokens,trace_id,started_at,first_token_at,
          completed_at,duration_ms,time_to_first_token_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(hugeTurn, SID, "completed", "main_turn", "test-model", 50, 0, 400, 300, 0, "TR1",
             t0 + 5000, t0 + 5100, t0 + 6000, 1000, 100);
    }
  }

  const shapes = ["cli-db", "tasks-index", "opencode"];
  const anomalies = ["normal", "empty", "missing-required-col", "extra-unknown-col", "corrupt", "huge-text", "future-timestamp"];
  const grid = [];
  for (const shape of shapes) {
    for (const anomaly of anomalies) {
      const cell = { shape, anomaly, outcome: "", ok: true };
      try {
        const dbPath = path.join(tmp, `matrix-${shape}-${anomaly}.sqlite`);
        if (anomaly === "corrupt") {
          // 先造一个合法库再破坏头部字节
          const seed = new DatabaseSync(dbPath);
          buildShape(seed, shape, "normal");
          seed.close();
          const bytes = fs.readFileSync(dbPath);
          bytes.fill(0xde, 0, Math.min(4096, bytes.length));
          fs.writeFileSync(dbPath, bytes);
        } else {
          const db = new DatabaseSync(dbPath);
          buildShape(db, shape, anomaly); // empty:建表不插数据(cli-db 为空表;其他形状本就无数据)
          db.close();
        }
        // CLI 查询行为
        const { query } = await loadWith(dbPath);
        let note = "";
        try {
          const r = query(SID);
          if (shape === "cli-db" && !["missing-required-col", "empty"].includes(anomaly)) {
            if (r.session.requests !== 2) throw new Error(`requests=${r.session.requests} 期望 2`);
            if (r.usage.total !== 1350) throw new Error("total 应为 1350(800+100+400+50)");
            if (anomaly === "future-timestamp" && !(r.latest.completedAt > r.sampledAt)) throw new Error("未来时间戳行应可成为 latest");
            if (anomaly === "huge-text" && !r.history.some((h) => h.model.length === 1_000_000)) throw new Error("超长 model_id 应原样保留");
            cell.outcome = `ok(requests=${r.session.requests}${anomaly === "future-timestamp" ? ",未来时间戳可选为 latest" : ""})`;
          } else if (anomaly === "empty") {
            if (r.session.requests !== 0 || r.usage !== null) throw new Error("空库应得到空统计");
            const ra = query(null); // auto 识别:空库 → 会话未知 + 警告(静默降级有日志)
            if (ra.sessionId !== null || !ra.warnings.some((w) => /会话/.test(w))) throw new Error("空库 auto 识别应有未知会话警告");
            cell.outcome = "ok(空统计;auto 识别附未知会话警告)";
          } else {
            cell.outcome = "ok(非用量库形状返回空域)";
          }
        } catch (e) {
          if (shape !== "cli-db" && /model_usage 表不存在/.test(e.message)) cell.outcome = "degrade(表不存在,明确报错)";
          else if (anomaly === "missing-required-col" && /缺少列/.test(e.message)) cell.outcome = "degrade(缺必需列,明确报错)";
          else if (anomaly === "corrupt") cell.outcome = "degrade(损坏文件,打开即明确报错)";
          else { cell.ok = false; cell.outcome = "FAIL " + e.message.slice(0, 80); }
        }
        // doctor 分类
        if (cell.ok) {
          const { runDoctor } = await loadWith(dbPath, DOC);
          const report = await runDoctor();
          const core = report.checks.find((c) => c.name === "usage 数据库");
          if (anomaly === "corrupt") {
            if (core.ok || !/无法只读打开|查询失败|not a database|损坏/i.test(core.detail)) { cell.ok = false; cell.outcome += " | doctor 分类错误"; }
          } else if (shape !== "cli-db") {
            if (core.ok || !/表不存在/.test(core.detail)) { cell.ok = false; cell.outcome += " | doctor 未报表不存在"; }
          } else if (anomaly === "missing-required-col") {
            if (core.ok || !/缺少列/.test(core.detail)) { cell.ok = false; cell.outcome += " | doctor 未报缺列"; }
          } else if (!core.ok) {
            cell.ok = false; cell.outcome += " | doctor 误报:" + core.detail.slice(0, 60);
          }
          if (cell.ok) cell.outcome += " | doctor 分类正确";
        }
        if (note) cell.outcome += note;
      } catch (e) {
        cell.ok = false;
        cell.outcome = "EXCEPTION " + e.message.slice(0, 100);
      }
      grid.push(cell);
    }
  }
  for (const c of grid) {
    assert.ok(c.ok, `矩阵 ${c.shape}×${c.anomaly} 未通过:${c.outcome}`);
    console.log(`矩阵 ${c.shape} × ${c.anomaly} → ${c.outcome}`);
  }
  console.log("T3 正确性矩阵 21 格全部通过 ✅");
}

// ---- T5 显示规则极值场景:多工作区会话切换 / 缓存命中率 0% 与 100% / 零输入 ----
{
  const { db, dbPath } = createDb("display-extremes.sqlite");
  // 工作区 A:cacheRead = input → 100%;工作区 B:cacheRead = 0 且 input > 0 → 0%
  insert(db, { turnId: "tA1", sess: "wsA", input: 800, cacheRead: 800, trace: "TA" });
  insert(db, { turnId: "tB1", sess: "wsB", input: 900, cacheRead: 0, trace: "TB" });
  db.close();

  const { query, formatLine } = await loadWith(dbPath);
  const a = query("wsA"), b = query("wsB");
  assert.equal(a.cacheHit, 100, "cacheRead=input → 100%");
  assert.ok(formatLine(a).includes("缓存 100%"), "0.5.3 行应显示 缓存 100%");
  assert.equal(b.cacheHit, 0, "cacheRead=0 且 input>0 → 0%(是数据,不是缺失)");
  assert.ok(formatLine(b).includes("缓存 0%"), "行应显示 缓存 0%");
  // 零输入行:input=0 → cacheHit=null → cache 段整体缺席,速率与会话段仍在
  const { db: db2, dbPath: dbPath2 } = createDb("display-zero-input.sqlite");
  insert(db2, { turnId: "tZ", input: 0, cacheRead: 0 });
  db2.close();
  const { query: q2, formatLine: f2 } = await loadWith(dbPath2);
  const z = q2(SID);
  assert.equal(z.cacheHit, null);
  assert.ok(!f2(z).includes("缓存"), "input=0 时 cache 段应缺席");
  assert.ok(f2(z).includes("⚡"), "rates 段恒在");

  // 多工作区会话切换:last-session 状态文件交替指向 A/B,auto 识别跟随最新一次
  const statePath = path.join(tmp, "switch-state.json");
  const { writeState } = await import(pathToFileURL(path.join(root, "plugins/zcode-tps/scripts/runtime.mjs")).href + "?switch" + Math.random());
  process.env.ZCODE_USAGE_DB = dbPath;
  const mod = await import(pathToFileURL(SCRIPT).href + "?case=switch" + Math.random());
  for (const active of ["wsA", "wsB", "wsA"]) {
    writeState(statePath, { sessionId: active, ts: Date.now(), source: "test" });
    const r = mod.query(null, { lastSessionFile: statePath });
    assert.equal(r.sessionId, active, `auto 应跟随状态文件切到 ${active}`);
    assert.equal(r.scoped, "file");
    // 显式另一会话不受状态文件影响(多窗口并存语义)
    const other = active === "wsA" ? "wsB" : "wsA";
    assert.equal(mod.query(other).sessionId, other, "显式会话与状态文件互不干扰");
  }
  console.log("T5 显示规则极值场景通过(缓存 0%/100%/零输入 + 三次会话切换)");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("correctness 前置红测完成 ✅(P1-1 / P1-3 / P2-1 / P2-2 / T3 矩阵 / T5 极值)");
