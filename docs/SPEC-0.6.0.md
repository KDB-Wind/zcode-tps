# zcode-tps 0.6.0 开发规格

日期：2026-10-02。状态：可用于开发的规格；尚未实施。基线：本地提交 `b95e0d2`，版本 0.5.5，包含 F01–F10、R01–R05、R04b 和 E01–E03 修复。本规格不代表 0.5.5 已完成本地或远端发布；开始开发时以实际发布提交为基线记录。

本版本目标：让完整报表回答“哪些请求、哪个来源、多少已记录用量、有哪些失败与等待”，同时保留 0.5.5 默认统计行为。workflow 分账和可选收尾采样必须先证明归属，证据不足时降级或延后，不能以猜测填满功能。

文中 **必须** 是验收条件，**建议** 是可替换的实现选择。下文定义的新字段、CLI 和配置属于本版本接口设计，不是在声明宿主已经提供这些能力。

## 1. 决策摘要与交付范围

| 能力 | 0.6.0 定位 | 发布要求 |
|---|---|---|
| 可解释用量分账 | 主能力：主对话、普通子代理、workflow、辅助、归属不明确分别列账 | 请求去重、范围与质量说明必须交付；workflow 自动关联须通过证据门槛 |
| error / retry 诊断 | 必做：保留请求状态、失败已记录用量；验证后区分逻辑请求与尝试 | 未验证的 retry 语义必须返回 unavailable，不能伪造准确尝试数 |
| TTFT 与模型维度 | 必做：来源、样本覆盖率、分布和 provider/model 分组 | 复用现有计时公式；不改名 HTTP TTFB，不改变默认行 |
| turn_usage 对账 | 按需诊断，优先支持最近已观察轮次 | 有表且字段语义验证后交付；否则有明确 unavailable 原因 |
| 本问快照与 wrapUpSample | 条件交付、默认关闭 | 宿主 turn 绑定及真实调用验收通过才开放；不足时整体延后，不阻断诊断版 0.6.0 |
| 大屏、MCP、daemon、费用账单 | 本版本不做 | 现有 CLI/JSON 足够；缺少需求或计费证据 |

0.6.0 最小可发布集合是：保持兼容的完整报表、互斥分账基础、状态/已记录失败用量、TTFT 分布、能力与降级说明。workflow/retry 深层语义、对账和收尾采样按证据决定开放范围，不以临时猜测实现换取清单齐全。若这些证据未取得，发布说明必须逐项写明哪些已开放、哪些只提供不可用诊断、哪些延后。

## 2. 继承契约与非目标

### 2.1 必须保持的行为

1. 默认 `rateLineFields=["rates","decode","session","cache"]`，默认在 UserPromptSubmit 采样；原四段行在同一输入下保持相同结果和取舍。
2. `tokenRateLine` 默认开启，`turnEndLine` 默认关闭，`includeSubagents` 默认开启；通知仍独立 opt-in。`tokenRateLine=false` 继续停用自动行与 Stop 通知，手动 `/tps` 仍可查询。
3. `model_usage` 是唯一用量主账。宿主数据库只读，无 INSERT/UPDATE/DELETE、索引创建、迁移、ANALYZE 或 journal_mode 修改。插件配置/状态与合成测试数据库另算。
4. `input_tokens` 已包含 `cache_read_input_tokens`；`reasoning_tokens` 是 output 的明细。总量为 input+output，缓存读和 reasoning 不再次相加。cache_creation 单列，不在未验证 provider 语义前额外加入总量。
5. 无效数值、时间、turn ID 继续使用 0.5.5 的守卫；已记录用量与有效速率样本解耦。历史字段无效按 0 聚合并告警的兼容行为保留，新增诊断必须同时暴露未知/非法计数，不能把这些 0 解释为完整账单。
6. 原 JSON `latest/session/turn/usage/cacheHit/decodeStats/auxiliary/history/coverage` 的语义不变。新增账本不得悄悄扩大 session 或 usage 的范围。
7. Stop 全程 7s 预算、宿主 8s 配置、查询超时终止、退出结果确认、unknown 不自动重发、每会话事务 claim 与防倒写守卫保留。新增完整诊断不挂入默认 Stop 或 prompt 查询。
8. 基础查询可在缺可选表/列时继续工作，hook stdout 保持宿主约定的 JSON，错误不驱动模型续跑。

### 2.2 不做的工作

