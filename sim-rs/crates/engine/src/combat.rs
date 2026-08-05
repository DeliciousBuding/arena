//! 战斗结算（从 go-rewrite `internal/sim/combat.go` 移植）。
//!
//! 快照语义：进入战斗时 MOVE/HARVEST/DEPOSIT 已结算，所有攻击的校验与
//! 伤害累积都基于战斗前 HP（同 tick 攻击互不提前生效）。伤害统一累积到
//! map 后一次性应用，最后从 VisibleEnemies 移除 HP<=0 的敌方实体。
//! 战斗只作用于敌方（VisibleEnemies），己方单位不受己方攻击。

use std::collections::BTreeMap;

use arena_sim_domain::{chebyshev, line_blocked, move_position, Event, Plan, Position, TickState, UnitActionKind, UnitType};

use crate::SettleStats;

/// Ranger 射程（Chebyshev 距离判定，与 Ranger 视野半径一致）。
pub const RANGER_RANGE: i32 = 5;

/// 一次已校验的合法攻击（伤害累积阶段产物）。
#[derive(Debug, Clone)]
struct CombatAttack {
    unit_id: String,
    event_type: String, // SHOOT / SHOOT_MISSED / SWEEP / SWEEP_MISSED
    cell: Position,
    target_id: String,
    hits: i32,
    damage_to: Vec<String>,
}

/// 结算战斗阶段（官方结算顺序第 9-10 步：冻结快照 → 校验并累积所有
/// 合法攻击 → 同时应用伤害 → 移除死亡实体）。
pub fn apply_combat(state: &mut TickState, plan: &Plan, stats: &mut SettleStats) -> Vec<Event> {
    let mut damage_by_id: BTreeMap<String, i32> = BTreeMap::new();
    let mut attacks: Vec<CombatAttack> = Vec::with_capacity(4);

    for (unit_id, action) in &plan.unit_actions {
        let attack = match action.kind {
            UnitActionKind::Shoot => collect_shoot(state, unit_id, action),
            UnitActionKind::Sweep => collect_sweep(state, unit_id, action),
            _ => None,
        };
        let Some(attack) = attack else { continue }; // 非法攻击静默忽略
        for enemy_id in &attack.damage_to {
            *damage_by_id.entry(enemy_id.clone()).or_insert(0) += 1;
        }
        match attack.event_type.as_str() {
            "SHOOT" | "SHOOT_MISSED" => stats.shots_fired += 1,
            "SWEEP" | "SWEEP_MISSED" => stats.sweeps_fired += 1,
            _ => {}
        }
        attacks.push(attack);
    }

    // 同时应用伤害：所有攻击累积完成后统一扣血（战斗快照语义）。
    let mut kills = 0;
    let mut alive: Vec<arena_sim_domain::VisibleEntity> = Vec::with_capacity(state.visible_enemies.len());
    for mut enemy in state.visible_enemies.drain(..) {
        if let Some(damage) = damage_by_id.get(&enemy.id) {
            enemy.hp -= damage;
        }
        if enemy.hp <= 0 {
            kills += 1;
            continue;
        }
        alive.push(enemy);
    }
    state.visible_enemies = alive;
    stats.kills += kills;

    build_combat_events(state.tick, &attacks)
}

