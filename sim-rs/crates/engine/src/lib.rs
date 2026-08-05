//! Digital Twin 规则结算引擎（从 go-rewrite `internal/sim` 移植）。
//!
//! 输入 TickState + Plan，确定性结算下一 tick 的状态变化。
//! 结算顺序（裁决语义）：MOVE（让位）→ HARVEST/DEPOSIT → COMBAT →
//! ENEMY_ATTACK → 单位 HEAL → Core 动作（SPAWN/HEAL/REPAIR_SHIELD）→
//! rebuildColumns → refill/reveal。

pub mod combat;
pub mod economy;
pub mod enemy_attack;
pub mod heal;
pub mod movement;
pub mod refill;
pub mod spawn;
pub mod util;
pub mod vision;

// 常用类型 re-export（Go 版同为 sim 包顶层）。
pub use refill::RefillConfig;

#[cfg(test)]
mod engine_tests;

use arena_sim_domain::{Event, Plan, TickState};

/// 单 tick 结算统计（遥测/赛马指标，与 Go `SettleStats` 一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SettleStats {
    pub moves: i32,
    pub blocked: i32,
    pub harvests: i32,
    pub deposits: i32,
    pub spawns: i32,
    pub spawn_blocked: i32,
    pub resource_delta: i32,
    pub kills: i32,
    pub shots_fired: i32,
    pub sweeps_fired: i32,
    pub units_lost: i32,
    pub hp_recovered: i32,
    pub shield_repaired: i32,
}

/// 单 tick 结算产物（与 Go `SettleResult` 一致）。
#[derive(Debug, Clone)]
pub struct SettleResult {
    pub next_state: TickState,
    pub events: Vec<Event>,
    pub stats: SettleStats,
}

/// 确定性结算引擎（默认无状态，并发安全；挂载 Refill 后跨 tick 有状态
/// ——单写者使用，与 runtime Loop 一致）。
#[derive(Debug, Default)]
pub struct Engine {
    /// 资源补满引擎（官方规则：4 tick 配额 + 视野揭示）；
    /// None = 不启用（纯结算，fixture 回放路径不受影响）。
    pub refill: Option<refill::RefillConfig>,
}

impl Engine {
    pub fn new() -> Engine {
        Engine::default()
    }

    /// 结算一个 tick：应用移动、经济活动、战斗与 Core 动作，产出下一状态
    /// （深拷贝语义，与 Go `Settle` 一致：不修改输入）。
    pub fn settle(&mut self, state: &TickState, plan: &Plan) -> SettleResult {
        let mut next = util::clone_state(state);
        let (events, stats) = self.settle_into(&mut next, plan);
        SettleResult {
            next_state: next,
            events,
            stats,
        }
    }

    /// 原地结算：直接修改传入状态（不克隆——批量评估/长跑热路径，避免
    /// 每 tick 深拷贝分配；等价于 Go `SettleInPlace` + 调用方继续持有
    /// state 的用法）。返回 (事件, 统计)，修改后的状态即传入的 state。
    pub fn settle_in_place(
        &mut self,
        state: &mut TickState,
        plan: &Plan,
    ) -> (Vec<Event>, SettleStats) {
        self.settle_into(state, plan)
    }

    /// settleInto 是结算主体：在 next 状态上就地应用全部阶段。
    fn settle_into(&mut self, next: &mut TickState, plan: &Plan) -> (Vec<Event>, SettleStats) {
        let mut events = Vec::with_capacity(8);
        let mut stats = SettleStats::default();

        // MOVE / 收集 HARVEST/DEPOSIT 名单（BTreeMap 迭代 = 确定性 ID 升序）。
        let mut harvest_workers = Vec::new();
        let mut deposit_workers = Vec::new();
        for (unit_id, action) in &plan.unit_actions {
            match action.kind {
                arena_sim_domain::UnitActionKind::Move => {
                    let (moved, blocked) = movement::apply_move(next, unit_id, action, &mut stats);
                    if moved {
                        events.push(movement::move_event(
                            next.tick,
                            unit_id,
                            action.direction,
                            None,
                        ));
                    } else if blocked.is_some() {
                        events.push(movement::move_event(next.tick, unit_id, None, blocked));
                    }
                }
                arena_sim_domain::UnitActionKind::Harvest => harvest_workers.push(unit_id.clone()),
                arena_sim_domain::UnitActionKind::Deposit => deposit_workers.push(unit_id.clone()),
                _ => {}
            }
        }

        let harvest_events =
            economy::apply_harvests(next, &harvest_workers, &mut stats, self.refill.as_mut());
        let deposit_events = economy::apply_deposits(next, &deposit_workers, &mut stats);
        events.extend(harvest_events);
        events.extend(deposit_events);

        let combat_events = combat::apply_combat(next, plan, &mut stats);
        events.extend(combat_events);

        // 敌方攻击（官方对称语义）：敌方单位攻击我方单位/Core，死亡移除。
        let enemy_events = enemy_attack::apply_enemy_attacks(next, &mut stats);
        events.extend(enemy_events);

        // 单位 HEAL（战斗伤害后、Core 动作前；升序 ID 先结算）。
        let heal_events = heal::apply_unit_heals(next, plan);
        for event in &heal_events {
            if event.event_type == "UNIT_HEAL_SUCCEEDED" {
                if let Some(amount) = event.values.get("amount").and_then(|v| v.as_i64()) {
                    stats.hp_recovered += amount as i32;
                }
            }
        }
        events.extend(heal_events);

        let core_events = spawn::apply_core_action(next, plan.core_action.as_ref());
        for event in &core_events {
            match event.event_type.as_str() {
                "SPAWN" => stats.spawns += 1,
                "SPAWN_BLOCKED_CORE_OCCUPIED" => stats.spawn_blocked += 1,
                "CORE_HEAL_SUCCEEDED" => {
                    if let Some(amount) = event.values.get("amount").and_then(|v| v.as_i64()) {
                        stats.hp_recovered += amount as i32;
                    }
                }
                "CORE_SHIELD_REPAIRED" => stats.shield_repaired += 1,
                _ => {}
            }
        }
        events.extend(core_events);

        // 一致性：分列从 Units 重建——结算只修改 Units 的位置/cargo，
        // 若不回写分列，决策（读 Units）与分配（读分列）会看到不同状态。
        util::rebuild_columns(next);

        // 资源 refill + 视野揭示（官方规则）。
        if let Some(refill) = &mut self.refill {
            refill.apply_refill_and_reveal(next);
        }

        (events, stats)
    }
}
