/**
 * S4 movement resolver 测试：micro-Golden 矩阵 + permutation + 随机不变量。
 *
 * Golden 矩阵（architecture §7 / task-breakdown §S4）：
 * 单步成功 / obstacle failure / destination full / 3 抢 2、3 抢 1 /
 * 双玩家同目标 / A→B→空链 / 链尾失败传播 / 同玩家 swap / 跨玩家 swap /
 * 3-cycle / 双 occupancy 部分离场入场 / resource cell 进入。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { cellKey, type Plan, type Position } from "../src/domain/model.ts";
import { resolveMovement } from "../src/sim/engine/movement.ts";
import type { SimWorld } from "../src/sim/world/types.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";

interface UnitSpec {
  readonly id: string;
  readonly position: Position;
  readonly owner?: string;
}

/** 简短测试 id → canonical UUID（S2 不变量要求；raw 序 = 数字序）。 */
const SHORT_IDS = ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8"];
const SHORT_TO_UUID: Readonly<Record<string, string>> = Object.fromEntries(
  SHORT_IDS.map((s, i) => [s, `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`]),
);
function realId(id: string): string {
  if (id in SHORT_TO_UUID) return SHORT_TO_UUID[id];
  if (/^[0-9a-f-]{36}$/.test(id)) return id;
  throw new Error(`unknown test id: ${id}`);
}
function mapIds(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [realId(k), v]));
}

interface GoldenCase {
  readonly name: string;
  readonly players: ReadonlyArray<{
    readonly id: string;
    readonly core?: Position | null;
    readonly units: readonly UnitSpec[];
  }>;
  readonly obstacles?: readonly Position[];
  readonly resources?: readonly Position[];
  readonly actions: Readonly<Record<string, { readonly type: "MOVE"; readonly direction: "UP" | "DOWN" | "LEFT" | "RIGHT" }>>;
  readonly expected: Readonly<Record<string, "success" | "fail">>;
  readonly expectedReasons?: Readonly<Record<string, string>>;
  readonly expectedPositions?: Readonly<Record<string, Position>>;
}

const U = (id: string, position: Position, owner = "p1"): UnitSpec => ({ id: realId(id), position, owner });

/** 每玩家固定合法 core UUID。 */
const CORE_UUID: Readonly<Record<string, string>> = {
  p1: "11111111-1111-1111-1111-111111111111",
  p2: "22222222-2222-2222-2222-222222222222",
};

function buildWorld(c: GoldenCase): SimWorld {
  return worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    players: c.players.map((p) => ({
      id: p.id,
      username: p.id,
      resources: 0,
      core:
        p.core === undefined
          ? null
          : p.core === null
            ? null
            : { id: CORE_UUID[p.id] ?? `33333333-3333-3333-3333-333333333333`, position: p.core, hp: 5, shield: 5, state: "NORMAL" },
      units: p.units.map((u) => ({
        id: u.id,
        owner: u.owner ?? p.id,
        position: u.position,
        hp: 2,
        unitType: "WORKER",
        cargo: 0,
      })),
    })),
    terrain: { obstacles: c.obstacles ?? [], resources: c.resources ?? [] },
  });
}

function buildPlans(world: SimWorld, actions: GoldenCase["actions"]): ReadonlyMap<string, Plan> {
  const plans = new Map<string, Plan>();
  const byPlayer = new Map<string, Record<string, unknown>>();
  for (const [shortId, action] of Object.entries(actions)) {
    const unitId = realId(shortId);
    for (const player of world.players.values()) {
      if (player.units.some((u) => u.id === unitId)) {
        const record = byPlayer.get(player.id) ?? {};
        record[unitId] = action;
        byPlayer.set(player.id, record);
      }
    }
  }
  for (const [playerId, unitActions] of byPlayer) {
    plans.set(playerId, { tick: world.tick, unitActions: unitActions as Plan["unitActions"], coreAction: null, intents: {} });
  }
  return plans;
}

function runCase(c: GoldenCase): void {
  const world = buildWorld(c);
  const result = resolveMovement(world, buildPlans(world, c.actions));
  const statusByUnit = new Map(result.moves.map((m) => [m.unitId, m.status]));
  const reasonByUnit = new Map(result.moves.map((m) => [m.unitId, m.reason]));
  for (const [shortId, expected] of Object.entries(c.expected)) {
    assert.equal(statusByUnit.get(realId(shortId)), expected, `${c.name}: ${shortId} status`);
  }
  if (c.expectedReasons) {
    for (const [shortId, reason] of Object.entries(c.expectedReasons)) {
      assert.equal(reasonByUnit.get(realId(shortId)), reason, `${c.name}: ${shortId} reason`);
    }
  }
  if (c.expectedPositions) {
    for (const [shortId, pos] of Object.entries(c.expectedPositions)) {
      assert.deepEqual(result.positions.get(realId(shortId)), pos, `${c.name}: ${shortId} position`);
    }
  }
}

