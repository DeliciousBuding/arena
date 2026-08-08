/**
 * 迁移系统运行时配置（migration-system-v1 §7，2026-08-08 设计）。
 *
 * 独立配置节（默认全关）：不并入 runtime-config（主树并行 WIP 持有，
 * 避免双 writer 冲突；接线时经 overlay 参数注入）。
 */

import { existsSync, readFileSync } from "node:fs";

export type MigrationPacePolicy = "adaptive" | "time-based" | "harvest-driven";

export interface MigrationPaceConfig {
  readonly policy: MigrationPacePolicy;
  readonly burstCells: number;
  readonly settleTarget: number;
  readonly minSettle: number;
  readonly maxSettle: number;
  readonly harvestRadius: number;
}

export interface MigrationCorridorConfig {
  readonly width: number;
  readonly lookahead: number;
}

export interface MigrationHoldConfig {
  /** DEFENSIVE_HOLD 进入半径（活跃敌核 ≤ 此距 → HOLD）。 */
  readonly enterRadius: number;
  /** HOLD 退出半径（敌情 ≤ 此距持续 exitTicks 且 HP 满 → 恢复）。 */
  readonly exitRadius: number;
  /** HOLD 重复进入计数窗口（tick 内 ≥2 次 → REPLAN/ABORT）。 */
  readonly repeatWindowTicks: number;
}

export interface MigrationOverlayConfig {
  /** 是否允许 overlay 生成核心 START_MOVE（canary 阶段后开；默认关 = 零影响）。 */
  readonly enableCoreOrders: boolean;
  /** 每 tick 重读计划文件校验 epoch 是否被 conductor 改写（fencing）。 */
  readonly recheckEpochEachTick: boolean;
}

export interface MigrationRuntimeConfig {
  readonly enabled: boolean;
  readonly pace: MigrationPaceConfig;
  /** worker 集结带（min 叠加既有权威上限）；null = 不限制。 */
  readonly workerBand: number | null;
  readonly corridor: MigrationCorridorConfig;
  readonly hold: MigrationHoldConfig;
  readonly overlay: MigrationOverlayConfig;
}

export const DEFAULT_MIGRATION_RUNTIME_CONFIG: MigrationRuntimeConfig = {
  enabled: false,
  pace: {
    policy: "adaptive",
    burstCells: 8,
    settleTarget: 60,
    minSettle: 30,
    maxSettle: 120,
    harvestRadius: 12,
  },
  workerBand: 15,
  corridor: { width: 8, lookahead: 30 },
  hold: { enterRadius: 12, exitRadius: 18, repeatWindowTicks: 600 },
  overlay: { enableCoreOrders: false, recheckEpochEachTick: true },
};

/**
 * 从 JSON 文件加载迁移配置（浅合并，缺省回落默认值；路径缺失/损坏 → 默认全关）。
 * 文件缺省为 null 时返回 DEFAULT（enabled=false，enableCoreOrders=false），
 * 即生产保持零影响；显式配置 `enabled: true` + `overlay.enableCoreOrders: true`
 * 才激活迁移执行。
 */
export function loadMigrationRuntimeConfig(configPath: string | null): MigrationRuntimeConfig {
  if (configPath === null) return DEFAULT_MIGRATION_RUNTIME_CONFIG;
  try {
    if (!existsSync(configPath)) return DEFAULT_MIGRATION_RUNTIME_CONFIG;
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    return {
      ...DEFAULT_MIGRATION_RUNTIME_CONFIG,
      ...raw,
      pace: { ...DEFAULT_MIGRATION_RUNTIME_CONFIG.pace, ...(raw.pace as object ?? {}) },
      corridor: { ...DEFAULT_MIGRATION_RUNTIME_CONFIG.corridor, ...(raw.corridor as object ?? {}) },
      hold: { ...DEFAULT_MIGRATION_RUNTIME_CONFIG.hold, ...(raw.hold as object ?? {}) },
      overlay: { ...DEFAULT_MIGRATION_RUNTIME_CONFIG.overlay, ...(raw.overlay as object ?? {}) },
    } as MigrationRuntimeConfig;
  } catch {
    return DEFAULT_MIGRATION_RUNTIME_CONFIG;
  }
}
