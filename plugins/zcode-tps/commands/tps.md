---
description: 查看 token 速率与用量报表：最近请求、最近轮次、留存范围累计和缓存命中率
---

只读查询 ZCode 数据库。优先使用显式 `ZCODE_TPS_SCRIPT`，其次当前 `ZCODE_PLUGIN_ROOT`，最后按修改时间查找默认缓存中的脚本。缓存回退不保证就是当前启用版本；如版本不符，明确指定脚本路径。选择当前可用的 shell 执行一段即可。

PowerShell（Windows 无需 Git Bash）：

```powershell
$tpsScript = $env:ZCODE_TPS_SCRIPT
if (-not $tpsScript -and $env:ZCODE_PLUGIN_ROOT) {
    $candidate = Join-Path $env:ZCODE_PLUGIN_ROOT 'scripts/token-rate.mjs'
    if (Test-Path -LiteralPath $candidate) { $tpsScript = $candidate }
}
if (-not $tpsScript) {
    $candidate = Get-ChildItem -Path "$env:USERPROFILE/.zcode/cli/plugins/cache/*/zcode-tps/*/scripts/token-rate.mjs" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($candidate) { $tpsScript = $candidate.FullName }
}
if (-not $tpsScript) { throw '找不到 token-rate.mjs，请用 ZCODE_TPS_SCRIPT 指定安装路径' }
node "$tpsScript" --json
```

Bash（macOS/Linux/Git Bash）：

```bash
tps_script="${ZCODE_TPS_SCRIPT:-}"
if [ -z "$tps_script" ] && [ -n "${ZCODE_PLUGIN_ROOT:-}" ] && [ -f "$ZCODE_PLUGIN_ROOT/scripts/token-rate.mjs" ]; then
  tps_script="$ZCODE_PLUGIN_ROOT/scripts/token-rate.mjs"
fi
if [ -z "$tps_script" ]; then
  tps_script="$(ls -td "$HOME"/.zcode/cli/plugins/cache/*/zcode-tps/*/scripts/token-rate.mjs 2>/dev/null | head -1 | sed 's/\*$//')"
fi
[ -n "$tps_script" ] || { echo '找不到 token-rate.mjs，请用 ZCODE_TPS_SCRIPT 指定安装路径'; exit 1; }
node "$tps_script" --json
```

先检查 JSON 的 `error` 字段，有错误则展示原因和 `db` 路径，不渲染虚构指标。成功时整理为中文报表：

1. **采样与范围**：展示 `sampledAt`、会话 ID 和识别来源 `scoped`。数据仅覆盖库内留存的 completed 请求；这是脚本执行时的快照，可能包括当前轮已完成请求。`coverage` 的完成时间范围对应基础请求范围。
2. **最近请求**：取 `history` 前 10 条，按返回顺序展示时间、模型、`tokPerSec`、TTFT、输出（其中 reasoning）与 `durMs`。`latest` 为独立查询的最近有效请求，可能不在 history 内；应标注其完成时间。`legacyTps` 只在用户明确要求与 0.3 对比时展示，并说明旧公式存在重复计数，不代表物理爆发速度。
3. **最近轮次**：`turn=null` 时显示“轮次未知”，不推测轮均；否则展示输入、输出、其中思考、总量、缓存读、缓存写入、请求数和有效请求服务时长。`completion=unknown` 表示整轮是否结束未知，不标成“已完成轮”。
4. **基础范围累计**：按 `usage.scope` 标注主对话（main_turn）或当前会话全部请求来源（session_all）。总量 = 输入 + 输出；reasoning 已含在输出中。`usage.turns=null` 时显示未知，可附 `knownTurns` 和 `unknownTurnRequests`；已知轮数也不是已完成轮数。缓存命中率取 `cacheHit`。缺失值显示“未知”，不能补成 0。
5. **会话合计与子代理**：按 `session.scope` 展示请求数、有效样本数、总输入、总输出、总量 `session.total`、均速与 `session.cacheHit`。有 `session.subagent` 时另列子代理累计和均速；无有效速率样本时均速可为空，但用量仍存在。不要把 usage 的主对话总量冒充含子代理合计。
6. **降级信息**：展示 `warnings` 中的原因。若无请求，直接说明暂无数据。

速率为 provider 总输出 ÷ 单次请求端到端时长，reasoning 不再相加。`durMs=duration_ms ?? (completed_at-started_at)`。有效样本要求 output>0、时长位于 `[TOKEN_RATE_MIN_MS,TOKEN_RATE_MAX_MS)`，默认 500ms/1h。最近轮均和会话均为 `Σoutput÷Σduration`，并发请求时长相加；不包含请求间工具执行，不是整轮墙钟吞吐。零输出或无效时长 completed 请求仍计入用量。

`includeSubagents` 默认开启，可在配置文件中关闭。默认简洁行 token/缓存对应 usage 范围，含子代理会话均与它范围不同。不要把输入 token（含缓存）直接解释成实际计费。

用户附加要求：$ARGUMENTS
