//! 工具函数（从 go-rewrite `internal/sim/util.go` 移植）。

use arena_sim_domain::TickState;

/// 深拷贝 TickState（集合/切片独立副本，避免别名共享）。
pub fn clone_state(state: &TickState) -> TickState {
    state.clone()
}

/// 按 Units 重建分列（Workers/Vanguards/Rangers），保持 Units 的既有顺序
/// （reduce 语义：按 ID 升序）。
pub fn rebuild_columns(state: &mut TickState) {
    state.workers.clear();
    state.vanguards.clear();
    state.rangers.clear();
    for unit in &state.units {
        match unit.unit_type {
            arena_sim_domain::UnitType::Worker => state.workers.push(unit.clone()),
            arena_sim_domain::UnitType::Vanguard => state.vanguards.push(unit.clone()),
            arena_sim_domain::UnitType::Ranger => state.rangers.push(unit.clone()),
        }
    }
}
