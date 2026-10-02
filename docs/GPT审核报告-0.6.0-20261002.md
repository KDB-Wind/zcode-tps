# zcode-tps 0.6.0 发布候选审核

> 后续状态：用户已授权修复，D01–D09 已在当前工作区闭环。下文第 1–14 节保留 f0d4bd3 的原始审核证据；最新源码行号、验证与裁定见 [修复验证记录](FIX-VALIDATION-0.6.0-20261002.md)。

审阅日期：2026-10-02。分支：`feat/0.6.0`。基线：`f0d4bd3`，对照 0.5.5 的 `b95e0d2`。本报告源码行号均对应 f0d4bd3，脚本简称指 `plugins/zcode-tps/scripts/` 下文件；采样工具、测试与文档使用完整相对路径。

本轮只读审阅实现，运行已有测试及临时合成库独立探针，仅新增本报告。未修改源码、测试、配置、版本、Git 历史或两份未决旧审核材料；未打开真实使用库、修改通知权限、执行真实通知、推送 origin/tag 或同步 marketplace。

## 1. 裁定

**f0d4bd3 暂缓发布。** 六文件测试复跑确实 16/16 全绿，但独立反例确认新增诊断仍有 8 项 P2 正确性/契约缺陷；另有 1 项 P2 性能验收未达标。主要问题是账本漏行/歧义行回流、可选能力探测不足、异常被伪装为 timeout、对账虚假 matched、重试分组串域、run 合计双计、未开放 current 参数静默返回历史，以及 M0 原始 ID 未完整脱敏。

未发现默认四段行、发消息时采样、0.5.5 速率/缓存公式或 Stop claim 的本轮回退证据。可以继续使用已发布/已验收的 0.5.5；本轮没有理由重新修它或生成 0.5.6。0.6.0 在未发布分支内继续修复并复验，保持版本 0.6.0。

| 编号 | 等级 | 已复现问题 | 首要证据 |
|---|---|---|---|
| D01 | P2 | NULL 来源漏账；双 root actor claim 的非 workflow 行既入总量又入歧义 | `diagnostics.mjs:127–152、216–231` |
| D02 | P2 | 实际缺字段/缺 id 时能力仍声称可用；可选列缺失导致诊断崩溃 | `diagnostics.mjs:68–95、163–174` |
| D03 | P2 | 局部 SQL 异常中断其他模块；fatal/no-session 终态被 CLI 改写为 timeout | `diagnostics.mjs:667–672、689–717、801–808、825–875` |
| D04 | P2 | 非法 model_usage 用量被归零后 matched；空比较集合也 matched | `diagnostics.mjs:585–619` |
| D05 | P2 | 同 logical ID 跨 session/provider 被合并为一次有额外尝试的逻辑请求 | `diagnostics.mjs:412–442` |
| D06 | P2 | 同 root 两个 run claim 同一 actor 时，run totals 双计 | `diagnostics.mjs:284–317` |
| D07 | P2 | 未开放 current 和含等号的错误 details 参数静默返回历史成功结果 | `token-rate.mjs:632–678` |
| D08 | P2 | M0 证据包含原始 run ID / trace ID，不满足全 ID 脱敏承诺 | `tools/data-contract-sample.mjs:354–359、439–446` |
| D09 | P2，验收 | 1M real 索引、典型千行会话全报表耗尽 5s，仅 partial | `diagnostics.mjs:163–185、216–226、337–370、404–429`；spec §11.3 |

这些反例来自合成输入和确定性边界，不是生产发生率测量。未断言本机当前库已经出现 NULL 来源、PID/ID 冲突或未知状态；“当前未观测到”不抵消 spec 对降级、歧义和错误分类的明确要求。

## 2. 已通过的部分