- 不把请求服务时长相加后的速率叫整轮墙钟吞吐，不预估最后总结尚未落库的 token。
- 不根据“近期有请求”判定 workflow/turn 正在运行，不根据 completed 请求宣称整轮已结束。
- 不把 dwf 前缀、完成时间或本地 nonce 当作主会话/本问关联的充分证据。
- 不直接引入上游 0.8.3 核心，不改变 warning 监听器、不混用演示数值，不复制另一套统计 SQL。
- 不做全历史增量缓存、后台监控、自动状态文件清理、价格估算或 provider 原始 JSON 的通用解析。
- 不在新版本开发中顺手重写 0.5.5 提交历史或替用户发布。

## 3. 证据阶段：先确认数据契约

### 3.1 已知与未确认的边界

2026-09-30 用户实测确认 model_usage 相关列存在、schema 无漂移，并确认 input/cache-read 子集关系。已有实现使用 trace_id 归因 subagent。资料列出 id、logical_request_id、attempt_index、provider_id、query_source、status、retry_count、cancelled_by_user、error_* 等列；**列存在不代表其唯一性、枚举或统计语义已确认**。

dwf_run/dwf_actor/dwf_node/dwf_event 与 turn_usage 的具体列、主外键和更新时序未在本规格中假定。资料内字段数量文字与实际列举不一致，开发以实际 PRAGMA 结果为准，不按文档数量硬编码 schema。

### 3.2 开发第一步必须产出

新增 `docs/DATA-CONTRACT-0.6.0.md`，记录经过验证的 schema、关联图、状态映射与脱敏实例。以实际开发当日数据为准，不把 9/30 无漂移结论当未来保证。

| 问题 | 所需证据 | 不能采用的捷径 |
|---|---|---|
| usage 行身份 | 实际主键/唯一约束、跨样本稳定性 | 拼 token/时间作 ID；无依据删除“看起来相同”的请求 |
| workflow 发起主会话 | run→主会话、run→actor/node→usage 的实际键与实例 | 仅 session_id 前缀；把全库 workflow 算给当前会话 |
| 嵌套与重复关联 | 普通/嵌套 run、重复事件、同 trace 多请求、冲突 root | 按 event 数累加 token；默认每个 trace 唯一属于一个 root |
| 请求状态 | 实际 status 值、取消/错误字段与状态的关系、何时落 token | 猜测 failed/error/cancelled 是宿主全部枚举 |
| retry | logical_request_id 的作用域、attempt_index 起点与唯一性、retry_count 含义 | retry_count 求和当重试次数；只数最终成功行 |
| TTFT | 显式列及 first-started 回退的计时语义 | 解释为 HTTP 字节或首个可见正文时延 |
| turn_usage | session+turn 键、粒度、包含的来源/状态、字段包含关系、回填行为 | 原值直接与含子代理 session.total 比较 |
| 当前 prompt | 实际 hook 输入、宿主 turnId/请求映射、工具执行时的标识传递 | 本地 nonce 或 completed_at≥promptStartedAt 直接证明归属 |

采样只读 PRAGMA/SELECT，限制行数与范围。优先使用专门产生的测试会话；记录宿主版本、采样时间与契约来源。文档不保存对话内容、error_message、raw_usage_json、provider_metadata_json 或完整 dwf_event payload；脱敏 ID 必须保留关联关系。

允许基于已验证语义编写字段 adapter；必须探测其所需字段。缺字段、未知映射或冲突时该能力 partial/unavailable，基础查询继续。不能仅凭客户端版本号跳过 schema 检查。新增可选字段不得放入基础 REQUIRED_COLS。

## 4. 统一范围、账本与聚合规则

### 4.1 两种范围分别存在

- **兼容范围**：0.5.5 的 completed main_turn，以及按现有规则可选并入的 trace subagent；usage 仍是主对话，auxiliary 独立。默认行全部取兼容范围。
- **诊断范围**：与当前 root session 有已验证关系的 model_usage 行，可含非 completed 状态和新增已关联 workflow。完整诊断显式标注 `rootSessionId`、状态范围、已证实的关联路径及缺失范围。`includeSubagents=false` 不妨碍手动诊断列出子代理，但两者范围必须分别注明。

新总量命名 `diagnostics.accounting.observedUsage`，文案“相关请求已记录用量”；不得冒充原 session.total 或所有历史真实消耗。全局其它 session、未关联 workflow 不进入它。缺少关联证据不等于已证明无 workflow。

### 4.2 防重与互斥分类

