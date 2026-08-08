/**
 * 程序化世界生成器（W53）——合成场景真实性校准。
 *
 * 移植 reference/arena-evolve/ahsim/world.py 的 _generate +
 * _break_large_clusters + _seed_initial_resources，保留官方风格：
 *   - 32×32 chunk 化生成（每 chunk 派生独立 seeded RNG）；
 *   - 每 chunk 十字主干通道（local x=0 整列 + local y=0 整行 EMPTY）→
 *     相邻 chunk 通道对齐 → 全图天然连通（官方"区块主干通道"）；
 *   - [0,0] 落在通道交汇处，永久 EMPTY（Beacon 不会被围死）；
 *   - 散点障碍 + 小簇（1-2×1-2）+ 大团块抽稀拆碎（真实分布校准：
 *     最大连通域 14 格，21+ 为 0）；
 *   - 每 chunk 按 chunkQuota 配额放资源，vacancyRate 比例 chunk 空置
 *     （真实分布：仅 65% chunk 含资源）。
 *
 * 旋钮：obstacleDensity / clusterMaxSize / vacancyRate（+ chunkRange 控制场景边界）。
 * 默认关——不改变现有手写 JSON 场景行为；仅在调用方显式启用时生效。
 *
 * 输出：raw scenario 对象（与 worldFromScenario 兼容），不直接构造 SimWorld；
 * 调用方经 worldFromScenario 载入并过 assertWorldInvariants（硬约束）。
 *
 * 确定性：所有随机性来自 createSeededRng（mulberry32），同 seed 恒同场景。
 */

import { cellKey, type Position } from "../../domain/model.ts";
import { assertSafeCoordinate } from "../deterministic/coordinate.ts";
import { createSeededRng, type SeededRng } from "../deterministic/rng.ts";
import { CHUNK_SIZE, chunkQuota } from "./chunks.ts";

/** 程序化生成旋钮（校准脚本输出默认值；调用方可覆盖）。 */
export interface ProceduralWorldParams {
  /** 散点障碍基础密度（world.py 默认 0.27）。每 chunk 实际密度 =
   *  obstacleDensity * 0.55 * uniform(0.05, 1.8)（真实 chunk 密度 0-26.3% 波动）。 */
  readonly obstacleDensity: number;
  /** 障碍连通域抽稀上限（> 该尺寸的连通域随机抽稀到该值，拆成小块）。
   *  world.py 校准 2026-08-06：真实最大连通域 14 格、21+ 为 0，默认 12。 */
  readonly clusterMaxSize: number;
  /** 资源空置率（该比例的 chunk 永不放资源——真实分布仅 65% chunk 含资源）。
   *  world.py 用 1 - 0.65 = 0.35。 */
  readonly vacancyRate: number;
  /** chunk 范围半径（生成 [-R, R]×[-R, R] 的 chunk 网格；默认 1 → 3×3 = 96×96 格）。 */
  readonly chunkRange?: number;
}

/** 默认参数（移植 world.py 校准值；校准脚本 calibrate-scenario-distribution.mts
 *  会从 survey.db 实测分布拟合输出更贴近的值）。默认关，不注入现有场景。 */
export const DEFAULT_PROCEDURAL_PARAMS: ProceduralWorldParams = {
  obstacleDensity: 0.27,
  clusterMaxSize: 12,
  vacancyRate: 0.35,
  chunkRange: 1,
};

/** 1v1 信标位置（与 tournament.makeArenaMatchScenario 对齐：双方核心
 *  [0,0]/[30,0]，信标取圆周几何中心 [15,0]，距两核各 15 > 视野 5）。 */
const PROCEDURAL_BEACON_1V1: readonly [number, number] = [15, 0];

