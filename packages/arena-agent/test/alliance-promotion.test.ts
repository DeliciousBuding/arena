import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAllianceShadowPromotion } from "../src/sim/alliance/promotion.ts";
import type { AllianceEpisodeResult } from "../src/sim/alliance/types.ts";
import type { EpisodeResult } from "../src/sim/harness/episode.ts";

function baseline(hash = "world-a"): EpisodeResult {
  return { records: [{ tick: 1 }] as unknown as EpisodeResult["records"], finalWorldHash: hash, metrics: { illegalPlans: 0 } as EpisodeResult["metrics"] } as EpisodeResult;
}
function candidate(o: { hash?: string; friendlyFire?: number; expired?: number; errors?: number; fallback?: number; kinds?: readonly any[]; retreats?: number; source?: "baseline" | "baseline-shadow" } = {}): AllianceEpisodeResult {
  return {
    episode: baseline(o.hash ?? "world-a"),
    kpi: { friendlyFireMetricSupported: true, allianceSafetyRejectCount: o.friendlyFire ?? 0, expiredDirectiveConsumed: o.expired ?? 0, directorErrorCount: o.errors ?? 0, fallbackAvailability: o.fallback ?? 1 } as AllianceEpisodeResult["kpi"],
    trace: [{ tick: 1, snapshotRevision: 1, directorRan: true, directiveCount: 1, missionCount: 1, missionKinds: o.kinds ?? ["RETREAT"], retreatRecommendationCount: o.retreats ?? 1, directorError: null, evaluations: [{ tenantId: "t2", revision: 1, consume: true, reason: null, planSource: o.source ?? "baseline-shadow" }] }],
    replayFootprint: { seed: 1, rulesVersion: "v0.14", directorKind: "shadow-policy-v1", configHash: "abc" },
  } as AllianceEpisodeResult;
}

test("promotion: 全门禁 + RETREAT 证据 → SHADOW_READY，且无 LIVE stage", () => {
  const base = baseline();
  const result = evaluateAllianceShadowPromotion({ baseline: base, candidate: candidate(), deterministicReplayMatch: true, requiredMissionKinds: ["RETREAT"], requireRetreatRecommendation: true, faultEvidence: [{ name: "wrong-tenant", baseline: base, candidate: candidate({ source: "baseline" }) }] });
  assert.equal(result.decision, "SHADOW_READY");
  assert.equal(result.maxAuthorizedStage, "SHADOW_READY");
  assert.equal(result.gates.every((item) => item.pass), true);
  assert.doesNotMatch(JSON.stringify(result), /LIVE_READY|LIVE_ENABLED/);
});

test("promotion: world hash 改变是硬拒绝", () => {
  const result = evaluateAllianceShadowPromotion({ baseline: baseline(), candidate: candidate({ hash: "mutated" }), deterministicReplayMatch: true });
  assert.equal(result.decision, "REJECT");
  assert.equal(result.gates.find((item) => item.name === "baseline_world_equivalence")?.pass, false);
});

test("promotion: friendly fire / expired directive 任一非零 → REJECT", () => {
  for (const bad of [candidate({ friendlyFire: 1 }), candidate({ expired: 1 })]) {
    assert.equal(evaluateAllianceShadowPromotion({ baseline: baseline(), candidate: bad, deterministicReplayMatch: true }).decision, "REJECT");
  }
});

test("promotion: fault run 不 fail-open → REJECT", () => {
  const base = baseline();
  const result = evaluateAllianceShadowPromotion({ baseline: base, candidate: candidate(), deterministicReplayMatch: true, faultEvidence: [{ name: "throw", baseline: base, candidate: candidate({ hash: "mutated" }) }] });
  assert.equal(result.decision, "REJECT");
  assert.match(result.reasons.join("\n"), /fault_injection_fail_open/);
});

test("promotion: 缺场景 Mission 证据 → HOLD", () => {
  const result = evaluateAllianceShadowPromotion({ baseline: baseline(), candidate: candidate({ kinds: ["SCOUT"], retreats: 0 }), deterministicReplayMatch: true, requiredMissionKinds: ["RETREAT"], requireRetreatRecommendation: true });
  assert.equal(result.decision, "HOLD");
  assert.ok(result.gates.some((item) => item.severity === "EVIDENCE" && !item.pass));
});

test("promotion: deterministic replay 缺失 → REJECT", () => {
  assert.equal(evaluateAllianceShadowPromotion({ baseline: baseline(), candidate: candidate(), deterministicReplayMatch: false }).decision, "REJECT");
});

