//! 治疗/护盾修复结算（从 go-rewrite `internal/sim/heal.go` 移植）。
//!
//! - HEAL 消耗对象完整动作，战斗伤害结算后执行；每恢复 1 HP 花费 1 资源；
//! - 单位 HEAL 必须存活且与己方静止 Core 同格（升序 ID 先结算）；
//! - REPAIR_SHIELD 恰好花费 1 资源恢复 1 盾（不超过当前盾上限）。

use arena_sim_domain::{
    unit_max_hp, Event, Plan, TickState, UnitActionKind, CORE_MAX_HP, CORE_MAX_SHIELD,
};

/// 结算单位 HEAL 动作（战斗伤害后、Core 动作前；按 ID 升序确定性顺序）。
pub fn apply_unit_heals(state: &mut TickState, plan: &Plan) -> Vec<Event> {
    let mut events = Vec::with_capacity(4);
    for (unit_id, action) in &plan.unit_actions {
        if action.kind != UnitActionKind::Heal {
            continue;
        }
        let Some(unit_index) = state.units.iter().position(|u| u.id == *unit_id) else {
            continue;
        };
        let mut event = heal_event(state.tick, unit_id, "UNIT_HEAL_FAILED");
        let Some(core) = state.core.as_ref() else {
            event.reason_code = Some("NOT_AT_OWN_CORE".to_string());
            events.push(event);
            continue;
        };
        if core.state != arena_sim_domain::CoreState::Normal {
            event.reason_code = Some("CORE_MOVING".to_string());
            events.push(event);
            continue;
        }
        if state.units[unit_index].position != core.position {
            event.reason_code = Some("NOT_AT_OWN_CORE".to_string());
            events.push(event);
            continue;
        }
        let missing = unit_max_hp(state.units[unit_index].unit_type) - state.units[unit_index].hp;
        if missing <= 0 {
            event.reason_code = Some("HP_FULL".to_string());
            events.push(event);
            continue;
        }
        // 每恢复 1 HP 花费 1 资源（受剩余资源约束）。
        let amount = missing.min(state.resources);
        if amount <= 0 {
            event.reason_code = Some("INSUFFICIENT_RESOURCES".to_string());
            events.push(event);
            continue;
        }
        state.units[unit_index].hp += amount;
        state.resources -= amount;
        let hp = state.units[unit_index].hp;
        let mut succeeded = heal_event(state.tick, unit_id, "UNIT_HEAL_SUCCEEDED");
        succeeded
            .values
            .insert("amount".to_string(), serde_json::json!(amount));
        succeeded
            .values
            .insert("hp".to_string(), serde_json::json!(hp));
        succeeded
            .values
            .insert("cost".to_string(), serde_json::json!(amount));
        events.push(succeeded);
    }
    events
}

/// 结算 Core HEAL 动作（SPAWN 之后、Core 动作内：每恢复 1 HP 花费 1 资源）。
pub fn apply_core_heal(state: &mut TickState, action: &arena_sim_domain::CoreAction) -> Vec<Event> {
    if action.kind != arena_sim_domain::CoreActionKind::Heal {
        return Vec::new();
    }
    let Some(core) = state.core.as_mut() else {
        return Vec::new();
    };
    let mut event = heal_event(state.tick, "core", "CORE_HEAL_FAILED");
    let missing = CORE_MAX_HP - core.hp;
    if missing <= 0 {
        event.reason_code = Some("HP_FULL".to_string());
        return vec![event];
    }
    let amount = missing.min(state.resources);
    if amount <= 0 {
        event.reason_code = Some("INSUFFICIENT_RESOURCES".to_string());
        return vec![event];
    }
    core.hp += amount;
    state.resources -= amount;
    let hp = core.hp;
    let mut succeeded = heal_event(state.tick, "core", "CORE_HEAL_SUCCEEDED");
    succeeded
        .values
        .insert("amount".to_string(), serde_json::json!(amount));
    succeeded
        .values
        .insert("hp".to_string(), serde_json::json!(hp));
    succeeded
        .values
        .insert("cost".to_string(), serde_json::json!(amount));
    vec![succeeded]
}

/// 结算 REPAIR_SHIELD 动作：恰好 1 资源恢复 1 盾（不超过当前盾上限）。
pub fn apply_core_shield_repair(
    state: &mut TickState,
    action: &arena_sim_domain::CoreAction,
) -> Vec<Event> {
    if action.kind != arena_sim_domain::CoreActionKind::RepairShield {
        return Vec::new();
    }
    let Some(core) = state.core.as_mut() else {
        return Vec::new();
    };
    let mut event = heal_event(state.tick, "core", "SHIELD_REPAIR_FAILED");
    if core.shield >= CORE_MAX_SHIELD {
        event.reason_code = Some("SHIELD_FULL".to_string());
        return vec![event];
    }
    if state.resources < 1 {
        event.reason_code = Some("INSUFFICIENT_RESOURCES".to_string());
        return vec![event];
    }
    core.shield += 1;
    state.resources -= 1;
    let shield = core.shield;
    let mut succeeded = heal_event(state.tick, "core", "CORE_SHIELD_REPAIRED");
    succeeded
        .values
        .insert("shield".to_string(), serde_json::json!(shield));
    succeeded
        .values
        .insert("cost".to_string(), serde_json::json!(1));
    vec![succeeded]
}

/// 构造治疗/修复事件（成功带 amount/hp/cost；失败带 reason）。
fn heal_event(tick: i32, actor_id: &str, event_type: &str) -> Event {
    Event {
        event_id: String::new(),
        tick,
        event_type: event_type.to_string(),
        reason_code: None,
        actor_id: Some(actor_id.to_string()),
        target_id: None,
        position: None,
        values: Default::default(),
    }
}
