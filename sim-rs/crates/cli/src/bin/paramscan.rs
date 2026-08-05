//! paramscan：sim 经济参数网格扫描——真实拓扑闭环（fixture 障碍 +
//! 资源格）下评估 workerTarget × spawnReserve 组合的经济产出。
//! 与 Go `cmd/paramscan` 对偶：scanState 拓扑、4×4 网格、100 tick、
//! 输出表 + best 行逐字节一致。
//!
//! 用法：cargo run --release -p arena-sim-cli --bin paramscan

use std::fmt::Write as _;
use std::process::ExitCode;

use arena_sim_domain::{
    cell_key, Beacon, BeaconStatus, Core, CoreState, CoreStatus, Position, TickState, UnitSnapshot,
    UnitType, CORE_MAX_HP, CORE_MAX_SHIELD,
};
use arena_sim_engine::Engine;
use arena_sim_strategy::{Config, Planner};

/// 扫描拓扑障碍格（与 Go scanObstacles 一致）。
const SCAN_OBSTACLES: [Position; 12] = [
    [36, 51],
    [36, 52],
    [37, 39],
    [37, 42],
    [37, 44],
    [38, 34],
    [38, 43],
    [38, 50],
    [39, 41],
    [39, 44],
    [39, 52],
    [40, 40],
];

/// scanState 构造真实拓扑起点（满载死锁态，与 Go 逐字段一致）。
fn scan_state() -> TickState {
    let worker_full = UnitSnapshot {
        id: "worker-full".to_string(),
        position: [38, 39],
        hp: 2,
        unit_type: UnitType::Worker,
        cargo: 1,
    };
    let worker_empty = UnitSnapshot {
        id: "worker-empty".to_string(),
        position: [38, 51],
        hp: 2,
        unit_type: UnitType::Worker,
        cargo: 0,
    };
    let mut state = TickState {
        tick: 1,
        status: CoreStatus::Active,
        resources: 10,
        resource_capacity: 10,
        resource_space: 0,
        population: 2,
        population_tier: 0,
        upkeep_next_tick: 0,
        core: Some(Core {
            id: "core-1".to_string(),
            position: [38, 39],
            hp: CORE_MAX_HP,
            shield: CORE_MAX_SHIELD,
            state: CoreState::Normal,
            owner_username: String::new(),
        }),
        units: vec![worker_full.clone(), worker_empty.clone()],
        workers: vec![worker_full, worker_empty],
        vanguards: Vec::new(),
        rangers: Vec::new(),
        visible_enemies: Vec::new(),
        resource_cells: [cell_key(38, 45)].into_iter().collect(),
        obstacle_cells: Default::default(),
        beacon: Beacon {
            position: [-17, 77],
            status: BeaconStatus::Ground,
            carrier_id: None,
        },
        events: Vec::new(),
        state_hash: String::new(),
    };
    for cell in SCAN_OBSTACLES {
        state.obstacle_cells.insert(cell_key(cell[0], cell[1]));
    }
    state
}

/// 单网格点扫描结果（与 Go scanResult 一致）。
struct ScanResult {
    worker_target: i32,
    spawn_reserve: i32,
    workers: i32,
    spawns: i32,
    harvests: i32,
    deposits: i32,
    resources: i32,
}

/// 跑单个 workerTarget × spawnReserve 组合（Engine::settle 克隆路径，
/// 与 Go Settle 一致；不启用 refill，与 Go NewEngine 默认一致）。
fn run_scan(worker_target: i32, spawn_reserve: i32, ticks: i32) -> ScanResult {
    let mut state = scan_state();
    let mut planner = Planner::new(Config {
        name: String::new(),
        worker_target,
        population_ceiling: 20,
        explore_radius: 16,
        threat_distance: 5,
        spawn_reserve,
        military_ratio: 0,
        enable_core_migration: false,
    });
    let mut engine = Engine::new();
    let mut result = ScanResult {
        worker_target,
        spawn_reserve,
        workers: 0,
        spawns: 0,
        harvests: 0,
        deposits: 0,
        resources: 0,
    };
    for tick in 1..=ticks {
        state.tick = tick;
        let plan = planner.decide(&state);
        let settled = engine.settle(&state, &plan);
        result.spawns += settled.stats.spawns;
        result.harvests += settled.stats.harvests;
        result.deposits += settled.stats.deposits;
        state = settled.next_state;
    }
    result.workers = state.workers.len() as i32;
    result.resources = state.resources;
    result
}

