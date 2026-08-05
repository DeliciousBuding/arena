//! 闭环集成测试（planner.decide → engine.settle_in_place 循环）：
//! 验证经济闭环跑通、人口补员、无死锁、确定性（对应 Go bench_test
//! runTicks 语义 + economy-loop 测试意图）。

use arena_sim_domain::{
    cell_key, Beacon, BeaconStatus, Core, CoreState, CoreStatus, Plan, TickState, UnitSnapshot,
    UnitType, CORE_MAX_HP, CORE_MAX_SHIELD,
};
use arena_sim_engine::{Engine, RefillConfig};

use crate::{commander::Commander, Config, Planner};

/// 构造经济闭环场景（与 Go benchState 同构：refill 池 + 满载死锁起点）。
pub(crate) fn bench_state() -> TickState {
    TickState {
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
        units: vec![
            UnitSnapshot {
                id: "worker-full".to_string(),
                position: [38, 39],
                hp: 2,
                unit_type: UnitType::Worker,
                cargo: 1,
            },
            UnitSnapshot {
                id: "worker-empty".to_string(),
                position: [38, 51],
                hp: 2,
                unit_type: UnitType::Worker,
                cargo: 0,
            },
        ],
        workers: vec![
            UnitSnapshot {
                id: "worker-full".to_string(),
                position: [38, 39],
                hp: 2,
                unit_type: UnitType::Worker,
                cargo: 1,
            },
            UnitSnapshot {
                id: "worker-empty".to_string(),
                position: [38, 51],
                hp: 2,
                unit_type: UnitType::Worker,
                cargo: 0,
            },
        ],
        vanguards: Vec::new(),
        rangers: Vec::new(),
        visible_enemies: Vec::new(),
        resource_cells: [cell_key(38, 45)].into_iter().collect(),
        obstacle_cells: [
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
        ]
        .iter()
        .map(|[x, y]| cell_key(*x, *y))
        .collect(),
        beacon: Beacon {
            position: [-17, 77],
            status: BeaconStatus::Ground,
            carrier_id: None,
        },
        events: Vec::new(),
        state_hash: String::new(),
    }
}

/// bench refill 池（与 Go bench_test 一致）。
pub(crate) fn bench_latent() -> Vec<arena_sim_domain::Position> {
    vec![
        [38, 45],
        [30, 34],
        [46, 34],
        [30, 46],
        [46, 46],
        [38, 26],
        [38, 47],
        [28, 36],
        [48, 36],
        [28, 48],
        [48, 48],
        [40, 24],
    ]
}

/// 跑完整闭环：commander 每 tick 输出指令 → planner.decide →
/// engine.settle_in_place。返回累计统计。
#[derive(Debug)]
struct LoopOutcome {
    moves: i32,
    blocked: i32,
    harvests: i32,
    deposits: i32,
    spawns: i32,
    final_resources: i32,
    final_units: usize,
}

fn run_loop(ticks: i32) -> LoopOutcome {
    let mut state = bench_state();
    let mut planner = Planner::new(Config::default());
    let mut commander = Commander::new();
    let mut engine = Engine::new();
    engine.refill = Some(RefillConfig::new(&bench_latent()));

    let mut outcome = LoopOutcome {
        moves: 0,
        blocked: 0,
        harvests: 0,
        deposits: 0,
        spawns: 0,
        final_resources: 0,
        final_units: 0,
    };
    for _ in 0..ticks {
        state.tick += 1;
        let directive = commander.update(&state);
        planner.apply_directive(directive);
        let plan: Plan = planner.decide(&state);
        let (_events, stats) = engine.settle_in_place(&mut state, &plan);
        outcome.moves += stats.moves;
        outcome.blocked += stats.blocked;
        outcome.harvests += stats.harvests;
        outcome.deposits += stats.deposits;
        outcome.spawns += stats.spawns;
    }
    outcome.final_resources = state.resources;
    outcome.final_units = state.units.len();
    outcome
}

#[test]
fn economy_loop_cycles() {
    // 300 tick 闭环：经济循环必须真实发生（harvest/deposit/spawn 均 > 0）。
    let outcome = run_loop(300);
    assert!(
        outcome.harvests > 0,
        "no harvests in 300 ticks — economy dead"
    );
    assert!(
        outcome.deposits > 0,
        "no deposits in 300 ticks — deposit channel dead"
    );
    assert!(
        outcome.spawns > 0,
        "no spawns in 300 ticks — population frozen"
    );
    assert!(
        outcome.blocked == 0 || outcome.moves > outcome.blocked * 3,
        "excessive blocking"
    );
}

#[test]
fn economy_loop_grows_population() {
    // 补员：workerTarget=13 且 refill 下资源持续流入 → 人口增长。
    // 结束时资源可能恰好被 SPAWN 耗尽（正常经济行为），断言非负防负资源 bug。
    let outcome = run_loop(600);
    assert!(
        outcome.final_units > 2,
        "population did not grow: {outcome:?}"
    );
    assert!(
        outcome.final_resources >= 0,
        "resources went negative: {outcome:?}"
    );
    // 经济自持：累计产出（deposits）至少覆盖人口增长所需成本。
    assert!(
        outcome.deposits as i32 > outcome.spawns * 5,
        "economy not self-sustaining: deposits={} spawns={}",
        outcome.deposits,
        outcome.spawns
    );
}

#[test]
fn loop_is_deterministic() {
    // 同输入两次长跑结果完全一致（planner 持久状态 + 引擎确定性）。
    let first = run_loop(200);
    let second = run_loop(200);
    assert_eq!(first.harvests, second.harvests);
    assert_eq!(first.deposits, second.deposits);
    assert_eq!(first.spawns, second.spawns);
    assert_eq!(first.final_resources, second.final_resources);
    assert_eq!(first.final_units, second.final_units);
}

#[test]
fn full_cargo_cycle_clears() {
    // 满载 worker 最终卸空（cargo 周期清零：无长期 cargo_blocked）。
    let mut state = bench_state();
    let mut planner = Planner::new(Config::default());
    let mut commander = Commander::new();
    let mut engine = Engine::new();
    engine.refill = Some(RefillConfig::new(&bench_latent()));
    let mut saw_cleared = false;
    for _ in 0..200 {
        state.tick += 1;
        let directive = commander.update(&state);
        planner.apply_directive(directive);
        let plan = planner.decide(&state);
        engine.settle_in_place(&mut state, &plan);
        if state.units.iter().all(|u| u.cargo == 0) {
            saw_cleared = true;
            break;
        }
    }
    assert!(
        saw_cleared,
        "cargo never cleared in 200 ticks — deposit channel deadlocked"
    );
}
