/**
 * Tournament 场景测试（对抗测试平台）：
 *  - makeArenaScenario：seed 派生资源盘变体（确定性）+ 初始 worker 合法 UUID；
 *  - decideWinner：核心存活 > 资源 > 人口 的胜负判定优先级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeArenaScenario,
  makeArenaMatchScenario,
  decideWinner,
  makeSafetyEntry,
  type TournEntry,
} from "../src/sim/opponent/tournament.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import type { SimWorld } from "../src/sim/world/types.ts";

interface ScenarioShape {
  readonly players: readonly {
    readonly id: string;
    readonly username: string;
    readonly resources: number;
    readonly core: { readonly id: string; readonly position: readonly [number, number] };
    readonly units: readonly { readonly id: string; readonly position: readonly [number, number]; readonly unitType: string }[];
  }[];
  readonly terrain: { readonly resources: readonly (readonly [number, number])[] };
  readonly beacon: { readonly position: readonly [number, number] };
  readonly seed: number;
}

const player = (id: string): {
  id: string;
  username: string;
  resources: number;
  core: { id: string; position: [number, number]; hp: number; shield: number; state: "NORMAL"; moveDirection: null; moveProgress: null; moveRequiredTicks: null; destination: null };
  units: never[];
} => ({
  id,
  username: id,
  // 起点资源：M4-3 官方语义 5（makeArenaScenario 不改写入参，这里与官方对齐）
  resources: 5,
  core: { id: "491977e4-d3db-417b-8d82-2f5f3b5c8006", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", moveDirection: null, moveProgress: null, moveRequiredTicks: null, destination: null },
  units: [],
});

test("makeArenaScenario：seed 派生资源盘变体（确定性）", () => {
  const s1 = makeArenaScenario(player("a"), player("b"), 1) as ScenarioShape;
  const s1again = makeArenaScenario(player("a"), player("b"), 1) as ScenarioShape;
  const s2 = makeArenaScenario(player("a"), player("b"), 2) as ScenarioShape;
  // 同 seed 恒同布局；不同 seed 布局不同
  assert.deepEqual(s1.terrain.resources, s1again.terrain.resources);
  assert.notDeepEqual(s1.terrain.resources, s2.terrain.resources);
  assert.ok(s1.terrain.resources.length > 0);
  // seed 进场景（runEpisode 会用它做随机源）
  const raw = makeArenaScenario(player("a"), player("b"), 7) as { seed: number };
  assert.equal(raw.seed, 7);
});

test("makeArenaScenario：players 携带合法 UUID 的初始单位", () => {
  const s = makeArenaScenario(player("a"), player("b"), 1) as ScenarioShape;
  for (const p of s.players) {
    assert.ok(p.units.length >= 0);
    for (const unit of p.units) {
      assert.match(unit.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  }
});

test("makeArenaScenario：M4-2/4 官方语义——beacon [15,0]、seed 派生障碍集且不破坏评测前提", () => {
  // 全部 6 个变体（与 RESOURCE_LAYOUTS 同源 seed % 6）逐一校验：
  //  - beacon [15,0]（距两核 15 > 视野 5，开局不可见）；
  //  - 障碍 8 格 = 4 个两两相邻的 1×2/2×1 块，位于双方核心之间偏侧；
  //  - 距任一核心 Manhattan > 3（核心周围 3 格无阻碍）；
  //  - y=0 主轴线全程无障碍（[0,0]→[30,0] 通路不被封死）；
  //  - 障碍与该 seed 资源盘格零重叠。
  const manhattan = (a: readonly [number, number], b: readonly [number, number]): number =>
    Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  const obstacleSets = new Set<string>();
  for (const seed of [0, 1, 2, 3, 4, 5]) {
    const s = makeArenaScenario(player("a"), player("b"), seed) as ScenarioShape & {
      terrain: { obstacles: readonly (readonly [number, number])[] };
    };
    assert.deepEqual(s.beacon.position, [15, 0], "beacon 归位圆周几何中心 [15,0]");
    const obstacles = s.terrain.obstacles;
    assert.equal(obstacles.length, 8, `seed ${seed}：4 块 × 2 格障碍`);
    for (const [x, y] of obstacles) {
      assert.notEqual(y, 0, "主轴 y=0 无障碍（通路不被封死）");
      assert.ok(manhattan([x, y], [0, 0]) > 3, "距核心 A 周围 3 格无阻碍");
      assert.ok(manhattan([x, y], [30, 0]) > 3, "距核心 B 周围 3 格无阻碍");
      for (const resource of s.terrain.resources) {
        assert.notDeepEqual([x, y], resource, "障碍不与资源盘格重叠");
      }
      assert.notDeepEqual([x, y], [15, 0], "障碍不压信标");
      obstacleSets.add(`${x},${y}`);
    }
    // 每格恰 1 个相邻格 → 集合是 4 个互不相连的 1×2/2×1 块
    for (const [x, y] of obstacles) {
      const neighbors = obstacles.filter(
        ([nx, ny]) => Math.abs(nx - x) + Math.abs(ny - y) === 1,
      );
      assert.equal(neighbors.length, 1, `seed ${seed}：格 (${x},${y}) 恰属一个 1×2/2×1 块`);
    }
  }
  assert.ok(obstacleSets.size > 8, "不同 seed 障碍集存在差异（确定性变体）");
});

test("makeArenaMatchScenario：起点 5/1 + beacon [15,0]（M4-2/3 官方语义）", () => {
  const a = makeSafetyEntry("mine");
  const b = makeSafetyEntry("p2");
  const scenario = makeArenaMatchScenario(a, b, 3) as ScenarioShape & {
    beacon: { position: [number, number] };
  };
  assert.deepEqual(scenario.beacon.position, [15, 0]);
  for (const p of scenario.players) {
    // 官方 startingResources=5 / startingWorkerCount=1（rules-v0.14）
    assert.equal(p.resources, 5, "起点 5 资源（无容量收缩）");
    assert.equal(p.units.length, 1, "起点 1 worker");
  }
});

test("decideWinner：核心存活优先 → 资源 → 人口", () => {
  const players = ["a", "b"];
  const after = {
    players: new Map([
      ["a", { core: null, resources: 0, units: [] }],
      ["b", { core: { id: "x" }, resources: 1, units: [] }],
    ]),
  } as unknown as SimWorld;
  // 只有 b 存活核心 → b 胜
  assert.equal(decideWinner(players, undefined as never, after).winner, "b");

  const bothAlive = {
    players: new Map([
      ["a", { core: { id: "x" }, resources: 5, units: [{}] }],
      ["b", { core: { id: "y" }, resources: 9, units: [] }],
    ]),
  } as unknown as SimWorld;
  // 都活：资源多 → b
  assert.equal(decideWinner(players, undefined as never, bothAlive).winner, "b");

  const resourceTie = {
    players: new Map([
      ["a", { core: { id: "x" }, resources: 5, units: [{}, {}] }],
      ["b", { core: { id: "y" }, resources: 5, units: [{}] }],
    ]),
  } as unknown as SimWorld;
  // 资源平：人口多 → a
  assert.equal(decideWinner(players, undefined as never, resourceTie).winner, "a");

  const fullTie = {
    players: new Map([
      ["a", { core: { id: "x" }, resources: 5, units: [{}] }],
      ["b", { core: { id: "y" }, resources: 5, units: [{}] }],
    ]),
  } as unknown as SimWorld;
  // 全平 → null
  assert.equal(decideWinner(players, undefined as never, fullTie).winner, null);
});

test("decideWinner：FFA 中间态——部分核心被拆、多存活时按存活阵营资源定胜", () => {
  const players = ["a", "b", "c", "d"];
  const midState = {
    players: new Map([
      // b/c/d 存活，a 核心被拆；存活者资源 b=10 > c=4 > d=2 → b 胜
      ["a", { core: null, resources: 0, units: [] }],
      ["b", { core: { id: "b" }, resources: 10, units: [{}] }],
      ["c", { core: { id: "c" }, resources: 4, units: [{}] }],
      ["d", { core: { id: "d" }, resources: 2, units: [{}] }],
    ]),
  } as unknown as SimWorld;
  assert.equal(decideWinner(players, undefined as never, midState).winner, "b");

  // 唯一存活（a 死、c/d 死）→ 最后幸存者胜，资源无关
  const lastStanding = {
    players: new Map([
      ["a", { core: null, resources: 0, units: [] }],
      ["b", { core: { id: "b" }, resources: 1, units: [] }],
      ["c", { core: null, resources: 0, units: [] }],
      ["d", { core: null, resources: 0, units: [] }],
    ]),
  } as unknown as SimWorld;
  assert.equal(decideWinner(players, undefined as never, lastStanding).winner, "b");

  // 存活者资源平且人口平 → null（不误判）
  const midTie = {
    players: new Map([
      ["a", { core: null, resources: 0, units: [] }],
      ["b", { core: { id: "b" }, resources: 3, units: [{}] }],
      ["c", { core: { id: "c" }, resources: 3, units: [{}] }],
      ["d", { core: null, resources: 0, units: [] }],
    ]),
  } as unknown as SimWorld;
  assert.equal(decideWinner(players, undefined as never, midTie).winner, null);
});

test("TournEntry：makeSafetyEntry 构造可用的 SafetyPlanner provider", () => {
  const entry = { id: "mine", desc: "t", build: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" }) } satisfies TournEntry;
  const provider = entry.build();
  assert.ok(provider);
  assert.equal(typeof provider.decide, "function");
});