- 基础核心提取 `queryOnceInTxn`，基础 query 和 details 共用投影、有效性规则和同一只读事务：`token-rate.mjs:157–175、189–205`，`diagnostics.mjs:740–761`。不是另开连接冒充对账同快照。
- 默认字段仍为四段：`token-rate.mjs:551–552`；usage/session 的既有范围保持：`:443–538`；未请求 details 时走原快速入口：`:670–676`。
- `git diff b95e0d2 HEAD` 确认 hooks、runtime.mjs、claim.mjs 没有变更。0.5.5 的通知结果取舍、预算、独立水位与 claim 生命周期门禁复跑通过。
- 合法 fixture 的基础分类、重复 event 不增加行数、跨 root workflow_child 双 claim 剔除、显式非法 TTFT 不回退、provider 分组、reported 与 observed 重试分离、普通 matched/different/backfill 及缺表对账测试通过。
- 基础库连接是 readOnly，内部连接级 PRAGMA 沿用旧版；采样工具也是只读连接/事务。没有发现宿主库写入语句。
- wrapUpSample 不开放的决定正确。宿主源码存在 turnId 不等于运行时与展示验收已完成；无需为通过本轮审核实现该功能，但必须拒绝其未开放参数，见 D07。
- 版本清单与 release 断言全绿，新增测试进入 npm test。历史五文件级门禁与新增 11 个显式 test 合计为 Node 所报的 16 个测试条目；这不是所有 spec 场景各自都被覆盖的证明。

## 3. D01：账本分区没有满足完整覆盖与歧义排除

### 3.1 NULL 来源漏行

`diagnostics.mjs:135–136` 的 in-session 未知来源条件先使用 `query_source != 'main_turn'` 等比较，再在末尾允许 `query_source IS NULL`。SQL 三值逻辑下，NULL 的前置比较为 UNKNOWN，后面的 IS NULL 无法让整个 AND 成立。因此注释“含 NULL/空白”与代码不符。

独立 fixture：root S 有一条 main_turn，再插入同 session 的 NULL query_source 请求（input=10/output=2）。结果：

```text
预期 observedUsage.requests=2 / unclassified.requests=1
实际 observedUsage.requests=1 / unclassified.requests=0
兼容基础 auxiliary.requests=1（旧查询并未漏这行）
```

五桶相加仍等于 observedUsage，因为 observedUsage 直接由五桶相加派生（`:221–222`）；这种算术自洽不能证明相关请求没有被遗漏。

### 3.2 歧义行又进入非 workflow 桶

`diagnostics.mjs:151–152` 对被两个 root claim 的 actor 会话定义歧义；但 subagent/auxiliary/部分 unclassified 条件（`:127–144`）没有统一排除这份歧义集合，只有 workflow 条件单独排除 otherRootClaim。

独立 fixture：S 一条主请求，CH 一条与 S 共享唯一 trace 的 subagent；CH 同时被 parent=S 与 parent=OTHER 的 run actor 列表 claim。结果：

```text
observedUsage.requests=2
buckets.subagent.requests=1
ambiguousCandidates.requests=1
```

同一 CH 请求同时被解释为“未计入任何 root”与实际已入账，违反 spec §4.2 和 DATA-CONTRACT §4.3 第 7 条。本次仅对 subagent 完成实测，不把其它 source 分支列为额外已复现案例。

**修正与验收：** 将 root 归属/歧义判定放在来源分类之前；相关但归属不明的行不能再流入任何可加桶。NULL/全部空白字符使用共享归一规则，显式写可判定条件。用独立 usage ID 集合检验覆盖率、桶互斥及歧义集合不相交，而非只检查五桶相加等于其自身合计。补 NULL 来源、双 claim 非 workflow 两个原反例。

## 4. D02：能力探测与实际 SQL 依赖脱节

`probeCapabilities` 只检查部分列名（`diagnostics.mjs:73–91`），rowIdentity 甚至无条件返回 id 主键可用（`:79`）。workflow 声称可用但构建器还读取未被检查的 status/spent_tokens/time_created/time_updated（`:276–280`）；retry/timing/bucketAggregate 对可选字段直接引用，没有完整的 adapter 投影与缺失降级。

独立删除可选列时，基础数据仍可返回，但 API/CLI 的诊断路径如下：

