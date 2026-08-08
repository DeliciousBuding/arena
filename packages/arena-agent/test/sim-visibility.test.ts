/**
 * S6 visibility 与 observation adapter 测试：
 * supercover 向量、遮挡、corner-touch、半径、union、stale 消失、
 * reduceTurn 兼容（Planner 可消费）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { reduceTurn } from "../src/domain/state-reducer.ts";
import { cellKey, type Position } from "../src/domain/model.ts";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";
import { projectPlayerState, simTurnLike, supercoverLine, visibleCellSet } from "../src/sim/visibility/visibility.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";
import type { SimWorld } from "../src/sim/world/types.ts";

const uuid = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const here = dirname(fileURLToPath(import.meta.url));
const rules = loadRulesManifest(join(here, "..", "src", "sim", "contracts", "rules-v0.11.json"));

interface UnitSpec {
  readonly id: string;
  readonly position: Position;
  readonly hp?: number;
  readonly unitType?: "WORKER" | "VANGUARD" | "RANGER";
  readonly cargo?: number;
}

function makeWorld(opts: {
  player?: "p1" | "p2";
  units?: readonly UnitSpec[];
  enemyUnits?: readonly UnitSpec[];
  obstacles?: readonly Position[];
  resources?: readonly Position[];
  piles?: readonly { readonly cell: Position; readonly amount: number }[];
}): SimWorld {
  const units = (opts.units ?? []).map((u, i) => ({
    id: u.id ?? uuid(i + 1),
    owner: "p1",
    position: u.position,
    hp: u.hp ?? 2,
    unitType: u.unitType ?? "WORKER",
    cargo: u.cargo ?? 0,
  }));
  const enemyUnits = (opts.enemyUnits ?? []).map((u, i) => ({
    id: u.id ?? uuid(100 + i),
    owner: "p2",
    position: u.position,
    hp: u.hp ?? 2,
    unitType: u.unitType ?? "WORKER",
    cargo: u.cargo ?? 0,
  }));
  return worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 5,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units,
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: "22222222-2222-2222-2222-222222222222", position: [50, 50], hp: 5, shield: 5, state: "NORMAL" },
        units: enemyUnits,
      },
    ],
    terrain: {
      obstacles: opts.obstacles ?? [],
      resources: opts.resources ?? [],
      piles: opts.piles ?? [],
    },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  });
}

function keyOf(pos: Position): string {
  return cellKey(pos);
}

/* ---------------- supercover 向量 ---------------- */

test("S6: supercover 直线", () => {
  const line = supercoverLine([0, 0], [3, 0]);
  assert.deepEqual(line.map(keyOf), ["0,0", "1,0", "2,0", "3,0"]);
});

test("S6: supercover 45° 对角——角两侧格都计入", () => {
  const line = supercoverLine([0, 0], [1, 1]);
  assert.deepEqual(line.map(keyOf).sort(), ["0,0", "0,1", "1,0", "1,1"]);
});

test("S6: supercover 2:3 斜率不误收终点旁格", () => {
  const line = supercoverLine([0, 0], [-2, 3]);
  assert.deepEqual(line.map(keyOf), ["0,0", "0,1", "-1,1", "-1,2", "-2,2", "-2,3"]);
  assert.equal(line.map(keyOf).includes("-1,3"), false);
});

test("S6: supercover 对角长线", () => {
  const line = supercoverLine([0, 0], [2, 2]);
  const keys = line.map(keyOf).sort();
  // 主格 + 每个过角的侧格
  assert.deepEqual(keys, ["0,0", "0,1", "1,0", "1,1", "1,2", "2,1", "2,2"]);
});

/* ---------------- 遮挡 ---------------- */

test("S6: 障碍遮挡——障碍格可见，其后不可见", () => {
  const world = makeWorld({
    units: [{ id: uuid(1), position: [0, 0] }],
    obstacles: [[1, 0]],
  });
  const visible = visibleCellSet(world, "p1", rules);
  assert.ok(visible.has("1,0"), "obstacle cell itself visible");
  assert.ok(!visible.has("2,0"), "cell behind obstacle hidden");
  assert.ok(!visible.has("3,0"), "cell far behind obstacle hidden");
  assert.ok(visible.has("0,1"), "unblocked side visible");
});

test("S6: 终点旁障碍不阻挡 2:3 中心线上的目标障碍", () => {
  const world = makeWorld({
    obstacles: [[-1, 3], [-2, 3]],
  });
  const visible = visibleCellSet(world, "p1", rules);
  assert.ok(visible.has("-2,3"), "target obstacle is inside Core radius and not behind the side obstacle");
});

