/**
 * SimWorld canonical 序列化与 hash（S2）。
 *
 * 用于"同 seed/config/scenario 的 final hash 与 JSONL 逐字节一致"——
 * 所有集合按稳定 key 排序，输出与对象插入顺序无关。
 */

import { createHash } from "node:crypto";
import { cellKey } from "../../domain/model.ts";
import type { SimWorld } from "./types.ts";

function sortRecord(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortRecord);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortRecord(record[key]);
    }
    return out;
  }
  return value;
}

/** SimWorld → canonical JSON 字符串（key 排序 + 定长缩进）。 */
export function canonicalWorldJson(world: SimWorld): string {
  const players = [...world.players.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, player]) => ({
      id,
      username: player.username,
      status: player.status,
      resources: player.resources,
      core: player.core === null ? null : sortRecord(player.core),
      units: [...player.units]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((unit) => sortRecord(unit)),
    }));
  const obstacles = [...world.terrain.obstacles].sort();
  const resources = [...world.terrain.resources.keys()].sort();
  const serializable = {
    tick: world.tick,
    resolvedTickCount: world.resolvedTickCount,
    rulesVersion: world.rulesVersion,
    players,
    terrain: { obstacles, resources },
    beacon: world.beacon,
    seed: world.seed,
    rngStreamPosition: world.rngStreamPosition,
    unsupportedFeatures: [...world.unsupportedFeatures].sort(),
    provenance: world.provenance,
  };
  return JSON.stringify(sortRecord(serializable), null, 2) + "\n";
}

/** SimWorld → SHA-256（canonical）。 */
export function worldHash(world: SimWorld): string {
  return createHash("sha256").update(canonicalWorldJson(world)).digest("hex");
}

/** 辅助：cellKey 供外部复用（避免重复 import）。 */
export { cellKey };
