/**
 * P13 chunk-quota refill（M4-1，逆向实证定案）。
 *
 * 官方语义（refill-reverse-engineering-2026-08-08 §4/§5）：
 * - 每第 4 个 resolved tick，对每个含自然点的 32×32 chunk 数"仍可用自然点数"，
 *   补回缺失槽至配额（quota = max(2, floor(16*8/(8+ring)))，ring = axis(cx)+axis(cy)）；
 * - 补点位置 = chunk 内确定性随机空槽（排除：现有自然点、障碍、结算后 Core
 *   占据格、chunk 边界主干通道；允许单位脚下与地面信标之下——官方约束为
 *   可通行/非障碍/非主干/非 Core）；
 * - 官方 placement seed 是 server-secret（单玩家视野不可逆向），模拟器实现
 *   自洽确定性环境随机流：同一 (environmentSeed, tick, chunkId) → 同一随机序列；
 *   不把 policy outcome/worldHash 混进 RNG，保证 counterfactual A/B 共用外生随机数。
 *
 * backbone 排除（map-and-vision.md:62-63 "outside chunk's backbone passages"）：
 * chunk 边界格（x 或 y 对 32 取模为 0）视为主干通道候选排除集。官方精确
 * backbone 形状是 server-secret，模拟器采用保守的"全边界格"近似（归
 * EXPECTED_UNKNOWN：与官方差异不构成确定性 Golden，需 unknown 标注）。
 * REFILL_BACKBONE_EXCLUDED=true 启用排除；置 false 可关闭用于实验对照。
 */

import { createHash } from "node:crypto";
import { cellKey, type Position } from "../../domain/model.ts";
import { createSeededRng } from "../deterministic/rng.ts";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import { chunkBounds, chunkKey, chunkOf, chunkQuota, parseChunkKey, CHUNK_SIZE } from "../world/chunks.ts";
import type { SimWorld } from "../world/types.ts";

export interface ChunkRefillSummary {
  readonly chunk: string;
  readonly quota: number;
  readonly existing: number;
  readonly refilled: number;
}

export interface RefillSummary {
  readonly total: number;
  readonly perChunk: readonly ChunkRefillSummary[];
}

/**
 * chunk 边界主干通道排除开关（map-and-vision.md:62-63）。
 * true = 补点候选排除 x%32===0 或 y%32===0 的格（保守全边界近似）；
 * false = 不排除（实验对照 / 旧行为复现）。
 */
export const REFILL_BACKBONE_EXCLUDED = true;

/** "x,y" → Position（补位节点构造用）。 */
function parsePosition(key: string): Position {
  const [x, y] = key.split(",").map((part) => Number.parseInt(part, 10));
  return [x, y];
}

/**
 * 是否位于 chunk 边界主干通道（x 或 y 对 CHUNK_SIZE(=32) 取模为 0）。
 * JS 负模修正：((n % 32) + 32) % 32 === 0 等价于 n 是 32 的整数倍。
 */
function isChunkBackbonePassage(x: number, y: number): boolean {
  const modX = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const modY = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  return modX === 0 || modY === 0;
}

/**
 * 确定性环境随机流：稳定输入 (environmentSeed, tick, chunkId) → 固定 uint32。
 * counterfactual A/B 必须共享同一外生随机流；策略只能改变候选空槽集合，
 * 不能通过 worldHash/missingSlots 间接改变随机数本身。
 */
function deriveRefillSeed(
  environmentSeed: number,
  tick: number,
  chunk: string,
): number {
  const digest = createHash("sha256")
    .update(`${environmentSeed}|${tick}|${chunk}`)
    .digest();
  return digest.readUInt32LE(0);
}

/** 结算后（P13）存活 Core 占据格——refill 空槽排除（官方约束）。 */
function coreOccupiedCells(draft: SimWorld): Set<string> {
  const cells = new Set<string>();
  for (const player of draft.players.values()) {
    if (player.core !== null) cells.add(cellKey(player.core.position));
  }
  return cells;
}

/**
 * 按 chunk 配额补缺（原地修改 draft.terrain.resources）。只作用于
 * chunks 参数列出的 chunk（= 世界载入时含自然点的 chunk）；chunk 现存
 * 自然点数 ≥ quota 时跳过。返回各 chunk 补回数量摘要。
 */
export function refillChunkQuota(
  draft: SimWorld,
  chunks: readonly string[],
  tick: number,
): RefillSummary {
  const coreCells = coreOccupiedCells(draft);
  const summaries: ChunkRefillSummary[] = [];
  let total = 0;

  for (const chunk of [...chunks].sort(compareCodeUnit)) {
    const [cx, cy] = parseChunkKey(chunk);
    const quota = chunkQuota(cx, cy);
    const { x0, y0, x1, y1 } = chunkBounds(cx, cy);

    let existing = 0;
    const candidates: string[] = [];
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const key = cellKey([x, y]);
        if (draft.terrain.resources.has(key)) {
          existing += 1;
          continue;
        }
        if (draft.terrain.obstacles.has(key)) continue;
        if (coreCells.has(key)) continue;
        if (REFILL_BACKBONE_EXCLUDED && isChunkBackbonePassage(x, y)) continue;
        candidates.push(key);
      }
    }

    const missing = Math.min(quota - existing, candidates.length);
    if (missing <= 0) {
      summaries.push({ chunk, quota, existing, refilled: 0 });
      continue;
    }

    // 不放回随机抽样：从候选空槽中逐次选位，同 seed 恒同结果。
    const rng = createSeededRng(deriveRefillSeed(draft.seed, tick, chunk));
    const resources = new Map(draft.terrain.resources);
    for (let i = 0; i < missing; i += 1) {
      const index = Math.floor(rng.next() * candidates.length);
      const key = candidates.splice(index, 1)[0]!;
      resources.set(key, { cell: parsePosition(key) });
    }
    (draft as unknown as { terrain: SimWorld["terrain"] }).terrain = {
      ...draft.terrain,
      resources,
    };
    summaries.push({ chunk, quota, existing, refilled: missing });
    total += missing;
  }

  return { total, perChunk: summaries };
}

/** 世界载入时含自然点的 chunk key 集合（refill 只作用于这些 chunk）。 */
export function initialChunkKeys(world: SimWorld): readonly string[] {
  const chunks = new Set<string>();
  for (const node of world.terrain.resources.values()) {
    const [cx, cy] = chunkOf(node.cell[0], node.cell[1]);
    chunks.add(chunkKey(cx, cy));
  }
  return [...chunks].sort(compareCodeUnit);
}
