//! 经济规划辅助（从 go-rewrite `internal/strategy/economic.go` 移植）：
//! worker 全局资源分配 + 移动目标冲突仲裁 + Core 恢复期（respawn
//! override）判定。

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use arena_sim_domain::{
    cell_key, manhattan, move_position, parse_cell_key, CoreStatus, Direction, Position, TickState,
    UnitAction, UnitActionKind, UnitSnapshot,
};

/// 补员紧急线（对齐 TS 版 WORKER_RECOVERY_FLOOR）：worker 数低于此线
/// 视为经济紧急，spawn 只要求 cost（不攒 reserve）。
pub const EMERGENCY_WORKER_FLOOR: i32 = 2;

/// 移动目标的任务优先级（数值越大越优先保留）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MovePriority {
    Explore,
    Combat,
    Harvest,
    Return,
}

/// 满载 Worker 让位 Core 时的确定性探测方向顺序（UP → RIGHT → DOWN →
/// LEFT，对齐 TS 版破锁语义）。
pub const YIELD_ORDER: [Direction; 4] = [
    Direction::Up,
    Direction::Right,
    Direction::Down,
    Direction::Left,
];

/// 为全部空手 worker 做全局资源格分配（每格至多一个 worker）。
/// 返回 unitID → 目标格：
/// - 满载 worker 不参与分配（走回仓/上交流程）；
/// - 已站在资源格上的空手 worker 本 tick 直接 HARVEST，其所在格视为占用；
/// - 其余空手 worker 按 ID 升序，各取曼哈顿距离最近的未占用格
///   （候选格先按 (x,y) 排序；平局取排序更前的格）；
/// - 资源格不足时未分到的 worker 不进入结果（调用方转探索/待命）。
pub fn assign_workers(state: &TickState) -> BTreeMap<String, Position> {
    let mut assignments = BTreeMap::new();

    let mut available: Vec<Position> = state
        .resource_cells
        .iter()
        .filter_map(|key| parse_cell_key(key))
        .collect();
    available.sort_unstable();

    let mut claimed: BTreeSet<String> = BTreeSet::new();
    let mut harvesters: BTreeSet<String> = BTreeSet::new();
    for worker in &state.workers {
        if worker.cargo > 0 {
            continue;
        }
        let key = cell_key(worker.position[0], worker.position[1]);
        if state.resource_cells.contains(&key) {
            claimed.insert(key);
            harvesters.insert(worker.id.clone());
        }
    }

    let mut workers: Vec<&UnitSnapshot> = state.workers.iter().collect();
    workers.sort_by_key(|w| w.id.clone());

    for worker in workers {
        if worker.cargo > 0 {
            continue;
        }
        if harvesters.contains(&worker.id) {
            continue;
        }
        let mut best_index: Option<usize> = None;
        let mut best_distance = 0;
        for (index, &cell) in available.iter().enumerate() {
            if claimed.contains(&cell_key(cell[0], cell[1])) {
                continue;
            }
            let distance = manhattan(worker.position, cell);
            // available 已按 (x,y) 排序：严格小于才替换 ⇒ 平局取排序更前的格。
            if best_index.is_none() || distance < best_distance {
                best_index = Some(index);
                best_distance = distance;
            }
        }
        let Some(index) = best_index else { break }; // 无未占用格：后续亦然
        let cell = available[index];
        assignments.insert(worker.id.clone(), cell);
        claimed.insert(cell_key(cell[0], cell[1]));
    }
    assignments
}

/// 一条 MOVE 候选（目标格 + 任务优先级）。
#[derive(Debug, Clone)]
pub struct MoveCandidate {
    pub unit_id: String,
    pub destination: Position,
    pub priority: MovePriority,
    pub intent: String,
}

/// 做一次性移动容量仲裁：同一目标格只保留优先级最高的单位（同优先级
/// 保留 ID 升序最小者），其余返回 loser 名单（调用方降级 WAIT）。
pub fn arbitrate_move_capacity(candidates: &[MoveCandidate]) -> Vec<MoveCandidate> {
    let mut best_by_cell: BTreeMap<String, MoveCandidate> = BTreeMap::new();
    for candidate in candidates {
        let key = cell_key(candidate.destination[0], candidate.destination[1]);
        let should_replace = match best_by_cell.get(&key) {
            None => true,
            Some(existing) => {
                candidate.priority > existing.priority
                    || (candidate.priority == existing.priority
                        && candidate.unit_id < existing.unit_id)
            }
        };
        if should_replace {
            best_by_cell.insert(key, candidate.clone());
        }
    }
    let winners: BTreeSet<String> = best_by_cell.values().map(|c| c.unit_id.clone()).collect();
    candidates
        .iter()
        .filter(|candidate| !winners.contains(&candidate.unit_id))
        .cloned()
        .collect()
}

/// 让 Worker 离开 Core 格。skip_resources=true 时跳过资源格（满载
/// Worker：踩上资源格会堵住采集格）；false 时允许踩资源格（空载 Worker
/// 被仲裁降级在 Core 上等目标：Core 4 邻域全被资源格覆盖时（dense
/// 拓扑），不踩资源格永远出不去）。
pub fn yield_from_core(
    state: &TickState,
    unit: &UnitSnapshot,
    skip_resources: bool,
) -> Option<(UnitAction, bool)> {
    let mut occupied: BTreeSet<String> = BTreeSet::new();
    for other in &state.units {
        occupied.insert(cell_key(other.position[0], other.position[1]));
    }
    for enemy in &state.visible_enemies {
        occupied.insert(cell_key(enemy.position[0], enemy.position[1]));
    }
    for direction in YIELD_ORDER {
        let next = move_position(unit.position, direction);
        let key = cell_key(next[0], next[1]);
        if state.obstacle_cells.contains(&key) {
            continue;
        }
        if skip_resources && state.resource_cells.contains(&key) {
            continue;
        }
        if occupied.contains(&key) {
            continue;
        }
        return Some((
            UnitAction {
                kind: UnitActionKind::Move,
                direction: Some(direction),
                target_id: None,
                expected_cell: None,
            },
            true,
        ));
    }
    None
}

/// 报告当前是否处于 Core 恢复期（Core 缺失 / 玩家 RESPAWNING / Core
/// 非 NORMAL）。期间强制经济模式：单位回核心防守或采最近资源（不探索
/// 远处），spawn 走紧急通道（resources >= cost 即 spawn，无视 reserve）。
pub fn respawn_override(state: &TickState) -> bool {
    if state.status == CoreStatus::Respawning {
        return true;
    }
    match &state.core {
        None => true,
        Some(core) => core.state != arena_sim_domain::CoreState::Normal,
    }
}

/// 按 ID 查找己方单位快照。
pub fn find_unit_snapshot<'a>(state: &'a TickState, unit_id: &str) -> Option<&'a UnitSnapshot> {
    state.units.iter().find(|u| u.id == unit_id)
}

/// 报告目标格是否被任一己方单位占据（除 exclude_id 外）。
pub fn occupied_by_any(state: &TickState, exclude_id: &str, cell: Position) -> bool {
    state
        .units
        .iter()
        .any(|other| other.id != exclude_id && other.position == cell)
}
