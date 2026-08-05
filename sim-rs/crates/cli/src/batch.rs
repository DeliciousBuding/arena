//! 并发批量评估（与 Go `internal/sim/batch.go` 对偶）。
//!
//! 多场景 × 多策略全组合 rayon 并行；结果确定性排序：scene 名升序 ×
//! policy 名升序（与 Go 一致）。每评估独立 Planner/Engine/Refill，
//! 零共享可变状态。

use arena_sim_domain::{Plan, Position, TickState};
use arena_sim_engine::{Engine, RefillConfig, SettleStats};
use arena_sim_strategy::{commander::DirectiveMode, Config, Planner};
use rayon::prelude::*;

use crate::policy_name::policy_name;

/// 独立场景（初始状态 + 潜在资源池）。
#[derive(Debug, Clone)]
pub struct Scenario {
    pub name: String,
    pub initial: TickState,
    pub latent_resources: Vec<Position>,
}

impl Scenario {
    /// 深拷贝初始状态（并发安全：每 worker 独立副本）。
    pub fn clone_state(&self) -> TickState {
        self.initial.clone()
    }
}

/// 逐 tick 关键指标采样（黄金集/赛马对比用；Interval 默认 25）。
#[derive(Debug, Clone)]
pub struct TimelinePoint {
    pub tick: i32,
    pub resources: i32,
    pub resource_cells: usize,
    pub workers: usize,
    pub deposits: i32,
    pub kills: i32,
    pub units_lost: i32,
    pub mode: String,
}

/// 单次评估结果（与 Go `BatchResult` 对偶）。
#[derive(Debug, Clone)]
pub struct BatchResult {
    pub scene: String,
    pub policy: String,
    pub ticks: i32,
    pub stats: SettleStats,
    pub final_state: TickState,
    pub score: f64,
    pub timeline: Vec<TimelinePoint>,
}

/// 批量评估配置。
#[derive(Debug, Clone)]
pub struct BatchOption {
    /// 并发线程数（0 = 默认 rayon 线程池）。
    pub workers: usize,
    /// Timeline 采样间隔（0 = 25）。
    pub interval: i32,
}

impl Default for BatchOption {
    fn default() -> Self {
        BatchOption {
            workers: 0,
            interval: 25,
        }
    }
}

/// 并发评估：scenes[i] × policies[j] 全组合并行跑 ticks 闭环。
/// 结果确定性顺序：scene 名升序 × policy 名升序。
pub fn batch(
    scenes: &[Scenario],
    policies: &[Config],
    ticks: i32,
    opt: BatchOption,
) -> Vec<BatchResult> {
    let interval = if opt.interval <= 0 { 25 } else { opt.interval };
    let thread_pool = if opt.workers > 0 {
        Some(
            rayon::ThreadPoolBuilder::new()
                .num_threads(opt.workers)
                .build()
                .expect("build rayon pool"),
        )
    } else {
        None
    };

    // 全组合索引（确定性顺序：scene 外循环 × policy 内循环）。
    let tasks: Vec<(usize, usize)> = (0..scenes.len())
        .flat_map(|scene_index| {
            (0..policies.len()).map(move |policy_index| (scene_index, policy_index))
        })
        .collect();

    let mut results: Vec<BatchResult> = if let Some(pool) = &thread_pool {
        pool.install(|| {
            tasks
                .par_iter()
                .map(|&(s, p)| run_scenario(&scenes[s], &policies[p], ticks, interval))
                .collect()
        })
    } else {
        tasks
            .par_iter()
            .map(|&(s, p)| run_scenario(&scenes[s], &policies[p], ticks, interval))
            .collect()
    };

    // 确定性顺序：scene 名升序 × policy 名升序。
    results.sort_by(|a, b| a.scene.cmp(&b.scene).then_with(|| a.policy.cmp(&b.policy)));
    results
}

/// 跑单个 场景×策略 组合（独立实例，可并发）。
fn run_scenario(scene: &Scenario, policy: &Config, ticks: i32, interval: i32) -> BatchResult {
    let mut state = scene.clone_state();
    let mut planner = Planner::new(policy.clone());
    let mut engine = Engine::new();
    engine.refill = Some(RefillConfig::new(&scene.latent_resources));

    let mut result = BatchResult {
        scene: scene.name.clone(),
        policy: policy_name(policy),
        ticks,
        stats: SettleStats::default(),
        final_state: state.clone(),
        score: 0.0,
        timeline: Vec::new(),
    };
    for tick in 1..=ticks {
        state.tick = tick;
        let plan: Plan = planner.decide(&state);
        let (_events, stats) = engine.settle_in_place(&mut state, &plan);
        result.stats.moves += stats.moves;
        result.stats.blocked += stats.blocked;
        result.stats.harvests += stats.harvests;
        result.stats.deposits += stats.deposits;
        result.stats.spawns += stats.spawns;
        result.stats.spawn_blocked += stats.spawn_blocked;
        result.stats.resource_delta += stats.resource_delta;
        result.stats.kills += stats.kills;
        result.stats.shots_fired += stats.shots_fired;
        result.stats.sweeps_fired += stats.sweeps_fired;
        result.stats.units_lost += stats.units_lost;
        result.stats.hp_recovered += stats.hp_recovered;
        result.stats.shield_repaired += stats.shield_repaired;
        if tick % interval == 0 || tick == ticks {
            result.timeline.push(TimelinePoint {
                tick,
                resources: state.resources,
                resource_cells: state.resource_cells.len(),
                workers: state.workers.len(),
                deposits: result.stats.deposits,
                kills: result.stats.kills,
                units_lost: result.stats.units_lost,
                mode: directive_mode_str(planner.directive_mode()),
            });
        }
    }
    result.final_state = state;
    result
}

/// 指挥模式字符串（与 Go DirectiveMode 一致）。
pub fn directive_mode_str(mode: DirectiveMode) -> String {
    match mode {
        DirectiveMode::Growth => "GROWTH".to_string(),
        DirectiveMode::ExploreStarved => "EXPLORE_STARVED".to_string(),
        DirectiveMode::MigrateCand => "MIGRATE_CAND".to_string(),
    }
}
