/**
 * 迁移战术小队组织（migration-system-v1 §5，评审 P1 定稿，纯函数模块）。
 *
 * 四角色机器可执行边界（§5.1）：
 * - SC 探路：前方 15-30 格走廊测绘，never initiate attack，接触即撤，chase 永不开始；
 * - SW 扫路：走廊带内清剿，仅 target ∈ corridor && localForceRatio ≥ X 才接战，
 *   chase 出走廊 → 放弃（交还既有 planner）；
 * - ES 护航：MOVING 期核心 5..8 松散环、NORMAL ≤R 贴身，不占核心路径格，
 *   仅核心受威胁时近距响应；
 * - RG 后卫：尾随核心 ±10 格，接敌顶住等支援。
 *
 * 职责边界：本模块只做编成（§5.2 退化表）与接敌包络的纯函数判定；
 * UUID→角色映射由 runtime 侧以 sticky assignment 完成（评审 P1：
 * conductor 只写 roleQuotas/rolePolicy/seed，不当地高频 roster planner）。
 */

import type { MigrationRoles } from "./plan.ts";

export type SquadRole = "SC" | "SW" | "ES" | "RG";

/** 配额默认值（§7 squadQuota 40/30/15/15；与 plan.ts roles.quotas 字段同名对齐），只作 6+ 分配依据。 */
export const DEFAULT_ROLE_QUOTAS: Readonly<MigrationRoles["quotas"]> = {
  escort: 40,
  sweep: 30,
  scout: 15,
  rear: 15,
};

/** SW 接战兵力比下限（§5.1 的 X）。 */
export const DEFAULT_MIN_FORCE_RATIO = 1.5;
/** ES 松散环内/外界（MOVING 期站位带，§7 escortLooseRingMin/Max）。 */
export const DEFAULT_ESCORT_LOOSE_RING_MIN = 5;
export const DEFAULT_ESCORT_LOOSE_RING_MAX = 8;
/** ES 贴身半径（NORMAL 期，§5.1 的 R）。 */
export const DEFAULT_ESCORT_CLOSE_RADIUS = 4;
/** ES 保护半径：核心受威胁的近距判定（unit→core 上限）。 */
export const DEFAULT_ESCORT_PROTECT_RADIUS = 8;
/** RG 尾随带（核心 ±10 格，§5.1）。 */
export const DEFAULT_REAR_TRAIL_BAND = 10;
/** RG 接敌距离上限（§5.1 尾随带内接战）。 */
export const DEFAULT_REAR_ENGAGE_RADIUS = 10;
/** 走廊宽度默认（§7 corridorWidth）。 */
export const DEFAULT_CORRIDOR_WIDTH = 8;

export interface DegradationResult {
  /** 编成槽位展开（顺序与 §5.2 表格一致；长度 = militaryCount）。 */
  readonly roles: readonly SquadRole[];
  /** 各角色配额数（角色缺失 = 无该角色）。 */
  readonly composition: Readonly<Partial<Record<SquadRole, number>>>;
}

/**
 * §5.2 退化表逐档硬编码展开（顺序与设计表一致）。
 * 6+ 为基础档 [2ES, 2SW, SC, RG]，余量进 ES/SW。
 */
const DEGRADATION_TIERS: readonly (readonly SquadRole[])[] = [
  [],
  ["ES"],
  ["ES", "SC"],
  ["ES", "SC", "SW"],
  ["ES", "ES", "SC", "SW"],
  ["ES", "ES", "SC", "SW", "RG"],
  ["ES", "ES", "SW", "SW", "SC", "RG"],
];

/**
 * 6+ 余量按 ES:SW 配额 40:30 分配（整数最大余数法，ES 占优，全整型无浮点）。
 * 选择理由：配额（§7 squadQuota）只作 6+ 的分配依据，且余量不进 SC/RG
 * （SC 不削、RG 不扩容），确定性可复算。
 */
