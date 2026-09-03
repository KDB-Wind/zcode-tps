---
description: 自检 zcode-tps 插件(定位"速率行不见了"等问题)
---

用 Bash 运行(自动定位插件安装缓存中最新的版本目录,ls -td 在 GNU/BSD ls 上均可用;末尾 sed 去掉个别平台给可执行文件加的 `*` 后缀):

```
node "$(ls -td ~/.zcode/cli/plugins/cache/*/zcode-tps/*/scripts/doctor.mjs 2>/dev/null | head -1 | sed 's/\*$//')"
```

若找不到文件,回退为搜索用户目录(-maxdepth 9 覆盖插件缓存的完整深度):

```
node "$(find "$HOME" -maxdepth 9 -type f -path "*zcode-tps/scripts/doctor.mjs" 2>/dev/null | head -1)"
```

以中文逐项展示自检结果(✅/❌),对未通过项给出具体修复建议。常见问题:Node 版本 < 22.5(缺内置 node:sqlite)、插件安装后未重开会话(钩子未注册)、usage 数据库路径异常(可用环境变量 ZCODE_USAGE_DB 指定)。

用户附加要求:$ARGUMENTS
