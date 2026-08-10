# Differential Record v1 — W3 差分回放契约（冻结 2026-08-02，v1.0.1 勘误）

> **状态：已冻结（v1.0.1）。** E1/E2（Python/TS 回放器）与 E3（差分比较器）的输出/输入协议。
> 修改契约必须先更新本文件并通知所有消费方（E1/E2/E3 + 2A fixture manifest）。
> 背景：E1/E2（Python/TS 回放器）与 E3（差分比较器）的输出/输入协议，见下方各节。
> v1.0.1 勘误：hash 魔法字符串 "none" → null；UUID 描述澄清；"逐字节一致"改为 canonicalization 语义；记录句法示例修正。
> 机器可验证 Schema：`contracts/differential/record-v1.schema.json`、`manifest-v1.schema.json`（**契约的机器部分，人工文档只作说明**）。
> 当前定位：这是 **2026-08-02 冻结的 legacy 迁移 fixture**，用于保护 reducer/state/metadata/协议兼容性；它不要求当前策略逐 MOVE 复刻旧 planner。已知策略差异只能通过带 `dataset_id/tenant_id/segment_id/tick` 范围和非空 reason 的有界白名单放行。

## 每 Tick 输出结构（JSONL，一行一个 Tick）

```json
{
  "protocol_version": 1,
  "dataset_id": "burnin-20260802-a",
  "tenant_id": "demo-001",
  "segment_id": "demo-001",
  "tick": 40123,
  "input_sha256": "sha256:325a40c00e40ad07a592b535d27130266017000fe0216372961a99bbb808b3fd",
  "config_hash": "sha256:1f6b2c0d4e8a9b3c5d7e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c",
  "map_snapshot_hash": null,
  "state": {
    "resources": 4,
    "population": 2,
    "resource_capacity": 10,
    "resource_space": 6,
    "core": {"id": "c1", "position": [119, 109], "hp": 5, "shield": 5, "state": "NORMAL"},
    "units": [{"id": "u1", "position": [120, 107], "hp": 2, "cargo": 1, "unit_type": "WORKER"}],
    "enemies": [{"id": "e1", "position": [10, 10], "unit_type": "VANGUARD"}],
    "resource_cells": [[116, 108]],
    "obstacle_cells": [[116, 109]],
    "beacon": {"position": [-22, 67], "status": null, "carrier_id": null}
  },
  "phase": "early_expansion",
  "memory": {
    "resources": {"116,108": {"state": "visible", "first_seen_tick": 40100}},
    "enemies": {"e1": {"last_seen_tick": 40123, "position": [10, 10]}},
    "units": {"u1": {"mode": "PATROL"}}
  },
  "intents": {"u1": "explore"},
  "plan": {
    "unit_actions": {"u1": {"type": "MOVE", "direction": "UP"}},
    "core_action": {"type": "SPAWN", "unit_type": "WORKER"}
  },
  "map_mode": "disabled"
}
```

## 规范化规则（必须逐条遵守）

1. **UUID**：保留完整 UUID 内容，字母统一为小写，不截断、不重新生成。
2. **positions**：统一 `[x, y]`（数组，不写 tuple/对象）。
3. **enum**：统一字符串值（如 `"WORKER"`、`"NORMAL"`、`"early_expansion"`），不写枚举对象。
4. **稳定排序**：`units`/`enemies` 按 id 字典序；`resource_cells`/`obstacle_cells` 排序后输出（字典序）；`memory` 的 key 排序后输出。
5. **null 与缺失不得混用**：语义上"无"一律 `null`（如 `core: null`、`core_action: null`）；字段缺失视为差异。不存在可选字段时输出 `null`，不要省略 key。
6. **JSON key 顺序不参与语义比较**：比较器按 key 语义对齐（解析后比较规范化语义树），不比较字面顺序。
7. **浮点**：当前协议不应出现浮点；若出现视为差异（记录但不 crash）。
8. **MapStore 模式**：每行显式 `map_mode`：`disabled`（无共享地图）/ `frozen`（固定快照）/ `controlled`（manifest 定义的有序更新）。第一版只用 `disabled`。
9. **hash 字段**：有值时统一 `sha256:<64 位小写 hex>`（如 `sha256:325a...`）；不可用时一律 `null`。**禁止魔法字符串**（如 "none"/"N/A"）。
10. **state 一致性口径**：state 维度要求两边**经过 canonicalization 后字节一致**；比较器本身比较解析后的规范化语义树，不比较原始 JSONL 字节。

## 跨 gap 规则（重要）

- manifest 的 tick 序列按**连续 segment** 组织（每 segment 内部严格连续）。
- **每个 segment 开头重建 World、PhaseMachine、Planner**；不跨 gap 延续记忆。
- E3 不比较跨 segment 的 memory continuity（segments 之间天然不可比）。
- record 携带 `segment_id`，回放顺序以 manifest 的 segments 为准（不依赖文件系统枚举顺序）。

## 四维对比口径（E3 按此分类）

| 维度 | 字段 | 级别 | 说明 |
|------|------|------|------|
| state | `state.*` | **硬** | 纯当前 Tick 事实，canonicalization 后应字节一致；不一致 = reducer bug，exit 1 |
| memory | `memory.*` | 软 | 跨 Tick 记忆演化；差异分类（world_memory）允许解释后白名单 |
| phase | `phase` | 软 | 阶段机；差异分类（phase） |
| intent | `intents` | 软 | 单位意图；差异分类（intent） |
| plan | `plan.*` | 核心 | 决策输出；差异分类（plan_*） |

## fixture manifest（2A 产出）与 record 的关系

- `manifest.inputs[tick].sha256` == record 的 `input_sha256`（都是**脱敏后**文件内容的 sha256，统一 `sha256:<hex>` 前缀格式）
- record 的 `dataset_id`/`tenant_id`/`segment_id` 来自 manifest
- record 的 tick 序列由 manifest 的 segments 驱动
- **config 单源**：manifest 携带 `decision_config`（规范化 JSON 对象，见 `manifest-v1.schema.json`）；`config_hash` 基于 manifest 中 decision_config 的 canonical JSON 计算。两端（Python/TS runner）必须从 manifest 读取同一对象转换为本语言配置，**不得各自读默认值**。

## 退出码约定（E3）

- state 硬错误 > 0 → exit 1（任何白名单都不得覆盖硬错误）
- 其余差异：报告分类计数，不挡退出码（白名单内的差异标 `whitelisted`）
- 未解释差异（unexplained）非零 → exit 1；白名单必须同时匹配复合 record key、类别、路径与差异形态，且不得覆盖硬差异

## 与资源效率评测的边界（职责分离）

- Differential Record v1 **只用于冻结迁移证据的兼容性保护**：state/metadata/协议仍要求严格一致；当前策略的路径与收益正确性不由 legacy Python 决定。
- 当前策略语义由 deterministic 单测 + Digital Twin 校准/soak 证明，晋级由严格 live burn-in 证明；策略效果评测见独立的 Efficiency Trace v1。
- 反事实警告：固定历史 raw-state 序列由历史真实行动产生，不能用来评价不同计划的长期收益（拿 MOVE RIGHT 的结果评估 MOVE LEFT 的历史是反事实污染）。

