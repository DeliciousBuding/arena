//! 确定性规划器（从 go-rewrite `internal/strategy/planner.go` 移植）。
//!
//! SafetyPlanner 语义子集：spawn/harvest/deposit/巡逻/防御 + 经济化
//! （worker 全局分配/移动容量仲裁/workerTarget reserve/respawn override）。
//! 战斗意图（SWEEP/SHOOT/kite/engage）与 Go 版同源（combat_tactics_test
//! 覆盖在 Go 侧，Rust 侧由差分门禁兜底）。

pub mod commander;
pub mod economic;

#[cfg(test)]
mod loop_tests;

use std::collections::BTreeMap;

use arena_sim_domain::{
    cell_key, chebyshev, manhattan, move_position, step_toward, Direction, Plan, Position,
    TickState, UnitAction, UnitActionKind, UnitSnapshot, UnitType, CORE_MAX_HP,
};

use commander::{Directive, DirectiveMode};

/// 规划器配置（对齐 TS 版 DEFAULT_SAFETY_CONFIG / Go `Config`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// 策略可读名（批量评估/赛马/黄金集输出用；规划逻辑忽略）。
    pub name: String,
    /// 目标 Worker 数（spawn 阈值）。
    pub worker_target: i32,
    /// 人口上限。
    pub population_ceiling: i32,
    /// 探索半径。
    pub explore_radius: i32,
    /// 威胁判定距离（Manhattan）。
    pub threat_distance: i32,
    /// 正常扩张的预留资源（reserve guard；紧急/恢复期忽略）。
    pub spawn_reserve: i32,
    /// 军事单位占人口比例（百分数 0-100）：worker 达到 WorkerTarget 后
    /// 按比例补 Vanguard/Ranger（交替，防御优先）。0 = 不产军事。
    pub military_ratio: i32,
    /// 启用 Core 迁移执行（红线：默认 false——MIGRATE_CAND 只评估）。
    pub enable_core_migration: bool,
}

impl Default for Config {
    /// 默认配置（多场景最差分评分双算法验证，见 Go `DefaultConfig`）：
    /// workerTarget=13、populationCeiling=16、exploreRadius=17、
    /// threatDistance=5、spawnReserve=0、MilitaryRatio=25。
    fn default() -> Config {
        Config {
            name: String::new(),
            worker_target: 13,
            population_ceiling: 16,
            explore_radius: 17,
            threat_distance: 5,
            spawn_reserve: 0,
            military_ratio: 25,
            enable_core_migration: false,
        }
    }
}

/// 停滞跳出阈值：服务器反馈的位置连续 N tick 不变（且单位有移动意图）
/// → 强制换巡逻目标。
pub const STUCK_YIELD_THRESHOLD: i32 = 3;

/// 追敌超时阈值：连续 engage 超过该 tick 数且未进入 SWEEP 射程 →
/// 放弃追击。
const ENGAGE_TIMEOUT_TICKS: i32 = 8;

/// 单位停滞指纹（基于服务器反馈的位置）。
#[derive(Debug, Clone)]
pub struct StuckState {
    last_pos: Position,
    stuck_ticks: i32,
}

/// 确定性规划器（无副作用，不接触游戏）。跨 tick 持久状态：
/// per-unit 巡逻目标/方向/环、停滞指纹、engage 计数、指挥指令。
#[derive(Debug)]
pub struct Planner {
    pub config: Config,
    pub directive: Directive,
    pub patrol_targets: BTreeMap<String, Position>,
    pub patrol_dirs: BTreeMap<String, i32>,
    pub patrol_rings: BTreeMap<String, i32>,
    pub stuck: BTreeMap<String, StuckState>,
    pub engage_ticks: BTreeMap<String, i32>,
}

impl Planner {
    pub fn new(config: Config) -> Planner {
        Planner {
            config,
            directive: Directive {
                mode: DirectiveMode::Growth,
                focus: [0, 0],
            },
            patrol_targets: BTreeMap::new(),
            patrol_dirs: BTreeMap::new(),
            patrol_rings: BTreeMap::new(),
            stuck: BTreeMap::new(),
            engage_ticks: BTreeMap::new(),
        }
    }

    /// 应用指挥层指令（每 tick 由 Loop 调用）。
    pub fn apply_directive(&mut self, directive: Directive) {
        self.directive = directive;
    }

    /// 返回当前指挥模式（决策遥测/批量评估时间线用）。
    pub fn directive_mode(&self) -> DirectiveMode {
        self.directive.mode
    }