诊断行身份优先采用验证后的 model_usage 主键 id；无稳定唯一身份时 accounting 能力不可用，基础查询保留。多条路径命中一行时先按行 ID 求并集，再分类，再汇总。逻辑请求 ID 不用于 token 行去重，因为一次逻辑请求可以有多次实际尝试。

分类顺序固定为：

1. `main`：当前 root session 的主对话请求。
2. `workflow`：其余行中有唯一可靠 root/run 归属的 workflow 请求。
3. `subagent`：其余行中可靠归于当前 root 的普通子代理请求。
4. `auxiliary`：其余已归属行中的标题、压缩、验证等内部请求，保留原 source 细分。
5. `unclassified`：已能证明与 root 相关，但来源类别未知或 workflow 细分冲突的请求。

不同 root 同时命中且无法判明归属的行不纳入任何 root 总量，单列 `ambiguousCandidates` 的数量/已知用量及冲突原因。来源分类和 root 归属是两件事；unknown source 若 session 归属明确，仍可进入 unclassified。main 与 workflow 证据冲突时主请求只计一次，保留 main 并发出分类冲突诊断，不能静默转移 headline。

workflow 从旧 subagent 类别移走只影响新诊断分类；不得用“旧 session.total + 新 workflow.total”合计。共享 trace 命中但无更强 root 消歧证据时必须标记潜在歧义，不宣称 trace 给出了唯一 root。

### 4.3 每个桶的统计

每个 bucket 返回 requests、状态计数、input/output/reasoning/cacheRead/cacheCreation、total=input+output、关联依据摘要和 quality。非法/NULL token 字段聚合方式复用 0.5.5，但 quality 至少提供每字段 knownRows/missingRows/invalidRows，`tokensComplete=false` 时人类文案写“已知部分”。0 条已确认行可以是 0；能力未知或查询失败必须为 null/不可用，不能写 0。

必须满足：按同一字段与同一状态范围，互斥 bucket 之和等于 observedUsage；workflow 各直接桶之和等于 workflow 桶。嵌套 run 的父级 inclusive 视图只能另列，标明含子节点，不能与子节点或总量相加。不把 dwf 表里的 token 摘要与 model_usage 相加。

requests 是库内 usage 行数，不是任务数、turn 数或逻辑请求数。每个报表表格必须显示自己的 scope 和状态范围。

### 4.4 速率不换公式

端到端有效样本集 E：completed、output 为合法正数、dur 在现有 `[min,max)` 门槛内；`dur=duration_ms ?? (completed_at-started_at)`，沿用现有数值规则。Decode 有效集 D 为 E 中 TTFT 合法且 `0≤TTFT≤dur`、`dur−TTFT≥200ms` 的行。

```text
E2E tok/s    = 1000 × Σ(output[E]) / Σ(dur[E])
Decode tok/s = 1000 × Σ(output[D]) / Σ(dur[D] − TTFT[D])
缓存命中率    = 100 × Σ(cacheRead) / Σ(input)，分母为 0 时 null
```

速率在相同样本集内求分子分母，不平均请求 tok/s 代替加权总体。并发时请求时长相加，不减掉重叠。错误/取消行可进诊断用量，但不混入兼容 headline 或 completed 速度分布。

## 5. workflow 分账

必须提供能力状态：`ok/partial/unavailable/error/not-requested`，以及已关联请求数、关联路径、冲突/无法细分的数量。没有任何已验证的 root 关联方法时返回 unavailable，而非“本会话 workflow=0”。

仅在已验证 adapter 下输出 run 列表：run 的脱敏显示标识、可用的父子关系、直接 usage 行数/用量、已知状态、关联质量。节点/actor 细分为可选项，不要求导出全事件日志。

未归属候选仅限与当前 root 有可解释弱关联的候选集合；不为此默认扫全库并展示其它会话消费。若只有 dwf 前缀可发现全局记录，应由手动证据采样描述“库中存在 workflow，当前归属不可确认”，不生成当前会话候选总量。

验收重点：已有 trace 子代理路径与 dwf 路径双命中不增加总量；重复 dwf_event 不增加用量；嵌套归属不重复；跨 root 冲突不误加；缺任一所需表/字段时基础 query 仍工作。

## 6. error / retry 诊断

### 6.1 状态与错误

按 DATA-CONTRACT 映射真实状态，并保留未映射 raw status 的分组计数。行按互斥状态计数；cancelled_by_user/context_exceeded/retryable 是可重叠特征，必须明确它们不是可加的状态桶。未经验证的状态不能仅凭 completed_at 是否非空归为 completed。

