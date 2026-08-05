//! 有界 BFS 最短路导航（从 go-rewrite `internal/domain/nav.go` 移植）。
//!
//! 语义与 TS 版 `nav.ts` 一致：margin 边界框 + 20,000 访问上限；StepToward
//! 依次尝试 margin 4/8/16/32，目标在框外时跳过必然失败的 margin。
//! BFS visited 用 `HashSet<Position>`（仅成员判断，无迭代，确定性不受
//! 哈希随机化影响；与 Go 版 map[Position]struct{} 语义一致）。

use std::collections::HashSet;

use crate::{cell_key, parse_cell_key, CellSet, Direction, Position};

/// 探索方位数（顺时针 8 方位）。
pub const EXPLORE_DIRECTION_COUNT: usize = 8;
/// 探索扩圈层级数。
pub const EXPLORE_RING_COUNT: usize = 4;
/// 单次 BFS 的访问上限（与 TS 版 visited.size <= 20_000 一致）。
pub const MAX_VISITED_NODES: usize = 20_000;

/// directionOrder 是 ordered_directions 的补齐顺序（RIGHT/DOWN/LEFT/UP）。
const DIRECTION_ORDER: [Direction; 4] = [
    Direction::Right,
    Direction::Down,
    Direction::Left,
    Direction::Up,
];

/// pathMargins 是 step_toward 逐级扩大的搜索边界（与 TS 版一致）。
pub const PATH_MARGINS: [i32; 4] = [4, 8, 16, 32];

/// exploreDeltas 是顺时针 8 方位：东、东南、南、西南、西、西北、北、东北。
const EXPLORE_DELTAS: [Position; 8] = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
];

/// 曼哈顿距离。
pub fn manhattan(a: Position, b: Position) -> i32 {
    (a[0] - b[0]).abs() + (a[1] - b[1]).abs()
}

/// 切比雪夫距离。
pub fn chebyshev(a: Position, b: Position) -> i32 {
    (a[0] - b[0]).abs().max((a[1] - b[1]).abs())
}

/// 从 position 沿 direction 移动一格后的坐标。
pub fn move_position(position: Position, direction: Direction) -> Position {
    match direction {
        Direction::Up => [position[0], position[1] - 1],
        Direction::Down => [position[0], position[1] + 1],
        Direction::Left => [position[0] - 1, position[1]],
        Direction::Right => [position[0] + 1, position[1]],
    }
}

/// 返回从 from 到相邻格 to 的方向；不相邻返回 None（与 Go 同语义）。
pub fn direction_to_adjacent(from: Position, to: Position) -> Option<Direction> {
    let dx = to[0] - from[0];
    let dy = to[1] - from[1];
    if dx.abs() + dy.abs() != 1 {
        return None;
    }
    match (dx, dy) {
        (1, _) => Some(Direction::Right),
        (-1, _) => Some(Direction::Left),
        (_, 1) => Some(Direction::Down),
        _ => Some(Direction::Up),
    }
}

/// 报告 a→b 视线是否被障碍遮挡（与 Go `LineBlocked` 同语义：
/// 相邻恒畅通；非整步长（不共线）视为遮挡）。
pub fn line_blocked(a: Position, b: Position, obstacles: &CellSet) -> bool {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let steps = dx.abs().max(dy.abs());
    if steps <= 1 {
        return false;
    }
    let sx = if dx != 0 { dx / steps } else { 0 };
    let sy = if dy != 0 { dy / steps } else { 0 };
    if sx * steps != dx || sy * steps != dy {
        return true;
    }
    for step in 1..steps {
        if obstacles.contains(&cell_key(a[0] + sx * step, a[1] + sy * step)) {
            return true;
        }
    }
    false
}

/// BFS 队列节点（parent_index 指向队列中父节点，None 为起点）。
#[derive(Clone, Copy)]
struct BfsNode {
    position: Position,
    parent_index: Option<usize>,
}

