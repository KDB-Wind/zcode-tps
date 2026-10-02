# DATA-CONTRACT 0.6.0 —— 宿主数据契约验证记录

日期:2026-10-02。状态:M0 证据基线,0.6.0 诊断能力开发的 schema/关联/语义依据。
宿主:ZCode 桌面端 3.14.4.7912(Windows),CLI 内核 `D:\software\ZCode\resources\glm\zcode.cjs`。
数据库:`~/.zcode/cli/db/db.sqlite`(SQLite 3.51.2,WAL,约 508 MB;采样期间宿主持续写入,行数为采样时点值)。
采样方式:`node tools/data-contract-sample.mjs`(只读连接 + 单只读事务;PRAGMA/SELECT;样本 ≤3 行、窗口 ≤20000 行;内容类列不取值;所有 ID 经确定性 sha256 短别名脱敏,同值同别名)。原始证据 JSON 不入库。

验证以"实际开发当日"数据为准;本文不把 2026-09-30 的无漂移结论当作未来保证。**列存在 ≠ 语义已验证**,每节末尾给出"已验证/未验证"边界。

## 1. 表清单与身份

库内 23 张表。与用量账相关:`model_usage`、`turn_usage`、`dwf_run/dwf_actor/dwf_node/dwf_event`、`workflow_run/workflow_definition/workflow_event/workflow_activity`(后四张**存在但 0 行**,未使用)。

### model_usage(采样时 22,605–22,650 行,持续增长)

主键 `id`(TEXT):`sqlite_autoindex_model_usage_1`,unique,origin=pk。全表 `COUNT(DISTINCT id) = COUNT(*)`,无 NULL、无重复。**usage 行身份 = `id`,可直接作为诊断账本的行去重键**(spec §4.2 门槛满足)。

全部列(spec §3.1 资料列名与实际一致,类型为声明类型):

```
id TEXT PK, logical_request_id, attempt_index, session_id, turn_id, trace_id, span_id,
assistant_message_id, parent_user_message_id, query_source, provider_id, model_id, variant,
agent, mode, task_type, status, started_at, first_token_at, completed_at, duration_ms,
time_to_first_token_ms, finish_reason, tool_call_count, input_tokens, output_tokens,
reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, provider_total_tokens,
computed_total_tokens, retry_count, retryable, cancelled_by_user, context_exceeded,
error_type, error_code, error_message*, raw_usage_json*, provider_metadata_json*
```

`*` 内容类列:**存在但本文与诊断实现均不读取其值**(spec §3.2 脱敏要求)。

非唯一索引:`model_usage_query_source_idx(query_source)`、`model_usage_trace_idx(trace_id)`、`model_usage_session_turn_idx(session_id, turn_id)`、`model_usage_started_model_idx(started_at, provider_id, model_id)`。无以 `session_id` 为首列的单列前缀问题(session_turn 索引满足 0.5.5 的 pickSessionIndex)。

新列(0.5.5 REQUIRED_COLS 之外)全部按"可选能力"处理,不得加入 REQUIRED_COLS:`logical_request_id/attempt_index/span_id/agent/mode/task_type/variant/finish_reason/tool_call_count/provider_total_tokens/computed_total_tokens/retry_count/retryable/cancelled_by_user/context_exceeded/error_type/error_code` 等。

### 其余相关表(行数为采样时点)

| 表 | 主键/唯一键 | 行数 | 说明 |
|---|---|---|---|
| turn_usage | **(session_id, turn_id) 复合 PK**(sqlite_autoindex,unique) | 1300–1301 | 每会话每轮一行;另有非唯一 `turn_usage_started_idx(started_at)` |
| dwf_run | id(TEXT) | 7 | workflow 运行 |
| dwf_actor | id(INTEGER);列 run_id, session_id | 36 | actor ↔ 会话映射 |
| dwf_node | id(INTEGER);列 run_id, site_id, ordinal, kind… | 162 | 无 usage 链接列 |
| dwf_event | id(INTEGER);列 run_id, sequence, type, payload_json* | 899 | payload 不读 |

## 2. 行聚合语义(token 包含关系,已验证)

全表 22,650 行(终采样时点):

- `computed_total_tokens = input_tokens + output_tokens`:**22,650/22,650 相等**,0 反例,无 NULL。
- `provider_total_tokens = input_tokens + output_tokens`:present 22,497(completed 行),**全部相等**;error/cancelled 行缺失(152 行 + 1)。present 与 `in+out+cache_creation` 相等是平凡重合(见下)。
- `cache_creation_input_tokens`:**全表恒 0**(22,650/22,650)。单列保留但当前宿主不写入;不能宣称"cache_creation 已验证有值语义"。
- `cache_read_input_tokens ⊆ input_tokens`:与 2026-09-30 实测一致(input 已含 cache_read);本轮 3 个 turn_usage 交叉样本同证(tu.cr ≤ tu.in)。
- **结论**:0.5.5 的 total=input+output 口径与宿主 computed_total_tokens 完全一致;不把 provider_total 或 cache_creation 加进总量。

