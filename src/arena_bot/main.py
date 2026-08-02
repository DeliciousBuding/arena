"""主入口：连接游戏、驱动决策链路、调试端点、遥测采样、优雅退出。

运行：
    uv run python -m arena_bot.main                # 单账号模式（旧兼容）
    uv run python -m arena_bot.tenant --tenant 0   # 多租户模式（每租户一进程）

每个 Turn 的链路：
    Turn → TickState → 事件处理(world) → World.observe → PhaseMachine.update
        → Strategy.decide → Plan → apply_plan → submit → 遥测采样 → 日志
"""

from __future__ import annotations

import sys

from arena_hero import ArenaHeroClient, UnitType

from .config import (MAP_STORE_PATH, PROJECT_ROOT, TacticConfig, TenantConfig,
                     load_api_key)
from .core.state import TickState
from .debug_api import DebugServer
from .logging_util import get_logger, set_current_tick, setup_logging
from .map_store import MapStore
from .phase_machine import GamePhase, PhaseMachine
from .strategies import create_strategy
from .strategy import apply_plan
from .telemetry import Telemetry
from .watchdog import Watchdog
from .world import World

log = get_logger("main")


def build_command_handler(cfg: TacticConfig, phase: PhaseMachine,
                          strategy, world: World,
                          state_holder: dict) -> callable:
    """debug API 命令处理器（白名单校验在 debug_api 层完成）。"""

    def handle(cmd: str, args: dict) -> tuple[bool, str]:
        nonlocal cfg
        if cmd == "pause":
            state_holder["paused"] = True
            log.warning("调试指令：暂停提交（观察模式）")
            return True, "paused"
        if cmd == "resume":
            state_holder["paused"] = False
            log.warning("调试指令：恢复提交")
            return True, "resumed"
        if cmd == "set_param":
            name, value = args.get("name"), args.get("value")
            try:
                cfg = cfg.with_param(name, value)
            except (KeyError, TypeError, ValueError) as exc:
                return False, str(exc)
            strategy.config = cfg
            log.warning("调试指令：参数 %s → %s", name, value)
            return True, f"param {name}={value}"
        if cmd == "set_phase":
            try:
                new_phase = GamePhase(args.get("phase", ""))
            except ValueError:
                return False, "phase 必须是 early_expansion/balanced/military"
            phase.force(new_phase)
            log.warning("调试指令：强制阶段 → %s", new_phase.value)
            return True, f"phase={new_phase.value}"
        return False, f"未知指令: {cmd}"

    return handle


def build_snapshot(cfg: TacticConfig, phase: PhaseMachine, world: World,
                   state_holder: dict, watchdog: Watchdog | None = None) -> callable:
    """debug API 快照：运行态全状态（状态/记忆/阶段/参数/暂停标志）。"""

    def snapshot() -> dict:
        st = state_holder.get("state")
        units = []
        if st is not None:
            for u in sorted(st.units, key=lambda x: x.id):
                units.append({
                    "id": str(u.id),
                    "type": u.unit_type.value,
                    "pos": list(u.position),
                    "hp": u.hp,
                    "cargo": u.cargo if u.unit_type is UnitType.WORKER else None,
                    "intent": state_holder.get("intents", {}).get(str(u.id)),
                    "worker_state": world.unit_states.get(u.id).worker_state.value,
                })
        body = {
            "tick": world.tick,
            "paused": state_holder.get("paused", False),
            "resources": st.resources if st else None,
            "population": st.population if st else None,
            "phase": phase.phase.value,
            "enemies_visible": world.current_enemy_count,
            "units": units,
            "world_memory": {
                "obstacles_known": len(world.obstacle_memory),
                "resources_known": len(world.resource_memory),
                "enemies_known": len(world.enemy_memory),
            },
            "strategies": {
                "phase": phase.phase.value,
                "explore_radius": cfg.explore_radius,
                "worker_target": cfg.worker_target,
                "pop_ceiling": cfg.pop_ceiling,
            },
            "map": (world.map_store.stats()
                    if world.map_store is not None else None),
        }
        if watchdog is not None:
            body["alarms"] = [
                {"type": a.alarm_type, "tick": a.tick, "message": a.message}
                for a in watchdog.open_alarms()
            ]
        return body

    return snapshot