/** 各参与方核心 id 前缀（与 tournament.CORE_ID_PREFIXES 同族，保持 canonical UUID）。 */
const PROCEDURAL_CORE_ID_PREFIXES = [
  "491977e4-d3db-417b-8d82-2f5f3b5c8000",
  "9fe0ca6d-53cb-4dd5-a8f8-2e6925f19e70",
  "1c8a4b2e-7f6d-4a3e-9c1b-5d2e8f4a6b7c",
  "6a3f9c1e-2b4d-4e8a-9f3c-7d1e5a8b2c4d",
] as const;

/** 各参与方初始 worker id 前缀（8 位 hex，跨玩家唯一）。 */
const PROCEDURAL_WORKER_ID_PREFIXES = [
  "22222222", "33333333", "44444444", "55555555",
] as const;

/**
 * 确定性 seed 派生：把 (baseSeed, cx, cy, purpose) 哈希成 32-bit 无符号整数，
 * 给 createSeededRng 做每 chunk / 每阶段独立随机源。同输入恒同输出、跨阶段独立。
 *
 * 用 cyrb53 风格哈希（非密码学，仅求确定 + 跨 chunk 去相关）；baseSeed 参与
 * 防同坐标跨场景撞种子。
 */
export function deriveProceduralSeed(
  baseSeed: number,
  cx: number,
  cy: number,
  purpose: string,
): number {
  const str = `${baseSeed >>> 0}:${cx}:${cy}:${purpose}`;
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    // FNV-1a scramble（imul 避免精度丢失；最终 >>> 0 归无符号 32-bit）
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // 再混一次 baseSeed 防低 bit 退化
  hash = (Math.imul(hash, 0x9e3779b1) ^ (baseSeed >>> 0)) >>> 0;
  return hash >>> 0;
}

/** 构造每 chunk 独立 RNG（world.py `random.Random(f"{seed}:{cx}:{cy}")` 等价）。 */
function chunkRng(baseSeed: number, cx: number, cy: number, purpose: string): SeededRng {
  return createSeededRng(deriveProceduralSeed(baseSeed, cx, cy, purpose));
}

/** [lo, hi) 左闭右开整数随机（world.py randrange 等价）。 */
function randRange(rng: SeededRng, lo: number, hi: number): number {
  return lo + Math.floor(rng.next() * (hi - lo));
}

/** [lo, hi] 闭区间整数随机（world.py randint 等价）。 */
function randInt(rng: SeededRng, lo: number, hi: number): number {
  return randRange(rng, lo, hi + 1);
}

/** [lo, hi) 左闭右开浮点随机（world.py uniform 等价）。 */
function uniform(rng: SeededRng, lo: number, hi: number): number {
  return lo + rng.next() * (hi - lo);
}

/** chunk 内是否属于"主干通道"格（local x=0 整列 + local y=0 整行）。
 *  官方语义：相邻 chunk 通道对齐 → 全图天然连通；[0,0] 永久 EMPTY。 */
function isBackbone(localX: number, localY: number): boolean {
  return localX === 0 || localY === 0;
}

/**
 * 生成程序化地形（障碍 + 资源）。返回真实坐标列表。
 *
 * reservedCells：玩家核心/worker/beacon 等不得放障碍/资源的格（cellKey 集合）。
 * 1v1 默认布局因 y=0 主轴是主干通道，核心/worker/信标全在通道上，无需额外保留；
 *  FFA 核心在圆周（非主干）必须保留。
 */
