//! simgolden：回归黄金集（与 Go `cmd/simgolden/main.go` 对偶）——固定场景 ×
//! 默认策略快照关键指标，`--update` 写 runtime/golden.json，`--check` 容差
//! 比对（CI 门禁防策略回归）。
//!
//! 用法：
//! ```bash
//! simgolden --update              // 跑 3 场景 × 默认策略，写 runtime/golden.json
//! simgolden --check               // 跑并比对，超容差 → exit 1
//! ```

use std::fs;
use std::process::ExitCode;

use arena_sim_cli::{batch, load_scenes, BatchOption, GoldenFile, GoldenSnapshot, Scenario};
use arena_sim_strategy::Config;

/// 容差配置（与 Go 常量一致）：Deposits 是核心经济指标（宽松 25% 防噪音），
/// UnitsLost 是危险指标（硬性：超过基线 +1 即 FAIL）。
const DEPOSITS_TOLERANCE: f64 = 0.25;
const SPAWNS_TOLERANCE: f64 = 0.25;
const WORKERS_TOLERANCE: f64 = 0.20;
const KILLS_TOLERANCE: f64 = 0.50;
const BLOCKED_RATIO_TOLERANCE: f64 = 0.30;
const UNITS_LOST_HARD_LIMIT: i32 = 1;

const GOLDEN_PATH: &str = "runtime/golden.json";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut update = false;
    let mut ticks = 500;
    let mut workers = 8;

    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        let (name, inline) = match arg.strip_prefix("--").or_else(|| arg.strip_prefix('-')) {
            Some(rest) if !rest.is_empty() => match rest.split_once('=') {
                Some((name, value)) => (name, Some(value.to_string())),
                None => (rest, None),
            },
            // Go flag 在第一个位置参数处停止解析。
            _ => break,
        };
        match name {
            "update" => match inline {
                Some(value) => match parse_bool(&value) {
                    Some(v) => update = v,
                    None => {
                        eprintln!("invalid boolean value \"{value}\" for flag -update");
                        eprintln!("usage: simgolden [--update] [--ticks N] [--workers N]");
                        return ExitCode::from(2);
                    }
                },
                None => update = true,
            },
            // 与 Go 对齐：--update 执行更新，否则（含 --check）执行容差比对。
            "check" => match inline {
                Some(value) => match parse_bool(&value) {
                    Some(v) => update = !v,
                    None => {
                        eprintln!("invalid boolean value \"{value}\" for flag -check");
                        eprintln!("usage: simgolden [--update] [--ticks N] [--workers N]");
                        return ExitCode::from(2);
                    }
                },
                None => update = false,
            },
            "ticks" => match flag_int_value(name, inline, &args, &mut i) {
                Ok(v) => ticks = v,
                Err(msg) => return flag_error(&msg),
            },
            "workers" => match flag_int_value(name, inline, &args, &mut i) {
                Ok(v) => workers = v,
                Err(msg) => return flag_error(&msg),
            },
            _ => {
                eprintln!("flag provided but not defined: -{name}");
                eprintln!("usage: simgolden [--update] [--ticks N] [--workers N]");
                return ExitCode::from(2);
            }
        }
        i += 1;
    }

    let scenes = match load_scenes("runtime/scenes/*.json") {
        Ok(scenes) => scenes,
        Err(err) => {
            eprintln!("load scenes: {err}");
            return ExitCode::FAILURE;
        }
    };
    let policy = Config {
        name: "default".to_string(),
        ..Config::default()
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
        &[policy],
        ticks,
        BatchOption {
            workers: workers as usize,
            ..BatchOption::default()
        },
    );

    if update {
        let snapshots = make_snapshots(&results);
        let file = GoldenFile {
            ticks,
            policies: vec!["default".to_string()],
            scenes: snapshots,
        };
        let data = match serde_json::to_string_pretty(&file) {
            Ok(data) => data,
            Err(err) => {
                eprintln!("marshal golden: {err}");
                return ExitCode::FAILURE;
            }
        };
        if let Err(err) = fs::write(GOLDEN_PATH, data) {
            eprintln!("write golden: {err}");
            return ExitCode::FAILURE;
        }
        println!(
            "golden updated: {} ({} scenes × {} ticks)",
            GOLDEN_PATH,
            file.scenes.len(),
            ticks
        );
        return ExitCode::SUCCESS;
    }

    // 默认 --check。
    let data = match fs::read_to_string(GOLDEN_PATH) {
        Ok(data) => data,
        Err(err) => {
            eprintln!("read golden: {err} (run simgolden --update first)");
            return ExitCode::FAILURE;
        }
    };
    let golden: GoldenFile = match serde_json::from_str(&data) {
        Ok(file) => file,
        Err(err) => {
            eprintln!("parse golden: {err}");
            return ExitCode::FAILURE;
        }
    };
    if golden.ticks != ticks {
        eprintln!(
            "golden ticks={}, run ticks={} (re-run --update)",
            golden.ticks, ticks
        );
        return ExitCode::FAILURE;
    }
    let (exit_code, lines) = compare_snapshot_lines(&golden.scenes, &make_snapshots(&results));
    for line in &lines {
        println!("{line}");
    }
    ExitCode::from(exit_code as u8)
}

