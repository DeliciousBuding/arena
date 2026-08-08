/** Adapter from latest per-tenant shadow frames to the pure production policy.
 * Strategic profile changes are queued and applied only at the next Director replan boundary. */
import { decideAllianceShadowPolicy, type ShadowPolicyDecision } from "../director-policy.ts";
import { aggregateAllianceShadowFrames, type AllianceShadowFrameV1 } from "../shadow-frame.ts";
import {
  STRATEGIC_REGISTRY,
  StrategicPolicySelector,
  type StrategicPolicyProfile,
  type StrategicPolicySelection,
} from "../strategic-policy.ts";
import type { AllianceSnapshot } from "../types.ts";
import type { AllianceMemberReport } from "../control-types.ts";
import type { AllianceDirectorInterface } from "./supervisor-director.ts";

export interface StrategicPolicyRuntimeView {
  readonly profiles: readonly {
    readonly name: string;
    readonly version: number;
    readonly contentHash: string;
    readonly description: string;
  }[];
  readonly active: {
    readonly name: string;
    readonly version: number;
    readonly contentHash: string;
    readonly selectionRevision: number;
    readonly selectedAtTick: number | null;
  };
  readonly pending: null | { readonly action: "select"; readonly profile: string } | { readonly action: "rollback" };
  readonly lastGood: null | { readonly name: string; readonly version: number; readonly contentHash: string };
}

export interface StrategicPolicyControlResult {
  readonly accepted: boolean;
  readonly error?: string;
  readonly strategy: StrategicPolicyRuntimeView;
}

export interface ShadowPolicyAdapterView {
  readonly revision: number;
  readonly tick: number | null;
  readonly frameTenants: readonly string[];
  readonly frameTicks: Readonly<Record<string, number>>;
  readonly strategy: StrategicPolicyRuntimeView;
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

export interface ShadowPolicyAdapterOptions {
  /** Initial profile is queued and still applies only at the first replan boundary. */
  readonly initialProfile?: string;
}

export interface ShadowPolicyAdapter {
  readonly director: AllianceDirectorInterface;
  onFrame(frame: AllianceShadowFrameV1): void;
  /** All expected tenants must have frames and tick skew must be bounded. */
  coherentTick(expectedTenants: readonly string[], maxSkewTicks: number): number | null;
  requestProfile(name: string): StrategicPolicyControlResult;
  requestRollback(): StrategicPolicyControlResult;
  markLastGood(): StrategicPolicyControlResult;
  view(): ShadowPolicyAdapterView;
}

function stableCompare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function profileRef(profile: StrategicPolicyProfile): { name: string; version: number; contentHash: string } {
  return { name: profile.name, version: profile.version, contentHash: profile.contentHash };
}

export function createShadowPolicyAdapter(options: ShadowPolicyAdapterOptions = {}): ShadowPolicyAdapter {
  const frames = new Map<string, AllianceShadowFrameV1>();
  const selector = new StrategicPolicySelector(STRATEGIC_REGISTRY);
  let pending: null | { action: "select"; profile: string } | { action: "rollback" } = null;
  let revision = 0;
  let latestSnapshot: AllianceSnapshot | null = null;
  let latestDecision: ShadowPolicyDecision | null = null;

  if (options.initialProfile !== undefined) {
    if (STRATEGIC_REGISTRY.get(options.initialProfile) === undefined) {
      throw new Error(`unknown Alliance strategic profile: ${options.initialProfile}`);
    }
    pending = { action: "select", profile: options.initialProfile };
  }

  function strategyView(): StrategicPolicyRuntimeView {
    const latest: StrategicPolicySelection | null = selector.latest;
    const active = selector.current;
    const lastGood = selector.lastGoodProfile;
    return {
      profiles: STRATEGIC_REGISTRY.list().map((profile) => ({
        name: profile.name,
        version: profile.version,
        contentHash: profile.contentHash,
        description: profile.description,
      })),
      active: {
        ...profileRef(active),
        selectionRevision: latest?.revision ?? 0,
        selectedAtTick: latest?.selectedAtTick ?? null,
      },
      pending: pending === null ? null : { ...pending },
      lastGood: lastGood === null ? null : profileRef(lastGood),
    };
  }

  function applyPendingAtReplan(tick: number): StrategicPolicyProfile {
    if (selector.latest === null) {
      if (pending?.action === "select") selector.select(tick, pending.profile);
      else if (pending?.action === "rollback") selector.rollback(tick);
      else selector.select(tick);
      pending = null;
      return selector.current;
    }
    if (pending?.action === "select") selector.select(tick, pending.profile);
    else if (pending?.action === "rollback") selector.rollback(tick);
    pending = null;
    return selector.current;
  }

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
      const profile = applyPendingAtReplan(tick);
      latestDecision = decideAllianceShadowPolicy(latestSnapshot, {}, profile);
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
    requestProfile(name): StrategicPolicyControlResult {
      if (STRATEGIC_REGISTRY.get(name) === undefined) {
        return { accepted: false, error: `unknown profile: ${name}`, strategy: strategyView() };
      }
      pending = { action: "select", profile: name };
      return { accepted: true, strategy: strategyView() };
    },
    requestRollback(): StrategicPolicyControlResult {
      pending = { action: "rollback" };
      return { accepted: true, strategy: strategyView() };
    },
    markLastGood(): StrategicPolicyControlResult {
      selector.markLastGood();
      return { accepted: true, strategy: strategyView() };
    },
    view(): ShadowPolicyAdapterView {
      const frameEntries = [...frames.entries()].sort((a, b) => stableCompare(a[0], b[0]));
      return {
        revision,
        tick: latestSnapshot?.tickWindow[1] ?? null,
        frameTenants: frameEntries.map(([tenant]) => tenant),
        frameTicks: Object.fromEntries(frameEntries.map(([tenant, frame]) => [tenant, frame.tick])),
        strategy: strategyView(),
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