## 3. status 枚举与落库时序(已验证)

全表观测枚举:**`completed` / `error` / `cancelled`**(22,498 / 114 / 38)。未观测到其他值;实现不得假设这是宿主全集枚举,未映射 raw status 必须保留分组计数(spec §6.1)。

各 status 行的 input/output/completed_at **全部非 NULL**(error 行 114/114、cancelled 行 38/38 也有 token 与完成时间):

| status | n | has_input | has_output | has_completed_at |
|---|---|---|---|---|
| completed | 22,498 | 全 | 全 | 全 |
| error | 114 | 全 | 全 | 全 |
| cancelled | 38 | 全 | 全 | 全 |

特征列(可重叠,**不是可加的状态桶**,spec §6.1):

- `cancelled_by_user`:1 ⇔ status='cancelled'(38 行);completed/error 全 0。观测内是 status 的充分特征,仍按独立特征列处理。
- `retryable`:1 共 216 行,**跨 status 分布**(216 个 error_type 非空的 completed 行与之一致,见 §5)。
- `context_exceeded`:全表恒 0(当前宿主不写入)。
- `error_type`:非空 368 行 = cancelled 38 + **completed 216** + error 114。**成功行也携带 error_type**(逻辑请求的重试历史记录在最终行,如 rate_limited 后重试成功)。取值(全表,允许脱敏统计):`rate_limited 245 / cancelled 39 / network_error 36 / unknown 26 / auth_failed 8 / invalid_request 7 / timeout 5 / server_error 2`。
- `error_code`:全表恒 NULL。error_message 不读值。

**落库语义**:三种 status 都落 token;未终止行(无 completed_at)在库中未观测到,但"未终止行的 token 可能回填"的标注仍保留(spec §6.1,防御宿主未来行为)。失败行计入诊断已记录用量一次;成功与失败来自同一行集合。

## 4. query_source 枚举与 workflow 行归属(已验证)

全表观测枚举:`main_turn 20146 / subagent 1394 / workflow_child 625 / target_completion_verification 300 / session_title 120 / goal_summary_title 39 / compact 26`(终采样时点)。**`workflow_child` 是新观测来源**,0.5.5 会把它归入 auxiliary(unknown 类)——0.6.0 分账把它移入 workflow 桶,不影响旧 session.total 范围(spec §4.2)。

### 4.1 会话拓扑(trace 与 session 的真实关系)

- **subagent 行也是独立会话**:`sess_subagent_agent_<uuid>`,其 trace 与父会话 main_turn 共享;`subagent 行与 main_turn 行同 session` = 0,`subagent 行所在 session 存在 main_turn` = 0。0.5.5 的 trace 归因是唯一链路,验证成立且没有更强的同 session 路径。
- **workflow_child 行是独立会话**:`sess_dwf-dwfrun-<runid>-actor_<site>_<ordinal>`,其 session 无任何 main_turn 行(rows_same_session_has_main=0);turn_id/trace_id 全部非空(625/625)。
- **trace 跨会话**:一个 trace 可覆盖 父会话(main_turn+辅助)+ 多个 sess_subagent_* + 多个 sess_dwf-…-actor_*(观测最大:10 个 session、1280 行、5 种 source)。
- **同一 trace 的 main_turn 落在 ≥2 个 session 的情形:0 例**(multiMainRootTraces=0)。即"当前观测内 trace 唯一对应一个 root",但这是观测事实不是约束;实现必须保留多 root 歧义检测(spec §4.2/A03)。

### 4.2 workflow 归属链(spec §5 证据门槛)

**权威路径(actor 链)**:`dwf_run.id → dwf_actor.run_id → dwf_actor.session_id = model_usage.session_id(query_source='workflow_child')`
验证:36/36 workflow 会话被 dwf_actor.session_id 覆盖;625/625 workflow_child 行可经 actor 链归属到 run(56+469+53+47=625)。

**交叉路径(trace 链)**:`dwf_run.parent_session_id → 该 session 的 main_turn trace 集合 → 共享 trace 的 workflow_child 行`
验证:有 actor 的 run,trace 链与 actor 链行数一致(56/469/53/47)。

