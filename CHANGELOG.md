# 更新记录

## 0.5.5

基于 0.5.4 完整审核（`docs/GPT审核报告-20260930.md`）的可信度补丁：只修缺陷，不改默认采样行为与默认四段行。修复项 F01–F10 对应报告第 5 节。

### 修复（查询正确性）

- **部分索引误选致查询整体失败（F01，P1）**：`INDEXED BY` 只选普通（非部分）索引——部分索引带 `WHERE` 条件，无法覆盖辅助查询的排除条件，命中即 `no query solution`；另加一次性回退（强制索引不可用时取消强制并附 warning），索引名改用正确的 SQL 标识符引用（含双引号转义）。
- **TTFT 缺类型与物理范围校验（F07，P2）**：Decode 谓词现要求 TTFT 为非负有限数值且不超过请求时长——负数/文本 TTFT 不再虚构解码窗口（此前 `TTFT='bad'` 会被 SQLite 算术当作 0 混入 Decode，`TTFT=-1000` 会得到大于请求总时长的解码窗口）；端到端样本不受 TTFT 坏值影响（两者范围本就不同）。TTFT 回退推导（`first_token_at − started_at`）同样要求两值为数值，JS 与 SQL 共用同一投影表达式，样本集合一致。
- **坏 token 字段污染速率样本（F10，P2）**：`output_tokens` 等字段为文本/负数时，SQL 比较 `文本 > 0` 恒真，坏行曾混入会话/轮次速率并拉低均速；现 SQL 与 JS 统一"非负有限数值"守卫，坏行不计速率但保留请求计数，用量按 0 计并计入 `warnings`（`N 条请求的 token 字段非合法数值`），`cache_read_input_tokens > input_tokens` 的语义异常行同样告警可见，不以 0 冒充准确账本。
- **超出 Date 可表示范围的完成时间拖垮整份报表（F08，P2）**：`completed_at = 8.64e15+1` 一类有限但非法的时间戳曾令 `Intl` 格式化抛 `RangeError`、报表整体降级；现格式化守卫返回 null 并附"完成时间非法"告警，其余指标照常。
- **空白 turn_id 虚构轮次（F09，P2）**：`turn_id` 为纯空白文本（空格/制表符/全角空格）现与 NULL 同样判为"轮次未知"（共用 `validIdSql` 规则）；合法但带前后空格的 ID 保留原值，不 trim 合并。

### 修复（Stop 通知与诊断）

- **健康记录按 会话+hook 分文件（F02，P1）**：默认关闭的 Stop 不再把 prompt 链路的 `error` 覆盖成 `disabled/ok`；doctor 分"注入链路采集(UserPromptSubmit)"与"通知链路(Stop)"两项展示，通知链路四态区分：采集成功（含提交结果 submitted/suppressed/unknown）/ 通知关闭 / 未观察到（不以无证据判定宿主不支持）/ 提交失败。
- **Stop 异常路径记录终态（F03，P1）**：缺库、持续锁、配置损坏等可捕获失败现在留下 `error` 终态与原因（此前 `running/error=null` 残留，doctor 只能误报"中断/超时"）；`startHealth` 先于一切可能失败的步骤。
- **macOS 通知错误转义（F04，P1）**：改为固定 AppleScript `on run` handler + argv 传参，文本不再进入脚本源码（此前 `JSON.stringify` 全量转义破坏 AppleScript 字符串边界，含引号/反斜杠的文本必然弹错）；命令构造抽出为可单测的 `buildNotifyCommand`。
- **未提交通知就记成功（F05，P1）**：先提交通知并等待有界的拉起确认（≤250ms），确认成功才落水位；提交失败记 `notify-failed` 且水位不前进，下次 Stop 自然重试。状态只承诺"命令已提交"，横幅可见性仍由系统权限决定；测试抑制模式如实标注 `notifyStatus: "suppressed"`。
- **单槽水位去重不足（F06，P2）**：去重水位改为按会话多槽（上限 32 槽，按时间淘汰），并对"实际展示范围的稳定指纹"（请求数/输入/输出/Decode 样本/用量与最近轮，排除 sampledAt）比对——A→B→A 会话切换不再重复通知，同会话子代理迟到并入产生的内容变化能再次通知；旧单槽文件自动迁移（至多多通知一次）。诊断/测试可设 `ZCODE_TPS_NOTIFY_BIN` 覆盖通知命令。
- **Stop stdin 限时/限长**：宿主异常保持 stdin 开启时，1.5s 超时 + 64KB 上限后按无输入处理，不再挂满 hook 8s 预算；关闭态读配置后尽早退出。