export function generateProceduralTerrain(
  params: ProceduralWorldParams,
  seed: number,
  reservedCells: ReadonlySet<string> = new Set(),
): { readonly obstacles: readonly Position[]; readonly resources: readonly Position[] } {
  const range = params.chunkRange ?? DEFAULT_PROCEDURAL_PARAMS.chunkRange ?? 1;
  const obstacleSet = new Set<string>();
  const resourceSet = new Set<string>();
  const obstaclePositions: Position[] = [];
  const resourcePositions: Position[] = [];

  const addObstacle = (gx: number, gy: number): void => {
    const key = cellKey([gx, gy]);
    if (obstacleSet.has(key)) return;
    obstacleSet.add(key);
    obstaclePositions.push([gx, gy]);
  };
  const addResource = (gx: number, gy: number): void => {
    const key = cellKey([gx, gy]);
    if (resourceSet.has(key)) return;
    resourceSet.add(key);
    resourcePositions.push([gx, gy]);
  };
  const isEmptyCell = (gx: number, gy: number): boolean => {
    const key = cellKey([gx, gy]);
    return !obstacleSet.has(key) && !resourceSet.has(key) && !reservedCells.has(key);
  };

  // ---- 阶段 1：散点 + 小簇障碍（world.py _generate）----
  for (let cy = -range; cy <= range; cy += 1) {
    for (let cx = -range; cx <= range; cx += 1) {
      const rng = chunkRng(seed, cx, cy, "chunk");
      const x0 = cx * CHUNK_SIZE;
      const y0 = cy * CHUNK_SIZE;
      // 每 chunk 密度随机因子（真实 chunk 密度 0-26.3%，波动大）
      const chunkDensity = params.obstacleDensity * 0.55 * uniform(rng, 0.05, 1.8);
      // 1-2 簇，每簇 1-2×1-2（最大 4 格，防大团块）
      const clusterCount = randInt(rng, 1, 2);
      const clusters: { cxx: number; cyy: number; cw: number; ch: number }[] = [];
      for (let i = 0; i < clusterCount; i += 1) {
        clusters.push({
          cxx: randRange(rng, 1, 31),
          cyy: randRange(rng, 1, 31),
          cw: randInt(rng, 1, 2),
          ch: randInt(rng, 1, 2),
        });
      }
      // 散点（主干通道格恒 EMPTY——不置障碍）
      for (let y = 0; y < CHUNK_SIZE; y += 1) {
        for (let x = 0; x < CHUNK_SIZE; x += 1) {
          if (isBackbone(x, y)) continue;
          if (rng.next() < chunkDensity) {
            const gx = x0 + x;
            const gy = y0 + y;
            const key = cellKey([gx, gy]);
            if (reservedCells.has(key)) continue;
            addObstacle(gx, gy);
          }
        }
      }
      // 簇（确定性 PRNG 顺序在散点之后；位置由 rng 序列决定）
      for (const cluster of clusters) {
        for (let yy = cluster.cyy; yy < Math.min(cluster.cyy + cluster.ch, CHUNK_SIZE); yy += 1) {
          for (let xx = cluster.cxx; xx < Math.min(cluster.cxx + cluster.cw, CHUNK_SIZE); xx += 1) {
            if (isBackbone(xx, yy)) continue;
            const gx = x0 + xx;
            const gy = y0 + yy;
            const key = cellKey([gx, gy]);
            if (reservedCells.has(key)) continue;
            addObstacle(gx, gy);
          }
        }
      }
    }
  }

  // ---- 阶段 2：大团块抽稀（world.py _break_large_clusters）----
  breakLargeClusters(obstacleSet, obstaclePositions, seed, params.clusterMaxSize);

  // ---- 阶段 3：资源种子（world.py _seed_initial_resources）----
  for (let cy = -range; cy <= range; cy += 1) {
    for (let cx = -range; cx <= range; cx += 1) {
      const resRng = chunkRng(seed, cx, cy, "res");
      // vacancyRate 比例 chunk 永不放资源（真实分布 35% chunk 空置）
      if (resRng.next() < params.vacancyRate) continue;
      const quota = chunkQuota(cx, cy);
      const placeRng = chunkRng(seed, cx, cy, "place");
      let placed = 0;
      let attempts = 0;
      const maxAttempts = quota * 60;
      while (placed < quota && attempts < maxAttempts) {
        attempts += 1;
        const gx = cx * CHUNK_SIZE + randRange(placeRng, 0, CHUNK_SIZE);
        const gy = cy * CHUNK_SIZE + randRange(placeRng, 0, CHUNK_SIZE);
        if (!isEmptyCell(gx, gy)) continue;
        addResource(gx, gy);
        placed += 1;
      }
    }
  }

  return { obstacles: obstaclePositions, resources: resourcePositions };
}

