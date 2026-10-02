---
description: 查看 token 速率与用量报表：最近请求、最近轮次、留存范围累计和缓存命中率（加"完整报表"执行 details 诊断：分账/可靠性/等待/对账）
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

1. **采样与范围**：展示 `sampledAtText`（连同 `timezone` 和 `utcOffset`）、会话 ID 和识别来源 `scoped`。数据仅覆盖库内留存的 completed 请求；这是脚本执行时的快照，可能包括当前轮已完成请求。`coverage` 的完成时间范围对应基础请求范围（`firstCompletedAtText`/`lastCompletedAtText`）。
2. **最近请求**：取 `history` 前 10 条，按返回顺序展示时间、模型、`tokPerSec`、`decodeTps`（纯生成 Decode 速度）、TTFT、输出（其中 reasoning）与 `durMs`。时间一律直接引用各行预格式化的 `completedAtText`，不要用毫秒时间戳自行换算成 UTC。`latest` 为独立查询的最近有效请求，可能不在 history 内；应标注其完成时间（`latest.completedAtText`）。`legacyTps` 只在用户明确要求与 0.3 对比时展示，并说明旧公式存在重复计数，不代表物理爆发速度。
3. **最近轮次**：`turn=null` 时显示“轮次未知”，不推测轮均；否则展示输入、输出、其中思考、总量、缓存读、缓存写入、请求数和有效请求服务时长（完成时间用 `turn.completedAtText`）。`completion=unknown` 表示整轮是否结束未知，不标成“已完成轮”。
4. **基础范围累计**：基础范围严格为当前会话主对话（`usage.scope="main_turn"`）。总量 = 输入 + 输出；reasoning 已含在输出中。`usage.turns=null` 时显示未知，可附 `knownTurns` 和 `unknownTurnRequests`；已知轮数也不是已完成轮数。缓存命中率取 `cacheHit`。另展示请求级 Decode 分布 `decodeStats`：均值/中位/p90（tok/s）与样本数（解码窗口 ≥200ms，基础范围口径、不含子代理；中位/p90 为 nearest-rank 分位，`index = ceil(p×n)−1`）。缺失值显示“未知”，不能补成 0。会话没有主请求时 `usage=null`，只展示第 5 条的辅助请求用量，不产出速率。
5. **会话合计与子代理**：按 `session.scope` 展示请求数、有效样本数、总输入、总输出、总量 `session.total`、均速与 `session.cacheHit`，另展示会话加权 Decode 速度 `session.decodeTps`（注明有效样本 `decodeSamples`，TTFT 缺失且无法回退的请求不参与）。有 `session.subagent` 时另列子代理累计和均速；无有效速率样本时均速可为空，但用量仍存在。不要把 usage 的主对话总量冒充含子代理合计。另单列辅助请求用量 `auxiliary`：本会话标题生成、压缩、目标完成验证等内部请求（`class` 为 title/system/unknown），不计入主统计与速率；`warnings` 出现“未识别的请求来源”时如实展示来源名。
6. **降级信息**：展示 `warnings` 中的原因。若无请求，直接说明暂无数据。

速率为 provider 总输出 ÷ 单次请求端到端时长，reasoning 不再相加。`durMs=duration_ms ?? (completed_at-started_at)`。有效样本要求 output>0、时长位于 `[TOKEN_RATE_MIN_MS,TOKEN_RATE_MAX_MS)`，默认 500ms/1h。最近轮均和会话均为 `Σoutput÷Σduration`，并发请求时长相加；不包含请求间工具执行，不是整轮墙钟吞吐。零输出或无效时长 completed 请求仍计入用量。

Decode 速度为 `output ÷ (durMs − TTFT)`（纯生成阶段，剔除首字等待），口径近似智谱官方"高峰期平均 Decode 速度"，可用于同环境趋势观察；计时边界、请求构成与平均方法不同，不保证与官方数字等价。端到端速率低于 Decode 是正常的（差值即排队+预填充+传输）。TTFT 缺失时回退 `first_token_at − started_at`，两者皆缺不参与 Decode；解码窗口 ≥200ms 对请求级、分布与会话级统一生效。

