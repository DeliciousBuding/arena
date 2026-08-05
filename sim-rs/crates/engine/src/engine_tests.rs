//! 引擎测试（从 go-rewrite `internal/sim/engine_test.go` + bench_test.go
//! 移植，语义逐一对应）。

use arena_sim_domain::{
    cell_key, Beacon, BeaconStatus, Core, CoreState, CoreStatus, Direction, Plan, TickState,
    UnitAction, UnitActionKind, UnitSnapshot, UnitType, CORE_MAX_HP, CORE_MAX_SHIELD,
};

use crate::{movement::WORLD_BOUND, refill::RefillConfig, Engine, SettleStats};

/// baseState 构造最小合法状态（健康 Core 在原点、一个 worker、无资源）。
fn base_state() -> TickState {
    TickState {
        tick: 1,
        status: CoreStatus::Active,
        resources: 0,
        resource_capacity: 10,
        resource_space: 10,
        population: 1,
        population_tier: 0,
        upkeep_next_tick: 0,
        core: Some(Core {
            id: "core-1".to_string(),
            position: [0, 0],
            hp: CORE_MAX_HP,
            shield: CORE_MAX_SHIELD,
            state: CoreState::Normal,
            owner_username: String::new(),
        }),
        units: vec![UnitSnapshot {
            id: "worker-1".to_string(),
            position: [3, 0],
            hp: 2,
            unit_type: UnitType::Worker,
            cargo: 0,
        }],
        workers: vec![UnitSnapshot {
            id: "worker-1".to_string(),
            position: [3, 0],
            hp: 2,
            unit_type: UnitType::Worker,
            cargo: 0,
        }],
        vanguards: Vec::new(),
        rangers: Vec::new(),
        visible_enemies: Vec::new(),
        resource_cells: Default::default(),
        obstacle_cells: Default::default(),
        beacon: Beacon { position: [0, 0], status: BeaconStatus::Ground, carrier_id: None },
        events: Vec::new(),
        state_hash: String::new(),
    }
}

fn move_action(direction: Direction) -> UnitAction {
    UnitAction { kind: UnitActionKind::Move, direction: Some(direction), target_id: None, expected_cell: None }
}

fn plan_with(actions: Vec<(String, UnitAction)>) -> Plan {
    Plan { tick: 1, unit_actions: actions.into_iter().collect(), core_action: None, intents: Default::default() }
}

fn count_events(events: &[arena_sim_domain::Event], event_type: &str) -> usize {
    events.iter().filter(|e| e.event_type == event_type).count()
}

/// 单发 settle（测试辅助：Engine::settle 需要 &mut self）。
fn run_settle(state: &TickState, plan: &Plan) -> crate::SettleResult {
    Engine::new().settle(state, plan)
}

#[test]
fn settle_moves_unit() {
    let state = base_state();
    let plan = plan_with(vec![("worker-1".to_string(), move_action(Direction::Left))]);
    let result = run_settle(&state, &plan);
    assert_eq!(result.stats.moves, 1);
    assert_eq!(result.stats.blocked, 0);
    assert_eq!(result.next_state.units[0].position, [2, 0]);
}

#[test]
fn settle_blocks_obstacle() {
    let state = base_state();
    let mut state = state;
    state.obstacle_cells.insert(cell_key(2, 0));
    let plan = plan_with(vec![("worker-1".to_string(), move_action(Direction::Left))]);
    let result = run_settle(&state, &plan);
    assert_eq!(result.stats.moves, 0);
    assert_eq!(result.stats.blocked, 1);
    assert_eq!(result.next_state.units[0].position, [3, 0]);
    assert!(result
        .events
        .iter()
        .any(|e| e.event_type == "MOVE_BLOCKED" && e.reason_code.as_deref() == Some("MOVE_BLOCKED_OBSTACLE")));
}

#[test]
fn settle_blocks_boundary() {
    let mut state = base_state();
    state.units[0].position = [-WORLD_BOUND, 0];
    state.workers[0].position = [-WORLD_BOUND, 0];
    let plan = plan_with(vec![("worker-1".to_string(), move_action(Direction::Left))]);
    let result = run_settle(&state, &plan);
    assert_eq!(result.stats.blocked, 1);
}

