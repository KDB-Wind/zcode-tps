---
description: 查看 token 速率与用量报表(tok/s、TTFT、本轮、会话累计、缓存命中率)
---

用 Bash(Windows 请用 git-bash)运行以下命令获取真实 token 统计(只读打开 ZCode usage 数据库,不写任何数据)。先取插件安装缓存中的最新版本(ls -td 在 GNU/BSD ls 上均可用;末尾 sed 去掉个别平台给可执行文件加的 `*` 后缀);找不到再窄范围搜索 `~/.zcode` 子树(插件缓存固定在此目录下,比全家目录快一个数量级);自定义安装位置可用环境变量 `ZCODE_TPS_SCRIPT` 直接指定:

```
ZCODE_TPS_SCRIPT="${ZCODE_TPS_SCRIPT:-$(ls -td ~/.zcode/cli/plugins/cache/*/zcode-tps/*/scripts/token-rate.mjs 2>/dev/null | head -1 | sed 's/\*$//')}"
[ -n "$ZCODE_TPS_SCRIPT" ] || ZCODE_TPS_SCRIPT="$(find ~/.zcode -maxdepth 8 -type f -path "*zcode-tps/scripts/token-rate.mjs" 2>/dev/null | head -1)"
[ -n "$ZCODE_TPS_SCRIPT" ] || { echo "找不到 token-rate.mjs:插件未安装或不在默认位置,可用 ZCODE_TPS_SCRIPT 指定路径,或运行 /tps-doctor 自检"; exit 1; }
node "$ZCODE_TPS_SCRIPT" --json
```

仍找不到则运行 `/tps-doctor` 自检。把 JSON 结果整理为中文报表,包含:

1. **最近请求**(history 数组,history[0] 为最新、按时间倒序;数组最多含 60 条、可用 TOKEN_RATE_HIST 调整;表格展示前 10 条即可):表格列出 时间、模型、tok/s、首字延迟 TTFT、输出 token(含思考)、耗时。tok/s = (输出+思考 token) ÷ 纯生成时长(completed_at − first_token_at),不含首字等待;history 仅含主对话口径行(不含子代理明细,子代理看 `session.subagent`);
2. **上一轮**(turn 字段):输入/输出/思考/缓存读 token、总消耗、模型请求数、时长、该轮缓存命中率;
3. **会话累计**(usage 字段,恒为主对话口径 `scope="main_turn"`):总 token(= 输入+输出,输入含缓存读)、其中输出/思考、轮数;缓存命中率 = 缓存读 ÷ 总输入(cacheHit 字段,百分比);并入子代理时报表中会注明"主对话口径",子代理量级另见 `session.subagent`;
4. **三级加权速率**(tok/s,口径均为 Σ(输出+思考 token) ÷ Σ纯生成时长,只统计有效请求):`latest.tokPerSec`(最近一次请求)、`turn.avgTps`(上一轮全部请求,主对话)、`session.avgTps`(会话全部请求,默认含子代理);`session.samples` 为计入会话均的有效请求数(含子代理);history 数组可自行计算峰值与明细;注意 `latest` 取最新一条**有效**请求,最新行缺流式时间戳(中断/非流式)时会与 `history[0]` 错一位,属预期;
5. **子代理归因**(`session.subagent` 字段,默认开启):并入会话口径的子代理请求数/token/速率;`session.includesSubagents` 标识当前口径。配置 `~/.zcode/zcode-tps.config.json` → `{"includeSubagents": false}` 可切回纯主对话口径。

注意:数据快照是本条消息发出时刻,不含当前正在进行的这轮回复。缓存命中率口径:ZCode usage 库中 input_tokens 已包含 cache_read_input_tokens。`scoped` 标识会话识别来源(explicit/file/auto-main/auto);脚本执行失败时 `--json` 输出 `{"error","db"}` 对象(先检查此字段再渲染报表)。

用户附加要求:$ARGUMENTS
