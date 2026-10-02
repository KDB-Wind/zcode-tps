# 0.6.0 D01–D09 修复与验证

日期：2026-10-02；分支：feat/0.6.0；修复基线：f0d4bd3，性能对照：0.5.5/b95e0d2。版本保持 0.6.0。本记录中的源码行号指当前工作区，原审核报告中的行号仍指 f0d4bd3。

**八项 P2 正确性/契约缺陷与一项性能未达标已闭环，可以进入真实宿主发布前验收。** 默认四段行、发消息时采样、Stop hook/claim/预算未改；没有引入新依赖，没有提交、推送、tag 或同步 marketplace。原有两份未决材料保留。

## 1. 修复证据与反例

| 项 | 修复 | 当前证据 | 验证 |
|---|---|---|---|
| D01 | session/trace/actor 候选按唯一 ID 求并集；归属冲突先剔除，CASE 每行仅分一桶；NULL/空白/未知来源完整覆盖；NULL session 不绕过多 root 歧义 | diagnostic-scope.mjs:33、diagnostics.mjs:151 | diagnostics.test.mjs:408：已知范围 8 行 = observed 4 + ambiguous 4，且 NULL session 反例不回流 |
| D02 | 检查实际列、PK/非部分唯一键；缺稳定行 ID 禁用分账；相关 NULL ID 返回 invalid-data；可选列投影 NULL，缺特征以 unavailable/null 标注；run 摘要缺列 partial | diagnostic-scope.mjs:3、diagnostics.mjs:65 | diagnostics.test.mjs:426：8 个可选字段分别缺失、无 ID/无唯一约束/NULL ID、缺 run 摘要列；基础与独立模块保留 |
| D03 | 每模块独立捕获异常并继续；worker done 交付最终封包；父进程保留 no-session/软预算终态；fatal/异常关闭区分 query-error，只有真正耗尽预算才 timeout | diagnostics.mjs:579、diagnostics.mjs:701、diagnostics.mjs:761 | diagnostics.test.mjs:475：注入局部错误后 reliability/timing 继续；空库 CLI 四模块均 unavailable/no-session；既有 B01 仍通过 |
| D04 | 源行逐字段计 missing/invalid，非负安全整数才精确比较；缺失/非法字段不产出 delta；列出 skippedFields/sourceQuality；空比较与必要字段不足不 matched；显式投影 turn_usage | diagnostics.mjs:516 | diagnostics.test.mjs:493：文本/NULL/负数/溢出/空集合反例；原 matched/different/backfill 仍通过 |
| D05 | 跨 session/provider、域未知或 attempt_index 坏组排除准确指标，token 行仍保留；reported 不依赖 attempts 能力 | diagnostics.mjs:347 | diagnostics.test.mjs:514：原跨域 L 反例的 retried/additional 均为 0、flagged=1、retry partial、账本仍含 2 行 |
| D06 | root totals 直接来自唯一 workflow 行桶；同 root 多 run claim 进 unallocated，不重复分配；唯一 run + omitted + unallocated 对各 token 字段和请求数守恒；run 查询 LIMIT 50，总量不截断 | diagnostics.mjs:223 | diagnostics.test.mjs:528：双 run 同 actor 总量 1 请求/12 token；51 run 明细仅 50 条、总量 51、omitted 1 |
| D07 | 统一校验参数；current/prompt-key、未知 flag、重复参数、非法 details 一律结构化错误/exit 1；本问采样仍 unsupported | token-rate.mjs:631、diagnostics.mjs:95 | diagnostics.test.mjs:548：包括 workflow=invalid，不再悄悄查询历史 |
| D08 | generic id、全部 *_id、resumed_from 及 provider/model 分类值全局别名；同值跨表同别名；计数保持数字；对账采样排除 ID 值列，内容列继续不读取 | data-contract-sample.mjs:34、data-contract-sample.mjs:47 | diagnostics.test.mjs:557：run/trace/span/tool_call/resumed/provider/model 的原始 sentinel 与内容 sentinel 均不出现在证据 JSON |
| D09 | 只读 CTE 按 session/trace 索引取候选，SQL 内汇总不把历史行载入 JS；WHERE 的 +query_source 避免低选择性 source 索引覆盖全库；保持 5s 预算 | diagnostic-scope.mjs:33、diagnostics.mjs:413、tools/diagnostics-benchmark.mjs | 下表：百万行典型完整报表中位 214ms，实际 CLI 263ms |

核心脚本简称位于 plugins/zcode-tps/scripts/，data-contract-sample.mjs 位于 tools/，测试位于 test/。候选集合覆盖 complete 只证明已知关联范围完整；缺 trace/actor 能力时 associationCoverage=partial，不声称历史全覆盖。