function splitEscortSweepExtras(extras: number): { escortExtras: number; sweepExtras: number } {
  const escortQuota = DEFAULT_ROLE_QUOTAS.escort;
  const sweepQuota = DEFAULT_ROLE_QUOTAS.sweep;
  const total = escortQuota + sweepQuota;
  const escortExtras = Math.floor((extras * escortQuota) / total);
  const remainder = (extras * escortQuota) % total;
  const escortTakesRemainder = remainder * 2 >= total; // 余数过半归 ES；平局偏配额大的一方
  return {
    escortExtras: escortExtras + (escortTakesRemainder ? 1 : 0),
    sweepExtras: extras - escortExtras - (escortTakesRemainder ? 1 : 0),
  };
}

/**
 * 退化表（§5.2）：按军事单位总数给出编成。1→[ES]；2→[ES,SC]；3→[ES,SC,SW]；
 * 4→[2ES,SC,SW]；5→[2ES,SC,SW,RG]；6+→[2ES,2SW,SC,RG]（余量进 ES/SW）。
 * RG 最先削（4 个单位时无 RG），SC 始终保留；militaryCount ≤ 0 → 空编成。
 */
export function degradationTable(militaryCount: number): DegradationResult {
  const count = Number.isFinite(militaryCount) && militaryCount > 0 ? Math.floor(militaryCount) : 0;
  let roles: readonly SquadRole[];
  if (count <= 6) {
    roles = DEGRADATION_TIERS[count] ?? [];
  } else {
    const { escortExtras, sweepExtras } = splitEscortSweepExtras(count - 6);
    roles = [
      ...Array<SquadRole>(2 + escortExtras).fill("ES"),
      ...Array<SquadRole>(2 + sweepExtras).fill("SW"),
      "SC",
      "RG",
    ];
  }
  const composition: Partial<Record<SquadRole, number>> = {};
  for (const role of roles) {
    composition[role] = (composition[role] ?? 0) + 1;
  }
  return { roles, composition };
}

export interface RosterUnit {
  readonly unitId: string;
  /** 军事等级（Vanguard/Ranger 等编码）；仅作哈希碰撞时的确定性 tiebreak。 */
  readonly militaryRank?: number;
}

/** 稳定哈希（FNV-1a 32 位，全整型）：seed 与 unitId 混合，同输入必同输出。 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 确定性 sticky assignment（评审 P1）：同一 roster 下重复调用结果一致；
 * roster 增删单位时既有单位角色尽量保持。
 *
 * 两遍算法：
 * 1. sticky 遍——按 roster 顺序，凡"上次角色在当前编成中仍有配额"的单位
 *    原样保留（配额递减）；角色被削（如 RG 在 4 档消失）或新兵不保留；
 * 2. 填空遍——剩余单位按 seed 哈希（FNV-1a）稳定排序，按编成槽位顺序填空，
 *    槽位耗尽则多余单位不授衔。
 *
 * 算法选择理由：相比"全部按哈希重排"的全局稳定，两遍法牺牲少量均匀性
 * 换粘性——增删单位时旧角色几乎不动，且全程无随机、可复算（§5.2 评审
 * 明确要求"既有单位角色尽量保持"）。seed 由 conductor 的 roles.seed 下发，
 * 换 seed 只影响空缺槽位的得主顺序。
 *
 * @param previous 上次的角色映射（runtime 侧持有）；缺省时全部单位走填空遍
 *   （退化为纯哈希分配）。纯函数无法"记得"上次角色，故由调用方传入。
 */