返回各状态的 requests、已记录 token 及缺失/非法字段数。失败有 input/output 就计入 observedUsage 一次；失败无 token 就报告未知，不从成功请求推算。未终止行的 token 必须标注“可能回填”，不能当最终消耗。

error_type/error_code 只做脱敏类别/码统计。默认不输出 error_message 或 provider 原始 payload；未知/高基数字符串限制数量、长度并防止控制字符污染报表。成功和失败用量来自同一行集合，不能再叠加“失败额外成本”。

### 6.2 尝试与逻辑请求

只有 logical_request_id 的分组作用域和 attempt_index 语义得到验证，才开放逻辑请求指标。adapter 明确组合键；不要在未知作用域下跨 provider/session 合并相同 ID。

- `attemptRows`：诊断范围内观察到的 usage 行数，始终注明留存范围。
- `groupedAttemptRows/ungroupedAttemptRows`：有可靠逻辑归属与无可靠归属的行数。
- `logicalRequestsObserved`：有可靠分组的不同逻辑键数，不代表所有实际逻辑请求数。
- `retriedLogicalRequestsObserved`：可靠分组中观察到多个不同有效 attempt 的逻辑请求数。
- `additionalAttemptsObserved`：各完整有效分组的 `max(有效尝试数−1,0)` 之和；只说明观察到的额外尝试，不推断已被清理的尝试。

同组重复 attempt_index、缺失或非法 index 必须诊断；相关组不产出准确重试指标，不能删除其 token 行来“修正”数据。retry_count 作为宿主 reported 摘要单列、解释其已验证语义，不与观察尝试数相加。

error 后成功、取消后重试、首尝试未留存、分组字段缺失/冲突、跨 session 同 logical ID 均须测试。语义未验证时保留状态和用量诊断，retry 指标返回 unavailable。

## 7. TTFT、Decode 与模型维度

字段统一称 TTFT/首 token 等待，不宣传为 HTTP TTFB。沿用显式 `time_to_first_token_ms` 优先、仅 NULL 时回退 first_token_at−started_at；显式非法值不静默改用回退制造有效样本。

完整报表的 timing 基础范围为 completed main_turn，与原 decodeStats 对齐；可按 accounting bucket 扩展时必须另标范围。至少返回 direct/derived/missing/invalid 计数、有效 TTFT 样本数/候选请求数、TTFT mean/median/p90、Decode 样本数及原始分子分母。

TTFT 有效集只要求合法可用 dur 与 `0≤TTFT≤dur`；零输出也可有有效等待时间，不因没有速率样本删除等待信息。TTFT mean 为请求算术均值，median/p90 为 nearest-rank；不得称 token 加权等待。Decode 仍使用第 4.4 节更严格的有效集。

provider_id+model_id 为分组键；同名 model 不跨 provider 合并，缺 provider 归入明确 unknown 桶。字段不存在时保留模型或总体诊断并标注缺失。分组必须给样本数，零样本返回 null。汇总与分组覆盖率对齐；显示表最多 50 组，其余为 other，机器输出也限制高基数规模并说明合并规则。

默认 `ttft` 紧凑段仍展示最近请求，默认四段不自动加入 TTFT。完整报表必须区分“最近请求首字”和“会话请求等待分布”。

## 8. turn_usage 对账

对账仅在手动 details 请求执行，默认只对最近已观察、ID 有效的主轮。保留拓展到少量指定轮的接口空间，不默认扫描全部历史。

在与 model_usage 同一只读事务快照内读取 turn_usage；只有 verified session+turn 键、来源/状态范围、单位与 token 包含关系一致的字段可比较。优先与主对话 turn 聚合比较，不与含 workflow/子代理会话总数比较。两表不可相加，不把 turn_usage 改成主数据源。

返回：`matched/different/missing-aggregate/scope-incomparable/invalid/unavailable`、比较范围、model_usage 值、turn_usage 值、可比较字段的 delta=model_usage−turn_usage、snapshotId/sample 时间与 missing/invalid 信息。整数 token 必须精确比较；时长字段除非单位及容差已写入 DATA-CONTRACT，否则不比较。

同一快照排除两次独立读取的采样差，但不能排除宿主异步聚合滞后。单次不同只能描述“当前快照不一致，可能尚未回填”，不能定性数据损坏，也不能仅凭 turn_usage 有行证明整轮结束。matched 只证明已比较字段在该快照一致。

缺表是 unavailable，不影响 doctor 基础健康或 hook；用户明确请求对账时给能力提示。回填后重查可变 matched，不缓存错误的差异结论。

