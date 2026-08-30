# zcode-tps-plus

ZCode 插件:每轮回复末尾自动显示**真实** token 速率与用量行,另有 `/tps` 报表与 `/tps-doctor` 自检。

基于 [shy3130/zcode-tps-monitor](https://github.com/shy3130/zcode-tps-monitor) 0.7.0 (MIT) 修改,增加:

- **上轮 token 总消耗**(输入+输出,来自 `turn_usage` 表——上游只按单次请求统计);
- **会话 token 总消耗**(所有轮次累计,输入+输出);
- **缓存命中率**(会话级与上轮级,= 缓存读 token ÷ 总输入 token;ZCode usage 库中 `input_tokens` 已包含 `cache_read_input_tokens`);
- `/tps` 命令重写为 token 用量报表(上游的 `/tps` 是业务接口 TPS 演示,与本插件无关);
- 移除上游的业务 TPS(metrics_url)、MCP 工具、浏览器大屏与 Windows 悬浮条,保持插件最小化。

## 显示效果

每条回复末尾一行引用块(数字为上一轮的真实数据):

```
> ⚡ 512.3 tok/s(上轮·均 480.2) · 首字 0.8s · 上轮 73.0k tok(出 8.7k) · 会话 1.05M tok · 缓存 94.5% · ⏱ 14:04:33
```

数据来源:`~/.zcode/cli/db/db.sqlite`(`model_usage` / `turn_usage` 表,只读打开,WAL 模式不影响客户端)。
tok/s = (输出+思考 token) ÷ 纯生成时长,不含首字等待;TTFT 用库中 `time_to_first_token_ms` 精确值。

## 安装

Settings → Plugin Management → Discover → **+** → 添加本目录(`zcode-plugins` 根,含 `marketplace.json`)→ 安装 `zcode-tps-plus` → **重开会话**(钩子需新会话才注册)。

## 关闭/开启速率行

`~/.zcode/tps-plus.config.json` → `{"tokenRateLine": false}`(改回 true 或删除文件即恢复;需重开会话)。

## 命令

- `/tps` — token 速率与用量报表(最近请求、上一轮、会话累计、缓存命中率)
- `/tps-doctor` — 自检(Node 版本、数据库、表结构、钩子状态)

## 依赖

Node ≥ 22.5(内置 `node:sqlite`)。跨平台。

## 口径说明

- 注入发生在你发送消息的瞬间,因此速率行显示的是**上一轮**数据(当前轮回复完成后的数字,下一条消息才能看到);
- 缓存命中率 = 缓存读 ÷ 总输入;`cache_creation_input_tokens`(缓存写入)不计入命中;
- 会话 `input_tokens` 为该会话所有 main_turn 请求的输入(含缓存读),不含子代理请求。