**歧义实例(必须按 spec §4.2 处理)**:7 个 run 中 3 个共享同一 parent_session_id(1,117 行 main_turn 的会话),其中两个(actors=0,spent_tokens=0,一个 status=failed)没有 actor 映射,但 trace 链会把同 56 行也"命中"。**归属规则:只用 actor 链计数;trace 链只作交叉验证;多 run 命中同批行时,未获 actor 归属的 run 计 0 行并标注**。`dwf_run.resumed_from` 列存在,疑似 run 重试/续跑机制(语义未验证)。

- `dwf_run.spent_tokens`:run 级宿主上报总量(3.7M/28.2M 等)。**语义未验证,不与 model_usage 相加**,仅作 reported 摘要。
- dwf_node/dwf_event/dwf_actor 无任何指向 model_usage 行的链接列(candidateUsageLinks 仅 dwf_actor.resolved_model,是模型名非行 ID);"run→node→usage"路径**不存在**,节点细分不开放(可选能力,不要求)。

### 4.3 workflow 分账分类规则(0.6.0 实现)

对 root session S:
1. `main` = S 的 main_turn 行;
2. `workflow` = actor 链归属到「parent_session_id = S」的 run 的 workflow_child 行(run 集合来自 dwf_run.parent_session_id = S,行集合来自 dwf_actor.session_id);
3. `subagent` = trace ∈ S 的 main_turn trace 集合且 query_source='subagent'(0.5.5 同口径);
4. `auxiliary` = S 的其他来源(不变);
5. trace 双命中(workflow 与 subagent 路径)不增加总量:先按行 id 求并集再分类。workflow_child 与 subagent 由 query_source 区分,观测无同 ID 跨类冲突。
6. `unclassified`/`ambiguousCandidates`:trace 命中 ≥2 个 root 的 main_turn、或 actor 链缺失时 trace 弱命中的行——计数并列冲突原因,不计入总量。

## 5. retry / logical_request_id(已验证:尝试不留行)

- `logical_request_id`:全表 22,650 行 **22,650 个不同值**(0 NULL)。同 lrid 多行:0 组。跨 session/跨 provider 同 lrid:0 例。
- `attempt_index`:**全表恒 0**。尝试(失败重试)**不作为独立行留存**。
- `retry_count`:宿主 reported 值,0–10;>0 共 222 行,主要落在 completed 行(成功最终行记录此前重试次数);与 `error_type` 非空(216 completed 行)互证。
- `turn_usage.model_retry_count` 同为 per-turn reported 摘要(样本全 0,与主会话轮的 model_usage retry_count 和一致)。

**结论**(spec §6.2 门槛):"逻辑请求 → 多尝试行"的分组语义**在留存数据中不存在**——`groupedAttemptRows = 行数`、`retriedLogicalRequestsObserved = 0(观察)`、`additionalAttemptsObserved = 0(观察)`,这些是**留存范围事实**而非重试次数真相;重试信息唯一来源是宿主 reported `retry_count`(单列摘要,不与观察尝试数相加)。不能从 retry_count 推断"丢失的尝试"的 token;失败尝试的用量只可能体现在 turn_usage 差额里(见 §6),不作推断。

## 6. TTFT(已验证)

- `time_to_first_token_ms` 显式列:窗口 20,000 行中 explicit_present 12,564,**explicit_invalid 0**(无文本/负数/Inf)。
- `fallback_eligible = 0`:**first_token_at/started_at 可算差值时,显式列必非空**;显式列 NULL 的行,first_token_at 或 started_at 也为 NULL(回退路径在真实数据中不会产出额外样本)。
- both_present 12,564 行抽样:显式值与 `first_token_at − started_at` **全部精确相等**(6/6 样本)。
- 0.5.5 的投影规则(显式优先、NULL 回退、非法不回退)保留不变,命名保持 TTFT/首字等待,不称 HTTP TTFB(spec §7)。

## 7. turn_usage(已验证键与字段;数值可比性有边界)

- 键:**(session_id, turn_id) 复合主键**,每会话每轮一行(1301 行 = 1301 键,per_key 恒 1)。粒度即"会话 × 轮",无 model/source 细分行。
- session 覆盖:other(主会话)1166 + subagent 会话 97 + dwf 会话 37(采样时点)。**每类会话各自有自己的 turn_usage 行**;主会话轮的 turn_usage 不含 subagent/workflow 用量(它们在各自会话的键下)。
- 字段:status、started_at/first_model_start_at/first_token_at/completed_at/duration_ms/time_to_first_token_ms、model_request_count、model_retry_count、tool_call_count/tool_error_count、input/output/reasoning/cache_creation/cache_read/computed_total_tokens、retryable/cancelled_by_user/context_exceeded、error_type/error_code、trace_id、user_message_id。
  - status 枚举:completed 1172 / error 84 / cancelled 44 —— **轮级状态**(15/16 请求 completed 的轮可为 error)。
  - computed_total_tokens = input+output(3/3 样本)。
