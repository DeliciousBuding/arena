# PARITY — Rust 版与 Go 版（oracle）的有意差异登记

> 规则：任何与 Go `go-rewrite` 版行为/输出不一致的地方必须在此登记，
> 附理由与豁免范围。未登记差异 = 未通过。差分门禁全绿后本节内容即
> 为两份实现间差异的完整记录。

## 1. 集合/映射使用 BTree 结构（确定性迭代）

- Go：`map[string]struct{}` / `map[Position]struct{}`，迭代序随机化；
  Go 版 refill 源码注释自认"超配额 chunk 时 map 迭代序导致评分漂移"。
- Rust：`BTreeSet<String>`（cell-key 集合）/ `BTreeMap<String, _>`（plan
  actions、latent 池），迭代恒为键升序。
- 影响：Rust 输出完全确定；Go 版在 refill 配额内恢复时若存在不确定行为，
  差分以 Go 的**意图语义**（坐标排序恢复）为准。
- 豁免：无（这是改进，不是偏差；差分 runner 对 refill 场景需要 Go 侧
  同样排序——见差分工具说明）。

## 2. 数值类型 i32 vs Go int

- 值域：坐标 ≤ 1000、资源/人口 ≤ 10^5 级，i32 无溢出风险。
- 豁免：无。

## 3. settle_in_place API 形状

- Go `SettleInPlace` 返回 `SettleResult{NextState: 同一 state 指针}`；
  Rust `settle_in_place` 返回 `(Vec<Event>, SettleStats)`，修改后的状态
  即传入的 `&mut state`。语义等价（无每 tick 深拷贝）。
- 豁免：API 层，非行为差异。

## 4. 闭枚举替代运行时校验

- Go `ValidDirection/ValidUnitType` 等运行时校验；Rust `Direction/UnitType`
  为闭枚举，非法值编译期不可表示。Go 版对非法输入的路径（如
  SPAWN_UNSUPPORTED）在 Rust 中不存在。
- 豁免：不可达路径。

## 5. Event.event_id 恒为空串

- 与 Go 版一致（引擎构造事件不填 EventID；Go 同样恒空）。

## 6. Go oracle 修正项（差分前必须落地）

- Go `internal/sim/refill.go` 的 byChunk map 迭代（见 §1）在差分前按
  坐标排序修正为确定性实现，否则差分在超配额场景不可复现。
- Go `internal/sim/batch.go` 的 `policyName → PolicyName` 重命名重构
  完成后才能作为 oracle 基准。

## 7. 场景 JSON 字段名大小写

- 现网场景文件（`runtime/scenes/*.json`）为 **PascalCase 大写字段**
  （`"ID"/"HP"/"Tick"/"UnitType"`），Go 因 encoding/json case-insensitive
  解析掩盖；serde 是 case-sensitive。Rust 侧 `contracts.rs` 用
  `rename_all = "PascalCase"` + 对 `ID/HP/CarrierID` 全大写字段显式
  alias（serde PascalCase 会转成 `Id/Hp/CarrierId`，不 alias 则解析为
  空/默认值——曾导致初始单位 ID 丢失、planner patrol 键冲突、
  经济产出减半；已修复并加测试）。
- 豁免：无（契约兼容性修复）。

## 8. 随机序列（simsearch/optsearch）

- Go `math/rand`（v1 算法）序列与 Rust 自研 `SplitMix64` 不共用——
  simsearch/optsearch 的随机生成只保证 **Rust 内部确定性**（同 seed
  同输出），不与 Go 输出逐字节对齐（随机场景生成是探索工具，非契约）。
- 豁免：探索工具输出，非差分目标。

## 9. 基准同步：Go fork 后新增螺旋扫描巡逻

- rust-sim fork 于 go-rewrite `b72ff3c`；Go 之后新增 3 个提交
  （`c10f2d6` 文档、`6e389fb` nav fast-path + **planner 螺旋扫描带
  巡逻**、`ab1b68a` golden 刷新）。Rust 已同步语义变更：
  - `nextSpiralTarget`（patrol_scan_radius：4+6*ring，>46 重置 4；
    patrol_angle_step：max(1, floor(36/radius))；64 方位角 spiralPoint）
    替代旧八方位 nextPatrolTarget；patrol/starvedPatrol 统一走螺旋。
  - Go nav.go 的 axial fast-path（L 形无墙直接返回主轴方向）**未移植**
    ——fast-path 语义保证与 BFS 结果一致，Rust 的 stamped BFS 已是
    真值（性能已 12x，无需加速路径）。
- 差分结果（500 tick golden，Go HEAD vs Rust）：dense 逐字段一致；
  base/sparse 的 deposits/spawns/workers 容差内（±6%）；blocked 残余
  个位数差异（base 3→8、sparse 0→7，早期 50 tick 逐字节一致，差异
  出现在 refill 长程演化后，来源疑为 Go map 迭代随机性，见 §1）。
- 豁免：nav fast-path（性能等价优化）。
