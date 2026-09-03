---
description: 自检 zcode-tps 插件(定位"速率行不见了"等问题)
---

用 Bash(Windows 请用 git-bash)运行(自动定位插件安装缓存中最新的版本目录,ls -td 在 GNU/BSD ls 上均可用;末尾 sed 去掉个别平台给可执行文件加的 `*` 后缀;找不到则窄范围搜索 `~/.zcode` 子树;`ZCODE_TPS_DOCTOR` 可直接指定脚本路径):

```
ZCODE_TPS_DOCTOR="${ZCODE_TPS_DOCTOR:-$(ls -td ~/.zcode/cli/plugins/cache/*/zcode-tps/*/scripts/doctor.mjs 2>/dev/null | head -1 | sed 's/\*$//')}"
[ -n "$ZCODE_TPS_DOCTOR" ] || ZCODE_TPS_DOCTOR="$(find ~/.zcode -maxdepth 8 -type f -path "*zcode-tps/scripts/doctor.mjs" 2>/dev/null | head -1)"
[ -n "$ZCODE_TPS_DOCTOR" ] || { echo "找不到 doctor.mjs:插件未安装或不在默认位置,可用 ZCODE_TPS_DOCTOR 指定路径"; exit 1; }
node "$ZCODE_TPS_DOCTOR"
```

以中文逐项展示自检结果(✅ 通过/⚠️ 警告/❌ 未通过),对未通过与警告项给出具体修复建议。警告项为可降级能力(子代理归因列、轮次关联列、turn_usage 表缺失),不影响核心速率行,退出码只看 ❌。常见问题:Node 版本 < 22.5(缺内置 node:sqlite)、插件安装后未重开会话(钩子未注册)、usage 数据库路径异常(可用环境变量 ZCODE_USAGE_DB 指定)。

用户附加要求:$ARGUMENTS