/* ---------------- Golden 矩阵 ---------------- */

test("S4 Golden: 单步成功", () => {
  runCase({
    name: "single-step",
    players: [{ id: "p1", core: [0, 0], units: [U("u1", [1, 0])] }],
    actions: { u1: { type: "MOVE", direction: "RIGHT" } },
    expected: { u1: "success" },
    expectedPositions: { u1: [2, 0] },
  });
});

test("S4 Golden: obstacle 失败（MOVE_BLOCKED_TERRAIN）", () => {
  runCase({
    name: "obstacle",
    players: [{ id: "p1", core: [0, 0], units: [U("u1", [1, 0])] }],
    obstacles: [[2, 0]],
    actions: { u1: { type: "MOVE", direction: "RIGHT" } },
    expected: { u1: "fail" },
    expectedReasons: { u1: "MOVE_BLOCKED_TERRAIN" },
  });
});

test("S4 Golden: destination full（满格 2 occupant 不走 → CELL_UNIT_LIMIT）", () => {
  runCase({
    name: "destination-full",
    players: [{ id: "p1", core: [0, 0], units: [U("u1", [1, 0]), U("u2", [2, 0]), U("u3", [2, 0])] }],
    actions: { u1: { type: "MOVE", direction: "RIGHT" } },
    expected: { u1: "fail" },
    expectedReasons: { u1: "CELL_UNIT_LIMIT" },
  });
});

test("S4 Golden: 空位格可进入（1 occupant 不走 + 1 arrival = 2 容量合法）", () => {
  // Worker 回 Core 格语义：格内静止 occupant 不阻挡进入（DEPOSIT 同格要求）
  runCase({
    name: "spare-slot-entry",
    players: [{ id: "p1", core: [0, 0], units: [U("u1", [1, 0]), U("u2", [2, 0])] }],
    actions: { u1: { type: "MOVE", direction: "RIGHT" } },
    expected: { u1: "success" },
    expectedPositions: { u1: [2, 0] },
  });
});

test("S4 Golden: 3 抢 2——低 UUID 两个赢", () => {
  // 目标格 [2,0] 空；u1/u2/u3 从三侧进入，容量 2 → 最低两个 UUID（u1,u2）赢
  runCase({
    name: "three-into-two",
    players: [
      {
        id: "p1",
        core: [0, 0],
        units: [
          U("u1", [1, 0]),
          U("u2", [2, 1]),
          U("u3", [3, 0]),
        ],
      },
    ],
    actions: {
      u1: { type: "MOVE", direction: "RIGHT" },
      u2: { type: "MOVE", direction: "UP" },
      u3: { type: "MOVE", direction: "LEFT" },
    },
    expected: { u1: "success", u2: "success", u3: "fail" },
    expectedReasons: { u3: "CELL_UNIT_LIMIT" },
    expectedPositions: { u1: [2, 0], u2: [2, 0] },
  });
});

test("S4 Golden: 3 抢 1——最低 UUID 赢", () => {
  // 目标格 [2,0] 有 u4 不动（staying=1 → room=1）；三个到达者 → 最低 UUID（u1）赢
  runCase({
    name: "three-into-one",
    players: [
      {
        id: "p1",
        core: [0, 0],
        units: [U("u1", [1, 0]), U("u2", [2, 1]), U("u3", [3, 0]), U("u4", [2, 0])],
      },
    ],
    actions: {
      u1: { type: "MOVE", direction: "RIGHT" },
      u2: { type: "MOVE", direction: "UP" },
      u3: { type: "MOVE", direction: "LEFT" },
    },
    expected: { u1: "success", u2: "fail", u3: "fail" },
    expectedReasons: {
      u2: "CELL_UNIT_LIMIT",
      u3: "CELL_UNIT_LIMIT",
    },
  });
});

test("S4 Golden: 双玩家同目标（MOVE_CONTESTED 双方失败）", () => {
  runCase({
    name: "cross-player-contested",
    players: [
      { id: "p1", core: null, units: [U("u1", [1, 0])] },
      { id: "p2", core: null, units: [U("u2", [2, 1], "p2")] },
    ],
    actions: {
      u1: { type: "MOVE", direction: "RIGHT" },
      u2: { type: "MOVE", direction: "UP" },
    },
    expected: { u1: "fail", u2: "fail" },
    expectedReasons: { u1: "MOVE_CONTESTED", u2: "MOVE_CONTESTED" },
  });
});

