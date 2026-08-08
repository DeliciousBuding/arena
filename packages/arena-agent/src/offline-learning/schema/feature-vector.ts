/**
 * 特征向量契约（feature-vector-v1）：标准化游戏状态 → ML 特征向量的映射约定。
 *
 * 所有特征为标量或固定大小数组，可直接序列化为 JSONL 一行或 Arrow table 一列。
 * 不对接任何特定 Python/ML 框架——只定义数据契约。消费者（BC/DAgger/DT/MAPPO/QMIX）
 * 按需选择特征子集。
 *
 * 设计：
 * - 空间特征：Core 相对坐标 + 距离（Chebyshev），以 Core 为原点归一化
 * - 经济特征：资源/容量/工人/携带量
 * - 军事特征：各兵种数量/HP
 * - 威胁特征：可见敌人数/距离/威胁等级 one-hot
 * - 全局特征：tick/scalar 归一化
 */

import type { TrajectoryStepState } from "./trajectory.ts";

export const FEATURE_VECTOR_SCHEMA_VERSION = "feature-vector-v1" as const;

/** 特征组标签：消费者可按组选择特征子集。 */
export type FeatureGroup = "spatial" | "economic" | "military" | "threat" | "global";

/** 单个特征的元数据。 */
export interface FeatureSpec {
  /** 特征名（列名）。 */
  readonly name: string;
  /** 所属组。 */
  readonly group: FeatureGroup;
  /** 值域描述。 */
  readonly range: string;
  /** 是否为整数特征。 */
  readonly integer: boolean;
}

/** 所有特征的规范化定义（SSOT）。 */
export const FEATURE_SPECS: readonly FeatureSpec[] = Object.freeze([
  // ── spatial（6 维）──
  { name: "core_x",              group: "spatial",   range: "[-64,64]",    integer: true },
  { name: "core_y",              group: "spatial",   range: "[-64,64]",    integer: true },
  { name: "nearest_enemy_core_dist",   group: "spatial", range: "[0,128]", integer: true },
  { name: "nearest_enemy_combat_dist", group: "spatial", range: "[0,128]", integer: true },
  { name: "nearest_enemy_core_dx",     group: "spatial", range: "[-64,64]", integer: true },
  { name: "nearest_enemy_core_dy",     group: "spatial", range: "[-64,64]", integer: true },

  // ── economic（6 维）──
  { name: "resources",           group: "economic", range: "[0,∞)",   integer: true },
  { name: "resource_capacity",   group: "economic", range: "[0,∞)",   integer: true },
  { name: "resource_ratio",      group: "economic", range: "[0,1]",   integer: false },
  { name: "workers",             group: "economic", range: "[0,30]",  integer: true },
  { name: "carried_resources",   group: "economic", range: "[0,∞)",   integer: true },
  { name: "visible_resource_cells", group: "economic", range: "[0,∞)", integer: true },

  // ── military（8 维）──
  { name: "population",          group: "military", range: "[0,30]",  integer: true },
  { name: "vanguards",           group: "military", range: "[0,30]",  integer: true },
  { name: "rangers",             group: "military", range: "[0,30]",  integer: true },
  { name: "core_hp",             group: "military", range: "[0,5]",   integer: true },
  { name: "core_shield",         group: "military", range: "[0,5]",   integer: true },
  { name: "vanguard_ratio",      group: "military", range: "[0,1]",   integer: false },
  { name: "military_total",      group: "military", range: "[0,30]",  integer: true },
  { name: "has_military",        group: "military", range: "{0,1}",   integer: true },

  // ── threat（8 维）──
  { name: "visible_enemy_units",    group: "threat", range: "[0,∞)",    integer: true },
  { name: "visible_enemy_combat",   group: "threat", range: "[0,∞)",    integer: true },
  { name: "visible_enemy_cores",    group: "threat", range: "[0,∞)",    integer: true },
  { name: "threat_normal",          group: "threat", range: "{0,1}",    integer: true },
  { name: "threat_alert",           group: "threat", range: "{0,1}",    integer: true },
  { name: "threat_engaged",         group: "threat", range: "{0,1}",    integer: true },
  { name: "threat_breakout",        group: "threat", range: "{0,1}",    integer: true },
  { name: "enemy_combat_nearby_12", group: "threat", range: "{0,1}",    integer: true },

  // ── global（3 维）──
  { name: "tick",                group: "global",  range: "[1,∞)",   integer: true },
  { name: "tick_normalized",     group: "global",  range: "[0,1]",   integer: false },
  { name: "core_normal",         group: "global",  range: "{0,1}",   integer: true },
]);