## 9. 接口、输出与展示

### 9.1 CLI

保留无参数和 `--json` 的原行为。新增接口：

```text
node token-rate.mjs --json --session <sessionId>
node token-rate.mjs --json --session <sessionId> --details
node token-rate.mjs --json --session <sessionId> --details workflow,reliability,timing,reconciliation
```

`--details` 无值请求全部四项；带值只能取表中的名字，空值/未知名字报结构化参数错误。显式 `--session` 优先于原 session 环境变量，缺省保持原识别链。诊断必须解析到有效 session，否则 unavailable，不自动汇总全库。

新增 `queryDetailed(sessionId, options)` 异步入口，复用基础查询的投影、数值规则和只读事务。原 `query()` 与 formatLine 继续服务快速路径，不因默认调用导入或扫描 dwf/turn_usage 全表。

基础成功时 details 返回原 JSON 加 `diagnostics`。基础失败沿用 `{error,db}` 与非零退出码。基础成功而可选模块失败时仍返回基础数据、模块 error/partial/unavailable 与 warnings，退出码 0；机器调用者必须读取模块 status，不能只看进程退出码。

### 9.2 新 JSON 契约

`diagnostics` 至少含：

| 字段 | 定义 |
|---|---|
| version | 新诊断结构版本，首版 1；与插件版本分别维护 |
| snapshotId / sampledAt / sampledAtText | 单次数据库快照标识及格式化时间；不是宿主 turn 身份 |
| rootSessionId / scope | 查询根会话、涉及的来源与状态、留存范围说明 |
| status | ok/partial/unavailable/error；按请求的模块聚合 |
| capabilities | 字段/关联能力及可用原因、契约标识；不记录对话 payload |
| accounting | observedUsage、互斥 buckets、歧义候选、quality；不可用为 null 并给状态原因 |
| workflow / reliability / timing / reconciliation | 各模块的 status、reasonCode、data、warnings；未请求为 not-requested |

reasonCode 至少区分 schema-missing、contract-unverified、association-ambiguous、no-session、no-data、invalid-data、timeout、query-error。明确范围内确认无行属于 no-data，可输出真实 0；contract-unverified/schema-missing 不可伪装 no-data。

未请求 details 时不做额外能力探测或模块查询；`diagnostics` 可省略。旧字段不因可选模块失败被清空。所有统计模块的 ID/token 归一规则共用一份实现。

workflow/reliability 请求共用 accounting 行集合，timing 可独立使用兼容范围，reconciliation 可独立使用主轮；不因只请求 timing 就强制扫描 workflow。总体 status 只汇总实际请求的模块：全部 ok 为 ok；全部 unavailable 为 unavailable；全部 error 为 error；其余组合为 partial，not-requested 不参与。模块有可用数据但覆盖不完整时自身为 partial。

### 9.3 /tps 与 doctor

`/tps` 升级为按需完整报表入口，命令执行 details 并只展示可用章节；先展示基础统计、采样时间和范围，再显示分账、可靠性、等待、对账与降级。默认自动行不受影响。

新增报表例子必须标明为文档示例，运行失败不能用示例数字替代真实值。总 token 不解释为金额；失败已记录量不解释为额外收费。

doctor 常规检查只做轻量 schema/配置/已有健康读取，不执行重报表或全库关联。`doctor --details` 可请求能力诊断；可选能力缺失为提示/warn，基础可读性错误才沿用 error 判定。保留健康记录 runId 防晚到覆盖规则：最后一条 Stop 为 locked 不等于持有者未通知，通知水位与单次健康是不同证据。

## 10. 条件特性：本问快照与收尾采样

本节可整体延后；**没有可靠本问归属时不得开放“本问”自动展示**。本节不是把最新历史 turn 改名的接口。

### 10.1 状态与归属

新增默认关闭配置 `wrapUpSample:false`。仅开启且能力经过验证时，为每 session 单独保存 prompt 状态：version、sessionId、promptKey、promptStartedAt、可靠时的 hostTurnId、关联依据。promptKey 是本地并发标识，只防状态混淆，不与数据库天然对应。

新状态路径由共享 runtime 统一生成，可由 `ZCODE_TPS_PROMPT_STATE` 覆盖基础路径；实际按 session 哈希落文件。它与 last-session 活动时间分离。SessionStart/Stop 不得改写 promptStartedAt；旧 prompt 采样不得覆盖新 prompt 状态。

