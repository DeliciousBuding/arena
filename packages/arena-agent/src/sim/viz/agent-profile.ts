/**
 * agent 评测五维画像（arena-bench-v1）：从 episode 的 per-player cost ledger
 * 派生五维画像，并提供跨 agent 的 min-max 归一化（雷达图 0-1 输入契约）。
 *
 * 数值语义（与 fitness/arena-evolve 对齐）：
 * - economy   = harvested / aliveTicks       资源获取效率
 * - military  = damageDealt / max(unitsLost,1) 战损比
 * - survival  = aliveTicks / totalTicks      存活率
 * - beacon    = beaconTicks / aliveTicks     信标控制占比
 * - expansion = finalPopulation              终局人口规模
 *
 * 纯函数、无副作用；aliveTicks/totalTicks 为 0 时相关维度取 0（不产生 NaN）。
 */

import type { PlayerCostLedger } from "../harness/episode.ts";

export interface AgentProfile {
  /** 资源获取效率：harvested / aliveTicks */
  readonly economy: number;
  /** 战损比：damageDealt / max(unitsLost, 1) */
  readonly military: number;
  /** 存活率：aliveTicks / totalTicks */
  readonly survival: number;
  /** 信标控制占比：beaconTicks / aliveTicks */
  readonly beacon: number;
  /** 终局人口规模 */
  readonly expansion: number;
}

/** 归一化地板：0 值抬到 0.05，避免雷达图顶点塌到中心（可读性）。 */
const NORMALIZE_FLOOR = 0.05;

/** 除数为 0 时取 0（aliveTicks=0 / totalTicks=0 的维度不产生 NaN）。 */
function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function computeAgentProfile(ledger: PlayerCostLedger, totalTicks: number): AgentProfile {
  return {
    economy: safeRatio(ledger.harvested, ledger.aliveTicks),
    military: safeRatio(ledger.damageDealt, Math.max(ledger.unitsLost, 1)),
    survival: safeRatio(ledger.aliveTicks, totalTicks),
    beacon: safeRatio(ledger.beaconTicks, ledger.aliveTicks),
    expansion: ledger.finalPopulation,
  };
}

const PROFILE_DIMS = ["economy", "military", "survival", "beacon", "expansion"] as const;

/** 归一化累加器用的可变画像类型（AgentProfile 只读，逐维赋值需要可变中间态）。 */
type MutableProfile = { -readonly [K in keyof AgentProfile]: number };

/** 单维归一化：min==max 时全 1；归一化后低于地板的抬到地板；非有限输入按地板处理。 */
function normalizeDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return NORMALIZE_FLOOR;
  }
  const spread = max - min;
  if (spread <= 0) {
    return 1;
  }
  return Math.max((value - min) / spread, NORMALIZE_FLOOR);
}

export function normalizeProfiles(profiles: Record<string, AgentProfile>): Record<string, AgentProfile> {
  const agentIds = Object.keys(profiles);
  if (agentIds.length === 0) {
    return {};
  }
  const minima: Record<keyof AgentProfile, number> = {
    economy: Infinity,
    military: Infinity,
    survival: Infinity,
    beacon: Infinity,
    expansion: Infinity,
  };
  const maxima: Record<keyof AgentProfile, number> = {
    economy: -Infinity,
    military: -Infinity,
    survival: -Infinity,
    beacon: -Infinity,
    expansion: -Infinity,
  };
  for (const id of agentIds) {
    const profile = profiles[id];
    for (const dim of PROFILE_DIMS) {
      const value = profile[dim];
      if (Number.isFinite(value)) {
        if (value < minima[dim]) {
          minima[dim] = value;
        }
        if (value > maxima[dim]) {
          maxima[dim] = value;
        }
      }
    }
  }
  const result: Record<string, AgentProfile> = {};
  for (const id of agentIds) {
    const source = profiles[id];
    const normalized: MutableProfile = {
      economy: 0,
      military: 0,
      survival: 0,
      beacon: 0,
      expansion: 0,
    };
    for (const dim of PROFILE_DIMS) {
      normalized[dim] = normalizeDimension(source[dim], minima[dim], maxima[dim]);
    }
    result[id] = normalized;
  }
  return result;
}
