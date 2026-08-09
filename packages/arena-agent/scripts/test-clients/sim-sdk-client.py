"""Sim-server 集成测试客户端（官方 SDK 零改动，可复用）。

来源：P2c/P2a 验证（2026-08-09）产出，原 p2c-client.py，入库为
arena-ts 的集成测试客户端。直接使用官方 fork SDK（arena_hero），
不改动 SDK 代码即可验证 sim-server 的 tick 流、私有观察、命令回执与
连接拒绝（PolicyViolation）行为。

3 客户端混战模式（默认）：
    python sim-sdk-client.py --api-key sim-client-1 --out out-1.json [--ticks 60]
每个客户端：连接 → 每 tick 记录私有观察（resources/population/own core/own
units/visible enemies/terrain）→ 提交工人 MOVE RIGHT + core WAIT → 记录回执。
连接被拒模式（--expect-reject）：预期收到 close 1008 → PolicyViolationError。

前置：本地 sim-server 运行在 http://127.0.0.1:8899，且安装了官方
arena_hero SDK（pip install -e <arena-hero-python 源码树>）。
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from arena_hero import ArenaHeroClient
from arena_hero.enums import Direction
from arena_hero.errors import PolicyViolationError
from arena_hero.turn import Core, Worker


def observe(turn) -> dict:
    state = turn.state
    return {
        "tick": turn.tick,
        "resources": state.resources,
        "population": state.population,
        "own_core": {
            "id": str(turn.core.id),
            "position": list(turn.core.position),
            "hp": turn.core.hp,
            "shield": turn.core.shield,
            "owner_username": turn.core.owner_username,
        }
        if isinstance(turn.core, Core)
        else None,
        "own_units": [
            {
                "id": str(unit.id),
                "position": list(unit.position),
                "hp": unit.hp,
                "type": str(unit.unit_type),
                "cargo": unit.cargo if isinstance(unit, Worker) else None,
            }
            for unit in turn.units
        ],
        "visible_enemies": [
            {"kind": type(ent).__name__, "id": str(ent.id), "position": list(ent.position)}
            for ent in turn.visible_enemies
        ],
        "terrain_batches": len(turn.terrain),
        "resource_cells": len(turn.resource_cells),
        "obstacle_cells": len(turn.obstacle_cells),
        "beacon": {
            "position": list(turn.beacon.position),
            "status": turn.beacon.status,
        },
        "private_events": len(turn.events),
    }


def run_player(api_key: str, out_path: str, ticks: int) -> int:
    ticks_seen: list[int] = []
    records: list[dict] = []
    receipts = 0
    error: str | None = None
    started = time.time()
    try:
        with ArenaHeroClient(
            api_key=api_key,
            base_url="http://127.0.0.1:8899",
            request_timeout=5.0,
            request_retries=1,
        ) as client:
            for turn in client.turns():
                record = observe(turn)
                record["wall_ms"] = round((time.time() - started) * 1000)
                ticks_seen.append(turn.tick)
                if turn.workers:
                    turn.workers[0].move(Direction.RIGHT)
                if isinstance(turn.core, Core):
                    turn.core.wait()
                accepted = turn.submit()
                record["accepted"] = {
                    "tick": accepted.tick,
                    "source": accepted.source,
                    "received_at": accepted.received_at.isoformat()
                    if hasattr(accepted.received_at, "isoformat")
                    else str(accepted.received_at),
                }
                receipt = client.latest_receipts.get(accepted.source)
                if receipt is not None:
                    receipts += 1
                    record["receipt"] = {
                        "tick": receipt.tick,
                        "plan_units": len(receipt.plan.unit_actions),
                        "core_action": receipt.plan.core_action.type
                        if receipt.plan.core_action
                        else None,
                    }
                records.append(record)
                if turn.tick >= ticks:
                    break
    except Exception as exc:  # noqa: BLE001 - 记录任何异常形态（含 401 拒绝）
        error = f"{type(exc).__name__}: {exc}"
        print(f"[{api_key}] ERROR: {error}", flush=True)
    summary = {
        "api_key": api_key,
        "ticks_seen": ticks_seen,
        "first_tick": ticks_seen[0] if ticks_seen else None,
        "last_tick": ticks_seen[-1] if ticks_seen else None,
        "tick_count": len(ticks_seen),
        "receipts": receipts,
        "records": records,
        "rejected": False,
        "error": error,
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2, ensure_ascii=False)
    print(
        f"[{api_key}] ticks={len(ticks_seen)} first={ticks_seen[0] if ticks_seen else '-'} "
        f"last={ticks_seen[-1] if ticks_seen else '-'} receipts={receipts} error={error}",
        flush=True,
    )
    return 0 if ticks_seen and error is None else 1


def run_reject(api_key: str, out_path: str) -> int:
    result: dict = {"api_key": api_key, "rejected": False, "error": None}
    started = time.time()
    try:
        with ArenaHeroClient(
            api_key=api_key,
            base_url="http://127.0.0.1:8899",
            request_timeout=5.0,
            request_retries=0,
            reconnect_min_delay=10.0,
        ) as client:
            for _ in client.turns():
                result["error"] = "unexpected turn received (slot not rejected)"
                break
    except PolicyViolationError as exc:
        result["rejected"] = True
        result["error"] = f"PolicyViolationError: {exc}"
    except Exception as exc:  # noqa: BLE001 - 记录任何意外异常形态
        result["error"] = f"{type(exc).__name__}: {exc}"
    result["wall_ms"] = round((time.time() - started) * 1000)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2, ensure_ascii=False)
    print(f"[{api_key}] reject={result['rejected']} error={result['error']}", flush=True)
    return 0 if result["rejected"] else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-key", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--ticks", type=int, default=60)
    parser.add_argument("--expect-reject", action="store_true")
    args = parser.parse_args()
    if args.expect_reject:
        return run_reject(args.api_key, args.out)
    return run_player(args.api_key, args.out, args.ticks)


if __name__ == "__main__":
    sys.exit(main())
