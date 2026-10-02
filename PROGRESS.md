# PROGRESS — zcode-tps v0.5.3 审计优化轮(2026-09-14 夜间)

本轮目标:全量文件审计 → 大库基准 → 正确性矩阵 → v0.5.3 就绪。
全局红线:真实用量库(C:\Users\KDB\.zcode\ 下所有 .sqlite/.db)绝对只读;基准一律合成库(test/tmp,不入 git);纯本地禁 push;发布留人工;禁 pkill/taskkill。

## T0 基线(2026-09-14 23:40,Node v24.14.0,win32)

### npm test — ✅ 全绿

- `test/degrade.test.mjs`:28 个用例通过(949ms)— 请求端到端口径 / 0.3 旧值 / duration 回退与边界 / 零输出 / 无 first-token / 子代理累计 / hook 契约 / model_usage 单一数据源
- `test/doctor.test.mjs`:8 个用例通过(170ms)— 核心 duration/start 列 / 分级 error/warn / 可选列检查 / 布尔一致性
- `test/release.test.mjs`:30 个用例通过(2634ms)— timezone-display / decode-speed / decode-window-boundary / decode-quantiles / auxiliary-sources / auxiliary-only-session 等
- 汇总:tests 3 / pass 3 / fail 0,总时长 2675ms

### npm run benchmark — 基线数字(10 万行合成库,20 主会话)

| 场景 | samples | median | p95 |
|---|---|---|---|
| no_indexes | 7 | 352.2 ms | 388.1 ms |
| fixture_indexes | 7 | 103.1 ms | 106.3 ms |

- persistentExclusiveLock:6479.6 ms 后报 "database is locked"
- attributedRequests: 5000
- 注:0.4.2 时代 fixture_indexes 为 38.8ms,现 103.1ms——查询面已增加 auxiliary/decode 分布等,不可直接对比,但提示 10 万行下仍有优化空间。T2 将扩展为 小/中/大库 × 冷/热 矩阵。

### 结论

门禁绿,进入 T1 全量文件审计。审计对象(共约 3174 行):

- plugins/zcode-tps/scripts/token-rate.mjs(546)/doctor.mjs(238)/runtime.mjs(165)
- plugins/zcode-tps/hooks/prompt-submit.mjs(48)/session-start.mjs(29)/hooks.json(36)
- plugins/zcode-tps/commands/tps.md(55)/tps-doctor.md(50)
- plugins/zcode-tps/.zcode-plugin/plugin.json(21)/README.md(129)
- test/degrade.test.mjs(711)/doctor.test.mjs(143)/release.test.mjs(521)/benchmark.mjs(75)
- docs/PERFORMANCE.md(25)/docs/ZCODE-3.11.2-...(382)
- 根:README.md/CHANGELOG.md/marketplace.json/package.json/.github/
- 产出:docs/audit-20260914.md(P0/P1/P2 + file:line 证据)

## 检查点日志

- [T0][23:40] 基线如上,门禁绿。

### T1 审计 + 修复(2026-09-15 00:05)

- 审计报告:`docs/audit-20260914.md`(P0×0 / P1×3 / P2×4,file:line 证据;真实库只读探查:model_usage 7,635 行,4 个二级索引,query_source 六种来源)。
- 红测:`test/correctness.test.mjs` 四项(语句数 13>8 红;空白 query_source 无组红;表不存在文案红;doctor NaN 红),已确认先红。
- 绿修复:
  - P1-1 `token-rate.mjs` 聚合合并:sum/aggr/decode/turn 四合一(bigRow 条件聚合)、sub 三合一、decodeStats 材化 CTE、resolveAutoSid 优先级排序合一、latest 从 items 派生(仅罕见回退深查询)。单次 query SELECT 语句数 **13 → 4**(≤8 门禁)。
  - P1-3 auxiliary 收编 NULL/空白 query_source 为 `(缺失)` 组 + 专用告警(runtime 新增 `blankLabelSql`)。
  - P2-1 doctor 时间戳 Number.isFinite 守卫 + 未来时间戳显式标注。
  - P2-2 表不存在与缺列错误文案区分。
