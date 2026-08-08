/** Adapter from latest per-tenant shadow frames to the pure production policy. */
import { decideAllianceShadowPolicy, type ShadowPolicyDecision } from "../director-policy.ts";
import { aggregateAllianceShadowFrames, type AllianceShadowFrameV1 } from "../shadow-frame.ts";
import type { AllianceSnapshot } from "../types.ts";
import type { AllianceMemberReport } from "../control-types.ts";
import type { AllianceDirectorInterface } from "./supervisor-director.ts";

export interface ShadowPolicyAdapterView {
  readonly revision: number;
  readonly tick: number | null;
  readonly frameTenants: readonly string[];
  readonly frameTicks: Readonly<Record<string, number>>;
  readonly snapshot: null | {
    readonly revision: number;
    readonly tickWindow: readonly [number, number];
    readonly memberCount: number;
    readonly sightingCount: number;
    readonly treasuryTenant: string;
    /** 联盟受控实体 id 并集（no-fire roster；supervisor 写共享文件用）。 */
    readonly allyEntityIds: readonly string[];
  };
  readonly policy: null | {
    readonly treasuryTenant: string;
    readonly missions: ShadowPolicyDecision["missions"];
    readonly taskForces: ShadowPolicyDecision["taskForces"];
    readonly roles: readonly (readonly [string, string])[];
    readonly retreatAssessments: ShadowPolicyDecision["retreatAssessments"];
  };
}

export interface ShadowPolicyAdapter {
  readonly director: AllianceDirectorInterface;
  onFrame(frame: AllianceShadowFrameV1): void;
  /** All expected tenants must have frames and tick skew must be bounded. */
  coherentTick(expectedTenants: readonly string[], maxSkewTicks: number): number | null;
  view(): ShadowPolicyAdapterView;
}

function stableCompare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export function createShadowPolicyAdapter(): ShadowPolicyAdapter {
  const frames = new Map<string, AllianceShadowFrameV1>();
  let revision = 0;
  let latestSnapshot: AllianceSnapshot | null = null;
  let latestDecision: ShadowPolicyDecision | null = null;

  const director: AllianceDirectorInterface = {
    replan(reports: ReadonlyMap<string, AllianceMemberReport>, tick: number) {
      const selected = [...reports.keys()]
        .sort(stableCompare)
        .map((tenantId) => frames.get(tenantId))
        .filter((frame): frame is AllianceShadowFrameV1 => frame !== undefined);
      if (selected.length !== reports.size || selected.length === 0) return [];
      revision += 1;
      const generatedAtMs = Math.max(...selected.map((frame) => frame.observedAtMs));
      latestSnapshot = aggregateAllianceShadowFrames({ revision, frames: selected, nowTick: tick, generatedAtMs });
      latestDecision = decideAllianceShadowPolicy(latestSnapshot);
      return latestDecision.directives;
    },
  };

  return {
    director,
    onFrame(frame): void {
      const current = frames.get(frame.tenantId);
      if (current !== undefined && frame.tick <= current.tick) return;
      frames.set(frame.tenantId, frame);
    },
    coherentTick(expectedTenants, maxSkewTicks): number | null {
      const ticks: number[] = [];
      for (const tenantId of [...expectedTenants].sort(stableCompare)) {
        const frame = frames.get(tenantId);
        if (frame === undefined) return null;
        ticks.push(frame.tick);
      }
      if (ticks.length === 0) return null;
      const min = Math.min(...ticks);
      const max = Math.max(...ticks);
      return max - min <= maxSkewTicks ? max : null;
    },
    view(): ShadowPolicyAdapterView {
      const frameEntries = [...frames.entries()].sort((a, b) => stableCompare(a[0], b[0]));
      return {
        revision,
        tick: latestSnapshot?.tickWindow[1] ?? null,
        frameTenants: frameEntries.map(([tenant]) => tenant),
        frameTicks: Object.fromEntries(frameEntries.map(([tenant, frame]) => [tenant, frame.tick])),
        snapshot: latestSnapshot === null ? null : {
          revision: latestSnapshot.revision,
          tickWindow: latestSnapshot.tickWindow,
          memberCount: latestSnapshot.members.size,
          sightingCount: latestSnapshot.sightings.length,
          treasuryTenant: latestSnapshot.treasuryTenant,
          allyEntityIds: [...latestSnapshot.allyEntityIds].sort(),
        },
        policy: latestDecision === null ? null : {
          treasuryTenant: latestDecision.treasuryTenant,
          missions: latestDecision.missions,
          taskForces: latestDecision.taskForces,
          roles: [...latestDecision.roles.entries()].sort((a, b) => stableCompare(a[0], b[0])),
          retreatAssessments: latestDecision.retreatAssessments,
        },
      };
    },
  };
}
