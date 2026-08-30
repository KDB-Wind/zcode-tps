---
description: 查看 token 速率与用量报表(tok/s、TTFT、本轮、会话累计、缓存命中率)
---

用 Bash 运行以下命令获取真实 token 统计(只读打开 ZCode usage 数据库,不写任何数据)。脚本位于插件安装缓存,用 ls -td 按修改时间取最新安装的版本(ls -td 在 GNU/BSD ls 上均可用,macOS 兼容):

```
node "$(ls -td ~/.zcode/cli/plugins/cache/*/zcode-tps-plus/*/scripts/token-rate.mjs 2>/dev/null | head -1)" --json
```

若上一命令找不到文件(插件未通过市场安装、而是克隆了仓库),回退为搜索用户目录:

```
node "$(find "$HOME" -maxdepth 8 -type f -path "*zcode-tps-plus/scripts/token-rate.mjs" 2>/dev/null | head -1)" --json
```

仍找不到则运行 `/tps-doctor` 自检。把 JSON 结果整理为中文报表,包含:

1. **最近请求**(history 数组,history[0] 为最新、按时间倒序;数组最多含 60 条、可用 TOKEN_RATE_HIST 调整;表格展示前 10 条即可):表格列出 时间、模型、tok/s、首字延迟 TTFT、输出 token(含思考)、耗时。tok/s = (输出+思考 token) ÷ 纯生成时长(completed_at − first_token_at),不含首字等待;
2. **上一轮**(turn 字段):输入/输出/思考/缓存读 token、总消耗、模型请求数、时长、该轮缓存命中率;
3. **会话累计**(usage 字段):总 token(= 输入+输出,输入含缓存读)、其中输出/思考、轮数;缓存命中率 = 缓存读 ÷ 总输入(cacheHit 字段,百分比);
4. **三级加权速率**(tok/s,口径均为 Σ(输出+思考 token) ÷ Σ纯生成时长,只统计有效请求):`latest.tokPerSec`(最近一次请求)、`turn.avgTps`(上一轮全部请求)、`session.avgTps`(会话全部请求);history 数组可自行计算峰值与明细。

注意:数据快照是本条消息发出时刻,不含当前正在进行的这轮回复。缓存命中率口径:ZCode usage 库中 input_tokens 已包含 cache_read_input_tokens。

用户附加要求:$ARGUMENTS
