//! 经济活动结算（从 go-rewrite `internal/sim/economy.go` 移植）。

use arena_sim_domain::{cell_key, Event, TickState, UnitType};

use crate::refill::RefillConfig;
use crate::SettleStats;

/// 结算 HARVEST 动作：worker 必须站在可见资源格上，成功 +1 cargo
/// （每 tick 至多 1）。服务器语义：采空格立即消失（refill 挂载时
/// 标记 mined，4 tick 配额补满后恢复）。
pub fn apply_harvests(
    state: &mut TickState,
    worker_ids: &[String],
    stats: &mut SettleStats,
    mut refill: Option<&mut RefillConfig>,
) -> Vec<Event> {
    let mut events = Vec::with_capacity(worker_ids.len());
    for unit_id in worker_ids {
        let Some(unit_index) = state.units.iter().position(|u| u.id == *unit_id) else {
            continue;
        };
        if state.units[unit_index].unit_type != UnitType::Worker {
            continue;
        }
        let position = state.units[unit_index].position;
        if !state
            .resource_cells
            .contains(&cell_key(position[0], position[1]))
        {
            events.push(harvest_event(
                state.tick,
                unit_id,
                Some("HARVEST_FAILED_NO_RESOURCE"),
            ));
            continue;
        }
        state.units[unit_index].cargo += 1;
        stats.harvests += 1;
        // 采空格立即消失（官方规则；refill 由引擎挂载时补回）。
        state
            .resource_cells
            .remove(&cell_key(position[0], position[1]));
        if let Some(ref mut refill) = refill {
            refill.mark_mined(position);
        }
        events.push(harvest_event(state.tick, unit_id, None));
    }
    events
}

/// 结算 DEPOSIT 动作：worker 带 cargo 且站在 Core 格，资源入仓并遵守
/// 容量上限（超出部分丢弃并记 REJECTED）。
pub fn apply_deposits(
    state: &mut TickState,
    worker_ids: &[String],
    stats: &mut SettleStats,
) -> Vec<Event> {
    let mut events = Vec::with_capacity(worker_ids.len());
    for unit_id in worker_ids {
        let Some(unit_index) = state.units.iter().position(|u| u.id == *unit_id) else {
            continue;
        };
        if state.units[unit_index].unit_type != UnitType::Worker
            || state.units[unit_index].cargo <= 0
        {
            continue;
        }
        let Some(core_position) = state.core.as_ref().map(|core| core.position) else {
            events.push(deposit_event(
                state.tick,
                unit_id,
                Some("DEPOSIT_FAILED_NOT_AT_CORE"),
            ));
            continue;
        };
        if state.units[unit_index].position != core_position {
            events.push(deposit_event(
                state.tick,
                unit_id,
                Some("DEPOSIT_FAILED_NOT_AT_CORE"),
            ));
            continue;
        }
        let mut accepted = state.units[unit_index].cargo;
        let overflow = state.resources + accepted - state.resource_capacity;
        if overflow > 0 {
            accepted -= overflow;
            events.push(deposit_event(
                state.tick,
                unit_id,
                Some("DEPOSIT_REJECTED_CAPACITY"),
            ));
        }
        if accepted > 0 {
            state.resources += accepted;
            stats.resource_delta += accepted;
            stats.deposits += 1;
        }
        state.units[unit_index].cargo -= accepted;
    }
    events
}

/// 构造采集事件（reason 为 None 表示成功；否则 EventType 替换为 reason）。
fn harvest_event(tick: i32, unit_id: &str, reason: Option<&str>) -> Event {
    Event {
        event_id: String::new(),
        tick,
        event_type: reason.unwrap_or("HARVEST").to_string(),
        reason_code: None,
        actor_id: Some(unit_id.to_string()),
        target_id: None,
        position: None,
        values: Default::default(),
    }
}

/// 构造存款事件（reason 为 None 表示成功；否则 EventType 替换为 reason）。
fn deposit_event(tick: i32, unit_id: &str, reason: Option<&str>) -> Event {
    Event {
        event_id: String::new(),
        tick,
        event_type: reason.unwrap_or("DEPOSIT").to_string(),
        reason_code: None,
        actor_id: Some(unit_id.to_string()),
        target_id: None,
        position: None,
        values: Default::default(),
    }
}