/**
 * 大团块抽稀（world.py _break_large_clusters）：4-邻接 BFS 找连通域，
 * > maxSize 的随机抽稀到 maxSize（保留子集，其余删）。
 *
 * 独立派生 RNG（world.py 2026-08-07 A1 修复：不与资源放置共享 RNG，
 * 避免资源位置依赖打断顺序）。原地修改 obstacleSet / obstaclePositions。
 */
function breakLargeClusters(
  obstacleSet: Set<string>,
  obstaclePositions: Position[],
  seed: number,
  maxSize: number,
): void {
  if (maxSize <= 0 || obstaclePositions.length === 0) return;
  const breakRng = chunkRng(seed, 0, 0, "break");
  const visited = new Set<string>();
  // 障碍格 → Position 映射（BFS 结果回查用）
  const positionByKey = new Map<string, Position>();
  for (const pos of obstaclePositions) positionByKey.set(cellKey(pos), pos);

  for (const start of obstaclePositions) {
    const startKey = cellKey(start);
    if (visited.has(startKey)) continue;
    // BFS 收集连通域（4-邻接）
    const queue: Position[] = [start];
    visited.add(startKey);
    const component: Position[] = [start];
    while (queue.length > 0) {
      const [cx, cy] = queue.shift()!;
      const neighbors: readonly [number, number][] = [
        [cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1],
      ];
      for (const [nx, ny] of neighbors) {
        const nkey = cellKey([nx, ny]);
        if (visited.has(nkey)) continue;
        if (!obstacleSet.has(nkey)) continue;
        const npos = positionByKey.get(nkey);
        if (npos === undefined) continue;
        visited.add(nkey);
        queue.push(npos);
        component.push(npos);
      }
    }
    if (component.length > maxSize) {
      // 随机保留 maxSize 格，其余删除（拆成小块，密度损失 <0.5%）
      const keepSet = sampleSet(breakRng, component, maxSize);
      for (const pos of component) {
        if (!keepSet.has(cellKey(pos))) {
          obstacleSet.delete(cellKey(pos));
        }
      }
    }
  }

  // 同步 obstaclePositions（删掉的从列表移除）
  obstaclePositions.length = 0;
  for (const key of obstacleSet) {
    const [x, y] = key.split(",").map(Number);
    obstaclePositions.push([x, y]);
  }
}

/** 从数组随机采样 maxSize 个 cellKey（world.py rng.sample 等价，无放回）。 */
function sampleSet(rng: SeededRng, items: readonly Position[], maxSize: number): Set<string> {
  const pool = [...items];
  const keep = new Set<string>();
  const take = Math.min(maxSize, pool.length);
  for (let i = 0; i < take; i += 1) {
    const idx = Math.floor(rng.next() * pool.length);
    keep.add(cellKey(pool[idx]));
    pool.splice(idx, 1);
  }
  return keep;
}

/** 由玩家位置 + seed 派生资源盘/障碍集构造 1v1 程序化场景（确定性）。
 *  镜像 tournament.makeArenaMatchScenario 的玩家布局，地形换成程序化生成。 */
