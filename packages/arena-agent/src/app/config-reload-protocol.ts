/** Typed IPC contract for atomic runtime strategy reloads. */

export interface ConfigReloadRequest {
  readonly type: "arena.config_reload";
  readonly requestId: string;
  /** Supervisor-preflighted complete config hash. Child must read the same bytes/semantics. */
  readonly expectedConfigHash: string;
}

export interface ConfigReloadResult {
  readonly type: "arena.config_reload_result";
  readonly requestId: string;
  readonly tenantId: string;
  readonly applied: boolean;
  readonly configGeneration: number;
  readonly activeConfigHash: string;
  readonly activeStrategyHash: string;
  readonly errorCode?: "candidate_changed" | "restart_required" | "invalid_config" | "apply_failed";
  readonly error?: string;
  readonly restartRequiredFields?: readonly string[];
}

export interface RuntimeConfigStatus {
  readonly type: "arena.config_status";
  readonly tenantId: string;
  readonly configGeneration: number;
  readonly activeConfigHash: string;
  readonly activeStrategyHash: string;
}

export type TenantRuntimeIpcMessage = ConfigReloadResult | RuntimeConfigStatus;

export function isConfigReloadRequest(value: unknown): value is ConfigReloadRequest {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<ConfigReloadRequest>;
  return message.type === "arena.config_reload"
    && typeof message.requestId === "string"
    && message.requestId.length > 0
    && typeof message.expectedConfigHash === "string"
    && message.expectedConfigHash.length > 0;
}

export function isTenantRuntimeIpcMessage(value: unknown): value is TenantRuntimeIpcMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<TenantRuntimeIpcMessage>;
  if (message.type !== "arena.config_reload_result" && message.type !== "arena.config_status") return false;
  return typeof message.tenantId === "string"
    && Number.isInteger(message.configGeneration)
    && typeof message.activeConfigHash === "string"
    && typeof message.activeStrategyHash === "string";
}
