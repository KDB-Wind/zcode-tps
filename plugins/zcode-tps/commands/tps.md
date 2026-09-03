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

1. **最近请求**(history 数组,history[0] 为最新、按时间倒序;数组最多含 60 条、可用 TOKEN_RATE_HIST 调整;表格展示前 10 条即可):表格列出时间、模型、请求端到端 tok/s(`tokPerSec`)、0.3 旧值(`legacyTps`)、TTFT、provider 总输出 token(其中 reasoning breakdown)、请求总耗时(`durMs`)与首 token 后窗口(`genMs`)。`tokPerSec = output_tokens ÷ durMs`,其中 `durMs = duration_ms ?? (completed_at-started_at)`;output 已包含 reasoning,不可再次相加。`legacyTps=(output+reasoning)÷genMs` 只复现 0.3 的重复计数旧公式用于升级对比,不代表物理爆发速度。history 仅含主对话口径行(不含子代理明细,子代理看 `session.subagent`);
2. **上一轮**(turn 字段):输入/输出/思考/缓存读 token、总消耗、模型请求数、时长、该轮缓存命中率;
3. **会话累计**(usage 字段,恒为主对话口径 `scope="main_turn"`):总 token(= 输入+输出,输入含缓存读)、其中输出/思考、轮数;缓存命中率 = 缓存读 ÷ 总输入(cacheHit 字段,百分比);并入子代理时报表中会注明"主对话口径",子代理量级另见 `session.subagent`;
4. **三级请求速率**(tok/s,聚合口径均为 `Σoutput ÷ Σdur`,只统计 `output>0` 且 `durMs∈[TOKEN_RATE_MIN_MS,TOKEN_RATE_MAX_MS)` 的 completed 请求;两者默认 500ms/1h):`latest.tokPerSec`(最近一次有效请求)、`turn.avgTps`(上一轮有效模型请求的服务时长加权值,主对话)、`session.avgTps`(会话有效模型请求的服务时长加权值,默认含子代理);`session.samples` 为计入会话均的有效请求数。这里的“端到端”是单次模型请求,不含请求间工具执行/编排时间,也不是会话墙钟吞吐。零输出行不计速率但仍保留在请求/token 累计中。无 first-token 但 durMs 有效的请求可成为 `latest`,此时 TTFT/genMs/legacyTps 为空;只有总时长也无效时 latest 才会跳过它;
5. **子代理归因**(`session.subagent` 字段,默认开启):并入会话口径的子代理请求数/token/速率;`session.includesSubagents` 标识当前口径。子代理累计与速率样本独立,所以 `avgTps` 可能为空但请求/token 仍存在。配置 `~/.zcode/zcode-tps.config.json` → `{"includeSubagents": false}` 可切回纯主对话口径。

注意:数据快照是本条消息发出时刻,不含当前正在进行的这轮回复。缓存命中率口径:ZCode usage 库中 input_tokens 已包含 cache_read_input_tokens。`scoped` 标识会话识别来源(explicit/file/auto-main/auto);脚本执行失败时 `--json` 输出 `{"error","db"}` 对象(先检查此字段再渲染报表)。

用户附加要求:$ARGUMENTS