时间显示：JSON 中所有毫秒时间戳仅是机器可读值，报表一律使用随结果返回的预格式化 `*Text` 字段（已按 `timezone` 换算，默认 Asia/Shanghai，附 `utcOffset`），不要自行换算成 UTC。需要 UTC 对照时说明可在配置 `timezone` 设为 `"UTC"`（也支持 `"system"` 与任意 IANA 时区名；环境变量 `ZCODE_TPS_TIMEZONE` 优先）。

`includeSubagents` 默认开启，可在配置文件中关闭。默认简洁行 token/缓存对应 usage 范围，含子代理会话均与它范围不同。不要把输入 token（含缓存）直接解释成实际计费。

## 完整报表（仅当用户要求分账/workflow/可靠性/等待分布/对账等诊断时执行）

在上述脚本定位成功后，追加 `--details` 运行一次（有界子进程，入口预算 5s；超时会保留基础数据并把未完成模块标记为 timeout）。两次运行是各自快照，数字允许略有差异：

```powershell
node "$tpsScript" --json --details
```

```bash
node "$tps_script" --json --details
```

只展示 `diagnostics` 中可用的章节，按顺序渲染；`status` 非 ok 时如实说明降级原因（reasonCode）。以下输出字段说明均为**文档示例格式，不是真实数字**；运行失败时展示错误与 `db` 路径，不得用示例数字替代真实值：

1. **分账（accounting）**：先展示 `observedUsage`（requests/input/output/total），文案为"相关请求已记录用量"，注明它不是 `session.total`、不是全部历史真实消耗、更不是费用账单；失败已记录量不解释为额外收费。再列互斥分桶 `main/workflow/subagent/auxiliary/unclassified`（requests、input、output、total、`quality.tokensComplete=false` 时写"已知部分"并注明存在缺失/非法 token 字段），以及 `ambiguousCandidates`（数量与冲突原因，注明未计入任何 root 总量）。引用 `scope.note` 说明状态范围与留存范围。
2. **workflow（status=ok/partial 且有 data）**：展示 run 列表、唯一行总量、`unallocated` 与 `omittedRunsUsage`。同 root 多 run claim 的行只在总量中计一次，歧义用量不分配到具体 run；截断明细不截断总量。说明 `reportedSpentTokens` 是宿主摘要，不与 usage 相加；节点/嵌套细分未验证时如实注明。
3. **可靠性（reliability）**：状态计数（未映射 raw status 单列）；`failedRecordedUsage`（失败已记录用量）；`overlappingFlags` 注明 cancelled_by_user/retryable/context_exceeded 是可重叠特征、不是可加的状态桶；`errorTypes` 脱敏统计（不展示 error_message）。`retry.reported` 为宿主上报重试摘要（不与观察尝试数相加）；`retry.attempts` 为库内留存的观察值，附 `retentionNote`。
4. **等待分布（timing）**：TTFT 的 direct/derived/invalid/missing 计数与 mean/median/p90（请求算术均值与 nearest-rank 分位，非 token 加权）；Decode 有效样本与分子/分母；`byModel` 分组表（provider+model，同名模型不跨 provider 合并，最多 50 组其余为 other）。TTFT 是"首 token 等待"，不是 HTTP TTFB。
5. **对账（reconciliation）**：展示 result（matched/different/missing-aggregate/invalid/incomplete）、全部状态行的比较范围、逐字段 delta（= model_usage − turn_usage）及 skippedFields/sourceQuality。非法或缺失源值的 delta 为 null，incomplete 不得转述为一致；different 只说明当前快照有差异，可能尚未回填。缺表为 unavailable，不影响其他章节。
6. **降级**：`diagnostics.warnings`、各模块 `warnings` 与 reasonCode（schema-missing/contract-unverified/association-ambiguous/no-session/no-data/invalid-data/timeout/query-error）如实转述；timeout 说明预算内未完成、未输出半个累加桶。

`--details workflow,reliability,timing,reconciliation` 可只请求部分模块；只请求 timing/reconciliation 时没有分账章节，属预期。默认注入行与本命令的基础部分不受影响。

用户附加要求：$ARGUMENTS
