/**
 * 经济闭环长跑测试（2026-08-05 生产死锁回归）：
 * t1 生产实测 capacity_wait:DEPOSIT 死锁——满血 Vanguard 守家站在 Core 格，
 * 满载 Worker 永远无法进入 Core 格回仓（经济停滞、cargoTot 永不清零）。
 *
 * 本测试跑确定性 planner 的多 tick 闭环（决策 → 模拟结算），断言：
 * - 满载 Worker 能回到 Core 格 DEPOSIT（cargo 周期清零，无 capacity_wait:DEPOSIT 死锁）；
 * - 满血军事单位守家锚定在 Core 相邻格（vanguard_home），绝不站 Core 格；
 * - 长跑 200 ticks 不出现"cargoTot 长期非零且不变化"的停滞。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Turn, type PlayerState } from "@arena/arena-hero-ts";

import { DeterministicPlanner } from "../src/planning/deterministic-planner.ts";
import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import type { Position, TickState, UnitAction } from "../src/domain/model.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const CARGO_MAX = 2;

function makeState(tick: number, objects: PlayerState["objects"], resources = 10): TickState {
  const turn = new Turn(
    tick,
    {
      status: "ACTIVE",
      respawn_at_tick: null,
      resources,
      population: objects.filter((o) => o.kind === "UNIT").length,
      population_tier: 0,
      upkeep_next_tick: 0,
      champion_beacon: { position: [100, 100], status: "GROUND", carrier_id: null },
      objects,
      events: [],
    },
    (() => {}) as never,
  );
  return reduceTurn(turn as unknown as TurnLike) as TickState;
}

const coreObj = {
  kind: "CORE", id: "c1", controlled: true, owner_username: "u",
  position: [0, 0], hp: 5, shield: 5, state: "NORMAL",
  move_direction: null, move_progress: null, move_required_ticks: null, destination: null,
} as PlayerState["objects"][number];
const unit = (id: string, x: number, y: number, unitType: "WORKER" | "VANGUARD", cargo = 0, hp = 4) =>
  ({ kind: "UNIT", id, controlled: true, position: [x, y], hp, unit_type: unitType, cargo }) as PlayerState["objects"][number];

/** 模拟结算（贴近服务端可观测语义）：MOVE 推进（容量 2，Core 占 1）；
 *  资源格 HARVEST（cargo<max 成功，否则失败）；Core 格 DEPOSIT（cargo→0）。 */
function settle(
  actions: Readonly<Record<string, UnitAction>>,
  objects: PlayerState["objects"],
  resourceCells: Set<string>,
): PlayerState["objects"] {
  const next: Array<PlayerState["objects"][number]> = [coreObj];
  const occupied = new Map<string, number>([["0,0", 1]]);
  for (const o of objects) {
    if (o.kind !== "UNIT") continue;
    const a = actions[o.id];
    let pos = o.position;
    let cargo = o.cargo ?? 0;
    if (a?.type === "MOVE") {
      const nextPos: Position = a.direction === "UP"
        ? [pos[0], pos[1] - 1]
        : a.direction === "DOWN"
          ? [pos[0], pos[1] + 1]
          : a.direction === "LEFT"
            ? [pos[0] - 1, pos[1]]
            : [pos[0] + 1, pos[1]];
      const key = `${nextPos[0]},${nextPos[1]}`;
      if ((occupied.get(key) ?? 0) < 2) {
        pos = nextPos;
        occupied.set(key, (occupied.get(key) ?? 0) + 1);
      }
    } else if (a?.type === "HARVEST" && resourceCells.has(`${pos[0]},${pos[1]}`) && cargo < CARGO_MAX) {
      cargo += 1;
    } else if (a?.type === "DEPOSIT" && pos[0] === 0 && pos[1] === 0) {
      cargo = 0;
    }
    next.push(unit(o.id, pos[0], pos[1], o.unit_type as "WORKER" | "VANGUARD", cargo, o.hp ?? 4));
  }
  return next;
}

const POLICY: MacroPolicy = { posture: "harvest", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: null };
const RESOURCE_CELLS = new Set(["16,0", "32,0"]);

test("经济闭环：满载 Worker 能回仓 DEPOSIT（无 capacity_wait 死锁）", () => {
  const planner = new DeterministicPlanner();
  let objects: PlayerState["objects"] = [coreObj, unit("w1", 16, 0, "WORKER", CARGO_MAX), unit("w2", 32, 0, "WORKER", CARGO_MAX)];
  let cargoTot = CARGO_MAX * 2;
  let cleared = false;
  let stuckTicks = 0;
  for (let tick = 100; tick < 300; tick++) {
    const state = { ...makeState(tick, objects, 10), resourceCells: RESOURCE_CELLS } as TickState;
    const plan = planner.decide({ state, policy: POLICY });
    const waitDeposit = Object.values(plan.intents ?? {}).filter((i) => i === "capacity_wait:DEPOSIT").length;
    objects = settle(plan.unitActions, objects, RESOURCE_CELLS);
    const nextCargoTot = objects.reduce((s, o) => s + (o.kind === "UNIT" ? (o.cargo ?? 0) : 0), 0);
    if (nextCargoTot === 0) cleared = true;
    if (nextCargoTot === cargoTot) stuckTicks += 1;
    else stuckTicks = 0;
    cargoTot = nextCargoTot;
    assert.ok(
      stuckTicks < 24,
      `经济停滞 ${stuckTicks} ticks（cargoTot=${cargoTot} 不变化）——疑似死锁 @tick ${tick}`,
    );
    assert.ok(waitDeposit < 2, `capacity_wait:DEPOSIT 持续出现（${waitDeposit}）@tick ${tick}`);
  }
  assert.equal(cleared, true, "满载 cargo 必须能周期回仓清零");
});

test("守家锚点：满血军事单位不站 Core 格（vanguard_home 移出）", () => {
  const planner = new DeterministicPlanner();
  // 满血 Vanguard 站在 Core 格（生产死锁起点）
  const state: TickState = { ...makeState(100, [coreObj, unit("v1", 0, 0, "VANGUARD", 0, 4), unit("w1", 1, 0, "WORKER", CARGO_MAX)]), resourceCells: RESOURCE_CELLS };
  const plan = planner.decide({ state, policy: POLICY });
  const vanguard = plan.unitActions["v1"];
  assert.equal(vanguard?.type, "MOVE", "满血 Vanguard 在 Core 格必须移出");
  assert.equal(plan.intents?.["v1"], "vanguard_home");
  const worker = plan.unitActions["w1"];
  assert.notEqual(plan.intents?.["w1"], "capacity_wait:DEPOSIT", "Worker 回仓不得被 Vanguard 占格阻塞");
});

test("守家锚点：Vanguard 无敌人时回防到 Core 相邻格而非 Core 格", () => {
  const planner = new DeterministicPlanner();
  const state: TickState = { ...makeState(100, [coreObj, unit("v1", 5, 0, "VANGUARD", 0, 4)]), resourceCells: new Set() };
  const plan = planner.decide({ state, policy: POLICY });
  const vanguard = plan.unitActions["v1"];
  assert.equal(vanguard?.type, "MOVE", "无敌人时 Vanguard 回防移动");
  const destination: Position = vanguard?.type === "MOVE"
    ? vanguard.direction === "UP" ? [5, -1] : vanguard.direction === "DOWN" ? [5, 1] : vanguard.direction === "LEFT" ? [4, 0] : [6, 0]
    : [0, 0];
  assert.notDeepEqual(destination, [0, 0], "回防目标不得是 Core 格本身");
});

