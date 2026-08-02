"""只读诊断：连接游戏查看当前状态，不提交任何计划（不占用 AGENT 槽）。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tactic import load_api_key
from arena_hero import ArenaHeroClient, UnitType


def main() -> None:
    api_key = load_api_key()
    with ArenaHeroClient(api_key=api_key) as game:
        for turn in game.turns():
            core = turn.core
            print(f"=== tick {turn.tick} ===")
            print(f"resources={turn.resources}/{turn.resource_capacity} space={turn.resource_space}")
            if core is not None:
                cv = core.view
                print(f"core@{core.position} hp={cv.hp} shield={cv.shield} state={cv.state}")
            for u in sorted(turn.units, key=lambda x: x.id):
                extra = f" cargo={u.cargo}" if u.unit_type is UnitType.WORKER else ""
                print(f"  unit {u.unit_type.name}@{u.position} hp={u.hp}{extra}")
            print(f"visible_enemies={[(e.kind, e.position) for e in turn.visible_enemies]}")
            print(f"resource_cells={sorted(turn.resource_cells)}")
            print(f"obstacles={len(turn.obstacle_cells)} beacon={turn.beacon}")
            for ev in turn.events:
                print(f"  event: {ev.event_type} reason={ev.reason_code} pos={ev.position} amount={ev.resource_amount}")
            break  # 只读一个 Tick


if __name__ == "__main__":
    main()