#[test]
fn settle_blocks_occupied_cell() {
    let mut state = base_state();
    state.units.push(UnitSnapshot {
        id: "worker-2".to_string(),
        position: [2, 0],
        hp: 2,
        unit_type: UnitType::Worker,
        cargo: 0,
    });
    let plan = plan_with(vec![("worker-1".to_string(), move_action(Direction::Left))]);
    let result = run_settle(&state, &plan);
    assert_eq!(result.stats.moves, 0);
    assert_eq!(result.stats.blocked, 1);
}

#[test]
fn settle_harvest_adds_cargo() {
    let mut state = base_state();
    state.resource_cells.insert(cell_key(3, 0));
    let plan = plan_with(vec![("worker-1".to_string(), UnitAction { kind: UnitActionKind::Harvest, direction: None, target_id: None, expected_cell: None })]);
    let result = run_settle(&state, &plan);
    assert_eq!(result.stats.harvests, 1);
    assert_eq!(result.next_state.units[0].cargo, 1);
    // 采空格立即消失。
    assert!(!result.next_state.resource_cells.contains(&cell_key(3, 0)));
}

#[test]
fn settle_harvest_fails_without_resource() {
    let state = base_state();
    let plan = plan_with(vec![("worker-1".to_string(), UnitAction { kind: UnitActionKind::Harvest, direction: None, target_id: None, expected_cell: None })]);
    let result = run_settle(&state, &plan);
    assert_eq!(result.stats.harvests, 0);
    assert_eq!(result.next_state.units[0].cargo, 0);
}

#[test]
fn settle_deposit_adds_resources() {
    let mut state = base_state();
    state.units[0].cargo = 3;
    state.workers[0].cargo = 3;
    state.units[0].position = [0, 0];
    state.workers[0].position = [0, 0];
    let plan = plan_with(vec![("worker-1".to_string(), UnitAction { kind: UnitActionKind::Deposit, direction: None, target_id: None, expected_cell: None })]);
    let result = run_settle(&state, &plan);
    assert_eq!(result.stats.deposits, 1);
    assert_eq!(result.stats.resource_delta, 3);
    assert_eq!(result.next_state.resources, 3);
    assert_eq!(result.next_state.units[0].cargo, 0);
}

#[test]
fn settle_deposit_respects_capacity() {
    let mut state = base_state();
    state.resources = 9;
    state.units[0].cargo = 3;
    state.workers[0].cargo = 3;
    state.units[0].position = [0, 0];
    state.workers[0].position = [0, 0];
    let plan = plan_with(vec![("worker-1".to_string(), UnitAction { kind: UnitActionKind::Deposit, direction: None, target_id: None, expected_cell: None })]);
    let result = run_settle(&state, &plan);
    assert_eq!(result.stats.resource_delta, 1);
    assert_eq!(result.next_state.resources, 10);
    assert_eq!(count_events(&result.events, "DEPOSIT_REJECTED_CAPACITY"), 1);
}

#[test]
fn settle_does_not_mutate_input() {
    let mut state = base_state();
    state.resource_cells.insert(cell_key(3, 0));
    let before = state.clone();
    let plan = plan_with(vec![("worker-1".to_string(), UnitAction { kind: UnitActionKind::Harvest, direction: None, target_id: None, expected_cell: None })]);
    run_settle(&state, &plan);
    assert_eq!(state.units[0].cargo, before.units[0].cargo);
    assert_eq!(state.resources, before.resources);
}

#[test]
fn settle_deterministic() {
    let mut state = base_state();
    state.resource_cells.insert(cell_key(4, 0));
    state.resource_cells.insert(cell_key(5, 0));
    let plan = plan_with(vec![("worker-1".to_string(), move_action(Direction::Left))]);
    let first = run_settle(&state, &plan);
    let second = run_settle(&state, &plan);
    assert_eq!(first.next_state.units[0].position, second.next_state.units[0].position);
    assert_eq!(first.stats, second.stats);
    assert_eq!(first.events.len(), second.events.len());
}