- 修复过程中发现并修正两个自引入缺陷:subScopeSql 拼接误入模板字符串(语法级,测试立即暴露)、latestTurnId=undefined 不可绑定(空 history 路径,degrade 用例 1/15 暴露)。
- 验证:`npm test` 全绿(28+8+30+correctness 4);真实库只读冒烟:速率行/JSON/decodeStats/auxiliary 正常。
- 待办:T1-2(benchmark 镜像真实索引)并入 T2 矩阵。

### T2 大库基准(2026-09-15 00:30-00:45)

- 新增 `test/fixture.mjs`:确定性(mulberry32)合成库生成器。分布对齐真实库观察:输入 1k-400k 对数均匀、输出 50-4000 对数均匀(1% 零输出)、缓存命中 85% 行在 90-99%、TTFT 2-14s、main_turn/subagent/辅助 ≈ 90/7.5/2.5%、2% error、2% NULL duration、0.5% NULL turn、20% 子代理不可归因;附同量级 message(1:1)/part(4:1)。trace/turn 按会话内分桶且桶首行强制 main_turn+completed,保证归因 oracle 确定。
- `test/benchmark.mjs` 重写为矩阵:规模(默认 5k/100k/1M,可传位置参数)× 索引场景(无/旧基准实验索引/生产真实索引镜像)× 模式(典型会话/最大会话/auto 识别)× 冷(子进程首查,3 次中位)/ 热(7 次中位+P95)+ rss/heap 增量;含 session 口径 oracle 精确断言(requests/total)。
- **第一轮 after 基准暴露新问题**:生产真实索引下 1M 行 typical 2263ms / auto 3540ms——planner 无 ANALYZE 统计时弃用 `(session_id,turn_id)` 索引,等同全表扫描 × N。
- **基准→修复→基准**:
  1. `INDEXED BY` 自适应(只读 `PRAGMA index_list/index_info` 探测 session_id 首列索引,按 status/query_source/completed_at 覆盖打分选优;旧代码无此逻辑)。
  2. 连接级 mmap(256MB)+ 页缓存(64MB)pragma——**锁路径回归发现**:pragma 在独占锁下自身付出完整 busy 周期,锁场景 6.5s→12.8s 突破 hook 8s 预算;修复:pragma 移至 schema 首次成功读取之后,锁路径提前抛错不受影响,最终 6314ms。
- 最终 after(1M 行,中位):real_indexes typical 166ms / big 332ms / auto 805ms;lock 6314ms。before(HEAD worktree 同矩阵):typical 3568ms / big 3064ms / auto 5535ms;lock 6551ms。**生产索引下 typical 21×、big 9×、auto 6.9× 提升;before 的 auto 5.5s+锁等待 4.2s 会突破 8s hook 预算,after 全场景 ≤0.9s。**
  (注:before 后台运行期间有轻量并发测试,数字取偏保守上界;差距量级远超噪声。)
- `npm test` 28+8+30+4 全绿;oracle(requests/total)逐档精确通过。

### T3 正确性矩阵(2026-09-15 00:40)

- `test/correctness.test.mjs` 扩展:三类库形状(cli-db / tasks-index / opencode)× 七异常(normal/empty/缺列/未知列/损坏/超长文本/未来时间戳)= 21 格,逐格断言查询行为 + doctor 分类,21/21 通过。
- 结果归档:`docs/correctness-matrix-20260915.md`。

### T4 v0.5.3 就绪(2026-09-15 00:50)

- 版本 bump:package.json / marketplace.json / plugin.json → 0.5.3;release.test 版本断言同步。
- CHANGELOG 0.5.3 条目(5 修复 + 3 改进);根/插件 README 版本与 benchmark 描述更新;`docs/RELEASE-NOTES-0.5.3.md` 草稿;`docs/PERFORMANCE.md` 重写(矩阵 + 前后对比 + 机理 + 历史对照)。
- 依赖:零第三方运行依赖,无 semver 升级项。

### T5 开放梯队(2026-09-15 00:55)

