/**
 * 迁移计划（migration-plan-v1，2026-08-08 设计 migration-system-v1）。
 *
 * 契约（评审 P0-2/P0-3/P0-4 定稿）：
 * - conductor 唯一 writer：只写本计划文件（原子替换），永不写 human-commands；
 * - runtime 只读：每 tick 必须满足 leaseFresh && epoch 匹配 && coreId 匹配
 *   才执行迁移订单，否则 fail-closed（只允许 NORMAL/WAIT）；
 * - 计划带 core 代际：CORE_DESTROYED/重生/currentCoreId ≠ originCoreId →
 *   RECOVERY_ABORT，禁止从旧 legProgress 续迁。
 */

import type { MigrationPhase } from "./state-machine.ts";

export interface MigrationPosition {
  readonly x: number;
  readonly y: number;
}

export interface MigrationAuditResult {
  readonly ok: boolean;
  readonly freshResources: number;
  readonly activeEnemyCores: number;
}

export interface MigrationLeg {
  readonly index: number;
  readonly from: MigrationPosition;
  readonly to: MigrationPosition;
  readonly audit: MigrationAuditResult;
}

export interface MigrationPace {
  readonly policy: "adaptive" | "time-based" | "harvest-driven";
  readonly burstCells: number;
  readonly settleTarget: number;
  readonly minSettle: number;
  readonly maxSettle: number;
  readonly harvestRadius: number;
}

export interface MigrationRoles {
  readonly quotas: { escort: number; sweep: number; scout: number; rear: number };
  readonly seed: number;
}

export interface MigrationCoreIdentity {
  /** 迁移发起时的核心 id（CORE_DESTROYED/重生后必然变化）。 */
  readonly originCoreId: string | null;
  readonly currentCoreId: string | null;
  /** 核心代际：每次核心 id 变化 +1（conductor 侧维护）。 */
  readonly generation: number;
}

export interface MigrationLease {
  /** 生效截止 tick（游戏 tick；runtime 用 currentTick 判定）。 */
  readonly untilTick: number;
  /** conductor 心跳（ISO 时间）；runtime 用墙钟判定新鲜度。 */
  readonly heartbeatAt: string;
}

export interface MigrationPlanV1 {
  readonly schema: "migration-plan-v1";
  readonly operationId: string;
  /** 每次 PLAN 重审 +1；runtime 只认当前 revision。 */
  readonly revision: number;
  /** conductor 接管代：stale takeover 后 +1，旧 conductor 订单失效。 */
  readonly conductorEpoch: number;
  readonly tenant: string;
  readonly mode: "migrate" | "receive";
  readonly state: MigrationPhase;
  readonly core: MigrationCoreIdentity;
  readonly lease: MigrationLease;
  readonly target: MigrationPosition & { readonly reason: string };
  readonly path: {
    readonly cells: readonly (readonly [number, number])[];
    readonly corridorWidth: number;
    readonly lookahead: number;
  };
  readonly legs: readonly MigrationLeg[];
  readonly legProgress: { readonly legIndex: number; readonly cellsThisLeg: number };
  readonly pace: MigrationPace;
  readonly roles: MigrationRoles;
  readonly conductor: { readonly pid: number };
  readonly updatedAt: string;
  /**
   * M6（migration-assist-v1 §5）：发下一个 START_MOVE 前需清空的格
   * （destination 及其邻格，≤3）。缺失 = 旧行为（不清路）。
   */
  readonly clearRequests?: readonly { readonly x: number; readonly y: number; readonly reason?: string }[];
  /** M6：清路前瞻格数 + 触发原因（遥测）。缺失 = 旧行为。 */
  readonly assist?: {
    readonly clearAheadCells: number;
    readonly clearAheadReason: "initial" | "blocked-retry" | "replan";
  };
  /**
   * M8（migration-survival-v1 §4）：战损编成缺口请求（SETTLE 期检测）。
   * 缺口持续 ≥ minGapTicks 才写入；缺口恢复 → 字段清除。缺失 = 无缺口。
   */
  readonly replenish?: {
    readonly gap: number;
    /** 缺口角色（退化表在 militaryCount+1 与 militaryCount 间新增的槽位）。 */
    readonly missingRole: "SC" | "SW" | "ES" | "RG";
    readonly sinceTick: number;
  };
}