支持的最小模式：同 session 只有一个已验证活动 prompt，宿主提供与 model_usage.turn_id 语义一致的身份，并能让工具调用显式携带 sessionId+promptKey。缺 turnId、状态丢失/损坏/过期/未来、session 不符、promptKey 过期或同 session 重叠请求时拒绝自动本问采样。未证明宿主传递身份的方法不得靠模型猜 ID 补齐。

建议状态最长有效期 24h，超过时返回 state-expired，不回退历史轮；该上限是产品保护值，长任务超过它允许跳过统计。可靠 hostTurnId 若需使用时间等其它证明替代，必须先修改 DATA-CONTRACT 与对应验收，不由实现者临时降级为 completed 时间比较。

### 10.2 读取接口与行为

开放后新增：

```text
node token-rate.mjs --json --current --session <sessionId> --prompt-key <promptKey>
```

`--current` 不与 `--details` 混用，缺必需参数报错。返回独立 current 结构：status=`partial/no-data/unknown/error`、reasonCode、sessionId/promptKey/hostTurnId、attributionBasis、samplePhase=`pre-summary`、completion=`unknown`、sampledAt、已落库 completed main_turn 的请求数/用量/速率及可展示 line。

partial 表示归属可靠但仅有已落库部分，不意味着最终完整；尚无属于该 turn 的 completed 行为 no-data；身份无法验证为 unknown；查询错误为 error。后三者 line=null，不返回旧轮补位。主轮选择和聚合同一 scope；请求历史截断不截断该 turn 的累计。

仅对原任务已经使用工具、即将进入最终总结的流程，允许一次额外只读采样；纯问答不为了统计增加工具。工具权限拒绝、超时、unknown/no-data/error 时正常完成任务，不循环重试、不自动重发用户请求、不从 Stop 驱动模型续跑。

开启且支持本能力时，prompt/SessionStart 注入一致展示规则，历史四段行不再要求与 current 行同时附上。开启但已知能力不支持时，回退 0.5.5 的历史展示并说明降级；真正采样失败时可以省略本问行。规则必须区分这些情况，不能让旧历史行被标成“本问”。

自动行示例：“本问已落库部分：端到端均 X tok/s · 主请求 N 次 · 输出 O tok · 采样 HH:mm:ss”。采样后生成的总结及其它未落库请求不在其中，不预估补账。模型遵守展示规则的效果必须实测，不能宣称 hook 能强制模型执行一次工具。

Stop 通知保持独立水位和原 snapshot 语义。开启两者时允许总结前和 Stop 后数字不同，不共享去重水位吞掉后者。

### 10.3 开放门槛

必须通过：前一轮迟到完成、旧请求重试晚到、auxiliary 更晚、未知 turn、并发 prompt、跨窗口同 session、清空/恢复会话、状态写入失败，以及权限拒绝下的正常结束。真实宿主至少验证新会话单轮长工具任务、普通多轮工具任务和纯问答；记录增加的调用数、采样耗时、额外 token、漏附与重复附情况。

不能验证宿主身份传递或展示行为时，0.6.0 中配置不得宣称有效；保持默认关闭并明确 unsupported，CLI 不返回伪造 current。实现可留到 0.6.x/下一版本，不阻断其他诊断交付。

## 11. 快照、预算、性能与降级

### 11.1 共用快照

details 的基础结果、关联、状态、timing、turn_usage 均来自同一连接的同一只读事务。禁止先 query 基础再另开连接读对账而宣称同快照。sampledAt 表示本次读取时间，覆盖范围与已观察完成时间另列。

建议拆出共享投影/会话范围/事务执行函数，由快速 query 和 detailed worker 复用。多条归属边先形成唯一 ID 集合再聚合；核心累计在 SQL 中完成，不将完整历史搬到 JS 逐行汇总。绑定数据参数、引用 SQL 标识符；新增强制索引沿用普通非部分索引检测和失败回退。

### 11.2 有界读取

手动 details 使用有界子进程，入口预算 5s，清理/退出预留不超过 500ms；慢同步 SQL 由父进程超时终止，不能仅靠 busy_timeout。已有 Stop 不启动 details worker，仍遵循原 7s 预算。

worker 在同一事务内完成基础查询后先通过 IPC 交付基础结果，再逐项交付完成的模块。超时后父进程可保留已收到的基础与完整模块，未完成模块记 timeout/partial；不输出半个累加桶。基础尚未完成则返回原错误结构及非零退出码。timeout 后等待子进程退出并关闭资源；不得留下轮询服务。

