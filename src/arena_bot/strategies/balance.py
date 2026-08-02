"""默认平衡策略：旧 tactic.py 决策逻辑的等价迁移（确定性保持）。"""

from __future__ import annotations

from typing import TYPE_CHECKING

from arena_hero import BeaconStatus, Direction, UnitType

from ..config import UNIT_MAX_HP
from ..core.nav import (explore_target, line_blocked, manhattan, nearest,
                        step_toward)
from ..core.unit_state import WorkerState
from ..strategy import Action, Plan, Strategy

if TYPE_CHECKING:
    from ..core.state import TickState


class BalanceStrategy(Strategy):
    """平衡型：经济优先、保守生产、确定性决策。

    决策顺序（tactic-authoring 规定）：
    生命周期 → 生存 → 恢复 → 经济 → 战斗 → 移动 → Beacon → 生产
    """

    name = "balance"

    def decide(self, state: "TickState") -> Plan:
        plan = Plan(tick=state.tick)
        core = state.core
        home = state.home
        core_normal = state.core_normal
        obstacle = state.obstacle_cells
        resource_cells = set(state.resource_cells)
        enemies = sorted(state.visible_enemies, key=lambda e: e.id)
        beacon = state.beacon

        # 我方是否已持 Beacon（对照 carrier_id 与本单位 UUID）
        unit_ids = {u.id for u in state.units}
        i_carry = (beacon is not None and beacon.carrier_id is not None
                   and beacon.carrier_id in unit_ids)

        # Worker 序号（UUID 排序）用于巡逻方向错开
        worker_index = {u.id: i for i, u in enumerate(
            sorted(state.workers, key=lambda u: u.id))}

        def target_enemy(pos, radius):
            visible = [e for e in enemies if manhattan(pos, e.position) <= radius]
            if not visible:
                return None
            return min(visible, key=lambda e: (manhattan(pos, e.position), e.id))

        for unit in sorted(state.units, key=lambda u: u.id):
            pos = unit.position
            unit_type = unit.unit_type
            # --- Beacon：与地面 Beacon 同格 → 拾取（Beacon 动作先于采集结算）---
            if (beacon is not None
                    and beacon.status is BeaconStatus.GROUND
                    and pos == beacon.position and beacon.carrier_id is None):
                plan.set(Action(unit.id, "PICKUP_BEACON"), "beacon")
                continue
            # --- 恢复：与自家静止 Core 同格且掉血 → 治疗 ---
            if (core_normal and home is not None and pos == home
                    and unit.hp < UNIT_MAX_HP[unit_type.value]):
                plan.set(Action(unit.id, "HEAL"), "heal")
                continue

            if unit_type is UnitType.WORKER:
                self._decide_worker(state, plan, unit, home, core_normal,
                                    obstacle, resource_cells,
                                    worker_index[unit.id])
                continue

            if unit_type is UnitType.VANGUARD:
                self._decide_vanguard(state, plan, unit, home, obstacle,
                                      enemies, pos)
                continue

            if unit_type is UnitType.RANGER:
                self._decide_ranger(state, plan, unit, home, obstacle,
                                    enemies, pos)
                continue

        # ---- Core 决策（一个动作槽；省略 = WAIT）----
        if core is None:
            return plan  # RESPAWNING / 初始入场：不提交伪造动作

        cv = core.view
        if cv.hp < 5:
            plan.core_action = Action(core.id, "HEAL")
            plan.intents["core"] = "core_heal"
            return plan
        if cv.shield < 5 and state.resources >= 1 and state.core_normal:
            plan.core_action = Action(core.id, "REPAIR_SHIELD")
            plan.intents["core"] = "repair_shield"
            return plan
        if state.core_normal and state.population < self.config.pop_ceiling:
            cfg = self.config
            # 积累模式：达标 → 停止消费（等兑换；兑换后资源下降自动恢复）
            if (cfg.accumulate_target
                    and state.resources >= cfg.accumulate_target):
                plan.intents["core"] = "accumulated_target"
                return plan
            # 守备：资源值得抢且兵力不足 → 优先造兵（Vanguard/Ranger 交替）
            military = len(state.vanguards) + len(state.rangers)
            if (cfg.accumulate_target
                    and state.resources >= cfg.guard_resources
                    and military < cfg.guard_force):
                unit_type, cost = self._next_guard(state)
            else:
                unit_type, cost = self._next_spawn(state)
            reserve = cfg.spawn_reserve(state.resources)
            if state.resources >= cost + reserve:
                plan.core_action = Action(core.id, "SPAWN", unit_type=unit_type)
                plan.intents["core"] = f"spawn_{unit_type.name.lower()}"
        return plan

    # ---- 单位决策 ----

    def _decide_worker(self, state, plan, unit, home, core_normal,
                       obstacle, resource_cells, index) -> None:
        pos = unit.position
        mem = self.world.unit_states.get(unit.id)
        # --- cargo>0：先交付后采集（cargo 是权威字段，无需记忆）---
        if unit.cargo > 0:
            if home is not None and pos == home:
                if state.resource_space > 0:
                    plan.set(Action(unit.id, "DEPOSIT"), "deposit")
                    # 下一 Tick cargo==0 自然回到 PATROL
                # 容量满：原地等待，下 Tick 再看
            elif home is not None:
                d = step_toward(pos, home, obstacle)
                if d is not None:
                    plan.set(Action(unit.id, "MOVE", direction=d), "return_home")
            return
        # --- cargo==0 ---
        # 站在资源格 → 采集（成功后事件处理清目标）
        if pos in resource_cells:
            plan.set(Action(unit.id, "HARVEST"), "harvest")
            mem.worker_state = WorkerState.PATROL
            mem.harvest_target = None
            return
        # 有可见资源 → 设目标前往
        if resource_cells:
            target = nearest(resource_cells, pos)
            mem.worker_state = WorkerState.GO_HARVEST
            mem.harvest_target = target
            if target != pos:
                d = step_toward(pos, target, obstacle)
                if d is not None:
                    plan.set(Action(unit.id, "MOVE", direction=d), "go_harvest")
            return
        # 无可见资源：记忆目标仍在线索中 → 继续前往（跨 Tick 意图）
        if (mem.worker_state is WorkerState.GO_HARVEST
                and mem.harvest_target is not None
                and mem.harvest_target in set(self.world.resource_hints())):
            d = step_toward(pos, mem.harvest_target, obstacle)
            if d is not None:
                plan.set(Action(unit.id, "MOVE", direction=d), "go_harvest_mem")
            return
        # 目标失效（被采/被抢/刷新移走）→ 回 PATROL，进入巡逻
        mem.worker_state = WorkerState.PATROL
        mem.harvest_target = None
        # 空手：朝最近可见资源格走；无可见资源则在家半径内巡逻
        if resource_cells:
            target = nearest(resource_cells, pos)
        elif home is not None:
            if manhattan(pos, home) > self.config.explore_radius:
                target = home  # 超距回头，不走丢
            else:
                beacon_pos = (state.beacon.position
                              if state.beacon is not None else home)
                target = explore_target(pos, home, beacon_pos,
                                        index, self.config.explore_radius)
        else:
            beacon_pos = (state.beacon.position
                          if state.beacon is not None else (0, 0))
            target = beacon_pos  # 无 Core：朝 Beacon 方向探索
        if target != pos:
            d = step_toward(pos, target, obstacle)
            if d is not None:
                plan.set(Action(unit.id, "MOVE", direction=d), "patrol")

    def _decide_vanguard(self, state, plan, unit, home, obstacle, enemies,
                         pos) -> None:
        # 战斗：相邻敌人 → sweep（多敌人取 UUID 最小）
        adjacent = [e for e in enemies if manhattan(pos, e.position) == 1]
        if adjacent:
            e = adjacent[0]
            d = (self._direction_to(e.position, pos))
            plan.set(Action(unit.id, "SWEEP", direction=d), "sweep")
            return
        # 视野内有敌人 → 逼近；离 Core 近时守家优先
        nearby = [e for e in enemies if manhattan(pos, e.position) <= 4]
        if nearby and home is not None and manhattan(pos, home) <= 4:
            return  # 守家不动
        if nearby:
            target = min(nearby, key=lambda e: (manhattan(pos, e.position), e.id)).position
        else:
            target = home
        if target is not None and target != pos:
            d = step_toward(pos, target, obstacle)
            if d is not None:
                plan.set(Action(unit.id, "MOVE", direction=d), "vanguard_move")

    def _decide_ranger(self, state, plan, unit, home, obstacle, enemies,
                       pos) -> None:
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
            if line_blocked(pos, e.position, obstacle):
                continue
            best = e
            break  # enemies 已按 UUID 排序，取第一个合法目标
        if best is not None:
            plan.set(Action(unit.id, "SHOOT", target_id=best.id,
                            expected_cell=best.position), "shoot")
            return
        # 朝最近敌人移动保持压力；无敌人守家
        if enemies:
            target = min(enemies, key=lambda e: (manhattan(pos, e.position), e.id)).position
        else:
            target = home
        if target is not None and target != pos:
            d = step_toward(pos, target, obstacle)
            if d is not None:
                plan.set(Action(unit.id, "MOVE", direction=d), "ranger_move")

    # ---- 生产 ----

    def _next_spawn(self, state):
        """Worker 未达标产 Worker；之后 Vanguard/Ranger 交替。"""
        workers = len(state.workers)
        vanguards = len(state.vanguards)
        rangers = len(state.rangers)
        if workers < self.config.worker_target:
            return UnitType.WORKER, 5
        if vanguards <= rangers:
            return UnitType.VANGUARD, 10
        return UnitType.RANGER, 12

    @staticmethod
    def _next_guard(state):
        """守备补兵：Vanguard/Ranger 交替（Vanguard 优先近战守家）。"""
        vanguards = len(state.vanguards)
        rangers = len(state.rangers)
        if vanguards <= rangers:
            return UnitType.VANGUARD, 10
        return UnitType.RANGER, 12

    @staticmethod
    def _direction_to(target, pos):
        if target[1] > pos[1]:
            return Direction.DOWN
        if target[1] < pos[1]:
            return Direction.UP
        return Direction.RIGHT if target[0] > pos[0] else Direction.LEFT
