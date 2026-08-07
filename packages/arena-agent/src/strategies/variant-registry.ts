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
    "core-evade-persist-v1": Object.freeze({ coreEvade: true, coreEvadePersist: true }),
    "guard-axes-v1": Object.freeze({ guardAxes: true }),
    "guard-heal-rotation-v1": Object.freeze({ guardHealRotation: true }),
    "detached-squad-v1": Object.freeze({ detachedSquadResponse: true }),
    "bounded-raid-v1": Object.freeze({ boundedRaid: true }),
    "scout-evade-v1": Object.freeze({ scoutEvade: true }),
    "ranger-memory-shot-v1": Object.freeze({ rangerMemoryShot: true }),
    /**
     * 攻坚候选（2026-08-07 用户导向"爆兵打对面水晶"，安全侧 = 军事单位行为）：
     * - aggression=aggressive：Vanguard 记忆推进敌 Core / Ranger 断敌经济；
     * - attackForce=6：军事规模达标才前压（避免零星送死）；
     * - boundedRaid：敌 Core 超 40 格视为远征送死，回撤守家；
     * - rangerMemoryShot：视野丢失时对记忆中的敌 Core 格保持射击压制；
     * - strikeGroupReserve：留 1 个 Vanguard 守家（防换家）。
     * 配套 deterministic 侧（DETERMINISTIC_VARIANT_CONFIG）：vanguardRatio=0.5
     * 交替产兵 + accumulateThreshold=30 积累期爆兵节奏。
     */
    "strike-core-v1": Object.freeze({
      aggression: "aggressive",
      attackForce: 6,
      boundedRaid: true,
      rangerMemoryShot: true,
      strikeGroupReserve: true,
    }),
  });

/** DeterministicPlanner 构造参数覆盖（core 生产侧，2026-08-07）：变体同时需要
 *  影响"产什么兵"（vanguardRatio/accumulateThreshold/spawnReserve）时注册到这里。
 *  与 VARIANT_SAFETY_CONFIG 同 id 配对——"变体启用 = 配置声明"在 deterministic
 *  模式同样成立（tenant-runtime 把两部分都喂给对应构造器）。 */
export interface DeterministicVariantConfig {
  /** VANGUARD 目标占比 [0,1]（缺省 undefined = 交替产兵，历史行为）。 */
  readonly vanguardRatio?: number;
  /** 爆兵阈值：resources 达标前只产 Worker 积累、达标后全力爆兵（0 = 关闭）。 */
  readonly accumulateThreshold?: number;
  /** 补员 reserve（缺省 2 = 生产行为零回归）。 */
  readonly spawnReserve?: number;
}

export const DETERMINISTIC_VARIANT_CONFIG: Readonly<Record<string, DeterministicVariantConfig>> =
  Object.freeze({
    "strike-core-v1": Object.freeze({ vanguardRatio: 0.5, accumulateThreshold: 30 }),
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

/** 解析变体 id → DeterministicPlanner 参数覆盖；未知 id 抛错（fail-fast）。 */
export function resolveDeterministicVariantConfig(id: string): DeterministicVariantConfig {
  const config = DETERMINISTIC_VARIANT_CONFIG[id];
  if (config === undefined) {
    throw new Error(
      `unknown deterministic variant: ${id} (registered: ${Object.keys(DETERMINISTIC_VARIANT_CONFIG).join(", ")})`,
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

/** 解析 config.variants 列表 → 合并的 DeterministicPlanner 参数覆盖（缺省/空 = 零覆盖）。 */
export function resolveDeterministicVariantsConfig(
  ids: readonly string[] | undefined,
): DeterministicVariantConfig {
  if (ids === undefined || ids.length === 0) return {};
  return Object.assign({}, ...ids.map((id) => resolveDeterministicVariantConfig(id)));
}
