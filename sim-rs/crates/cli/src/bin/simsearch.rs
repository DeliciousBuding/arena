//! simsearch：大规模策略/死锁搜索（与 Go `cmd/simsearch` 对偶）。
//!
//! 并发跑「随机场景 × 参数网格」全组合，自动检测：
//!   - 经济冻结（长时间 0 deposit = 死锁/互堵）
//!   - 资源枯竭（工人不增长/不采）
//!   - 高频阻塞（blocked/moves 比例异常 = 振荡）
//!
//! 输出按冻结严重度排序的 TOP 场景+策略，用于发现算法漏洞。
//!
//! 用法：
//! ```bash
//! simsearch --scenes 40 --policies 24 --ticks 300 --workers 28
//! simsearch --scenes 200 --policies 100 --ticks 500 --workers 28
//! ```
//!
//! 随机场景/策略生成用共享库 SplitMix64（确定性，seed 参数化；
//! PARITY §8：序列与 Go math/rand 不同，仅保证 Rust 内部同 seed 一致）。

use std::fmt::Write as _;
use std::process::ExitCode;

use arena_sim_cli::{batch, BatchOption, Scenario, SplitMix64};
use arena_sim_domain::{
    manhattan, Beacon, BeaconStatus, Core, CoreState, CoreStatus, Position, TickState,
    UnitSnapshot, UnitType, CORE_MAX_HP, CORE_MAX_SHIELD,
};
use arena_sim_strategy::Config;

/// 策略网格取值（与 Go generatePolicies 一致）。
const WORKER_TARGETS: [i32; 6] = [4, 6, 8, 10, 13, 16];
const EXPLORE_RADII: [i32; 4] = [8, 12, 17, 24];
const RESERVES: [i32; 4] = [0, 1, 2, 3];
const MILITARY_RATIOS: [i32; 3] = [0, 25, 50];

/// 命令行参数（默认值与 Go flag 一致）。
struct Args {
    scenes: i64,
    policies: i64,
    ticks: i64,
    workers: i64,
    seed: i64,
    inspect: i64,
}

/// 参数解析结果（镜像 Go flag 语义：`-name value` / `-name=value`，
/// 首个位置参数后停止解析；错误 exit 2，help exit 0）。
enum ParseOutcome {
    Run(Args),
    Help,
    Error(String),
}

fn parse_args(args: &[String]) -> ParseOutcome {
    let mut parsed = Args {
        scenes: 40,
        policies: 24,
        ticks: 300,
        workers: 0,
        seed: 20260805,
        inspect: -1,
    };
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--" || !arg.starts_with('-') || arg.len() == 1 {
            // 位置参数或终止符：Go flag 停止解析，其余忽略。
            break;
        }
        let (flag, inline_value) = match arg.split_once('=') {
            Some((name, value)) => (name.trim_start_matches('-'), Some(value.to_string())),
            None => (arg.trim_start_matches('-'), None),
        };
        match flag {
            "scenes" | "policies" | "ticks" | "workers" | "seed" | "inspect" => {
                let value = match inline_value {
                    Some(value) => value,
                    None => {
                        i += 1;
                        match args.get(i) {
                            Some(value) => value.clone(),
                            None => {
                                return ParseOutcome::Error(format!(
                                    "flag needs an argument: -{flag}"
                                ));
                            }
                        }
                    }
                };
                let parsed_value: i64 = match value.parse() {
                    Ok(value) => value,
                    Err(_) => {
                        return ParseOutcome::Error(format!(
                            "invalid value \"{value}\" for flag -{flag}: parse error"
                        ));
                    }
                };
                match flag {
                    "scenes" => parsed.scenes = parsed_value,
                    "policies" => parsed.policies = parsed_value,
                    "ticks" => parsed.ticks = parsed_value,
                    "workers" => parsed.workers = parsed_value,
                    "seed" => parsed.seed = parsed_value,
                    "inspect" => parsed.inspect = parsed_value,
                    _ => unreachable!(),
                }
            }
            "h" | "help" => return ParseOutcome::Help,
            _ => {
                return ParseOutcome::Error(format!("flag provided but not defined: -{flag}"));
            }
        }
        i += 1;
    }
    ParseOutcome::Run(parsed)
}

fn print_usage() {
    eprintln!("Usage of simsearch:");
    eprintln!("  -inspect int");
    eprintln!("    \tprint scene details for this index and exit (default -1)");
    eprintln!("  -policies int");
    eprintln!("    \tpolicy grid count (default 24)");
    eprintln!("  -scenes int");
    eprintln!("    \trandom scenes count (default 40)");
    eprintln!("  -seed int");
    eprintln!("    \tdeterministic seed (default 20260805)");
    eprintln!("  -ticks int");
    eprintln!("    \tsimulation ticks (default 300)");
    eprintln!("  -workers int");
    eprintln!("    \tparallel workers (0 = NumCPU)");
}

