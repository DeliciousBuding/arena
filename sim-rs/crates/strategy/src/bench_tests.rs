//! 性能基准（与 Go `BenchmarkSim100Ticks/1000Ticks` 完全同场景：
//! benchState + 12 格 refill 池 + planner(workerTarget=6) + engine 闭环）。
//!
//! 运行（release 模式）：
//! ```bash
//! cargo test --release -p arena-sim-strategy -- --ignored --nocapture bench_
//! ```

use std::time::Instant;

use arena_sim_engine::{Engine, RefillConfig};

use super::loop_tests::{bench_latent, bench_state};
use crate::{Config, Planner};

/// bench 配置（与 Go bench_test 的 planner Config 一致）。
fn bench_config() -> Config {
    Config {
        worker_target: 6,
        population_ceiling: 16,
        explore_radius: 17,
        threat_distance: 5,
        spawn_reserve: 0,
        military_ratio: 25,
        ..Config::default()
    }
}

/// 跑 N tick 闭环（planner.decide + engine.settle_in_place + refill），
/// 返回墙钟耗时。与 Go runTicks 同构。
fn run_ticks(ticks: i32) -> std::time::Duration {
    let mut state = bench_state();
    let mut planner = Planner::new(bench_config());
    let mut engine = Engine::new();
    engine.refill = Some(RefillConfig::new(&bench_latent()));

    let start = Instant::now();
    for _ in 1..=ticks {
        state.tick += 1;
        let plan = planner.decide(&state);
        engine.settle_in_place(&mut state, &plan);
    }
    start.elapsed()
}

fn report(name: &str, elapsed: std::time::Duration, ticks: i32) {
    let ticks_per_sec = ticks as f64 / elapsed.as_secs_f64();
    println!("{name}: {elapsed:?} ({ticks_per_sec:.0} ticks/s)");
}

#[test]
#[ignore]
fn bench_100_ticks() {
    report("bench 100 ticks", run_ticks(100), 100);
}

#[test]
#[ignore]
fn bench_1000_ticks() {
    report("bench 1000 ticks", run_ticks(1000), 1000);
}

#[test]
#[ignore]
fn bench_5000_ticks() {
    report("bench 5000 ticks", run_ticks(5000), 5000);
}
