# zcode-tps

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
> ⚡ 最近 49 · 上轮均 60.9 · 会话均 58.4 tok/s · 首字 11.6s·ctx 599k · 上轮 读 599k(出 2.8k) · 会话 29.13M tok · 缓存 97.3% · ⏱ 17:12:14
```

三个速率对齐三个层级,全部采用**加权口径** Σ(输出+思考 token) ÷ Σ纯生成时长(短回复不会虚抬平均值):

- **最近** —— 最后一次模型请求的速率(请求级);
- **上轮均** —— 上一条回复全部有效请求的加权平均(轮次级);
- **会话均** —— 本会话全部有效请求的加权平均(会话级)。

数据来源:`~/.zcode/cli/db/db.sqlite`(`model_usage` / `turn_usage` 表,只读打开,WAL 模式不影响客户端)。
"纯生成时长"= `completed_at − first_token_at`,不含首字等待;TTFT 用库中 `time_to_first_token_ms` 精确值。

## 安装

方式一(推荐):在 ZCode 输入框依次执行

```
/plugin marketplace add KDB-Wind/zcode-tps
/plugin install zcode-tps@zcode-tps-marketplace
```

方式二:克隆本仓库后,Settings → Plugin Management → Discover → **+** → 添加仓库根目录(含 `marketplace.json`)→ 安装 `zcode-tps`。

安装后**重开会话**(钩子需新会话才注册)。

## 关闭/开启速率行

`~/.zcode/zcode-tps.config.json` → `{"tokenRateLine": false}`(改回 true 或删除文件即恢复;需重开会话)。

## 命令

- `/tps` — token 速率与用量报表(最近请求、上一轮、会话累计、缓存命中率)
- `/tps-doctor` — 自检(Node 版本、数据库、表结构、钩子状态)

## 依赖

Node ≥ 22.5(内置 `node:sqlite`)。跨平台。

## 口径说明

- 注入发生在你发送消息的瞬间,因此速率行显示的是**上一轮**数据(当前轮回复完成后的数字,下一条消息才能看到);
- 三个速率均为加权平均(Σtoken ÷ Σ时长),"最近"除外(单请求瞬时值);
- 缓存命中率 = 缓存读 ÷ 总输入;`cache_creation_input_tokens`(缓存写入)不计入命中;
- 会话 `input_tokens` 为该会话所有 main_turn 请求的输入(含缓存读);
- **子代理归因**:默认开启——与主会话共享 `trace_id` 的子代理(subagent)请求会并入会话级统计(实测约占输出 token 的两成);`~/.zcode/zcode-tps.config.json` → `{"includeSubagents": false}` 切回纯主对话口径(需重开会话);
- **口径边界**:`turn_usage` 无子代理归因,会话 tok 与缓存命中率恒为主对话口径(`usage.scope="main_turn"`);并入子代理时速率行标注 `tok(主)`/`%(主)`,`session.samples` 与 `会话均` 则含子代理有效请求;
- **会话识别**(`/tps` 未传 env 时):显式 `ZCODE_SESSION_ID` > `~/.zcode/zcode-tps.last-session.json`(新鲜或有数据时) > 最新 `main_turn` 会话 > 最新任意完成行——子代理行不再劫持自动识别;
- **健壮性**:只读连接带 2s `busy_timeout` + 忙时重试一次;CLI `--json` 失败时输出 `{"error","db"}` 对象而非堆栈;
- **自检分级**:`/tps-doctor` 分 error(❌,影响退出码)与 warn(⚠️,降级可用:缺 `trace_id`/`turn_id` 列、`turn_usage` 表);配置布尔兼容字符串写法(`"false"`/`"off"` 等同样生效)。
- 回归测试:`node test/degrade.test.mjs`(覆盖 turn_usage 缺失/结构变更的降级路径、子代理归因与指标口径)。