| 缺列 | API 实际异常 | CLI 实际模块状态 |
|---|---|---|
| trace_id | no such column: trace_id | 四模块 error/timeout，基础保留 |
| cache_creation_input_tokens | no such column: cache_creation_input_tokens | 四模块 error/timeout，基础保留 |
| provider_id | no such column: provider_id | workflow=ok，其余 error/timeout |
| retry_count | no such column: retry_count | workflow=ok，其余 error/timeout |

另将合成 model_usage 重建为不含 id 的兼容列集合，基础仍可读；details 却仍输出：

```text
capabilities.rowIdentity.status=ok
method="model_usage.id 主键(DATA-CONTRACT §1)"
accounting 存在 / diagnostics.status=ok
```

M0 证明某次真实库有主键，不代表任意运行时 schema 都满足契约。该实现没有按 spec §4.2 在稳定身份缺失时停用账本。

**修正与验收：** 能力探测必须检查当前表/所需列及身份唯一约束，方法与数据契约分别说明。各模块只依赖自己所需字段；缺 cache_creation/trace/provider 等按契约降级，不改变 REQUIRED_COLS。retry 报告与尝试分组分开探测，不能缺 lrid 就丢掉仍可读的 retry_count，也不能只有 lrid 就认定所有 retry SQL 可用。新增 missing-column/缺唯一身份反例，doctor 的“可用”与真实调用保持一致。

## 5. D03：可选模块异常与 IPC 终态被误报

`buildDiagnostics`（`diagnostics.mjs:689–717`）没有各模块错误边界。任何同步 SQL 抛错进入整个 queryDetailed catch（`:756–758`），后续独立模块不再执行。worker 的 queryDetailed 返回值又被丢弃，只发送无结果的 done（`:801–808`）。parent 虽保存 fatal/done，但基础已交付后的模块补齐统一写 timeout（`:825、832–833、869–874`），既不使用真实 fatal 原因，也不区分正常 no-session 返回。

D02 的四个缺列探针已证明非超时 SQL 错误被标成 timeout。另以空 model_usage、无 session 环境变量、无 last-session 状态的同一合成库对比：

```text
API: diagnostics.status=unavailable，各请求模块 reasonCode=no-session
CLI: 约 73ms 正常结束，四模块 status=error/reasonCode=timeout
CLI capabilities.note="meta 消息未及送达(超时),能力列表不可用"
```

原因是 no-session 分支在 `:667–672` 提前返回，没有发送 meta/module；worker 不发送最终 envelope，parent 只能错误猜测。

**修正与验收：** optional 模块错误局部返回 query-error/schema-missing，继续可独立执行的模块；共享连接已无法使用等系统错误应明确标记，不冒充 timeout。IPC 必须能交付最终 envelope 或所有语义终态，包括 no-session、软 deadline 跳过与正常 done。parent 只有发生真正 deadline/终止才使用 timeout；真实 fatal 原因应保留。补 API/CLI 同输入一致性、空库/no-session、缺 retry 列但 timing 仍成功的反例。

## 6. D04：对账存在虚假 matched

`diagnostics.mjs:585–590` 使用 sumOk 将非法/缺失 model_usage token 归零，却没有保留每字段源行质量。`:606–609` 只验证聚合结果是否整数；`:605` 跳过所有 NULL 的 turn_usage 字段，`:619` 在没有任何有效比较时默认 matched。

两个独立反例：

1. 一条 model_usage 的 input_tokens='bad'、output=20；turn_usage 的 requests=1/input=0/output=20。实际 result=matched，input delta=0，未显示源 input 非法。非法值被处理成真实零后得到“精确一致”。
2. turn_usage 的 model_request_count/input/output/reasoning/cache 等全部 NULL。实际 result=matched，comparedFields=[]。没有比较证据，却宣称匹配。

