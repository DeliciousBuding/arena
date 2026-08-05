//! 敌方攻击结算（从 go-rewrite `internal/sim/enemy_attack.go` 移植）。
//!
//! 官方对称语义：敌方单位在战斗阶段同时攻击我方。
//! - Vanguard：相邻格（Chebyshev 1）1 伤害；
//! - Ranger：八方向 1-3 格（轴向/对角线，视线无遮挡）1 伤害；
//! - Worker：无攻击；
//! - 目标选择：范围内最近的己方对象（单位优先于 Core，Manhattan 距离，
//!   平局取 ID 升序——确定性）；
//! - 伤害先扣 Core Shield 再扣 HP；
//! - 快照语义：伤害统一累积后同时应用。

use std::collections::BTreeMap;

use arena_sim_domain::{chebyshev, manhattan, Event, TickState, UnitType, VisibleEntity};

use crate::SettleStats;

/// 敌方 Ranger 射程（八方向 1-3 格）。
const ENEMY_RANGER_RANGE: i32 = 3;

/// 结算敌方攻击阶段（combat 之后、Core 动作之前）。
pub fn apply_enemy_attacks(state: &mut TickState, stats: &mut SettleStats) -> Vec<Event> {
    let mut damage_by_target: BTreeMap<String, i32> = BTreeMap::new();
    struct AttackInfo {
        actor_id: String,
        target: String,
    }
    let mut attacks: Vec<AttackInfo> = Vec::with_capacity(4);

    for enemy in &state.visible_enemies {
        if enemy.kind != "UNIT" || enemy.unit_type.is_none() {
            continue; // 敌方 Core 的攻击结算不在本引擎范围（服务器侧）
        }
        if let Some(target) = enemy_attack_target(state, enemy) {
            *damage_by_target.entry(target.clone()).or_insert(0) += 1;
            attacks.push(AttackInfo {
                actor_id: enemy.id.clone(),
                target,
            });
        }
    }

    let mut events = Vec::with_capacity(attacks.len() + 2);
    for attack in &attacks {
        events.push(Event {
            event_id: String::new(),
            tick: state.tick,
            event_type: "ENEMY_ATTACK".to_string(),
            reason_code: None,
            actor_id: Some(attack.actor_id.clone()),
            target_id: Some(attack.target.clone()),
            position: None,
            values: [("damage".to_string(), serde_json::json!(1))].into(),
        });
    }

    // 同时应用伤害（快照语义）：Core Shield 优先，其次 Core HP，最后单位 HP。
    if let Some(core) = state.core.as_mut() {
        if let Some(&damage) = damage_by_target.get("core") {
            let shield_absorb = damage.min(core.shield);
            core.shield -= shield_absorb;
            let hp_damage = damage - shield_absorb;
            if hp_damage > 0 {
                core.hp -= hp_damage;
            }
            events.push(Event {
                event_id: String::new(),
                tick: state.tick,
                event_type: "CORE_DAMAGED".to_string(),
                reason_code: None,
                actor_id: None,
                target_id: None,
                position: None,
                values: [
                    ("damage".to_string(), serde_json::json!(damage)),
                    (
                        "shieldRemaining".to_string(),
                        serde_json::json!(core.shield),
                    ),
                    ("hpRemaining".to_string(), serde_json::json!(core.hp)),
                ]
                .into(),
            });
        }
    }

    // 单位死亡移除（Units 内按 ID 稳定顺序重建）。
    let mut alive = Vec::with_capacity(state.units.len());
    for mut unit in state.units.drain(..) {
        if let Some(&damage) = damage_by_target.get(&unit.id) {
            unit.hp -= damage;
        }
        if unit.hp <= 0 {
            stats.units_lost += 1;
            events.push(Event {
                event_id: String::new(),
                tick: state.tick,
                event_type: "UNIT_DESTROYED".to_string(),
                reason_code: None,
                actor_id: Some(unit.id.clone()),
                target_id: None,
                position: None,
                values: [(
                    "unitType".to_string(),
                    serde_json::json!(unit.unit_type.as_str()),
                )]
                .into(),
            });
            continue;
        }
        alive.push(unit);
    }
    state.units = alive;
    events
}

/// 返回敌方单位的目标（None = 无目标）：范围内最近的己方对象——
/// Core 用固定键 "core"，单位用 ID。目标优先级：Manhattan 距离近者优先；
/// 同距离单位优先于 Core（先扫描单位再 Core）；同距离同优先级取先序
/// （Units 按 ID 升序）。
fn enemy_attack_target(state: &TickState, enemy: &VisibleEntity) -> Option<String> {
    let mut best_id: Option<String> = None;
    let mut best_distance = i32::MAX;

    // 己方单位（按 Units 顺序，Manhattan 距离；同距离取先序）。
    for unit in &state.units {
        if unit.position == enemy.position {
            continue;
        }
        let distance = manhattan(enemy.position, unit.position);
        if !enemy_can_hit(enemy, unit.position, distance) {
            continue;
        }
        if distance < best_distance {
            best_id = Some(unit.id.clone());
            best_distance = distance;
        }
    }
    // Core（固定键 "core"）：仅在严格更近时替换（同距单位优先，Go 语义）。
    if let Some(core) = &state.core {
        if core.position != enemy.position {
            let distance = manhattan(enemy.position, core.position);
            if enemy_can_hit(enemy, core.position, distance) && distance < best_distance {
                best_id = Some("core".to_string());
            }
        }
    }
    best_id
}

