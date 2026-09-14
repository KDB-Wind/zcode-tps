# 正确性矩阵(2026-09-15,v0.5.3 轮 T3)

验证目标:三类本地 SQLite 库形状 × 七种异常样本,插件必须不崩溃、输出合理、静默降级有日志。
自动化:`node test/correctness.test.mjs`(已纳入 `npm test`),逐格断言查询行为与 doctor 分类。

## 库形状(合成样本)

| 形状 | 模拟对象 | 关键结构 |
|---|---|---|
| `cli-db` | `~/.zcode/cli/db/db.sqlite` | `model_usage`(完整 16 列)+ `session`/`message`/`part` |
| `tasks-index` | `~/.zcode/v2/tasks-index.sqlite` | `tasks`/`automations` 等任务表,**无 model_usage** |
| `opencode` | 其他客户端(如 opencode.db) | `message`/`part`/`session` 但列名与结构完全不同,**无 model_usage** |

## 异常维度

`normal`(2 条有效请求)/ `empty`(建表无数据)/ `missing-required-col`(DROP duration_ms)/ `extra-unknown-col`(ALTER ADD 2 个未知列并写入)/ `corrupt`(合法库头部 4KB 覆写为垃圾字节)/ `huge-text`(model_id 1MB、turn_id 200KB)/ `future-timestamp`(completed_at 在未来 30 天)。

## 矩阵结果(21/21 通过)

| 形状 × 异常 | 查询行为 | doctor 分类 |
|---|---|---|
| cli-db × normal | ok(requests=2) | ✅ 核心列完整 |
| cli-db × empty | ok(空统计;auto 识别附"会话未知"警告) | ✅(表存在无数据) |
| cli-db × missing-required-col | **degrade:明确报"缺少列"**(hook 路径空注入,degrade 用例 27 已覆盖) | ❌ error(缺列名列出) |
| cli-db × extra-unknown-col | ok(requests=2,未知列被忽略) | ✅ |
| cli-db × corrupt | **degrade:打开即明确报错** | ❌ 无法只读打开 |
| cli-db × huge-text | ok(requests=2,超长标识原样保留、不进显示行) | ✅ |
| cli-db × future-timestamp | ok(requests=2,未来行可成为 latest) | ✅ 且标注"时间在未来" |
| tasks-index × *(全部 7 格)* | **degrade:"model_usage 表不存在" 明确报错**,不崩溃 | ❌ 表不存在 |
| opencode × *(全部 7 格)* | 同上 | ❌ 表不存在 |

## 结论

- 一切非用量库(tasks-index、opencode 形状)与损坏文件都在**打开/首查阶段明确报错**,由 CLI `{"error","db"}` 与 hook 空注入承接,不存在崩溃或错数路径。
- cli-db 形状的全部异常按冻结边界分级降级:必需列缺失=error;空库/未知列/超长文本/未来时间戳=正常统计或空统计 + 警告。
- v0.5.3 新增:表不存在与缺列的错误文案已区分(审计 P2-2);doctor 对异常类型与未来时间戳不再输出 NaN/负数(审计 P2-1)。
