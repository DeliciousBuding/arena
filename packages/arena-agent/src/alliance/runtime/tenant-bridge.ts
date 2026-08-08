/** Tenant-side Alliance IPC bridge. Control-plane only: no planner/action imports. */
import type { AllianceShadowFrameV1 } from "../shadow-frame.ts";
import { createDirectiveInbox, type DirectiveInbox } from "./directive-inbox.ts";
import {
  createAckMessage,
  createFrameMessage,
  isAllianceDirectiveMessage,
  type AllianceIpcMessage,
} from "./ipc.ts";

export interface TenantAllianceIpcBridge {
  /** First frame binds tenant identity; subsequent mismatched frames are ignored. */
  onFrame(frame: AllianceShadowFrameV1): void;
  /** Only directive messages are consumed; all unrelated process IPC is ignored. */
  onMessage(message: unknown): void;
  readonly tenantId: string | null;
  readonly lastRevision: number;
}

export function createTenantAllianceIpcBridge(
  send: (message: AllianceIpcMessage) => void,
): TenantAllianceIpcBridge {
  let tenantId: string | null = null;
  let inbox: DirectiveInbox | null = null;

  function safeSend(message: AllianceIpcMessage): void {
    try { send(message); } catch {}
  }

  return {
    onFrame(frame): void {
      if (tenantId === null) {
        tenantId = frame.tenantId;
        inbox = createDirectiveInbox(frame.tenantId);
      }
      if (frame.tenantId !== tenantId) return;
      safeSend(createFrameMessage(frame));
    },

    onMessage(message): void {
      if (!isAllianceDirectiveMessage(message) || tenantId === null || inbox === null) return;
      if (message.tenantId !== tenantId) {
        safeSend(createAckMessage(tenantId, message.tick, message.revision, "rejected", "transport tenant mismatch"));
        return;
      }
      const result = inbox.accept(message.directive, message.tick);
      if (result.accepted) {
        // "accepted" = stored in ASSIST inbox only. It never means an Arena action executed.
        safeSend(createAckMessage(tenantId, message.tick, message.revision, "accepted", "assist directive stored; no action ownership"));
        return;
      }
      const reason = result.reason;
      const rejected = reason.includes("tenant mismatch") || reason.includes("invalid");
      safeSend(createAckMessage(tenantId, message.tick, message.revision, rejected ? "rejected" : "ignored", reason));
    },

    get tenantId(): string | null { return tenantId; },
    get lastRevision(): number { return inbox?.lastRevision ?? -1; },
  };
}