/// 从 Batch 结果构建快照（确定性：scene 名升序，batch 已保证）。
fn make_snapshots(results: &[arena_sim_cli::BatchResult]) -> Vec<GoldenSnapshot> {
    results
        .iter()
        .map(|result| GoldenSnapshot {
            scene: result.scene.clone(),
            deposits: result.stats.deposits,
            spawns: result.stats.spawns,
            workers: result.final_state.workers.len() as i32,
            kills: result.stats.kills,
            units_lost: result.stats.units_lost,
            blocked: result.stats.blocked,
            moves: result.stats.moves,
            resources: result.final_state.resources,
        })
        .collect()
}

/// 比对黄金集，返回 (退出码, 输出行)（与 Go `compareSnapshots` 逐字节一致）。
fn compare_snapshot_lines(
    golden: &[GoldenSnapshot],
    current: &[GoldenSnapshot],
) -> (i32, Vec<String>) {
    if golden.len() != current.len() {
        return (
            1,
            vec![format!(
                "FAIL: scene count changed: golden={} current={}",
                golden.len(),
                current.len()
            )],
        );
    }
    let mut failures = 0;
    let mut lines = Vec::new();
    for (g, c) in golden.iter().zip(current.iter()) {
        if g.scene != c.scene {
            return (
                1,
                vec![format!(
                    "FAIL: scene order changed: golden={} current={}",
                    g.scene, c.scene
                )],
            );
        }
        // Deposits：核心经济指标，容差内允许浮动。
        if !within_tolerance(g.deposits, c.deposits, DEPOSITS_TOLERANCE) {
            lines.push(format!(
                "FAIL [{}]: deposits {} → {} (tolerance {:.0}%)",
                g.scene,
                g.deposits,
                c.deposits,
                DEPOSITS_TOLERANCE * 100.0
            ));
            failures += 1;
        }
        if !within_tolerance(g.spawns, c.spawns, SPAWNS_TOLERANCE) {
            lines.push(format!(
                "FAIL [{}]: spawns {} → {} (tolerance {:.0}%)",
                g.scene,
                g.spawns,
                c.spawns,
                SPAWNS_TOLERANCE * 100.0
            ));
            failures += 1;
        }
        if !within_tolerance(g.workers, c.workers, WORKERS_TOLERANCE) {
            lines.push(format!(
                "FAIL [{}]: workers {} → {} (tolerance {:.0}%)",
                g.scene,
                g.workers,
                c.workers,
                WORKERS_TOLERANCE * 100.0
            ));
            failures += 1;
        }
        if !within_tolerance(g.kills, c.kills, KILLS_TOLERANCE) {
            lines.push(format!(
                "FAIL [{}]: kills {} → {} (tolerance {:.0}%)",
                g.scene,
                g.kills,
                c.kills,
                KILLS_TOLERANCE * 100.0
            ));
            failures += 1;
        }
        // UnitsLost：硬性（超过基线 +1 = FAIL，死循环/战斗回归强信号）。
        if c.units_lost > g.units_lost + UNITS_LOST_HARD_LIMIT {
            lines.push(format!(
                "FAIL [{}]: unitsLost {} → {} (hard limit +{})",
                g.scene, g.units_lost, c.units_lost, UNITS_LOST_HARD_LIMIT
            ));
            failures += 1;
        }
        // Blocked/Moves 比例：死循环代理（blocked 占比暴涨 = 拥堵回归）。
        let g_ratio = blocked_ratio(g.blocked, g.moves);
        let c_ratio = blocked_ratio(c.blocked, c.moves);
        if g_ratio > 0.0 && c_ratio > g_ratio * (1.0 + BLOCKED_RATIO_TOLERANCE) {
            lines.push(format!(
                "FAIL [{}]: blocked ratio {:.2} → {:.2} (tolerance {:.0}%)",
                g.scene,
                g_ratio,
                c_ratio,
                BLOCKED_RATIO_TOLERANCE * 100.0
            ));
            failures += 1;
        }
        if c.units_lost > g.units_lost {
            lines.push(format!(
                "WARN [{}]: unitsLost {} → {} (within hard limit)",
                g.scene, g.units_lost, c.units_lost
            ));
        }
    }
    if failures == 0 {
        lines.push(format!("PASS: {} scenes within tolerance", golden.len()));
        return (0, lines);
    }
    (1, lines)
}