/// 校验并累积一次 SHOOT 攻击：
/// - 合法：射手存活且为 Ranger，expected_cell 在 5 格 Chebyshev 内且视线无遮挡；
/// - 命中：带 target_id 时目标必须仍在 expected_cell；无 target_id 时命中
///   该格 HP 最低的敌方实体（同 HP 取 ID 升序）；
/// - 目标不在格/越界/被遮挡统一为 SHOOT_MISSED。
fn collect_shoot(
    state: &TickState,
    unit_id: &str,
    action: &arena_sim_domain::UnitAction,
) -> Option<CombatAttack> {
    let unit = state.units.iter().find(|u| u.id == unit_id)?;
    if unit.unit_type != UnitType::Ranger {
        return None;
    }
    let cell = action.expected_cell?;
    let distance = chebyshev(unit.position, cell);
    if distance < 1 || distance > RANGER_RANGE || line_blocked(unit.position, cell, &state.obstacle_cells) {
        return Some(CombatAttack {
            unit_id: unit_id.to_string(),
            event_type: "SHOOT_MISSED".to_string(),
            cell,
            target_id: String::new(),
            hits: 0,
            damage_to: Vec::new(),
        });
    }
    let mut attack = CombatAttack {
        unit_id: unit_id.to_string(),
        event_type: "SHOOT_MISSED".to_string(),
        cell,
        target_id: String::new(),
        hits: 0,
        damage_to: Vec::new(),
    };
    let enemy = if let Some(target_id) = &action.target_id {
        find_enemy_at(state, target_id, cell)
    } else {
        lowest_hp_enemy_at(state, cell)
    };
    if let Some(enemy) = enemy {
        attack.event_type = "SHOOT".to_string();
        attack.target_id = enemy.id.clone();
        attack.damage_to = vec![enemy.id.clone()];
    }
    Some(attack)
}

/// 校验并累积一次 SWEEP 攻击：Vanguard 对相邻格（cardinal direction）内
/// 每个敌方单位各造成 1 伤害（AOE）。格内无敌人为 SWEEP_MISSED。
fn collect_sweep(
    state: &TickState,
    unit_id: &str,
    action: &arena_sim_domain::UnitAction,
) -> Option<CombatAttack> {
    let unit = state.units.iter().find(|u| u.id == unit_id)?;
    if unit.unit_type != UnitType::Vanguard {
        return None;
    }
    let direction = action.direction?;
    let cell = move_position(unit.position, direction);
    let mut attack = CombatAttack {
        unit_id: unit_id.to_string(),
        event_type: "SWEEP_MISSED".to_string(),
        cell,
        target_id: String::new(),
        hits: 0,
        damage_to: Vec::new(),
    };
    for enemy in &state.visible_enemies {
        if enemy.position != cell {
            continue;
        }
        attack.hits += 1;
        attack.damage_to.push(enemy.id.clone());
    }
    if attack.hits > 0 {
        attack.event_type = "SWEEP".to_string();
    }
    Some(attack)
}

/// 按 ID 查找位于指定格的敌方实体。
fn find_enemy_at(state: &TickState, enemy_id: &str, cell: Position) -> Option<&arena_sim_domain::VisibleEntity> {
    state
        .visible_enemies
        .iter()
        .find(|enemy| enemy.id == enemy_id && enemy.position == cell)
}

/// 返回指定格内 HP 最低的敌方实体（同 HP 取 ID 升序：VisibleEnemies
/// 按 ID 升序，min_by_key 对同值取首个 = 顺序扫描语义与 Go 一致）。
fn lowest_hp_enemy_at(state: &TickState, cell: Position) -> Option<&arena_sim_domain::VisibleEntity> {
    state
        .visible_enemies
        .iter()
        .filter(|enemy| enemy.position == cell)
        .min_by_key(|enemy| enemy.hp)
}

/// 按攻击收集顺序构造战斗事件（与 plan.unit_actions 的 ID 升序一致，
/// 确定性）。命中事件带目标/命中数；miss 事件省略 target_id。
fn build_combat_events(tick: i32, attacks: &[CombatAttack]) -> Vec<Event> {
    let mut events = Vec::with_capacity(attacks.len());
    for attack in attacks {
        let mut event = Event {
            event_id: String::new(),
            tick,
            event_type: attack.event_type.clone(),
            reason_code: None,
            actor_id: Some(attack.unit_id.clone()),
            target_id: None,
            position: Some(attack.cell),
            values: Default::default(),
        };
        match attack.event_type.as_str() {
            "SHOOT" => {
                event.target_id = Some(attack.target_id.clone());
                event.values.insert("damage".to_string(), serde_json::json!(1));
            }
            "SWEEP" => {
                event.values.insert("hits".to_string(), serde_json::json!(attack.hits));
            }
            _ => {}
        }
        events.push(event);
    }
    events
}
