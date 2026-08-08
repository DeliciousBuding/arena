/**
 * M4-1 refill chunk-quota 空槽模型测试（逆向实证定案 2026-08-08，
 * refill-reverse-engineering-2026-08-08.md §4/§5）。
 *
 * 覆盖：
 * - 官方 quota 公式与负坐标 axis/chunk 几何（chunks.ts 纯函数）；
 * - 4-tick 边界：采空后第 4 个 resolved tick 补回 quota - 现存；
 * - 排除约束：补位不在现有自然点/障碍/Core 格；
 * - 单位脚下补位允许（官方语义）；
 * - 同 tick 先采后补（P13 在 harvest 之后，现有顺序）；
 * - 同 seed 确定性（跑两次结果相同，无 Math.random）；
 * - everyTicks 配置生效；无配置保持不补（unknown note 语义由
 *   sim-settlement.test.ts S3 覆盖）。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { cellKey, type Plan, type Position } from "../src/domain/model.ts";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";
import { idlePlans, settleTick, type SettlementContext } from "../src/sim/engine/settlement.ts";
import { axisIndex, CHUNK_SIZE, chunkBounds, chunkOf, chunkQuota } from "../src/sim/world/chunks.ts";
import { worldHash } from "../src/sim/world/canonical.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";
import type { SimWorld } from "../src/sim/world/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.14.json");
const rules = loadRulesManifest(MANIFEST_PATH);

const CORE_CELL: Position = [0, 0];
const MINE_CELLS: readonly Position[] = [
  [3, 0],
  [3, 1],
  [3, 2],
  [3, 3],
];

function workerId(index: number): string {
  return `22222222-2222-2222-2222-2222222222${String(index + 1).padStart(2, "0")}`;
}

function makeRefillContext(chunks: readonly string[], everyTicks: number): SettlementContext {
  return { rules, rng: null, refill: { chunks, everyTicks } };
}

/** 1 个 chunk（0,0）+ N 个矿 + N 个 worker（各自站在矿格上）的小世界。 */
function chunkZeroScenario(options: {
  readonly seed?: number;
  /** 前 N 个矿格放 worker（= 可采数量）；缺省全 4 个。 */
  readonly harvesters?: number;
  /** 障碍格（缺省无）。 */
  readonly obstacles?: readonly Position[];
  /** 障碍填充：chunk 内除 Core/矿格/extraOpenCells 外全部填障碍。 */
  readonly obstacleFill?: boolean;
  readonly extraOpenCells?: readonly Position[];
} = {}): unknown {
  const {
    seed = 7,
    harvesters = MINE_CELLS.length,
    obstacles = [],
    obstacleFill = false,
    extraOpenCells = [],
  } = options;
  const units = MINE_CELLS.slice(0, harvesters).map((position, index) => ({
    id: workerId(index),
    owner: "p1",
    position,
    hp: 2,
    unitType: "WORKER",
    cargo: 0,
  }));
  const terrainObstacles: Position[] = [...obstacles];
  if (obstacleFill) {
    const open = new Set([
      cellKey(CORE_CELL),
      ...MINE_CELLS.map(cellKey),
      ...extraOpenCells.map(cellKey),
    ]);
    for (let x = 0; x < CHUNK_SIZE; x += 1) {
      for (let y = 0; y < CHUNK_SIZE; y += 1) {
        if (!open.has(`${x},${y}`)) terrainObstacles.push([x, y]);
      }
    }
  }
  return {
    rulesVersion: "v0.14",
    tick: 1,
    seed,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 5,
        core: {
          id: "11111111-1111-1111-1111-111111111111",
          position: CORE_CELL,
          hp: 5,
          shield: 5,
          state: "NORMAL",
        },
        units,
      },
    ],
    terrain: { obstacles: terrainObstacles, resources: [...MINE_CELLS] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

/** 全部 worker HARVEST（tick 1 用）。 */
function harvestPlans(world: SimWorld): Map<string, Plan> {
  const unitActions: Record<string, { readonly type: "HARVEST" }> = {};
  for (const unit of world.players.get("p1")!.units) {
    unitActions[unit.id] = { type: "HARVEST" };
  }
  return new Map([["p1", { tick: world.tick, unitActions, coreAction: null, intents: {} }]]);
}

/** 前 harvestCount 个 worker HARVEST，其余 WAIT。 */
function partialHarvestPlans(world: SimWorld, harvestCount: number): Map<string, Plan> {
  const unitActions: Record<string, { readonly type: "HARVEST" } | { readonly type: "WAIT" }> = {};
  world.players.get("p1")!.units.forEach((unit, index) => {
    unitActions[unit.id] = index < harvestCount ? { type: "HARVEST" } : { type: "WAIT" };
  });
  return new Map([["p1", { tick: world.tick, unitActions, coreAction: null, intents: {} }]]);
}

test("chunks: 官方 quota 公式、负坐标 axis 与 chunk 几何", () => {
  // quota = max(2, floor(16*8/(8+ring)))，ring = axis(cx)+axis(cy)
  assert.equal(chunkQuota(0, 0), 16);
  assert.equal(chunkQuota(1, 0), 14);
  assert.equal(chunkQuota(0, 1), 14);
  assert.equal(chunkQuota(-1, 0), 16, "axis(-1)=0 → ring 0");
  assert.equal(chunkQuota(-2, -1), 14, "axis(-2)=1 + axis(-1)=0 → ring 1");
  assert.equal(chunkQuota(100, 100), 2, "大 ring → floor 值 < 2 → 下限 2");
  // axis(c) = c (c≥0) 否则 -c-1
  assert.equal(axisIndex(0), 0);
  assert.equal(axisIndex(5), 5);
  assert.equal(axisIndex(-1), 0);
  assert.equal(axisIndex(-6), 5);
  // chunk = floor(x/32), floor(y/32)（负坐标向负无穷）
  assert.deepEqual(chunkOf(0, 0), [0, 0]);
  assert.deepEqual(chunkOf(31, -1), [0, -1]);
  assert.deepEqual(chunkOf(32, 32), [1, 1]);
  assert.deepEqual(chunkOf(-1, -32), [-1, -1]);
  assert.deepEqual(chunkOf(-33, 63), [-2, 1]);
  assert.deepEqual(chunkBounds(-1, -1), { x0: -32, y0: -32, x1: 0, y1: 0 });
});

test("refill: 采空后第 4 个 resolved tick 补回 quota，非 cadence tick 不补，同 seed 确定性", () => {
  const ctx = makeRefillContext(["0,0"], 4);
  const run = (): SimWorld => {
    let world = worldFromScenario(chunkZeroScenario());
    // tick 1：4 个 worker 各自采空所在矿格
    world = settleTick(world, harvestPlans(world), ctx).world;
    assert.equal(world.terrain.resources.size, 0, "tick 1 采空全部 4 矿");
    // tick 2/3：未到 cadence（第 4 个 resolved tick），不补
    for (let i = 0; i < 2; i += 1) {
      world = settleTick(world, idlePlans(world), ctx).world;
      assert.equal(world.terrain.resources.size, 0, "cadence 前不补");
    }
    // tick 4：第 4 个 resolved tick → 补到 quota（现存 0）
    const result = settleTick(world, idlePlans(world), ctx);
    world = result.world;
    assert.equal(world.terrain.resources.size, chunkQuota(0, 0), "补回数量 = quota - 现存");
    assert.ok(
      result.unknownEffects.some(
        (effect) => effect.kind === "refill" && effect.note.includes("chunk-quota refill"),
      ),
      "配置路径 unknown note 标注 chunk-quota refill",
    );
    return world;
  };

  const first = run();
  const second = run();
  // 排除约束：补位不在 Core 格、在 chunk (0,0) 内（本场景无障碍）
  for (const key of first.terrain.resources.keys()) {
    assert.notEqual(key, cellKey(CORE_CELL), "补位不在 Core 格");
    const [x, y] = key.split(",").map(Number);
    assert.ok(x >= 0 && x < 32 && y >= 0 && y < 32, `补位 ${key} 在 chunk (0,0) 内`);
  }
  // 确定性：同 seed 跑两次，最终世界 hash 与补位集合完全一致
  assert.equal(worldHash(first), worldHash(second));
  assert.deepEqual(
    [...first.terrain.resources.keys()].sort(),
    [...second.terrain.resources.keys()].sort(),
  );

  // 下个 cadence：chunk 无缺失槽 → 不重复补、不超配额
  let world = first;
  for (let i = 0; i < 4; i += 1) {
    world = settleTick(world, idlePlans(world), ctx).world;
  }
  assert.equal(world.terrain.resources.size, chunkQuota(0, 0), "全 chunk 无缺失槽时不补");
});

test("refill: 补回数量 = quota - 现存，补位不在现有自然点/障碍/Core 格", () => {
  // 3 个 worker 采 3 矿，[3,3] 保留 + 2 个障碍格
  const obstacles: readonly Position[] = [
    [5, 5],
    [6, 6],
  ];
  const scenario = chunkZeroScenario({ harvesters: 3, obstacles });
  const ctx = makeRefillContext(["0,0"], 4);
  const run = (): SimWorld => {
    let world = worldFromScenario(scenario);
    world = settleTick(world, harvestPlans(world), ctx).world; // 采空 3 矿
    for (let i = 0; i < 3; i += 1) {
      world = settleTick(world, idlePlans(world), ctx).world;
    }
    return world;
  };

  const world = run();
  const remainingMine = cellKey([3, 3]);
  const refilled = [...world.terrain.resources.keys()].filter((key) => key !== remainingMine);
  assert.equal(world.terrain.resources.size, chunkQuota(0, 0), "总点数 = quota");
  assert.equal(refilled.length, chunkQuota(0, 0) - 1, "补回数量 = quota - 现存(1)");
  for (const key of refilled) {
    assert.notEqual(key, remainingMine, "补位不在现有自然点");
    assert.notEqual(key, cellKey(CORE_CELL), "补位不在 Core 格");
    assert.ok(!obstacles.some(([x, y]) => `${x},${y}` === key), `补位不在障碍格 ${key}`);
  }
});

test("refill: 单位脚下补位允许（官方语义）", () => {
  // 障碍填满 chunk 内除 16 个空槽（4 矿 + 12 额外格）外的全部格；
  // quota(0,0)=16 → 补位必覆盖全部 16 个候选，含 4 个 worker 脚下的矿格。
  const extras: Position[] = [];
  for (const x of [5, 6, 7]) {
    for (const y of [0, 1, 2, 3]) extras.push([x, y]);
  }
  const scenario = chunkZeroScenario({ harvesters: 4, obstacleFill: true, extraOpenCells: extras });
  const ctx = makeRefillContext(["0,0"], 4);
  let world = worldFromScenario(scenario);
  world = settleTick(world, harvestPlans(world), ctx).world;
  for (let i = 0; i < 3; i += 1) {
    world = settleTick(world, idlePlans(world), ctx).world;
  }
  assert.equal(world.terrain.resources.size, 16, "全部候选空槽被补满");
  for (const mine of MINE_CELLS) {
    assert.ok(
      world.terrain.resources.has(cellKey(mine)),
      `单位脚下矿格 ${cellKey(mine)} 被补回（单位脚下补位允许）`,
    );
  }
  // 补位集合 = 16 个开放格（排除 Core 格）——不落障碍
  const openKeys = new Set([
    ...MINE_CELLS.map(cellKey),
    ...extras.map(cellKey),
  ]);
  for (const key of world.terrain.resources.keys()) {
    assert.ok(openKeys.has(key), `补位 ${key} 在开放格内（非障碍/非 Core）`);
  }
});

test("refill: 同 tick 先采后补（P13 在 harvest 之后）", () => {
  // tick 1-3 只采 3 矿；tick 4（refill tick）第 4 个 worker 采最后一矿：
  // 同一 settle 内 P08 采空 → P13 按现存 0 补 16（若先补后采会只补 15）。
  const scenario = chunkZeroScenario({ harvesters: 4 });
  const ctx = makeRefillContext(["0,0"], 4);
  let world = worldFromScenario(scenario);
  world = settleTick(world, partialHarvestPlans(world, 3), ctx).world;
  assert.equal(world.terrain.resources.size, 1, "tick 1 后剩 [3,3]");
  for (let i = 0; i < 2; i += 1) {
    world = settleTick(world, idlePlans(world), ctx).world;
  }
  world = settleTick(world, harvestPlans(world), ctx).world; // tick 4：采空 [3,3] + refill
  assert.equal(world.terrain.resources.size, chunkQuota(0, 0), "P08 先采、P13 后补 → 补 16");
});

test("refill: everyTicks 配置生效；无配置保持不补", () => {
  // everyTicks=2：settle #2 补回
  const ctx2 = makeRefillContext(["0,0"], 2);
  let world = worldFromScenario(chunkZeroScenario({ harvesters: 4 }));
  world = settleTick(world, harvestPlans(world), ctx2).world;
  assert.equal(world.terrain.resources.size, 0, "tick 1 未到 cadence(2)");
  world = settleTick(world, idlePlans(world), ctx2).world;
  assert.equal(world.terrain.resources.size, chunkQuota(0, 0), "tick 2 补回");

  // 无 refill 配置：不补（unknown note 语义由 S3 覆盖）
  const noRefill: SettlementContext = { rules, rng: null };
  let bare = worldFromScenario(chunkZeroScenario({ harvesters: 4 }));
  bare = settleTick(bare, harvestPlans(bare), noRefill).world;
  for (let i = 0; i < 3; i += 1) {
    bare = settleTick(bare, idlePlans(bare), noRefill).world;
  }
  assert.equal(bare.terrain.resources.size, 0, "无配置不补");
});
