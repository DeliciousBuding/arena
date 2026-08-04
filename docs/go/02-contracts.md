# 契约层（02）

> 状态：设计定稿。契约是 Go 版与服务器、与 TS 版、与未来数据平台之间的唯一事实源。

## 1. 契约来源与黄金文件

| 契约 | 黄金文件（只读数据） | 用途 |
|---|---|---|
| `arena_plan` 工具协议 | `contracts/arena-plan.schema.json` | LLM 候选计划 JSON（actions/core/reason） |
| `arena_map` 工具协议 | `contracts/world-query.schema.json` | 地图查询 JSON |
| 差分回放 manifest | `contracts/differential/manifest-v1.schema.json` | fixture 元数据（规则/SDK 版本、脱敏声明） |
| 差分回放 record | `contracts/differential/record-v1.schema.json` | fixture 单 tick raw-state 记录 |
| 服务器 wire 协议 | hero SDK（`packages/arena-hero-ts` 已随基线删除；以 fixture 与官方 SDK 文档为参照） | WS 消息 / Turn / submit |

**处理原则**：

1. JSON Schema 黄金文件**只读不生成**（TS 版 TypeBox 已退役，Go 版不重建生成链）；
2. Go 版以 `internal/contracts/` 手写 Go 结构体 + 手写 JSON 编解码与校验
   （`encoding/json` + 显式字段校验函数），并以**黄金文件对齐测试**守护：
   对每条 schema 的合法/非法样例做往返序列化断言（样例由 Go 版建立并冻结）；
3. `internal/contracts` 是唯一允许手写 wire 结构的地方；领域层不得直接 import
   `encoding/json`（经 `contracts` 转换），保证 wire 与 domain 解耦；
4. fixture 记录以 `differential/record-v1.schema.json` 为结构基准，
   `internal/domain` 的 reducer 输入直接来自该结构。

## 2. 分层结构

```text
internal/contracts/
├── wire/       服务器 WS 原始消息（turn 事件、提交回执）——字节级兼容
├── domain/     规范化 TickState / Unit / Plan（内部表示，reducer 输出）
└── decision/   arena_plan / arena_map 工具请求响应（LLM 接口）
```

- `wire → domain` 转换在 `internal/domain` 的 reducer（`state-reducer.go`）中完成；
- `domain → decision` 的 plan 序列化在 `internal/agent/harness` 中完成；
- 每个包自带 `golden_test.go`：黄金样例往返 + schema 字段存在性断言。

## 3. 关键类型（从 schema/fixture 提取，Go 表示）

### arena_plan（决策候选计划）

```go
type Plan struct {
    Actions []UnitAction   `json:"actions"`            // 每个可控单位至多一个
    Core    *CoreAction    `json:"core,omitempty"`     // null = 无 Core 动作
    Reason  string         `json:"reason,omitempty"`   // 一句话理由（遥测）
}

type UnitAction struct {
    Unit         string       `json:"unit"`                    // 单位 UUID
    Kind         ActionKind   `json:"kind"`                    // MOVE/SWEEP/SHOOT/HARVEST/DEPOSIT/HEAL/PICKUP_BEACON/DROP_BEACON/SELF_DESTRUCT/WAIT
    Direction    *Direction   `json:"direction,omitempty"`     // MOVE/SWEEP 需要
    TargetID     *string      `json:"target_id,omitempty"`     // SHOOT 需要
    ExpectedCell *[2]int      `json:"expected_cell,omitempty"` // 单元格坐标
}

type CoreAction struct {
    Kind     CoreActionKind `json:"kind"` // SPAWN/HEAL/REPAIR_SHIELD/WAIT
    UnitType *UnitType      `json:"unit_type,omitempty"` // SPAWN 需要
}
```

### 规范化 TickState（reducer 输出，immutable）

从 fixture raw-state（`status/respawn_at_tick/resources/population/population_tier/upkeep_next_tick/champion_beacon/objects/events`）
归约为 TS 版 `TickState` 同构结构：core、units（workers/vanguards/rangers 分列）、
visibleEnemies、resourceCells、beacon、tick、resources、resourceCapacity 等。
**字段名与 TS 版一致**，reducer 输出经 fixture 回放测试逐字段比对（期望值来自
TS 版已冻结的 100-tick 回放结果，见 04）。

### 差分 fixture record（输入）

```go
type DifferentialRecord struct {
    Status          string      `json:"status"`
    RespawnAtTick   *int        `json:"respawn_at_tick"`
    Resources       int         `json:"resources"`
    Population      int         `json:"population"`
    PopulationTier  int         `json:"population_tier"`
    UpkeepNextTick  int         `json:"upkeep_next_tick"`
    ChampionBeacon  *Beacon     `json:"champion_beacon"`
    Objects         []Object    `json:"objects"`   // OBSTACLE/CORE/UNIT/RESOURCE/…
    Events          []Event     `json:"events"`    // 结算事件（可用于校验模拟器）
}
```

## 4. 契约冻结策略

- 所有 Go 结构体的 JSON 标签与 TS 版序列化**完全一致**（字段名、顺序、omitempty 语义）；
- 新增字段必须同时：更新 Go 结构体 + 更新黄金对齐测试样例 + 在 `02-contracts.md` 记变更；
- 服务器协议升级（新事件类型/新字段）→ 在 `internal/contracts/wire` 加宽松字段
  （未知字段保留原始 JSON 供调试，不阻断解析），再经 fixture 验证后冻结；
- 契约变更走 PR 审查（L3 必审）。