同时处理相关 P3：running/未映射状态保留在账本，单列 nonFinalOrUnmappedUsage，不算已验证失败；other 只声明省略组数，不声称已计算合并指标；诊断测试自动清理自己创建的临时目录。DATA-CONTRACT 收缩了“未留存尝试导致差额”和“同父 run 验证嵌套”的无证据因果承诺；没有新增未经证实的嵌套归属猜测。

## 2. 验证结果

- npm test：六文件，Node test 汇总 **25/25，fail 0**，约 26s；默认查询 SELECT ×4，既有 Stop 通知/水位/claim/全程预算回归全部通过。
- 最后补充关联覆盖元数据后，仅重跑受影响的 diagnostics.test.mjs：**20/20，fail 0**，约 11s。
- git diff --check 通过；版本仍 0.6.0。所有写入仅限源码/测试/文档及自有临时合成库。
- node:sqlite 超安全整数的 INTEGER 读取会直接抛 RangeError：基础源行触发时整体拒绝，turn_usage 触发时该模块 query-error；两者均不会生成虚假 matched。正常大小整数仍做逐字段精确 delta。

## 3. 性能

Windows / Node v24.14.0，同机合成数据；四个生产型二级索引 session_turn/query_source/trace/started_provider_model，不执行 ANALYZE，不修改宿主索引。100k 和 1M 最终有效基准顺序执行。每个 details 场景运行 3 个新 worker，表中为包含启动和退出的墙钟中位；实际父进程 CLI 另测一次。大场景定义为本 fixture 最大的 10,000 行相关范围，含 workflow/retry 场景为其中 500 行 actor 请求及约 100 行多尝试记录。

| details 场景 | 100k | 1M | 结果 |
|---|---:|---:|---|
| 典型会话，1,000 行 | 203ms | 214ms | 全模块 ok；1M 达到 ≤2s 目标 |
| 大会话，10,000 行 | 1070ms | 1123ms | 全模块 ok |
| workflow/retry，10,000 行相关范围 | 1183ms | 1218ms | 全模块 ok |
| 无二级索引，典型会话 | 731ms | 5055ms | 100k ok；1M 按 5s 预算终止、partial，保留此前交付的基础与完整账本 |
| 实际完整 CLI，恢复索引后的典型会话 | 267ms | 263ms | exit 0，全模块 ok |

原始分段 IPC 时序及完整 100k/1M 基准：[diagnostics-benchmark-20261002.json](diagnostics-benchmark-20261002.json)。

默认 fast 对照每格预热后 7 次取中位，先断言旧/新版本返回相同 session/request/token 总量：

| 规模/索引 | 模式 | 0.5.5 | 当前 0.6.0 | 差值 |
|---|---|---:|---:|---:|
| 100k / real | typical | 34.0ms | 34.2ms | +0.2ms |
| 100k / real | largest | 161.9ms | 173.4ms | +11.5ms |
| 100k / real | auto | 120.3ms | 110.7ms | −9.6ms |
| 100k / no-index | typical | 96.3ms | 98.5ms | +2.2ms |
| 100k / no-index | largest | 94.5ms | 100.8ms | +6.3ms |
| 100k / no-index | auto | 165.7ms | 171.2ms | +5.5ms |
| 1M / real | typical | 15.5ms | 31.3ms | +15.8ms |
| 1M / real | largest | 176.2ms | 169.0ms | −7.2ms |
| 1M / real | auto | 943.4ms | 954.1ms | +10.7ms |
| 1M / no-index | typical | 739.9ms | 732.7ms | −7.2ms |
| 1M / no-index | largest | 716.2ms | 717.2ms | +1.0ms |
| 1M / no-index | auto | 1473.1ms | 1582.5ms | +109.4ms |

各格正向差值均小于 spec 的调查阈值 max(基线×20%,30ms)。不同规模的绝对时间不可直接类比，页缓存、运行时噪声和 fixture 会话分布会影响数字；只比较同格同库的旧/新结果，不外推其他机器或所有真实分布。

复现：npm run benchmark:details；100k 用 node tools/diagnostics-benchmark.mjs --rows 100000。工具使用自有临时目录，完成后校验路径并清理，保留 JSON 输出供记录。

**基准工具纠错说明：** 第一版对照向 0.5.5 传了其不支持的 dbPath，旧基线曾只读打开默认真实用量库，未写入、未读取对话内容；那组 fast 数字全部作废。工具现导入旧版前设置合成库环境路径，并断言两个版本同库同范围同用量。本记录和 JSON 仅保留重测后的有效数字。诊断 worker 始终收到合成 dbPath。

## 4. 发布边界与裁定

尚未执行真实宿主重开会话验收、实际 Stop 通知验收、远端 CI 或发布缓存验收。仍需按 RELEASE-NOTES 检查清单完成；本次修复未授权推送、tag、marketplace 同步，也未自动执行。

**升级建议：升级到修复后的 0.6.0，八项 P2 与典型百万行性能目标已经验证闭环；先完成真实宿主发布前验收，再按用户授权发布。**
