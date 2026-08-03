# 研究进度与架构决策记录（2026-08-02）

> 本文件是项目的"发现/决策/进度"权威记录，随每个阶段更新。
> 仓库 SHA（记录时）：arena `a5b1dca` / pi-dev `da0203afd`。

## 一、外部审阅结论（两轮，已采纳）

### 第一轮：5 个 P0 正确性问题
1. **MapStore 不实时跨进程共享**——内存缓存只在启动时加载，其他进程写入要等重启才可见
2. **LLM 超时污染下一 Tick**——ask 超时不取消/隔离旧事件，迟到响应会串到下一 Tick
3. **进程重启后不重发规则**——`_first` 布尔在 backend 重启后失效，新会话无 RULES
4. **Telemetry 漏掉失败 Tick**——paused/空计划/409/超时全部无遥测行，CSV "w" 覆盖
5. **孤儿 pi 进程**——调度器强杀租户，pi node 子进程残留

### 第二轮：Pi 原生架构（SUPERP 五原则）
- **S** Single Purpose：Pi=Agent runtime；Arena=环境/执行器；pi-arena=领域适配层
- **U** Unidirectional Flow：Turn → State → Safety Plan → Agent Run → 校验 → Deadline → Submit
- **P** Ports over Implementation：AgentRuntimePort/WorldKnowledgePort/PlanValidatorPort 等
- **E** Environment-Agnostic：不假设 Windows/路径/端口/模型
- **R** Replaceable Parts：模型/存储/prompt/策略/遥测均可替换

核心判断：**不要做成"Python 每 Tick 调 LLM 的脚本"，也不要魔改 Pi 成 Arena 专用框架**。
最优先动作：把 arena_plan/arena_map/--arena-* 从 Pi core 迁成标准 Pi Extension（Phase 0+1）。

## 二、已落地（按提交序）

| 提交 | 内容 |
|---|---|
| `58bad59` | P0-1 MapStore 实时一致性：revision + rowid 增量游标 + busy_timeout |
| `8a934f0` | P0-2/P0-3：ask 超时隔离（_restart + 清队列 + epoch）；epoch 感知 bootstrap；工具调用按 call_id 合并；stderr 消费线程 |
| `f5156d7` | **Phase 0+1：packages/pi-arena 原生 extension**（registerTool 双工具）+ contracts/ SSOT + docs/pi-patches.md |
| `da0203afd`（pi-dev） | Pi core 删除全部 Arena 专用代码（保留通用类型修复） |
| `024ffdb` | 共享地图日志占位符修复（stats 新增字段） |
| `bac39b6` | MapStore 线程安全（DebugServer 跨线程查询 → RLock + check_same_thread=False） |
| `2ae3cb1` | **多进程并发写 database is locked**（BEGIN IMMEDIATE + 5 次退避重试；测试：4 子进程 × 40 格全落盘） |
| `a5b1dca` | **Windows TIME_WAIT bind 竞争**（DebugServer 24×5s 重试，WinError 10013） |

## 三、新发现（修 P0 过程中暴露的真实 bug 链）

1. 共享地图 stats() 扩字段 → main.py 日志 `%d` 不匹配 → Logging error
2. arena_map 经 ThreadingHTTPServer 跨线程查 SQLite → ProgrammingError → 工具 500 → 模型卡死 → 每 tick 超时重建（epoch 疯转）
3. 4 租户同时启动并发写 SQLite → `database is locked` → 租户启动即死（run.py 监控 uv 包装进程导致无感知）
4. Windows 快速重启 → TIME_WAIT 端口 bind 失败（WinError 10013）

## 四、当前运行状态（19:09）

- 4 租户稳定：t1 economic 4/10、t2 aggressive 1/10、t3 standard 1/25（pop5）、t4 standard 3/15（pop3）
- 共享地图：408 障碍格 / 14 chunk / 4 盟友 / revision 189（跨进程实时）
- 测试 133 全绿；pi 决策 2-4s（缓存命中），偶发超时走 epoch 重建 + fallback（容错正常）
- 实验定义：experiments/exp-llm-4.yaml（4 账号全 LLM）