    /// 产出确定性计划（同输入同输出）：
    /// 1. Core 决策（workerTarget + reserve guard + 紧急/恢复期通道）；
    /// 2. worker 全局资源分配（assign_workers，每格至多一个 worker）；
    /// 3. 移动目标冲突仲裁（arbitrate_move_capacity）→ 冲突格只留最高
    ///    优先级单位，其余降级 WAIT。
    pub fn decide(&mut self, state: &TickState) -> Plan {
        let mut plan = Plan {
            tick: state.tick,
            unit_actions: BTreeMap::new(),
            core_action: None,
            intents: BTreeMap::new(),
        };

        if let Some(core_action) = self.decide_core(state) {
            plan.core_action = Some(core_action);
            plan.intents.insert("core".to_string(), "spawn".to_string());
        }

        let assignments = economic::assign_workers(state);

        let mut unit_ids: Vec<&str> = state.units.iter().map(|u| u.id.as_str()).collect();
        unit_ids.sort_unstable();

        let mut candidates: Vec<economic::MoveCandidate> = Vec::new();
        for id in unit_ids {
            let Some(unit) = economic::find_unit_snapshot(state, id) else {
                continue;
            };
            // 停滞指纹：基于服务器反馈的位置（连续不变 = 结算未生效）。
            self.track_stuck(id, unit.position);
            let Some((action, intent)) = self.decide_unit(state, unit, &assignments) else {
                continue;
            };
            plan.unit_actions.insert(id.to_string(), action.clone());
            plan.intents.insert(id.to_string(), intent.to_string());
            if action.kind == UnitActionKind::Move {
                if let Some(direction) = action.direction {
                    candidates.push(economic::MoveCandidate {
                        unit_id: id.to_string(),
                        destination: move_position(unit.position, direction),
                        priority: move_priority_for(intent),
                        intent: intent.to_string(),
                    });
                }
            }
        }

        // 一次性仲裁：冲突格只保留最高优先级单位，其余降级 WAIT。
        for loser in economic::arbitrate_move_capacity(&candidates) {
            plan.unit_actions.insert(
                loser.unit_id.clone(),
                UnitAction {
                    kind: UnitActionKind::Wait,
                    direction: None,
                    target_id: None,
                    expected_cell: None,
                },
            );
            plan.intents.insert(
                loser.unit_id.clone(),
                format!("capacity_wait:{}", loser.intent),
            );
            // 仲裁降级且站在 Core 格上的空载单位：改为让位（仓库口让出）。
            if let Some(unit) = economic::find_unit_snapshot(state, &loser.unit_id) {
                let on_core = state
                    .core
                    .as_ref()
                    .map(|core| unit.cargo == 0 && unit.position == core.position)
                    .unwrap_or(false);
                if on_core {
                    if let Some((yield_action, _)) = self.yield_from_core(state, unit, false) {
                        plan.unit_actions
                            .insert(loser.unit_id.clone(), yield_action);
                        plan.intents
                            .insert(loser.unit_id.clone(), "yield_core_wait".to_string());
                    }
                }
            }
        }
        plan
    }

    /// 让满载 Worker 离开 Core 格（满仓破锁）：按固定顺序找第一个安全
    /// 相邻格（跳过障碍格、资源格、任何已占用格）。
    pub fn yield_full_core(
        &self,
        state: &TickState,
        unit: &UnitSnapshot,
    ) -> Option<(UnitAction, bool)> {
        self.yield_from_core(state, unit, true)
    }

    /// 让 Worker 离开 Core 格（见 economic::yield_from_core 语义）。
    pub fn yield_from_core(
        &self,
        state: &TickState,
        unit: &UnitSnapshot,
        skip_resources: bool,
    ) -> Option<(UnitAction, bool)> {
        economic::yield_from_core(state, unit, skip_resources)
    }

    /// 更新单位停滞指纹：位置与上次一致则计数 +1；位置变化则重置。
    fn track_stuck(&mut self, unit_id: &str, position: Position) {
        match self.stuck.get_mut(unit_id) {
            Some(st) => {
                if st.last_pos == position {
                    st.stuck_ticks += 1;
                } else {
                    st.last_pos = position;
                    st.stuck_ticks = 0;
                }
            }
            None => {
                self.stuck.insert(
                    unit_id.to_string(),
                    StuckState {
                        last_pos: position,
                        stuck_ticks: 0,
                    },
                );
            }
        }
    }

    /// 报告单位是否处于停滞（服务器位置连续不变达阈值）。
    fn is_stuck(&self, unit_id: &str) -> bool {
        self.stuck
            .get(unit_id)
            .map(|st| st.stuck_ticks >= STUCK_YIELD_THRESHOLD)
            .unwrap_or(false)
    }