/// 返回 from→to 的最短路（含两端，逐格相邻），障碍视为永久阻塞。
/// 有界搜索：margin 边界框 + 20,000 访问上限；框内不可达返回 None。
/// from==to 返回单元素路径。
pub fn shortest_path(
    from: Position,
    to: Position,
    obstacles: &CellSet,
    margin: i32,
) -> Option<Vec<Position>> {
    if from == to {
        return Some(vec![from]);
    }
    let (min_x, max_x, min_y, max_y) = search_bounds(from, to, margin);
    let mut queue: Vec<BfsNode> = Vec::with_capacity(64);
    queue.push(BfsNode {
        position: from,
        parent_index: None,
    });
    let mut visited: HashSet<Position> = HashSet::new();
    visited.insert(from);
    let mut head = 0;
    while head < queue.len() && visited.len() <= MAX_VISITED_NODES {
        let current = queue[head];
        head += 1;
        for direction in ordered_directions(current.position, to) {
            let next = move_position(current.position, direction);
            if next[0] < min_x || next[0] > max_x || next[1] < min_y || next[1] > max_y {
                continue;
            }
            if visited.contains(&next) {
                continue;
            }
            if obstacles.contains(&cell_key(next[0], next[1])) {
                continue;
            }
            if next == to {
                return Some(reconstruct_path(&queue, head - 1, next));
            }
            visited.insert(next);
            queue.push(BfsNode {
                position: next,
                parent_index: Some(head - 1),
            });
        }
    }
    None
}

/// 在 margin 边界框内做有界 BFS，返回 from→to 最短路的第一步。
/// 不可达返回 None。
pub fn shortest_path_first_step(
    from: Position,
    to: Position,
    obstacles: &CellSet,
    margin: i32,
) -> Option<Direction> {
    let (min_x, max_x, min_y, max_y) = search_bounds(from, to, margin);
    let obstacle_pos: HashSet<Position> = obstacles
        .iter()
        .filter_map(|key| parse_cell_key(key))
        .collect();
    shortest_path_first_step_keyed(from, to, &obstacle_pos, min_x, max_x, min_y, max_y)
}

/// Position-keyed BFS 主体（零字符串分配）。
fn shortest_path_first_step_keyed(
    from: Position,
    to: Position,
    obstacle_pos: &HashSet<Position>,
    min_x: i32,
    max_x: i32,
    min_y: i32,
    max_y: i32,
) -> Option<Direction> {
    #[derive(Clone, Copy)]
    struct FirstStepNode {
        position: Position,
        first_direction: Option<Direction>,
    }
    let mut queue: Vec<FirstStepNode> = Vec::with_capacity(64);
    queue.push(FirstStepNode {
        position: from,
        first_direction: None,
    });
    let mut visited: HashSet<Position> = HashSet::new();
    visited.insert(from);
    let mut directions = [Direction::Right; 4];
    let mut head = 0;
    while head < queue.len() && visited.len() <= MAX_VISITED_NODES {
        let current = queue[head];
        head += 1;
        let count = ordered_directions_into(current.position, to, &mut directions);
        for direction in &directions[..count] {
            let next = move_position(current.position, *direction);
            if next[0] < min_x || next[0] > max_x || next[1] < min_y || next[1] > max_y {
                continue;
            }
            if visited.contains(&next) {
                continue;
            }
            if obstacle_pos.contains(&next) {
                continue;
            }
            let first_direction = current.first_direction.unwrap_or(*direction);
            if next == to {
                return Some(first_direction);
            }
            visited.insert(next);
            queue.push(FirstStepNode {
                position: next,
                first_direction: Some(first_direction),
            });
        }
    }
    None
}