test("S6: corner-touch——过角线任一侧障碍阻挡", () => {
  // 到 (2,2) 的线精确过 (1,1) 角；(1,0) 是角邻格之一 → 阻挡
  const world = makeWorld({
    units: [{ id: uuid(1), position: [0, 0] }],
    obstacles: [[1, 0]],
  });
  const visible = visibleCellSet(world, "p1", rules);
  assert.ok(!visible.has("2,2"), "diagonal line blocked by corner-side obstacle");
});

/* ---------------- 半径 ---------------- */

test("S6: 视野半径——Worker 3 / Core 5", () => {
  // worker 在 (5,0)：半径 3 → (5,3) 可见、(5,4) 不可见
  const world = makeWorld({
    units: [{ id: uuid(1), position: [5, 0] }],
  });
  const visible = visibleCellSet(world, "p1", rules);
  assert.ok(visible.has("5,3"), "worker radius 3 sees (5,3)");
  assert.ok(!visible.has("5,4"), "worker radius 3 cannot see (5,4)");
  assert.ok(!visible.has("9,0"), "worker cannot see x+4");
  // Core 在 (0,0) 半径 5 → (0,5) 可见
  assert.ok(visible.has("0,5"), "core radius 5 sees (0,5)");
});

test("S6: 视野半径从 rules manifest 读取而非硬编码", () => {
  const customRules = structuredClone(rules) as typeof rules & {
    rules: { core: { visionRadius: number }; units: { workerVisionRadius: number } };
  };
  customRules.rules.core.visionRadius = 0;
  customRules.rules.units.workerVisionRadius = 1;
  const world = makeWorld({ units: [{ id: uuid(1), position: [5, 0] }] });
  const visible = visibleCellSet(world, "p1", customRules);
  assert.ok(visible.has("5,1"));
  assert.ok(!visible.has("5,2"));
  assert.ok(!visible.has("0,1"), "Core radius override must take effect");
});

/* ---------------- union ---------------- */

test("S6: 多 observer 视野并集", () => {
  const world = makeWorld({
    units: [
      { id: uuid(1), position: [0, 0] },
      { id: uuid(2), position: [10, 0] },
    ],
  });
  const visible = visibleCellSet(world, "p1", rules);
  assert.ok(visible.has("0,3"), "observer 1 range");
  assert.ok(visible.has("10,3"), "observer 2 range");
});

/* ---------------- 投影与 stale 消失 ---------------- */

test("S6: 敌方在视野内出现、离开视野后从 state 消失（完整替换语义）", () => {
  // p2 unit 在 p1 的 core 视野内 (0,2)
  const world = makeWorld({
    enemyUnits: [{ id: uuid(100), position: [0, 2] }],
  });
  const state1 = projectPlayerState(world, "p1", rules);
  const enemy1 = state1.objects.filter((o) => "controlled" in o && o.controlled === false);
  assert.equal(enemy1.length, 1);
  assert.equal((enemy1[0] as { position?: Position }).position?.[0], 0);
  assert.equal((enemy1[0] as { position?: Position }).position?.[1], 2);

  // p2 unit 移到视野外 (0,10)
  const moved = makeWorld({
    enemyUnits: [{ id: uuid(100), position: [0, 10] }],
  });
  const state2 = projectPlayerState(moved, "p1", rules);
  const enemy2 = state2.objects.filter((o) => "controlled" in o && o.controlled === false);
  assert.equal(enemy2.length, 0, "enemy outside vision disappears from state");
});

test("S6: 己方对象恒全量（含视野外）", () => {
  const world = makeWorld({
    units: [
      { id: uuid(1), position: [0, 0] },
      { id: uuid(2), position: [50, 51] }, // 远超视野
    ],
  });
  const state = projectPlayerState(world, "p1", rules);
  const controlled = state.objects.filter((o) => "controlled" in o && o.controlled === true);
  assert.equal(controlled.length, 3, "core + 2 units all present regardless of vision");
});

test("S6: 投影对象排序稳定（canonical batching）", () => {
  const world = makeWorld({
    units: [
      { id: uuid(3), position: [1, 1] },
      { id: uuid(1), position: [0, 0] },
    ],
    resources: [[2, 2]],
  });
  const a = projectPlayerState(world, "p1", rules);
  const b = projectPlayerState(world, "p1", rules);
  assert.deepEqual(a, b, "same world projects identically");
  const units = a.objects.filter((o) => o.kind === "UNIT");
  assert.ok(units.length >= 2);
});