### 文档与展示口径

- Stop 时采样的值统一表述为"库内已落库的 completed 快照，通常恰为刚结束这轮，不含 Stop 之后才提交的用量"，不再写"恰为刚结束这轮的完整数据"（宿主最终用量提交与 Stop 的先后未验证）。
- CHANGELOG 清理重复的 0.5.3 标题。

### 测试

- 新增 `test/quality.test.mjs`：F01（无索引/普通索引/仅部分索引/普通+高评分部分索引并存/特殊字符索引名）、F07（负数/文本/0/等于/大于时长 TTFT）、F08（超范围日期）、F09（空白与带空格 turn_id）、F10（文本/负 token、cacheRead>input）、F02/F03（子进程级链路隔离与终态）、F04（三平台命令构造）、F05（提交失败不落水位 + doctor 可诊断 + 恢复后重试）、F06（子代理指纹变化、A→B→A、旧格式迁移）、stdin 限时长/限长度。
- 既有用例随水位文件格式（多槽）与健康记录分文件更新断言；发布一致性断言升至 0.5.5。

## 0.5.4

### 改进

- 新增回合结束系统通知（`turnEndLine`，默认关闭，`true`/`"notify"`/`"toast"` 开启）：Stop hook 在回合结束时弹系统通知显示统计（Windows toast / macOS 通知中心 / Linux notify-send，零依赖，detached 弹出不阻塞回合结束）。修复单轮会话的显示空窗——此前自动行由发消息时的 UserPromptSubmit 采样，天然滞后一轮，只发一条消息执行长任务时回复末尾没有任何统计。通知负责即时性，UserPromptSubmit 注入行照常工作、负责对话流内的历史记录，两渠道互补；数据未前进（水位 `coverage.lastCompletedAt`，`zcode-tps.last-shown.json`）时不重复通知；任何失败静默放行。ZCode 的 Stop hook 若驱动模型续跑会把回合折叠为摘要条（回答主体被藏起），故本功能不采用续跑补行方案、只走系统通知（2026-09-19 源码确证：`systemMessage` 不 block 时被忽略、纯 `additionalContext` 只写消息历史，会话流内即时显示没有免续跑通道）。
- 速率行新增可选 `last` 段：最近有效请求的单次端到端速度（`latest.tokPerSec`），供与 ⚡ 轮均交叉验证单次波动。请求级波动大，不入默认名单；无有效请求（速率为 null）时同其他可选段一样静默跳过。`rateLineFields: "all"` 由此展开为八段（`rates/last/decode/ttft/turn/session/cache/time`）。
- CI 矩阵新增 macOS（`macos-latest` × Node 22.13/24）：插件为跨平台纯 Node（`node:sqlite` + `homedir` 路径），此前仅 Windows/Linux 有 CI 实测；根 README 平台说明同步。
- 测试新增 Stop hook 通知用例（默认关/开启通知/水位去重/水位前进/字符串与布尔等价/主开关优先/损坏水位降级）、`resolveTurnEndMode` 两态解析与注入行照常的回归。

## 0.5.3

### 修复

- 大库(百万行级)下查询随库容量线性劣化:单次统计最多 13 条语句各自重复扫描 `model_usage`,叠加持续锁等待可突破 hook 的 8 秒宿主超时。现合并为 ≤4 条语句(单遍条件聚合 + 材化 CTE + 优先级排序会话识别),并对带会话等值的语句自适应固定 `session_id` 首列索引(只读 `PRAGMA` 探测,兼容 ZCode 3.11.2+ 自带索引)。生产同款索引的 100 万行合成库:典型会话中位 3.6s → 0.17s,最大会话 3.1s → 0.33s,auto 识别 5.5s → 0.8s。
- 连接优化 pragma(mmap/页缓存)原在打开连接时执行,库被独占锁时会额外付出完整 busy 等待周期,锁场景实测 6.5s → 12.8s(超 hook 预算);现移至 schema 首次成功读取之后,持锁路径恢复 ~6.3s。
- ZCode 升级若把 `query_source` 写成 NULL/空白,相关请求会从主统计与 auxiliary 同时静默消失;现归一为 `(缺失)` 组单列于 auxiliary 并附专用告警(与 0.5.2 "来源变化必须可见" 的设计对齐)。
- `model_usage` 表整个不存在(空库文件/非用量库,如 tasks-index.sqlite)时错误文案误导为"缺少列";现明确区分"表不存在"与"缺少列"。
- doctor 的"最近完成样本"遇 TEXT 等异常时间戳显示 "NaN 分钟前";现守卫类型,未来时间戳标注"时钟偏差或脏数据"。

