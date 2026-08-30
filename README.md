# zcode-tps

ZCode 插件:每轮回复末尾自动显示一行**真实** token 速率与用量数据,无需重启、零额外模型调用。

```
> ⚡ 最近 49 · 上轮均 60.9 · 会话均 58.4 tok/s · 首字 11.6s · 上轮 602k tok(出 2.8k) · 会话 29.13M tok · 缓存 97.3% · ⏱ 17:12:14
```

| 指标 | 含义 |
|---|---|
| **最近** | 最后一次模型请求的生成速率(请求级) |
| **上轮均** | 上一条回复全部有效请求的加权平均(轮次级) |
| **会话均** | 本会话全部有效请求的加权平均(会话级) |
| **首字** | TTFT(库中 `time_to_first_token_ms` 精确值) |
| **上轮 / 会话 tok** | 轮次 / 会话的总 token 消耗(输入+输出) |
| **缓存** | 缓存命中率 = 缓存读 ÷ 总输入 |

## 安装

在 ZCode 输入框依次执行:

```
/plugin marketplace add KDB-Wind/zcode-tps
/plugin install zcode-tps@zcode-tps-marketplace
```

安装后**重开会话**即可。命令:`/tps` 完整报表,`/tps-doctor` 自检;`~/.zcode/zcode-tps.config.json` 写 `{"tokenRateLine": false}` 可关闭自动行。

详细说明见 [plugins/zcode-tps/README.md](plugins/zcode-tps/README.md)。

## 原理

数据取自 ZCode CLI 自带的 SQLite 用量库(`~/.zcode/cli/db/db.sqlite`,只读),`UserPromptSubmit` 钩子在你发送消息的瞬间计算上一轮的真实数据并注入上下文,由模型以引用块附在回复末尾——**非模型自述、非估算**,且不产生任何额外模型调用。

## 致谢

基于 [shy3130/zcode-tps-monitor](https://github.com/shy3130/zcode-tps-monitor) 0.7.0 (MIT) 修改:增加轮次/会话 token 消耗与缓存命中率、三级加权速率口径,重写 `/tps` 为 token 用量报表,精简掉业务 TPS/MCP/大屏组件。
