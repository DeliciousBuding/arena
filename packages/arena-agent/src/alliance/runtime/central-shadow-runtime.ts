/** Supervisor-side central Alliance shadow control loop. Tokenless and ASSIST-only. */
import type { Serializable } from "node:child_process";
import { isAllianceAckMessage, isAllianceFrameMessage, isAllianceMemberMessage } from "./ipc.ts";
import {
  createShadowPolicyAdapter,
  type StrategicPolicyControlResult,
} from "./shadow-policy-adapter.ts";
import { createSupervisorAllianceDirectorRuntime } from "./supervisor-director.ts";

export interface CentralAllianceShadowOptions {
  readonly enabled: boolean;
  readonly expectedTenants: readonly string[];
  readonly periodTicks?: number;
  readonly maxSkewTicks?: number;
  /** Optional initial strategic profile; validated at construction, applied on first replan. */
  readonly initialStrategicProfile?: string;
  readonly send: (tenantId: string, message: Serializable) => boolean;
}

export interface CentralAllianceShadowView {
  readonly enabled: boolean;
  readonly available: true;
  readonly mode: "ASSIST_ONLY";
  readonly actionOwnership: "none";
  readonly periodTicks: number;
  readonly maxSkewTicks: number;
  readonly expectedTenants: readonly string[];
  readonly runtime: ReturnType<import("./supervisor-director.ts").SupervisorAllianceDirectorRuntime["stats"]>;
  readonly revision: number;
  readonly tick: number | null;
  readonly frameTenants: readonly string[];
  readonly frameTicks: Readonly<Record<string, number>>;
  readonly strategy: ReturnType<import("./shadow-policy-adapter.ts").ShadowPolicyAdapter["view"]>["strategy"];
  readonly snapshot: ReturnType<import("./shadow-policy-adapter.ts").ShadowPolicyAdapter["view"]>["snapshot"];
  readonly policy: ReturnType<import("./shadow-policy-adapter.ts").ShadowPolicyAdapter["view"]>["policy"];
}

export interface CentralAllianceShadowRuntime {
  onChildMessage(transportTenantId: string, message: unknown): void;
  /** Queue a registered StrategicProfile. It becomes active only on the next coherent replan. */
  requestStrategicProfile(name: string): StrategicPolicyControlResult;
  /** Queue rollback to last-good/default. It becomes active only on the next coherent replan. */
  requestStrategicRollback(): StrategicPolicyControlResult;
  /** Mark the currently active profile as last-good; no action/directive is emitted. */
  markStrategicLastGood(): StrategicPolicyControlResult;
  view(): CentralAllianceShadowView;
}

export function createCentralAllianceShadowRuntime(options: CentralAllianceShadowOptions): CentralAllianceShadowRuntime {
  const periodTicks = Math.max(1, Math.floor(options.periodTicks ?? 4));
  const maxSkewTicks = Math.max(0, Math.floor(options.maxSkewTicks ?? 4));
  const expectedTenants = [...new Set(options.expectedTenants)].sort();
  const adapter = createShadowPolicyAdapter({ initialProfile: options.initialStrategicProfile });
  let lastTriggeredTick: number | null = null;

  const runtime = createSupervisorAllianceDirectorRuntime(adapter.director, {
    send(tenantId, message): void {
      if (!options.send(tenantId, message as unknown as Serializable)) {
        throw new Error(`tenant child unavailable: ${tenantId}`);
      }
    },
  }, { enabled: options.enabled });

  function maybeReplan(): void {
    if (!runtime.enabled) return;
    const tick = adapter.coherentTick(expectedTenants, maxSkewTicks);
    if (tick === null) return;
    if (lastTriggeredTick !== null && tick - lastTriggeredTick < periodTicks) return;
    runtime.replan(tick);
    lastTriggeredTick = tick;
  }

  return {
    onChildMessage(transportTenantId, message): void {
      if (isAllianceFrameMessage(message)) {
        if (message.tenantId !== transportTenantId) return;
        adapter.onFrame(message.frame);
        runtime.onMemberReport(message.frame.member);
        maybeReplan();
        return;
      }
      if (isAllianceMemberMessage(message)) {
        if (message.tenantId !== transportTenantId) return;
        runtime.onMemberReport(message.report);
        return;
      }
      if (isAllianceAckMessage(message)) {
        if (message.tenantId !== transportTenantId) return;
        runtime.onAck(message.tenantId, message.revision, message.status, message.tick, message.reason);
      }
    },
    requestStrategicProfile(name): StrategicPolicyControlResult {
      return adapter.requestProfile(name);
    },
    requestStrategicRollback(): StrategicPolicyControlResult {
      return adapter.requestRollback();
    },
    markStrategicLastGood(): StrategicPolicyControlResult {
      return adapter.markLastGood();
    },
    view() {
      const policy = adapter.view();
      return {
        enabled: runtime.enabled,
        available: true as const,
        mode: "ASSIST_ONLY" as const,
        actionOwnership: "none" as const,
        periodTicks,
        maxSkewTicks,
        expectedTenants,
        runtime: runtime.stats(),
        revision: policy.revision,
        tick: policy.tick,
        frameTenants: policy.frameTenants,
        frameTicks: policy.frameTicks,
        strategy: policy.strategy,
        snapshot: policy.snapshot,
        policy: policy.policy,
      };
    },
  };
}