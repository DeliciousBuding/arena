//! 指挥层（从 go-rewrite `internal/strategy/commander.go` 移植）：
//! 观察全局经济态势（资源/工人/可见资源格/停滞计数），输出确定性
//! 模式指令。战术层（Planner）按指令调整行为。

use arena_sim_domain::TickState;
use serde::{Deserialize, Serialize};

/// 全局指挥模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum DirectiveMode {
    /// 正常扩张（默认）。
    Growth,
    /// 资源枯竭：集中扫掠。
    ExploreStarved,
    /// 迁移候选（只评估不执行）。
    MigrateCand,
}

/// 模式切换阈值。
pub const STARVED_THRESHOLD_TICKS: i32 = 30; // 无进展连续 tick 数 → EXPLORE_STARVED
pub const MIGRATE_CANDIDATE_TICKS: i32 = 100; // EXPLORE_STARVED 持续 → MIGRATE_CAND

/// 指挥层输出（每 tick 由 Loop 传递给 Planner）。
/// JSON 形状对齐 Go `strategy.Directive`：`{"Mode":"GROWTH","Focus":[0,0]}`。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Directive {
    pub mode: DirectiveMode,
    /// 探索焦点（EXPLORE_STARVED 时所有 worker 朝此方向扫掠；默认
    /// Beacon 方位）。
    pub focus: arena_sim_domain::Position,
}

/// 指挥层（跨 tick 持久：停滞计数与最近指标）。
#[derive(Debug, Default)]
pub struct Commander {
    no_progress_ticks: i32,
    last_resources: i32,
    last_workers: i32,
}

impl Commander {
    pub fn new() -> Commander {
        Commander::default()
    }

    /// 每 tick 调用：观察全局指标，返回当前指令。
    /// 无进展定义：资源未增 + 工人未增 + 零可见资源格（连续计数）。
    /// 任一进展出现即重置计数（回到 GROWTH）。
    pub fn update(&mut self, state: &TickState) -> Directive {
        let workers = state.workers.len() as i32;
        if state.resources > self.last_resources
            || workers > self.last_workers
            || !state.resource_cells.is_empty()
        {
            self.no_progress_ticks = 0;
        } else {
            self.no_progress_ticks += 1;
        }
        self.last_resources = state.resources;
        self.last_workers = workers;

        let mode = if self.no_progress_ticks >= MIGRATE_CANDIDATE_TICKS {
            DirectiveMode::MigrateCand
        } else if self.no_progress_ticks >= STARVED_THRESHOLD_TICKS {
            DirectiveMode::ExploreStarved
        } else {
            DirectiveMode::Growth
        };
        Directive {
            mode,
            focus: state.beacon.position,
        }
    }

    /// 重置指挥层（测试/运维用）。
    pub fn reset(&mut self) {
        self.no_progress_ticks = 0;
        self.last_resources = 0;
        self.last_workers = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use arena_sim_domain::{Beacon, BeaconStatus, Core, CoreState, CoreStatus};

    fn state_with(resources: i32, workers: usize, cells: usize) -> TickState {
        let mut resource_cells: arena_sim_domain::CellSet = Default::default();
        for i in 0..cells {
            resource_cells.insert(format!("{i},0"));
        }
        TickState {
            tick: 1,
            status: CoreStatus::Active,
            resources,
            resource_capacity: 10,
            resource_space: 10,
            population: workers as i32,
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
            units: (0..workers)
                .map(|i| arena_sim_domain::UnitSnapshot {
                    id: format!("worker-{i}"),
                    position: [0, 0],
                    hp: 2,
                    unit_type: arena_sim_domain::UnitType::Worker,
                    cargo: 0,
                })
                .collect(),
            workers: Vec::new(),
            vanguards: Vec::new(),
            rangers: Vec::new(),
            visible_enemies: Vec::new(),
            resource_cells,
            obstacle_cells: Default::default(),
            beacon: Beacon {
                position: [10, 0],
                status: BeaconStatus::Ground,
                carrier_id: None,
            },
            events: Vec::new(),
            state_hash: String::new(),
        }
    }

    #[test]
    fn progress_resets_counter() {
        let mut commander = Commander::new();
        // 无进展 30 tick → 第 31 次 update 触发 EXPLORE_STARVED
        // （首次 update 因 resources>0 计为进展，与 Go 测试同语义）。
        let mut state = state_with(5, 2, 0);
        let mut mode = DirectiveMode::Growth;
        for _ in 0..30 {
            state.tick += 1;
            mode = commander.update(&state).mode;
        }
        assert_eq!(mode, DirectiveMode::Growth);
        state.tick += 1;
        mode = commander.update(&state).mode;
        assert_eq!(mode, DirectiveMode::ExploreStarved);
        // 资源增加 → 重置回 GROWTH。
        state.resources = 6;
        state.tick += 1;
        assert_eq!(commander.update(&state).mode, DirectiveMode::Growth);
    }

    #[test]
    fn visible_cells_count_as_progress() {
        let mut commander = Commander::new();
        let mut state = state_with(5, 2, 0);
        for _ in 0..30 {
            state.tick += 1;
            commander.update(&state);
        }
        state.resource_cells.insert("9,0".to_string());
        state.tick += 1;
        assert_eq!(commander.update(&state).mode, DirectiveMode::Growth);
    }

    #[test]
    fn migrate_candidate_after_100_ticks() {
        let mut commander = Commander::new();
        let mut state = state_with(5, 2, 0);
        let mut mode = DirectiveMode::Growth;
        for _ in 0..100 {
            state.tick += 1;
            mode = commander.update(&state).mode;
        }
        assert_eq!(mode, DirectiveMode::ExploreStarved); // 99 tick 无进展
        state.tick += 1;
        mode = commander.update(&state).mode; // 第 101 次：no_progress=100
        assert_eq!(mode, DirectiveMode::MigrateCand);
    }
}
