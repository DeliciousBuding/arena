/**
 * Alliance Episode — sim 层集成与单元测试（Phase 2）。
 *
 * 覆盖：
 * - simultaneous planning：所有 tenant 基于同一 pre-step world/tick
 * - Noop director 与 baseline episode 世界结果等价
 * - Fixed valid directive shadow accepted（不接管动作，world 与 baseline 等价）
 * - stale / wrong-tenant directive 拒绝 → per-tenant fallback 计数
 * - director throw → episode 继续 + KPI errorCount++
 * - period=1 每 tick replan
 * - sighting history per-tenant 不串/不丢 + snapshot 稳定去重
 * - 相同 seed/config 两次整体 deterministic projection 深等（排除 wallMs）
 * - 源码无 Date.now / Math.random
 * - no-fire 静态扫描：SHOOT ally target → allianceSafetyRejectCount++
 *
 * 最后更新：2026-08-08
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { AllianceSnapshot as ContractSnapshot, EntitySighting } from "../../src/alliance/types.ts";
import type { Plan, TickState } from "../../src/domain/model.ts";
import { loadRulesManifest } from "../../src/sim/contracts/rules-manifest.ts";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../../src/sim/harness/episode.ts";
import { worldFromScenario } from "../../src/sim/world/loaders.ts";
import {
  runAllianceEpisode,
  buildMemberReport,
  mergeSightings,
  buildSnapshot,
} from "../../src/sim/alliance/alliance-episode.ts";
import {
  NoopAllianceDirector,
  FixedAllianceDirector,
} from "../../src/sim/alliance/director.ts";
import type {
  AllianceEpisodeConfig,
  AllianceEpisodeResult,
  AllianceDirector,
} from "../../src/sim/alliance/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "..", "src", "sim", "contracts", "rules-v0.14.json");

// ═══════════════════════════════════════════════════════════════
// Scenario fixtures
// ═══════════════════════════════════════════════════════════════

/** 2-tenant 最小对局：p1 [0,0]，p2 [10,0]，互不在视野（core vision=5）。 */
function twoTenantScenario(): unknown {
  return {
    rulesVersion: "v0.14",
    tick: 1,
    seed: 1,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 12,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
      },
      {
        id: "p2",
        username: "p2",
        resources: 12,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [10, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [11, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [[2, 0], [12, 0]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

/** 3-tenant：e1 敌 Core 在 p1 视野内（[1,0] 距 p1 core [0,0] 曼哈顿 1），不在 p2 视野。 */
function threeTenantWithEnemyScenario(): unknown {
  return {
    rulesVersion: "v0.14",
    tick: 1,
    seed: 1,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 12,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 }],
      },
      {
        id: "p2",
        username: "p2",
        resources: 12,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [10, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [11, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
      },
      {
        id: "e1",
        username: "enemy",
        resources: 12,
        core: { id: "66666666-6666-6666-6666-666666666666", position: [1, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [],
      },
    ],
    terrain: { obstacles: [], resources: [[2, 0], [12, 0]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

/**
 * no-fire 场景：p1 worker [8,0] 在 p2 视野内（p2 core [10,0] 距 2 ≤ 5）；
 * p2 带一个 RANGER [9,0]（距 ally worker 曼哈顿 1，合法射击线）。
 */
function noFireScenario(): unknown {
  return {
    rulesVersion: "v0.14",
    tick: 1,
    seed: 1,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 12,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [8, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
      },
      {
        id: "p2",
        username: "p2",
        resources: 12,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [10, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [11, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555502", owner: "p2", position: [9, 0], hp: 2, unitType: "RANGER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[2, 0], [12, 0]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

function tenants(ids: readonly string[]): EpisodeTenant[] {
  return ids.map((id) => ({ id, planner: "deterministic" as const }));
}

function baseEpisodeConfig(overrides: Partial<EpisodeConfig> = {}): EpisodeConfig {
  return {
    scenario: twoTenantScenario(),
    rulesPath: MANIFEST_PATH,
    seed: 42,
    ticks: 40,
    tenants: tenants(["p1", "p2"]),
    ...overrides,
  };
}

function allianceConfig(overrides: Partial<AllianceEpisodeConfig> = {}): AllianceEpisodeConfig {
  return {
    episode: baseEpisodeConfig(),
    allianceTenants: ["p1", "p2"],
    director: new NoopAllianceDirector(),
    directorPeriodTicks: 4,
    ...overrides,
  };
}

/** 排除 EpisodeResult 既有性能字段（wallMs）后的确定性投影。 */
function deterministicProjection(result: AllianceEpisodeResult): unknown {
  const copy = structuredClone(result);
  (copy.episode.metrics as { wallMs: number }).wallMs = 0;
  return copy;
}

const RULES = loadRulesManifest(MANIFEST_PATH);

// ═══════════════════════════════════════════════════════════════
// Simultaneous planning
// ═══════════════════════════════════════════════════════════════

test("simultaneous planning: 所有 tenant 的 plan 基于同一 pre-step tick，settlement 每 tick 一次", () => {
  const result = runAllianceEpisode(allianceConfig({ directorPeriodTicks: 1 }));
  assert.equal(result.episode.records.length, 40, "one settlement per tick");
  for (const record of result.episode.records) {
    const p1Tick = record.plans["p1"]?.tick;
    const p2Tick = record.plans["p2"]?.tick;
    assert.ok(p1Tick !== undefined && p2Tick !== undefined, "both tenants must have plans");
    assert.equal(p1Tick, p2Tick, "plans must be based on the same pre-step tick");
    assert.equal(p1Tick, record.tick, "plan tick must equal the settled tick");
  }
  // trace 与 records 的 tick 对齐
  for (let i = 0; i < result.trace.length; i += 1) {
    assert.equal(result.trace[i].tick, result.episode.records[i].tick);
  }
});

// ═══════════════════════════════════════════════════════════════
// Noop director = baseline
// ═══════════════════════════════════════════════════════════════

test("Noop director: 联盟 episode 与 baseline episode 世界结果等价", () => {
  const baseline = runEpisode(baseEpisodeConfig());
  const alliance = runAllianceEpisode(allianceConfig());
  assert.equal(alliance.episode.finalWorldHash, baseline.finalWorldHash);
  assert.equal(alliance.episode.metrics.illegalPlans, baseline.metrics.illegalPlans);
  // Noop 不产 directive：每 tick 每 tenant no-directive fallback
  assert.equal(alliance.kpi.directiveAccepted, 0);
  assert.equal(alliance.kpi.baselineFallbackCount, 40 * 2);
  for (const entry of alliance.trace) {
    assert.equal(entry.directiveCount, 0);
    assert.ok(entry.evaluations.every((e) => e.planSource === "baseline"));
  }
});

// ═══════════════════════════════════════════════════════════════
// Fixed valid directive: shadow accepted, no takeover
// ═══════════════════════════════════════════════════════════════

test("Fixed directive: accepted 为 shadow（baseline-shadow），不接管动作——world 与 baseline 等价", () => {
  const director = new FixedAllianceDirector({
    roles: new Map([["p1", "TREASURY"], ["p2", "DEFENDER"]]),
  });
  const baseline = runEpisode(baseEpisodeConfig());
  const alliance = runAllianceEpisode(allianceConfig({
    director,
    directorPeriodTicks: 1, // 每 tick 产出新 directive
  }));

  // world 等价：directive 不改变任何 plan
  assert.equal(alliance.episode.finalWorldHash, baseline.finalWorldHash);
  assert.equal(alliance.episode.metrics.illegalPlans, baseline.metrics.illegalPlans);

  // accepted 计数 = 每 tick 每 tenant
  assert.equal(alliance.kpi.directiveAccepted, 40 * 2);
  // accepted shadow 不算 fallback
  assert.equal(alliance.kpi.baselineFallbackCount, 0);
  assert.equal(alliance.kpi.fallbackAvailability, 1);

  // trace 证明：全部 baseline-shadow，无 baseline fallback
  for (const entry of alliance.trace) {
    assert.equal(entry.directiveCount, 2);
    assert.equal(entry.evaluations.length, 2);
    for (const ev of entry.evaluations) {
      assert.equal(ev.consume, true);
      assert.equal(ev.reason, null);
      assert.equal(ev.planSource, "baseline-shadow");
      assert.ok(ev.revision !== null);
    }
  }
});

test("period=1: 每 tick replan（directorRan 全 true，snapshotRevision 单调递增）", () => {
  const director = new FixedAllianceDirector({ roles: new Map([["p1", "TREASURY"]]) });
  const result = runAllianceEpisode(allianceConfig({ director, directorPeriodTicks: 1 }));
  let expectedRevision = 1;
  for (const entry of result.trace) {
    assert.equal(entry.directorRan, true, `tick ${entry.tick} must replan`);
    assert.equal(entry.snapshotRevision, expectedRevision);
    expectedRevision += 1;
  }
});

// ═══════════════════════════════════════════════════════════════
// Stale / wrong-tenant directive → fail-open fallback
// ═══════════════════════════════════════════════════════════════

test("stale directive: 超 stale 窗口后拒绝，per-tenant fallback 计数", () => {
  const director = new FixedAllianceDirector({
    roles: new Map([["p1", "TREASURY"], ["p2", "DEFENDER"]]),
    directiveDurationTicks: 100, // 结构有效、长窗口——只有 stale 会触发
  });
  // period=40：只 tick 1 产一次 directive（issued=1）；DEFAULT_DIRECTIVE_STALE_TICKS=4
  const result = runAllianceEpisode(allianceConfig({
    director,
    directorPeriodTicks: 40,
    episode: baseEpisodeConfig({ ticks: 20 }),
  }));

  // tick 1-5：consume（age 0..4 ≤ 4 不 stale）；tick 6+：stale
  assert.equal(result.kpi.directiveAccepted, 5 * 2);
  assert.ok(result.kpi.directiveStale >= (20 - 6 + 1) * 2, `stale=${result.kpi.directiveStale}`);
  assert.equal(result.kpi.baselineFallbackCount, result.kpi.directiveStale);
  assert.equal(result.kpi.directiveRejected, 0);

  // trace 证明拒绝原因
  const staleEvals = result.trace.flatMap((e) => e.evaluations).filter((ev) => ev.reason === "stale");
  assert.ok(staleEvals.length >= (20 - 6 + 1) * 2);
  assert.ok(staleEvals.every((ev) => ev.planSource === "baseline" && !ev.consume));
});

test("WRONG_TENANT fault: directive 被改写为错误 tenant → invalid reject + fallback", () => {
  const director = new FixedAllianceDirector({ roles: new Map([["p1", "TREASURY"], ["p2", "DEFENDER"]]) });
  const result = runAllianceEpisode(allianceConfig({
    director,
    directorPeriodTicks: 1,
    directorFaults: [{ atTick: 3, fault: "WRONG_TENANT" }],
  }));
  // tick 3 只有 fault 一次：2 tenant 各 1 条 invalid
  assert.equal(result.kpi.directiveRejected, 2);
  assert.ok(result.kpi.baselineFallbackCount >= 2);
  const invalidEvals = result.trace[2].evaluations; // tick 3
  assert.equal(invalidEvals.length, 2);
  for (const ev of invalidEvals) {
    assert.equal(ev.consume, false);
    assert.ok(ev.reason?.includes("invalid"), `reason=${ev.reason}`);
    assert.equal(ev.planSource, "baseline");
  }
});

test("NO_DIRECTIVE fault: 不调用 director，旧 directive 自然 stale → fallback", () => {
  const director = new FixedAllianceDirector({
    roles: new Map([["p1", "TREASURY"], ["p2", "DEFENDER"]]),
    directiveDurationTicks: 100,
  });
  // period=20：tick 1 产出后不再 replan；tick 5 故障 → 保留 tick 1 的 directive
  const result = runAllianceEpisode(allianceConfig({
    director,
    directorPeriodTicks: 20,
    episode: baseEpisodeConfig({ ticks: 12 }),
    directorFaults: [{ atTick: 5, fault: "NO_DIRECTIVE" }],
  }));
  // tick 5 的 trace：directorRan=false
  const entryTick5 = result.trace.find((e) => e.tick === 5);
  assert.ok(entryTick5);
  assert.equal(entryTick5.directorRan, false);
  // tick 6 起旧 directive（issued=1）超过 stale 窗口 4 → stale fallback
  const staleCount = result.kpi.directiveStale;
  assert.ok(staleCount >= 6 * 2, `stale=${staleCount}`); // tick 6..11 共 6 tick × 2 tenant
  assert.equal(result.kpi.baselineFallbackCount, staleCount);
});

test("DISAPPEAR fault: durationTicks 内不产出，恢复后继续，确定性可重复", () => {
  const director = new FixedAllianceDirector({ roles: new Map([["p1", "TREASURY"], ["p2", "DEFENDER"]]) });
  const config = allianceConfig({
    director,
    directorPeriodTicks: 1,
    episode: baseEpisodeConfig({ ticks: 10 }),
    directorFaults: [{ atTick: 4, fault: "DISAPPEAR", durationTicks: 3 }],
  });
  const result = runAllianceEpisode(config);
  // tick 4,5,6：directorRan=false
  for (const tick of [4, 5, 6]) {
    const entry = result.trace.find((e) => e.tick === tick);
    assert.ok(entry, `trace for tick ${tick} must exist`);
    assert.equal(entry.directorRan, false);
  }
  // tick 7 恢复
  const entry7 = result.trace.find((e) => e.tick === 7);
  assert.equal(entry7?.directorRan, true);
  // 确定性可重复
  const again = runAllianceEpisode(config);
  assert.deepEqual(deterministicProjection(again), deterministicProjection(result));
});

// ═══════════════════════════════════════════════════════════════
// Director throws → fail-open
// ═══════════════════════════════════════════════════════════════

class ThrowingDirector implements AllianceDirector {
  readonly kind = "throwing";
  decide(_snapshot: ContractSnapshot, _rng: () => number): { directives: never[] } {
    throw new Error("director exploded");
  }
}

test("director throw: episode 继续，KPI directorErrorCount++，可重复", () => {
  const config = allianceConfig({
    director: new ThrowingDirector(),
    directorPeriodTicks: 2,
  });
  const result = runAllianceEpisode(config);
  assert.equal(result.episode.metrics.ticks, 40, "episode must complete");
  assert.equal(result.kpi.directorErrorCount, 20, "one error per replan (every 2 ticks)");
  const errorEntries = result.trace.filter((e) => e.directorError !== null);
  assert.equal(errorEntries.length, 20);
  assert.ok(errorEntries.every((e) => e.directorError === "director exploded"));
  // 没有 directive → 全部 fallback
  assert.equal(result.kpi.directiveAccepted, 0);
  assert.equal(result.kpi.baselineFallbackCount, 40 * 2);
  // 确定性可重复
  const again = runAllianceEpisode(config);
  assert.deepEqual(deterministicProjection(again), deterministicProjection(result));
});

// ═══════════════════════════════════════════════════════════════
// Sighting per-tenant carry-forward + snapshot dedupe
// ═══════════════════════════════════════════════════════════════

test("sighting: per-tenant 历史不串——e1 只被 p1 目击，p2 视野为空", () => {
  const world = worldFromScenario(threeTenantWithEnemyScenario());
  const p1 = buildMemberReport(world, "p1", RULES);
  const p2 = buildMemberReport(world, "p2", RULES);

  // p1 视野内有 e1 core（曼哈顿 1 ≤ core vision 5）
  const p1Sightings = [...p1.currentSightings.values()];
  assert.ok(p1Sightings.some((s) => s.key === "core:66666666-6666-6666-6666-666666666666"));
  assert.equal(p1.report.localThreat, p1Sightings.length, "localThreat = 本 tenant 可见目击数");

  // p2 视野内无 e1（曼哈顿 9 > 5）
  assert.equal(p2.currentSightings.size, 0);
  assert.equal(p2.report.localThreat, 0);
});

test("sighting: carry-forward 不丢历史——不可见后仍保留（confidence 衰减，currentlyVisible=false）", () => {
  const world = worldFromScenario(threeTenantWithEnemyScenario());
  const p1tick1 = buildMemberReport(world, "p1", RULES);

  // tick 1 目击 → tick 2 无新目击（carry-forward）
  const merged1 = mergeSightings(new Map(), p1tick1.currentSightings, 1);
  const merged2 = mergeSightings(merged1, new Map(), 2);
  const e1 = [...merged2.values()].find((s) => s.key === "core:66666666-6666-6666-6666-666666666666");
  assert.ok(e1, "history must be carried forward");
  assert.equal(e1!.currentlyVisible, false);
  assert.equal(e1!.firstSeenTick, 1, "firstSeen preserved");
  assert.equal(e1!.lastSeenTick, 1, "lastSeen not advanced");
  assert.ok(e1!.confidence < 1.0, "confidence must decay");
});

test("sighting: snapshot 跨 tenant union 稳定去重（同 key 取最新 lastSeenTick）+ ally 集合不泄漏敌方", () => {
  const world = worldFromScenario(threeTenantWithEnemyScenario());
  const p1 = buildMemberReport(world, "p1", RULES);

  // p1 在 tick 5 目击（最新），p2 无目击；currentSightings 的 lastSeenTick 是
  // world tick（=1），手动推进到 5 模拟 tick 5 的目击
  const p1Map: ReadonlyMap<string, EntitySighting> = new Map(
    [...p1.currentSightings].map(([key, s]) => [key, { ...s, lastSeenTick: 5 }]),
  );
  const perTenant = new Map<string, ReadonlyMap<string, EntitySighting>>([
    ["p1", p1Map],
    ["p2", new Map()],
  ]);
  const snapshot = buildSnapshot(
    [p1.report],
    perTenant,
    world,
    ["p1", "p2"],
    "p1",
    1,
    5,
  );

  const e1 = snapshot.sightings.find((s) => s.key === "core:66666666-6666-6666-6666-666666666666");
  assert.ok(e1, "e1 sighting must be in snapshot");
  assert.equal(e1!.lastSeenTick, 5);
  assert.equal(e1!.sourceTenant, "p1");

  // allyEntityIds 只含联盟成员实体（不含敌方 e1）
  assert.ok(snapshot.allyEntityIds.has("11111111-1111-1111-1111-111111111111"));
  assert.ok(snapshot.allyEntityIds.has("22222222-2222-2222-2222-222222222201"));
  assert.ok(snapshot.allyEntityIds.has("44444444-4444-4444-4444-444444444444"));
  assert.ok(!snapshot.allyEntityIds.has("66666666-6666-6666-6666-666666666666"), "no enemy leak");
});

// ═══════════════════════════════════════════════════════════════
// Deterministic replay
// ═══════════════════════════════════════════════════════════════

test("deterministic: 相同 seed/config/scenario 两次整体投影深等", () => {
  const config = allianceConfig({
    director: new FixedAllianceDirector({ roles: new Map([["p1", "TREASURY"], ["p2", "DEFENDER"]]) }),
    directorPeriodTicks: 4,
  });
  const a = runAllianceEpisode(config);
  const b = runAllianceEpisode(config);
  assert.deepEqual(deterministicProjection(b), deterministicProjection(a));
  assert.deepEqual(b.replayFootprint, a.replayFootprint);
});

test("deterministic: allianceTenants 传入顺序不影响结果（configHash canonical）", () => {
  const a = runAllianceEpisode(allianceConfig({
    allianceTenants: ["p1", "p2"],
    director: new FixedAllianceDirector({ roles: new Map([["p1", "TREASURY"]]) }),
    directorPeriodTicks: 4,
  }));
  const b = runAllianceEpisode(allianceConfig({
    allianceTenants: ["p2", "p1"],
    director: new FixedAllianceDirector({ roles: new Map([["p1", "TREASURY"]]) }),
    directorPeriodTicks: 4,
  }));
  assert.deepEqual(deterministicProjection(b), deterministicProjection(a));
  assert.equal(b.replayFootprint.configHash, a.replayFootprint.configHash);
});

// ═══════════════════════════════════════════════════════════════
// No wall-clock in semantics
// ═══════════════════════════════════════════════════════════════

test("语义无 wall-clock: src/sim/alliance 无 Date.now / Math.random / performance.now 调用", () => {
  const dir = join(here, "..", "..", "src", "sim", "alliance");
  for (const file of readdirSync(dir)) {
    const text = readFileSync(join(dir, file), "utf8");
    // 检查实际调用形式（注释文字中的关键词不算）
    assert.ok(!text.includes("Date.now()"), `${file} must not call Date.now()`);
    assert.ok(!text.includes("Math.random()"), `${file} must not call Math.random()`);
    assert.ok(!text.includes("performance.now()"), `${file} must not call performance.now()`);
  }
});

// ═══════════════════════════════════════════════════════════════
// No-fire static scan
// ═══════════════════════════════════════════════════════════════

test("no-fire: SHOOT ally target 被静态扫描计数（allianceSafetyRejectCount）", () => {
  // p2 的 RANGER 对 p1 的 worker（[8,0]，在 p2 视野内）注入一次 SHOOT
  const allyWorkerId = "22222222-2222-2222-2222-222222222201";
  const p2RangerId = "55555555-5555-5555-5555-555555555502";
  let injected = false;
  const result = runAllianceEpisode(allianceConfig({
    director: new FixedAllianceDirector({ roles: new Map([["p1", "TREASURY"], ["p2", "DEFENDER"]]) }),
    directorPeriodTicks: 1,
    episode: baseEpisodeConfig({
      scenario: noFireScenario(),
      ticks: 5,
      manualOverrideProvider: (tenantId: string, _tick: number, _state: TickState, proposed: Plan): Plan | null => {
        if (tenantId === "p2" && !injected) {
          injected = true;
          return {
            ...proposed,
            unitActions: {
              ...proposed.unitActions,
              [p2RangerId]: { type: "SHOOT", targetId: allyWorkerId, expectedCell: [8, 0] as const },
            },
          };
        }
        return null;
      },
    }),
  }));
  assert.equal(injected, true, "manual override must fire");
  assert.ok(result.kpi.allianceSafetyRejectCount >= 1, "ally-target SHOOT must be counted");
  assert.equal(result.kpi.friendlyFireMetricSupported, true);
});

// ═══════════════════════════════════════════════════════════════
// Config validation
// ═══════════════════════════════════════════════════════════════

test("config 验证: 重复/越界/非法 period fail fast", () => {
  assert.throws(() => runAllianceEpisode(allianceConfig({ allianceTenants: ["p1", "p1"] })), /duplicates/);
  assert.throws(() => runAllianceEpisode(allianceConfig({ allianceTenants: ["p1", "ghost"] })), /not in episode/);
  assert.throws(() => runAllianceEpisode(allianceConfig({ allianceTenants: [] })), /non-empty/);
  assert.throws(() => runAllianceEpisode(allianceConfig({ treasuryTenant: "ghost" })), /must be an alliance tenant/);
  assert.throws(() => runAllianceEpisode(allianceConfig({ directorPeriodTicks: 0 })), /positive integer/);
  assert.throws(() => runAllianceEpisode(allianceConfig({ directorPeriodTicks: -3 })), /positive integer/);
});
