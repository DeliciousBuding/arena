/**
 * 核心移动中守卫（2026-08-08，人机协同）：手操目标是本租户核心且核心正在移动 →
 * 立即拒绝并给明确原因（否则 agent 端静默拒绝——t3 404 次 "Core is already
 * moving" 实证）。纯函数 + 快照读取分离：server.ts 只调 loadCoreMovingGuard。
 * 只读快照，不写库；命中由调用方落 rejected 审计。
 */
import { loadAllianceSnapshot, type AllianceSnapshotPayload } from "./alliance-snapshot.ts";

export interface CoreGuardResult {
  blocked: boolean;
  coreId: string | null;
}

/** 纯函数（可测）：给定租户成员核心 + 目标单位 id → 是否应拦截。 */
export function evaluateCoreMovingGuard(
  core: { id?: unknown; moving?: unknown } | null | undefined,
  unitId: string,
): CoreGuardResult {
  if (!core || !core.id) return { blocked: false, coreId: null };
  const coreId = String(core.id);
  if (unitId !== coreId) return { blocked: false, coreId };
  if (core.moving === true) return { blocked: true, coreId };
  return { blocked: false, coreId };
}

/** 读取快照（30s 缓存）并评估。快照不可用不阻断。 */
export function loadCoreMovingGuard(tenant: string, unitId: string): CoreGuardResult {
  try {
    const snap = loadAllianceSnapshot() as AllianceSnapshotPayload;
    const member = snap.members?.[tenant];
    return evaluateCoreMovingGuard(member?.core, unitId);
  } catch {
    return { blocked: false, coreId: null };
  }
}
