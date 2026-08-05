//! optsearch：模拟退火 + 遗传算法参数优化（与 Go `cmd/optsearch` 对偶）。
//!
//! 在 sim 经济闭环评分下搜索最优策略参数（`workerTarget`/`spawnReserve`/
//! `exploreRadius`/`populationCeiling`）。评分 = `spawns×3 + deposits×5 +
//! harvests×2 + workers×10`，base/dense/sparse 三场景取最低分（鲁棒性优先，
//! 防止过拟合单场景）。批量评估复用共享库 `batch`（rayon 并行，结果确定性
//! 排序）。随机数用共享库 `SplitMix64`（PARITY §8：仅 Rust 内部确定性，
//! 同 seed 两次运行输出逐字节一致；不与 Go math/rand 序列对齐）。
//!
//! 用法：`optsearch [iterations] [--ga]`（iterations 默认 400，正整数）。

use std::fmt::Write as FmtWrite;

use arena_sim_cli::{batch, policy_name, BatchOption, BatchResult, Scenario, SplitMix64};
use arena_sim_domain::{
    cell_key, Beacon, BeaconStatus, CellSet, Core, CoreState, CoreStatus, Position, TickState,
    UnitSnapshot, UnitType, CORE_MAX_HP, CORE_MAX_SHIELD,
};
use arena_sim_strategy::Config;

/// 评分闭环 tick 数（与 Go `const ticks = 100` 一致）。
const TICKS: i32 = 100;
/// 确定性种子（与 Go `rand.NewSource(20260805)` 同值，序列不同）。
const RNG_SEED: u64 = 20260805;

/// 可优化参数（与 Go `searchParams` 对偶；整数空间）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SearchParams {
    worker_target: i32,
    spawn_reserve: i32,
    explore_radius: i32,
    population_ceiling: i32,
}

/// 各维度参数边界（与 Go `paramBounds` 对偶，字段序：
/// workerTarget/spawnReserve/exploreRadius/populationCeiling）。
const PARAM_BOUNDS: [[i32; 2]; 4] = [[2, 16], [0, 8], [8, 32], [10, 30]];

/// 默认参数（与 Go `defaultParams` 一致：{8, 5, 16, 20}）。
fn default_params() -> SearchParams {
    SearchParams {
        worker_target: 8,
        spawn_reserve: 5,
        explore_radius: 16,
        population_ceiling: 20,
    }
}

/// 均匀随机参数（每维度在边界内等概率，与 Go `randomParams` 对偶）。
fn random_params(rng: &mut SplitMix64) -> SearchParams {
    SearchParams {
        worker_target: random_in_bounds(rng, PARAM_BOUNDS[0]),
        spawn_reserve: random_in_bounds(rng, PARAM_BOUNDS[1]),
        explore_radius: random_in_bounds(rng, PARAM_BOUNDS[2]),
        population_ceiling: random_in_bounds(rng, PARAM_BOUNDS[3]),
    }
}

/// 边界内均匀随机整数（与 Go `lo + Intn(hi-lo+1)` 一致）。
fn random_in_bounds(rng: &mut SplitMix64, bounds: [i32; 2]) -> i32 {
    bounds[0] + rng.next_int((bounds[1] - bounds[0] + 1) as i64) as i32
}

/// 扰动一个随机维度 ±(1..2) 步 + clamp（与 Go `neighbor` 对偶，RNG 调用
/// 顺序一致：先步长、再维度、后符号）。
fn neighbor(params: SearchParams, rng: &mut SplitMix64) -> SearchParams {
    let mut step = 1 + rng.next_int(2) as i32;
    let dimension = rng.next_int(4) as usize;
    let mut next = params;
    let target = match dimension {
        0 => &mut next.worker_target,
        1 => &mut next.spawn_reserve,
        2 => &mut next.explore_radius,
        _ => &mut next.population_ceiling,
    };
    if rng.next_int(2) == 0 {
        step = -step;
    }
    *target = (*target + step).clamp(PARAM_BOUNDS[dimension][0], PARAM_BOUNDS[dimension][1]);
    next
}