/// |a-b| <= tolerance*max(1,a)（与 Go `withinTolerance` 一致）。
fn within_tolerance(a: i32, b: i32, tolerance: f64) -> bool {
    (a as f64 - b as f64).abs() <= tolerance * (a.max(1) as f64)
}

/// blocked/moves（moves=0 时返回 0；与 Go `blockedRatio` 一致）。
fn blocked_ratio(blocked: i32, moves: i32) -> f64 {
    if moves == 0 {
        return 0.0;
    }
    blocked as f64 / moves as f64
}

/// 取 `-name value` 或 `-name=value` 的整数值（Go flag 语义）。
fn flag_int_value(
    name: &str,
    inline: Option<String>,
    args: &[String],
    pos: &mut usize,
) -> Result<i32, String> {
    let value = match inline {
        Some(value) => value,
        None => {
            *pos += 1;
            args.get(*pos)
                .cloned()
                .ok_or_else(|| format!("flag needs an argument: -{name}"))?
        }
    };
    value
        .parse::<i32>()
        .map_err(|_| format!("invalid value \"{value}\" for flag -{name}: parse error"))
}

/// 解析 Go flag 布尔值（"1"/"t"/"T"/"true"/"TRUE"/"True" 等）。
fn parse_bool(value: &str) -> Option<bool> {
    match value.to_ascii_lowercase().as_str() {
        "1" | "t" | "true" => Some(true),
        "0" | "f" | "false" => Some(false),
        _ => None,
    }
}