    /// Core 决策：workerTarget 消费 + reserve guard + 紧急/恢复期通道。
    /// - Core 缺失或非 NORMAL：无 core 动作；
    /// - 正常扩张：resources >= cost + SpawnReserve 才 spawn（reserve guard）；
    /// - 紧急通道：worker 数低于 emergencyWorkerFloor 或恢复期时，
    ///   resources >= cost 即 spawn（不攒 reserve）；
    /// - 同 tick 至多一个 spawn。
    fn decide_core(&mut self, state: &TickState) -> Option<arena_sim_domain::CoreAction> {
        let core = state.core.as_ref()?;
        if core.state != arena_sim_domain::CoreState::Normal {
            return None;
        }
        // Core 迁移执行（红线：默认关闭；MIGRATE_CAND 且显式启用才发）。
        if self.config.enable_core_migration && self.directive.mode == DirectiveMode::MigrateCand {
            if let Some(direction) = migration_direction(self.directive.focus, core.position) {
                return Some(arena_sim_domain::CoreAction {
                    kind: arena_sim_domain::CoreActionKind::StartMove,
                    unit_type: None,
                    direction: Some(direction),
                });
            }
        }
        let workers = state.workers.len() as i32;
        if workers < self.config.worker_target && state.population < self.config.population_ceiling
        {
            let cost = arena_sim_domain::spawn_cost(UnitType::Worker);
            let mut reserve = self.config.spawn_reserve;
            if workers < economic::EMERGENCY_WORKER_FLOOR || economic::respawn_override(state) {
                reserve = 0;
            }
            // 满仓死锁防护：reserve 超过 capacity-cost 时 spawn 永不触发。
            let max_reserve = state.resource_capacity - cost;
            if reserve > max_reserve {
                reserve = max_reserve;
            }
            if state.resources >= cost + reserve {
                return Some(arena_sim_domain::CoreAction {
                    kind: arena_sim_domain::CoreActionKind::Spawn,
                    unit_type: Some(UnitType::Worker),
                    direction: None,
                });
            }
        }
        // 军事生产（worker 达到目标后）：按人口比例补 Vanguard/Ranger 交替。
        if let Some(military_type) = self.military_spawn(state, workers) {
            let cost = arena_sim_domain::spawn_cost(military_type);
            if state.resources >= cost {
                return Some(arena_sim_domain::CoreAction {
                    kind: arena_sim_domain::CoreActionKind::Spawn,
                    unit_type: Some(military_type),
                    direction: None,
                });
            }
        }
        if core.hp < CORE_MAX_HP && workers >= 2 {
            return Some(arena_sim_domain::CoreAction {
                kind: arena_sim_domain::CoreActionKind::Heal,
                unit_type: None,
                direction: None,
            });
        }
        None
    }

    /// 返回需要生产的军事单位类型（None = 不生产）：worker 达到
    /// WorkerTarget 且军事占比低于 MilitaryRatio 时，Vanguard/Ranger
    /// 交替（第偶数个军事 → Vanguard，奇数 → Ranger，防御优先）。
    fn military_spawn(&self, state: &TickState, workers: i32) -> Option<UnitType> {
        if self.config.military_ratio <= 0 || workers < self.config.worker_target {
            return None;
        }
        let military = (state.vanguards.len() + state.rangers.len()) as i32;
        let expected =
            ((state.population as f64) * (self.config.military_ratio as f64) / 100.0).ceil() as i32;
        if military >= expected {
            return None;
        }
        Some(if military % 2 == 1 {
            UnitType::Ranger
        } else {
            UnitType::Vanguard
        })
    }

    fn decide_unit(
        &mut self,
        state: &TickState,
        unit: &UnitSnapshot,
        assignments: &BTreeMap<String, Position>,
    ) -> Option<(UnitAction, &'static str)> {
        // 信标拾取优先。
        if state.beacon.status == arena_sim_domain::BeaconStatus::Ground
            && state.beacon.carrier_id.is_none()
            && unit.position == state.beacon.position
        {
            return Some((
                UnitAction {
                    kind: UnitActionKind::PickupBeacon,
                    direction: None,
                    target_id: None,
                    expected_cell: None,
                },
                "beacon",
            ));
        }
        match unit.unit_type {
            UnitType::Worker => self.decide_worker(state, unit, assignments),
            UnitType::Vanguard => self.decide_vanguard(state, unit),
            UnitType::Ranger => self.decide_ranger(state, unit),
        }
    }

    /// moveTowardOrYield：move_toward 的停滞跳出包装——位置连续不变达
    /// 阈值且路径第一步仍被占（环形互堵）→ 确定性让位到相邻空格打破环。
    fn move_toward_or_yield(
        &mut self,
        state: &TickState,
        unit: &UnitSnapshot,
        target: Position,
    ) -> UnitAction {
        let action = self.move_toward(state, unit, target);
        if action.kind != UnitActionKind::Wait || !self.is_stuck(&unit.id) {
            return action;
        }
        if let Some((aside, _)) = self.step_aside(state, unit, target) {
            return aside;
        }
        action
    }

    /// stepAside 让位：向相邻空位移动打破互堵。方向优先级（确定性）：
    /// 1. 垂直于目标方向的两个方向（横向让开）；
    /// 2. 远离目标方向；
    /// 3. 兜底 4 邻域顺序（UP→RIGHT→DOWN→LEFT）。
    fn step_aside(
        &self,
        state: &TickState,
        unit: &UnitSnapshot,
        target: Position,
    ) -> Option<(UnitAction, bool)> {
        const WORLD_BOUND: i32 = 1000;
        let perpendicular = perpendicular_to(unit.position, target);
        let away = away_direction(unit.position, target);
        let orders: [&[Direction]; 3] = [&perpendicular, &[away], &YIELD_ORDER];
        for order in orders {
            for &direction in order {
                let next = move_position(unit.position, direction);
                if next[0] < -WORLD_BOUND
                    || next[0] > WORLD_BOUND
                    || next[1] < -WORLD_BOUND
                    || next[1] > WORLD_BOUND
                {
                    continue;
                }
                if state.obstacle_cells.contains(&cell_key(next[0], next[1])) {
                    continue;
                }
                if economic::occupied_by_any(state, &unit.id, next) {
                    continue;
                }
                return Some((
                    UnitAction {
                        kind: UnitActionKind::Move,
                        direction: Some(direction),
                        target_id: None,
                        expected_cell: None,
                    },
                    true,
                ));
            }
        }
        None
    }

