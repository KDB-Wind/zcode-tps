# zcode-tps

ZCode 插件:每轮回复末尾自动显示一行**真实** token 速率与用量数据,无需重启、零额外模型调用。

```
> ⚡ 最近 81.4 · 上轮均 79.6 · 会话均 80.7 tok/s · 会话 29.13M tok · 缓存 97.3%
```

默认显示速率组、会话累计、缓存三段;`~/.zcode/zcode-tps.config.json` 写 `{"rateLineFields": "all"}` 可恢复全部六段,或用字段名单自定义(如 `["rates", "turn", "time"]`,顺序即显示顺序)。

| 指标 | 含义 | 默认显示 |
|---|---|---|
| **最近** | 最后一次有效模型请求的端到端速率(请求级) | ✅ |
| **上轮均** | 上一条回复全部有效模型请求的服务时长加权值 | ✅ |
| **会话均** | 本会话全部有效模型请求的服务时长加权值 | ✅ |
| **首字·ctx** | TTFT;ctx 为最后请求的上下文规模(首字延迟与它强相关) | `"all"` |
| **上轮 读(出)** | 上一轮读取的上下文(含缓存)与生成量 | `"all"` |
| **会话 tok** | 会话累计总消耗(读+出) | ✅ |
| **缓存** | 缓存命中率 = 缓存读 ÷ 总输入 | ✅ |

## 安装

在 ZCode 输入框依次执行:

```
/plugin marketplace add KDB-Wind/zcode-tps
/plugin install zcode-tps@zcode-tps-marketplace
```

安装后**重开会话**即可。命令:`/tps` 完整报表,`/tps-doctor` 自检;`~/.zcode/zcode-tps.config.json` 写 `{"tokenRateLine": false}` 可关闭自动行。

详细说明见 [plugins/zcode-tps/README.md](plugins/zcode-tps/README.md)。

## 原理

数据取自 ZCode CLI 自带的 SQLite 用量库(`~/.zcode/cli/db/db.sqlite`,只读),`UserPromptSubmit` 钩子在你发送消息的瞬间计算上一轮的真实数据并注入上下文,由模型以引用块附在回复末尾——**非模型自述、非估算**,且不产生任何额外模型调用。0.4.0 起速率为 provider 总输出 token(含 reasoning breakdown)÷单次模型请求端到端时长;“上轮均/会话均”是请求服务时长加权值,不包含请求之间的工具执行间隙,不是整轮墙钟吞吐。子代理(Agent 工具)的请求通过 `trace_id` 归因并入会话统计(可用配置关闭),详见 [plugins/zcode-tps/README.md](plugins/zcode-tps/README.md)。

## 致谢

基于 [shy3130/zcode-tps-monitor](https://github.com/shy3130/zcode-tps-monitor) 0.7.0 (MIT) 修改:增加轮次/会话 token 消耗与缓存命中率、三级请求端到端速率口径,重写 `/tps` 为 token 用量报表,精简掉业务 TPS/MCP/大屏组件。