#[test]
fn settle_full_cycle() {
    let mut state = base_state();
    state.resource_cells.insert(cell_key(3, 0));
    // tick 1: worker 在资源格上采集
    let harvest_plan = plan_with(vec![("worker-1".to_string(), UnitAction { kind: UnitActionKind::Harvest, direction: None, target_id: None, expected_cell: None })]);
    let result1 = run_settle(&state, &harvest_plan);
    assert_eq!(result1.next_state.units[0].cargo, 1);
    // tick 2-4: worker 回仓（每次一格，3 步到 Core 格）
    let mut state2 = result1.next_state;
    for step in 0..3 {
        let mut return_plan = plan_with(vec![("worker-1".to_string(), move_action(Direction::Left))]);
        return_plan.tick = 2 + step;
        state2 = run_settle(&state2, &return_plan).next_state;
    }
    assert_eq!(state2.units[0].position, [0, 0]);
    let mut deposit_plan = plan_with(vec![("worker-1".to_string(), UnitAction { kind: UnitActionKind::Deposit, direction: None, target_id: None, expected_cell: None })]);
    deposit_plan.tick = 5;
    let result3 = run_settle(&state2, &deposit_plan);
    assert_eq!(result3.next_state.resources, 1);
    assert_eq!(result3.next_state.units[0].cargo, 0);
}

/// benchState 构造经济闭环场景（与 Go bench_test 同构：refill 池 +
/// 满载死锁起点）。
pub fn bench_state() -> TickState {
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
            UnitSnapshot { id: "worker-full".to_string(), position: [38, 39], hp: 2, unit_type: UnitType::Worker, cargo: 1 },
            UnitSnapshot { id: "worker-empty".to_string(), position: [38, 51], hp: 2, unit_type: UnitType::Worker, cargo: 0 },
        ],
        workers: vec![
            UnitSnapshot { id: "worker-full".to_string(), position: [38, 39], hp: 2, unit_type: UnitType::Worker, cargo: 1 },
            UnitSnapshot { id: "worker-empty".to_string(), position: [38, 51], hp: 2, unit_type: UnitType::Worker, cargo: 0 },
        ],
        vanguards: Vec::new(),
        rangers: Vec::new(),
        visible_enemies: Vec::new(),
        resource_cells: [cell_key(38, 45)].into_iter().collect(),
        obstacle_cells: [
            [36, 51], [36, 52], [37, 39], [37, 42], [37, 44], [38, 34], [38, 43], [38, 50], [39, 41], [39, 44], [39, 52], [40, 40],
        ]
        .iter()
        .map(|[x, y]| cell_key(*x, *y))
        .collect(),
        beacon: Beacon { position: [-17, 77], status: BeaconStatus::Ground, carrier_id: None },
        events: Vec::new(),
        state_hash: String::new(),
    }
}

/// 跑 N tick 结算（原地结算，空计划——纯结算骨架；planner 接线在
/// strategy crate 完成后补）。
pub fn run_ticks(state: &mut TickState, ticks: i32, refill_cells: &[arena_sim_domain::Position]) -> SettleStats {
    let mut engine = Engine::new();
    if !refill_cells.is_empty() {
        engine.refill = Some(RefillConfig::new(refill_cells));
    }
    let mut total = SettleStats::default();
    for _ in 1..=ticks {
        state.tick += 1;
        let plan = Plan { tick: state.tick, unit_actions: Default::default(), core_action: None, intents: Default::default() };
        let (_events, stats) = engine.settle_in_place(state, &plan);
        total.moves += stats.moves;
        total.blocked += stats.blocked;
        total.harvests += stats.harvests;
        total.deposits += stats.deposits;
    }
    total
}

#[test]
fn sim_run_sanity() {
    // 200 tick 空计划结算不崩溃、状态一致（纯结算骨架）。
    let mut state = bench_state();
    let stats = run_ticks(&mut state, 200, &[]);
    assert_eq!(stats.blocked, 0);
    assert_eq!(state.units.len(), 2);
}
