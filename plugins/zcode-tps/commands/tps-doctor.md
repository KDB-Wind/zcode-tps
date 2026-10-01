---
description: 自检 zcode-tps 的依赖、数据库、配置及最近采集结果
---

只读查询 ZCode 数据库。优先使用显式 `ZCODE_TPS_DOCTOR`，其次当前 `ZCODE_PLUGIN_ROOT`，最后按修改时间查找默认缓存中的脚本。缓存回退不保证就是当前启用版本；如版本不符，明确指定脚本路径。选择当前可用的 shell 执行一段即可。

PowerShell（Windows 无需 Git Bash）：

```powershell
$tpsScript = $env:ZCODE_TPS_DOCTOR
if (-not $tpsScript -and $env:ZCODE_PLUGIN_ROOT) {
    $candidate = Join-Path $env:ZCODE_PLUGIN_ROOT 'scripts/doctor.mjs'
    if (Test-Path -LiteralPath $candidate) { $tpsScript = $candidate }
}
if (-not $tpsScript) {
    $candidate = Get-ChildItem -Path "$env:USERPROFILE/.zcode/cli/plugins/cache/*/zcode-tps/*/scripts/doctor.mjs" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($candidate) { $tpsScript = $candidate.FullName }
}
if (-not $tpsScript) { throw '找不到 doctor.mjs，请用 ZCODE_TPS_DOCTOR 指定安装路径' }
node "$tpsScript" --json
```

Bash（macOS/Linux/Git Bash）：

```bash
tps_script="${ZCODE_TPS_DOCTOR:-}"
if [ -z "$tps_script" ] && [ -n "${ZCODE_PLUGIN_ROOT:-}" ] && [ -f "$ZCODE_PLUGIN_ROOT/scripts/doctor.mjs" ]; then
  tps_script="$ZCODE_PLUGIN_ROOT/scripts/doctor.mjs"
fi
if [ -z "$tps_script" ]; then
  tps_script="$(ls -td "$HOME"/.zcode/cli/plugins/cache/*/zcode-tps/*/scripts/doctor.mjs 2>/dev/null | head -1 | sed 's/\*$//')"
fi
[ -n "$tps_script" ] || { echo '找不到 doctor.mjs，请用 ZCODE_TPS_DOCTOR 指定安装路径'; exit 1; }
node "$tps_script" --json
```

根据 `checks` 逐项用中文展示结果：`ok=true` 为 ✅；`ok=false, level=warn` 为 ⚠️；其他失败为 ❌。退出码只看 error 项；为失败/警告项解释 detail 和 hint。

- 核心列缺失或数据库不可读为 error；缺 trace_id、turn_id、cache_creation_input_tokens 可以降级，按提示说明不可用的字段。
- turn_usage 不参与统计，缺失不应要求用户修复。
- 会话状态文件仅证明曾被写入，不能据此断言当前插件已注册或统计成功。状态文件可由 ZCODE_TPS_LAST_SESSION 覆盖。
- 最近采集记录提供状态、耗时、最后成功时间和错误/降级原因；它可能来自其他会话或已经过期，应保留提示。
- 健康记录按 会话+hook 分链路展示（0.5.5）：「注入链路采集(UserPromptSubmit)」是默认显示行的采集；「通知链路(Stop)」是回合结束通知，按本次运行状态渲染——采集成功（附通知命令结果 ok/suppressed/unknown；同会话并发让位时附让位原因：locked=另一回合结束处理中、concurrent=相同内容已被并发通知、stale=已有更新的并发通知）、通知关闭（turnEndLine 未开启，属预期）、未观察到（回合未结束过/插件刚更新未重开会话/宿主未触发 Stop，以记录为准不预设）、采集失败（error，附原因与"随下次回合结束自动重试"提示）、提交失败（notify-failed，下次回合结束自动重试）、采集中/中断。error/running 状态绝不出现"采集成功"或上一轮通知结果的表述（新运行启动时清空上一轮 notified/notifyStatus，lastSuccessAt 保留用于"最后成功"）。提示语按结果区分：只有 notifyStatus=ok 才写"命令执行完成（退出码 0）"；unknown 写"限时内未退出，按已提交处理且不自动重发"；suppressed 写"测试抑制"。保留报告中的 sessionId/runId；其他会话的成功不能替代当前会话。running 表示本次尚未完成，即使有 lastSuccessAt 也不能报正常；进程退出或超过 8 秒时应解释为可能中断/超时。
- 配置缺失使用默认值，损坏 JSON、非对象配置和非法 TOKEN_RATE_* 环境变量应修正。tokenRateLine=false 是预期关闭，不是故障。
- Node 22 系列最低为 22.13，23 系列最低为 23.4，24+ 支持无实验启动参数导入 node:sqlite。

不要仅因状态文件不存在就断言钩子未注册；建议发送新消息重新采集，结合具体错误诊断。

用户附加要求：$ARGUMENTS
