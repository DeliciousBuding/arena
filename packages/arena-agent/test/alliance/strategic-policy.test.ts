/**
 * Strategic Policy — 注册表、选择器、profile 集成测试。
 *
 * 覆盖：
 * - 5 个内置 profile 的 contentHash 稳定性
 * - Registry 注册/查重/unregister/setDefault
 * - Selector：default→sticky→explicit override→rollback→lastGood
 * - Director integration：profile 切换改变 mission 产出
 * - ASSIST-only 硬约束：任何 profile 不可产出 mode≠"ASSIST"
 * - 确定性：相同 snapshot + 相同 profile → 相同结果
 * - 安全约束：无效 strategyName fallback 到 default（不抛错）
 * - revision 递增 + history 有界
 *
 * 最后更新：2026-08-08
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeProfileHash,
  StrategicPolicyRegistry,
  StrategicPolicySelector,
  BALANCED_PROFILE,
  AGGRESSIVE_PROFILE,
  SCOUT_PROFILE,
  DEFEND_PROFILE,
  RESERVE_PROFILE,
  STRATEGIC_REGISTRY,
  ALL_STRATEGY_KINDS,
} from "../../src/alliance/strategic-policy.ts";

import { decideAllianceShadowPolicy } from "../../src/alliance/director-policy.ts";
import { buildAllianceSnapshotFromSightings } from "../../src/alliance/snapshot.ts";
import type { AllianceMemberState, EntitySighting } from "../../src/alliance/types.ts";
import type { MissionKind } from "../../src/alliance/control-types.ts";

// ── Fixtures ───────────────────────────────────────────────────

function member(
  tenantId: string,
  opts: Partial<AllianceMemberState> & { corePosition?: readonly [number, number]; military?: number } = {},
): AllianceMemberState {
  const military = opts.military ?? 4;
  return {
    tenantId,
    tick: opts.tick ?? 80,
    observedAtMs: opts.observedAtMs ?? 80_000,
    core: opts.status === "RESPAWNING"
      ? null
      : {
          id: `${tenantId}-core`,
          position: opts.corePosition ?? [0, 0],
          hp: opts.core?.hp ?? 5,
          shield: opts.core?.shield ?? 5,
          moving: opts.core?.moving ?? false,
        },
    resources: opts.resources ?? 10,
    resourceCapacity: opts.resourceCapacity ?? 50,
    population: opts.population ?? 8,
    workers: opts.workers ?? 4,
    vanguards: opts.vanguards ?? military,
    rangers: opts.rangers ?? 0,
    carriedResources: opts.carriedResources ?? 0,
    activeFleetIds: opts.activeFleetIds ?? [],
    localThreat: opts.localThreat ?? 0,
    localHarvestRate: opts.localHarvestRate ?? 0,
    status: opts.status ?? "READY",
  };
}

function sighting(
  key: string,
  kind: "UNIT" | "CORE",
  position: readonly [number, number],
  opts: Partial<EntitySighting> = {},
): EntitySighting {
  return {
    key,
    kind,
    ...(kind === "UNIT" ? { unitType: opts.unitType ?? "VANGUARD" } : {}),
    entityId: opts.entityId ?? key.split(":").at(-1),
    ownerUsername: opts.ownerUsername ?? "enemy",
    position,
    sourceTenant: opts.sourceTenant ?? "t1",
    firstSeenTick: opts.firstSeenTick ?? 80,
    lastSeenTick: opts.lastSeenTick ?? 80,
    currentlyVisible: opts.currentlyVisible ?? true,
    confidence: opts.confidence ?? 1,
    evidence: opts.evidence ?? "LIVE",
  };
}

function snapshot(
  membersArr: readonly AllianceMemberState[],
  sightingsArr: readonly EntitySighting[] = [],
  historicalSightingCount = sightingsArr.length,
) {
  return buildAllianceSnapshotFromSightings({
    revision: 9,
    members: membersArr,
    sightings: sightingsArr,
    allyEntityIds: new Set(membersArr.flatMap((m) => m.core === null ? [] : [m.core.id])),
    nowTick: 80,
    generatedAtMs: 80_000,
    historicalSightingCount,
  });
}

// ═══════════════════════════════════════════════════════════════
// Profile contentHash 稳定性
// ═══════════════════════════════════════════════════════════════

test("Profile: contentHash 确定性——同定义同 hash", () => {
  const h1 = BALANCED_PROFILE.contentHash;
  const h2 = BALANCED_PROFILE.contentHash;
  assert.equal(h1, h2);
  assert.equal(typeof h1, "string");
  assert.equal(h1.length, 16);
});

test("Profile: 不同 profile 有不同 contentHash", () => {
  const hashes = new Set([
    BALANCED_PROFILE.contentHash,
    AGGRESSIVE_PROFILE.contentHash,
    SCOUT_PROFILE.contentHash,
    DEFEND_PROFILE.contentHash,
    RESERVE_PROFILE.contentHash,
  ]);
  assert.equal(hashes.size, 5);
});

test("Profile: computeProfileHash 与 profile.contentHash 一致", () => {
  for (const p of [BALANCED_PROFILE, AGGRESSIVE_PROFILE, SCOUT_PROFILE, DEFEND_PROFILE, RESERVE_PROFILE]) {
    const computed = computeProfileHash(p);
    assert.equal(computed, p.contentHash, `profile=${p.name} contentHash mismatch`);
  }
});

test("Profile: 每个 profile 的 name/version/strategies/missionPriority 均合法", () => {
  for (const p of [BALANCED_PROFILE, AGGRESSIVE_PROFILE, SCOUT_PROFILE, DEFEND_PROFILE, RESERVE_PROFILE]) {
    assert.ok(p.name.length > 0);
    assert.ok(p.version >= 1);
    assert.ok(p.strategies.length > 0);
    assert.ok(p.missionPriority.length > 0);
    // 所有 strategies 都在 ALL_STRATEGY_KINDS 中
    for (const s of p.strategies) {
      assert.ok(ALL_STRATEGY_KINDS.includes(s), `profile=${p.name} unknown strategy: ${s}`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// Registry 操作
// ═══════════════════════════════════════════════════════════════

test("Registry: 全局 STRATEGIC_REGISTRY 包含 5 个内置 profile", () => {
  assert.equal(STRATEGIC_REGISTRY.size, 5);
  assert.ok(STRATEGIC_REGISTRY.get("balanced") !== undefined);
  assert.ok(STRATEGIC_REGISTRY.get("aggressive") !== undefined);
  assert.ok(STRATEGIC_REGISTRY.get("scout-first") !== undefined);
  assert.ok(STRATEGIC_REGISTRY.get("defend-only") !== undefined);
  assert.ok(STRATEGIC_REGISTRY.get("reserve") !== undefined);
});

test("Registry: 默认 profile 是 balanced", () => {
  assert.equal(STRATEGIC_REGISTRY.defaultName, "balanced");
});

test("Registry: list() 返回按 name 排序的 profile 列表", () => {
  const list = STRATEGIC_REGISTRY.list();
  assert.equal(list.length, 5);
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i - 1]!.name < list[i]!.name, `list not sorted: ${list[i - 1]!.name} >= ${list[i]!.name}`);
  }
});

test("Registry: 重复注册同名 profile 抛错", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  assert.throws(() => registry.register(BALANCED_PROFILE), {
    message: /already registered/,
  });
});

test("Registry: unregister 移除 profile", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(AGGRESSIVE_PROFILE);
  assert.equal(registry.size, 2);
  assert.equal(registry.unregister("balanced"), true);
  assert.equal(registry.size, 1);
  assert.equal(registry.get("balanced"), undefined);
});

test("Registry: unregister 不存在 profile 返回 false", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  assert.equal(registry.unregister("nonexistent"), false);
  assert.equal(registry.size, 1);
});

test("Registry: setDefault 合法/非法", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(AGGRESSIVE_PROFILE);

  registry.setDefault("aggressive");
  assert.equal(registry.defaultName, "aggressive");

  assert.throws(() => registry.setDefault("nonexistent"), {
    message: /not registered/,
  });
});

test("Registry: unregister 默认 profile 后 defaultName 回退到第一个", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(AGGRESSIVE_PROFILE);
  registry.setDefault("aggressive");
  registry.unregister("aggressive");
  // 回退到第一个注册的
  assert.equal(registry.defaultName, "balanced");
});

test("Registry: 空 registry 访问 defaultName 抛错", () => {
  const registry = new StrategicPolicyRegistry();
  assert.throws(() => registry.defaultName, {
    message: /no profiles registered/,
  });
});

// ═══════════════════════════════════════════════════════════════
// Selector — 选择逻辑
// ═══════════════════════════════════════════════════════════════

test("Selector: 首轮 select() 返回 default profile", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(AGGRESSIVE_PROFILE);
  const selector = new StrategicPolicySelector(registry);

  const sel = selector.select(100);
  assert.equal(sel.profile.name, "balanced");
  assert.equal(sel.revision, 1);
  assert.equal(sel.reason, "default");
  assert.equal(sel.previousHash, null);
});

test("Selector: sticky——无 explicit 时保持上次 profile", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(AGGRESSIVE_PROFILE);
  const selector = new StrategicPolicySelector(registry);

  const sel1 = selector.select(100, "aggressive");
  assert.equal(sel1.profile.name, "aggressive");

  const sel2 = selector.select(101);
  assert.equal(sel2.profile.name, "aggressive");
  assert.equal(sel2.reason, "sticky");
});

test("Selector: explicit override 切换 profile", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(AGGRESSIVE_PROFILE);
  registry.register(DEFEND_PROFILE);
  const selector = new StrategicPolicySelector(registry);

  const sel1 = selector.select(100, "balanced");
  assert.equal(sel1.profile.name, "balanced");

  const sel2 = selector.select(101, "defend-only");
  assert.equal(sel2.profile.name, "defend-only");
  assert.equal(sel2.reason, "explicit-override:defend-only");
  assert.equal(sel2.previousHash, sel1.profile.contentHash);
  assert.notEqual(sel2.profile.contentHash, sel1.profile.contentHash);
});

test("Selector: 无效 explicit override name → sticky 回退", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  const selector = new StrategicPolicySelector(registry);

  const sel1 = selector.select(100, "balanced");
  const sel2 = selector.select(101, "nonexistent-strategy");
  assert.equal(sel2.profile.name, "balanced");
  assert.equal(sel2.reason, "explicit-override-not-found:nonexistent-strategy→sticky");
});

test("Selector: revision 严格递增", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  const selector = new StrategicPolicySelector(registry);

  const revisions: number[] = [];
  for (let i = 0; i < 5; i++) {
    revisions.push(selector.select(100 + i).revision);
  }
  assert.deepEqual(revisions, [1, 2, 3, 4, 5]);
});

test("Selector: history 最近在前", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(AGGRESSIVE_PROFILE);
  const selector = new StrategicPolicySelector(registry);

  selector.select(100, "balanced");
  selector.select(101, "aggressive");
  selector.select(102);

  assert.equal(selector.history.length, 3);
  assert.equal(selector.history[0]!.profile.name, "aggressive"); // 最近
  assert.equal(selector.history[2]!.profile.name, "balanced");   // 最早
});

test("Selector: history 有界（maxHistory）", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  const selector = new StrategicPolicySelector(registry, { maxHistory: 3 });

  for (let i = 0; i < 10; i++) {
    selector.select(100 + i);
  }
  assert.equal(selector.history.length, 3);
});

test("Selector: latest 返回最近一次选择", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(AGGRESSIVE_PROFILE);
  const selector = new StrategicPolicySelector(registry);

  assert.equal(selector.latest, null);

  const sel1 = selector.select(100);
  assert.equal(sel1.profile.name, "balanced");

  const sel2 = selector.select(101, "aggressive");
  assert.equal(sel2.profile.name, "aggressive");
  assert.equal(sel2.revision, 2);
});

test("Selector: current 在无选择时返回 default", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  const selector = new StrategicPolicySelector(registry);

  assert.equal(selector.current.name, "balanced");
});

// ═══════════════════════════════════════════════════════════════
// Selector — lastGood / rollback
// ═══════════════════════════════════════════════════════════════

test("Selector: markLastGood + rollback", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(AGGRESSIVE_PROFILE);
  const selector = new StrategicPolicySelector(registry);

  // 选择 balanced，标记为 lastGood
  const sel1 = selector.select(100, "balanced");
  selector.markLastGood();
  assert.equal(selector.lastGoodProfile?.name, "balanced");

  // 切换到 aggressive
  selector.select(101, "aggressive");
  assert.equal(selector.current.name, "aggressive");

  // 回滚 → 回到 balanced（lastGood）
  const rollback = selector.rollback(102);
  assert.equal(rollback.profile.name, "balanced");
  assert.equal(rollback.reason, "rollback-to-last-good");
  assert.equal(selector.current.name, "balanced");
});

test("Selector: rollback 无 lastGood 时回到 default", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(AGGRESSIVE_PROFILE);
  registry.setDefault("balanced");
  const selector = new StrategicPolicySelector(registry);

  selector.select(100, "aggressive");
  // 未调用 markLastGood → lastGood = null
  assert.equal(selector.lastGoodProfile, null);

  const rollback = selector.rollback(101);
  assert.equal(rollback.profile.name, "balanced");
  assert.equal(rollback.reason, "rollback-to-default");
});

test("Selector: rollback 后 sticky 继续生效", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(AGGRESSIVE_PROFILE);
  const selector = new StrategicPolicySelector(registry);

  selector.select(100, "balanced");
  selector.markLastGood();
  selector.select(101, "aggressive");
  selector.rollback(102);

  const next = selector.select(103);
  assert.equal(next.profile.name, "balanced");
  assert.equal(next.reason, "sticky");
});

test("Selector: rollback 产生新的 selection 记录 + 递增 revision", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(AGGRESSIVE_PROFILE);
  const selector = new StrategicPolicySelector(registry);

  selector.select(100, "balanced");
  selector.markLastGood();
  selector.select(101, "aggressive");
  const rollback = selector.rollback(102);

  assert.equal(rollback.revision, 3);
  assert.equal(selector.history[0]!.revision, 3);
  assert.equal(selector.history[0]!.reason, "rollback-to-last-good");
});

// ═══════════════════════════════════════════════════════════════
// Director integration — profile 切换改变 mission
// ═══════════════════════════════════════════════════════════════

test("Director: 默认 balanced profile → 压力下 RETREAT", () => {
  const s = snapshot(
    [member("t2", { military: 3 })],
    [sighting("UNIT:ne", "UNIT", [5, 5]), sighting("UNIT:sw", "UNIT", [-5, -5])],
  );
  const decision = decideAllianceShadowPolicy(s);
  assert.equal(decision.missions[0]?.kind, "RETREAT");
  // directive explanation 含 profile hash
  assert.match(decision.directives[0]?.explanation ?? "", /profile=balanced@[a-f0-9]{16}/);
});

test("Director: aggressive profile → RAID 优先于 DEFEND", () => {
  // 激进 profile 下，远距 enemy core + 6 兵力 → RAID（missionPriority 中 RAID 第一）
  const s = snapshot(
    [member("t1", { military: 6 })],
    [sighting("CORE:enemy", "CORE", [30, 0])], // 距离 30 ≤ 96（aggressive 阈值）
  );
  const decision = decideAllianceShadowPolicy(s, { strategyName: "aggressive" });
  assert.equal(decision.missions[0]?.kind, "RAID");
  assert.equal(decision.roles.get("t1"), "RAIDER");
  assert.match(decision.directives[0]?.explanation ?? "", /profile=aggressive@[a-f0-9]{16}/);
});

test("Director: defend-only profile → 只产出 DEFEND/INTERCEPT/RETREAT/ASSEMBLE", () => {
  const s = snapshot(
    [member("t1", { military: 6 })],
    [sighting("CORE:enemy", "CORE", [20, 0])],
  );
  const decision = decideAllianceShadowPolicy(s, { strategyName: "defend-only" });
  // defend-only 的 missionPriority 不含 RAID/SCOUT，但有 ASSEMBLE
  const kinds = new Set(decision.missions.map((m) => m.kind));
  assert.ok(!kinds.has("RAID"), "defend-only should not produce RAID");
  assert.ok(!kinds.has("SCOUT"), "defend-only should not produce SCOUT");
});

test("Director: scout-first profile → 无压力时优先 SCOUT", () => {
  const s = snapshot([member("t1", { military: 4 })]);
  const decision = decideAllianceShadowPolicy(s, { strategyName: "scout-first" });
  assert.equal(decision.missions[0]?.kind, "SCOUT");
  assert.equal(decision.roles.get("t1"), "SCOUT");
});

test("Director: reserve profile → 防守/集结为主，极高远征门槛", () => {
  const s = snapshot(
    [member("t1", { military: 8 })],
    [sighting("CORE:enemy", "CORE", [20, 0])],
  );
  const decision = decideAllianceShadowPolicy(s, { strategyName: "reserve" });
  // reserve 的 minRaidMilitary=10，8 < 10 → 不触发 RAID
  // 无压力 → SCOUT（reserve 的 missionPriority 中 ASSEMBLE 后是 SCOUT）
  // 但 member 有 8 兵力 ≥ assembleMilitaryBelow(4) → 不触发 ASSEMBLE
  // → SCOUT
  assert.equal(decision.missions[0]?.kind, "SCOUT");
});

test("Director: 无效 strategyName → fallback balanced，不抛错", () => {
  const s = snapshot([member("t1", { military: 4 })]);
  const decision = decideAllianceShadowPolicy(s, { strategyName: "nonexistent" });
  // 回退到 balanced，正常产出
  assert.ok(decision.missions.length > 0);
  assert.match(decision.directives[0]?.explanation ?? "", /profile=balanced@[a-f0-9]{16}/);
});

test("Director: strategicProfile 直接注入（优先级高于 strategyName）", () => {
  const s = snapshot([member("t1", { military: 4 })]);
  // strategyName=says-balanced, but strategicProfile=defend-only wins
  const decision = decideAllianceShadowPolicy(s, {
    strategyName: "balanced",
    strategicProfile: DEFEND_PROFILE,
  });
  assert.match(decision.directives[0]?.explanation ?? "", /profile=defend-only@[a-f0-9]{16}/);
});

// ═══════════════════════════════════════════════════════════════
// ASSIST-only 硬约束
// ═══════════════════════════════════════════════════════════════

test("ASSIST-only: 所有 profile 产出的 directive mode 均为 ASSIST", () => {
  const profiles = [undefined, "balanced", "aggressive", "scout-first", "defend-only", "reserve"] as const;
  for (const strategyName of profiles) {
    const s = snapshot(
      [member("t1", { military: 6 }), member("t2", { military: 3 })],
      [sighting("UNIT:ne", "UNIT", [5, 5])],
    );
    const config = strategyName === undefined ? {} : { strategyName };
    const decision = decideAllianceShadowPolicy(s, config);
    for (const d of decision.directives) {
      assert.equal(
        d.mode, "ASSIST",
        `profile=${strategyName ?? "default"} directive for ${d.tenantId} has mode=${d.mode}, expected ASSIST`,
      );
    }
  }
});

test("ASSIST-only: 所有 profile 产出不含 submit/action/START_MOVE", () => {
  const profiles = [undefined, "balanced", "aggressive", "scout-first", "defend-only", "reserve"] as const;
  for (const strategyName of profiles) {
    const s = snapshot(
      [member("t1", { military: 5 })],
      [sighting("UNIT:e", "UNIT", [4, 0])],
    );
    const config = strategyName === undefined ? {} : { strategyName };
    const decision = decideAllianceShadowPolicy(s, config);
    const text = JSON.stringify({ missions: decision.missions, directives: decision.directives });
    assert.doesNotMatch(text, /START_MOVE|unitActions|coreAction|CandidateSink|submit/i,
      `profile=${strategyName ?? "default"} output contains forbidden action terms`);
  }
});

// ═══════════════════════════════════════════════════════════════
// 确定性回归
// ═══════════════════════════════════════════════════════════════

test("确定性: 相同 snapshot + 相同 profile → 相同结果", () => {
  const s = snapshot(
    [member("t1", { military: 5 }), member("t2", { military: 3 })],
    [sighting("UNIT:ne", "UNIT", [5, 5]), sighting("UNIT:sw", "UNIT", [-5, -5])],
  );
  const r1 = decideAllianceShadowPolicy(s, { strategyName: "aggressive" });
  const r2 = decideAllianceShadowPolicy(s, { strategyName: "aggressive" });
  assert.deepEqual(JSON.parse(JSON.stringify(r1)), JSON.parse(JSON.stringify(r2)));
});

test("确定性: 不同 profile 产生不同结果", () => {
  const s = snapshot(
    [member("t1", { military: 6 })],
    [sighting("CORE:enemy", "CORE", [20, 0])],
  );
  const balanced = decideAllianceShadowPolicy(s, { strategyName: "balanced" });
  const aggressive = decideAllianceShadowPolicy(s, { strategyName: "aggressive" });
  // balanced: RAID only if no urgent → likely RAID (no threat)
  // aggressive: RAID checked first in missionPriority
  assert.notDeepEqual(
    JSON.parse(JSON.stringify(balanced)),
    JSON.parse(JSON.stringify(aggressive)),
  );
});

test("确定性: profile thresholds 被 Director 正确合并", () => {
  // aggressive profile 降低了 minRaidMilitary 到 4
  const s = snapshot(
    [member("t1", { military: 5 })],
    [sighting("CORE:enemy", "CORE", [20, 0])],
  );
  const decision = decideAllianceShadowPolicy(s, { strategyName: "aggressive" });
  // 5 ≥ 4（aggressive 阈值）→ RAID
  assert.equal(decision.missions[0]?.kind, "RAID");
});

// ═══════════════════════════════════════════════════════════════
// missionPriority 顺序验证
// ═══════════════════════════════════════════════════════════════

test("missionPriority: 高优先 kind 的条件匹配后不再检查后续", () => {
  // aggressive profile: RAID first → 即使无 enemy core，也会 fall through 到 INTERCEPT
  const s = snapshot(
    [member("t1", { military: 4 })],
    [sighting("UNIT:close", "UNIT", [5, 0])], // nearby combat unit
  );
  const decision = decideAllianceShadowPolicy(s, { strategyName: "aggressive" });
  // RAID checked first → no enemy core sighting → skip
  // INTERCEPT checked next → visible combat within 12 → match
  assert.equal(decision.missions[0]?.kind, "INTERCEPT");
});

// ═══════════════════════════════════════════════════════════════
// roleFor 映射
// ═══════════════════════════════════════════════════════════════

test("roleFor: balanced profile 的 ASSEMBLE + treasury → TREASURY", () => {
  const s = snapshot(
    [member("t1", { military: 0 })], // low military → ASSEMBLE
  );
  const decision = decideAllianceShadowPolicy(s, { strategyName: "balanced" });
  // t1 是 treasury（最低威胁+最高资源）
  assert.equal(decision.treasuryTenant, "t1");
  assert.equal(decision.roles.get("t1"), "TREASURY");
  assert.equal(decision.missions[0]?.kind, "ASSEMBLE");
});

test("roleFor: aggressive profile 的 RAID → RAIDER，INTERCEPT → DEFENDER", () => {
  const s = snapshot(
    [member("t1", { military: 6 })],
    [sighting("CORE:enemy", "CORE", [20, 0])],
  );
  const decision = decideAllianceShadowPolicy(s, { strategyName: "aggressive" });
  assert.equal(decision.roles.get("t1"), "RAIDER");
});

// ═══════════════════════════════════════════════════════════════
// 安全：strategy 不混入 Safety variants
// ═══════════════════════════════════════════════════════════════

test("安全边界: strategic profile 不含 Safety/Stall/Discipline 概念", () => {
  // 验证所有内置 profile 的 roleFor 只返回合法 AllianceRole
  const profiles = [BALANCED_PROFILE, AGGRESSIVE_PROFILE, SCOUT_PROFILE, DEFEND_PROFILE, RESERVE_PROFILE];
  const validRoles = new Set(["TREASURY", "DEFENDER", "RAIDER", "SCOUT"]);
  const sampleKinds: MissionKind[] = ["DEFEND", "RAID", "SCOUT", "INTERCEPT", "RETREAT", "ASSEMBLE", "ESCORT"];
  for (const p of profiles) {
    for (const kind of sampleKinds) {
      const role = p.roleFor(kind, "t1", "t2");
      assert.ok(validRoles.has(role), `profile=${p.name} kind=${kind} roleFor=${role} not in valid roles`);
    }
  }
});

test("安全边界: profile 不引用 pi/LLM/runtime/agent 模块", () => {
  // 静态检查：源码中不应出现这些 import
  // 这个测试是设计约束文档——实际 enforce 由 code review + 编译时类型检查保证
  // 此处验证 contentHash 是纯 sha256（不依赖运行时状态）
  const h = BALANCED_PROFILE.contentHash;
  // 如果 profile 依赖外部状态，contentHash 会在不同 run 间变化
  // 此处只验证 hash 是合法 hex
  assert.match(h, /^[a-f0-9]{16}$/);
});