- 显示规则极值:缓存 100%/0%(0% 是数据必须显示)/input=0 时 cache 段缺席且 rates 恒在;状态文件三次工作区切换 auto 跟随 + 显式会话互不干扰。
- P2 清单:P2-3(基准真实分布)随 T2 交付;P2-1/P2-2 已修;P3 三项(空白 turn_id 计轮、prompt-submit 不可达回退、PID 复用误判存活)记录于审计文档,明确不修。
- 文档补齐:插件 README 测试清单加 correctness;审计文档回填修复结果;CI 两工作流均自动覆盖新测试(glob/npm test)。

## 收尾判定(2026-09-15 01:00)

- 门禁:npm test 4 文件全绿(degrade 28 + doctor 8 + release 30 + correctness:4 红转绿修复 + T3 矩阵 21 格 + T5 极值);真实库只读冒烟(INDEXED BY 激活)正常;doctor 全 ✅。
- 自寻轮次记录:第 1 轮发现 2 项(插件 README 测试清单漂移、真实库 INDEXED BY 冒烟缺失)→ 已修;第 2 轮候选(PROGRESS 终局、worktree/临时文件清理、本地提交)→ 已执行;第 3 轮:无新可落地项(P3 明确不修;auto 1M 1.1s 可接受且有排序主导波动说明;REVIEW.md 为本地不提交文件)。**梯队枯竭 + 连续 3 轮自寻收敛 + 门禁全绿 → 收尾。**
- 红线遵守:真实库仅 PRAGMA/SELECT 只读探查与生产路径冒烟,零写入;合成库全部位于系统临时目录且运行后删除;未 push;未执行任何发布动作;未使用 pkill/taskkill。
- 下一步(若还有 4 小时):① 真实宿主 hook 耗时采样(观察锁竞争频率,PERFORMANCE.md 遗留项);② auto 识别路径的排序优化(无 completed_at 索引时 1M 行约 1.1s,可用 MAX+回表两段查询替代排序,预计再省 ~40%);③ `(session_id)` 覆盖打分可纳入 index_xinfo 的排序列方向信息;④ CI 上跑一次 100k 矩阵防回归(当前矩阵仅本地手跑)。

# v0.5.5 可信度补丁轮(2026-10-01)

基于 `docs/GPT审核报告-20260930.md`(基线 434638f)修复 F01–F10,保持默认采样行为与默认四段行;上游 0.8.3 对照结论(第 10 节)不引入其核心。

## 改动

- **查询正确性(F01/F07/F08/F09/F10)**:强制索引只选普通非部分索引 + 一次性 no-query-solution 回退 + SQL 标识符引用;`validNumSql/validNum` 统一 SQL/JS 数值有效性(token/时长/TTFT 非负有限),TTFT 走 SQL 投影 `ttft_val`(显式列优先、数值化 first-started 回退)并要求 `0≤ttft≤dur`;坏 token 用量按 0 计 + `bad_tokens/cache_gt_input` 告警;`formatInZone` 守卫 ±8.64e15 日期范围;空白 turn_id 投影为 NULL 共用 `validIdSql`。
- **Stop 通知与诊断(F02/F03/F04/F05/F06)**:健康记录按 会话+hook 分文件(`healthFile(sid,hook)`,去掉全局镜像);stop 的 startHealth 先于读配置,任何 catch 记 error 终态;macOS 通知改 `on run` argv 传参;`submitNotify` 等待 ≤250ms 拉起确认,成功才落水位,失败记 `notify-failed` 不前进水位(下回合重试);水位按会话多槽(≤32)+展示内容指纹,旧单槽文件迁移;stdin 1.5s/64KB 限时限长。
- **doctor**:拆"注入链路采集(UserPromptSubmit)"与"通知链路(Stop)"两检查,通知四态(采集成功/通知关闭/未观察到/提交失败)。
- **测试**:新增 `test/quality.test.mjs`(30+ 断言覆盖 F01–F10 与 stdin 预算);degrade 用例 29 随多槽水位更新;release 健康断言随分文件/检查名更新;版本断言 0.5.5。诊断/测试 seam:`ZCODE_TPS_NOTIFY_BIN` 覆盖通知命令(Windows 清空 PATH 不可靠,CreateProcess 仍搜系统目录,实测确认)。
- **文档**:CHANGELOG 0.5.5 条目 + 清理重复 0.5.3 标题;两 README/tps-doctor 命令同口径(Stop 采样="已落库 completed 快照",不写"恰为完整数据")。