test("S4 Golden: A→B→空 链（链式移动成功）", () => {
  runCase({
    name: "chain",
    players: [
      {
        id: "p1",
        core: [0, 0],
        units: [U("u1", [1, 0]), U("u2", [2, 0]), U("u3", [3, 0])],
      },
    ],
    actions: {
      u1: { type: "MOVE", direction: "RIGHT" }, // 1→2
      u2: { type: "MOVE", direction: "RIGHT" }, // 2→3
      u3: { type: "MOVE", direction: "RIGHT" }, // 3→4（空）
    },
    expected: { u1: "success", u2: "success", u3: "success" },
    expectedPositions: { u1: [2, 0], u2: [3, 0], u3: [4, 0] },
  });
});

test("S4 Golden: 满格依赖失败传播（u3 撞障碍 → 依赖它的 u1 失败）", () => {
  // 格 [2,0] 满（u2、u3 都在）：u1 进 [2,0] 依赖 u2/u3 离开；
  // u3 向右撞 [3,0] 障碍 fail 留在 [2,0] → u1 fail MOVE_DEPENDENCY_FAILED；
  // u2 向下走 [2,1] 空 → 成功
  runCase({
    name: "chain-tail-failure",
    players: [
      {
        id: "p1",
        core: [0, 0],
        units: [U("u1", [1, 0]), U("u2", [2, 0]), U("u3", [2, 0])],
      },
    ],
    obstacles: [[3, 0]],
    actions: {
      u1: { type: "MOVE", direction: "RIGHT" },
      u2: { type: "MOVE", direction: "DOWN" },
      u3: { type: "MOVE", direction: "RIGHT" },
    },
    expected: { u1: "fail", u2: "success", u3: "fail" },
    expectedReasons: { u1: "MOVE_DEPENDENCY_FAILED", u3: "MOVE_BLOCKED_TERRAIN" },
  });
});

test("S4 Golden: 同玩家 swap 成功", () => {
  runCase({
    name: "same-player-swap",
    players: [{ id: "p1", core: [0, 0], units: [U("u1", [1, 0]), U("u2", [2, 0])] }],
    actions: {
      u1: { type: "MOVE", direction: "RIGHT" },
      u2: { type: "MOVE", direction: "LEFT" },
    },
    expected: { u1: "success", u2: "success" },
    expectedPositions: { u1: [2, 0], u2: [1, 0] },
  });
});

test("S4 Golden: 跨玩家 swap 失败（MOVE_SWAP_BLOCKED）", () => {
  runCase({
    name: "cross-player-swap",
    players: [
      { id: "p1", core: null, units: [U("u1", [1, 0])] },
      { id: "p2", core: null, units: [U("u2", [2, 0], "p2")] },
    ],
    actions: {
      u1: { type: "MOVE", direction: "RIGHT" },
      u2: { type: "MOVE", direction: "LEFT" },
    },
    expected: { u1: "fail", u2: "fail" },
    expectedReasons: { u1: "MOVE_SWAP_BLOCKED", u2: "MOVE_SWAP_BLOCKED" },
  });
});

test("S4 Golden: 4-cycle（同玩家环成功）", () => {
  // 四方环：u1(1,0)→(2,0)，u2(2,0)→(2,1)，u3(2,1)→(1,1)，u4(1,1)→(1,0)
  runCase({
    name: "four-cycle",
    players: [
      {
        id: "p1",
        core: [0, 0],
        units: [U("u1", [1, 0]), U("u2", [2, 0]), U("u3", [2, 1]), U("u4", [1, 1])],
      },
    ],
    actions: {
      u1: { type: "MOVE", direction: "RIGHT" },
      u2: { type: "MOVE", direction: "DOWN" },
      u3: { type: "MOVE", direction: "LEFT" },
      u4: { type: "MOVE", direction: "UP" },
    },
    expected: { u1: "success", u2: "success", u3: "success", u4: "success" },
    expectedPositions: { u1: [2, 0], u2: [2, 1], u3: [1, 1], u4: [1, 0] },
  });
});

test("S4 Golden: 双 occupancy 部分离场（1 走 1 留，到达者进）", () => {
  // 格 [3,0] 有 u2（不走）+ u3（走）；u1 想进 [3,0]——u2 不走 → 失败
  runCase({
    name: "partial-departure",
    players: [
      {
        id: "p1",
        core: [0, 0],
        units: [U("u1", [2, 0]), U("u2", [3, 0]), U("u3", [3, 0])],
      },
    ],
    actions: {
      u1: { type: "MOVE", direction: "RIGHT" },
      u3: { type: "MOVE", direction: "RIGHT" },
    },
    expected: { u1: "fail", u3: "success" },
    expectedReasons: { u1: "CELL_UNIT_LIMIT" },
  });
});