test("S6: dropped cargo pile 投影为 RESOURCE，Planner 可继续回收", () => {
  const world = makeWorld({
    units: [{ id: uuid(1), position: [1, 0] }],
    piles: [{ cell: [1, 0], amount: 2 }],
  });
  const state = projectPlayerState(world, "p1", rules);
  const resources = state.objects.find((object) => object.kind === "RESOURCE");
  assert.ok(resources !== undefined && resources.kind === "RESOURCE");
  assert.ok(resources.positions.some((position: Position) => cellKey(position) === "1,0"));
  const tickState = reduceTurn(simTurnLike(world, "p1", rules));
  assert.ok(tickState.resourceCells.has("1,0"));
});

test("S6: 裸 MOVING Core（无迁移字段）fail closed，不伪造 wire 字段", () => {
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 5,
        core: {
          id: "11111111-1111-1111-1111-111111111111",
          position: [0, 0],
          hp: 5,
          shield: 5,
          state: "MOVING",
        },
        units: [],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  });
  assert.throws(() => projectPlayerState(world, "p1", rules), /MOVING Core without migration fields/);
});

test("S6: MOVING Core 迁移字段投影到 wire CoreView", () => {
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 5,
        core: {
          id: "11111111-1111-1111-1111-111111111111",
          position: [0, 0],
          hp: 5,
          shield: 5,
          state: "MOVING",
          moveDirection: "RIGHT",
          moveProgress: 2,
          moveRequiredTicks: 4,
          destination: [1, 0],
        },
        units: [],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  });
  const state = projectPlayerState(world, "p1", rules);
  const core = state.objects.find((object) => object.kind === "CORE" && object.controlled === true);
  assert.ok(core !== undefined && core.kind === "CORE");
  assert.equal(core.state, "MOVING");
  assert.equal(core.move_direction, "RIGHT");
  assert.equal(core.move_progress, 2);
  assert.equal(core.move_required_ticks, 4);
  assert.deepEqual(core.destination, [1, 0]);
  // 迁移期间 position 保持逻辑位置
  assert.deepEqual(core.position, [0, 0]);
});

/* ---------------- reduceTurn 兼容 ---------------- */

test("S6: simTurnLike → reduceTurn → TickState 可被 Planner 消费", () => {
  const world = makeWorld({
    units: [
      { id: uuid(1), position: [0, 1], cargo: 0 },
      { id: uuid(2), position: [1, 0] },
    ],
    enemyUnits: [{ id: uuid(100), position: [0, 3] }],
    obstacles: [[2, 2]],
    resources: [[3, 0]],
  });
  const turn = simTurnLike(world, "p1", rules);
  const tickState = reduceTurn(turn);
  assert.equal(tickState.tick, 1);
  assert.equal(tickState.units.length, 2);
  assert.equal(tickState.workers.length, 2);
  assert.equal(tickState.resources, 5);
  assert.equal(tickState.visibleEnemies.length, 1);
  assert.ok(tickState.obstacleCells.has("2,2"));
  assert.ok(tickState.resourceCells.has("3,0"));
  assert.equal(tickState.core?.position[0], 0);
  // planner 输入必需字段齐全
  assert.equal(tickState.resourceCapacity, 10);
  assert.equal(tickState.population, 2);
});

test("S6: Beacon 坐标恒可见，但状态仅格子可见时给出（fog 补强）", () => {
  // Beacon 在 [100,100]，p1 核心 [0,0]（视野 5）——格子不可见
  const hidden = makeWorld({
    units: [{ id: uuid(1), position: [1, 0] }],
  });
  const hiddenState = projectPlayerState(hidden, "p1", rules);
  assert.equal(hiddenState.champion_beacon.status, null);
  assert.equal(hiddenState.champion_beacon.carrier_id, null);
  // 坐标恒知
  assert.deepEqual(hiddenState.champion_beacon.position, [100, 100]);
  // TickState 链路同样过滤
  const hiddenTick = reduceTurn(simTurnLike(hidden, "p1", rules));
  assert.equal(hiddenTick.beacon.status, null);
  assert.equal(hiddenTick.beacon.carrierId, null);

  // Beacon 移到 p1 核心格 [0,0]——格子可见，状态如实给出
  const visibleWorld = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 5,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: uuid(1), owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: { position: [0, 0], status: "CARRIED", carrierId: uuid(1) },
  });
  const visibleState = projectPlayerState(visibleWorld, "p1", rules);
  assert.equal(visibleState.champion_beacon.status, "CARRIED");
  assert.equal(visibleState.champion_beacon.carrier_id, uuid(1));
});
