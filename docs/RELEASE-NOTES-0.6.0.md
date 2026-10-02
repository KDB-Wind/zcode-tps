# zcode-tps 0.6.0 发布说明(发布候选)

日期:2026-10-02。D01–D09 审核修复完成，验证见 [修复记录](FIX-VALIDATION-0.6.0-20261002.md)。分支 `feat/0.6.0`,基线 = 0.5.5(b95e0d2)。
状态:**发布候选**——origin/tag 推送与本地 marketplace 发布仍需用户单独授权;本文不含任何示例数字冒充真实输出。

## 一句话

0.6.0 是**按需完整诊断报表**版本:默认行为与 0.5.5 完全一致;新增 `--details` 报表回答"哪些请求、哪个来源、多少已记录用量、有哪些失败与等待";证据不足的能力诚实延后。

## 范围 before/after

| 能力 | 0.5.5 | 0.6.0 |
|---|---|---|
| 默认注入行 / `/tps` 基础统计 | ✅ | ✅ 完全不变(快速路径不新增 SQL) |
| usage 主账 | model_usage 只读聚合 | 同上,不变 |
| 子代理归因 | trace 共享(completed) | 兼容口径不变;诊断范围另列(含非 completed) |
| workflow 请求 | 落入 auxiliary(unknown 类) | 新分账桶 `workflow`(权威 actor 链;trace 仅交叉验证) |
| error/cancelled 请求 | 不出现在任何报表 | reliability:状态计数 + 失败已记录用量(一次计入) |
| retry | 无 | `reported`(宿主上报)+ `attempts`(库内观察,坏组标记) |
| TTFT/Decode | 请求级 + 会话均/分布 | 新增 direct/derived/invalid/missing 来源计数、mean/median/p90、provider+model 分组 |
| turn_usage | 不读取 | reconciliation:最近主轮同快照整数精确对账 |
| doctor | 基础自检 | + `--details` 能力诊断(可选缺失为警告) |

## 新接口

```text
node token-rate.mjs --json --session <sessionId>            # 基础(显式会话优先于环境变量)
node token-rate.mjs --json --session <sessionId> --details  # 完整诊断(全部四模块)
node token-rate.mjs --json --session <sessionId> --details workflow,reliability,timing,reconciliation
node doctor.mjs --details                                   # 能力诊断(轻量 schema 探测)
```

- `--details` 需要配合 `--json`;无值 = 全部四模块;空值/未知名字、未知 flag、重复参数以及未开放 current/prompt-key 返回结构化参数错误(退出码 1)。
- **机器调用方必须读取各模块 `status`**(ok/partial/unavailable/error)与 `reasonCode`,不能只看进程退出码:模块失败时基础数据照常返回、退出码为 0。
- 预算:入口 5s + 清理预留 500ms;超时保留已交付的基础与完整模块,未完成模块记 `timeout`。可用 `ZCODE_TPS_DETAILS_BUDGET_MS` 调整(测试/诊断用途)。

## 能力矩阵(0.6.0 实际开放范围)

| 能力 | 状态 | 依据/降级 |
|---|---|---|
| usage 行身份(id 主键去重) | ✅ ok | DATA-CONTRACT §1；实际唯一键检查，缺失时禁用分账 |
| 子代理 trace 归因(诊断) | ✅ ok | §4.1;多 root trace 命中判歧义 |
| workflow 分账(actor 链) | ✅ ok | §4.2;节点细分 unavailable(无关联列) |
| retry reported 摘要 | ✅ ok | §5(retry_count 宿主上报,不相加) |
| retry 尝试分组指标 | ✅ ok(观察口径) | §5;跨 session/provider、域未知或重复/缺失/非法 attempt_index 的组不产出准确指标 |
| error/retry 状态与失败用量 | ✅ ok | §3;error_message 永不输出 |
| TTFT/Decode 分布与分组 | ✅ ok | §6;TTFT ≠ HTTP TTFB |
| turn_usage 对账 | ✅ ok | §7;主轮整数 token;差额不定性损坏 |
| 本问快照 / 收尾采样(wrapUpSample、`--current`) | ❌ **unsupported,默认关闭** | §8:内核源码有 turnId 证据,但运行时传递与展示行为未验收 → 按 spec §10.3 延后至 0.6.x |
| dwf_run.spent_tokens | reported 摘要单列 | 语义未验证,不与 usage 相加 |
| 大屏 / MCP / daemon / 费用账单 | 不做 | spec §1 |

## 性能与预算

- 快速路径(默认行、Stop 查询)无任何新增语句与探测;现有 ≤8 SELECT 门禁继续生效(release 测试覆盖)。
- details 有界子进程:入口预算 5s(可配),清理预留 ≤500ms;锁定/慢库时在预算内返回错误结构;百万行有索引典型会话实际完整 CLI 263ms；10k 行相关范围 worker 中位 1123ms/含 workflow-retry 1218ms(合成库,不外推真实全分布)。
- 大库/无索引场景允许 partial/timeout,不伪造完整报表。

## 兼容与回滚

- 升级:结束旧插件运行后加载新版 hooks;旧配置键全部兼容。0.6.0 新增 JSON 字段只出现在显式请求的 details 输出中。
- 回滚:0.5.5 不认识新命令参数,基础用法不受影响;状态文件/水位/claim 协议未变。
- 推送与发布(origin/main、tag、marketplace-local)按惯例**等待用户单独授权**。

## 发布前检查清单

- [x] npm test 全绿(6 文件、25/25,含 D01–D08 原反例)
- [x] D09：100k/1M、real/no-index、typical/largest/auto 快速路径基线对照，典型 details ≤2s，5s 总预算不变
- [x] 数据契约 M0 文档与可复现采样工具入库
- [x] 版本四处一致(package.json / marketplace.json / plugin.json / 双 README 标题)
- [x] CHANGELOG 0.6.0 条目
- [ ] 真实宿主只读主链路验收(默认行)——在用户环境重开会话后确认
- [ ] 真实宿主 `/tps` 完整报表验收——用户授权发布后执行
- [ ] GitHub Actions 六环境矩阵(本机无法代跑,发布时以 CI 为准)