/// 以概率 0.2 扰动一个维度 ±(1..2) 步 + clamp（与 Go `mutate` 内联逻辑对偶，
/// RNG 调用顺序一致：概率、步长、符号）。
fn maybe_step(value: i32, bounds: [i32; 2], rng: &mut SplitMix64) -> i32 {
    if rng.next_f64() < 0.2 {
        let mut step = 1 + rng.next_int(2) as i32;
        if rng.next_int(2) == 0 {
            step = -step;
        }
        return (value + step).clamp(bounds[0], bounds[1]);
    }
    value
}

/// 每维度 0.2 概率扰动（与 Go `mutate` 对偶）。
fn mutate(params: SearchParams, rng: &mut SplitMix64) -> SearchParams {
    SearchParams {
        worker_target: maybe_step(params.worker_target, PARAM_BOUNDS[0], rng),
        spawn_reserve: maybe_step(params.spawn_reserve, PARAM_BOUNDS[1], rng),
        explore_radius: maybe_step(params.explore_radius, PARAM_BOUNDS[2], rng),
        population_ceiling: maybe_step(params.population_ceiling, PARAM_BOUNDS[3], rng),
    }
}

/// 均匀交叉：每维度独立等概率从父代之一继承（与 Go `crossover` 对偶）。
fn crossover(a: SearchParams, b: SearchParams, rng: &mut SplitMix64) -> SearchParams {
    SearchParams {
        worker_target: if rng.next_int(2) == 0 {
            b.worker_target
        } else {
            a.worker_target
        },
        spawn_reserve: if rng.next_int(2) == 0 {
            b.spawn_reserve
        } else {
            a.spawn_reserve
        },
        explore_radius: if rng.next_int(2) == 0 {
            b.explore_radius
        } else {
            a.explore_radius
        },
        population_ceiling: if rng.next_int(2) == 0 {
            b.population_ceiling
        } else {
            a.population_ceiling
        },
    }
}

/// 锦标赛选择：随机选 size 个个体，返回适应度最优者（与 Go
/// `tournamentSelect` 对偶）。
fn tournament_select(
    pop: &[SearchParams],
    fitness: &[f64],
    size: usize,
    rng: &mut SplitMix64,
) -> SearchParams {
    let mut best_index = rng.next_int(pop.len() as i64) as usize;
    let mut best_fitness = fitness[best_index];
    for _ in 1..size {
        let index = rng.next_int(pop.len() as i64) as usize;
        if fitness[index] > best_fitness {
            best_index = index;
            best_fitness = fitness[index];
        }
    }
    pop[best_index]
}

// ---------------------------------------------------------------------------
// 三评分场景（与 Go `optState*`/`optLatentResources` 坐标逐一照抄）
// ---------------------------------------------------------------------------

/// 基准场景 refill 潜在资源池（12 格：与 optState 初始可见格同源 +
/// 周边扩展格，见 Go 注释）。
fn opt_latent_resources() -> Vec<Position> {
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

/// 密集场景 refill 潜在池（16 格，见 Go 注释：8 初始可见 + 6 周边扩展 +
/// 2 邻 chunk 格）。
fn opt_dense_latent_resources() -> Vec<Position> {
    vec![
        [37, 38],
        [37, 39],
        [37, 40],
        [38, 38],
        [38, 40],
        [39, 38],
        [39, 39],
        [39, 40],
        [36, 39],
        [40, 39],
        [38, 36],
        [38, 42],
        [37, 37],
        [39, 41],
        [30, 42],
        [31, 39],
    ]
}

/// 稀疏场景 refill 潜在池（6 格：沿三个远资源方向扩展）。
fn opt_sparse_latent_resources() -> Vec<Position> {
    vec![[26, 30], [30, 26], [50, 30], [46, 26], [36, 58], [40, 54]]
}

/// 三评分场景共享初始框架（Core 满载 worker 死锁起点 + 空载 worker 在外 +
/// beacon；仅资源/障碍分布不同）。
fn opt_state_frame() -> TickState {
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
        units: vec![worker_full.clone(), worker_empty.clone()],
        workers: vec![worker_full, worker_empty],
        vanguards: Vec::new(),
        rangers: Vec::new(),
        visible_enemies: Vec::new(),
        resource_cells: CellSet::new(),
        obstacle_cells: CellSet::new(),
        beacon: Beacon {
            position: [-17, 77],
            status: BeaconStatus::Ground,
            carrier_id: None,
        },
        events: Vec::new(),
        state_hash: String::new(),
    }
}

