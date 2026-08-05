//! simrun：独立模拟器 CLI（与 Go `cmd/simrun` 对偶）——从场景 JSON 加载
//! 初始状态 + 潜在资源池，批量并发评估策略，输出统计/时间线/对比。
//!
//! 用法：
//! ```bash
//! cargo run --release -p arena-sim-cli --bin simrun -- --scene 'runtime/scenes/*.json' --ticks 500
//! cargo run --release -p arena-sim-cli --bin simrun -- --scene 'runtime/scenes/*.json' --policy 'policies/*.json' --race --workers 8
//! ```

use std::process::ExitCode;

use arena_sim_cli::{batch, load_policies, load_scenes, BatchOption, Scenario};
use arena_sim_strategy::Config;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let mut scene_glob: Option<String> = None;
    let mut policy_glob: Option<String> = None;
    let mut race = false;
    let mut ticks = 300;
    let mut workers = 8;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--scene" => {
                i += 1;
                scene_glob = args.get(i).cloned();
            }
            "--policy" => {
                i += 1;
                policy_glob = args.get(i).cloned();
            }
            "--race" => race = true,
            "--ticks" => {
                i += 1;
                if let Some(v) = args.get(i).and_then(|v| v.parse().ok()) {
                    ticks = v;
                }
            }
            "--workers" => {
                i += 1;
                if let Some(v) = args.get(i).and_then(|v| v.parse().ok()) {
                    workers = v;
                }
            }
            "--help" | "-h" => {
                println!(
                    "usage: simrun --scene <scenes/*.json> [--policy <policies/*.json>] [--ticks N] [--workers N] [--race]"
                );
                return ExitCode::SUCCESS;
            }
            _ => {}
        }
        i += 1;
    }

    let Some(scene_glob) = scene_glob else {
        eprintln!("usage: simrun --scene <scenes/*.json> [--policy <policies/*.json>] [--ticks N] [--workers N] [--race]");
        return ExitCode::from(2);
    };

    let scenes = match load_scenes(&scene_glob) {
        Ok(scenes) => scenes,
        Err(err) => {
            eprintln!("load scenes: {err}");
            return ExitCode::FAILURE;
        }
    };
    let policies: Vec<(String, Config)> = match load_policies(policy_glob.as_deref().unwrap_or(""))
    {
        Ok(files) => files
            .iter()
            .map(|(name, file)| (name.clone(), file.to_config(name)))
            .collect(),
        Err(err) => {
            eprintln!("load policies: {err}");
            return ExitCode::FAILURE;
        }
    };
    if scenes.is_empty() {
        eprintln!("no scenes matched");
        return ExitCode::FAILURE;
    }
    let policies: Vec<Config> = if policies.is_empty() {
        eprintln!("no policies matched (default config used)");
        vec![Config::default()]
    } else {
        policies.into_iter().map(|(_, config)| config).collect()
    };

    let scenario_list: Vec<Scenario> = scenes
        .iter()
        .map(|(_, file)| Scenario {
            name: file.name.clone(),
            initial: file
                .initial
                .as_ref()
                .expect("initial checked")
                .to_tick_state(),
            latent_resources: file.latent_resources.clone(),
        })
        .collect();

    let results = batch(
        &scenario_list,
        &policies,
        ticks,
        BatchOption {
            workers: workers as usize,
            ..BatchOption::default()
        },
    );

    if race {
        print_race(&results);
    } else {
        print_summary(&results);
    }
    ExitCode::SUCCESS
}

/// 输出单策略结果摘要（与 Go printSummary 逐字节一致）。
fn print_summary(results: &[arena_sim_cli::BatchResult]) {
    for result in results {
        println!(
            "=== {} / {} ({} ticks) ===",
            result.scene, result.policy, result.ticks
        );
        println!(
            "  workers={} resources={}",
            result.final_state.workers.len(),
            result.final_state.resources
        );
        println!(
            "  spawns={} deposits={} harvests={}",
            result.stats.spawns, result.stats.deposits, result.stats.harvests
        );
        println!(
            "  kills={} unitsLost={} shots={} sweeps={}",
            result.stats.kills,
            result.stats.units_lost,
            result.stats.shots_fired,
            result.stats.sweeps_fired
        );
        println!("  timeline:");
        for point in &result.timeline {
            println!(
                "    t{:<5} res={:<4} cells={:<3} workers={} kills={} lost={} mode={}",
                point.tick,
                point.resources,
                point.resource_cells,
                point.workers,
                point.kills,
                point.units_lost,
                point.mode
            );
        }
    }
}

/// 输出多策略赛马对比表（与 Go printRace 逐字节一致）。
fn print_race(results: &[arena_sim_cli::BatchResult]) {
    println!("=== race ({} results) ===", results.len());
    println!(
        "{:<20} {:<24} {:>8} {:>8} {:>6} {:>6} {:>6} {:>6}",
        "scene", "policy", "workers", "res", "spawns", "deposits", "kills", "lost"
    );
    for result in results {
        println!(
            "{:<20} {:<24} {:>8} {:>8} {:>6} {:>6} {:>6} {:>6}",
            result.scene,
            result.policy,
            result.final_state.workers.len(),
            result.final_state.resources,
            result.stats.spawns,
            result.stats.deposits,
            result.stats.kills,
            result.stats.units_lost
        );
    }
}
