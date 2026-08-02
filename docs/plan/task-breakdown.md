# Task Breakdown — 重构任务分解

最后更新：2026-08-02（Phase 3）

跟踪模式：**LOCAL_ONLY**（无 git remote）→ 批次以 git 提交为单位，进度在 docs/progress/。

## 批次与任务

### Batch 1 — 工程基座（uv + 包结构）

| ID | 任务 | 优先级 | 工作量 | 依赖 | 验收标准 | 测试预期 |
|---|---|---|---|---|---|---|
| A1 | pyproject.toml + uv 初始化（arena-hero 0.2.6 钉死、pytest dev 依赖） | P0 | S | — | `uv sync` 成功；`uv run pytest` 绿色 | 现有 38 例通过 |
| A2 | `src/arena_bot` 包结构 + `config.py`（常量/参数/`.env` 读取，含动态 reserve、巡逻半径等现有调优参数） | P0 | M | A1 | 配置从包导入；秘钥仍只从 .env 读 | config 读取单测 |
| A3 | pytest 配置（rootdir/tests 指向）+ 测试夹具复用准备 | P0 | S | A2 | `uv run pytest` 从项目根跑通 | 现有测试不动全过 |

### Batch 2 — 核心库（日志 + 记忆 + 状态）

| ID | 任务 | 优先级 | 工作量 | 依赖 | 验收标准 | 测试预期 |
|---|---|---|---|---|---|---|
| B1 | `logging_util.py`：文件轮转（logs/arena.log，大小轮转保留 5 份）+ stdout 双写；格式 `[tick][level] msg`；tick 上下文关联 | P0 | M | A2 | 日志文件生成且轮转；stdout 有实时摘要 | 日志格式/轮转单测 |
| B2 | `world.py` 环境记忆：永久障碍记忆（视野外不丢）、资源格状态表（可见/采过/未知，HARVEST_FAILED 更新）、敌人跟踪（位置/类型/时间戳）；全部 stale 标记，决策永远优先当前 Turn 可见 | P0 | L | A2 | 跨 Tick 记忆在 Fake 序列测试中正确更新；stale 数据不被当真相 | 记忆更新单测 |
| B3 | `core/state.py`：Turn 适配层（类型化字段封装、单位/敌人/资源索引预计算） | P0 | S | A2 | 决策层不直接依赖 SDK Turn 细节 | 适配层单测 |

### Batch 3 — 决策内核 I（策略抽象 + Balance 迁移）

| ID | 任务 | 优先级 | 工作量 | 依赖 | 验收标准 | 测试预期 |
|---|---|---|---|---|---|---|
| C1 | `strategy.py`：Strategy 基类（`decide(tick_state, world) -> Plan`）+ Plan 输出模型（单位动作/核心动作/意图） | P0 | M | B3 | 策略接口可独立实例化；Plan 可被提交层消费 | 接口单测 |
| C2 | `BalanceStrategy` 迁移：现有 decide_actions 全逻辑（采集/交付/巡逻/战斗/生产/Beacon）+ 38 例测试迁移到新结构 | P0 | L | C1, B2 | 测试全绿；确定性不变；参数从 config 读 | 38+ 例全过 |

### Batch 4 — 决策内核 II（状态机）+ 调试接口

| ID | 任务 | 优先级 | 工作量 | 依赖 | 验收标准 | 测试预期 |
|---|---|---|---|---|---|---|
| C3 | 全局阶段状态机：EARLY_EXPANSION → BALANCED → MILITARY，按资源/人口/敌人威胁自动切换，阈值可配置 | P1 | M | C2 | 阶段转移规则单测；默认从 EARLY 启动 | 转移单测 |
| C4 | 单元状态机：Worker（PATROL→GO_HARVEST→HARVEST→RETURN→DEPOSIT→PATROL，HARVEST_FAILED/RESOURCE_DEPLETED 重定向）；战斗单位（CHASE/GUARD/FIRE）；状态存于 world 记忆 | P1 | L | C2, B2 | Fake 序列测试覆盖完整转移链与失败重试 | 状态机序列测试 |
| D1 | `debug_api.py`：HTTP 127.0.0.1 调试端点——GET /state（全状态含记忆）、GET /strategies（阶段/参数）、POST /command（白名单指令：pause/resume/set_phase/set_param/order） | P0 | M | B1, B3, C2 | curl 可查状态；指令生效；非法指令拒绝 | 端点单测（不绑端口） |

### Batch 5 — 集成与切换

| ID | 任务 | 优先级 | 工作量 | 依赖 | 验收标准 | 测试预期 |
|---|---|---|---|---|---|---|
| D2 | `main.py`：连接循环 + 决策 + 日志 + 调试端点 + Ctrl-C 优雅退出 + 阶段机挂载 | P0 | M | C3, C4, D1 | 无凭据下 dry-run 可跑通决策链 | 集成冒烟测试 |
| E1 | 全量验证：uv run pytest + 新旧决策对比（同一合成 Turn 输出一致） | P0 | M | D2 | 对比脚本输出一致；全部测试绿 | 对比测试 |
| E2 | 线上切换：停旧 tactic.py 进程 → `uv run` 新入口 → 观察日志与提交 | P0 | S | E1 | 新进程 accepted=True 连续稳定 | 线上观察记录 |
| E3 | 文档收尾：CLAUDE.md/README 更新 + docs/archives/ 归档 + 阶段机架构文档 | P1 | S | E2 | 文档与代码一致 | N/A（文档任务） |

## 批次理由

- Batch 1-5 严格按依赖链；每批一个 git 提交组，单批可独立回滚
- Batch 4 合并状态机与调试接口：两者共享 world 记忆与策略查询，拆开会产生文件重叠
- Batch 5 的最后切换动作需要线上观察窗口，单列为批