/// 基准评分场景（真实拓扑 + 满载死锁起点 + 6 资源格 + 12 格 fixture 障碍）。
fn opt_state() -> TickState {
    let mut state = opt_state_frame();
    state.resource_cells = [
        cell_key(38, 45),
        cell_key(30, 34),
        cell_key(46, 34),
        cell_key(30, 46),
        cell_key(46, 46),
        cell_key(38, 26),
    ]
    .into_iter()
    .collect();
    for cell in [
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
    ] {
        state.obstacle_cells.insert(cell_key(cell[0], cell[1]));
    }
    state
}

/// 密集资源评分场景：Core 周围 8 格全资源、无障碍。
fn opt_state_dense() -> TickState {
    let mut state = opt_state_frame();
    state.resource_cells = [
        cell_key(37, 38),
        cell_key(37, 39),
        cell_key(37, 40),
        cell_key(38, 38),
        cell_key(38, 40),
        cell_key(39, 38),
        cell_key(39, 39),
        cell_key(39, 40),
    ]
    .into_iter()
    .collect();
    state
}

/// 稀疏资源评分场景：Core 远处 3 资源格 + 8 个自构造障碍。
fn opt_state_sparse() -> TickState {
    let mut state = opt_state_frame();
    state.resource_cells = [cell_key(28, 28), cell_key(48, 28), cell_key(38, 56)]
        .into_iter()
        .collect();
    for cell in [
        [37, 38],
        [39, 40],
        [36, 42],
        [42, 37],
        [38, 50],
        [35, 36],
        [43, 43],
        [45, 41],
    ] {
        state.obstacle_cells.insert(cell_key(cell[0], cell[1]));
    }
    state
}

/// 三评分场景（与 Go `evaluateMulti`/`evaluateBatch` 内 scenes 一致）。
fn evaluation_scenarios() -> [Scenario; 3] {
    [
        Scenario {
            name: "base".to_string(),
            initial: opt_state(),
            latent_resources: opt_latent_resources(),
        },
        Scenario {
            name: "dense".to_string(),
            initial: opt_state_dense(),
            latent_resources: opt_dense_latent_resources(),
        },
        Scenario {
            name: "sparse".to_string(),
            initial: opt_state_sparse(),
            latent_resources: opt_sparse_latent_resources(),
        },
    ]
}

/// 把搜索参数转为策略配置（与 Go `paramsToConfig` 对偶：MilitaryRatio 留 0）。
fn params_to_config(params: SearchParams) -> Config {
    Config {
        name: String::new(),
        worker_target: params.worker_target,
        population_ceiling: params.population_ceiling,
        explore_radius: params.explore_radius,
        threat_distance: 5,
        spawn_reserve: params.spawn_reserve,
        military_ratio: 0,
        enable_core_migration: false,
    }
}

/// 单结果经济产出评分：spawns×3 + deposits×5 + harvests×2 + workers×10
/// （与 Go `evaluateScenario` 内公式一致）。
fn score_of(result: &BatchResult) -> f64 {
    result.stats.spawns as f64 * 3.0
        + result.stats.deposits as f64 * 5.0
        + result.stats.harvests as f64 * 2.0
        + result.final_state.workers.len() as f64 * 10.0
}

/// 三场景各自得分（base/dense/sparse）。
#[derive(Debug, Clone, Copy)]
struct ScenarioScores {
    base: f64,
    dense: f64,
    sparse: f64,
}

/// 三场景批量评估，返回最低分（最差场景决定评分）与各场景分
/// （与 Go `evaluateMulti` 对偶）。
fn evaluate_multi(params: SearchParams) -> (f64, ScenarioScores) {
    let results = batch(
        &evaluation_scenarios(),
        &[params_to_config(params)],
        TICKS,
        BatchOption::default(),
    );
    let mut scores = ScenarioScores {
        base: 0.0,
        dense: 0.0,
        sparse: 0.0,
    };
    for result in &results {
        let score = score_of(result);
        match result.scene.as_str() {
            "base" => scores.base = score,
            "dense" => scores.dense = score,
            "sparse" => scores.sparse = score,
            _ => {}
        }
    }
    (scores.base.min(scores.dense).min(scores.sparse), scores)
}

