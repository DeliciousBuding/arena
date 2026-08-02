# TS 迁移方案：Python 决策层 → TS 编排层

> 状态：进行中（2026-08-02）。SDK 层完成；编排层迁移按本方案推进。
> 审阅者：外部 GPT（ChatGPT Web，经 GitHub 仓库审阅）。

## 1. 为什么迁移

当前架构 = **Python 决策层 + pi RPC 桥**：

```
[Python 决策层 arena_bot] --stdin/stdout JSONL RPC--> [pi CLI 子进程]
    权威 TickState / 规则校验 / deadline / submit        LLM 决策大脑
```

RPC 桥是最大维护痛点（外部审阅 P0 确认）：
- 超时杀进程重启 → 丢 session 上下文、epoch 旋转、放大网络抖动
- 串 tick 风险 → 需要 call_id 合并、事件队列清空等补偿逻辑
- 无法用 pi 原生 `abort`/compaction/session lifecycle

pi-coding-agent 本身是**嵌入库设计**（`createAgentSession()` 公开 SDK，见
`pi/packages/coding-agent/src/core/sdk.ts`），TS 编排层可直接嵌入——RPC 桥消失。

另外 schema 三份实现（JSON Schema + TypeBox + Python parser）→ TS 后收敛为 TypeBox 一份。

## 2. 目标架构

```
[TS 编排层 @arena/arena-agent]（每租户一进程）
    ├── arena-hero-ts（游戏客户端，fork 自上游 Python SDK）
    ├── MapStore（node:sqlite，WAL 多进程共享）
    ├── 策略/状态机/遥测/supervisor（纯逻辑移植）
    └── pi-coding-agent 直接嵌入（createAgentSession + abort）
```

- 多租户隔离模型不变：4 账号 = 4 个独立 node 进程
- pi-arena 扩展保留（registerTool 工具定义），system context/rules 迁入
- schema 单源：TypeBox（packages/pi-arena 现有）→ Python parser 删除

## 3. 仓库布局

| 仓库 | 路径 | 内容 |
|------|------|------|
| arena（private） | `[arena-repo]` | 编排层 `packages/arena-agent/` + 扩展 `packages/pi-arena/` + Python 旧版 `src/arena_bot/`（迁移完成前保留运行） |
| arena-hero-ts（public fork） | `[arena-hero-ts-repo]` | fork 自 arena-hero/arena-hero-python；上游 Python 保留 `src/`（可 merge），TS 实现 `packages/arena-hero-ts/` |
| pi（private fork） | `[pi-repo]` | pi 本体（上游化通用修复；无 Arena 业务） |

## 4. 已完成（稳定基线）

### 4.1 arena-hero-ts SDK（✅ 真机验证通过）

- `packages/arena-hero-ts/`：enums/geometry/rules/errors/types/actions/protocol/client/turn，2045 行
- 协议与上游逐字节兼容：`encodePlan`（sort_keys + exclude_none + 紧凑）已用
  Python `json.dumps` 交叉验证 MATCH
- 真机只读验证：WS 连接 1.16s → tick 39555 → Turn 解析（4 workers/Core owner）✓
- 16 测试（node:test）+ tsc 严格模式全绿
- 唯一运行时依赖 `ws`（Node 内置 WebSocket 不支持认证 header）

### 4.2 MapStore TS 移植（✅ 测试通过）

- `packages/arena-agent/src/map-store.ts`：node:sqlite 同步 API
- 完整继承 Python 版语义：WAL、BEGIN IMMEDIATE + 重试、revision 增量游标、
  P0-A（仅有效 mutation bump revision）
- 8 测试全过（含 4 子进程并发写 160 cells 无锁冲突）
- 进程内单线程 → 无 RLock（node 同步 API 天然串行）

### 4.3 Python 侧稳定（继续运行 4 租户 burn-in）

- P0-4 全 Tick 遥测 JSONL（outcome 分布：submitted/paused/empty/tick_mismatch/error）
- P0-A revision 只在有效 mutation 时递增
- 135 测试全绿；4 租户稳定运行中（tick ~39500+）

## 5. 待做工作包（迁移顺序）

> 依赖：SDK（✅）→ 编排层核心 → 决策桥（依赖 spike-embed 结果）→ supervisor

| # | 包 | 内容 | 依赖 | 验收 |
|---|-----|------|------|------|
| W1 | TickState + 游戏循环 | `turn` 事件 → TickState 类型（TS 版 core/state）→ phase machine | SDK | `node --test`；对照 Python 135 测试语义 |
| W2 | 策略（balance/aggressive/economic） | 状态机移植（worker 状态机、巡逻、目标记忆） | W1 | 单测；与 Python 策略输出对照 |
| W3 | Telemetry + DebugServer | JSONL 遥测 + node http 调试端点（/state /command /map/query） | W1 | 单测；curl 端点 |
| W4 | LLM 决策桥（核心） | createAgentSession 嵌入；每 tick 一次 prompt；soft deadline → `session.abort()`；hedged safety plan | spike-embed 结果 + W1/W2 | 嵌入 demo 跑通；abort 复用 session |
| W5 | Supervisor + run manifest | 4 租户进程管理（readiness/health/优雅停机）+ 实验 manifest.json | W1-W4 | 4 进程启动/停止无孤儿 |
| W6 | schema 单源 | TypeBox 一份（pi-arena 现有）→ 删除 Python parser/JSON Schema 重复 | W4 | tsc + 协议测试 |

## 6. 风险与注意

1. **SDK 协议面耦合**：上游 changelog（v0.11 upkeep 等）→ fork 内手动同步 TS 实现；
   上游 Python 保留可 merge，冲突面隔离在 `src/`
2. **Node 内置 WebSocket 无 header 支持**：认证必须 `ws` 包（已处理）
3. **spike-embed 验证中**：createAgentSession 的嵌入/abort 行为是 W4 前提
   （若 abort 语义不符，W4 降级为 RPC 桥 + abort 命令）
4. **burn-in 期间双轨**：Python 版继续跑实验直到 TS 编排层通过真机观察
5. **15s 决策窗口**：deadline 预算（ask(timeout)）在 TS async 下保持硬截止

## 7. 当前运行状态（2026-08-02 19:50）

- 4 租户 burn-in 运行中（exp-llm-4：t1 economic / t2 aggressive / t3/t4 standard）
- 共享地图 revision 已稳定（P0-A 生效）
- Python 测试 135 全绿；arena-hero-ts 16 全绿；arena-agent MapStore 8 全绿