**修正与验收：** 对账必须使用源行字段质量，非法/缺失源值不产出该字段准确 delta；必要字段全未知时 unavailable/invalid/scope-incomparable，不能 matched。列出已比较/跳过字段与原因，matched 至少要求声明范围内的有效比较证据。整数还应守卫非负与可安全精确表达的范围，不能将负整数视作有效 token。补非法 model_usage、NULL 双方、空比较集反例；保持 delta 方向为 model_usage−turn_usage。

另外，`:592–593、622` 文案写“token 限 completed”，实际 SQL 没有 status 过滤，确实聚合同键全部状态。修复时须根据已验证的 turn_usage 范围统一说明，**不要按这条错误注释把 SQL 改成 completed，以免破坏正确的全状态对账**。

## 7. D05：logical_request_id 跨域误合并

`diagnostics.mjs:412–418` 将全部相关行按 lrid 单独 GROUP BY；虽统计 sessions/providers（`:417`），clean/retried/additional 判定（`:420–422`）并不排除跨域组。质量字段只是附注，准确重试指标已经产生。

独立 fixture：root S/provider P 的 main_turn 与 child CH/provider otherProvider 的 subagent，共享 trace；二者 logical_request_id 都是 L，attempt_index 分别 0、1。实际：

```text
logicalRequestsObserved=1
retriedLogicalRequestsObserved=1 / additionalAttemptsObserved=1
multiSessionGroups=1 / multiProviderGroups=1 / flaggedGroups=0
retry.status=ok
```

本机 M0 观察 lrid 全唯一、attempt_index 恒 0，证明的是采样留存范围没有多尝试组，不能证明跨 session/provider 分组作用域或发生多行时的含义。spec §6.2 明确要求验证组合键，不能遇到反例只做附注后继续输出准确重试数。

**修正与验收：** 验证并实现作用域键；没有可靠证据时跨域组隔离/不产出准确重试指标，保留 token 行。reported 与 observed 两层继续分开。补同 lrid 跨 session/provider、重复/缺失 index、部分尝试不留存；不能简单把所有 observed 指标改成 0 来绕过未知语义。

## 8. D06：run 级合计双计

`diagnostics.mjs:284–289` 对每个 run 独立查询其 actor session 并累加，run 之间没有行 ID 归属互斥。`:303` 仅在累加后用请求数检查守恒，发现不一致时标 partial，但仍保留重复的 totals 数值。

独立 fixture：同 root S 的 A/B 两个 run 共同 claim 一个 WF actor session，WF 只有一条 input=10/output=2 的 workflow_child。实际：

```text
accounting.buckets.workflow.requests=1 / total=12
workflow.runs[*].requests=[1,1]
workflow.data.totals.requests=2 / total=24
workflow.status=partial，守恒告警存在
```

partial 告警有价值，但不能把已知重复的合计当作已记录量输出。当前 `/tps` 文案只展示 ok workflow，机器消费者仍会收到 totals=24。

**修正与验收：** 可靠 root 已确定而 run 细分冲突时，root workflow 用量可按唯一行集合保留一次；run 层用唯一 owner/未分配 run 桶/冲突候选表达。totals 必须来自去重集合，不能来自重叠明细相加。分别守卫请求数与各 token 字段守恒；截断到 50 run 时也不把已展示明细小计冒充全部 workflow 总量。补同 root 双 run 的原反例。

## 9. D07：CLI 参数错误静默回退历史查询

`token-rate.mjs:632–665` 仅识别 --session/--details，没有拒绝 --current/--prompt-key；未进入 details 就走普通 query（`:670–678`）。独立执行：

```text
node token-rate.mjs --json --session S --current --prompt-key nonexistent
exit=0，返回普通基础 JSON，turn.turnId=T（历史轮）
没有 current 状态，没有 unsupported/参数错误
```

README 明确未开放，capabilities.currentPrompt 也正确为不可用；但调用端请求 current 时不应通过普通成功返回弱化该边界。未宣称当前 CLI 把文案写成“本问”，问题是它没有拒绝未实现的本问请求。