test("S4 Golden: resource cell 进入成功", () => {
  runCase({
    name: "resource-cell-entry",
    players: [{ id: "p1", core: [0, 0], units: [U("u1", [1, 0])] }],
    resources: [[2, 0]],
    actions: { u1: { type: "MOVE", direction: "RIGHT" } },
    expected: { u1: "success" },
    expectedPositions: { u1: [2, 0] },
  });
});

/* ---------------- permutation 与不变量 ---------------- */

test("S4: 动作输入顺序打乱不改变结果", () => {
  const world = buildWorld({
    name: "perm",
    players: [
      {
        id: "p1",
        core: [0, 0],
        units: [U("u1", [1, 0]), U("u2", [1, 1]), U("u3", [1, 2])],
      },
    ],
    actions: {},
    expected: {},
  });
  const baseActions: GoldenCase["actions"] = {
    u1: { type: "MOVE", direction: "RIGHT" },
    u2: { type: "MOVE", direction: "RIGHT" },
    u3: { type: "MOVE", direction: "RIGHT" },
  };
  const plansA = buildPlans(world, baseActions);
  const plansB = buildPlans(world, { u3: baseActions.u3, u1: baseActions.u1, u2: baseActions.u2 });
  const a = resolveMovement(world, plansA);
  const b = resolveMovement(world, plansB);
  assert.deepEqual(
    a.moves.map((m) => [m.unitId, m.status, m.reason]),
    b.moves.map((m) => [m.unitId, m.status, m.reason]),
  );
});

test("S4: 随机合法小图 10000 例无 invariant failure 且 occupancy 合法", () => {
  // 确定性伪随机（避免 Math.random）——用固定 LCG 生成场景
  let state = 12345;
  const rand = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const uuids = Array.from({ length: 8 }, (_, i) => `f0000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
  for (let iter = 0; iter < 10_000; iter += 1) {
    const n = 2 + Math.floor(rand() * 6);
    const units = uuids.slice(0, n).map((id, i) => ({ id, position: [i * 2 + 1, 0] as Position }));
    const world = worldFromScenario({
      rulesVersion: "v0.11",
      players: [{ id: "p1", username: "p1", resources: 0, core: null, units }],
      terrain: { obstacles: [], resources: [] },
    });
    const actions: Record<string, { type: "MOVE"; direction: "UP" | "DOWN" | "LEFT" | "RIGHT" }> = {};
    for (const u of units) {
      const dir = ["UP", "DOWN", "LEFT", "RIGHT"][Math.floor(rand() * 4)] as "UP" | "DOWN" | "LEFT" | "RIGHT";
      actions[u.id] = { type: "MOVE", direction: dir };
    }
    const result = resolveMovement(world, buildPlans(world, actions));
    // 位置集合：成功者到 dest，失败者留原位；校验 occupancy ≤ 2
    const occ = new Map<string, number>();
    for (const m of result.moves) {
      const unit = world.players.get("p1")!.units.find((u) => u.id === m.unitId)!;
      const pos = m.status === "fail" ? unit.position : actions[m.unitId] === undefined ? unit.position : destOf(unit.position, actions[m.unitId]);
      const key = cellKey(pos);
      occ.set(key, (occ.get(key) ?? 0) + 1);
    }
    for (const [key, count] of occ) {
      assert.ok(count <= 2, `iter ${iter}: occupancy ${count} at ${key}`);
    }
    // fail 的原因只允许官方 reason 集合
    for (const m of result.moves) {
      if (m.status === "fail") {
        assert.ok(
          ["MOVE_BLOCKED_TERRAIN", "CELL_UNIT_LIMIT", "MOVE_CONTESTED", "MOVE_SWAP_BLOCKED", "MOVE_DESTINATION_OCCUPIED", "MOVE_DEPENDENCY_FAILED"].includes(m.reason ?? ""),
          `iter ${iter}: unexpected reason ${m.reason}`,
        );
      }
    }
  }
});

function destOf(source: Position, action: { type: "MOVE"; direction: "UP" | "DOWN" | "LEFT" | "RIGHT" }): Position {
  switch (action.direction) {
    case "UP":
      return [source[0], source[1] - 1];
    case "DOWN":
      return [source[0], source[1] + 1];
    case "LEFT":
      return [source[0] - 1, source[1]];
    case "RIGHT":
      return [source[0] + 1, source[1]];
  }
}