### 改进

- 基准重写为多场景矩阵:小/中/大库(默认 5k/100k/1M 行)× 索引场景(无/旧实验索引/生产真实索引镜像)× 查询模式(典型会话/最大会话/auto 识别)× 冷(子进程首查)/热(7 次中位)× 内存增量,含真实分布(缓存命中、token 长度、来源配比)的确定性合成器与 session 口径 oracle 断言;优化前后对比见 `docs/PERFORMANCE.md`。
- 新增正确性矩阵:三类库形状(cli-db/tasks-index/opencode)× 七种异常共 21 格的回归测试与结果归档 `docs/correctness-matrix-20260915.md`;新增"单次查询 SELECT 语句数 ≤ 8"门禁。
- 依赖:保持零第三方运行依赖,无依赖升级。

## 0.5.2

### 修复

- 会话级 Decode(主对话与子代理)与请求级、分布统计统一最小解码窗口 200ms:`decodeSamples` 与 `decodeStats.samples` 现在同一有效性定义下计数,1–199ms 的极短窗口不再进入会话 Decode。
- `decodeStats` 分位数改为 nearest-rank 定义(`index = ceil(p×n)−1`):小样本不再偏低,3 个样本的 p90 为最大值;README 与报表说明同步。
- 修复无 main_turn 会话回退全部来源的边界缺陷:辅助请求(compact/标题/验证)曾被同时计入主统计与 `auxiliary`,并产出虚假的最近轮均/Decode 会话均。主统计现严格限定 `main_turn`,会话没有主请求时 `usage`/`turn`/`latest` 为 null、速率为 null,辅助用量仍经 `auxiliary` 单列(`session_all` scope 值随之移除);新增 auxiliary-only 会话回归测试。
- 根 README 的版本与示例、插件 README 标题、manifest 描述、hook 注释与 0.5.x 实际行为漂移,全部修正;新增发布一致性测试(README 版本/示例、hook 注释与 `DEFAULT_RATE_FIELDS` 对应)。

### 改进

- 速率行 Decode 段改名为 `Decode 会话均`,明示其为整个留存会话的加权值,不与"最近轮均"的时间范围混淆。
- "与官方 Decode 直接对比"的表述统一弱化为:近似纯生成口径,可用于同环境趋势观察;不同服务、模型、请求长度与官方测速结果不保证等价。
- 新增 `auxiliary`(JSON/CLI/`/tps` 报表):本会话非 `main_turn`/`subagent` 的已完成辅助请求按来源分组(标题类/系统类/未分类),不计入主统计;未识别来源进入 `warnings`,以发现 ZCode 升级带来的来源变化(适配 ZCode 3.11.2 的 `session_title`、`goal_summary_title`、`compact`、`target_completion_verification`)。
- 评估文档入库:`docs/ZCODE-3.11.2-COMPATIBILITY-AND-REPAIR-PLAN.md`。

## 0.5.1

### 改进

- JSON 新增 `decodeStats`（基础范围口径，不含子代理）：请求级 Decode 的均值/中位/p90 与样本数，解码窗口 ≥200ms，分位数在 SQL 内取有序值，紧凑速率行不变；`/tps` 报表据此展示请求级分布。

## 0.5.0

### 改进

- 速率行精简为四个数,降低认知负荷:`⚡ 最近轮均 X tok/s · Decode Y tok/s · 会话 N tok · 缓存 Z%`。
- 端到端速度只显示最近轮均(反映当前服务状态);单请求级波动大、会话均会被拥堵期历史拖偏(长会话逐渐失真),两者移出紧凑行,仍见 JSON(`latest.tokPerSec`/`session.avgTps`)、CLI 明细与 `/tps` 报表。无轮次数据时按 会话均→最近请求 降级并相应改标签。
- 解释最近轮均与会话均的差距:会话均是含全部历史的加权平均,跨天/跨拥堵时段的会话必然低于当前轮均;两者口径本就不同,不再并排展示。

## 0.4.5

### 改进

- 速率行 Decode 段只显示会话加权值（`Decode 62 tok/s`），不再显示最近请求级：单请求波动大，参考意义有限。请求级速度保留在 JSON `latest/history[].decodeTps`、CLI 明细输出与 `/tps` 报表中。

## 0.4.4

### 改进

