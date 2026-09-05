# zcode-tps

ZCode 插件:每轮回复末尾自动显示**真实** token 速率与用量行,另有 `/tps` 报表与 `/tps-doctor` 自检。

基于 [shy3130/zcode-tps-monitor](https://github.com/shy3130/zcode-tps-monitor) 0.7.0 (MIT) 修改,增加:

- **上轮 token 总消耗**(输入+输出,来自 `turn_usage` 表——上游只按单次请求统计);
- **会话 token 总消耗**(所有轮次累计,输入+输出);
- **缓存命中率**(会话级与上轮级,= 缓存读 token ÷ 总输入 token;ZCode usage 库中 `input_tokens` 已包含 `cache_read_input_tokens`);
- `/tps` 命令重写为 token 用量报表(上游的 `/tps` 是业务接口 TPS 演示,与本插件无关);
- 移除上游的业务 TPS(metrics_url)、MCP 工具、浏览器大屏与 Windows 悬浮条,保持插件最小化。

## 显示效果

每条回复末尾一行引用块(数字为上一轮的真实数据),默认只显示最关键的三段:

```
> ⚡ 最近 81.4 · 上轮均 79.6 · 会话均 80.7 tok/s · 会话 29.13M tok · 缓存 97.3%
```

自定义显示字段(`~/.zcode/zcode-tps.config.json`,顺序即显示顺序,`"all"`=全部六段):

```
{"rateLineFields": ["rates", "ttft", "turn", "session", "cache", "time"]}
// 如 {"rateLineFields": "all"} 恢复完整行:
// > ⚡ 最近 81.4 · … · 会话均 80.7 tok/s · 首字 11.6s·ctx 599k · 上轮 读 599k(出 2.8k) · 会话 29.13M tok · 缓存 97.3% · ⏱ 17:12:14
```

字段:`rates` 速率组 / `ttft` 首字延迟+上下文 / `turn` 上轮读写 / `session` 会话累计 / `cache` 缓存命中率 / `time` 时间。未知字段忽略,空名单回落默认。

三个速率对齐三个层级。headline 统一采用 **provider 总输出 token ÷ 单次模型请求端到端时长**;其中 `output_tokens` 已包含 `reasoning_tokens` breakdown,不会再把 reasoning 重复相加:

- **最近** —— 最后一次模型请求的速率(请求级);
- **上轮均** —— 上一条回复全部有效请求的加权平均(轮次级);
- **会话均** —— 本会话全部有效请求的加权平均(会话级)。

“最近”是单请求值;“上轮均/会话均”采用 `Σoutput_tokens ÷ ΣdurMs` 的请求服务时长加权口径。`durMs = duration_ms ?? (completed_at-started_at)`,包含模型请求内的首 token 等待与内部网络重试。有效样本要求 output>0 且 durMs 在 `[500ms,1h)` 半开区间。

这里的“端到端”只指**单次模型请求**:请求之间的工具执行、编排间隙不在分母内;并发子代理的请求时长会相加。因此它不是整轮或整个会话的墙钟吞吐。数据库只有聚合 token 数和首 token 时间,无法可靠还原物理“爆发速度”。

数据来源:`~/.zcode/cli/db/db.sqlite`(`model_usage` / `turn_usage` 表,只读打开,WAL 模式不影响客户端)。TTFT 继续使用 `time_to_first_token_ms`;没有 text/reasoning 流事件但 duration 有效的工具调用请求仍可计算 headline,只是 TTFT 为空。

### 0.4.0 口径迁移

0.3.0 使用 `(output+reasoning)÷(completed-first_token)`。在 Responses 用量结构中 reasoning 是 output 的明细,旧公式会重复计数,且首 token 后窗口不覆盖隐藏思考/首字等待。0.4.0 改为 `output÷duration`;数值下降是口径修正,不是模型性能下降。`/tps` history 的 `legacyTps` 仅用于与 0.3 旧显示对比,不代表真实 burst。

环境变量:

- `TOKEN_RATE_MIN_MS`:有效模型请求的最短总时长,默认 500ms;变量名为兼容旧配置保留,0.3 中它表示纯生成窗口下限;
- `TOKEN_RATE_MAX_MS`:有效模型请求的最长总时长,默认 1h;
- `TOKEN_RATE_HIST`:history 返回条数,默认 60。

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
- output 为 provider 总输出并已包含 reasoning breakdown;显示“思考”时是其中量,不是在 output 之外再次相加;
- 零输出 completed 请求不计速率/samples,但仍保留在请求数与 token 累计中;
- 缓存命中率 = 缓存读 ÷ 总输入;`cache_creation_input_tokens`(缓存写入)不计入命中;
- 会话 `input_tokens` 为该会话所有 main_turn 请求的输入(含缓存读);
- **子代理归因**:默认开启——与主会话共享 `trace_id` 的子代理(subagent)请求会并入会话级统计(实测约占输出 token 的两成);`~/.zcode/zcode-tps.config.json` → `{"includeSubagents": false}` 切回纯主对话口径(需重开会话);
- **单一数据源(v0.4.1)**:轮次/会话聚合只读 `model_usage`,不再读取 `turn_usage`——实测跨重启恢复的会话,ZCode 不再写入 turn_usage 行(其余会话正常),旧实现会把三天前的"上轮/会话 tok/缓存命中率"冻结展示。代价:会话累计只覆盖 model_usage 的留存窗口(ZCode 会定期清理旧行),不再是全历史总量;
- **口径边界**:子代理归因只作用于会话级速率与累计;并入子代理时速率行标注 `tok(主)`/`%(主)` 标明 token/缓存的纯主对话口径,`session.samples` 与 `会话均` 则含子代理有效请求;子代理没有有效速率样本时其累计仍保留、`subagent.avgTps` 为空;
- **会话识别**(`/tps` 未传 env 时):显式 `ZCODE_SESSION_ID` > `~/.zcode/zcode-tps.last-session.json`(新鲜或有数据时) > 最新 `main_turn` 会话 > 最新任意完成行——子代理行不再劫持自动识别;
- **健壮性**:只读连接带 2s `busy_timeout` + 忙时重试一次;CLI `--json` 失败时输出 `{"error","db"}` 对象而非堆栈;
- **自检分级**:`/tps-doctor` 分 error(❌,影响退出码)与 warn(⚠️,降级可用:缺 `trace_id`/`turn_id` 列;`turn_usage` 表自 v0.4.1 起不再被读取);配置布尔兼容字符串写法(`"false"`/`"off"` 等同样生效)。
- 回归测试:`node test/degrade.test.mjs`(覆盖 turn_usage 缺失/结构变更的降级路径、子代理归因与指标口径)。
