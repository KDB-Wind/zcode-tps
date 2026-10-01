# zcode-tps 0.5.5

从 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 只读计算速率、用量和缓存命中率。无需额外模型调用；自动行由模型根据 hook 上下文引用展示。

## 安装与使用

```text
/plugin marketplace add KDB-Wind/zcode-tps
/plugin install zcode-tps@zcode-tps-marketplace
```

也可在 Settings → Plugin Management → Discover 中添加仓库根目录，再安装插件。安装或更新后重开会话。

依赖 Node 22.13+（22 系列）、23.4+（23 系列）或 24+。22.5 虽引入 `node:sqlite`，但直到 22.13 才无需实验启动参数，见 [Node 官方文档](https://nodejs.org/download/release/v24.14.0/docs/api/sqlite.html)。

命令：`/tps` 完整报表，`/tps-doctor` 自检。Windows 可以直接用 PowerShell，不要求 Git Bash。

## 自动显示与配置

默认显示四个字段：

```text
> ⚡ 最近轮均 43.1 tok/s · Decode 会话均 62.4 tok/s · 会话 29.13M tok · 缓存 97.3%

四个数各答一个问题:最近轮均=现在的端到端体感速度;Decode 会话均=整个留存会话的纯生成加权平均;会话=留存范围累计 token;缓存=命中率。请求级与会话级端到端速度不在紧凑行中,见 `/tps` 报表与 JSON。
```

配置文件：`~/.zcode/zcode-tps.config.json`。配置在每次 hook 或命令执行时读取，不需要为配置变化重启。

```json
{
  "tokenRateLine": true,
  "turnEndLine": false,
  "includeSubagents": true,
  "rateLineFields": ["rates", "ttft", "turn", "session", "cache", "time"],
  "timezone": "Asia/Shanghai"
}
```

| 字段 | 内容 |
|---|---|
| `rates` | 最近一轮的端到端速度(无轮次数据时降级为 会话均→最近请求,标签跟随来源) |
| `last` | `最近请求`:最近一次有效请求的单次端到端速度(`latest.tokPerSec`),供与 `rates` 轮均交叉验证单次波动;波动大不入默认名单 |
| `decode` | `Decode 会话均`:整个留存会话的纯生成加权速度(剔除首字等待);请求级分布见 JSON `decodeStats` 与 `/tps` 报表 |
| `ttft` | 最近有效请求的 TTFT 与输入上下文规模 |
| `turn` | 最近可识别轮次的输入、输出 |
| `session` | `usage.total`，库内留存范围内累计 |
| `cache` | `usage` 范围内的缓存命中率 |
| `time` | 最近有效请求完成时间（按 `timezone` 显示日期+时间）；查询采样时间另见 `sampledAt` |

`rateLineFields` 缺省为 `["rates", "decode", "session", "cache"]`；`"all"` 展开全部八段。未知字段忽略，空名单或所选字段均无数据时回落默认显示。布尔选项兼容 `"false"`、`"off"` 等字符串。

**已知限制**：注入行在发消息时采样，只能覆盖到上一轮——如果会话只有一轮对话（常见于新会话直接开启目标任务、执行很长才结束），第一轮回复末尾不会有任何统计，从第二轮对话起正常显示。`turnEndLine` 的系统通知是这一场景的补救选项，但弹窗有打扰感，默认不开启；Windows 下横幅顶部的来源名显示为 PowerShell 的应用标识（AUMID），无法自定义，通知内容本身不受影响。

`turnEndLine`（默认 `false`）开启回合结束的系统通知（Stop hook）。开启后，回合结束时立即弹系统通知显示统计（Windows toast / macOS 通知中心 / Linux notify-send，零依赖），单轮会话即时可见；通知完全不动会话流，不产生任何额外模型调用，回答主体不受影响（不采用"驱动模型续跑补行"方案——ZCode 会把续跑回合折叠为摘要条，回答被藏起）。通知负责即时性，UserPromptSubmit 注入行照常工作、负责对话流内的历史记录，两渠道互补。Windows 下首条通知会自动写入注册表开启 PowerShell 通知的横幅权限（新机器默认可能为关，静默 toast 会被丢弃），之后尊重用户在系统设置里的开关。通知在 Stop 时对库内已落库的 completed 快照采样——通常恰为刚结束这轮，但不含 Stop 之后才提交的用量，不宣称"本轮最终完整用量"。整个 Stop 在 7s 全程预算内运行（宿主 8s）：关闭态短限时退出，查询放有界子进程、超预算终止并记 error 终态，绝不阻塞回合结束。去重按**会话独立水位文件** + 展示内容指纹：同一会话展示的统计无变化（含切走再切回）不重复通知；指纹覆盖实际展示所需的原始聚合（速率分子/时长分母、缓存分子、轮次与最新请求、字段选择），总量不变但速率或缓存被回填变化也会再次通知。同会话的"比较→发送→写水位"以原子占用锁（`…claim` 文件，带 pid/过期回收）串行化：并发触发时只有占用者发送——相同内容不重复发送，旧采样晚完成不倒写新水位（占用后重验，拿到锁的旧结果让位），拿不到锁不等待直接让位并在健康记录标注原因；通知失败会释放锁供下次重试。通知先提交并确认**退出码**：退出码 0 记"命令执行完成"；非零退出/被信号终止/命令缺失记 `notify-failed` 且不前进水位，下次回合结束自动重试；限时内未退出记 `unknown` 按已提交处理（避免对可能已展示的通知重复弹窗）。"执行完成"不保证用户看到横幅，可见性由通知权限与用户设置决定；`tokenRateLine: false` 时本选项一并停用。取值：`true`/`"notify"`/`"toast"` 开启，`false`/`"off"` 关闭。

`timezone` 控制所有时间显示（速率行 `time` 段、采样提示、`/tps` 报表、doctor），默认 `Asia/Shanghai`；可设 `"UTC"`、`"system"`（跟随系统时区）或任意 IANA 时区名（如 `America/New_York`）。无效值回退默认并在 `warnings` 提示。环境变量 `ZCODE_TPS_TIMEZONE` 优先于配置文件。数据库中的时间戳无时区语义，只是显示层的选择。

关闭自动行后，SessionStart 和 UserPromptSubmit 不再注入显示指令。后续未提供新行时，指令要求模型不要沿用旧数字；实际展示仍取决于模型执行。

配置缺失采用默认值；支持 UTF-8 BOM。损坏 JSON、非对象配置及非法数值环境变量会明确报错。hook 保持严格 JSON 空注入，同时记录错误供 doctor 检查。运行时 warning 保留在 stderr，模块不会修改其他代码的 warning 监听器；stdout 仍可作为 JSON 解析。

## 统计口径

- `durMs = duration_ms ?? (completed_at - started_at)`，速率为 `output_tokens / (durMs / 1000)`。
- 数值有效性契约（0.5.5）：token 与时长字段须为非负有限数值（SQL 与 JS 同一规则）。文本、负数、NULL、非有限值的行不计速率样本；用量按 0 计并保留请求计数，同时在 `warnings` 暴露"N 条请求的 token 字段非合法数值"，不静默补零冒充准确账本。`cache_read_input_tokens > input_tokens` 的语义异常行同样告警。
- 有效样本：请求 `status=completed`、输出为合法数值且大于 0、时长在 `[500ms, 1h)`。无 first-token 但时长有效的请求仍可统计速率，TTFT 可为空。完成时间超出 Date 可表示范围的行保留用量，时间显示为空并附告警。
- 最近轮均、会话均为 `Σoutput / Σduration`。请求内等待计入；请求间工具执行和编排间隙不计入。并发子代理的请求时长相加，不代表整轮墙钟吞吐。
- 总量始终为输入 + 输出；reasoning 是输出明细，不再相加。零输出或时长无效的 completed 请求仍计入用量和请求数。
- 缓存命中率 = 缓存读 / 输入；输入已含缓存读，缓存创建不计命中。
- Decode 速度 = `output / (durMs − TTFT)`，只计纯生成阶段，排队与预填充不计入分母，因此高于端到端速率。口径近似智谱官方"高峰期平均 Decode 速度"（同为纯生成思路），但计时边界、请求构成与平均方法不同，可用于同环境趋势观察，不保证与官方数字等价。TTFT 取 `time_to_first_token_ms`，缺失时回退 `first_token_at − started_at`（两者皆为数值才有效）；TTFT 须满足 `0 ≤ TTFT ≤ durMs`，负数、文本或超过请求时长的值不参与 Decode（端到端样本不受影响，两者范围不同）。两者皆缺的请求不参与 Decode（仍计入端到端与用量）。解码窗口 ≥200ms 的要求对请求级、分布与会话级（含子代理）统一生效；会话 Decode 为同批有效样本的 `Σoutput / Σ(durMs − TTFT)` 加权值。
- turn_id 为 NULL 或纯空白文本时一律判"轮次未知"（共用有效 ID 规则）；合法但带前后空格的 ID 按原值区分，不 trim 合并。
- 不使用 `turn_usage` 计算指标。ZCode 清理旧 `model_usage` 行后累计可能下降，不能当全历史消耗或费用账本。

## JSON 与时间边界

`node scripts/token-rate.mjs --json` 返回：

| 字段 | 契约 |
|---|---|
| `sampledAt` | 本次 SQLite 读快照建立后的时间，毫秒时间戳 |
| `timezone` / `utcOffset` | 时间显示时区（默认 Asia/Shanghai）及其 UTC 偏移，如 `UTC+8` |
| `*Text` 字段 | `sampledAtText`、`coverage`/`latest`/`turn`/`history` 行内的 `completedAtText` 等，按 `timezone` 预格式化的 `YYYY-MM-DD HH:mm:ss`；报表应直接引用而非自行换算 |
| `coverage` | `retainedOnly=true`、completed 请求、基础统计范围及其最早/最晚完成时间 |
| `warnings` | 缺可选列、未知轮次和子代理归因降级原因 |
| `history` | 基础统计范围内最近请求，倒序，默认最多 60 条 |
| `latest` | 同一范围内最近有效请求，独立于 history 长度；全部无效时回退最新请求，速率为空；含 `decodeTps` |
| `turn` | 最新已完成请求所属的可识别轮次；`completion="unknown"`，不能证明整轮完成 |
| `usage` | 基础范围的输入/输出/总量/缓存/轮次数；reasoning 是其中量 |
| `session` | 基础范围加可归因子代理的累计与加权速率；`total=input+output`，有独立 `cacheHit` 和 `scope`；`decodeTps`/`decodeSamples` 为会话加权 Decode 及其有效样本数（默认含可归因子代理，与不含子代理的 `decodeStats.samples` 统计范围不同，但有效性门槛相同）；`e2eOutputTokens`/`e2eDurationMs`/`decodeOutputTokens`/`decodeDurationMs` 为对应速率的原始分子与时长分母（未经四舍五入，0.5.5 起供展示指纹比对） |
| `decodeStats` | 请求级 Decode 分布（基础范围，不含子代理）：`mean`/`median`/`p90`（tok/s）与 `samples`；解码窗口 ≥200ms，分位为 nearest-rank（`index = ceil(p×n)−1`） |
| `auxiliary` | 本会话非 `main_turn`/`subagent` 的已完成辅助请求（标题/压缩/验证等），按来源分组并标注 `class`（title/system/unknown）；不计入主统计；未识别来源进入 `warnings` |

基础范围严格为当前会话 `main_turn`（`usage.scope="main_turn"`），不再于无 main_turn 时回退全部来源。`session.scope` 对应 `main_turn`、`main_turn+subagent` 或 `unknown`。会话没有主请求时主统计为空（`usage`/`turn`/`latest` 为 null、速率为 null），辅助用量仍经 `auxiliary` 单列。无法识别有效会话时返回空统计、`sessionId=null`、`session.scope="unknown"` 和警告，不会汇总全库。

默认将共享主对话 `trace_id` 的 subagent completed 请求并入 `session`；`includeSubagents=false` 可关闭。`session.subagent` 提供子代理累计和均速；没有有效速率样本时累计仍保留。`usage` 不额外并入子代理，简洁行在并入子代理时标注 `tok(主)`、`%(主)`。`coverage` 的时间范围对应基础范围，不包括其他会话的归因子代理。

NULL 或仅含空白的 trace 不参与归因。有效 trace 按原值匹配，不会通过去掉前后空格将不同标识合并。

NULL/空轮次 ID 不能证明轮次归属：最新请求缺 ID 时 `turn=null`；存在任意缺 ID 的请求时 `usage.turns=null`，并提供 `knownTurns`、`unknownTurnRequests`。已知轮次数也只是留存范围内观察到的轮次，不代表已完成轮数。最近轮次不会因零输出而偷偷回退旧轮次。

自动行在 UserPromptSubmit 时采样，通常是上一轮的数据；`/tps` 在命令执行时采样，可能包含当前轮已完成请求。同一报表使用单个只读事务保持一致。CLI 出错时 `--json` 返回 `{"error","db"}`，退出码为 1。

## 会话、诊断与环境变量

会话识别顺序：显式 `ZCODE_SESSION_ID`（兼容 `CLAUDE_SESSION_ID`）→ 两小时内状态文件 → 最新 main_turn 会话 → 最新任意 completed 请求会话。所有自动来源均排除 NULL/空白 ID；显式无效 ID 报错。过期或未来时间状态文件不参与识别。多个会话同时工作时应传显式 ID；全局状态文件不保证判断出调用者所在窗口。

| 环境变量 | 作用 |
|---|---|
| `ZCODE_USAGE_DB` | 覆盖数据库路径 |
| `ZCODE_SESSION_ID` | 明确指定当前会话 |
| `ZCODE_TPS_LAST_SESSION` | 覆盖会话状态文件；hook、CLI、doctor 共用 |
| `ZCODE_TPS_CONFIG` | 覆盖配置文件路径 |
| `ZCODE_TPS_HEALTH` | 覆盖健康记录基础路径；默认是状态文件路径加 `.health.json`，实际文件按 会话+hook 追加 `.SHA256(sessionId).prompt.json` / `.stop.json` |
| `TOKEN_RATE_HIST` | history 条数，1–1000 的整数，默认 60 |
| `TOKEN_RATE_MIN_MS` | 有限正数，默认 500 |
| `TOKEN_RATE_MAX_MS` | 有限正数，默认 3600000；必须大于 MIN |
| `ZCODE_TPS_NOTIFY_SUPPRESS` | 置 `1` 跳过真实系统通知（测试/CI 用；健康记录如实标注 `suppressed`） |
| `ZCODE_TPS_NOTIFY_BIN` | 覆盖通知命令（诊断/测试用，如指向缺失路径验证提交失败路径） |
| `ZCODE_TPS_NOTIFY_CONFIRM_MS` | 通知命令退出结果的确认限时，200–3000ms，默认 2000（超时记 `unknown` 按已提交处理） |
| `ZCODE_TPS_LAST_SHOWN` | 覆盖去重水位基础路径；实际文件按会话追加 `.SHA256(sessionId).json`，曾通知标记为 `…last-shown.json.once` |

只读连接设置 2 秒 busy timeout，整个查询遇锁错误重试一次，取消轮次查询的嵌套重试。SQLite 锁等待与查询 CPU 时间不是同一个预算；UserPromptSubmit 的 8 秒宿主超时仍是最终限制。Stop hook 额外按 7s 全程预算统筹（stdin 等待、查询、通知确认与终态写入共享同一条 deadline），查询放在有界子进程中执行，超预算直接终止——库被持续锁定时 Stop 以带原因的 error 终态退出，不会越过宿主超时。

doctor 与查询共享必需/可选列定义。缺 `trace_id` 时无法归因；缺 `turn_id` 时轮次未知；缺 `cache_creation_input_tokens` 时缓存写入为 null，其余累计仍可用。以上为 warn；核心列缺失为 error。`turn_usage` 缺失不影响指标。

状态文件存在只说明曾写入，不能证明采集成功或当前 hook 已注册。hook 在查询数据库前记录 `running`、`runId`、PID、hook 类型和开始时间，完成后再更新为 `ok`、`disabled`、`notify-failed` 或 `error`；任何可捕获失败（缺库、持续锁、配置损坏、通知命令不可用）都有带原因的终态，只有宿主强制终止才会残留 `running`。每次运行启动时清空上一轮的 `notified`/`notifyStatus`/错误等易变字段，新运行不被上一轮通知结果解释；`lastSuccessAt` 作为历史字段保留（doctor 的"最后成功"）。Stop 的健康记录另分段记录 `stdinMs`/`queryMs`/`totalMs`，全程耗时含输入等待与前置启动。尚未完成的记录总是警告；进程已退出或运行超过 8 秒时提示疑似中断/超时，不沿用上一次成功状态。

健康记录按 会话哈希 + hook 类型 分文件保存（0.5.5）：Stop 通道的关闭态/失败不会覆盖 prompt 通道的诊断，反之亦然；同一会话两个 hook 交错完成互不合并。doctor 分"注入链路采集(UserPromptSubmit)"与"通知链路(Stop)"两项展示，通知链路按本次运行状态渲染：采集成功（附通知命令结果 ok/suppressed/unknown；同会话并发让位时附让位原因——locked=另一回合结束处理中/concurrent=相同内容已被并发通知/stale=已有更新的并发通知）、通知关闭、未观察到（可能回合未结束、插件刚更新未重开会话或宿主未触发 Stop——以记录为准，不预设）、采集失败（error，附原因与重试提示）、提交失败（notify-failed，下次回合结束自动重试）、采集中/中断（running）。error/running 不再出现"采集成功"或上一轮通知结果的表述。doctor 优先选择显式会话 ID，其次新鲜状态文件中的会话；不使用其他会话的成功记录替代当前会话。无显式 ID 的 hook 会记录到无会话文件，并在成功查询后附 `resolvedSessionId`；在获得实际会话前不会猜测归属。

记录不包含对话正文。doctor 对缺失、过期、未完成和降级记录提示警告，error 才影响退出码。会话健康文件按每个会话一份保留；并行窗口隔离不等于同一会话并发执行的事务日志。

## 迁移与开发

0.4.0 已把速率从 `(output+reasoning)/(completed-first_token)` 改为 `output/duration`。0.4.2 进一步修正累计总量中的 reasoning 重复计数；若思考量非零，总量会下降，这是纠错。`history.legacyTps` 仅用于显式请求的 0.3 对比，不作为默认性能指标。

在仓库根目录运行 `npm test`，也可单独执行 `node test/degrade.test.mjs`、`node test/doctor.test.mjs`、`node test/release.test.mjs`、`node test/correctness.test.mjs`、`node test/quality.test.mjs`（0.5.5 修复回归：索引选择、字段类型校验、Stop 终态与通知退出码矩阵、按会话独立水位与展示指纹、全程预算墙钟门禁、并发 Stop、stdin 限时限长）。测试使用隔离配置和临时 SQLite，包含并发 WAL 写入时快照一致性、CLI 与 hook JSON 契约。

`npm run benchmark` 默认跑多场景矩阵:小/中/大库(5k/100k/1M 行,含真实分布的缓存命中与 token 长度)× 索引场景(无/旧实验索引/生产真实索引镜像)× 查询模式(典型/最大会话/auto 识别)× 冷/热,并记录内存与持续独占锁耗时;可传位置参数只跑一档,如 `npm run benchmark -- 1000000`。基准只创建临时数据库,不修改真实用量库或其索引。样本不含 Node 启动和 hook 文件 IO,不能代替宿主实测。

基于 [shy3130/zcode-tps-monitor](https://github.com/shy3130/zcode-tps-monitor) 0.7.0（MIT）修改。
