# zcode-tps 0.4.2

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

默认显示三个字段：

```text
> ⚡ 最近 81.4 · 最近轮均 79.6 · 会话均 80.7 tok/s · 会话 29.13M tok · 缓存 97.3%
```

配置文件：`~/.zcode/zcode-tps.config.json`。配置在每次 hook 或命令执行时读取，不需要为配置变化重启。

```json
{
  "tokenRateLine": true,
  "includeSubagents": true,
  "rateLineFields": ["rates", "ttft", "turn", "session", "cache", "time"]
}
```

| 字段 | 内容 |
|---|---|
| `rates` | 最近有效请求、最近可识别轮次、会话的速率 |
| `ttft` | 最近有效请求的 TTFT 与输入上下文规模 |
| `turn` | 最近可识别轮次的输入、输出 |
| `session` | `usage.total`，库内留存范围内累计 |
| `cache` | `usage` 范围内的缓存命中率 |
| `time` | 最近有效请求完成时间；查询采样时间另见 `sampledAt` |

`rateLineFields` 缺省为 `["rates", "session", "cache"]`；`"all"` 展开全部六段。未知字段忽略，空名单或所选字段均无数据时回落默认显示。布尔选项兼容 `"false"`、`"off"` 等字符串。

关闭自动行后，SessionStart 和 UserPromptSubmit 不再注入显示指令。后续未提供新行时，指令要求模型不要沿用旧数字；实际展示仍取决于模型执行。

配置缺失采用默认值；支持 UTF-8 BOM。损坏 JSON、非对象配置及非法数值环境变量会明确报错。hook 保持严格 JSON 空注入，同时记录错误供 doctor 检查。运行时 warning 保留在 stderr，模块不会修改其他代码的 warning 监听器；stdout 仍可作为 JSON 解析。

## 统计口径

- `durMs = duration_ms ?? (completed_at - started_at)`，速率为 `output_tokens / (durMs / 1000)`。
- 有效样本：请求 `status=completed`、输出大于 0、时长在 `[500ms, 1h)`。无 first-token 但时长有效的请求仍可统计速率，TTFT 可为空。
- 最近轮均、会话均为 `Σoutput / Σduration`。请求内等待计入；请求间工具执行和编排间隙不计入。并发子代理的请求时长相加，不代表整轮墙钟吞吐。
- 总量始终为输入 + 输出；reasoning 是输出明细，不再相加。零输出或时长无效的 completed 请求仍计入用量和请求数。
- 缓存命中率 = 缓存读 / 输入；输入已含缓存读，缓存创建不计命中。
- 不使用 `turn_usage` 计算指标。ZCode 清理旧 `model_usage` 行后累计可能下降，不能当全历史消耗或费用账本。

## JSON 与时间边界

`node scripts/token-rate.mjs --json` 返回：

| 字段 | 契约 |
|---|---|
| `sampledAt` | 本次 SQLite 读快照建立后的时间，毫秒时间戳 |
| `coverage` | `retainedOnly=true`、completed 请求、基础统计范围及其最早/最晚完成时间 |
| `warnings` | 缺可选列、未知轮次和子代理归因降级原因 |
| `history` | 基础统计范围内最近请求，倒序，默认最多 60 条 |
| `latest` | 同一范围内最近有效请求，独立于 history 长度；全部无效时回退最新请求，速率为空 |
| `turn` | 最新已完成请求所属的可识别轮次；`completion="unknown"`，不能证明整轮完成 |
| `usage` | 基础范围的输入/输出/总量/缓存/轮次数；reasoning 是其中量 |
| `session` | 基础范围加可归因子代理的累计与加权速率；`total=input+output`，有独立 `cacheHit` 和 `scope` |

基础范围优先为当前会话 `main_turn`，没有 main_turn 时回退当前会话全部请求来源，`usage.scope="session_all"`，不再错误标成主对话。`session.scope` 对应 `main_turn`、`main_turn+subagent` 或 `session_all`。无法识别有效会话时返回空统计、`sessionId=null`、`session.scope="unknown"` 和警告，不会汇总全库。

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

在仓库根目录运行 `npm test`，也可单独执行 `node test/degrade.test.mjs`、`node test/doctor.test.mjs`、`node test/release.test.mjs`。测试使用隔离配置和临时 SQLite，包含并发 WAL 写入时快照一致性、CLI 与 hook JSON 契约。

`npm run benchmark` 默认构建 10 万条合成请求，测量无索引、有测试索引两种情况下的查询中位值/95 分位值，以及持续独占锁的失败耗时。可用 `npm run benchmark -- 1000000` 增大数据量。基准只创建临时数据库，不修改真实用量库或其索引。样本不含 Node 启动和 hook 文件 IO，不能代替宿主实测。

基于 [shy3130/zcode-tps-monitor](https://github.com/shy3130/zcode-tps-monitor) 0.7.0（MIT）修改。
