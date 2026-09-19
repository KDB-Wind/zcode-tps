# zcode-tps 0.5.4

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

`turnEndLine`（默认 `false`）把显示时机从"下一次发消息时"改为"回合结束时"（Stop hook）。自动行由 UserPromptSubmit 采样，天然滞后一轮：只发一条消息让 agent 执行长任务的单轮会话，回复末尾不会有任何统计。三种取值：

- `true`（或 `"block"`）：回合结束时驱动模型在本轮回复末尾原样补上统计行，单轮会话立即出现在会话流里；代价是一次续跑模型调用，且 ZCode 会将该回合折叠为"已工作"摘要条（点开查看），此为 ZCode 对续跑回合的固定渲染。
- `"notify"`（或 `"toast"`）：改为弹系统通知（Windows toast / macOS 通知中心 / Linux notify-send）显示统计，完全不动会话流、零续跑调用；统计不在对话历史里。Windows 通知复用 PowerShell 的应用身份，无第三方依赖。
- `false`：关闭。

开启任一模式后 prompt-submit 不再注入显示行（其数据滞后一轮，会与回合结束显示重复），但会话识别状态照常写入。数据未前进（水位未更新）时不重复显示；block 模式防循环双保险（宿主 `stop_hook_active` 标记 + last-shown 水位 `pending` 标记，至多连续 block 一次，由 prompt-submit 兜底复位）；任何查询失败静默放行，绝不阻塞回合结束；`tokenRateLine: false` 时本选项一并停用。

`timezone` 控制所有时间显示（速率行 `time` 段、采样提示、`/tps` 报表、doctor），默认 `Asia/Shanghai`；可设 `"UTC"`、`"system"`（跟随系统时区）或任意 IANA 时区名（如 `America/New_York`）。无效值回退默认并在 `warnings` 提示。环境变量 `ZCODE_TPS_TIMEZONE` 优先于配置文件。数据库中的时间戳无时区语义，只是显示层的选择。

关闭自动行后，SessionStart 和 UserPromptSubmit 不再注入显示指令。后续未提供新行时，指令要求模型不要沿用旧数字；实际展示仍取决于模型执行。

配置缺失采用默认值；支持 UTF-8 BOM。损坏 JSON、非对象配置及非法数值环境变量会明确报错。hook 保持严格 JSON 空注入，同时记录错误供 doctor 检查。运行时 warning 保留在 stderr，模块不会修改其他代码的 warning 监听器；stdout 仍可作为 JSON 解析。

## 统计口径

- `durMs = duration_ms ?? (completed_at - started_at)`，速率为 `output_tokens / (durMs / 1000)`。
- 有效样本：请求 `status=completed`、输出大于 0、时长在 `[500ms, 1h)`。无 first-token 但时长有效的请求仍可统计速率，TTFT 可为空。
- 最近轮均、会话均为 `Σoutput / Σduration`。请求内等待计入；请求间工具执行和编排间隙不计入。并发子代理的请求时长相加，不代表整轮墙钟吞吐。
- 总量始终为输入 + 输出；reasoning 是输出明细，不再相加。零输出或时长无效的 completed 请求仍计入用量和请求数。
- 缓存命中率 = 缓存读 / 输入；输入已含缓存读，缓存创建不计命中。
- Decode 速度 = `output / (durMs − TTFT)`，只计纯生成阶段，排队与预填充不计入分母，因此高于端到端速率。口径近似智谱官方"高峰期平均 Decode 速度"（同为纯生成思路），但计时边界、请求构成与平均方法不同，可用于同环境趋势观察，不保证与官方数字等价。TTFT 取 `time_to_first_token_ms`，缺失时回退 `first_token_at − started_at`；两者皆缺的请求不参与 Decode（仍计入端到端与用量）。解码窗口 ≥200ms 的要求对请求级、分布与会话级（含子代理）统一生效；会话 Decode 为同批有效样本的 `Σoutput / Σ(durMs − TTFT)` 加权值。
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
| `session` | 基础范围加可归因子代理的累计与加权速率；`total=input+output`，有独立 `cacheHit` 和 `scope`；`decodeTps`/`decodeSamples` 为会话加权 Decode 及其有效样本数（默认含可归因子代理，与不含子代理的 `decodeStats.samples` 统计范围不同，但有效性门槛相同） |
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
| `ZCODE_TPS_HEALTH` | 覆盖健康记录基础路径；默认是状态文件路径加 `.health.json`，会话文件追加 `.SHA256(sessionId).json` |
| `TOKEN_RATE_HIST` | history 条数，1–1000 的整数，默认 60 |
| `TOKEN_RATE_MIN_MS` | 有限正数，默认 500 |
| `TOKEN_RATE_MAX_MS` | 有限正数，默认 3600000；必须大于 MIN |