fn flag_error(msg: &str) -> ExitCode {
    eprintln!("{msg}");
    eprintln!("usage: simgolden [--update] [--ticks N] [--workers N]");
    ExitCode::from(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within_tolerance_bounds() {
        // 边界上（== 允许）通过。
        assert!(within_tolerance(100, 125, 0.25));
        assert!(within_tolerance(100, 100, 0.25));
        // 超过容差 FAIL。
        assert!(!within_tolerance(100, 126, 0.25));
        // 基数为 0 时按 max(1, a) 计（a=0 → 基准 1）。
        assert!(within_tolerance(0, 0, 0.25));
        assert!(!within_tolerance(0, 2, 0.25));
    }

    #[test]
    fn blocked_ratio_zero_moves() {
        assert_eq!(blocked_ratio(5, 0), 0.0);
        assert_eq!(blocked_ratio(0, 0), 0.0);
        assert!((blocked_ratio(3, 10) - 0.3).abs() < 1e-12);
    }

    #[test]
    fn scene_count_mismatch_fails() {
        let current = vec![GoldenSnapshot {
            scene: "base".to_string(),
            ..sample_snapshot("base")
        }];
        let (code, lines) = compare_snapshot_lines(&[], &current);
        assert_eq!(code, 1);
        assert_eq!(lines, vec!["FAIL: scene count changed: golden=0 current=1"]);
    }

    #[test]
    fn scene_order_changed_fails() {
        let golden = vec![sample_snapshot("base")];
        let current = vec![sample_snapshot("dense")];
        let (code, lines) = compare_snapshot_lines(&golden, &current);
        assert_eq!(code, 1);
        assert_eq!(
            lines,
            vec!["FAIL: scene order changed: golden=base current=dense"]
        );
    }

    #[test]
    fn identical_snapshots_pass() {
        let golden = vec![sample_snapshot("base"), sample_snapshot("dense")];
        let current = golden.clone();
        let (code, lines) = compare_snapshot_lines(&golden, &current);
        assert_eq!(code, 0);
        assert_eq!(lines, vec!["PASS: 2 scenes within tolerance"]);
    }

    #[test]
    fn deposits_over_tolerance_fails() {
        let mut golden = sample_snapshot("base");
        let mut current = sample_snapshot("base");
        golden.deposits = 100;
        current.deposits = 70;
        let (code, lines) = compare_snapshot_lines(&[golden], &[current]);
        assert_eq!(code, 1);
        assert_eq!(lines[0], "FAIL [base]: deposits 100 → 70 (tolerance 25%)");
    }

    #[test]
    fn units_lost_hard_limit_and_warn() {
        let golden = sample_snapshot("base");
        let mut over = sample_snapshot("base");
        over.units_lost = 5;
        let (code, lines) = compare_snapshot_lines(std::slice::from_ref(&golden), &[over]);
        assert_eq!(code, 1);
        assert_eq!(lines[0], "FAIL [base]: unitsLost 0 → 5 (hard limit +1)");
        assert_eq!(lines[1], "WARN [base]: unitsLost 0 → 5 (within hard limit)");

        let mut within = sample_snapshot("base");
        within.units_lost = 1;
        let (code, lines) = compare_snapshot_lines(&[golden], &[within]);
        assert_eq!(code, 0);
        assert_eq!(lines[0], "WARN [base]: unitsLost 0 → 1 (within hard limit)");
        assert_eq!(lines[1], "PASS: 1 scenes within tolerance");
    }

    #[test]
    fn blocked_ratio_tolerance_fails() {
        let mut golden = sample_snapshot("base");
        let mut current = sample_snapshot("base");
        golden.blocked = 10;
        golden.moves = 100;
        current.blocked = 60;
        current.moves = 100;
        let (code, lines) = compare_snapshot_lines(&[golden], &[current]);
        assert_eq!(code, 1);
        assert_eq!(
            lines[0],
            "FAIL [base]: blocked ratio 0.10 → 0.60 (tolerance 30%)"
        );
    }

    #[test]
    fn golden_file_serializes_go_shape() {
        let file = GoldenFile {
            ticks: 500,
            policies: vec!["default".to_string()],
            scenes: vec![sample_snapshot("base")],
        };
        let data = serde_json::to_string_pretty(&file).expect("serialize");
        assert_eq!(
            data,
            "{\n  \"ticks\": 500,\n  \"policies\": [\n    \"default\"\n  ],\n  \
             \"scenes\": [\n    {\n      \"scene\": \"base\",\n      \"deposits\": 71,\n      \
             \"spawns\": 13,\n      \"workers\": 13,\n      \"kills\": 0,\n      \
             \"unitsLost\": 0,\n      \"blocked\": 1,\n      \"moves\": 2704,\n      \
             \"resources\": 4\n    }\n  ]\n}"
        );
    }

    fn sample_snapshot(scene: &str) -> GoldenSnapshot {
        GoldenSnapshot {
            scene: scene.to_string(),
            deposits: 71,
            spawns: 13,
            workers: 13,
            kills: 0,
            units_lost: 0,
            blocked: 1,
            moves: 2704,
            resources: 4,
        }
    }
}