/// 返回朝 target 的最短路径第一步：依次尝试 margin 4/8/16/32 的有界 BFS；
/// 全部失败时 fail-safe 走一个不撞墙且尽量朝向目标的格；四周全堵或
/// 已在目标格返回 None（调用方应 WAIT）。
pub fn step_toward(position: Position, target: Position, obstacles: &CellSet) -> Option<Direction> {
    if position == target {
        return None;
    }
    let obstacle_pos: HashSet<Position> = obstacles
        .iter()
        .filter_map(|key| parse_cell_key(key))
        .collect();
    // 关键优化：目标在 margin 框外时 BFS 必然失败，跳过这些 margin。
    let distance = chebyshev(position, target);
    let mut start_margin = 0;
    while start_margin < PATH_MARGINS.len() && distance > PATH_MARGINS[start_margin] {
        start_margin += 1;
    }
    for &margin in &PATH_MARGINS[start_margin..] {
        let (min_x, max_x, min_y, max_y) = search_bounds(position, target, margin);
        if let Some(direction) = shortest_path_first_step_keyed(
            position,
            target,
            &obstacle_pos,
            min_x,
            max_x,
            min_y,
            max_y,
        ) {
            return Some(direction);
        }
    }
    let mut directions = [Direction::Right; 4];
    let count = ordered_directions_into(position, target, &mut directions);
    for direction in &directions[..count] {
        let next = move_position(position, *direction);
        if !obstacle_pos.contains(&next) {
            return Some(*direction);
        }
    }
    None
}

/// 沿父索引回溯重建 from→to 完整路径（含两端）。
fn reconstruct_path(queue: &[BfsNode], target_index: usize, target: Position) -> Vec<Position> {
    let mut path = Vec::with_capacity(queue.len());
    path.push(target);
    let mut index = Some(target_index);
    while let Some(i) = index {
        path.push(queue[i].position);
        index = queue[i].parent_index;
    }
    path.reverse();
    path
}

/// 返回 margin 边界框。
pub fn search_bounds(from: Position, to: Position, margin: i32) -> (i32, i32, i32, i32) {
    let min_x = from[0].min(to[0]) - margin;
    let max_x = from[0].max(to[0]) + margin;
    let min_y = from[1].min(to[1]) - margin;
    let max_y = from[1].max(to[1]) + margin;
    (min_x, max_x, min_y, max_y)
}

/// stamped grid BFS 搜索器：visited 用固定网格 + 世代戳（无哈希、无
/// 分配——BFS 热路径从 ~100ns/节点降到 ~5ns/节点）。跨多次 BFS 复用
/// 缓冲。与 HashSet 版语义完全一致（仅成员判断，确定性结果相同）。
///
/// 网格尺寸按搜索框动态 resize（保留历史最大容量，避免反复分配）。
#[derive(Debug, Default)]
pub struct BfsSearcher {
    visited: Vec<u32>,
    stamp: u32,
    queue: Vec<BfsEntry>,
}

#[derive(Debug, Clone, Copy)]
struct BfsEntry {
    position: Position,
    first_direction: Option<Direction>,
}

impl BfsSearcher {
    pub fn new() -> BfsSearcher {
        BfsSearcher::default()
    }

    /// 在搜索框内做有界 BFS，返回 from→to 最短路的第一步（不可达返回
    /// None）。obstacle_pos 为 Position-keyed 障碍集合（调用方每 tick
    /// 缓存一次，避免每调用字符串解析）；extra_obstacle 为动态额外障碍
    /// （如目标非 Core 时的 Core 格——planner 热路径用，免集合克隆）。
    pub fn first_step(
        &mut self,
        from: Position,
        to: Position,
        obstacle_pos: &HashSet<Position>,
        extra_obstacle: Option<Position>,
        min_x: i32,
        max_x: i32,
        min_y: i32,
        max_y: i32,
    ) -> Option<Direction> {
        let width = (max_x - min_x + 1) as usize;
        let height = (max_y - min_y + 1) as usize;
        let grid_size = width * height;
        if self.visited.len() < grid_size {
            self.visited.resize(grid_size, 0);
        }
        self.stamp = self.stamp.wrapping_add(1);
        if self.stamp == 0 {
            self.stamp = 1;
            self.visited.fill(0);
        }
        let stamp = self.stamp;

        self.queue.clear();
        self.queue.push(BfsEntry {
            position: from,
            first_direction: None,
        });
        self.visited[grid_index(from, min_x, min_y, width)] = stamp;

        let mut directions = [Direction::Right; 4];
        let mut head = 0;
        while head < self.queue.len() && head < MAX_VISITED_NODES {
            let current = self.queue[head];
            head += 1;
            let count = ordered_directions_into(current.position, to, &mut directions);
            for direction in &directions[..count] {
                let next = move_position(current.position, *direction);
                if next[0] < min_x || next[0] > max_x || next[1] < min_y || next[1] > max_y {
                    continue;
                }
                if self.visited[grid_index(next, min_x, min_y, width)] == stamp {
                    continue;
                }
                if obstacle_pos.contains(&next) || extra_obstacle == Some(next) {
                    continue;
                }
                let first_direction = current.first_direction.unwrap_or(*direction);
                if next == to {
                    return Some(first_direction);
                }
                self.visited[grid_index(next, min_x, min_y, width)] = stamp;
                self.queue.push(BfsEntry {
                    position: next,
                    first_direction: Some(first_direction),
                });
            }
        }
        None
    }
}

