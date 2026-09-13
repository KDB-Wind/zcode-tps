# 更新记录

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
