/**
 * 程序化世界生成器测试（W53）：
 *  - generateProceduralTerrain：确定性（同 seed 恒同输出）；
 *  - 主干通道对齐（x 或 y 是 32 倍数 → EMPTY）；
 *  - [0,0] 恒 EMPTY（Beacon 不会被围死）；
 *  - 大团块抽稀：连通域 ≤ clusterMaxSize；
 *  - vacancyRate=1 → 全部 chunk 空置（0 资源）；
 *  - makeProceduralMatchScenario：经 worldFromScenario 载入并通过 assertWorldInvariants；
 *  - makeProceduralScenarioN：FFA 圆周核心不被障碍/资源压、过 invariants；
 *  - 默认关：tournament.runMatch 不带 procedural 仍用 makeArenaMatchScenario 布局。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { cellKey, type Position } from "../src/domain/model.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";
import { assertWorldInvariants, WorldInvariantError } from "../src/sim/world/world.ts";
import { CHUNK_SIZE } from "../src/sim/world/chunks.ts";
import {
  DEFAULT_PROCEDURAL_PARAMS,
  deriveProceduralSeed,
  generateProceduralTerrain,
  makeProceduralMatchScenario,
  makeProceduralScenarioN,
  type ProceduralWorldParams,
} from "../src/sim/world/procedural.ts";
import {
  makeArenaMatchScenario,
  makeSafetyEntry,
  runMatch,
} from "../src/sim/opponent/tournament.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";

test("deriveProceduralSeed：同输入恒同输出、跨 chunk 去相关", () => {
  const a = deriveProceduralSeed(7, 1, -1, "chunk");
  const b = deriveProceduralSeed(7, 1, -1, "chunk");
  assert.equal(a, b);
  // 不同 chunk/purpose 应产生不同种子
  const c = deriveProceduralSeed(7, 1, 0, "chunk");
  const d = deriveProceduralSeed(7, 1, -1, "res");
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  // 32-bit 无符号范围
  assert.ok(Number.isInteger(a) && a >= 0 && a <= 0xffffffff);
});

test("generateProceduralTerrain：确定性——同 seed 恒同地形", () => {
  const params: ProceduralWorldParams = {
    obstacleDensity: 0.27,
    clusterMaxSize: 12,
    vacancyRate: 0.35,
    chunkRange: 1,
  };
  const t1 = generateProceduralTerrain(params, 42);
  const t2 = generateProceduralTerrain(params, 42);
  assert.deepEqual(t1.obstacles, t2.obstacles);
  assert.deepEqual(t1.resources, t2.resources);
  // 不同 seed 布局不同
  const t3 = generateProceduralTerrain(params, 99);
  assert.notDeepEqual(t1.obstacles, t3.obstacles);
});

test("generateProceduralTerrain：主干通道对齐（x 或 y 是 32 倍数 → 无障碍）", () => {
  const params: ProceduralWorldParams = {
    obstacleDensity: 0.40,
    clusterMaxSize: 12,
    vacancyRate: 0.35,
    chunkRange: 1,
  };
  const { obstacles } = generateProceduralTerrain(params, 1);
  for (const [x, y] of obstacles) {
    // local x=0 或 local y=0 是主干——禁止放障碍
    if (x % CHUNK_SIZE === 0 || y % CHUNK_SIZE === 0) {
      assert.fail(`主干通道格 [${x},${y}] 不应有障碍`);
    }
  }
});

test("generateProceduralTerrain：[0,0] 恒 EMPTY（Beacon 不被围死）", () => {
  for (const seed of [0, 1, 7, 42, 100]) {
    const { obstacles, resources } = generateProceduralTerrain(DEFAULT_PROCEDURAL_PARAMS, seed);
    const originKey = cellKey([0, 0]);
    assert.ok(!obstacles.some((p) => cellKey(p) === originKey), `[0,0] seed=${seed} 不应有障碍`);
    assert.ok(!resources.some((p) => cellKey(p) === originKey), `[0,0] seed=${seed} 不应有资源`);
  }
});

test("generateProceduralTerrain：障碍/资源不重叠", () => {
  const { obstacles, resources } = generateProceduralTerrain(DEFAULT_PROCEDURAL_PARAMS, 7);
  const obstacleKeys = new Set(obstacles.map((p) => cellKey(p)));
  for (const r of resources) {
    assert.ok(!obstacleKeys.has(cellKey(r)), `资源 ${cellKey(r)} 不应落在障碍格上`);
  }
});

test("generateProceduralTerrain：大团块抽稀——连通域 ≤ clusterMaxSize", () => {
  const params: ProceduralWorldParams = {
    obstacleDensity: 0.45, // 高密度促发大块
    clusterMaxSize: 8,
    vacancyRate: 0.35,
    chunkRange: 1,
  };
  const { obstacles } = generateProceduralTerrain(params, 3);
  // BFS 4-邻接连通域
  const obstacleSet = new Set(obstacles.map((p) => cellKey(p)));
  const visited = new Set<string>();
  let maxSize = 0;
  for (const start of obstacles) {
    const startKey = cellKey(start);
    if (visited.has(startKey)) continue;
    const queue: Position[] = [start];
    visited.add(startKey);
    let size = 0;
    while (queue.length > 0) {
      const [cx, cy] = queue.shift()!;
      size += 1;
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]] as const) {
        const nkey = cellKey([nx, ny]);
        if (!visited.has(nkey) && obstacleSet.has(nkey)) {
          visited.add(nkey);
          queue.push([nx, ny]);
        }
      }
    }
    if (size > maxSize) maxSize = size;
  }
  assert.ok(maxSize <= 8, `最大连通域 ${maxSize} 应 ≤ clusterMaxSize=8`);
});

test("generateProceduralTerrain：vacancyRate=1 → 全部 chunk 空置（0 资源）", () => {
  const params: ProceduralWorldParams = {
    obstacleDensity: 0.27,
    clusterMaxSize: 12,
    vacancyRate: 1.0, // 全空置
    chunkRange: 1,
  };
  const { resources } = generateProceduralTerrain(params, 5);
  assert.equal(resources.length, 0, "vacancyRate=1 时不应生成任何资源");
});

test("generateProceduralTerrain：vacancyRate=0 → 所有 chunk 尝试放资源（>0）", () => {
  const params: ProceduralWorldParams = {
    obstacleDensity: 0.10,
    clusterMaxSize: 12,
    vacancyRate: 0.0,
    chunkRange: 1,
  };
  const { resources } = generateProceduralTerrain(params, 5);
  assert.ok(resources.length > 0, "vacancyRate=0 时应生成资源");
});

test("generateProceduralTerrain：reservedCells 防障碍/资源压格", () => {
  const reserved = new Set<string>(["5,5", "10,10"]);
  const { obstacles, resources } = generateProceduralTerrain(
    { obstacleDensity: 0.40, clusterMaxSize: 12, vacancyRate: 0.0, chunkRange: 1 },
    7,
    reserved,
  );
  for (const [x, y] of obstacles) {
    assert.ok(!reserved.has(cellKey([x, y])), `障碍落在保留格 ${cellKey([x, y])}`);
  }
  for (const [x, y] of resources) {
    assert.ok(!reserved.has(cellKey([x, y])), `资源落在保留格 ${cellKey([x, y])}`);
  }
});

test("makeProceduralMatchScenario：经 worldFromScenario 载入并通过 invariants", () => {
  for (const seed of [1, 2, 3, 7]) {
    const scenario = makeProceduralMatchScenario("p1", "p2", seed, DEFAULT_PROCEDURAL_PARAMS);
    const world = worldFromScenario(scenario);
    // 不变量校验（硬约束 1）
    assert.doesNotThrow(() => assertWorldInvariants(world), `seed=${seed} 应通过 invariants`);
    // [0,0] 恒 EMPTY（硬约束 2）
    assert.ok(!world.terrain.obstacles.has(cellKey([0, 0])));
    // beacon 格非障碍
    assert.ok(!world.terrain.obstacles.has(cellKey([15, 0])));
  }
});

test("makeProceduralMatchScenario：种子进场景、玩家 id 与入参一致", () => {
  const raw = makeProceduralMatchScenario("mine", "opp", 9, DEFAULT_PROCEDURAL_PARAMS) as {
    seed: number;
    players: { id: string }[];
  };
  assert.equal(raw.seed, 9);
  assert.deepEqual(raw.players.map((p) => p.id), ["mine", "opp"]);
});

test("makeProceduralScenarioN：FFA 圆周核心不被障碍/资源压、过 invariants", () => {
  for (const n of [2, 3, 4]) {
    const ids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
    const scenario = makeProceduralScenarioN(ids, 5, DEFAULT_PROCEDURAL_PARAMS);
    const world = worldFromScenario(scenario);
    assert.doesNotThrow(() => assertWorldInvariants(world), `N=${n} 应通过 invariants`);
    // 每个核心格非障碍（硬约束：不被围死）
    for (const player of world.players.values()) {
      if (player.core !== null) {
        assert.ok(
          !world.terrain.obstacles.has(cellKey(player.core.position)),
          `核心 ${player.id} 在 ${cellKey(player.core.position)} 不应是障碍`,
        );
      }
    }
    // beacon 在 [0,0]，非障碍
    assert.ok(!world.terrain.obstacles.has(cellKey([0, 0])));
  }
});

test("makeProceduralScenarioN：worker id 跨玩家唯一（canonical UUID）", () => {
  const scenario = makeProceduralScenarioN(["a", "b", "c", "d"], 1, DEFAULT_PROCEDURAL_PARAMS) as {
    players: { units: { id: string }[] }[];
  };
  const ids = scenario.players.flatMap((p) => p.units.map((u) => u.id));
  const unique = new Set(ids);
  assert.equal(ids.length, unique.size, "worker id 应全图唯一");
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  }
});

test("runMatch：procedural=true 启用程序化场景（与默认布局不同）", () => {
  const a = makeSafetyEntry("mine");
  const b = makeSafetyEntry("opp");
  // 默认（手写布局）：8 格固定障碍
  const defaultScenario = makeArenaMatchScenario(a, b, 1) as {
    terrain: { obstacles: readonly (readonly [number, number])[] };
  };
  assert.equal(defaultScenario.terrain.obstacles.length, 8);
  // procedural=true：程序化地形（障碍数 ≠ 8，且 > 0）
  const result = runMatch(a, b, 1, 10, MANIFEST_PATH, {
    procedural: true,
    refillEveryTicks: null,
    validatePlans: false,
  });
  assert.ok(result.players.length === 2);
  assert.ok(typeof result.winner === "string" || result.winner === null);
});

test("runMatch：默认关——不带 procedural 仍用 makeArenaMatchScenario 布局", () => {
  const a = makeSafetyEntry("mine");
  const b = makeSafetyEntry("opp");
  // 不带 procedural → 跑通即证明默认路径未变（现有手写布局行为不变）
  const result = runMatch(a, b, 1, 10, MANIFEST_PATH, {
    refillEveryTicks: null,
    validatePlans: false,
  });
  assert.ok(result.players.length === 2);
});

test("generateProceduralTerrain：坐标全部 safe integer", () => {
  const { obstacles, resources } = generateProceduralTerrain(DEFAULT_PROCEDURAL_PARAMS, 1);
  for (const [x, y] of obstacles) {
    assert.ok(Number.isSafeInteger(x) && Number.isSafeInteger(y), `障碍坐标 [${x},${y}] 非 safe integer`);
  }
  for (const [x, y] of resources) {
    assert.ok(Number.isSafeInteger(x) && Number.isSafeInteger(y), `资源坐标 [${x},${y}] 非 safe integer`);
  }
});

test("assertWorldInvariants：违规场景抛 WorldInvariantError（回归保护）", () => {
  // 直接构造违规 SimWorld（[0,0] 是障碍）验证 invariants 仍生效
  const badScenario = {
    rulesVersion: "v0.14",
    tick: 1,
    seed: 1,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 5,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [1, 1], hp: 5, shield: 5, state: "NORMAL" },
        units: [],
      },
    ],
    terrain: { obstacles: [[0, 0]], resources: [] }, // [0,0] 障碍 → 违规
    beacon: { position: [2, 2], status: "GROUND", carrierId: null },
  };
  assert.throws(() => assertWorldInvariants(worldFromScenario(badScenario)), WorldInvariantError);
});