/// 网格索引（stamped BFS visited 定位）。
fn grid_index(pos: Position, min_x: i32, min_y: i32, width: usize) -> usize {
    ((pos[1] - min_y) as usize) * width + ((pos[0] - min_x) as usize)
}

/// 返回确定性方向顺序（与 TS/Go 版同语义）：优先主轴向（|dx| >= |dy|
/// 时 x 优先），再按 RIGHT/DOWN/LEFT/UP 补齐。
pub fn ordered_directions(from: Position, target: Position) -> Vec<Direction> {
    let mut directions = [Direction::Right; 4];
    let count = ordered_directions_into(from, target, &mut directions);
    directions[..count].to_vec()
}

/// 把确定性方向顺序写入 buffer，返回方向数（BFS 热路径免分配）。
pub fn ordered_directions_into(
    from: Position,
    target: Position,
    buffer: &mut [Direction; 4],
) -> usize {
    let dx = target[0] - from[0];
    let dy = target[1] - from[1];
    let mut index = 0;
    if dx.abs() >= dy.abs() {
        if dx > 0 {
            buffer[index] = Direction::Right;
            index += 1;
        } else if dx < 0 {
            buffer[index] = Direction::Left;
            index += 1;
        }
        if dy > 0 {
            buffer[index] = Direction::Down;
            index += 1;
        } else if dy < 0 {
            buffer[index] = Direction::Up;
            index += 1;
        }
    } else {
        if dy > 0 {
            buffer[index] = Direction::Down;
            index += 1;
        } else if dy < 0 {
            buffer[index] = Direction::Up;
            index += 1;
        }
        if dx > 0 {
            buffer[index] = Direction::Right;
            index += 1;
        } else if dx < 0 {
            buffer[index] = Direction::Left;
            index += 1;
        }
    }
    for &direction in &DIRECTION_ORDER {
        if !direction_in_buffer(buffer, index, direction) {
            buffer[index] = direction;
            index += 1;
        }
    }
    index
}

fn direction_in_buffer(buffer: &[Direction; 4], index: usize, target: Direction) -> bool {
    buffer[..index].contains(&target)
}

/// 返回指定环的探索半径：base、2×base、3×base、4×base 循环
/// （负索引循环回绕）。
pub fn explore_radius_for_ring(base_radius: i32, ring_index: i32) -> Option<i32> {
    if base_radius < 1 {
        return None;
    }
    let normalized = ((ring_index % EXPLORE_RING_COUNT as i32) + EXPLORE_RING_COUNT as i32)
        % EXPLORE_RING_COUNT as i32;
    Some(base_radius * (normalized + 1))
}

/// 返回以 home 为圆心、beacon 方向为第 0 方位、index 偏移的探索目标。
pub fn explore_target(home: Position, beacon: Position, index: usize, radius: i32) -> Position {
    let dx = beacon[0] - home[0];
    let dy = beacon[1] - home[1];
    let base = explore_octant(dx, dy);
    let delta = EXPLORE_DELTAS[(base + index) % EXPLORE_DIRECTION_COUNT];
    [home[0] + delta[0] * radius, home[1] + delta[1] * radius]
}