export function assignSquadRoles(
  units: readonly RosterUnit[],
  militaryCount: number,
  seed: number,
  previous?: ReadonlyMap<string, SquadRole>,
): Map<string, SquadRole> {
  const { roles } = degradationTable(militaryCount);
  const remaining = new Map<SquadRole, number>();
  for (const role of roles) {
    remaining.set(role, (remaining.get(role) ?? 0) + 1);
  }

  const assigned = new Map<string, SquadRole>();
  const unassigned: RosterUnit[] = [];

  if (previous !== undefined) {
    for (const unit of units) {
      const prevRole = previous.get(unit.unitId);
      const slotLeft = prevRole === undefined ? 0 : (remaining.get(prevRole) ?? 0);
      if (prevRole !== undefined && slotLeft > 0) {
        assigned.set(unit.unitId, prevRole);
        remaining.set(prevRole, slotLeft - 1);
      } else {
        unassigned.push(unit);
      }
    }
  } else {
    unassigned.push(...units);
  }

  const ordered = [...unassigned].sort((a, b) => {
    const hashA = fnv1a32(`${seed}:${a.unitId}`);
    const hashB = fnv1a32(`${seed}:${b.unitId}`);
    if (hashA !== hashB) return hashA - hashB;
    // 32 位哈希碰撞罕见；以 rank 降序、unitId 字典序兜底，保证全序确定性。
    const rankA = a.militaryRank ?? 0;
    const rankB = b.militaryRank ?? 0;
    if (rankA !== rankB) return rankB - rankA;
    return a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0;
  });

  let slotIndex = 0;
  for (const unit of ordered) {
    while (slotIndex < roles.length && (remaining.get(roles[slotIndex]) ?? 0) === 0) {
      slotIndex++;
    }
    if (slotIndex >= roles.length) break;
    const role = roles[slotIndex];
    assigned.set(unit.unitId, role);
    remaining.set(role, (remaining.get(role) ?? 0) - 1);
    slotIndex++;
  }

  return assigned;
}

export interface EngageParams {
  /** 单位到目标距离（格）。 */
  readonly targetDistance: number;
  /** 目标是否处于走廊带内（runtime 已按 corridorWidth 判定）。 */
  readonly targetInCorridor: boolean;
  /** 单位所在局部我方/敌方兵力比（≥1 = 势均力敌）。 */
  readonly localForceRatio: number;
  /** 单位到核心距离（格）。 */
  readonly coreDistance: number;
  /** 是否处于 MOVING 期（核心移动中，ES 走松散环）。 */
  readonly moving: boolean;
  /** 走廊宽度（与 plan.path.corridorWidth 对齐，§7 corridorWidth=8）。 */
  readonly corridorWidth: number;
}

/** 接敌包络可调参数（默认值即 §5.1 硬边界；上层面板可覆写）。 */
export interface EngageOptions {
  readonly minForceRatio?: number;
  readonly escortLooseRingMin?: number;
  readonly escortLooseRingMax?: number;
  readonly escortCloseRadius?: number;
  readonly escortProtectRadius?: number;
  readonly rearTrailBand?: number;
  readonly rearEngageRadius?: number;
}

export type RoleEnvelope =
  | { readonly role: "SC"; readonly engages: false; readonly corridorWidth: number }
  | {
      readonly role: "SW";
      readonly corridorWidth: number;
      readonly minForceRatio: number;
    }
  | {
      readonly role: "ES";
      readonly corridorWidth: number;
      readonly looseRingMin: number;
      readonly looseRingMax: number;
      readonly closeRadius: number;
      readonly protectRadius: number;
    }
  | {
      readonly role: "RG";
      readonly corridorWidth: number;
      readonly trailBand: number;
      readonly engageRadius: number;
    };