    fn decide_worker(
        &mut self,
        state: &TickState,
        unit: &UnitSnapshot,
        assignments: &BTreeMap<String, Position>,
    ) -> Option<(UnitAction, &'static str)> {
        let core_position = state.core.as_ref().map(|core| core.position);
        if unit.cargo >= 1 {
            if state.resource_space <= 0 {
                // 满仓破锁：满载 Worker 站在 Core 会永久阻塞 SPAWN 结算 →
                // 确定性让位到安全相邻格；不在 Core 上的满载 Worker 原地等待。
                if core_position == Some(unit.position) {
                    if let Some((action, _)) = self.yield_full_core(state, unit) {
                        return Some((action, "yield_full_core"));
                    }
                }
                return Some((
                    UnitAction {
                        kind: UnitActionKind::Wait,
                        direction: None,
                        target_id: None,
                        expected_cell: None,
                    },
                    "wait_full",
                ));
            }
            if core_position == Some(unit.position) {
                return Some((
                    UnitAction {
                        kind: UnitActionKind::Deposit,
                        direction: None,
                        target_id: None,
                        expected_cell: None,
                    },
                    "deposit",
                ));
            }
            if let Some(core_pos) = core_position {
                return Some((
                    self.move_toward_or_yield(state, unit, core_pos),
                    "return_core",
                ));
            }
            return Some((
                UnitAction {
                    kind: UnitActionKind::Wait,
                    direction: None,
                    target_id: None,
                    expected_cell: None,
                },
                "wait",
            ));
        }
        if state
            .resource_cells
            .contains(&cell_key(unit.position[0], unit.position[1]))
        {
            return Some((
                UnitAction {
                    kind: UnitActionKind::Harvest,
                    direction: None,
                    target_id: None,
                    expected_cell: None,
                },
                "harvest",
            ));
        }
        // 全局分配：目标是"分给我的"资源格（每格唯一，消除抢格）。
        if let Some(&target) = assignments.get(&unit.id) {
            let action = self.move_toward_or_yield(state, unit, target);
            if action.kind == UnitActionKind::Wait
                && state.core.is_some()
                && unit.position == state.core.as_ref().unwrap().position
            {
                // 空载 Worker 在 Core 上排队等资源格时被堵：先让位离开
                // 仓库口（允许踩资源格，dense 拓扑 Core 四邻全为资源格）。
                if let Some((yield_action, _)) = self.yield_from_core(state, unit, false) {
                    return Some((yield_action, "yield_core_wait"));
                }
            }
            return Some((action, "to_resource"));
        }
        // 无可见资源格：恢复期原地待命（不探索远处），正常期巡逻探索。
        if economic::respawn_override(state) {
            return Some((
                UnitAction {
                    kind: UnitActionKind::Wait,
                    direction: None,
                    target_id: None,
                    expected_cell: None,
                },
                "defend",
            ));
        }
        Some((self.patrol(state, unit), "explore"))
    }

    fn decide_vanguard(
        &mut self,
        state: &TickState,
        unit: &UnitSnapshot,
    ) -> Option<(UnitAction, &'static str)> {
        let core_position = core_position_of(state);
        // SWEEP（官方规则）：相邻格有敌方单位 → AOE 1 伤害（比逼近优先）。
        if let Some(direction) = adjacent_enemy_sweep(state, unit.position) {
            return Some((
                UnitAction {
                    kind: UnitActionKind::Sweep,
                    direction: Some(direction),
                    target_id: None,
                    expected_cell: None,
                },
                "sweep",
            ));
        }
        if let Some(enemy) = nearest_enemy(state, unit.position, self.config.threat_distance) {
            // 追敌超时跳出：敌人持续移动导致永远追不上 → 放弃追击回防。
            if self.engage_ticks.get(&unit.id).copied().unwrap_or(0) >= ENGAGE_TIMEOUT_TICKS {
                self.engage_ticks.insert(unit.id.clone(), 0);
                if let Some(core_pos) = core_position {
                    if unit.position != core_pos {
                        return Some((self.move_toward(state, unit, core_pos), "disengage"));
                    }
                }
                return Some((self.patrol(state, unit), "patrol"));
            }
            *self.engage_ticks.entry(unit.id.clone()).or_insert(0) += 1;
            return Some((self.move_toward(state, unit, enemy.position), "engage"));
        }
        // 无敌人：重置 engage 计数。
        self.engage_ticks.insert(unit.id.clone(), 0);
        if let Some(core_pos) = core_position {
            if unit.hp < arena_sim_domain::unit_max_hp(unit.unit_type) {
                if unit.position == core_pos {
                    return Some((
                        UnitAction {
                            kind: UnitActionKind::Heal,
                            direction: None,
                            target_id: None,
                            expected_cell: None,
                        },
                        "heal",
                    ));
                }
                return Some((self.move_toward(state, unit, core_pos), "to_core_heal"));
            }
        }
        if economic::respawn_override(state) {
            // 恢复期：回核心防守，不巡逻远处。
            if let Some(core_pos) = core_position {
                if unit.position != core_pos {
                    return Some((self.move_toward(state, unit, core_pos), "defend"));
                }
            }
            return Some((
                UnitAction {
                    kind: UnitActionKind::Wait,
                    direction: None,
                    target_id: None,
                    expected_cell: None,
                },
                "defend",
            ));
        }
        Some((self.patrol(state, unit), "patrol"))
    }