/// 将方位角映射到 0..7 的八方位索引（与 TS/Go 版同语义；Go 用
/// math.Round，与 JS Math.round 的差异仅出现在非整倍数 π/4 的边界角）。
fn explore_octant(dx: i32, dy: i32) -> usize {
    if dx == 0 && dy == 0 {
        return 0;
    }
    let angle = (dy as f64).atan2(dx as f64);
    let octant = (angle / (std::f64::consts::PI / 4.0)).round() as i32;
    ((octant + EXPLORE_DIRECTION_COUNT as i32) % EXPLORE_DIRECTION_COUNT as i32) as usize
}

/// 返回距 position 最近的目标（曼哈顿距离，同距离取 x 小再 y 小）。
/// 无目标返回 None。
pub fn nearest(targets: &[Position], position: Position) -> Option<Position> {
    let mut best: Option<Position> = None;
    let mut best_key = [0; 3];
    for &target in targets {
        let key = [manhattan(position, target), target[0], target[1]];
        if best.is_none() || compare_tuple(key, best_key) < 0 {
            best = Some(target);
            best_key = key;
        }
    }
    best
}

fn compare_tuple(a: [i32; 3], b: [i32; 3]) -> i32 {
    for i in 0..3 {
        if a[i] != b[i] {
            return a[i] - b[i];
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_of(keys: &[&str]) -> CellSet {
        keys.iter().map(|k| k.to_string()).collect()
    }

    #[test]
    fn step_toward_returns_shortest_first_step() {
        // (0,0) → (3,0) 无障碍，第一步应为 RIGHT。
        let direction = step_toward([0, 0], [3, 0], &CellSet::new()).unwrap();
        assert_eq!(direction, Direction::Right);
    }

    #[test]
    fn step_toward_at_target_returns_none() {
        assert!(step_toward([3, 3], [3, 3], &CellSet::new()).is_none());
    }

    #[test]
    fn shortest_path_first_step_ring_blocked() {
        // 环形障碍围住目标：{10,0}→{0,0}，margin 4 内不可达（与 Go
        // nav_test 同断言；StepToward 另有 fail-safe 兜底不在此测）。
        let ring = set_of(&["1,0", "0,1", "-1,0", "0,-1", "2,0", "0,2", "-2,0", "0,-2"]);
        assert!(shortest_path_first_step([10, 0], [0, 0], &ring, 4).is_none());
    }

    #[test]
    fn line_blocked_basic() {
        // 中间格有障碍 → 视线遮挡（与 Go 同语义：steps>1 逐格检查）。
        let obstacles = set_of(&["1,0"]);
        assert!(line_blocked([0, 0], [3, 0], &obstacles));
        assert!(line_blocked([0, 0], [2, 0], &obstacles));
        assert!(!line_blocked([0, 0], [2, 0], &CellSet::new()));
        // 非共线（非整步长）视为遮挡。
        assert!(line_blocked([0, 0], [2, 1], &CellSet::new()));
    }

    #[test]
    fn shortest_path_reconstructs_full_path() {
        let path = shortest_path([0, 0], [2, 0], &CellSet::new(), 4).unwrap();
        assert_eq!(path, vec![[0, 0], [1, 0], [2, 0]]);
    }

    #[test]
    fn ordered_directions_priority() {
        // 目标在右下方：|dx| >= |dy| 时 x 优先 → RIGHT 先于 DOWN。
        let directions = ordered_directions([0, 0], [3, 1]);
        assert_eq!(directions[0], Direction::Right);
        assert_eq!(directions[1], Direction::Down);
    }

    #[test]
    fn explore_radius_for_ring_cycles() {
        assert_eq!(explore_radius_for_ring(17, 0), Some(17));
        assert_eq!(explore_radius_for_ring(17, 3), Some(68));
        assert_eq!(explore_radius_for_ring(17, 4), Some(17));
        assert_eq!(explore_radius_for_ring(17, -1), Some(68));
    }

    #[test]
    fn nearest_uses_manhattan_then_x_then_y() {
        // 距离 4 的两个目标：同距取 x 小 → [3,1]（与 Go compareTuple 一致）。
        let targets = vec![[5, 0], [3, 1], [4, 0]];
        assert_eq!(nearest(&targets, [0, 0]), Some([3, 1]));
    }
}