/// 批量评估多个个体的三场景最差分（一次 batch 跑完 N×3 评估，rayon 并行），
/// 返回与输入顺序一致的得分数组（按 policy 名从 batch 结果里筛三场景最低分，
/// 与 Go `evaluateBatch` 对偶）。
fn evaluate_batch(params: &[SearchParams]) -> Vec<f64> {
    let policies: Vec<Config> = params.iter().map(|&p| params_to_config(p)).collect();
    let results = batch(
        &evaluation_scenarios(),
        &policies,
        TICKS,
        BatchOption::default(),
    );
    let mut scores = vec![f64::INFINITY; params.len()];
    for (index, &params_i) in params.iter().enumerate() {
        let want = policy_name(&params_to_config(params_i));
        let mut min_score = f64::INFINITY;
        for result in &results {
            if result.policy != want {
                continue;
            }
            min_score = min_score.min(score_of(result));
        }
        scores[index] = min_score;
    }
    scores
}

/// 格式化三场景分，如 `{129, 150, 100}`（base, dense, sparse；与 Go
/// `formatScores` 的 `%.0f` 一致）。
fn format_scores(scores: ScenarioScores) -> String {
    format!(
        "{{{:.0}, {:.0}, {:.0}}}",
        scores.base, scores.dense, scores.sparse
    )
}

/// 格式化参数（与 Go `%+v` 结构体输出一致：
/// `{workerTarget:8 spawnReserve:5 exploreRadius:16 populationCeiling:20}`）。
fn format_params(params: SearchParams) -> String {
    format!(
        "{{workerTarget:{} spawnReserve:{} exploreRadius:{} populationCeiling:{}}}",
        params.worker_target,
        params.spawn_reserve,
        params.explore_radius,
        params.population_ceiling
    )
}

// ---------------------------------------------------------------------------
// 搜索主流程（与 Go `main`/`simulatedAnnealing`/`geneticAlgorithm` 对偶）
// ---------------------------------------------------------------------------

/// 模拟退火：温度 50 线性 ×0.99 降温（下限 1），Metropolis 接受准则。
fn simulated_annealing(iterations: i32, rng: &mut SplitMix64) {
    print!("{}", simulated_annealing_report(iterations, rng));
}

/// SA 报告文本（独立成函数供确定性/格式测试）。
fn simulated_annealing_report(iterations: i32, rng: &mut SplitMix64) -> String {
    let mut current = default_params();
    let (mut current_score, mut current_scores) = evaluate_multi(current);
    let mut best = current;
    let mut best_score = current_score;
    let mut best_scores = current_scores;

    let mut report = String::new();
    writeln!(
        report,
        "=== simulated annealing ({iterations} iterations, {TICKS} ticks) ==="
    )
    .expect("write report");
    writeln!(
        report,
        "start: {} score={:.0} scenario: {}",
        format_params(current),
        current_score,
        format_scores(current_scores)
    )
    .expect("write report");

    let mut temperature = 50.0_f64;
    let mut accepts = 0;
    for _ in 0..iterations {
        let candidate = neighbor(current, rng);
        let (candidate_score, candidate_scores) = evaluate_multi(candidate);
        let delta = candidate_score - current_score;
        if delta >= 0.0 || rng.next_f64() < (delta / temperature).exp() {
            current = candidate;
            current_score = candidate_score;
            current_scores = candidate_scores;
            accepts += 1;
            if current_score > best_score {
                best = current;
                best_score = current_score;
                // Go 此处用 candidateScores；current_scores 刚被赋为同值。
                best_scores = current_scores;
            }
        }
        temperature *= 0.99;
        if temperature < 1.0 {
            temperature = 1.0;
        }
    }
    writeln!(
        report,
        "best: {} score={:.0} scenario: {} (accepts={accepts})",
        format_params(best),
        best_score,
        format_scores(best_scores)
    )
    .expect("write report");
    let default = default_params();
    let (default_score, default_scores) = evaluate_multi(default);
    writeln!(
        report,
        "default: {} score={:.0} scenario: {}",
        format_params(default),
        default_score,
        format_scores(default_scores)
    )
    .expect("write report");
    report
}

/// 遗传算法：种群 20 × generations 代，锦标赛 size 3 + 均匀交叉 + 变异，
/// 精英保留。初始种群与每代除精英外一次 batch 并行评估。
fn genetic_algorithm(generations: i32, rng: &mut SplitMix64) {
    print!("{}", genetic_algorithm_report(generations, rng));
}