- 新增 Decode 速度(默认显示段):纯生成阶段速率 = 输出 ÷(请求时长 − 首 token 等待),与智谱官方"高峰期平均 Decode 速度"同口径,可直接对比;排队/预填充不计入分母,解释了端到端速率低于官方数值的原因。
- TTFT 缺失时回退 `first_token_at - started_at` 参与解码窗口计算;两者皆缺的请求不参与 Decode 统计(仍计入端到端口径与用量)。
- 请求级解码窗口下限 200ms,避免几乎全部时长用于等待首字的请求产生失真速率;会话加权 Decode 与 e2e 会话均使用同一有效样本集,includeSubagents 开启时并入子代理。
- `rateLineFields` 默认四段 `[rates, decode, session, cache]`,`"all"` 展开七段;JSON 新增 `latest/history[].decodeTps`、`session.decodeTps`、`session.decodeSamples`。

## 0.4.3

### 改进

- 时间显示默认改为 Asia/Shanghai（此前为 UTC 的 `toISOString()` 或依赖系统时区的短时间）；可在配置 `timezone` 设为 `"UTC"`、`"system"` 或任意 IANA 时区名，环境变量 `ZCODE_TPS_TIMEZONE` 优先，无效值回退默认并在 `warnings` 提示。
- JSON 新增 `timezone`、`utcOffset` 与预格式化 `*Text` 时间字段（`sampledAtText`、`coverage`/`latest`/`turn`/`history` 的 `completedAtText`）；`/tps` 报表直接引用，不再由模型把毫秒时间戳换算成 UTC。
- 速率行 `time` 段含日期（会话跨零点时纯 `HH:mm:ss` 有歧义）；注入采样提示与 doctor 的最后成功时间同样按配置时区显示。

## 0.4.2

### 修复

- 轮次/会话总 token 改为输入 + 输出，reasoning 仅作为输出明细。
- 自检和查询共享 schema 定义；缺轮次、缓存写入、trace 列时明确降级，不再自检正常但整行消失。
- NULL/空 turn_id 不再合并成虚构轮次；未知轮次不推测总轮数。
- 过期或未来时间的状态文件不再锁定自动识别；不再用 turn_usage 判断状态是否有效。
- 最近有效请求独立于 history 长度；最近轮次不因零输出回退旧轮次。
- 统一标注最近观察轮次、采样时间和数据库留存范围，避免声称整轮已结束或报表固定在消息发送时。
- 对齐 doctor 测试与不依赖 turn_usage 的现行行为。
- Node 无实验启动参数的最低版本更正为 22.13（23 系列为 23.4）。
- 自动会话识别排除 NULL/空白标识；无法识别时返回会话未知和空统计，不再扩大为跨会话汇总。
- 子代理归因排除 NULL/空白 trace，包括制表符和 Unicode 空白，避免无关子代理误并入。
- hook 查询前记录 running、执行 ID、PID 和开始时间；doctor 对未完成/中断/超时采集显示警告。
- 配置读取兼容 UTF-8 BOM；模块导入不再移除进程的 warning 监听器，运行时警告保留在 stderr。

### 改进

- 每份报表使用单个 SQLite 只读事务；仅聚合最近轮次，不再把全部轮次加载到 JavaScript。
- 去掉嵌套锁重试，保留整个查询的单次重试。
- 新增 JSON scope、coverage、sampledAt、warnings 和未知轮次元数据；session 增加同范围总量与缓存命中率。
- 共用配置读取与校验；非法 JSON、非对象配置、非法 history/时长参数明确报告。
- hook 记录最近采集成功时间、状态、耗时和降级信息；doctor 支持状态路径覆盖。
- 健康记录按会话哈希文件名隔离，并保留最近启动采集的全局摘要；doctor 明确展示会话和执行 ID，不使用其他会话的成功记录替代当前会话。
- 新增 `npm run benchmark`：在临时合成数据库测量有/无索引查询及持续独占锁等待，不访问真实用量库。
- 关闭自动行时 SessionStart 也不再注入附行指令；缺 SQLite 能力时 CLI/hook 仍输出可解析 JSON。
- 命令说明支持原生 PowerShell，优先使用当前插件根目录或显式脚本路径。
- 增加统一 npm test 与 Windows/Linux、Node 22.13/24 CI 配置。

### 兼容性说明

- 简洁行“上轮均”更名为“最近轮均”；通常仍对应上一轮，但不保证整轮已结束。
- `turn` 和 `usage.turns` 在无法识别时返回 null；缓存写入列缺失时 `cacheCreation=null`。
- 主对话 usage 与含子代理 session 的既有划分保留，并明确标注实际范围。
- 数据库仍只读；没有引入全历史持久账本、增量缓存或宿主原生状态栏。