    fn decide_ranger(
        &mut self,
        state: &TickState,
        unit: &UnitSnapshot,
    ) -> Option<(UnitAction, &'static str)> {
        let core_position = core_position_of(state);
        if let Some(enemy) = nearest_enemy(state, unit.position, 3) {
            if !arena_sim_domain::line_blocked(unit.position, enemy.position, &state.obstacle_cells)
            {
                // 放风筝（kite）：敌人距离 <= 2 时先拉开保持射程优势。
                if chebyshev(unit.position, enemy.position) <= 2 {
                    if let Some((action, _)) = self.kite_away(state, unit, enemy.position) {
                        return Some((action, "kite"));
                    }
                }
                let target_id = enemy.id.clone();
                let cell = enemy.position;
                return Some((
                    UnitAction {
                        kind: UnitActionKind::Shoot,
                        direction: None,
                        target_id: Some(target_id),
                        expected_cell: Some(cell),
                    },
                    "shoot",
                ));
            }
        }
        if let Some(core_pos) = core_position {
            if unit.hp < arena_sim_domain::unit_max_hp(unit.unit_type) {
                if unit.position == core_pos {
                    return Some((
                        UnitAction {
                            kind: UnitActionKind::Heal,
                            direction: None,
                            target_id: None,
                            expected_cell: None,
                        },
                        "heal",
                    ));
                }
                return Some((self.move_toward(state, unit, core_pos), "to_core_heal"));
            }
        }
        if economic::respawn_override(state) {
            if let Some(core_pos) = core_position {
                if unit.position != core_pos {
                    return Some((self.move_toward(state, unit, core_pos), "defend"));
                }
            }
            return Some((
                UnitAction {
                    kind: UnitActionKind::Wait,
                    direction: None,
                    target_id: None,
                    expected_cell: None,
                },
                "defend",
            ));
        }
        Some((self.patrol(state, unit), "patrol"))
    }

    /// kiteAway 让 Ranger 朝远离敌人的方向撤退一步（保持射程优势）。
    /// 方向选择：敌人反方向优先（dx/dy 反向），被堵则走正交方向；
    /// 全部被堵返回 None（调用方降级 SHOOT）。
    fn kite_away(
        &self,
        state: &TickState,
        unit: &UnitSnapshot,
        enemy: Position,
    ) -> Option<(UnitAction, bool)> {
        let dx = unit.position[0] - enemy[0];
        let dy = unit.position[1] - enemy[1];
        // 反方向候选：主轴向优先（|dx| >= |dy| 时 x 反向优先）。
        let mut preferred: Vec<Direction> = Vec::with_capacity(4);
        if dx != 0 {
            preferred.push(if dx > 0 {
                Direction::Right
            } else {
                Direction::Left
            });
        }
        if dy != 0 {
            preferred.push(if dy > 0 {
                Direction::Down
            } else {
                Direction::Up
            });
        }
        for direction in [
            Direction::Right,
            Direction::Down,
            Direction::Left,
            Direction::Up,
        ] {
            if !preferred.contains(&direction) {
                preferred.push(direction);
            }
        }
        for direction in preferred {
            let next = move_position(unit.position, direction);
            let key = cell_key(next[0], next[1]);
            if state.obstacle_cells.contains(&key) || state.resource_cells.contains(&key) {
                continue;
            }
            if economic::occupied_by_any(state, &unit.id, next) {
                continue;
            }
            return Some((
                UnitAction {
                    kind: UnitActionKind::Move,
                    direction: Some(direction),
                    target_id: None,
                    expected_cell: None,
                },
                true,
            ));
        }
        None
    }