/** 返回角色的硬边界常量对象（§5.1 engagementEnvelope），供 overlay/runtime 直接使用。 */
export function engageEnvelope(
  role: "SC",
  corridorWidth: number,
  options?: EngageOptions,
): Extract<RoleEnvelope, { readonly role: "SC" }>;
export function engageEnvelope(
  role: "SW",
  corridorWidth: number,
  options?: EngageOptions,
): Extract<RoleEnvelope, { readonly role: "SW" }>;
export function engageEnvelope(
  role: "ES",
  corridorWidth: number,
  options?: EngageOptions,
): Extract<RoleEnvelope, { readonly role: "ES" }>;
export function engageEnvelope(
  role: "RG",
  corridorWidth: number,
  options?: EngageOptions,
): Extract<RoleEnvelope, { readonly role: "RG" }>;
export function engageEnvelope(
  role: SquadRole,
  corridorWidth: number,
  options: EngageOptions = {},
): RoleEnvelope {
  switch (role) {
    case "SC":
      return { role: "SC", engages: false, corridorWidth };
    case "SW":
      return {
        role: "SW",
        corridorWidth,
        minForceRatio: options.minForceRatio ?? DEFAULT_MIN_FORCE_RATIO,
      };
    case "ES":
      return {
        role: "ES",
        corridorWidth,
        looseRingMin: options.escortLooseRingMin ?? DEFAULT_ESCORT_LOOSE_RING_MIN,
        looseRingMax: options.escortLooseRingMax ?? DEFAULT_ESCORT_LOOSE_RING_MAX,
        closeRadius: options.escortCloseRadius ?? DEFAULT_ESCORT_CLOSE_RADIUS,
        protectRadius: options.escortProtectRadius ?? DEFAULT_ESCORT_PROTECT_RADIUS,
      };
    case "RG":
      return {
        role: "RG",
        corridorWidth,
        trailBand: options.rearTrailBand ?? DEFAULT_REAR_TRAIL_BAND,
        engageRadius: options.rearEngageRadius ?? DEFAULT_REAR_ENGAGE_RADIUS,
      };
  }
}

/**
 * 接敌包络判定（§5.1 机器可执行边界）：
 * - SC：任何参数一律拒绝（never initiate attack，接触即撤）；
 * - SW：`targetInCorridor && localForceRatio >= minForceRatio`（chase 出走廊 → 放弃）；
 * - ES：不主动接战远处目标——仅 unit 在保护半径内且目标在响应半径内
 *   （MOVING 期响应半径 = 松散环外界 8，NORMAL 期 = 贴身半径 4）才放行；
 * - RG：仅尾随带内（targetDistance ≤ engageRadius=10）可接战顶住等支援。
 */
export function canEngage(
  role: SquadRole,
  params: EngageParams,
  options: EngageOptions = {},
): { readonly allow: boolean; readonly reason?: string } {
  switch (role) {
    case "SC":
      return {
        allow: false,
        reason: "探路不接战：SC 只测绘不交火，接触即撤（never initiate attack）",
      };
    case "SW": {
      const envelope = engageEnvelope("SW", params.corridorWidth, options);
      if (!params.targetInCorridor) {
        return { allow: false, reason: "目标已出走廊带（chase 放弃，交还既有 planner）" };
      }
      if (params.localForceRatio < envelope.minForceRatio) {
        return {
          allow: false,
          reason: `兵力比不足（localForceRatio=${params.localForceRatio} < ${envelope.minForceRatio}），扫路不接战`,
        };
      }
      return { allow: true };
    }
    case "ES": {
      const envelope = engageEnvelope("ES", params.corridorWidth, options);
      if (params.coreDistance > envelope.protectRadius) {
        return {
          allow: false,
          reason: `护航离核过远（coreDistance=${params.coreDistance} > ${envelope.protectRadius}），不脱离环位接战`,
        };
      }
      const responseRadius = params.moving ? envelope.looseRingMax : envelope.closeRadius;
      if (params.targetDistance > responseRadius) {
        return {
          allow: false,
          reason: `护航不主动接战远距目标（targetDistance=${params.targetDistance} > ${responseRadius}），仅近距响应`,
        };
      }
      return { allow: true };
    }
    case "RG": {
      const envelope = engageEnvelope("RG", params.corridorWidth, options);
      if (params.targetDistance > envelope.engageRadius) {
        return {
          allow: false,
          reason: `后卫仅尾随带内接战（targetDistance=${params.targetDistance} > ${envelope.engageRadius}），放弃交还既有 planner`,
        };
      }
      return { allow: true };
    }
  }
}
