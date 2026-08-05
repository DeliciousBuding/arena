//! 视野规则（从 go-rewrite `internal/sim/vision.go` 移植）。
//!
//! 官方 v0.13：玩家视野 = 所有存活己方对象的视野并集。
//! Worker 半径 3、Core 半径 5、Vanguard 半径 4、Ranger 半径 5。

use arena_sim_domain::{Position, TickState, UnitType};

/// 返回单位类型的视野半径（官方数值）。
pub fn vision_radius(unit_type: UnitType) -> i32 {
    match unit_type {
        UnitType::Worker => 3,
        UnitType::Vanguard => 4,
        UnitType::Ranger => 5,
    }
}

/// Core 的视野半径。
pub const CORE_VISION_RADIUS: i32 = 5;

/// 返回两格的 Chebyshev 距离（视野为方形区域）。
fn chebyshev_distance(a: Position, b: Position) -> i32 {
    (a[0] - b[0]).abs().max((a[1] - b[1]).abs())
}

/// 报告格 p 是否在任一己方对象（Core + 所有单位）的视野内。
/// Core 缺失时仅单位视野。
pub fn in_union_vision(state: &TickState, p: Position) -> bool {
    if let Some(core) = &state.core {
        if chebyshev_distance(p, core.position) <= CORE_VISION_RADIUS {
            return true;
        }
    }
    for unit in &state.units {
        let radius = vision_radius(unit.unit_type);
        if radius > 0 && chebyshev_distance(p, unit.position) <= radius {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use arena_sim_domain::{Beacon, BeaconStatus, Core, CoreState, CoreStatus, TickState};

    fn state_with_units(units: Vec<arena_sim_domain::UnitSnapshot>) -> TickState {
        TickState {
            tick: 1,
            status: CoreStatus::Active,
            resources: 0,
            resource_capacity: 10,
            resource_space: 10,
            population: units.len() as i32,
            population_tier: 0,
            upkeep_next_tick: 0,
            core: Some(Core {
                id: "core-1".to_string(),
                position: [0, 0],
                hp: 5,
                shield: 5,
                state: CoreState::Normal,
                owner_username: String::new(),
            }),
            units,
            workers: Vec::new(),
            vanguards: Vec::new(),
            rangers: Vec::new(),
            visible_enemies: Vec::new(),
            resource_cells: Default::default(),
            obstacle_cells: Default::default(),
            beacon: Beacon {
                position: [0, 0],
                status: BeaconStatus::Ground,
                carrier_id: None,
            },
            events: Vec::new(),
            state_hash: String::new(),
        }
    }

    #[test]
    fn vision_radii() {
        assert_eq!(vision_radius(UnitType::Worker), 3);
        assert_eq!(vision_radius(UnitType::Vanguard), 4);
        assert_eq!(vision_radius(UnitType::Ranger), 5);
        assert_eq!(CORE_VISION_RADIUS, 5);
    }

    #[test]
    fn union_vision_core_and_units() {
        let state = state_with_units(vec![arena_sim_domain::UnitSnapshot {
            id: "worker-1".to_string(),
            position: [10, 0],
            hp: 2,
            unit_type: UnitType::Worker,
            cargo: 0,
        }]);
        // Core 视野 5 格内可见。
        assert!(in_union_vision(&state, [5, 0]));
        // 单位视野：worker 半径 3 → (10,0)±3。
        assert!(in_union_vision(&state, [13, 0]));
        assert!(!in_union_vision(&state, [14, 0]));
        assert!(!in_union_vision(&state, [6, 0]));
    }
}