    /// moveToward 朝目标走一步：
    /// - 地形障碍（静态）由 BFS 绕行（step_toward）；
    /// - 其他己方单位当前位置不并入 BFS（避免拥挤时绕行横跳振荡）——
    ///   理想第一步的目标格被占时 WAIT 排队；
    /// - 目标格被占时同样 WAIT 排队——不绕行到目标相邻格（互卡死锁）；
    /// - Core 格路径语义：目标非 Core 时 Core 格视为障碍（探索/采集
    ///   路径不得穿越仓库口）。
    fn move_toward(&self, state: &TickState, unit: &UnitSnapshot, target: Position) -> UnitAction {
        // 目标格被己方单位占位：WAIT 排队。
        if target != unit.position && economic::occupied_by_any(state, &unit.id, target) {
            return UnitAction {
                kind: UnitActionKind::Wait,
                direction: None,
                target_id: None,
                expected_cell: None,
            };
        }
        // 地形障碍 + Core 格（目标非 Core 时）作为 BFS 障碍。
        let mut obstacles = state.obstacle_cells.clone();
        if let Some(core_pos) = core_position_of(state) {
            if target != core_pos {
                obstacles.insert(cell_key(core_pos[0], core_pos[1]));
            }
        }
        let Some(direction) = step_toward(unit.position, target, &obstacles) else {
            return UnitAction {
                kind: UnitActionKind::Wait,
                direction: None,
                target_id: None,
                expected_cell: None,
            };
        };
        // 理想第一步的目标格被其他单位占据：WAIT 排队（不绕行——
        // 拥挤时绕行路径每 tick 变化导致横跳振荡）。
        let next_cell = move_position(unit.position, direction);
        if economic::occupied_by_any(state, &unit.id, next_cell) {
            return UnitAction {
                kind: UnitActionKind::Wait,
                direction: None,
                target_id: None,
                expected_cell: None,
            };
        }
        UnitAction {
            kind: UnitActionKind::Move,
            direction: Some(direction),
            target_id: None,
            expected_cell: None,
        }
    }

    /// patrol 是 per-unit 持久巡逻：同一单位持续朝同一目标直线移动直到
    /// 到达或受阻，才按八方位 × 递增环半径换下一个目标。目标是让 worker
    /// 真正走出视野发现资源格。停滞跳出：位置连续不变 → 强制换目标。
    fn patrol(&mut self, state: &TickState, unit: &UnitSnapshot) -> UnitAction {
        let home = state.core.as_ref().map(|c| c.position).unwrap_or([0, 0]);
        // EXPLORE_STARVED / MIGRATE_CAND：所有 worker 朝指挥焦点方向扫掠。
        if self.directive.mode == DirectiveMode::ExploreStarved
            || self.directive.mode == DirectiveMode::MigrateCand
        {
            return self.starved_patrol(state, unit, home);
        }

        let has_target = self.patrol_targets.contains_key(&unit.id);
        let at_target = self.patrol_targets.get(&unit.id) == Some(&unit.position);
        if !has_target || at_target || self.is_stuck(&unit.id) {
            let target = self.next_patrol_target(home, state.beacon.position, &unit.id);
            self.stuck.insert(
                unit.id.clone(),
                StuckState {
                    last_pos: unit.position,
                    stuck_ticks: 0,
                },
            );
            self.patrol_targets.insert(unit.id.clone(), target);
        }
        let target = self.patrol_targets[&unit.id];
        let action = self.move_toward(state, unit, target);
        if action.kind == UnitActionKind::Wait {
            // 目标方向全被障碍阻挡：换下一个目标，避免原地卡死。
            let target = self.next_patrol_target(home, state.beacon.position, &unit.id);
            self.patrol_targets.insert(unit.id.clone(), target);
            return self.move_toward(state, unit, target);
        }
        action
    }

    /// starvedPatrol 是资源枯竭模式的确定性螺旋覆盖：每 worker 沿自己
    /// 方位角（focus 方向 + ID 哈希偏移）在环上等距行走（angle 步长按
    /// ring 缩放保持覆盖密度），走完一圈 ring+1（半径 22→44→66→88）。
    fn starved_patrol(
        &mut self,
        state: &TickState,
        unit: &UnitSnapshot,
        home: Position,
    ) -> UnitAction {
        let has_target = self.patrol_targets.contains_key(&unit.id);
        let at_target = self.patrol_targets.get(&unit.id) == Some(&unit.position);
        if !has_target || at_target || self.is_stuck(&unit.id) {
            let mut ring = self.patrol_rings.get(&unit.id).copied().unwrap_or(0);
            let mut radius = self.config.explore_radius * (ring + 1);
            if radius > 88 {
                self.patrol_rings.insert(unit.id.clone(), 0);
                ring = 0;
                radius = self.config.explore_radius;
            }
            let angle_step = 1 + radius / 16; // 环越大步长越大：覆盖密度恒定
            let angle = self.patrol_dirs.get(&unit.id).copied().unwrap_or(0);
            let target = spiral_point(home, self.directive.focus, &unit.id, ring, angle, radius);
            self.patrol_dirs.insert(unit.id.clone(), angle + angle_step);
            let next_angle = self.patrol_dirs[&unit.id];
            if next_angle >= 64 {
                self.patrol_dirs.insert(unit.id.clone(), 0);
                self.patrol_rings.insert(unit.id.clone(), ring + 1);
            }
            self.stuck.insert(
                unit.id.clone(),
                StuckState {
                    last_pos: unit.position,
                    stuck_ticks: 0,
                },
            );
            self.patrol_targets.insert(unit.id.clone(), target);
        }
        let target = self.patrol_targets[&unit.id];
        let action = self.move_toward(state, unit, target);
        if action.kind == UnitActionKind::Wait {
            let ring = self.patrol_rings.get(&unit.id).copied().unwrap_or(0);
            let angle = self.patrol_dirs.get(&unit.id).copied().unwrap_or(0);
            let target = spiral_point(
                home,
                self.directive.focus,
                &unit.id,
                ring,
                angle + 1,
                self.config.explore_radius,
            );
            self.patrol_targets.insert(unit.id.clone(), target);
            return self.move_toward(state, unit, target);
        }
        action
    }

