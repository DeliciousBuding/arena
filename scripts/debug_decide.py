"""只读调试：连真实 Turn → 跑 decide → 打印 Plan 内容（不提交）。

    uv run python scripts/debug_decide.py --tenant 1
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from arena_bot.config import TacticConfig, load_tenant_keys
from arena_bot.core.state import TickState
from arena_bot.strategies import create_strategy
from arena_bot.world import World
from arena_hero import ArenaHeroClient


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tenant", type=int, required=True)
    args = parser.parse_args()

    keys = load_tenant_keys()
    if args.tenant >= len(keys):
        print(f"无租户 {args.tenant}，key 数 {len(keys)}")
        return 1
    api_key = keys[args.tenant]
    cfg = TacticConfig()
    world = World()
    strategy = create_strategy("balance", cfg, world)

    with ArenaHeroClient(api_key=api_key) as game:
        for turn in game.turns():
            st = TickState.from_turn(turn)
            print(f"=== tick {st.tick} ===")
            core = st.core
            print(f"core@{core.position if core else None} "
                  f"res={st.resources}/{st.resource_capacity} "
                  f"space={st.resource_space} pop={st.population}")
            for u in st.units:
                print(f"  unit {u.unit_type.value}@{u.position} hp={u.hp} "
                      f"cargo={getattr(u, 'cargo', None)} id={u.id}")
            print(f"resource_cells={sorted(st.resource_cells)}")
            print(f"obstacle_cells({len(st.obstacle_cells)})={sorted(st.obstacle_cells)[:10]}")
            print(f"beacon pos={st.beacon.position if st.beacon else None} "
                  f"status={st.beacon.status if st.beacon else None}")
            print(f"enemies={[(e.kind, e.position) for e in st.visible_enemies]}")

            plan = strategy.decide(st)
            print(f"--- Plan actions: {len(plan.actions)} ---")
            for uid, a in plan.actions.items():
                print(f"  {a.kind} dir={a.direction} target={a.expected_cell} "
                      f"intent={plan.intents.get(uid)}")
            print(f"--- core_action: {plan.core_action} "
                  f"intent={plan.intents.get('core')} ---")
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
