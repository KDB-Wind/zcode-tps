# zcode-tps

ZCode 插件：从本地 SQLite 用量库读取 token 速率与用量，在回复末尾显示统计行，无额外模型调用。

```text
> ⚡ 最近轮均 43.1 tok/s · Decode 会话均 62.4 tok/s · 会话 29.13M tok · 缓存 97.3%
```

当前版本 **0.5.3**，统计与显示规则不变；本轮重写性能基准为多场景矩阵，并修复百万行级大库下查询线性劣化（生产同款索引下典型会话中位 3.6s → 0.17s）与锁路径回归。详见 [更新记录](CHANGELOG.md)。

## 安装

在 ZCode 输入框依次执行：

```text
/plugin marketplace add KDB-Wind/zcode-tps
/plugin install zcode-tps@zcode-tps-marketplace
```

安装或更新后重开会话。需要 Node **22.13+（22 系列）或 24+**；23 系列需 23.4+。

- `/tps`：完整报表。
- `/tps-doctor`：依赖、配置、数据库与最近 hook 采集结果自检。
- `~/.zcode/zcode-tps.config.json` 写入 `{"tokenRateLine": false}` 可关闭自动行，下一次 hook 即生效。
- `{"rateLineFields": "all"}` 展示全部字段；如 `["rates", "turn", "time"]` 可自定义字段和顺序。

## 数据含义

速率 = provider 总输出 token ÷ 单次请求端到端时长。最近轮均、会话均是 `Σ输出 ÷ Σ请求时长`，包含请求内等待，不含请求之间的工具执行时间；并发请求时长相加，因此不是整轮墙钟吞吐。

总 token = 输入 + 输出，reasoning 已包含在输出中。会话累计仅覆盖数据库留存的已完成请求，不是全历史账本；缓存命中率 = 缓存读 ÷ 输入。

自动行采样发生在发送消息时，通常对应上一轮；`/tps` 则在脚本执行时采样，可能包含当前轮的已完成请求。仅凭请求完成状态无法断定整轮结束，所以显示“最近轮均”。轮次 ID 缺失时不推测轮次。

数据库只读访问，数字由模型引用展示；模型可能漏附行。默认将同 trace 的子代理并入会话速率与 `session` 累计，简洁行的会话 token/缓存仍是主对话口径，存在子代理时标注 `(主)`。

详细配置、JSON 字段与降级行为见 [插件说明](plugins/zcode-tps/README.md)。

## 开发

```sh
npm test
```

零第三方运行依赖。测试使用临时数据库与隔离配置；CI 配置覆盖 Windows/Linux 和 Node 22.13/24。

`npm run benchmark` 用带真实分布(缓存命中、token 长度、来源配比)的合成库跑多场景矩阵:小/中/大库(默认 5k/100k/1M 行)× 索引场景 × 冷/热查询 × 内存,可传位置参数只跑一档(如 `npm run benchmark -- 1000000`);结果及限制见 [性能记录](docs/PERFORMANCE.md)。

## 致谢

基于 [shy3130/zcode-tps-monitor](https://github.com/shy3130/zcode-tps-monitor) 0.7.0（MIT）修改，保留轻量 token 统计，移除业务 TPS/MCP/大屏组件。