export function makeProceduralMatchScenario(
  playerAId: string,
  playerBId: string,
  seed: number,
  params: ProceduralWorldParams = DEFAULT_PROCEDURAL_PARAMS,
): unknown {
  // 1v1 核心/worker/信标全在 y=0 主干通道上，程序化生成不会在主干放障碍 → 无需保留。
  const terrain = generateProceduralTerrain(params, seed);
  return {
    rulesVersion: "v0.14",
    tick: 1,
    seed,
    players: [
      {
        id: playerAId,
        username: playerAId,
        resources: 5,
        core: {
          id: `${PROCEDURAL_CORE_ID_PREFIXES[0]}`,
          position: [0, 0] as [number, number],
          hp: 5,
          shield: 5,
          state: "NORMAL" as const,
          moveDirection: null,
          moveProgress: null,
          moveRequiredTicks: null,
          destination: null,
        },
        units: [
          { id: `${PROCEDURAL_WORKER_ID_PREFIXES[0]}-0000-0000-0000-000000000000`, position: [1, 0] as [number, number], hp: 2, unitType: "WORKER" as const, cargo: 0 },
        ],
      },
      {
        id: playerBId,
        username: playerBId,
        resources: 5,
        core: {
          id: `${PROCEDURAL_CORE_ID_PREFIXES[1]}`,
          position: [30, 0] as [number, number],
          hp: 5,
          shield: 5,
          state: "NORMAL" as const,
          moveDirection: null,
          moveProgress: null,
          moveRequiredTicks: null,
          destination: null,
        },
        units: [
          { id: `${PROCEDURAL_WORKER_ID_PREFIXES[1]}-0000-0000-0000-000000000000`, position: [29, 0] as [number, number], hp: 2, unitType: "WORKER" as const, cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: terrain.obstacles, resources: terrain.resources },
    beacon: { position: [...PROCEDURAL_BEACON_1V1] as [number, number], status: "GROUND" as const, carrierId: null },
  };
}

/** N 玩家 FFA 程序化场景：核心均匀分布在半径 18 圆周，信标在圆心 [0,0]。
 *  镜像 tournament.makeArenaScenarioN 的玩家布局，地形换成程序化生成。
 *  FFA 核心在圆周（非主干通道），必须作为 reservedCells 防被障碍/资源压。 */
export function makeProceduralScenarioN(
  playerIds: readonly string[],
  seed: number,
  params: ProceduralWorldParams = DEFAULT_PROCEDURAL_PARAMS,
): unknown {
  const n = Math.max(2, playerIds.length);
  const radius = 18;
  const reservedCells = new Set<string>();
  const players = playerIds.map((id, index) => {
    const angle = (2 * Math.PI * index) / n - Math.PI / 2;
    const cx = Math.round(radius * Math.cos(angle));
    const cy = Math.round(radius * Math.sin(angle));
    const workerPos: [number, number] = [cx + 1, cy];
    // 核心格 + worker 格保留（防被程序化障碍/资源压）
    reservedCells.add(cellKey([cx, cy]));
    reservedCells.add(cellKey(workerPos));
    return {
      id,
      username: id,
      resources: 5,
      core: {
        id: `${PROCEDURAL_CORE_ID_PREFIXES[index % PROCEDURAL_CORE_ID_PREFIXES.length].slice(0, 23)}-${String(index).padStart(12, "0")}`,
        position: [cx, cy] as [number, number],
        hp: 5,
        shield: 5,
        state: "NORMAL" as const,
        moveDirection: null,
        moveProgress: null,
        moveRequiredTicks: null,
        destination: null,
      },
      units: [
        {
          id: `${PROCEDURAL_WORKER_ID_PREFIXES[index % PROCEDURAL_WORKER_ID_PREFIXES.length]}-0000-0000-0000-${String(index).padStart(12, "0")}`,
          position: workerPos,
          hp: 2,
          unitType: "WORKER" as const,
          cargo: 0,
        },
      ],
    };
  });
  const terrain = generateProceduralTerrain(params, seed, reservedCells);
  return {
    rulesVersion: "v0.14",
    tick: 1,
    seed,
    players,
    terrain: { obstacles: terrain.obstacles, resources: terrain.resources },
    beacon: { position: [0, 0] as [number, number], status: "GROUND" as const, carrierId: null },
  };
}

/** 校验程序化生成坐标全部 safe（供调用方在 worldFromScenario 前快速预检）。 */
export function assertProceduralCoordinatesSafe(terrain: {
  readonly obstacles: readonly Position[];
  readonly resources: readonly Position[];
}): void {
  for (const pos of terrain.obstacles) assertSafeCoordinate(pos);
  for (const pos of terrain.resources) assertSafeCoordinate(pos);
}