只读连接设置 2 秒 busy timeout，整个查询遇锁错误重试一次，取消轮次查询的嵌套重试。SQLite 锁等待与查询 CPU 时间不是同一个预算；hook 的 8 秒宿主超时仍是最终限制。

doctor 与查询共享必需/可选列定义。缺 `trace_id` 时无法归因；缺 `turn_id` 时轮次未知；缺 `cache_creation_input_tokens` 时缓存写入为 null，其余累计仍可用。以上为 warn；核心列缺失为 error。`turn_usage` 缺失不影响指标。

状态文件存在只说明曾写入，不能证明采集成功或当前 hook 已注册。hook 在加载配置和查询数据库前记录 `running`、`runId`、PID 和开始时间，完成后再更新为 `ok`、`disabled` 或 `error`。尚未完成的记录总是警告；进程已退出或运行超过 8 秒时提示疑似中断/超时，不沿用上一次成功状态。

健康记录按会话哈希文件名保存，并保留全局最近启动采集的摘要。doctor 优先选择显式会话 ID，其次新鲜状态文件中的会话；不使用其他会话的成功记录替代当前会话。没有会话线索时可展示全局记录，并明确标注会话。最近成功时间仅从同一会话继承。无显式 ID 的 hook 会记录到全局文件，并在成功查询后附 `resolvedSessionId`；在获得实际会话前不会猜测归属。

记录不包含对话正文。doctor 对缺失、过期、未完成和降级记录提示警告，error 才影响退出码。会话健康文件按每个会话一份保留；并行窗口隔离不等于同一会话并发执行的事务日志。

## 迁移与开发

0.4.0 已把速率从 `(output+reasoning)/(completed-first_token)` 改为 `output/duration`。0.4.2 进一步修正累计总量中的 reasoning 重复计数；若思考量非零，总量会下降，这是纠错。`history.legacyTps` 仅用于显式请求的 0.3 对比，不作为默认性能指标。

在仓库根目录运行 `npm test`，也可单独执行 `node test/degrade.test.mjs`、`node test/doctor.test.mjs`、`node test/release.test.mjs`、`node test/correctness.test.mjs`（含三类库 × 七异常的正确性矩阵与查询语句数门禁）。测试使用隔离配置和临时 SQLite，包含并发 WAL 写入时快照一致性、CLI 与 hook JSON 契约。

`npm run benchmark` 默认跑多场景矩阵:小/中/大库(5k/100k/1M 行,含真实分布的缓存命中与 token 长度)× 索引场景(无/旧实验索引/生产真实索引镜像)× 查询模式(典型/最大会话/auto 识别)× 冷/热,并记录内存与持续独占锁耗时;可传位置参数只跑一档,如 `npm run benchmark -- 1000000`。基准只创建临时数据库,不修改真实用量库或其索引。样本不含 Node 启动和 hook 文件 IO,不能代替宿主实测。

基于 [shy3130/zcode-tps-monitor](https://github.com/shy3130/zcode-tps-monitor) 0.7.0（MIT）修改。