同快照指已交付数据来自该事务，不表示超时后仍是最新值。optional 表不存在/语义未知尽早降级，不额外消耗整段预算。JSON stdout 只有一个最终对象，日志及 worker 调试不得混入 stdout。

### 11.3 性能验收

- 快速 query 不新增诊断 SQL，现有 SELECT≤8 门禁继续适用于快速路径；新增模块不能通过放宽此门禁掩盖默认退化。
- 同机同 fixture 对实际发布 0.5.5 与候选版做 100k/1M、real/no-index、典型/最大/auto 对照。热查询预热后至少 7 次取中位；默认路径中位差超过 `max(基线×20%,30ms)` 时调查并给证据，未解释的持续回退不能放行。
- details 新建代表性 workflow/retry 分布 fixture，与快速路径分别报告。1M real 典型会话正常目标为 2s 内、最长受 5s 总预算约束；这是新目标，不是已测事实。无索引或超大 session 允许 partial/timeout，但不能伪造完整报表。
- 默认 hook 不加载事件 payload；不执行全库全行 `.all()`；内存增长与 returned groups 数量有界。记录峰值/增量而非凭估计宣称几 MB。

### 11.4 状态迁移边界

保留 0.5.5 的 claim.sqlite 文件身份，不在运行中自动删除。legacy 活 PID 复用的 P3 和状态文件累积作为已知限制，不恢复“年龄一到就抢活锁”。如未来提供清理/恢复命令，另立停止插件运行的契约与验收，不顺手并入本版本。

本地升级要求结束旧插件运行，再加载新版 hooks；重开单个会话不能证明其它旧会话已结束。不支持新旧 claim 协议同时运行。回滚期间同样先结束新版运行，保留旧字段/状态可读，新增诊断状态可被旧版忽略。

## 12. 测试与验收矩阵

新增测试必须验证独立输入/预期或可控交错，不以复制生产聚合函数充当 oracle。fixture 仅在临时目录创建，任何终止进程都只针对本测试自建 PID；真实用量库只读。可合并相关测试文件，但新增文件必须同时纳入 npm test 与 CI，不能只有某个 glob 工作流执行。

| 编号 | 用例 | 必须结果 |
|---|---|---|
| C01 | 0.5.5 配置/默认行/JSON 对照 | 旧字段范围和值不变，禁用行为不变 |
| C02 | input=1000/cacheRead=800/output=200/reasoning=100 | total=1200、缓存80%；不能变成2000或1300 |
| A01 | trace 与 dwf 双路径、多 event、嵌套 run | 稳定 usage ID 每行一次，bucket 之和守恒 |
| A02 | 普通 subagent 改分类 workflow | 新分类移动但同一相关行集合总量不变；旧 session 不扩大 |
| A03 | 两个 root 命中同 trace / workflow 关联冲突 | 不误归任一 root，返回明确歧义 |
| A04 | dwf 缺表/缺列/未验证键、unknown source | 基础正常，能力不可用或 unclassified，不补0 |
| R01 | error 已记录 input=20/output=5，success input=30/output=10 | 诊断已记录量65；兼容 completed 主用量40；错误量25不再次加 |
| R02 | error→success 两个有效 attempt 同 logical key | 逻辑请求1、观察尝试2、额外尝试1，token 两行各计一次 |
| R03 | retry_count 摘要、缺首尝试、重复/坏 index | 不简单求和，不推测丢失尝试，保留质量说明 |
| T01 | direct/derived/NULL/文本/负值/TTFT>dur | 来源与质量计数正确，非法显式值不偷偷回退 |
| T02 | 同模型不同 provider、零输出、有TTFT无Decode、样本不足 | 不混provider，不丢等待，零样本null，分母范围明确 |
| U01 | turn_usage 同快照匹配/差异/缺行/滞后回填 | 明确对账状态、差异方向、回填后重查，不定性损坏 |
| U02 | turn_usage 不可比scope/字段未知/缺表 | 不强行比较或相加，不改变主数据源 |
| B01 | 持续库锁、慢同步SQL、模块失败、worker 中断 | 预算内退出，基础可保留，模块原因明确，无残留子进程 |
| B02 | 高基数model/error、非法标识符、BOM配置、路径覆盖 | 输出有界且机器可解析，标识符安全，入口同路径规则 |
| S01 | legacy/新claim、回收交错、发布前强杀、owner变化 | 保留 0.5.5 E01–E03 专项全部通过 |
| W01 | current 无/坏/过期状态、错误session/promptKey、旧轮晚到 | 不返回旧轮为本问，line=null 与 reason 明确 |
| W02 | current 启停/通知组合/权限拒绝/纯问答 | 无统计驱动续跑，最多一次采样，不影响任务正常结束 |

