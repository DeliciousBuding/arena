//! 移动结算（从 go-rewrite `internal/sim/movement.go` 移植）。

use arena_sim_domain::{cell_key, move_position, Event, Position, TickState, UnitAction};

use crate::SettleStats;

/// 模拟地图边界（坐标绝对值上限，超出禁止移动）。
pub const WORLD_BOUND: i32 = 1000;

/// 应用单个 MOVE 动作：障碍/边界/冲突阻挡时不移动。
/// 返回 (已移动, 阻挡原因)；未移动且未阻挡时返回 (false, None)（如原地）。
pub fn apply_move(
    state: &mut TickState,
    unit_id: &str,
    action: &UnitAction,
    stats: &mut SettleStats,
) -> (bool, Option<String>) {
    let Some(unit_index) = state.units.iter().position(|u| u.id == unit_id) else {
        return (false, None);
    };
    let Some(direction) = action.direction else {
        return (false, None);
    };
    let next = move_position(state.units[unit_index].position, direction);

    if state.obstacle_cells.contains(&cell_key(next[0], next[1])) {
        stats.blocked += 1;
        return (false, Some("MOVE_BLOCKED_OBSTACLE".to_string()));
    }
    if next[0] < -WORLD_BOUND || next[0] > WORLD_BOUND || next[1] < -WORLD_BOUND || next[1] > WORLD_BOUND {
        stats.blocked += 1;
        return (false, Some("MOVE_BLOCKED_BOUNDARY".to_string()));
    }
    if occupied_by_other(state, unit_id, next) {
        stats.blocked += 1;
        return (false, Some("MOVE_BLOCKED_OCCUPIED".to_string()));
    }

    state.units[unit_index].position = next;
    stats.moves += 1;
    (true, None)
}

/// 报告目标格是否被其他己方单位占据（按计划顺序依次移动，
/// 已移动单位占据新格视为占用）。
fn occupied_by_other(state: &TickState, unit_id: &str, cell: Position) -> bool {
    state.units.iter().any(|other| other.id != unit_id && other.position == cell)
}

/// 构造移动结算事件（方向或阻挡原因二选一）。
pub fn move_event(
    tick: i32,
    unit_id: &str,
    direction: Option<arena_sim_domain::Direction>,
    reason: Option<String>,
) -> Event {
    let mut event = Event {
        event_id: String::new(),
        tick,
        event_type: "MOVE".to_string(),
        reason_code: None,
        actor_id: Some(unit_id.to_string()),
        target_id: None,
        position: None,
        values: Default::default(),
    };
    if let Some(reason) = reason {
        event.event_type = "MOVE_BLOCKED".to_string();
        event.reason_code = Some(reason);
    } else if let Some(direction) = direction {
        event
            .values
            .insert("direction".to_string(), serde_json::json!(direction.as_str()));
    }
    event
}
