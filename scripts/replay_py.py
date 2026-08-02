"""Python reference runner：消费 fixture manifest，输出 Differential Record v1 JSONL。

W3 差分（Python 侧）：与 TS 侧（packages/arena-agent/scripts/replay-ts.ts）共用同一
fixture manifest（scripts/differential/fixture_builder.py 产出），逐 Tick 走真实决策链：

    fixture {tick}.json → PlayerState → Turn → TickState → world.observe
    → phase.update → BalanceStrategy.decide → canonical record

契约：docs/differential-record-v1.md（v1.0.1）+ contracts/differential/record-v1.schema.json。

用法：
    uv run python scripts/replay_py.py --manifest fixtures/differential/burnin-20260802-a/manifest.json \
        --fixture-dir fixtures/differential/burnin-20260802-a --out /tmp/replay-py.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from arena_hero import PlayerState, Turn  # noqa: E402
from arena_bot.config import TacticConfig  # noqa: E402
from arena_bot.core.state import TickState  # noqa: E402
from arena_bot.phase_machine import PhaseMachine  # noqa: E402
from arena_bot.strategies.balance import BalanceStrategy  # noqa: E402
from arena_bot.world import World  # noqa: E402

# decision_config 中立字段 → TacticConfig 字段（config 单源：值全部来自 manifest）
CONFIG_MAP = {
    "worker_target": "worker_target",
    "population_ceiling": "pop_ceiling",
    "explore_radius": "explore_radius",
    "guard_resources": "guard_resources",
    "guard_force": "guard_force",
}


def build_config(decision_config: dict) -> TacticConfig:
    kwargs: dict = {}
    for neutral, local in CONFIG_MAP.items():
        if neutral in decision_config:
            kwargs[local] = decision_config[neutral]
    return TacticConfig(**kwargs)


def pos2list(p) -> list[int]:
    return [int(p[0]), int(p[1])]


def canonical_state(state: TickState) -> dict:
    """TickState → canonical state（record-v1.schema.json 的 state 部分）。"""
    core_view = state.core_view
    units = [
        {
            "id": str(u.id),
            "position": pos2list(u.position),
            "hp": int(u.hp),
            "cargo": int(u.cargo),
            "unit_type": str(u.unit_type),
        }
        for u in [*state.workers, *state.vanguards, *state.rangers]
    ]
    units.sort(key=lambda u: u["id"])
    enemies = []
    for e in state.visible_enemies:
        kind = getattr(e, "kind", None)
        unit_type = str(getattr(e, "unit_type", kind or "CORE"))
        enemies.append({"id": str(e.id), "position": pos2list(e.position), "unit_type": unit_type})
    enemies.sort(key=lambda e: e["id"])
    beacon = state.beacon
    return {
        "resources": int(state.resources),
        "population": int(state.population),
        "resource_capacity": int(state.resource_capacity),
        "resource_space": int(state.resource_space),
        "core": (
            None
            if core_view is None
            else {
                "id": str(core_view.id),
                "position": pos2list(core_view.position),
                "hp": int(core_view.hp),
                "shield": int(core_view.shield),
                "state": str(core_view.state),
            }
        ),
        "units": units,
        "enemies": enemies,
        "resource_cells": sorted([pos2list(c) for c in state.resource_cells]),
        "obstacle_cells": sorted([pos2list(c) for c in state.obstacle_cells]),
        "beacon": (
            None
            if beacon is None
            else {
                "position": pos2list(beacon.position),
                "status": str(beacon.status) if beacon.status is not None else None,
                "carrier_id": str(beacon.carrier_id) if beacon.carrier_id is not None else None,
            }
        ),
    }


def canonical_memory(world: World) -> dict:
    """World 记忆投影（record-v1 的 memory 部分）。"""
    resources = {
        f"{rm.cell[0]},{rm.cell[1]}": {
            "state": rm.state.value,
            "first_seen_tick": int(rm.first_seen_tick),
        }
        for rm in world.resource_memory.values()
    }
    enemies = {
        str(em.id): {"last_seen_tick": int(em.last_seen_tick), "position": pos2list(em.position)}
        for em in world.enemy_memory.values()
    }
    units = {str(k): {"mode": str(v)} for k, v in world.unit_states.snapshot().items()}
    return {"resources": resources, "enemies": enemies, "units": units}


def action_to_wire(action) -> dict | None:
    """Action → wire 字段（type/direction/target_id/expected_cell/unit_type）。"""
    if action is None:
        return None
    wire: dict = {"type": str(action.kind)}
    if action.direction is not None:
        wire["direction"] = str(action.direction)
    if action.target_id is not None:
        wire["target_id"] = str(action.target_id)
    if action.expected_cell is not None:
        wire["expected_cell"] = list(action.expected_cell)
    if action.unit_type is not None:
        wire["unit_type"] = str(action.unit_type)
    return wire


def canonical_plan(plan) -> dict:
    return {
        "unit_actions": {str(k): action_to_wire(a) for k, a in sorted(plan.actions.items())},
        "core_action": action_to_wire(plan.core_action),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True, help="fixture manifest.json（2A 产出）")
    ap.add_argument("--fixture-dir", required=True, help="fixture 目录（脱敏 {tick}.json）")
    ap.add_argument("--out", required=True, help="输出 JSONL 路径")
    args = ap.parse_args()

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    fixture_dir = Path(args.fixture_dir)
    config = build_config(manifest["decision_config"])
    seg_id = manifest.get("tenant_id", "unknown")

    lines: list[str] = []
    for segment in manifest["segments"]:
        # 每 segment 重建决策链（跨 gap 不延续记忆，契约 v1.0.1）
        world = World()  # map_store=None：Tenant-local parity，不依赖共享地图
        phase = PhaseMachine(config)
        strategy = BalanceStrategy(config, world)
        for tick in segment["ticks"]:
            raw = json.loads((fixture_dir / f"{tick}.json").read_text(encoding="utf-8"))
            state_model = PlayerState.model_validate(raw)
            # shadow：只回放不提交（submitter 为占位）
            turn = Turn(tick=int(tick), state=state_model, submitter=lambda plan, **kw: None)
            state = TickState.from_turn(turn)

            harvest_failed = {
                ev.position
                for ev in state.events
                if getattr(ev, "event_type", None) == "HARVEST_FAILED" and ev.position
            }
            world.observe(
                state.tick, state.obstacle_cells, state.resource_cells,
                state.visible_enemies, harvest_failed, observer="replay",
            )
            enemy_near = 0
            if state.core is not None:
                cx, cy = state.core.position
                enemy_near = sum(
                    1 for e in state.visible_enemies
                    if abs(e.position[0] - cx) + abs(e.position[1] - cy) <= config.threat_enemy_dist
                )
            phase.update(state.population, state.resources, enemy_near)
            plan = strategy.decide(state)

            record = {
                "protocol_version": 1,
                "dataset_id": manifest["dataset_id"],
                "tenant_id": seg_id,
                "segment_id": segment["segment_id"],
                "tick": int(tick),
                "input_sha256": manifest["inputs"][str(tick)]["sha256"],
                "config_hash": manifest["config_hash"],
                "map_snapshot_hash": None,
                "state": canonical_state(state),
                "phase": phase.phase.value,
                "memory": canonical_memory(world),
                "intents": {str(k): str(v) for k, v in plan.intents.items()},
                "plan": canonical_plan(plan),
                "map_mode": manifest["map_mode"],
            }
            lines.append(json.dumps(record, ensure_ascii=False))

    Path(args.out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"replay_py: {len(lines)} records → {args.out}")


if __name__ == "__main__":
    main()
