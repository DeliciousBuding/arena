/**
 * 变体注册映射（生产侧，2026-08-06 架构整理）：候选变体 id → SafetyPlanner
 * 配置开关的单一映射。生产 config（runtime/configs/*.json）通过 `variants`
 * 字段声明启用（如 ["threat-recall-v1"]），运行时经本模块解析为 SafetyPlanner
 * 配置——"变体启用"从改代码布尔变成改配置声明；未知 id fail-fast。
 *
 * sim 侧注册表（sim/tools/planner-variants.ts）复用本映射构造 A/B 变体，
 * 保证离线实验与生产启用读同一份事实（无环：sim → strategies 已存在）。
 */

import type { SafetyPlannerConfig } from "./safety-planner.ts";

/** 候选变体 → SafetyPlanner 配置开关（全部默认 false 的历史行为零回归）。 */
export const VARIANT_SAFETY_CONFIG: Readonly<Record<string, Partial<SafetyPlannerConfig>>> =
  Object.freeze({
    "clear-path-v1": Object.freeze({ clearPath: true }),
    "threat-recall-v1": Object.freeze({ threatRecall: true }),
    "move-failed-avoidance-v1": Object.freeze({ moveFailedAvoidance: true }),
    "threat-breakout-v1": Object.freeze({ threatBreakout: true }),
    "core-evade-v1": Object.freeze({ coreEvade: true }),
    "guard-axes-v1": Object.freeze({ guardAxes: true }),
    "guard-heal-rotation-v1": Object.freeze({ guardHealRotation: true }),
  });

/** 解析变体 id → SafetyPlanner 配置覆盖；未知 id 抛错（fail-fast）。 */
export function resolveSafetyVariantConfig(id: string): Partial<SafetyPlannerConfig> {
  const config = VARIANT_SAFETY_CONFIG[id];
  if (config === undefined) {
    throw new Error(
      `unknown safety variant: ${id} (registered: ${Object.keys(VARIANT_SAFETY_CONFIG).join(", ")})`,
    );
  }
  return config;
}

/** 判断 id 是否为已注册的安全变体（config schema 校验用）。 */
export function isSafetyVariant(id: string): boolean {
  return id in VARIANT_SAFETY_CONFIG;
}

/** 解析 config.variants 列表 → 合并的 SafetyPlanner 配置覆盖（缺省/空 = 零覆盖）。 */
export function resolveVariantsConfig(
  ids: readonly string[] | undefined,
): Partial<SafetyPlannerConfig> {
  if (ids === undefined || ids.length === 0) return {};
  return Object.assign({}, ...ids.map((id) => resolveSafetyVariantConfig(id)));
}