## 门禁(2026-10-01 22:20,Node v24.14.0,win32)

- npm test 5 文件全绿:degrade 30 用例 / doctor 8 / release 30 / correctness(矩阵 21 格)/ quality 0.5.5 回归。
- benchmark 1M 档对照 0.5.3 基线:real_indexes 典型 117ms(基线 ~170ms)/最大 360ms(~330ms,噪声内)/auto 456ms(~800ms);持续独占锁 6.53s 持平;oracle 全过。
- 真实库只读冒烟(token-rate + doctor)正常;数值守卫无可见性能代价。
- 红线遵守:真实库仅只读;合成库在临时目录;未 push、未发布;未用 pkill。
- 遗留:origin/marketplace 推送与 tag 留待用户明确授权(报告 §8.2);0.6.0(wrapUpSample 收尾采样/workflow 分账)未动。

# v0.5.5 复核修复轮(2026-10-01,报告 §11 R01–R05)

d18dab5 的独立复核(报告第 11 节)发现 5 项未闭环(1 P1 + 4 P2),本轮全部修复并独立探针复演。版本保持 0.5.5(未发布,不产生 0.5.6)。

## 改动

- **R01 通知退出码确认(P1)**:`submitNotify` 由"250ms 内 spawn 事件即记 submitted"改为等待退出结果——exit 0 → `ok`;非零退出/信号 → `failed:exit N/signal X` → stop 记 `notify-failed` 不落水位(下回合重试);限时(默认 2000ms,`ZCODE_TPS_NOTIFY_CONFIRM_MS` 200–3000)未退出 → `unknown` 按已提交处理且如实标注(避免对可能已展示的通知重复弹窗)。超时不杀子进程(toast 可能正在展示)。
- **R02 指纹覆盖展示聚合(P2)**:token-rate `session` 新增 `e2eOutputTokens/e2eDurationMs/decodeOutputTokens/decodeDurationMs`(未经四舍五入的分子/分母);stop 指纹扩为 session/usage/turn/latest 原始聚合 + 字段选择 + 时区 + 格式化行本身(排除 sampledAt)——duration 回填(轮均 100→50)与 cacheRead 回填(缓存 87.5%→50%)均触发再通知。
- **R03 Stop 全程预算(P2)**:入口设 7s deadline(< 宿主 8s),stdin/查询/通知确认/落盘按剩余预算收缩;配置先行,关闭态 300ms 短限时抓 sid 即退出;查询放有界子进程(token-rate CLI --json,超时 kill),墙钟上限不再依赖 SQLite 锁等待叠加(审核复现 8095ms → 复演 3670ms,error 终态);健康记录分段 `stdinMs/queryMs/totalMs`。
- **R04 每会话独立水位文件(P2)**:`shownSlotFile(sid)` = `…last-shown.json.<SHA256(sid)>.json`(version 3),并发 Stop 互不覆盖(审核复现 3/3 丢 A 槽 → 复演 A/B 双水位保留);旧共享多槽/单槽文件仅迁移读;`everNotified` 改独立 `.once` 标记文件。
- **R05 doctor 状态文案(P2)**:Stop 链路按本次 run 状态分支渲染(ok/disabled/notify-failed/error/running),error/running 不再出现"采集成功";`startHealth` 清空上一轮 `notified/notifyStatus` 等易变字段(`lastSuccessAt` 历史字段保留);`describeNotifyStatus` 如实映射 ok/suppressed/unknown/failed:*。

## 门禁(2026-10-01 23:40,Node v24.14.0,win32)

- npm test 5 文件全绿(quality 扩至退出码矩阵/回填指纹/预算墙钟/并发水位/doctor 文案,~16.7s)。
- 独立探针复演审核反例(临时目录合成库 + 可控通知命令,未碰真实库、未弹真实通知):R01 找不到脚本 exit 1 → notify-failed 无水位;R02 100→50/111.1→52.6/87.5%→50% 每次再通知、快照不变不通知;R03 墙钟 3670ms + error 终态 + 分段耗时;R04 双水位;R05 notified true→null、lastSuccessAt 保留、无"采集成功"。
- 基准未重跑(查询路径仅增 4 个已聚合字段的赋值,无新 SQL;benchmark 预算路径未动)。
- 红线遵守:真实库未打开;合成库临时目录;未 push、未发布;未用 pkill。
- 遗留:发布(origin/marketplace-local/tag + /plugin 更新)仍等用户授权;0.6.0 路线不变。