def play(api_key: str, config: TacticConfig,
         tenant: "TenantConfig | None" = None) -> None:
    """主循环。tenant=None 为单账号兼容模式（logs/ + 8123）。"""
    if tenant is not None:
        setup_logging(log_dir=tenant.log_dir)
    else:
        setup_logging()
    log.info("arena-bot 启动（SDK 0.2.6 / 规则 v0.10）租户=%s", tenant.name if tenant else "solo")

    map_store = MapStore(MAP_STORE_PATH)  # 共享地图：4 账号协同测绘
    log.info("共享地图加载：%s（%d 障碍格 / %d chunk）",
             map_store.path, *map_store.stats().values())

    world = World(map_store)
    phase = PhaseMachine(config)
    strategy = create_strategy(tenant.strategy_name if tenant else "balance",
                               config, world)
    state_holder: dict = {"paused": False}

    watchdog = Watchdog(
        alert_path=(PROJECT_ROOT / "alerts" / f"{tenant.name}.jsonl")
        if tenant is not None else None,
        stall_ticks=config.watchdog_stall_ticks,
    )

    host = config.debug_host
    port = tenant.debug_port if tenant is not None else config.debug_port
    debug = DebugServer(
        host, port,
        build_snapshot(config, phase, world, state_holder, watchdog),
        build_command_handler(config, phase, strategy, world, state_holder),
    )
    debug.start()
    log.info("调试端点 http://%s:%s（GET /state /strategies，POST /command）", host, port)

    telemetry = Telemetry(tenant.telemetry_path) if tenant is not None else None

    with ArenaHeroClient(api_key=api_key) as game:
        for turn in game.turns():
            set_current_tick(turn.tick)
            state = TickState.from_turn(turn)
            state_holder["state"] = state

            # 事件 → world（采集成功/失败、单位状态）
            harvest_failed = {ev.position for ev in state.events
                              if ev.event_type == "HARVEST_FAILED" and ev.position}
            world.observe(state.tick, state.obstacle_cells, state.resource_cells,
                          state.visible_enemies, harvest_failed,
                          observer=tenant.name if tenant else "solo")
            # 结盟：注册自己的 Core username（其他租户看到后不攻击）
            if state.core_view is not None and map_store.register_ally(
                    state.core_view.owner_username,
                    tenant.name if tenant else "solo", state.tick):
                log.info("盟友注册：@%s（%s）",
                         state.core_view.owner_username,
                         tenant.name if tenant else "solo")
            for ev in state.events:
                if ev.event_type == "HARVEST_SUCCEEDED" and ev.position:
                    world.mark_harvested(ev.position, state.tick)

            # 阶段机：威胁 = 距 Core ≤ 阈值的可见敌人数
            enemy_near = 0
            if state.core is not None:
                enemy_near = sum(
                    1 for e in state.visible_enemies
                    if abs(e.position[0] - state.core.position[0])
                    + abs(e.position[1] - state.core.position[1])
                    <= config.threat_enemy_dist)
            phase.update(state.population, state.resources, enemy_near)

            if state_holder["paused"]:
                log.info("tick %d 暂停中（不提交）", state.tick)
                continue

            plan = strategy.decide(state)
            # intents 存 str key（snapshot 按 str(u.id) 查询）
            state_holder["intents"] = {str(k): v for k, v in plan.intents.items()}
            empty_plan = not plan.actions and plan.core_action is None
            # watchdog：观察停滞（空计划/单位卡死/经济停滞）
            watchdog.observe(
                tick=state.tick, empty_plan=empty_plan,
                units=[{"id": str(u.id), "pos": tuple(u.position),
                        "intent": plan.intents.get(u.id)}
                       for u in state.units],
                resources=state.resources, resource_capacity=state.resource_capacity)
            if empty_plan:
                # 全单位无动作（等效 WAIT）：跳过提交，避免 UI 显示"空计划"
                log.debug("tick %d 无任何动作，跳过提交", state.tick)
                continue
            apply_plan(turn, plan)
            accepted = state.submit()

            if telemetry is not None:
                telemetry.record(
                    tick=state.tick, phase=phase.phase.value,
                    resources=state.resources,
                    resource_capacity=state.resource_capacity,
                    population=state.population,
                    workers=len(state.workers), vanguards=len(state.vanguards),
                    rangers=len(state.rangers),
                    core_hp=state.core_view.hp if state.core_view else None,
                    core_shield=state.core_view.shield if state.core_view else None,
                    enemies_visible=len(state.visible_enemies),
                    events=state.events, intents=dict(plan.intents))

            log.info(
                "tick %d accepted=%s phase=%s res=%d/%d pop=%d w=%d vg=%d rg=%d enemies=%d",
                state.tick, accepted.accepted, phase.phase.value,
                state.resources, state.resource_capacity, state.population,
                len(state.workers), len(state.vanguards), len(state.rangers),
                len(state.visible_enemies))

    if telemetry is not None:
        telemetry.close()
    map_store.close()


def main() -> None:
    api_key = load_api_key()
    if not api_key:
        print("错误：未找到 API key（.env 的 ARENA_HERO_API_KEY 或环境变量）",
              file=sys.stderr)
        sys.exit(1)
    try:
        play(api_key, TacticConfig())
    except KeyboardInterrupt:
        log.info("Ctrl-C 退出")


if __name__ == "__main__":
    main()