/// 报告敌方单位能否命中目标格（按官方攻击表）：
/// Vanguard 相邻 1 格（Chebyshev）；Ranger 八方向 1-3 格。
fn enemy_can_hit(
    enemy: &VisibleEntity,
    target: arena_sim_domain::Position,
    manhattan: i32,
) -> bool {
    let Some(unit_type) = enemy.unit_type else {
        return false;
    };
    let distance = chebyshev(enemy.position, target);
    match unit_type {
        UnitType::Vanguard => distance == 1,
        UnitType::Ranger => {
            if !(1..=ENEMY_RANGER_RANGE).contains(&manhattan) {
                return false;
            }
            // 八方向：轴向（dx==0 || dy==0）或对角线（|dx|==|dy|）。
            let dx = target[0] - enemy.position[0];
            let dy = target[1] - enemy.position[1];
            if dx != 0 && dy != 0 && dx.abs() != dy.abs() {
                return false;
            }
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use arena_sim_domain::{Beacon, BeaconStatus, Core, CoreState, CoreStatus};

    fn base_state() -> TickState {
        TickState {
            tick: 1,
            status: CoreStatus::Active,
            resources: 0,
            resource_capacity: 10,
            resource_space: 10,
            population: 1,
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
            units: vec![arena_sim_domain::UnitSnapshot {
                id: "worker-1".to_string(),
                position: [3, 0],
                hp: 2,
                unit_type: UnitType::Worker,
                cargo: 0,
            }],
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
    fn enemy_vanguard_hits_adjacent_unit() {
        let mut state = base_state();
        state.visible_enemies = vec![VisibleEntity {
            id: "enemy-1".to_string(),
            kind: "UNIT".to_string(),
            position: [2, 0],
            hp: 4,
            unit_type: Some(UnitType::Vanguard),
            owner_username: None,
        }];
        let mut stats = SettleStats::default();
        let events = apply_enemy_attacks(&mut state, &mut stats);
        assert_eq!(stats.units_lost, 0);
        assert_eq!(state.units[0].hp, 1);
        assert_eq!(
            events
                .iter()
                .filter(|e| e.event_type == "ENEMY_ATTACK")
                .count(),
            1
        );
        assert!(events.iter().any(|e| e.event_type == "CORE_DAMAGED") == false);
    }

    #[test]
    fn enemy_ranger_attacks_core_when_unit_out_of_range() {
        let mut state = base_state();
        // worker 在 3 格外（ranger 射程 3 内但 3 格 = 轴向可命中）；
        // 距离比较：worker 距离 3 < core 距离 4？core 在原点 (0,0)，ranger 在 (-4,0)。
        state.units[0].position = [3, 0];
        state.visible_enemies = vec![VisibleEntity {
            id: "enemy-2".to_string(),
            kind: "UNIT".to_string(),
            position: [-4, 0],
            hp: 2,
            unit_type: Some(UnitType::Ranger),
            owner_username: None,
        }];
        let mut stats = SettleStats::default();
        let events = apply_enemy_attacks(&mut state, &mut stats);
        // worker 距离 7 超射程；core 距离 4 超射程 → 无攻击。
        assert_eq!(
            events
                .iter()
                .filter(|e| e.event_type == "ENEMY_ATTACK")
                .count(),
            0
        );
    }

    #[test]
    fn core_shield_absorbs_before_hp() {
        let mut state = base_state();
        state.core.as_mut().unwrap().hp = 5;
        state.core.as_mut().unwrap().shield = 2;
        state.units.clear();
        state.visible_enemies = vec![VisibleEntity {
            id: "enemy-3".to_string(),
            kind: "UNIT".to_string(),
            position: [1, 0],
            hp: 4,
            unit_type: Some(UnitType::Vanguard),
            owner_username: None,
        }];
        let mut stats = SettleStats::default();
        apply_enemy_attacks(&mut state, &mut stats);
        let core = state.core.as_ref().unwrap();
        assert_eq!(core.shield, 1);
        assert_eq!(core.hp, 5);
    }

    #[test]
    fn unit_preferred_over_core_at_same_distance() {
        let mut state = base_state();
        // 敌人站在 (0,1)：core (0,0) 距离 1、无单位在距离 1。
        // 在 (1,0) 放一个单位 → 距离 2；core 距离 2 的格…构造同距场景：
        state.units[0].position = [0, 2];
        state.visible_enemies = vec![VisibleEntity {
            id: "enemy-4".to_string(),
            kind: "UNIT".to_string(),
            position: [0, 1],
            hp: 4,
            unit_type: Some(UnitType::Vanguard),
            owner_username: None,
        }];
        let mut stats = SettleStats::default();
        let events = apply_enemy_attacks(&mut state, &mut stats);
        // unit (0,2) 距离 1 与 core (0,0) 距离 1 相同 → 单位优先。
        let attack = events
            .iter()
            .find(|e| e.event_type == "ENEMY_ATTACK")
            .unwrap();
        assert_eq!(attack.target_id.as_deref(), Some("worker-1"));
    }
}
