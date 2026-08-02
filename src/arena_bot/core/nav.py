"""导航工具：曼哈顿距离、直线障碍检测、寻路步进、巡逻目标计算。

全部确定性：固定方向序 + 固定 tie-break（来源：旧 tactic.py 迁移，规则 v0.10）。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from arena_hero import Direction

if TYPE_CHECKING:
    Position = tuple[int, int]

# 方向轮盘：按 (i + base) % 4 旋转，确定性错开多 Worker 巡逻方向
_DIRECTIONS = (Direction.RIGHT, Direction.DOWN, Direction.LEFT, Direction.UP)


def _direction_delta(d: Direction) -> "Position":
    return d.delta  # 官方实现：UP=(0,-1) DOWN=(0,1) LEFT=(-1,0) RIGHT=(1,0)


def manhattan(a: "Position", b: "Position") -> int:
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def line_blocked(a: "Position", b: "Position", obstacle_cells) -> bool:
    """8 方向直线（同轴或 45 度对角）中间格是否有障碍物。

    规则：射程 1-3，仅中间格障碍阻挡；目标格与旁边格不阻挡。
    """
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    steps = max(abs(dx), abs(dy))
    if steps <= 1:
        return False
    sx = dx // steps if dx else 0
    sy = dy // steps if dy else 0
    for i in range(1, steps):
        cell = (a[0] + sx * i, a[1] + sy * i)
        if cell in obstacle_cells:
            return True
    return False


def step_toward(pos: "Position", target: "Position",
                obstacle_cells) -> "Direction | None":
    """朝 target 走一步，避开可见障碍；全堵则返回 None。

    确定性：优先沿差值大的轴走（x 先于 y），方向按固定顺序。
    """
    dx = target[0] - pos[0]
    dy = target[1] - pos[1]
    primary = []
    if dx != 0:
        primary.append((Direction.RIGHT if dx > 0 else Direction.LEFT,
                        (pos[0] + (1 if dx > 0 else -1), pos[1])))
    if dy != 0:
        primary.append((Direction.DOWN if dy > 0 else Direction.UP,
                        (pos[0], pos[1] + (1 if dy > 0 else -1))))
    for d, cell in primary:
        if cell not in obstacle_cells:
            return d
    # 主轴向被堵：尝试其余两个方向
    for d, cell in ((Direction.UP, (pos[0], pos[1] - 1)),
                    (Direction.DOWN, (pos[0], pos[1] + 1)),
                    (Direction.LEFT, (pos[0] - 1, pos[1])),
                    (Direction.RIGHT, (pos[0] + 1, pos[1]))):
        if d in {p[0] for p in primary}:
            continue
        if cell not in obstacle_cells:
            return d
    return None


def explore_target(pos: "Position", home: "Position", beacon_pos: "Position",
                   index: int, radius: int) -> "Position":
    """巡逻目标：以 Core 为圆心、半径 radius 的圆周上一点。

    主方向取 Beacon 相对 Core 的轴向，再按 Worker 序号旋转轮盘错开，
    避免多 Worker 扎堆同方向。确定性：固定方向序 + 固定序号。
    """
    dx = beacon_pos[0] - home[0]
    dy = beacon_pos[1] - home[1]
    if abs(dx) >= abs(dy):
        base = 0 if dx >= 0 else 2      # RIGHT 或 LEFT
    else:
        base = 1 if dy >= 0 else 3      # DOWN 或 UP
    d = _DIRECTIONS[(base + index) % 4]
    delta = _direction_delta(d)
    return (home[0] + delta[0] * radius, home[1] + delta[1] * radius)


def nearest(targets, pos: "Position"):
    """按 (距离, x, y) 确定性选取最近目标，避免迭代顺序抖动。"""
    return min(targets, key=lambda t: (manhattan(pos, t), t[0], t[1]))