W01/W02 在收尾采样实际开放时为强制；延后时须验证默认关闭/unsupported 不改原行为。各可选能力除有效 fixture 外，必须有 missing schema 与 contract-unverified 反例。

发布前跑完整 npm test、必要 benchmark、Windows/macOS/Linux × Node 22.13/24 的现有 CI 矩阵，以及真实宿主只读主链路/完整报表验收。平台通知适配器继续覆盖命令构造与退出结果；真实横幅可见性只对实际测试平台声明。任何跳过项须在发布说明列出，不把本机全绿写成六环境通过。

## 13. 开发分解与停点

| 阶段 | 产物 | 进入下一阶段的条件 |
|---|---|---|
| M0 基线与证据 | 实际0.5.5发布SHA、DATA-CONTRACT、脱敏fixture、未确认表 | 真实键/状态证据明确；未知项有降级决定，不阻塞独立模块 |
| M1 诊断骨架 | detailed worker、共用快照、能力状态、稳定ID集合、互斥账本 | 同快照与守恒测试通过，快速路径兼容 |
| M2 状态与等待 | reliability状态/已记录量、timing来源/分组；retry仅验证后开放 | NULL与非法字段不冒充0，逻辑/尝试区分清楚 |
| M3 可靠关联与对账 | workflow adapter、嵌套/歧义处理、turn_usage adapter | 证据门槛通过；否则模块明确unavailable并记录延期 |
| M4 条件收尾采样 | 独立prompt状态、current CLI、展示规则与真实宿主A/B | 身份传递和行为验收通过；否则不开放，不阻断诊断发布 |
| M5 发布候选 | README、命令、CHANGELOG、release notes、版本/CI/性能结果 | 无未解释的正确性反例、所有已开放能力验收通过 |

实现从 M0/M1 开始；不先 bump 版本再铺功能。基础正确性问题或新默认退化必须当轮解决；遇到宿主身份/数据语义无法证明时只停该能力，不为凑 0.6.0 清单改成弱推断。以上由脚本、fixture、CI 足够完成，不需要新增 agent 或常驻服务。

## 14. 发布与回滚

开发基于用户实际发布的 0.5.5 提交，新分支建议 `feat/0.6.0`；保留 0.5.3/0.5.4/0.5.5 历史，0.5.5 已发布内容保持不可变。

候选达到 M5 再统一修改 package.json、marketplace.json、plugin.json 及版本断言为 0.6.0。发布说明给出范围 before/after、默认兼容行为、能力矩阵与延期项，尤其注明 observedUsage 不是费用账单、TTFT 不是 HTTP TTFB、partial 不是最终完整。

先本地验收，再按授权发布；origin/tag 推送与本地 marketplace 覆盖分别核对，不把本地已更新当远端已发布。升级与回滚都结束旧插件运行，保留必要状态，不自动改工具权限或通知开关。旧版本不认识新配置应可忽略，基础 JSON 仍可被旧命令消费者理解。

## 15. 依据与完成定义

- [审核报告 §7.2–7.4](GPT审核报告-20260930.md)：workflow/error/retry/TTFT/turn_usage 的价值与账本边界。
- [审核报告 §10.2–10.7](GPT审核报告-20260930.md)：上游缺点、本问契约与可选收尾采样，不重新引用未经更新核验的“最新上游”结论。
- [审核报告 §14](GPT审核报告-20260930.md)：claim 生命周期修复与混跑边界。
- [数据源实测材料](schema漂移排查与GPT审核材料-20260930.md)：9/30 schema与表族现状，只作为证据阶段起点。
- `scripts/token-rate.mjs:35–43、162–205、422–518、532–535`：有效性规则、只读事务、旧输出范围、默认四段；`scripts/runtime.mjs:16–20、181–203`：基础/可选列与健康守卫；行号对应 b95e0d2 中插件路径。
- [性能基线](PERFORMANCE.md)：矩阵设计；0.6.0 对照必须重新使用实际发布0.5.5，不把历史0.5.3数字当新门禁的测量结果。

**完成定义：默认行为与旧账本兼容；新增已开放能力都有真实语义证据、明确范围、未知/失败状态和反例验收；没有证据的能力诚实延后；必要测试、性能与宿主检查通过后，0.6.0 才进入发布。**