/// 单次搜索评估结果（含冻结诊断，与 Go searchResult 一致）。
struct SearchResult {
    scene_name: String,
    policy_name: String,
    deposits: i32,
    harvests: i32,
    workers: usize,
    blocked: i32,
    moves: i32,
    /// 冻结 tick 数（连续无 deposit 的最长段）。
    frozen: i64,
    /// 冻结起始 tick（0 = 未冻结）。
    frozen_at: i64,
    /// 资源枯竭（harvests==0）。
    starvation: i32,
}

/// 生成确定性随机场景：Core 在原点附近，资源池随机散布
/// （chunk 配额语义：密度/距离可变——覆盖 dense 近程与 sparse 远程）。
/// 场景结构与 Go generateScenes 逐行一致，仅 RNG 换成 SplitMix64。
fn generate_scenes(count: i64, seed: i64) -> Vec<Scenario> {
    let mut rng = SplitMix64::new(seed as u64);
    let mut scenes = Vec::with_capacity(count as usize);
    for i in 0..count {
        let core: Position = [
            (rng.next_int(21) - 10) as i32,
            (rng.next_int(21) - 10) as i32,
        ];
        let worker_count = 1 + rng.next_int(2);
        let latent_count = 2 + rng.next_int(10);
        let mut latent = Vec::with_capacity(latent_count as usize);
        for _ in 0..latent_count {
            // 距离混合：40% 近程（Core 周围 8 内）、60% 远程（8-30）。
            if rng.next_int(100) < 40 {
                latent.push([
                    core[0] + rng.next_int(17) as i32 - 8,
                    core[1] + rng.next_int(17) as i32 - 8,
                ]);
            } else {
                latent.push([
                    core[0] + rng.next_int(61) as i32 - 30,
                    core[1] + rng.next_int(61) as i32 - 30,
                ]);
            }
        }
        let workers: Vec<UnitSnapshot> = (0..worker_count)
            .map(|w| {
                let position = if w > 0 {
                    [
                        core[0] + rng.next_int(9) as i32 - 4,
                        core[1] + rng.next_int(9) as i32 - 4,
                    ]
                } else {
                    core
                };
                UnitSnapshot {
                    id: format!("w-{w}"),
                    position,
                    hp: 2,
                    unit_type: UnitType::Worker,
                    cargo: 0,
                }
            })
            .collect();
        let initial = TickState {
            tick: 1,
            status: CoreStatus::Active,
            resources: 10,
            resource_capacity: 10,
            resource_space: 0,
            population: worker_count as i32,
            population_tier: 0,
            upkeep_next_tick: 0,
            core: Some(Core {
                id: "core-1".to_string(),
                position: core,
                hp: CORE_MAX_HP,
                shield: CORE_MAX_SHIELD,
                state: CoreState::Normal,
                owner_username: String::new(),
            }),
            units: workers.clone(),
            workers: workers.clone(),
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
        };
        scenes.push(Scenario {
            name: format!("rand-{i:02}"),
            initial,
            latent_resources: latent,
        });
    }
    scenes
}

/// 生成参数网格：workerTarget × exploreRadius × reserve 组合
/// （覆盖激进/稳健/保守三档），最后按名字排序保证确定性顺序。
fn generate_policies(count: i64, seed: i64) -> Vec<Config> {
    let mut rng = SplitMix64::new(seed as u64);
    let mut policies = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let mut config = Config::default();
        config.worker_target = WORKER_TARGETS[rng.next_int(WORKER_TARGETS.len() as i64) as usize];
        config.explore_radius = EXPLORE_RADII[rng.next_int(EXPLORE_RADII.len() as i64) as usize];
        config.spawn_reserve = RESERVES[rng.next_int(RESERVES.len() as i64) as usize];
        config.population_ceiling = config.worker_target + 3;
        config.military_ratio =
            MILITARY_RATIOS[rng.next_int(MILITARY_RATIOS.len() as i64) as usize];
        config.name = format!(
            "wt{}-er{}-r{}-m{}",
            config.worker_target,
            config.explore_radius,
            config.spawn_reserve,
            config.military_ratio
        );
        policies.push(config);
    }
    policies.sort_by(|a, b| a.name.cmp(&b.name));
    policies
}

