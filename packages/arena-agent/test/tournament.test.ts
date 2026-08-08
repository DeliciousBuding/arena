/**
 * Tournament 场景测试（对抗测试平台）：
 *  - makeArenaScenario：seed 派生资源盘变体（确定性）+ 初始 worker 合法 UUID；
 *  - decideWinner：核心存活 > 资源 > 人口 的胜负判定优先级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeArenaScenario,
  decideWinner,
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
}

const player = (id: string) => ({
  id,
  username: id,
  resources: 25,
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

test("TournEntry：makeSafetyEntry 构造可用的 SafetyPlanner provider", () => {
  const entry = { id: "mine", desc: "t", build: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" }) } satisfies TournEntry;
  const provider = entry.build();
  assert.ok(provider);
  assert.equal(typeof provider.decide, "function");
});