- **与 model_usage 的对账关系**(同库快照对照):
  - 主会话轮(3 样本,含 1 个 error 轮):input/output 与「该 (session,turn) 的 model_usage 行聚合」**精确相等**;`model_request_count` = 该键下全部 usage 行数(含非 completed)。
  - **workflow actor 轮(4 样本):turn_usage 大于 model_usage 行总和**(input +22,901/+51,585/+36,222…,output 同向)。与 §5 互证:turn_usage 计入未留存的尝试用量。**两表不可假设相等;差异如实报 delta,不定性为损坏**(spec §8/U01)。
  - 键覆盖:1290/1301 键在 model_usage 有同键行;**11 个孤儿键**(该 (session,turn) 无任何 usage 行)。反向:model_usage 的 main_turn 键是否都有 turn_usage 行未全查(以 U01 测试 fixture 为准,不宣称)。
- 回填时序:`turn_usage.completed_at ≥ 该轮最晚 model_usage.completed_at` 1249 例;**`<` 41 例**(usage 行晚于 turn 行落库)——两表异步写入双向存在,同快照对账必须容忍双向滞后。
- `user_message_id`:非空 1276,**1276/1276 命中 message.id** —— prompt 消息 ↔ turn 的绑定锚点已验证(供未来"本问"归属使用)。

**对账实现边界**(spec §8):只对同键、整数 token 字段(input/output/reasoning/cache_read/cache_creation)精确比较;duration/time 字段单位与容差未写入本契约(§9 冻结前不比较);workflow actor 轮的已知系统性差额写入 reasonCode 说明,matched 只证明该快照一致。

## 8. 当前 prompt / hook 输入(spec §3.2 第 8 行)

- **运行时已验证**:宿主通过环境变量 `ZCODE_SESSION_ID` 向 hook 传 sessionId(prompt-submit/stop 均如此,0.5.5 依赖此);Stop stdin JSON 含 `session_id`。hook 输入中**未运行时观测到 turnId**。
- **宿主内核源码验证(3.14.4,读 `zcode.cjs`)**:hook 事件对象对 UserPromptSubmit/Stop 均含 `hookEventName, mode, prompt|responseText, sessionId, timestamp, traceId, turnId`,且 stdin 载荷为 `{...event, agent_type, hook_event_name, permission_mode, session_id}` 展开 —— **turnId/traceId(camelCase)预期已在 stdin JSON 中**,只是 0.5.5 未读取、未运行时证实。
- turn_id 生成格式 `` `turn_${crypto.randomUUID()}` `` 与库内 `turn_<uuid>` 一致(格式级证据)。
- **降级决定**:wrapUpSample(本问快照/收尾采样)0.6.0 **保持默认关闭、状态 unsupported**(spec §10.3):turnId 字段的运行时传递、与 model_usage.turn_id 的等值性、"模型执行一次采样工具"的展示行为,均需真实宿主验收后才可开放。内核源码证据使 0.6.1 的开放门槛从"宿主能力未知"降为"需运行时确认 + 展示 A/B",记入延期项而非永久排除。

## 9. 降级决定汇总(spec §13 M0 停点)

| 未确认项 | 决定 | 依据 |
|---|---|---|
| usage 行身份 | **开放**:`id` 主键去重 | §1,全表唯一 |
| workflow 归属 | **开放**:actor 链为权威,trace 交叉,多 run/多 root 歧义检测 | §4.2/4.3 |
| run→node→usage | **不可用**:无链接列;节点细分不实现 | §4.2 |
| dwf_run.spent_tokens | reported 摘要单列,不相加 | §4.2 |
| retry 尝试分组 | **仅 reported**:观察尝试恒 1 行/组;lrid 不用于去重 | §5 |
| error_type/code | 脱敏类别统计开放;error_message 不读;error_code 恒 NULL 时为空组 | §3 |
| turn_usage 对账 | **开放**:整数 token 同键精确比较;workflow 轮已知差额;时长不比较 | §7 |
| 本问快照(wrapUpSample) | **延后**:默认关闭/unsupported;源码证据已记录 | §8 |
| cache_creation | 列保留、恒 0;单列展示,不入总量 | §2 |
| context_exceeded | 特征列恒 0;保留读取 | §3 |

## 10. 复现

```bash
node tools/data-contract-sample.mjs --out <证据.json> [--window 20000] [--sample 3]
```

只读执行;不写宿主库;输出 JSON 含全部计数与脱敏样本。本文数字取自 2026-10-02 采样(多次采样间宿主持续写入,行数自然增长;结论均为全表或窗口聚合,不受个位数漂移影响)。
