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
  makeSafetyEntry,
  type TournEntry,
} from "../src/sim/opponent/tournament.ts";
import { runMatrix, type MatrixOpponent } from "../src/sim/opponent/matrix.ts";
import { formatWinRateCI, wilson95 } from "../src/sim/opponent/stats.ts";
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

const player = (id: string): {
  id: string;
  username: string;
  resources: number;
  core: { id: string; position: [number, number]; hp: number; shield: number; state: "NORMAL"; moveDirection: null; moveProgress: null; moveRequiredTicks: null; destination: null };
  units: never[];
} => ({
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

// ---------- M2：Wilson 95% 区间（evidence-v1 契约） ----------

const close = (actual: number, expected: number, tolerance = 0.011): void => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected} ± ${tolerance}, got ${actual}`,
  );
};

test("wilson95：已知标定 6/8 → [0.41, 0.93]（evidence-v1.md 示例）", () => {
  const [lower, upper] = wilson95(6, 8);
  close(lower, 0.41);
  close(upper, 0.93);
  // 半宽 ≈ ±30%（M2 最低样本量门禁的论述依据）
  assert.ok(upper - lower >= 0.5, "8 局区间半宽应 ≥ ±25%");
});

test("wilson95：极端样本不越界（0/n 与 n/n 都在 [0,1] 内）", () => {
  const [zeroLower, zeroUpper] = wilson95(0, 8);
  assert.equal(zeroLower, 0);
  assert.ok(zeroUpper > 0 && zeroUpper <= 1);
  const [allLower, allUpper] = wilson95(8, 8);
  assert.ok(allLower > 0 && allLower < 1);
  assert.equal(allUpper, 1);
  // 对称性：4/8 区间以 0.5 为中心（Wilson 中点略偏，但不会出界）
  const [midLower, midUpper] = wilson95(4, 8);
  assert.ok(midLower < 0.5 && midUpper > 0.5);
});

test("wilson95：n=0 无样本 → [0, 1] 哨兵（不给出误导性窄区间）", () => {
  assert.deepEqual(wilson95(0, 0), [0, 1]);
});

test("formatWinRateCI：胜率=75% [41-93] 展示格式（整数百分比 + Wilson 取整）", () => {
  assert.equal(formatWinRateCI(6, 8), "75% [41-93]");
  assert.equal(formatWinRateCI(0, 4), "0% [0-49]");
});

// ---------- M2：交叉矩阵（runMatrix） ----------

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";

test("matrix：2 版本 × 1 对手短局——全组合跑通、统计自洽、CI 单调", () => {
  const opponent: MatrixOpponent = {
    name: "t-opp",
    desc: "test opponent",
    kind: "reference-python",
    source: "t-opp",
    entry: (seed) => makeSafetyEntry(`t-opp-s${seed}`),
  };
  const combos = runMatrix(
    [
      { entry: makeSafetyEntry("mine-aggressive"), kind: "config", source: "aggressive" },
      { entry: makeSafetyEntry("mine-defensive"), kind: "config", source: "defensive" },
    ],
    [opponent],
    [1, 2],
    { ticks: 30, rulesPath: MANIFEST_PATH, validatePlans: false, refillEveryTicks: null },
  );
  assert.equal(combos.length, 2, "2 版本 × 1 对手 = 2 组合");
  for (const combo of combos) {
    assert.equal(combo.matches.length, 2, "每组合 2 seeds");
    assert.equal(combo.matches[0].seed, 1);
    assert.equal(combo.matches[1].seed, 2);
    assert.equal(combo.versionWins + combo.opponentWins + combo.draws, 2, "胜负平合计 = 局数");
    assert.ok(combo.versionWinRate >= 0 && combo.versionWinRate <= 1);
    assert.ok(combo.opponentWinRate >= 0 && combo.opponentWinRate <= 1);
    assert.ok(combo.versionWilson95[0] <= combo.versionWilson95[1]);
    assert.ok(combo.opponentWilson95[0] <= combo.opponentWilson95[1]);
    assert.ok(Number.isFinite(combo.versionMeanResources));
    assert.ok(Number.isFinite(combo.opponentMeanResources));
    // 对手 id 约定 <name>-s<seed>：finalResources 必须收录
    assert.ok("t-opp-s1" in combo.matches[0].result.finalResources);
    assert.ok("t-opp-s2" in combo.matches[1].result.finalResources);
  }
});

test("matrix：2 版本 × 2 对手 = 4 组合（交叉全组合）", () => {
  const opponentA: MatrixOpponent = {
    name: "t-opp-a",
    desc: "test opponent a",
    kind: "reference-python",
    source: "t-opp-a",
    entry: (seed) => makeSafetyEntry(`t-opp-a-s${seed}`),
  };
  const opponentB: MatrixOpponent = {
    name: "t-opp-b",
    desc: "test opponent b",
    kind: "reference-python",
    source: "t-opp-b",
    entry: (seed) => makeSafetyEntry(`t-opp-b-s${seed}`),
  };
  const combos = runMatrix(
    [
      { entry: makeSafetyEntry("mine-a"), kind: "config", source: "a" },
      { entry: makeSafetyEntry("mine-b"), kind: "config", source: "b" },
    ],
    [opponentA, opponentB],
    [1],
    { ticks: 30, rulesPath: MANIFEST_PATH, validatePlans: false, refillEveryTicks: null },
  );
  assert.equal(combos.length, 4, "2 版本 × 2 对手 = 4 组合");
  const comboKeys = combos.map((c) => `${c.version.entry.id}:${c.opponent.name}`).sort();
  assert.deepEqual(comboKeys, ["mine-a:t-opp-a", "mine-a:t-opp-b", "mine-b:t-opp-a", "mine-b:t-opp-b"]);
});