    /// 生成下一巡逻目标：per-unit 八方位方向索引递增，每轮 8 个方向后
    /// 探索环 +1（半径 ×1×2×3×4 循环）。首目标方向按单位 ID 稳定分散。
    fn next_patrol_target(&mut self, home: Position, beacon: Position, unit_id: &str) -> Position {
        let mut initial = self.patrol_dirs.get(unit_id).copied().unwrap_or(0);
        if initial == 0 {
            // 首目标：beacon 方位为基准 + 单位 ID 哈希偏移（0..7）。
            let offset = id_hash(unit_id, 8);
            initial = offset;
            self.patrol_dirs.insert(unit_id.to_string(), initial);
        }
        // 巡逻半径从内圈开始螺旋外扩（Core 周围是资源最可能的位置）。
        let mut radius = self.config.explore_radius / 2;
        if radius < 4 {
            radius = 4;
        }
        if let Some(&ring) = self.patrol_rings.get(unit_id) {
            if ring > 0 {
                if let Some(r) =
                    arena_sim_domain::explore_radius_for_ring(self.config.explore_radius, ring)
                {
                    radius = r;
                }
            }
        }
        let target = arena_sim_domain::explore_target(home, beacon, initial as usize, radius);
        let next = (initial + 1) % 8;
        self.patrol_dirs.insert(unit_id.to_string(), next);
        if next == 0 {
            let ring = self.patrol_rings.get(unit_id).copied().unwrap_or(0);
            self.patrol_rings.insert(unit_id.to_string(), ring + 1);
        }
        target
    }
}

/// 满载 Worker 让位 Core 时的确定性探测方向顺序（UP → RIGHT → DOWN →
/// LEFT，对齐 TS 版破锁语义）。
pub const YIELD_ORDER: [Direction; 4] = [
    Direction::Up,
    Direction::Right,
    Direction::Down,
    Direction::Left,
];

/// 生成 spiralPoint 环上目标点：64 方位角分辨率，方位角 = focus 方位
/// （45°×8）+ 单位 ID 哈希偏移 + 环进度 angle；半径按 ring 缩放。
fn spiral_point(
    home: Position,
    focus: Position,
    unit_id: &str,
    _ring: i32,
    angle: i32,
    radius: i32,
) -> Position {
    let base = octant_of(focus[0] - home[0], focus[1] - home[1]) * 8;
    let offset = id_hash(unit_id, 64);
    let total = (((base + offset + angle) % 64) + 64) % 64;
    let theta = (total as f64) / 64.0 * 2.0 * std::f64::consts::PI;
    let x = home[0] + (theta.cos() * radius as f64).round() as i32;
    let y = home[1] + (theta.sin() * radius as f64).round() as i32;
    [x, y]
}

/// 单位 ID 的确定性哈希偏移（Go `for ch { offset = (offset*31+ch)%n }`）。
fn id_hash(unit_id: &str, modulus: i32) -> i32 {
    let mut offset: i32 = 0;
    for ch in unit_id.bytes() {
        offset = (offset * 31 + ch as i32) % modulus;
    }
    offset
}

/// 将方向向量映射到 0..7 八方位索引（0=E,1=SE,2=S,3=SW,4=W,5=NW,6=N,7=NE）。
fn octant_of(dx: i32, dy: i32) -> i32 {
    if dx == 0 && dy == 0 {
        return 0;
    }
    let angle = (dy as f64).atan2(dx as f64);
    let octant = (angle / (std::f64::consts::PI / 4.0)).round() as i32;
    ((octant % 8) + 8) % 8
}

/// 将指挥焦点方位转为 Core 迁移的四方向：octant 0/1→E、2/3→S、4/5→W、
/// 6/7→N。焦点与 home 重合返回 None。
fn migration_direction(focus: Position, home: Position) -> Option<Direction> {
    if focus == home {
        return None;
    }
    let octant = octant_of(focus[0] - home[0], focus[1] - home[1]);
    let direction = match octant {
        0 | 1 => Direction::Right,
        2 | 3 => Direction::Down,
        4 | 5 => Direction::Left,
        _ => Direction::Up,
    };
    Some(direction)
}