/** 特征名 → 索引映射（固定顺序 = FEATURE_SPECS 声明序）。 */
export const FEATURE_NAMES: readonly string[] = Object.freeze(
  FEATURE_SPECS.map((f) => f.name),
);

const NAME_TO_INDEX = new Map(FEATURE_NAMES.map((name, i) => [name, i]));
export const FEATURE_DIM = FEATURE_NAMES.length; // 31

// ── 特征提取 ──

/**
 * 从 TrajectoryStepState 提取完整特征向量（31 维）。
 * 返回 Float64Array，适合直接送入模型/序列化。
 *
 * 未提供的可选字段（如 nearestEnemyCoreDx/Dy 无敌人时）填 0。
 */
export function extractFeatureVector(
  state: TrajectoryStepState,
  maxTicks: number = 6000,
): Float64Array {
  const vec = new Float64Array(FEATURE_DIM);
  let i = 0;

  // spatial
  vec[i++] = state.corePosition[0];
  vec[i++] = state.corePosition[1];
  vec[i++] = state.nearestEnemyCoreDist ?? 128;   // 无可视为远距哨兵值
  vec[i++] = state.nearestEnemyCombatDist ?? 128;
  vec[i++] = 0; // nearestEnemyCoreDx (caller fills if available)
  vec[i++] = 0; // nearestEnemyCoreDy (caller fills if available)

  // economic
  vec[i++] = state.resources;
  vec[i++] = state.resourceCapacity;
  vec[i++] = state.resourceCapacity > 0 ? state.resources / state.resourceCapacity : 0;
  vec[i++] = state.workers;
  vec[i++] = state.carriedResources;
  vec[i++] = state.visibleResourceCells;

  // military
  vec[i++] = state.population;
  vec[i++] = state.vanguards;
  vec[i++] = state.rangers;
  vec[i++] = state.coreHp;
  vec[i++] = state.coreShield;
  const milTotal = state.vanguards + state.rangers;
  vec[i++] = state.population > 0 ? milTotal / state.population : 0;
  vec[i++] = milTotal;
  vec[i++] = milTotal > 0 ? 1 : 0;

  // threat
  vec[i++] = state.visibleEnemyUnits;
  vec[i++] = state.visibleEnemyCombat;
  vec[i++] = state.visibleEnemyCores;
  vec[i++] = state.threatLevel === "NORMAL" ? 1 : 0;
  vec[i++] = state.threatLevel === "ALERT" ? 1 : 0;
  vec[i++] = state.threatLevel === "ENGAGED" ? 1 : 0;
  vec[i++] = state.threatLevel === "BREAKOUT" ? 1 : 0;
  vec[i++] = (state.nearestEnemyCombatDist ?? 128) <= 12 ? 1 : 0;

  // global
  vec[i++] = state.tick;
  vec[i++] = maxTicks > 0 ? state.tick / maxTicks : 0;
  vec[i++] = state.coreState === "NORMAL" ? 1 : 0;

  return vec;
}

/**
 * 将特征向量转为普通 JS 对象（按 FEATURE_NAMES 键），适合 JSONL 序列化。
 */
export function featureVectorToRecord(vec: Float64Array): Record<string, number> {
  const record: Record<string, number> = {};
  for (let i = 0; i < FEATURE_DIM; i++) {
    record[FEATURE_NAMES[i]!] = Math.round(vec[i]! * 1e6) / 1e6; // round to 6 decimals
  }
  return record;
}

/**
 * 按特征组过滤，返回该组的特征名列表。
 */
export function featureNamesByGroup(group: FeatureGroup): readonly string[] {
  return Object.freeze(FEATURE_SPECS.filter((f) => f.group === group).map((f) => f.name));
}

/**
 * 按特征组过滤，返回该组的索引列表。
 */
export function featureIndicesByGroup(group: FeatureGroup): readonly number[] {
  return Object.freeze(
    FEATURE_SPECS
      .map((f, i) => (f.group === group ? i : -1))
      .filter((i) => i >= 0),
  );
}

/**
 * 验证特征向量维度是否正确。
 */
export function validateFeatureVector(vec: Float64Array): string[] {
  const problems: string[] = [];
  if (vec.length !== FEATURE_DIM) {
    problems.push(`feature vector length ${vec.length} != expected ${FEATURE_DIM}`);
  }
  for (let i = 0; i < vec.length && i < FEATURE_DIM; i++) {
    if (!Number.isFinite(vec[i]!)) {
      problems.push(`feature[${i}] (${FEATURE_NAMES[i]}) is not finite: ${vec[i]}`);
    }
  }
  return problems;
}