另一个独立反例是 `--json --session S --details workflow=invalid`：退出 0，没有 diagnostics/parameterError，返回历史 turn=OLD。`:657–659` 对含等号值把 details 设置为 null，注释称“不可达”，实际上正常的该参数形态就会进入此分支，绕过 parseDetailModules 对未知模块的检查。它不属于 spec 已支持的模块名单，必须报参数错误，不能默默完成另一种查询。

**修正与验收：** 统一参数解析与校验，含等号等未知模块值必须结构化报错；明确识别并拒绝未开放的 current/prompt-key，结构化 unsupported/参数错误及非零退出，或者返回独立 unavailable 结构且绝不混入历史 turn。不要为修本项实现收尾采样。补畸形 details 与 W 延后态的 CLI 行为；wrapUpSample=true 也应有一致 unsupported 说明，不宣称开关有效。

## 10. D08：M0 ID 脱敏不完整

`tools/data-contract-sample.mjs:6–8` 承诺所有 ID 脱敏；实际 turn_usage 样本的键名匹配（`:357–358、384–385`）没有 trace，dwf 通用样本（`:444–445`）没有通用 id。未命中者走 clip，输出原始值。alias 本身还带字段种类前缀（`:34–43`），同值不同字段的完整别名不相同；哈希后缀相同不等于文档承诺的“同值同别名”。

合成采样工具端到端复演（没有使用真实 ID）：

```text
dwf_run.id="PRIVATE_RUN_060"
turn_usage.trace_id="PRIVATE_TRACE_060"
采样 exit=0，证据 JSON 同时含这两个原始字符串
```

这不是证据文件里冒充真实内容的示例，也不是默认统计输出的泄露；它是 M0 工具未兑现脱敏契约的实现反例。未发现本轮读取/输出 error_message、raw_usage_json 或 dwf_event.payload_json 的实测证据，不扩大成未经证实的对话内容泄露结论。

**修正与验收：** 使用显式安全字段投影及统一 ID 分类/别名，不只依赖关键词正则；覆盖通用 id、trace_id、span_id、tool_call_id、resumed_from 等实际身份/链接字段，跨表等值关系按契约可比较。补 sentinel 端到端输出检查，断言原始 ID 不在证据文件中。schema 元数据可保留，不保存真实内容值。

## 11. D09：完整报表在正常百万行场景未达性能目标

独立合成压力冒烟：1,000,000 行、1,000 个会话，目标 S0 仅 1,000 行；全部 completed main_turn，无实际 workflow/错误请求；列集完整，四个生产型索引为 session_turn/query_source/trace/started_provider_model。它是简化健康输入，不等同真实分布矩阵，也不是超大单会话或无索引场景。

对同一库复制 b95e0d2 的原始 token-rate/runtime 到系统临时目录，分别预热一次后测 7 次热查询中位：

| 读取 | 本次结果 |
|---|---|
| 0.5.5 快速 query | 34.5ms |
| f0d4bd3 快速 query | 38.2ms |
| f0d4bd3 全 details 默认 CLI | 墙钟 5401ms，exit=0，status=partial；workflow=ok，其余 error/timeout；基础/账本请求数仍为 1000 |

基础差异约 3.7ms，没有触及 spec 的未解释回退调查阈值。新增诊断则未达 spec §11.3 的 1M real 典型会话 2s 目标，全报表在默认 5s 内无法完成。

为区分初次启动噪声与模块耗时，另建同分布库，在自建 worker IPC 打点并按 5s 终止：

```text
全模块：base 98ms → meta 99ms → accounting 2297ms → workflow 2297ms
        5057ms 终止；没有 reliability/timing/reconciliation 完成消息
仅 timing：base 101ms → timing 480ms → done 497ms → close 504ms
```

说明问题不是基础查询或仅 timing 不能运行，而是分账/可靠性阶段消耗了全局预算。代码中五桶+歧义各自执行用量及 status 查询（`diagnostics.mjs:163–185、216–226`），reliability 又反复计算复杂 OR 关联范围（`:337–370、404–429`）。这是优化候选解释，未取得 EXPLAIN/完整 profiling，不宣称已经锁定唯一瓶颈。