export type MigrationPlanParseResult =
  | { readonly ok: true; readonly plan: MigrationPlanV1 }
  | { readonly ok: false; readonly reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isPosition = (v: unknown): v is MigrationPosition =>
  isRecord(v) && typeof v.x === "number" && typeof v.y === "number";

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 严格校验（fail-closed）：字段缺失/类型错/枚举错一律拒绝，不部分采纳。 */
export function parseMigrationPlan(raw: unknown): MigrationPlanParseResult {
  if (!isRecord(raw)) return { ok: false, reason: "计划不是对象" };
  if (raw.schema !== "migration-plan-v1") return { ok: false, reason: `schema 不识别: ${String(raw.schema)}` };
  if (typeof raw.operationId !== "string" || raw.operationId.length === 0)
    return { ok: false, reason: "operationId 缺失" };
  if (!isNumber(raw.revision) || raw.revision < 1) return { ok: false, reason: "revision 非法" };
  if (!isNumber(raw.conductorEpoch) || raw.conductorEpoch < 0)
    return { ok: false, reason: "conductorEpoch 非法" };
  if (typeof raw.tenant !== "string" || raw.tenant.length === 0)
    return { ok: false, reason: "tenant 缺失" };
  if (raw.mode !== "migrate" && raw.mode !== "receive")
    return { ok: false, reason: `mode 非法: ${String(raw.mode)}` };
  if (typeof raw.state !== "string") return { ok: false, reason: "state 缺失" };
  if (!isRecord(raw.core)) return { ok: false, reason: "core 段缺失" };
  if (raw.core.originCoreId !== null && typeof raw.core.originCoreId !== "string")
    return { ok: false, reason: "originCoreId 非法" };
  if (raw.core.currentCoreId !== null && typeof raw.core.currentCoreId !== "string")
    return { ok: false, reason: "currentCoreId 非法" };
  if (!isNumber(raw.core.generation) || raw.core.generation < 0)
    return { ok: false, reason: "core.generation 非法" };
  if (!isRecord(raw.lease)) return { ok: false, reason: "lease 段缺失" };
  if (!isNumber(raw.lease.untilTick)) return { ok: false, reason: "lease.untilTick 非法" };
  if (typeof raw.lease.heartbeatAt !== "string" || Number.isNaN(Date.parse(raw.lease.heartbeatAt)))
    return { ok: false, reason: "lease.heartbeatAt 非法" };
  if (!isRecord(raw.target) || !isPosition(raw.target) || typeof raw.target.reason !== "string")
    return { ok: false, reason: "target 段非法" };
  if (!isRecord(raw.path) || !Array.isArray(raw.path.cells))
    return { ok: false, reason: "path 段非法" };
  for (const cell of raw.path.cells) {
    if (!Array.isArray(cell) || !isNumber(cell[0]) || !isNumber(cell[1]))
      return { ok: false, reason: "path.cells 含非法格" };
  }
  if (!isNumber(raw.path.corridorWidth) || raw.path.corridorWidth < 0)
    return { ok: false, reason: "path.corridorWidth 非法" };
  if (!isNumber(raw.path.lookahead) || raw.path.lookahead < 0)
    return { ok: false, reason: "path.lookahead 非法" };
  if (!Array.isArray(raw.legs)) return { ok: false, reason: "legs 缺失" };
  for (const leg of raw.legs) {
    if (!isRecord(leg) || !isNumber(leg.index) || !isPosition(leg.from) || !isPosition(leg.to) || !isRecord(leg.audit))
      return { ok: false, reason: "legs 含非法段" };
    if (typeof leg.audit.ok !== "boolean" || !isNumber(leg.audit.freshResources) || !isNumber(leg.audit.activeEnemyCores))
      return { ok: false, reason: "legs 审计结果非法" };
  }
  if (!isRecord(raw.legProgress) || !isNumber(raw.legProgress.legIndex) || !isNumber(raw.legProgress.cellsThisLeg))
    return { ok: false, reason: "legProgress 非法" };
  if (!isRecord(raw.pace)) return { ok: false, reason: "pace 段缺失" };
  if (
    raw.pace.policy !== "adaptive" &&
    raw.pace.policy !== "time-based" &&
    raw.pace.policy !== "harvest-driven"
  )
    return { ok: false, reason: `pace.policy 非法: ${String(raw.pace.policy)}` };
  if (
    !isNumber(raw.pace.burstCells) || raw.pace.burstCells < 1 ||
    !isNumber(raw.pace.settleTarget) || raw.pace.settleTarget < 0 ||
    !isNumber(raw.pace.minSettle) || raw.pace.minSettle < 0 ||
    !isNumber(raw.pace.maxSettle) || raw.pace.maxSettle < 0 ||
    !isNumber(raw.pace.harvestRadius) || raw.pace.harvestRadius < 0
  )
    return { ok: false, reason: "pace 参数非法" };
  if (!isRecord(raw.roles) || !isRecord(raw.roles.quotas) || !isNumber(raw.roles.seed))
    return { ok: false, reason: "roles 段非法" };
  for (const key of ["escort", "sweep", "scout", "rear"] as const) {
    if (!isNumber(raw.roles.quotas[key]) || raw.roles.quotas[key] < 0)
      return { ok: false, reason: `roles.quotas.${key} 非法` };
  }
  if (!isRecord(raw.conductor) || !isNumber(raw.conductor.pid))
    return { ok: false, reason: "conductor 段非法" };
  if (typeof raw.updatedAt !== "string" || Number.isNaN(Date.parse(raw.updatedAt)))
    return { ok: false, reason: "updatedAt 非法" };

  // M6 可选字段（migration-assist-v1 §5）：缺失 = 旧行为；存在则严格校验。
  if (raw.clearRequests !== undefined) {
    if (!Array.isArray(raw.clearRequests) || raw.clearRequests.length > 3)
      return { ok: false, reason: "clearRequests 非法（最多 3 格）" };
    for (const request of raw.clearRequests) {
      if (!isRecord(request) || !isPosition(request))
        return { ok: false, reason: "clearRequests 含非法项" };
      if (request.reason !== undefined && typeof request.reason !== "string")
        return { ok: false, reason: "clearRequests.reason 非法" };
    }
  }
  if (raw.assist !== undefined) {
    if (
      !isRecord(raw.assist) ||
      !isNumber(raw.assist.clearAheadCells) || raw.assist.clearAheadCells < 1 ||
      (raw.assist.clearAheadReason !== "initial" &&
        raw.assist.clearAheadReason !== "blocked-retry" &&
        raw.assist.clearAheadReason !== "replan")
    )
      return { ok: false, reason: "assist 段非法" };
  }

  // M8 可选字段（migration-survival-v1 §4）：缺失 = 无缺口；存在则严格校验。
  if (raw.replenish !== undefined) {
    if (
      !isRecord(raw.replenish) ||
      !isNumber(raw.replenish.gap) || raw.replenish.gap < 1 ||
      !isNumber(raw.replenish.sinceTick) ||
      (raw.replenish.missingRole !== "SC" &&
        raw.replenish.missingRole !== "SW" &&
        raw.replenish.missingRole !== "ES" &&
        raw.replenish.missingRole !== "RG")
    )
      return { ok: false, reason: "replenish 段非法" };
  }

  return { ok: true, plan: raw as unknown as MigrationPlanV1 };
}
