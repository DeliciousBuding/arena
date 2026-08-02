"""Arena Hero 平衡型战术脚本（v0.10 规则）—— 长跑主力。

decide_actions(turn) 为纯决策函数，与网络连接分离，可用合成 Turn 无凭据测试。
决策顺序遵循 tactic-authoring：生命周期 → 生存 → 恢复 → 经济 → 战斗 → 移动 → Beacon → 生产。
所有选择确定性：对象按 UUID 排序，目标按 (距离, x, y) 排序，方向按固定轴顺序。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional

from arena_hero import ArenaHeroClient, BeaconStatus, CoreState, Direction, UnitType

# ---- 战术常量（对应规则 v0.10 数值，勿凭记忆改动）----
WORKER_COST = 5
VANGUARD_COST = 10
RANGER_COST = 12
RESERVE = 3          # spawn 后必须保留的应急资源（heal/维修）
WORKER_TARGET = 8    # 经济目标 Worker 数，之后开始造兵
POP_CEILING = 20     # 人口上限：tier 0 (0-19) 无 upkeep，留 1 格缓冲
HEAL_THRESHOLD = 2   # 战斗中允许保留的血量阈值（低于此值且能到家则优先回家治疗）

UNIT_MAX_HP = {UnitType.WORKER: 2, UnitType.VANGUARD: 4, UnitType.RANGER: 2}


def manhattan(a, b) -> int:
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def _line_blocked(a, b, obstacle_cells) -> bool:
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


def _step_toward(pos, target, obstacle_cells) -> Optional[Direction]:
    """朝 target 走一步，避开可见障碍；全堵则返回 None。

    确定性：优先沿差值大的轴走（x 先于 y），方向按固定顺序。
    """
    dx = target[0] - pos[0]
    dy = target[1] - pos[1]
    primary = []
    secondary = []
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


def _nearest(targets, pos):
    """按 (距离, x, y) 确定性选取最近目标，避免迭代顺序抖动。"""
    return min(targets, key=lambda t: (manhattan(pos, t), t[0], t[1]))


def decide_actions(turn) -> None:
    """纯决策：读取当前 Turn，为每个受控对象安排至多一个动作。"""
    core = turn.core
    home = core.position if core is not None else None
    core_normal = core is not None and core.view.state is CoreState.NORMAL
    obstacle = turn.obstacle_cells
    resource_cells = set(turn.resource_cells)
    enemies = sorted(turn.visible_enemies, key=lambda e: e.id)
    beacon = turn.beacon

    # 我方是否已持 Beacon（对照 carrier_id 与本单位 UUID）
    unit_ids = {u.id for u in turn.units}
    i_carry = beacon.carrier_id is not None and beacon.carrier_id in unit_ids

    def target_enemy(pos, radius):
        """视野 radius 内最近的敌人（确定性）。"""
        visible = [e for e in enemies if manhattan(pos, e.position) <= radius]
        if not visible:
            return None
        return min(visible, key=lambda e: (manhattan(pos, e.position), e.id))

    for unit in sorted(turn.units, key=lambda u: u.id):
        pos = unit.position
        # --- Beacon：与地面 Beacon 同格 → 拾取（Beacon 动作先于采集结算）---
        if (beacon.status is BeaconStatus.GROUND and pos == beacon.position
                and beacon.carrier_id is None):
            unit.pickup_beacon()
            continue
        # --- 恢复：与自家静止 Core 同格且掉血 → 治疗后结算（不占后续动作）---
        if (core_normal and home is not None and pos == home
                and unit.hp < UNIT_MAX_HP[unit.unit_type]):
            unit.heal()
            continue

        if unit.unit_type is UnitType.WORKER:
            # 经济：先交付后采集
            if unit.cargo > 0:
                if home is not None and pos == home:
                    if turn.resource_space > 0:
                        unit.deposit()
                    # 容量满：原地等待，下 Tick 再看
                elif home is not None:
                    d = _step_toward(pos, home, obstacle)
                    if d is not None:
                        unit.move(d)
                continue
            if pos in resource_cells:
                unit.harvest()
                continue
            # 朝最近可见资源格走；无资源则回家待命
            if resource_cells:
                target = _nearest(resource_cells, pos)
            elif home is not None:
                target = home
            else:
                continue  # 无 Core 且无资源：原地等待
            if target != pos:
                d = _step_toward(pos, target, obstacle)
                if d is not None:
                    unit.move(d)
            continue

        if unit.unit_type is UnitType.VANGUARD:
            # 战斗：相邻敌人 → sweep（多敌人取 UUID 最小）
            adjacent = [e for e in enemies if manhattan(pos, e.position) == 1]
            if adjacent:
                e = adjacent[0]
                unit.sweep(Direction.DOWN if e.position[1] > pos[1]
                           else Direction.UP if e.position[1] < pos[1]
                           else Direction.RIGHT if e.position[0] > pos[0]
                           else Direction.LEFT)
                continue
            # 视野内有敌人 → 逼近
            e = target_enemy(pos, 4)
            if e is not None and home is not None and manhattan(pos, home) <= 4:
                # 离 Core 近时守家优先
                target = pos
            elif e is not None:
                target = e.position
            else:
                target = home  # 无敌人：守家
            if target is not None and target != pos:
                d = _step_toward(pos, target, obstacle)
                if d is not None:
                    unit.move(d)
            continue

        if unit.unit_type is UnitType.RANGER:
            # 战斗：合法射程目标 → shoot（8 方向 1-3 格、直线无遮挡）
            best = None
            for e in enemies:
                dx = e.position[0] - pos[0]
                dy = e.position[1] - pos[1]
                dist = max(abs(dx), abs(dy))
                if dist < 1 or dist > 3:
                    continue
                if not (dx == 0 or dy == 0 or abs(dx) == abs(dy)):
                    continue
                if _line_blocked(pos, e.position, obstacle):
                    continue
                best = e
                break  # enemies 已按 UUID 排序，取第一个合法目标
            if best is not None:
                unit.shoot(best)
                continue
            # 朝最近敌人移动保持压力；无敌人守家
            e = target_enemy(pos, 5)
            target = e.position if e is not None else home
            if target is not None and target != pos:
                d = _step_toward(pos, target, obstacle)
                if d is not None:
                    unit.move(d)
            continue

    # ---- Core 决策（一个动作槽；省略 = WAIT）----
    if core is None:
        return  # RESPAWNING / 初始入场：不提交伪造动作

    cv = core.view
    if cv.hp < 5:
        core.heal()
        return
    if cv.shield < 5 and turn.resources >= 1 and cv.state is CoreState.NORMAL:
        core.repair_shield()
        return
    if cv.state is CoreState.NORMAL and turn.state.population < POP_CEILING:
        workers = [u for u in turn.workers]
        vanguards = [u for u in turn.vanguards]
        rangers = [u for u in turn.rangers]
        if len(workers) < WORKER_TARGET:
            unit_type, cost = UnitType.WORKER, WORKER_COST
        elif len(vanguards) <= len(rangers):
            unit_type, cost = UnitType.VANGUARD, VANGUARD_COST
        else:
            unit_type, cost = UnitType.RANGER, RANGER_COST
        if turn.resources >= cost + RESERVE:
            core.spawn(unit_type)


def load_api_key() -> str:
    """从 .env 或环境变量读取 API key（不经 stdout 打印）。"""
    env_path = Path(__file__).resolve().parent / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("ARENA_HERO_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.environ.get("ARENA_HERO_API_KEY", "")


def play(api_key: str) -> None:
    with ArenaHeroClient(api_key=api_key) as game:
        for turn in game.turns():
            decide_actions(turn)
            accepted = turn.submit()
            print(
                f"[tick {turn.tick}] accepted={accepted.accepted} "
                f"res={turn.resources}/{turn.resource_capacity} "
                f"pop={turn.state.population} "
                f"workers={len(turn.workers)} vg={len(turn.vanguards)} rg={len(turn.rangers)} "
                f"enemies_visible={len(turn.visible_enemies)}"
            )
            for ev in turn.events:
                print(f"  event: {ev.event_type} reason={ev.reason_code} pos={ev.position}")


def main() -> None:
    api_key = load_api_key()
    if not api_key:
        print("错误：未找到 API key（.env 的 ARENA_HERO_API_KEY 或环境变量）", file=sys.stderr)
        sys.exit(1)
    try:
        play(api_key)
    except KeyboardInterrupt:
        print("\n[战术脚本] Ctrl-C 退出")


if __name__ == "__main__":
    main()