**修正与验收：** 优先只读事务内复用目标 ID/关联范围、合并聚合、减少相同范围重复扫描，不给宿主建索引、不提高预算掩盖问题。补 100k/1M real 典型/最大、代表性 workflow/retry 与无索引矩阵，记录默认 fast 对照和 details 分段时间。若决定降低目标，必须明确修订 spec 与产品能力边界，不能继续称 M5 全部通过。当前 5s 超时保留部分的机制有实际效果，本项不把诚实 partial 误判为伪造完整。

## 12. 非阻断观察与证据缺口

### 12.1 P3：非 completed 一律计为失败

`diagnostics.mjs:355` 的 failed 选择条件是 status !== completed，未映射或进行中状态也进入 failedRecordedUsage。独立注入 running/completed_at=NULL/input=100/output=20：failedRecordedUsage=1 请求/120 token，同时 unterminatedRows=1。既然不认识 running，应列为未知/未终止，不能给它已验证的失败语义。

M0 当前只观察 completed/error/cancelled，因此不将它列为已知本机生产错误；建议下次相关小改动按已验证失败状态筛选，保留未知桶，勿删除其已记录用量。

### 12.2 P3：other 没有被合并的样本数/指标

`diagnostics.mjs:525–532` 返回前 50 个 provider/model 组，other 仅含被截断的组数，没有对应样本数、均值/分位或足以对齐总样本的字段。现有 B02 仅检查长度和 other.groups（`test/diagnostics.test.mjs:323–325`）。文案“合并为 other”更准确地应是“省略细分”，或补真实 other 聚合；不要平均各组 mean 充当样本合并。

### 12.3 P3：诊断测试临时目录未清理

`test/diagnostics.test.mjs:16–18` 每项新建 zcode-tps-diag-*，文件内没有 after/finally 目录清理。与 spec 临时 fixture 用后清理的预期不符。本轮独立探针目录全部自行校验位置并清理；不批量删除无法确认归属的历史测试目录。建议 fixture 带测试级 teardown，先关闭自建连接/进程再按准确路径清理。

### 12.4 M0 文档的推断需要与观测分开

DATA-CONTRACT §5/§7 的“失败尝试不留行”“workflow 差额包含未留存尝试”不能仅从 lrid 全唯一、attempt_index 恒 0、turn_usage 大于 model_usage 得出唯一因果；还可能涉及采样留存、异步回填、聚合范围。本文接受用户给出的实测数据，不否定其数值；未读取宿主重试持久化源码或其他原始证据，因此只把“采样未见多尝试行”“出现差额”视为当前可直接支持的事实。

采样工具主轮 cross-check（`tools/data-contract-sample.mjs:401–405`）只求 completed input/output，DATA-CONTRACT §7 文案又说同键全部 usage 行。建议记录实际样本中两种聚合值及来源/状态范围，再确定对账 adapter；不要把只有样本范围的结论写成全局恒等契约。

### 12.5 “嵌套 workflow 已验收”证据不足

测试夹具中 `dwfrun-2` 的 parent_session_id 仍为 sess-main，仅设置 resumed_from=dwfrun-1（`test/diagnostics-fixture.mjs:180–181`）；DATA-CONTRACT §4.2 又明确 resumed_from 语义未验证。这个 fixture 证明同 root 不同 actor 的多个 run 不重复，不能证明真正的父子嵌套归属已完成。

实现只找 parent_session_id=sid 的 run（`diagnostics.mjs:112、279`），没有验证后的递归父子链或输出其父子关系。本轮没有证据证明实际宿主一定把嵌套 run 的 parent 记为 actor session，故不据此新增“真实库嵌套漏账”缺陷。应补真实拓扑证据与专门 fixture，或明确嵌套细分未开放，不能把 resumed_from 猜成父子关系。

### 12.6 M4 与发布验收的完成表述