## 五、待办（按外部审阅路线图）

- [ ] **P0-4**：全 Tick 遥测（每观察到的 tick 必写一行含 outcome）+ run manifest（SHA/实验/YAML/模型）
- [ ] **P0-5**：优雅退出（play() try/finally + 调度器 graceful shutdown + 进程树清理）
- [ ] parser 语义校验分层（capability/current-state/per-action repair）——Ranger 打不可见目标目前仍通过
- [ ] arena 工具 policy 统一（arena_plan 的 prompt guideline 与 RULES 去冲突）
- [ ] Phase 2：hedged safety plan（soft/hard deadline + abort + 一 session 一 active run）
- [ ] Phase 3：Arena 专用 context builder / 战略记忆 / 自定义 compaction / session rotation / World Store TTL / 语义地图工具
- [ ] Phase 4：fault injection / 数千 tick soak / 跨仓库 compatibility CI / 健康状态
- [ ] 实验方法论：Latin square（账号不再固定绑策略）、统一 KPI（安全达到 30/50 的 tick 数）

## 六、研究 agent 状态（本会话派发）

4 个只读研究 agent 并行（策略/pi 对接/bug 审计/架构评估），结论回来后并入本文档。
场外支援（ChatGPT Web）通过两个 private 仓库审阅：github.com/DeliciousBuding/arena + /pi。

## 七、P0-4/P0-A 完成 + TS 迁移启动（19:50）

### P0-4 全 Tick 遥测（fcd236e）
- telemetry.py 重写为 append-only JSONL；main.py `_record_tick` 接入全部分支
  （submitted/paused/empty/tick_mismatch/error）；evaluate.py 读 t*.jsonl 并新增 outcome 列
- 修 evaluate `events_total` 恒为 0 的真实 bug（`num()` 吞掉 dict）
- 旧实验还在写 CSV——JSONL 在下次重启后生效

### P0-A revision 只在有效 mutation 时递增（2bb9de5）
- `_write(bump_revision)`：同一事务内 INSERT OR IGNORE 的 rowcount>0 才 bump
- 验收：同批障碍重复 100 次 revision 不变；重复盟友不变；写入后校准本地快照
- 顺手移除 arena_map 的 resources 假能力（MapStore 不持久化资源格）——
  contracts/TS schema/Python 三处同步，协议 1.0 enum 收敛为 stats/obstacles/allies

### TS 迁移决策（用户拍板）
- **SDK 不重写**：fork 上游 arena-hero/arena-hero-python → DeliciousBuding/arena-hero-ts
  （public，Apache-2.0；上游 Python 保留可 merge，TS 实现独立包）
- **编排层重写 TS**：pi-coding-agent 直接嵌入（createAgentSession 是官方 SDK API），
  RPC 桥消失、schema 单源、原生 abort
- 完整方案与工作包：docs/migration-plan.md

### arena-hero-ts SDK 完成（7af2818）
- 2045 行完整移植（enums/types/actions/protocol/client/turn），16 测试全绿
- encodePlan 与 Python sort_keys 交叉验证逐字节 MATCH
- 真机只读验证：WS 1.16s → tick 39555 → Turn 解析（4 workers/core=deliciousbuding）✓
- 关键坑：Node 内置 WebSocket 不支持自定义 header → 唯一运行时依赖 `ws`

### MapStore TS 移植完成
- packages/arena-agent/src/map-store.ts（node:sqlite 同步 API，无 RLock）
- 完整继承 Python 语义：WAL/BEGIN IMMEDIATE+重试/revision 游标/P0-A
- 8 测试全绿（含 4 子进程并发写 160 cells）

### 测试基线
- Python 135 全绿；arena-hero-ts 16 全绿；arena-agent(MapStore) 8 全绿

### 待办（迁移顺序见 migration-plan.md §5）
- [ ] spike-embed 验证结果（createAgentSession 嵌入/abort）→ W4 决策桥
- [ ] W1-W6 编排层移植（TickState/策略/遥测/决策桥/supervisor/schema 单源）
- [ ] 4 租户实验重启到 JSONL 遥测
