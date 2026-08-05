//! SPAWN 结算（从 go-rewrite `internal/sim/spawn.go` 移植）。

use arena_sim_domain::{spawn_cost, unit_max_hp, Event, TickState, UnitSnapshot, UnitType};

/// 资源容量公式（max(minCapacity, pop*capacityPerUnit)）。
const CORE_MIN_CAPACITY: i32 = 10;
const CORE_CAPACITY_PER_UNIT: i32 = 5;

/// 结算 Core 动作（SPAWN / HEAL / REPAIR_SHIELD）；action 或 Core 缺失时
/// 返回空（与 Go `applyCoreAction` 一致）。
pub fn apply_core_action(state: &mut TickState, action: Option<&arena_sim_domain::CoreAction>) -> Vec<Event> {
    let Some(action) = action else { return Vec::new() };
    if state.core.is_none() {
        return Vec::new();
    }
    match action.kind {
        arena_sim_domain::CoreActionKind::Spawn => apply_spawn(state, action),
        arena_sim_domain::CoreActionKind::Heal => crate::heal::apply_core_heal(state, action),
        arena_sim_domain::CoreActionKind::RepairShield => crate::heal::apply_core_shield_repair(state, action),
        _ => Vec::new(),
    }
}

/// 结算 SPAWN 动作（WORKER / VANGUARD / RANGER）：
/// - 占位语义（TS 版破锁）：Core 格上的满载 Worker 不阻止 SPAWN；
///   空载 Worker / Vanguard / Ranger 视为永久占位，阻止 SPAWN；
/// - 资源扣除（resources -= cost）与人口/容量刷新；
/// - 新单位出生在 Core 格（ID 确定性生成，分列按类型落位）。
pub fn apply_spawn(state: &mut TickState, action: &arena_sim_domain::CoreAction) -> Vec<Event> {
    let Some(unit_type) = action.unit_type else {
        return Vec::new();
    };
    let Some(core) = state.core.as_ref() else {
        return vec![Event {
            event_id: String::new(),
            tick: state.tick,
            event_type: "SPAWN_FAILED_NO_CORE".to_string(),
            reason_code: None,
            actor_id: None,
            target_id: None,
            position: None,
            values: Default::default(),
        }];
    };
    if let Some(occupant) = permanent_core_occupant(state) {
        return vec![Event {
            event_id: String::new(),
            tick: state.tick,
            event_type: "SPAWN_BLOCKED_CORE_OCCUPIED".to_string(),
            reason_code: None,
            actor_id: Some(occupant),
            target_id: None,
            position: None,
            values: Default::default(),
        }];
    }
    let cost = spawn_cost(unit_type);
    if state.resources < cost {
        return vec![Event {
            event_id: String::new(),
            tick: state.tick,
            event_type: "SPAWN_FAILED_INSUFFICIENT_RESOURCES".to_string(),
            reason_code: None,
            actor_id: None,
            target_id: None,
            position: None,
            values: Default::default(),
        }];
    }
    state.resources -= cost;
    let unit_id = format!("sim-{}-{}", unit_type.as_str(), state.population + 1);
    let unit = UnitSnapshot {
        id: unit_id.clone(),
        position: core.position,
        hp: unit_max_hp(unit_type),
        unit_type,
        cargo: 0,
    };
    state.units.push(unit.clone());
    match unit_type {
        UnitType::Worker => state.workers.push(unit),
        UnitType::Vanguard => state.vanguards.push(unit),
        UnitType::Ranger => state.rangers.push(unit),
    }
    state.population += 1;
    refresh_capacity(state);

    let mut values = Default::default();
    values.insert("unitType".to_string(), serde_json::json!(unit_type.as_str()));
    values.insert("cost".to_string(), serde_json::json!(cost));
    vec![Event {
        event_id: String::new(),
        tick: state.tick,
        event_type: "SPAWN".to_string(),
        reason_code: None,
        actor_id: Some(unit_id),
        target_id: None,
        position: None,
        values,
    }]
}

/// 返回 Core 格上的永久占位单位 ID；满载 Worker 让位语义下不视为
/// 永久占位（None 表示无阻挡）。
fn permanent_core_occupant(state: &TickState) -> Option<String> {
    let core_position = state.core.as_ref()?.position;
    for unit in &state.units {
        if unit.position != core_position {
            continue;
        }
        if unit.unit_type == UnitType::Worker && unit.cargo > 0 {
            continue; // 满载 Worker：本 tick 让位后 SPAWN 即可结算
        }
        return Some(unit.id.clone());
    }
    None
}

/// 按人口重算容量与剩余空间（与 domain reducer 同公式）。
fn refresh_capacity(state: &mut TickState) {
    let mut capacity = CORE_MIN_CAPACITY;
    if capacity < state.population * CORE_CAPACITY_PER_UNIT {
        capacity = state.population * CORE_CAPACITY_PER_UNIT;
    }
    state.resource_capacity = capacity;
    state.resource_space = capacity - state.resources;
}