/// 完整扫描输出（表 + best 行，格式与 Go main 逐字节一致）。
fn scan_output(ticks: i32) -> String {
    const TARGETS: [i32; 4] = [4, 6, 8, 10];
    const RESERVES: [i32; 4] = [0, 2, 5, 8];

    let mut out = String::new();
    writeln!(
        out,
        "=== economy parameter scan ({ticks} ticks, real fixture topology) ==="
    )
    .unwrap();
    writeln!(
        out,
        "{:<6} {:<8} {:<8} {:<6} {:<8} {:<8} {:<8}",
        "target", "reserve", "workers", "spawns", "harvests", "deposits", "resources"
    )
    .unwrap();

    let mut results = Vec::with_capacity(TARGETS.len() * RESERVES.len());
    for &target in &TARGETS {
        for &reserve in &RESERVES {
            results.push(run_scan(target, reserve, ticks));
        }
    }
    for result in &results {
        writeln!(
            out,
            "{:<6} {:<8} {:<8} {:<6} {:<8} {:<8} {:<8}",
            result.worker_target,
            result.spawn_reserve,
            result.workers,
            result.spawns,
            result.harvests,
            result.deposits,
            result.resources
        )
        .unwrap();
    }

    // 最优：worker 数最多 + 资源不枯竭（deposits 最高）。
    results.sort_by(|a, b| {
        b.workers
            .cmp(&a.workers)
            .then_with(|| b.deposits.cmp(&a.deposits))
    });
    let best = &results[0];
    writeln!(
        out,
        "\nbest: workerTarget={} spawnReserve={} → workers={} deposits={}",
        best.worker_target, best.spawn_reserve, best.workers, best.deposits
    )
    .unwrap();
    out
}

fn main() -> ExitCode {
    print!("{}", scan_output(100));
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_state_topology_matches_go() {
        let state = scan_state();
        // 障碍 12 格。
        assert_eq!(state.obstacle_cells.len(), 12);
        assert!(state.obstacle_cells.contains(&cell_key(36, 51)));
        assert!(state.obstacle_cells.contains(&cell_key(40, 40)));
        // worker-full 满载在 Core，worker-empty 在 (38,51)。
        let core = state.core.as_ref().unwrap();
        assert_eq!(core.position, [38, 39]);
        let full = state
            .workers
            .iter()
            .find(|u| u.id == "worker-full")
            .unwrap();
        assert_eq!(full.position, [38, 39]);
        assert_eq!(full.cargo, 1);
        let empty = state
            .workers
            .iter()
            .find(|u| u.id == "worker-empty")
            .unwrap();
        assert_eq!(empty.position, [38, 51]);
        assert_eq!(empty.cargo, 0);
        // 资源格与 beacon。
        assert!(state.resource_cells.contains(&cell_key(38, 45)));
        assert_eq!(state.beacon.position, [-17, 77]);
        assert_eq!(state.beacon.status, BeaconStatus::Ground);
    }

    #[test]
    fn table_header_format_matches_go() {
        let out = scan_output(100);
        let mut lines = out.lines();
        assert_eq!(
            lines.next().unwrap(),
            "=== economy parameter scan (100 ticks, real fixture topology) ==="
        );
        // Go %-6s/%-8s 补齐：reserve/workers 7 字符 → 各补 1 空格
        //（"target reserve  workers  spawns ..."，逐字节同 Go）。
        assert_eq!(
            lines.next().unwrap(),
            "target reserve  workers  spawns harvests deposits resources"
        );
        // 16 数据行（4 target × 4 reserve）+ 1 行 best。
        let mut data_rows = 0;
        let mut best_row = None;
        for line in lines {
            if line.is_empty() {
                // "\nbest: ..." 的前导空行。
                continue;
            }
            if line.starts_with("best:") {
                best_row = Some(line);
                break;
            }
            data_rows += 1;
            // 每行 7 列（左对齐，与 Go %-6d/%-8d 一致）。
            assert_eq!(line.split_whitespace().count(), 7, "row: {line}");
        }
        assert_eq!(data_rows, 16);
        let best = best_row.expect("best row present");
        assert!(best.starts_with("best: workerTarget="), "{best}");
        assert!(best.contains("→ workers="), "{best}");
    }

    #[test]
    fn run_scan_is_deterministic_and_bounded() {
        let first = run_scan(8, 2, 100);
        let second = run_scan(8, 2, 100);
        assert_eq!(first.workers, second.workers);
        assert_eq!(first.spawns, second.spawns);
        assert_eq!(first.harvests, second.harvests);
        assert_eq!(first.deposits, second.deposits);
        assert_eq!(first.resources, second.resources);
        // 初始 2 worker 永远在场，资源非负。
        assert!(first.workers >= 2, "workers: {}", first.workers);
        assert!(first.resources >= 0, "resources: {}", first.resources);
    }
}