/// 冻结段扫描：用 Timeline 采样（每 25 tick）近似，找最长 0-deposit 段。
/// 返回 (longest, frozenAt)，语义与 Go 诊断循环逐行一致。
fn freeze_span(points: &[arena_sim_cli::TimelinePoint]) -> (i64, i64) {
    let mut last_deposit = 0;
    let mut prev_deposits = 0;
    let mut longest = 0;
    let mut frozen_at = 0;
    for point in points {
        if point.tick % 25 == 0 {
            if point.deposits == prev_deposits {
                if last_deposit == 0 {
                    last_deposit = i64::from(point.tick);
                }
                if i64::from(point.tick) - last_deposit > longest {
                    longest = i64::from(point.tick) - last_deposit;
                    frozen_at = last_deposit;
                }
            } else {
                last_deposit = 0;
            }
            prev_deposits = point.deposits;
        }
    }
    (longest, frozen_at)
}

/// 冻结诊断：扫描 Timeline 找最长 0-deposit 段，并打枯竭标记。
fn diagnose(results: &[arena_sim_cli::BatchResult]) -> Vec<SearchResult> {
    let mut diagnosed = Vec::with_capacity(results.len());
    for result in results {
        let mut diag = SearchResult {
            scene_name: result.scene.clone(),
            policy_name: result.policy.clone(),
            deposits: result.stats.deposits,
            harvests: result.stats.harvests,
            workers: result.final_state.workers.len(),
            blocked: result.stats.blocked,
            moves: result.stats.moves,
            frozen: 0,
            frozen_at: 0,
            starvation: 0,
        };
        if result.stats.harvests == 0 {
            diag.starvation = 1;
        }
        let (longest, frozen_at) = freeze_span(&result.timeline);
        diag.frozen = longest;
        diag.frozen_at = frozen_at;
        diagnosed.push(diag);
    }
    diagnosed
}

