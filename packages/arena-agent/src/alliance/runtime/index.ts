/**
 * Alliance Director — Runtime shadow primitives barrel export（Phase 3a）。
 *
 * 约束：
 * - 不含 Arena credentials or action-writer capabilities——合同层不能成为 writer；
 * - default-disabled：enabled=false 时 0 sends / 0 director calls；
 * - fail-open：director crash → 记录 stats，不抛到 supervisor 生命周期。
 *
 * 最后更新：2026-08-08
 */

// IPC
export type {
  AllianceIpcMessage,
  AllianceMemberMessage,
  AllianceDirectiveMessage,
  AllianceAckMessage,
  AllianceAckStatus,
} from "./ipc.ts";
export {
  ALLIANCE_IPC_SCHEMA_VERSION,
  isAllianceIpcMessage,
  isAllianceMemberMessage,
  isAllianceDirectiveMessage,
  isAllianceAckMessage,
  createMemberMessage,
  createDirectiveMessage,
  createAckMessage,
} from "./ipc.ts";

// DirectiveInbox
export type { DirectiveInbox, DirectiveAcceptResult } from "./directive-inbox.ts";
export { createDirectiveInbox } from "./directive-inbox.ts";

// SupervisorAllianceDirectorRuntime
export type {
  AckState,
  DirectiveAckRecord,
  AllianceDirectorStats,
  AllianceDirectorCallbacks,
  AllianceDirectorInterface,
  SupervisorAllianceDirectorOptions,
  SupervisorAllianceDirectorRuntime,
} from "./supervisor-director.ts";
export { createSupervisorAllianceDirectorRuntime } from "./supervisor-director.ts";

// Central shadow control plane
export type {
  CentralAllianceShadowOptions,
  CentralAllianceShadowRuntime,
  CentralAllianceShadowView,
} from "./central-shadow-runtime.ts";
export { createCentralAllianceShadowRuntime } from "./central-shadow-runtime.ts";

export type {
  ShadowPolicyAdapter,
  ShadowPolicyAdapterOptions,
  ShadowPolicyAdapterView,
  StrategicPolicyControlResult,
  StrategicPolicyRuntimeView,
} from "./shadow-policy-adapter.ts";
export { createShadowPolicyAdapter } from "./shadow-policy-adapter.ts";

export type { TenantAllianceIpcBridge } from "./tenant-bridge.ts";
export { createTenantAllianceIpcBridge } from "./tenant-bridge.ts";
