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
    /**
     * 远端军事回援（2026-08-07，竞品 "敌方战斗单位已经进入 Core 防区时，
     * 所有非守家单位跳过集结等待并立即回援" 对照）：可见敌方战斗单位进入
     * Core 防区（12）→ 远端 Vanguard/Ranger 立即回 Core 守位（优先于攻坚/
     * 打野/环搜），守家圈内单位走既有防御逻辑。与 threat-recall-v1 配套：
     * 一个管 worker 收缩守家圈，一个管远端军事回援。
     */
    "reinforce-home-v1": Object.freeze({ remoteReinforce: true }),
    /**
     * 信标夺取（2026-08-07，官方 Champion Beacon 机制对齐）：近距离
     * （Chebyshev ≤80）信标由最近 Vanguard 拾取并带回守家——持标核心盾
     * 上限 5→10 + worker 采集 1→2（双倍经济）。远距放弃（信标坐标公开，
     * 可能被敌方埋伏）。与 threat-recall/reinforce-home 同属防御经济层。
     */
    "beacon-grab-v1": Object.freeze({ beaconGrab: true, beaconGrabMaxDist: 80 }),
    "move-failed-avoidance-v1": Object.freeze({ moveFailedAvoidance: true }),
    /**
     * 威胁自适应防守（2026-08-07，排行榜威胁画像接入）：攻坚目标 owner 命中
     * 官方排行榜高伤害玩家（ELITE_AGGRESSOR=damage top10 / AGGRESSOR=top30）
     * 时"留强"——成型门槛 +2/+4（叠加 attackForce）+ 守家预留 1→2 Vanguard。
     * 高伤害玩家 = 猛攻蛆（用户裁决），进攻同时防偷家/反打。无画像/降级 =
     * 零回归。配套 external 数据源：docs/progress/leaderboard-intel.py 拉取
     * data/leaderboard/ 快照，运行时只读本地文件不联网。
     */
    "threat-adaptive-defense-v1": Object.freeze({ threatAdaptiveDefense: true }),
    /**
     * 严格占优攻坚（2026-08-07，guide v3.0 overmatch 对照）：按目标敌 Core
     * 实测守军（World.enemyCoreForces，Vanguard+Ranger 按 ID 去重）动态抬高
     * 攻坚成型门槛 = max(基础/威胁自适应, 守军估计+1)——存活兵力严格大于守军
     * 估计才压上；守军增援门槛同步抬高、兵力不足自动蓄势（vanguard_hold）。
     * 与 threat-adaptive-defense-v1 叠加：排行榜画像给先验，实测守军给实时。
     */
    "assault-overmatch-v1": Object.freeze({ assaultOvermatch: true }),
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
      // 攻坚搜索补强（2026-08-07）：16 方位密集搜索（覆盖 off-diagonal 敌 Core
      // 几何盲区——8 方位最近 Manhattan 7 > 视野 4）+ 同环 20 tick 时间预算强制
      // 升环（破"争格/振荡永不外扩"）+ 敌 Core 记忆窗口 1200（发现即长时前压）。
      militarySearchDense: true,
      militaryRingHoldTicks: 20,
      enemyCoreMemoryTicks: 1200,
      // 敌情狩猎（2026-08-07，持久敌情测绘）：无可见敌人/资源时优先回访最后
      // 已知敌基地（CORE 目击 sticky + Worker 轨迹推断）并清扫，替代 home 盲搜
      // ——t1 生产实证：敌 Core 迁移后军队在旧位置空转、环搜几何近失永不接敌。
      militaryHunt: true,
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

/** 解析变体 id → DeterministicPlanner 参数覆盖。变体 id 的合法性统一由
 *  resolveSafetyVariantConfig 负责（所有生产变体都注册在安全侧）；这里对
 *  没有 deterministic 部分（如 move-failed-avoidance-v1）的变体返回 {} =
 *  零覆盖，不抛错（"无 deterministic 声明 = 不影响 core 生产"是正确语义）。 */
export function resolveDeterministicVariantConfig(id: string): DeterministicVariantConfig {
  return DETERMINISTIC_VARIANT_CONFIG[id] ?? {};
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