/// 完整搜索流程（输出与 Go main 逐字节一致；inspect 分支打印场景后提前返回）。
fn run_search(args: &Args) -> String {
    let scenes = generate_scenes(args.scenes, args.seed);
    let policies = generate_policies(args.policies, args.seed + 1);
    let mut out = String::new();

    if (0..scenes.len() as i64).contains(&args.inspect) {
        let scene = &scenes[args.inspect as usize];
        let core = scene
            .initial
            .core
            .as_ref()
            .expect("generated scenes always have core");
        writeln!(
            out,
            "scene {}: core=({},{}) initial workers={} latent={}",
            scene.name,
            core.position[0],
            core.position[1],
            scene.initial.workers.len(),
            scene.latent_resources.len()
        )
        .unwrap();
        for (i, cell) in scene.latent_resources.iter().enumerate() {
            let dist = manhattan(core.position, *cell);
            writeln!(
                out,
                "  latent[{i}]=({},{}) manhattan={dist}",
                cell[0], cell[1]
            )
            .unwrap();
        }
        return out;
    }

    writeln!(
        out,
        "search: {} scenes × {} policies = {} evals, {} ticks each",
        scenes.len(),
        policies.len(),
        scenes.len() * policies.len(),
        args.ticks
    )
    .unwrap();

    let results = batch(
        &scenes,
        &policies,
        args.ticks as i32,
        BatchOption {
            workers: args.workers as usize,
            ..BatchOption::default()
        },
    );

    let mut diagnosed = diagnose(&results);

    // 按冻结长度降序（最严重在前）。
    diagnosed.sort_by_key(|diag| std::cmp::Reverse(diag.frozen));

    // 汇总统计。
    let mut frozen_count = 0;
    let mut starved_count = 0;
    let mut healthy = 0;
    for diag in &diagnosed {
        if diag.frozen >= args.ticks / 4 {
            frozen_count += 1;
        }
        if diag.starvation > 0 {
            starved_count += 1;
        }
        if diag.deposits > 0 && diag.frozen < args.ticks / 4 {
            healthy += 1;
        }
    }
    writeln!(
        out,
        "summary: frozen={frozen_count} starved={starved_count} healthy={healthy}"
    )
    .unwrap();

    // 输出 TOP 冻结（前 20）。
    writeln!(
        out,
        "\n=== top frozen (deposits stuck >= {} ticks) ===",
        args.ticks / 4
    )
    .unwrap();
    writeln!(
        out,
        "{:<24} {:<16} {:>6} {:>6} {:>6} {:>6} {:>6} {:>6} {:>6}",
        "scene", "policy", "dep", "harv", "work", "block", "moves", "frozen", "at"
    )
    .unwrap();
    let mut shown = 0;
    for diag in &diagnosed {
        if diag.frozen < args.ticks / 4 {
            continue;
        }
        if shown >= 20 {
            break;
        }
        shown += 1;
        writeln!(
            out,
            "{:<24} {:<16} {:>6} {:>6} {:>6} {:>6} {:>6} {:>6} {:>6}",
            diag.scene_name,
            diag.policy_name,
            diag.deposits,
            diag.harvests,
            diag.workers,
            diag.blocked,
            diag.moves,
            diag.frozen,
            diag.frozen_at
        )
        .unwrap();
    }
    if shown == 0 {
        writeln!(out, "  (none — no deadlocks found)").unwrap();
    }

    // 输出健康 TOP（deposits 最高，前 10）。
    diagnosed.sort_by_key(|diag| std::cmp::Reverse(diag.deposits));
    writeln!(out, "\n=== top economy (highest deposits) ===").unwrap();
    writeln!(
        out,
        "{:<24} {:<16} {:>6} {:>6} {:>6} {:>6}",
        "scene", "policy", "dep", "harv", "work", "block"
    )
    .unwrap();
    for diag in diagnosed.iter().take(10) {
        writeln!(
            out,
            "{:<24} {:<16} {:>6} {:>6} {:>6} {:>6}",
            diag.scene_name,
            diag.policy_name,
            diag.deposits,
            diag.harvests,
            diag.workers,
            diag.blocked
        )
        .unwrap();
    }
    out
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&args) {
        ParseOutcome::Run(parsed) => {
            print!("{}", run_search(&parsed));
            ExitCode::SUCCESS
        }
        ParseOutcome::Help => {
            print_usage();
            ExitCode::SUCCESS
        }
        ParseOutcome::Error(message) => {
            eprintln!("{message}");
            print_usage();
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use arena_sim_cli::{BatchResult, TimelinePoint};
    use arena_sim_engine::SettleStats;

    fn test_args() -> Args {
        Args {
            scenes: 8,
            policies: 4,
            ticks: 100,
            workers: 2,
            seed: 20260805,
            inspect: -1,
        }
    }

    fn stub_tick_state() -> TickState {
        TickState {
            tick: 1,
            status: CoreStatus::Active,
            resources: 10,
            resource_capacity: 10,
            resource_space: 0,
            population: 0,
            population_tier: 0,
            upkeep_next_tick: 0,
            core: None,
            units: Vec::new(),
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

    fn point(tick: i32, deposits: i32) -> TimelinePoint {
        TimelinePoint {
            tick,
            resources: 0,
            resource_cells: 0,
            workers: 0,
            deposits,
            kills: 0,
            units_lost: 0,
            mode: String::new(),
        }
    }

    fn stub_result(deposits: i32, harvests: i32, timeline: Vec<TimelinePoint>) -> BatchResult {
        BatchResult {
            scene: "s".to_string(),
            policy: "p".to_string(),
            ticks: 100,
            stats: SettleStats {
                deposits,
                harvests,
                ..SettleStats::default()
            },
            final_state: stub_tick_state(),
            score: 0.0,
            timeline,
        }
    }

    #[test]
    fn same_seed_output_is_byte_identical() {
        let first = run_search(&test_args());
        let second = run_search(&test_args());
        assert_eq!(first, second);
    }

    #[test]
    fn search_header_format_matches_go() {
        let out = run_search(&test_args());
        let first = out.lines().next().unwrap();
        assert_eq!(
            first,
            "search: 8 scenes × 4 policies = 32 evals, 100 ticks each"
        );
    }

    #[test]
    fn summary_and_table_headers_present() {
        let out = run_search(&test_args());
        assert!(out.contains("summary: frozen="), "{out}");
        assert!(
            out.contains("=== top frozen (deposits stuck >= 25 ticks) ==="),
            "{out}"
        );
        assert!(
            out.contains("=== top economy (highest deposits) ==="),
            "{out}"
        );
        let frozen_header = format!(
            "{:<24} {:<16} {:>6} {:>6} {:>6} {:>6} {:>6} {:>6} {:>6}",
            "scene", "policy", "dep", "harv", "work", "block", "moves", "frozen", "at"
        );
        assert!(out.contains(&frozen_header), "{out}");
        // 数据行宽度：右对齐 6 位数字。
        assert!(out.contains("     dep"), "{out}");
    }

    #[test]
    fn scenes_are_deterministic() {
        // Scenario 无 PartialEq（共享库）；按字段元组比较。
        let key = |scenes: Vec<Scenario>| -> Vec<(String, TickState, Vec<Position>)> {
            scenes
                .into_iter()
                .map(|s| (s.name, s.initial, s.latent_resources))
                .collect()
        };
        assert_eq!(key(generate_scenes(8, 42)), key(generate_scenes(8, 42)));
        assert_ne!(key(generate_scenes(8, 42)), key(generate_scenes(8, 43)));
    }

    #[test]
    fn policies_match_go_grid_and_sort() {
        let policies = generate_policies(24, 7);
        let names: Vec<&str> = policies.iter().map(|p| p.name.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted);
        for policy in &policies {
            // 名字格式照抄 Go：wt%d-er%d-r%d-m%d。
            assert_eq!(
                policy.name,
                format!(
                    "wt{}-er{}-r{}-m{}",
                    policy.worker_target,
                    policy.explore_radius,
                    policy.spawn_reserve,
                    policy.military_ratio
                )
            );
            // populationCeiling = workerTarget + 3。
            assert_eq!(policy.population_ceiling, policy.worker_target + 3);
        }
    }

    #[test]
    fn inspect_prints_scene_details_and_exits() {
        let mut args = test_args();
        args.inspect = 0;
        let out = run_search(&args);
        assert!(out.starts_with("scene rand-00: core=("), "{out}");
        assert!(!out.contains("search:"), "{out}");
    }

    #[test]
    fn inspect_out_of_range_falls_through_to_search() {
        let mut args = test_args();
        args.inspect = 9999;
        let out = run_search(&args);
        assert!(out.starts_with("search:"), "{out}");
    }

    #[test]
    fn freeze_span_detects_longest_zero_deposit_run() {
        // 全程无 deposit：段 [25, 100]，长度 75。
        let stuck = vec![point(25, 0), point(50, 0), point(75, 0), point(100, 0)];
        assert_eq!(freeze_span(&stuck), (75, 25));
        // 中间恢复：段 [25, 50] 长度 25，其后重置。
        let recovered = vec![point(25, 0), point(50, 0), point(75, 5), point(100, 5)];
        assert_eq!(freeze_span(&recovered), (25, 25));
        // 无冻结：deposits 单调增长。
        let healthy = vec![point(25, 1), point(50, 3), point(75, 6), point(100, 9)];
        assert_eq!(freeze_span(&healthy), (0, 0));
    }

    #[test]
    fn diagnose_flags_starvation_and_frozen() {
        let results = vec![
            stub_result(
                3,
                0,
                vec![point(25, 0), point(50, 0), point(75, 0), point(100, 0)],
            ),
            stub_result(
                9,
                4,
                vec![point(25, 2), point(50, 5), point(75, 7), point(100, 9)],
            ),
        ];
        let diagnosed = diagnose(&results);
        assert_eq!(diagnosed[0].starvation, 1);
        assert_eq!(diagnosed[0].frozen, 75);
        assert_eq!(diagnosed[0].frozen_at, 25);
        assert_eq!(diagnosed[1].starvation, 0);
        assert_eq!(diagnosed[1].frozen, 0);
        assert_eq!(diagnosed[1].frozen_at, 0);
    }

    #[test]
    fn flag_parse_matches_go_semantics() {
        let run =
            |args: &[&str]| parse_args(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        // 默认值。
        match run(&[]) {
            ParseOutcome::Run(a) => {
                assert_eq!(a.scenes, 40);
                assert_eq!(a.policies, 24);
                assert_eq!(a.ticks, 300);
                assert_eq!(a.workers, 0);
                assert_eq!(a.seed, 20260805);
                assert_eq!(a.inspect, -1);
            }
            _ => panic!("expected Run"),
        }
        // `--name value` 与 `--name=value` 等价。
        match run(&["--scenes", "8", "--policies=4"]) {
            ParseOutcome::Run(a) => {
                assert_eq!(a.scenes, 8);
                assert_eq!(a.policies, 4);
            }
            _ => panic!("expected Run"),
        }
        // 位置参数停止解析（Go flag 语义：剩余忽略）。
        match run(&["--scenes", "8", "positional", "--ticks", "50"]) {
            ParseOutcome::Run(a) => {
                assert_eq!(a.scenes, 8);
                assert_eq!(a.ticks, 300);
            }
            _ => panic!("expected Run"),
        }
        // 非法值 / 未定义 flag → Error。
        assert!(matches!(run(&["--scenes", "abc"]), ParseOutcome::Error(_)));
        assert!(matches!(run(&["--bogus"]), ParseOutcome::Error(_)));
        assert!(matches!(run(&["--scenes"]), ParseOutcome::Error(_)));
        // help。
        assert!(matches!(run(&["--help"]), ParseOutcome::Help));
        assert!(matches!(run(&["-h"]), ParseOutcome::Help));
    }
}
