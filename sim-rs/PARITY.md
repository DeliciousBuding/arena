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
