# zcode-tps 0.5.3 Release Notes(草稿,发布前由人工确认)

> 本文件为草稿,不进入 marketplace;正式发布仍由人工执行(本地未 push)。

## 亮点:百万行级大库不再逼近超时

0.5.2 在库增长到百万行量级时,每次发消息的统计查询会线性变慢:生产同款索引下典型会话中位 3.6s、auto 识别 5.5s,叠加锁等待可突破 hook 的 8 秒宿主超时,速率行会开始随机消失。0.5.3 把单次统计从最多 13 条重复扫描的语句合并为 ≤4 条,并自适应固定 session_id 索引路径,同样的 100 万行合成库上典型会话中位 0.17s(约 21 倍),全部场景 ≤1.1s。

## 修复

- **大库线性劣化**(详见 `docs/PERFORMANCE.md` 前后对比):语句合并 + `INDEXED BY` 自适应(只读探测索引,兼容 ZCode 3.11.2+ 自带索引)+ 连接级 mmap/页缓存。
- **锁路径回归**:连接优化 pragma 在独占锁下会额外付出 busy 等待周期(实测 6.5s→12.8s),已移至 schema 首次成功读取之后,锁路径 6.3s(<8s)。
- **query_source 为 NULL/空白的请求不再静默消失**:以 `(缺失)` 组单列于 auxiliary 并专用告警。
- **错误文案**:model_usage 表不存在(如误指 tasks-index.sqlite)与缺列现在明确区分。
- **doctor**:异常类型时间戳不再显示 "NaN 分钟前",未来时间戳标注"时钟偏差或脏数据"。

## 改进

- `npm run benchmark` 重写为多场景矩阵:小/中/大库(5k/100k/1M 行,真实分布合成器)× 索引场景(无/旧实验/生产镜像)× 查询模式 × 冷/热 × 内存,支持 `ZCODE_TPS_BENCH_SCRIPT` 做任意版本的前后对比。
- 新增正确性矩阵:三类库形状 × 七种异常 21 格回归(`docs/correctness-matrix-20260915.md`),以及"单次查询 SELECT 语句数 ≤ 8"门禁。
- 依赖:保持零第三方运行依赖,无依赖升级。

## 兼容性

- JSON 字段、速率行、配置、环境变量契约与 0.5.2 完全一致;`auxiliary.groups` 可能新增 `source: "(缺失)"` 组(仅当库中存在 NULL/空白 query_source 的 completed 请求)。
- 数据库仍然只读;插件不会对真实用量库创建索引(索引探测仅 PRAGMA,`INDEXED BY` 是查询文本的一部分)。

## 升级

`/plugin install zcode-tps@zcode-tps-marketplace` 更新后重开会话。需要 Node 22.13+(22 系列)、23.4+ 或 24+。