M4 是有依据延后，不是功能已实现；作为 0.6.0 的范围裁决合理。发布说明还有实际 hook 默认行、/tps 完整报表与六环境 CI 的未勾选项目（`docs/RELEASE-NOTES-0.6.0.md:71–73`），本轮也没有运行真实宿主。用户提供的真实库 CLI 回归可作为旁证，但它与真实 hook/模型展示验收不同，不能称全部 M5 发布门禁通过。

## 13. 本轮验证与范围

- Windows / Node v24.14.0，`npm test` 16/16、fail=0，6 文件，总耗时 25959.082ms；不重复跑已通过且未变化的完整门禁。
- `git diff --check b95e0d2 HEAD` 通过。默认快速 SELECT 门禁实测 4 条，未放宽 ≤8。
- 独立探针覆盖：NULL source、缺可选列、空库 no-session、缺 id、跨域 retry、双 claim 非 workflow、同 root 双 run、非法/空字段对账、未知状态、未开放 current、M0 脱敏与百万行分段耗时。期望基于手工定义的行数/数值与 API 契约，不调用生产聚合函数生成 oracle。
- 合成 schema 复用项目 fixture 仅为建表/插入便利；NULL 来源通过显式覆盖插入，避免 row helper 的 `??` 默认值抹掉 NULL（`test/diagnostics-fixture.mjs:65–87`）。探针开发期间建库/ALTER 的个别调度脚本错误已修正，不列为产品缺陷；已完成的结果均来自可成功执行的独立反例。
- 独立工具/库/基线拷贝均在核验后的系统临时目录，已等待自建 worker 退出并清理；不涉及源码、宿主或用户数据删除。
- 本轮没有打开真实 model_usage 库、读取宿主对话、执行实际横幅、运行实际 ZCode hook 或访问远端。其它 OS/Node 的 CI 和发布缓存仍未实测。百万行冒烟不是完整 benchmark 矩阵，不能据此宣称所有性能场景已通过或都失败。

两份用户未决旧材料仍保持 untracked，不纳入审核报告结论、不删除或提交；本轮新增的唯一项目文件是本报告。

## 14. 建议修复顺序与发布处置

1. 先修 D02/D03：建立实际能力依赖、模块错误边界与 IPC 最终结果；这会让后续所有反例拥有可信 reasonCode，并保持独立 timing/reconciliation 可读。
2. 修 D01/D04/D05/D06：先证明行集合覆盖/互斥/歧义排除，再验证对账质量、retry 作用域和 run 去重合计。只修已有诊断，不扩展新的归属猜测。
3. 修 D07/D08：拒绝 current 未开放请求，补全证据工具 ID 脱敏；不为通过验收开放 wrapUpSample。
4. 按 D09 定位、合并扫描并跑必要性能对照。P3 文案/teardown 可随相关改动对齐；嵌套/重试因果无证据时在能力矩阵中收缩承诺。
5. 新增原反例行为回归，完整 npm test、平台 CI 与真实宿主默认行/报表验收完成后再发布。

这些修复适合现有 fixture/脚本与 CI，不需要新增 agent 或常驻服务。所有修复追加在 feat/0.6.0，不改已发布 0.5.5 历史；版本仍为 0.6.0，不因候选审核未通过而产生 0.6.1。本报告不执行任何发布动作，也不将“同意修复”自动解释为远端/marketplace 授权。

**本次裁定：升级到 0.6.0 有价值，但暂不发布 f0d4bd3——先修复八项诊断/契约 P2 并闭环性能验收，保留默认兼容行为和收尾采样延后决定。**

## 15. D01–D09 修复闭环

八项 P2 和性能项均已修复，版本保持 0.6.0；完整 npm test 25/25，最后受影响诊断回归 20/20。百万行典型 details 中位 214ms，实际完整 CLI 263ms；无二级索引百万行仍按 5s 预算诚实 partial。完整证据、基准工具纠错及发布边界见 [修复验证记录](FIX-VALIDATION-0.6.0-20261002.md)。未提交、推送或同步 marketplace。

**后续裁定：建议升级到修复后的 0.6.0，先完成真实宿主验收；原 f0d4bd3 的暂缓裁定保留为历史证据。**
