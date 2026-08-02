# Differential Record v1 — W3 差分回放契约（冻结 2026-08-02）

> **状态：已冻结。** E1/E2（Python/TS 回放器）与 E3（差分比较器）的输出/输入协议。
> 修改契约必须先更新本文件并通知所有消费方（E1/E2/E3 + 2A fixture manifest）。
> 背景与完整规划见 `docs/architecture-review-gpt-2026-08-02.md` 切片 2。

## 每 Tick 输出结构（JSONL，一行一个 Tick）

```json
{
  "protocol_version": 1,
  "dataset_id": "burnin-20260802-a",
  "tenant_id": "t1",
  "tick": 40123,
  "input_sha256": "<脱敏后输入的 sha256，与 fixture manifest.inputs 一致>",
  "config_hash": "<决策配置的确定性 hash；未接入时 "none">",
  "map_snapshot_hash": "<MapStore 快照 hash；map_mode=disabled 时 "none">",
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
    "resources": {"116,108": {"state": "known", "first_seen_tick": 40100}},
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

1. **UUID**：小写字符串，原样保留（不裁剪、不重排）。
2. **positions**：统一 `[x, y]`（数组，不写 tuple/对象）。
3. **enum**：统一字符串值（如 `"WORKER"`、`"NORMAL"`、`"early_expansion"`），不写枚举对象。
4. **稳定排序**：`units`/`enemies` 按 id 字典序；`resource_cells`/`obstacle_cells` 排序后输出（字典序）；`memory` 的 key 排序后输出。
5. **null 与缺失不得混用**：语义上"无"一律 `null`（如 `core: null`、`core_action: null`）；字段缺失视为差异。不存在可选字段时输出 `null`，不要省略 key。
6. **JSON key 顺序不参与语义比较**：比较器按 key 语义对齐，不比较字面顺序。
7. **浮点**：当前协议不应出现浮点；若出现视为差异（记录但不 crash）。
8. **MapStore 模式**：每行显式 `map_mode`：`disabled`（无共享地图）/ `frozen`（固定快照）/ `controlled`（manifest 定义的有序更新）。第一版只用 `disabled`。

## 四维对比口径（E3 按此分类）

| 维度 | 字段 | 级别 | 说明 |
|------|------|------|------|
| state | `state.*` | **硬** | 纯当前 Tick 事实，两边应逐字节一致；不一致 = reducer bug，exit 1 |
| memory | `memory.*` | 软 | 跨 Tick 记忆演化；差异分类（world_memory）允许解释后白名单 |
| phase | `phase` | 软 | 阶段机；差异分类（phase） |
| intent | `intents` | 软 | 单位意图；差异分类（intent） |
| plan | `plan.*` | 核心 | 决策输出；差异分类（plan_*） |

## fixture manifest（2A 产出）与 record 的关系

- `manifest.inputs[tick].sha256` == record 的 `input_sha256`（都是**脱敏后**文件内容的 sha256）
- record 的 `dataset_id`/`tenant_id` 来自 manifest
- record 的 `tick` 序列由 manifest 的 `ticks`（有序，含 gaps）驱动——**回放顺序以 manifest 为准，不依赖文件系统枚举顺序**

## 退出码约定（E3）

- state 硬错误 > 0 → exit 1（任何白名单都不得覆盖硬错误）
- 其余差异：报告分类计数，不挡退出码（白名单内的差异标 `whitelisted`）
- 未解释差异（unexplained）非零 → exit 1（W3 完成标准：零未解释语义差异）
