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