/// GA 报告文本（独立成函数供确定性/格式测试）。
fn genetic_algorithm_report(generations: i32, rng: &mut SplitMix64) -> String {
    const POPULATION_SIZE: usize = 20;

    let mut pop: Vec<SearchParams> = (0..POPULATION_SIZE).map(|_| random_params(rng)).collect();
    let mut fitness = vec![0.0; POPULATION_SIZE];
    let mut best = pop[0];
    let mut best_score = fitness[0];
    let mut best_scores = ScenarioScores {
        base: 0.0,
        dense: 0.0,
        sparse: 0.0,
    };

    // 初始种群批量并发评估（20 个体 × 3 场景 = 60 评估一次 batch 并行）。
    let seed_fitness = evaluate_batch(&pop);
    for (index, &seed_score) in seed_fitness.iter().enumerate() {
        fitness[index] = seed_score;
        if seed_score > best_score {
            best = pop[index];
            best_score = seed_score;
            best_scores = scores_for(best);
        }
    }

    let mut report = String::new();
    writeln!(
        report,
        "=== genetic algorithm ({generations} gen, population {POPULATION_SIZE}, {TICKS} ticks) ==="
    )
    .expect("write report");
    writeln!(
        report,
        "seed: {} score={:.0} scenario: {}",
        format_params(best),
        best_score,
        format_scores(best_scores)
    )
    .expect("write report");

    for gen in 0..generations {
        let mut next = vec![default_params(); POPULATION_SIZE];
        let mut next_fitness = vec![0.0; POPULATION_SIZE];
        // 精英保留：最优个体直接进入下一代。
        next[0] = best;
        next_fitness[0] = best_score;
        for slot in next.iter_mut().skip(1) {
            let parent1 = tournament_select(&pop, &fitness, 3, rng);
            let parent2 = tournament_select(&pop, &fitness, 3, rng);
            *slot = mutate(crossover(parent1, parent2, rng), rng);
        }
        // 除精英外批量并发评估（19 个体 × 3 场景 = 57 评估一次 batch）。
        let batch_fitness = evaluate_batch(&next[1..]);
        for (index, &batch_score) in batch_fitness.iter().enumerate() {
            let individual_index = index + 1;
            next_fitness[individual_index] = batch_score;
            if batch_score > best_score {
                best = next[individual_index];
                best_score = batch_score;
                best_scores = scores_for(best);
            }
        }
        pop = next;
        fitness = next_fitness;
        if gen % 10 == 9 || gen == generations - 1 {
            writeln!(
                report,
                "  gen {:3}: best={:.0} {}",
                gen + 1,
                best_score,
                format_params(best)
            )
            .expect("write report");
        }
    }
    writeln!(
        report,
        "best: {} score={:.0} scenario: {}",
        format_params(best),
        best_score,
        format_scores(best_scores)
    )
    .expect("write report");
    let default = default_params();
    let (default_score, default_scores) = evaluate_multi(default);
    writeln!(
        report,
        "default: {} score={:.0} scenario: {}",
        format_params(default),
        default_score,
        format_scores(default_scores)
    )
    .expect("write report");
    report
}

/// 计算单个体的三场景最差分（best 更新时用；与 Go `scoresFor` 对偶）。
fn scores_for(params: SearchParams) -> ScenarioScores {
    evaluate_multi(params).1
}

