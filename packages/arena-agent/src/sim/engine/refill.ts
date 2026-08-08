/**
 * P13 chunk-quota refill（M4-1，逆向实证定案）。
 *
 * 官方语义（refill-reverse-engineering-2026-08-08 §4/§5）：
 * - 每第 4 个 resolved tick，对每个含自然点的 32×32 chunk 数"仍可用自然点数"，
 *   补回缺失槽至配额（quota = max(2, floor(16*8/(8+ring)))，ring = axis(cx)+axis(cy)）；
 * - 补点位置 = chunk 内确定性随机空槽（排除：现有自然点、障碍、结算后 Core
 *   占据格；允许单位脚下与地面信标之下——官方约束为可通行/非障碍/非主干/非 Core）；
 * - 官方 placement seed 是 server-secret（单玩家视野不可逆向），模拟器实现
 *   自洽确定性：同一 (worldHash, tick, chunkId, missingSlots) → 同一位置。
 */

import { createHash } from "node:crypto";
import { cellKey, type Position } from "../../domain/model.ts";
import { createSeededRng } from "../deterministic/rng.ts";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import { worldHash } from "../world/canonical.ts";
import { chunkBounds, chunkKey, chunkOf, chunkQuota, parseChunkKey } from "../world/chunks.ts";
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

/** "x,y" → Position（补位节点构造用）。 */
function parsePosition(key: string): Position {
  const [x, y] = key.split(",").map((part) => Number.parseInt(part, 10));
  return [x, y];
}

/**
 * 确定性 seed：稳定输入 (worldHash, tick, chunkId, missingSlots) → 固定
 * uint32。禁止 Math.random；同 seed 恒同结果。
 */
function deriveRefillSeed(
  worldHashHex: string,
  tick: number,
  chunk: string,
  missingSlots: number,
): number {
  const digest = createHash("sha256")
    .update(`${worldHashHex}|${tick}|${chunk}|${missingSlots}`)
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
  const hash = worldHash(draft);
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
        candidates.push(key);
      }
    }

    const missing = Math.min(quota - existing, candidates.length);
    if (missing <= 0) {
      summaries.push({ chunk, quota, existing, refilled: 0 });
      continue;
    }

    // 不放回随机抽样：从候选空槽中逐次选位，同 seed 恒同结果。
    const rng = createSeededRng(deriveRefillSeed(hash, tick, chunk, missing));
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