# v0.5.5 复核修复轮二(2026-10-01,报告 §12.3 同会话并发)

375b6c1 的第二次复核确认五项反例全部消除,剩同会话并发一项 P2(原 §11 R04 既定验收项),本轮闭环;两处 P3 文案顺手对齐。版本保持 0.5.5。

## 改动

- **R04b 同会话原子占用与防倒写**:发送前 `O_EXCL` 原子创建 `…last-shown.json.<sha256>.claim`(带 runId/pid/ts),只有占用者发送与写水位;占用后重读水位——指纹一致/完成水位更新/水位写入时刻晚于本次采样开始 → 让位(skipReason=locked/concurrent/stale),拿到锁的旧采样不再倒写新结果;拿不到锁不等待(不耗预算);pid 活性+15s 过期回收兜底强杀残留;notify-failed/异常路径释放锁可重试。`slotFrom` 补 ts 字段(让位判据);`startHealth` 同步清空 skipReason。
- **P3 对齐**:doctor hint 按通知结果分支(unknown 不再写"退出码 0"承诺;suppressed 标注测试抑制);根 README 版本行"多槽"→"独立水位文件+同会话原子占用"。

## 门禁(2026-10-02 00:40,Node v24.14.0,win32)

- npm test 5 文件全绿;quality 新增 §12.3 专项(同快照并发×3 恰调一次/倒写链/ts 让位/claim 残留三态)。
- 独立探针复演审核反例:A 同会话并发 3/3 命令调用=1(审核 2);B 倒写链调用序列 v1、v2 各一次(审核 3 次含重复)、终态水位=新指纹、快照不变第三次不再通知。
- 红线遵守:真实库未打开;合成库临时目录;未 push、未发布;未用 pkill。
- 遗留:发布(origin/marketplace-local 覆盖已安装的 d18dab5 版 0.5.5/tag)仍等用户授权;0.6.0 路线不变。

# v0.5.5 claim 生命周期修复(2026-10-02,报告 §13 E01–E03 / §14)

基于 7675d87，按用户授权直接修复三个 P2；版本保持 0.5.5，默认四段行、发消息时采样和 unknown 不自动重发策略不变。

- **E01 回收/释放竞态**：新增 `scripts/claim.mjs`，用已有 `node:sqlite` 的每会话 `BEGIN IMMEDIATE` 事务保护回收、发布、通知、水位提交和释放；`busy_timeout=0`，竞争者立即让位。释放及发送/提交前检查 owner/runId，旧 handle 不能删除新记录。`.claim` 为诊断元数据，`.claim.sqlite` 为持久事务门，运行中不能删除事务门。
- **E02 空/损坏残留**：新格式 JSON 原子发布，进程终止自动释放 OS 锁，下一占用者在事务内恢复；旧格式空、截断或非法 JSON 先保留 15s 写入宽限，超过宽限后恢复。旧格式活 PID 仍受保护。
- **E03 新目录/错误分类**：占用前初始化自定义水位父目录；目录、读写和损坏事务门错误进入 error 终态并保留具体原因，只有真实事务冲突或受保护的旧 writer 才记录 locked。
- **验证**：最终 `npm test` 5 文件全绿、fail=0，约 28.94s（Windows / Node v24.14.0）；quality 新增可控回收交错、旧坏元数据宽限、自建 owner 发布前被终止、旧 handle/owner 校验、新目录及目录阻塞/事务门损坏专项。独立探针再次复演 E01–E03：并发回收通知调用一次、过期空 claim 恢复、新目录生成水位、目录错误如实记录 error。`git diff --check` 通过。
- **范围**：只写插件源码、测试和文档及临时合成状态；真实 usage 库未打开，未执行实际通知或修改注册表。无新第三方依赖，未提交、推送或发布；其他平台/Node 与实际宿主验收留待发布检查，0.6.0 路线不变。