fn main() {
    let mut iterations: i32 = 400;
    let mut use_ga = false;
    for arg in std::env::args().skip(1) {
        if arg == "--ga" {
            use_ga = true;
            continue;
        }
        if let Ok(n) = arg.parse::<i32>() {
            if n > 0 {
                iterations = n;
            }
        }
    }
    let mut rng = SplitMix64::new(RNG_SEED);
    if use_ga {
        genetic_algorithm(iterations, &mut rng);
    } else {
        simulated_annealing(iterations, &mut rng);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_params_match_spec() {
        let params = default_params();
        assert_eq!(
            (
                params.worker_target,
                params.spawn_reserve,
                params.explore_radius,
                params.population_ceiling
            ),
            (8, 5, 16, 20)
        );
    }

    #[test]
    fn random_params_stay_in_bounds() {
        let mut rng = SplitMix64::new(RNG_SEED);
        for _ in 0..2000 {
            let params = random_params(&mut rng);
            assert!((PARAM_BOUNDS[0][0]..=PARAM_BOUNDS[0][1]).contains(&params.worker_target));
            assert!((PARAM_BOUNDS[1][0]..=PARAM_BOUNDS[1][1]).contains(&params.spawn_reserve));
            assert!((PARAM_BOUNDS[2][0]..=PARAM_BOUNDS[2][1]).contains(&params.explore_radius));
            assert!((PARAM_BOUNDS[3][0]..=PARAM_BOUNDS[3][1]).contains(&params.population_ceiling));
        }
    }

    #[test]
    fn neighbor_perturbs_exactly_one_dimension() {
        let mut rng = SplitMix64::new(RNG_SEED);
        for _ in 0..2000 {
            let params = default_params(); // 全部位于边界内部，clamp 不会吞掉步长
            let next = neighbor(params, &mut rng);
            let deltas = [
                next.worker_target - params.worker_target,
                next.spawn_reserve - params.spawn_reserve,
                next.explore_radius - params.explore_radius,
                next.population_ceiling - params.population_ceiling,
            ];
            assert_eq!(
                deltas.iter().filter(|d| **d != 0).count(),
                1,
                "exactly one dimension must change"
            );
            let step = deltas.iter().find(|d| **d != 0).copied().unwrap();
            assert!([-2, -1, 1, 2].contains(&step));
        }
    }

    #[test]
    fn mutate_keeps_params_in_bounds() {
        let mut rng = SplitMix64::new(RNG_SEED);
        for _ in 0..2000 {
            let params = random_params(&mut rng);
            let next = mutate(params, &mut rng);
            assert!((PARAM_BOUNDS[0][0]..=PARAM_BOUNDS[0][1]).contains(&next.worker_target));
            assert!((PARAM_BOUNDS[1][0]..=PARAM_BOUNDS[1][1]).contains(&next.spawn_reserve));
            assert!((PARAM_BOUNDS[2][0]..=PARAM_BOUNDS[2][1]).contains(&next.explore_radius));
            assert!((PARAM_BOUNDS[3][0]..=PARAM_BOUNDS[3][1]).contains(&next.population_ceiling));
        }
    }

    #[test]
    fn crossover_inherits_fields_from_parents_only() {
        let a = SearchParams {
            worker_target: 2,
            spawn_reserve: 0,
            explore_radius: 8,
            population_ceiling: 10,
        };
        let b = SearchParams {
            worker_target: 16,
            spawn_reserve: 8,
            explore_radius: 32,
            population_ceiling: 30,
        };
        let mut rng = SplitMix64::new(RNG_SEED);
        for _ in 0..500 {
            let child = crossover(a, b, &mut rng);
            assert!([a.worker_target, b.worker_target].contains(&child.worker_target));
            assert!([a.spawn_reserve, b.spawn_reserve].contains(&child.spawn_reserve));
            assert!([a.explore_radius, b.explore_radius].contains(&child.explore_radius));
            assert!(
                [a.population_ceiling, b.population_ceiling].contains(&child.population_ceiling)
            );
        }
    }

    #[test]
    fn tournament_select_returns_population_member_deterministically() {
        let pop = [
            SearchParams {
                worker_target: 2,
                spawn_reserve: 0,
                explore_radius: 8,
                population_ceiling: 10,
            },
            SearchParams {
                worker_target: 6,
                spawn_reserve: 3,
                explore_radius: 16,
                population_ceiling: 18,
            },
            SearchParams {
                worker_target: 10,
                spawn_reserve: 5,
                explore_radius: 24,
                population_ceiling: 24,
            },
            SearchParams {
                worker_target: 14,
                spawn_reserve: 8,
                explore_radius: 32,
                population_ceiling: 30,
            },
        ];
        let fitness = [10.0, 40.0, 30.0, 20.0];
        let mut rng_a = SplitMix64::new(RNG_SEED);
        let mut rng_b = SplitMix64::new(RNG_SEED);
        for _ in 0..500 {
            let winner_a = tournament_select(&pop, &fitness, 3, &mut rng_a);
            let winner_b = tournament_select(&pop, &fitness, 3, &mut rng_b);
            assert_eq!(winner_a, winner_b, "same seed must give same winner");
            assert!(
                pop.contains(&winner_a),
                "winner must be a population member"
            );
        }
    }

    #[test]
    fn format_params_matches_go_plus_v_style() {
        assert_eq!(
            format_params(default_params()),
            "{workerTarget:8 spawnReserve:5 exploreRadius:16 populationCeiling:20}"
        );
    }

    #[test]
    fn format_scores_matches_go_style() {
        let scores = ScenarioScores {
            base: 129.0,
            dense: 150.0,
            sparse: 100.0,
        };
        assert_eq!(format_scores(scores), "{129, 150, 100}");
    }

    #[test]
    fn evaluate_multi_returns_min_of_three_scenarios() {
        let (min_score, scores) = evaluate_multi(default_params());
        let expected_min = scores.base.min(scores.dense).min(scores.sparse);
        assert!((min_score - expected_min).abs() < f64::EPSILON);
        assert!(scores.base >= 0.0 && scores.dense >= 0.0 && scores.sparse >= 0.0);
    }

    #[test]
    fn evaluate_batch_agrees_with_evaluate_multi() {
        let samples = [
            default_params(),
            SearchParams {
                worker_target: 13,
                spawn_reserve: 0,
                explore_radius: 17,
                population_ceiling: 16,
            },
            SearchParams {
                worker_target: 6,
                spawn_reserve: 2,
                explore_radius: 24,
                population_ceiling: 14,
            },
            SearchParams {
                worker_target: 10,
                spawn_reserve: 8,
                explore_radius: 12,
                population_ceiling: 26,
            },
        ];
        let batch_scores = evaluate_batch(&samples);
        for (index, &params) in samples.iter().enumerate() {
            let (min_score, _) = evaluate_multi(params);
            assert!(
                (batch_scores[index] - min_score).abs() < f64::EPSILON,
                "param {index} score mismatch: batch={} multi={}",
                batch_scores[index],
                min_score
            );
        }
    }

    #[test]
    fn simulated_annealing_is_deterministic_for_same_seed() {
        let report_a = simulated_annealing_report(3, &mut SplitMix64::new(RNG_SEED));
        let report_b = simulated_annealing_report(3, &mut SplitMix64::new(RNG_SEED));
        assert_eq!(
            report_a, report_b,
            "same seed must produce byte-identical output"
        );
    }

    #[test]
    fn simulated_annealing_report_has_required_sections() {
        let report = simulated_annealing_report(2, &mut SplitMix64::new(RNG_SEED));
        assert!(report.starts_with("=== simulated annealing (2 iterations, 100 ticks) ===\n"));
        assert!(
            report.contains("start: {workerTarget:8 spawnReserve:5 exploreRadius:16 populationCeiling:20} score="),
            "missing start line: {report}"
        );
        assert!(report.contains("\nbest: "), "missing best line");
        assert!(report.contains("(accepts="), "missing accepts counter");
        assert!(
            report.contains("default: {workerTarget:8 spawnReserve:5 exploreRadius:16 populationCeiling:20} score="),
            "missing default line"
        );
    }

    #[test]
    fn genetic_algorithm_is_deterministic_for_same_seed() {
        let report_a = genetic_algorithm_report(2, &mut SplitMix64::new(RNG_SEED));
        let report_b = genetic_algorithm_report(2, &mut SplitMix64::new(RNG_SEED));
        assert_eq!(
            report_a, report_b,
            "same seed must produce byte-identical output"
        );
    }

    #[test]
    fn genetic_algorithm_report_has_required_sections() {
        let report = genetic_algorithm_report(2, &mut SplitMix64::new(RNG_SEED));
        assert!(report.starts_with("=== genetic algorithm (2 gen, population 20, 100 ticks) ===\n"));
        assert!(report.contains("\nseed: "), "missing seed line");
        assert!(report.contains("\nbest: "), "missing best line");
        assert!(report.contains("\ndefault: "), "missing default line");
        // Go 进度打印条件：gen%10==9 || gen==generations-1（2 代只打最后一行）。
        assert!(
            report.contains("  gen   2: best="),
            "missing final gen progress line: {report}"
        );
        assert!(
            !report.contains("  gen   1:"),
            "gen 1 must not print progress line"
        );
    }

    #[test]
    fn genetic_algorithm_prints_decade_progress_line() {
        let report = genetic_algorithm_report(10, &mut SplitMix64::new(RNG_SEED));
        assert!(
            report.contains("  gen  10: best="),
            "missing decadal progress line"
        );
    }
}