/// 检查四方向相邻格（UP→RIGHT→DOWN→LEFT 确定性顺序），返回第一个含
/// 敌方单位的方向；无相邻敌人返回 None。
fn adjacent_enemy_sweep(state: &TickState, position: Position) -> Option<Direction> {
    for direction in [
        Direction::Up,
        Direction::Right,
        Direction::Down,
        Direction::Left,
    ] {
        let adjacent = move_position(position, direction);
        if state
            .visible_enemies
            .iter()
            .any(|enemy| enemy.position == adjacent)
        {
            return Some(direction);
        }
    }
    None
}

/// 返回范围内最近的敌方单位（Manhattan 距离，平局取 ID 升序）。
fn nearest_enemy(
    state: &TickState,
    from: Position,
    radius: i32,
) -> Option<&arena_sim_domain::VisibleEntity> {
    state
        .visible_enemies
        .iter()
        .filter(|enemy| manhattan(from, enemy.position) <= radius)
        .min_by_key(|enemy| (manhattan(from, enemy.position), enemy.id.clone()))
}

/// 返回 Core 位置（None = 无 Core）。
fn core_position_of(state: &TickState) -> Option<Position> {
    state.core.as_ref().map(|core| core.position)
}

/// 返回目标方向的垂直方向列表（确定性顺序）：目标主要沿 X 轴 →
/// UP/DOWN；目标主要沿 Y 轴 → LEFT/RIGHT。
fn perpendicular_to(from: Position, target: Position) -> Vec<Direction> {
    let dx = target[0] - from[0];
    let dy = target[1] - from[1];
    if dx.abs() >= dy.abs() {
        vec![Direction::Up, Direction::Down]
    } else {
        vec![Direction::Left, Direction::Right]
    }
}

/// 返回远离目标方向的确定性方向（与目标主轴向相反）。
fn away_direction(from: Position, target: Position) -> Direction {
    let dx = target[0] - from[0];
    let dy = target[1] - from[1];
    if dx < 0 {
        Direction::Right
    } else if dx > 0 {
        Direction::Left
    } else if dy < 0 {
        Direction::Down
    } else if dy > 0 {
        Direction::Up
    } else {
        Direction::Left
    }
}

/// 移动候选（目标格 + 任务优先级）——统一使用 economic::MoveCandidate。
pub use economic::MoveCandidate;

/// 从动作 intent 映射任务优先级（deposit/return > harvest > combat >
/// explore）。非移动动作不产生目标格，不会进入仲裁。
fn move_priority_for(intent: &str) -> economic::MovePriority {
    match intent {
        "deposit" | "return_core" | "yield_full_core" => economic::MovePriority::Return,
        "harvest" | "to_resource" => economic::MovePriority::Harvest,
        "engage" | "defend" | "to_core_heal" => economic::MovePriority::Combat,
        _ => economic::MovePriority::Explore,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_values() {
        let config = Config::default();
        assert_eq!(config.worker_target, 13);
        assert_eq!(config.population_ceiling, 16);
        assert_eq!(config.explore_radius, 17);
        assert_eq!(config.threat_distance, 5);
        assert_eq!(config.spawn_reserve, 0);
        assert_eq!(config.military_ratio, 25);
        assert!(!config.enable_core_migration);
    }

    #[test]
    fn id_hash_is_deterministic_and_scattered() {
        assert_eq!(id_hash("worker-1", 8), id_hash("worker-1", 8));
        assert_ne!(id_hash("worker-1", 8), id_hash("worker-2", 8));
    }

    #[test]
    fn octant_and_migration_direction() {
        assert_eq!(octant_of(1, 0), 0); // E
        assert_eq!(octant_of(0, -1), 6); // N
        assert_eq!(migration_direction([10, 0], [0, 0]), Some(Direction::Right));
        assert_eq!(migration_direction([0, 0], [0, 0]), None);
    }

    #[test]
    fn perpendicular_and_away() {
        // 目标在右（主 X 轴）→ 垂直方向 UP/DOWN；远离 → LEFT。
        let from = [0, 0];
        let target = [5, 0];
        assert_eq!(
            perpendicular_to(from, target),
            vec![Direction::Up, Direction::Down]
        );
        assert_eq!(away_direction(from, target), Direction::Left);
    }

    #[test]
    fn spiral_point_ring_geometry() {
        // 半径 17 的环上点应在距离 home 17 附近（整数舍入）。
        let point = spiral_point([0, 0], [17, 0], "worker-1", 0, 0, 17);
        let distance = chebyshev([0, 0], point);
        assert!(
            (10..=24).contains(&distance),
            "spiral point too far: {point:?}"
        );
    }

    #[test]
    fn move_priority_mapping() {
        assert_eq!(move_priority_for("deposit"), economic::MovePriority::Return);
        assert_eq!(
            move_priority_for("to_resource"),
            economic::MovePriority::Harvest
        );
        assert_eq!(move_priority_for("engage"), economic::MovePriority::Combat);
        assert_eq!(move_priority_for("patrol"), economic::MovePriority::Explore);
    }
}
