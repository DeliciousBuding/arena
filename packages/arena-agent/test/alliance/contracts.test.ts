/**
 * Alliance Director — Phase 0 合同层测试。
 *
 * 覆盖：
 * - TTL 边界（expired/stale/active 精确边界）
 * - revision 新旧比较
 * - TaskForce 跨 tenant 合法 / FleetRef tenant-local enforcement
 * - 错误 tenant directive 拒绝
 * - AUTO/ASSIST/DIRECT roundtrip / 结构校验
 * - fail-open：过期/无效/stale → 忽略指令，回退本地 planner
 * - Mission 生命周期
 * - EntitySighting 置信度衰减
 * - AllianceSnapshot 基本结构校验
 *
 * 最后更新：2026-08-08
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AllianceSnapshot, EntitySighting } from "../../src/alliance/types.ts";
import type { AllianceDirective, AllianceMemberReport, FleetRef, Mission, TaskForce } from "../../src/alliance/control-types.ts";
import { computeForceCounts } from "../../src/alliance/counts.ts";
import { projectThreatField } from "../../src/alliance/threat-field.ts";

import {
  isMissionExpired,
  isMissionTerminal,
  isMissionActive,
  isMissionStale,
  isNewerMissionRevision,
  compareMissionRevision,
  latestMission,
  DEFAULT_MISSION_STALE_TICKS,
} from "../../src/alliance/mission.ts";

import {
  isMemberReportStale,
  sightingAge,
  isSightingFresh,
  computeConfidence,
  freshSightings,
  validateSnapshot,
  DEFAULT_REPORT_STALE_TICKS,
} from "../../src/alliance/member-report.ts";

import {
  isDirectiveExpired,
  isDirectivePending,
  isDirectiveActive,
  isDirectiveStale,
  isNewerRevision,
  compareRevision,
  validateDirectiveForTenant,
  evaluateDirective,
  MAX_DIRECTIVE_DURATION_TICKS,
} from "../../src/alliance/directive.ts";

import {
  validateFleetRefForTenant,
  fleetRefsForTenant,
} from "../../src/alliance/fleet.ts";

// ═══════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "m1",
    revision: 1,
    kind: "DEFEND",
    priority: 5,
    issuedAtTick: 100,
    expiresAtTick: 200,
    status: "ASSIGNED",
    source: "AUTO",
    ...overrides,
  };
}

function makeDirective(overrides: Partial<AllianceDirective> = {}): AllianceDirective {
  return {
    tenantId: "t1",
    revision: 1,
    missionRefs: ["m1"],
    issuedAtTick: 100,
    expiresAtTick: 200,
    source: "auto",
    mode: "AUTO",
    ...overrides,
  };
}

function makeReport(overrides: Partial<AllianceMemberReport> = {}): AllianceMemberReport {
  return {
    tenantId: "t1",
    tick: 100,
    observedAtMs: Date.now(),
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, moving: false },
    resources: 100,
    resourceCapacity: 200,
    population: 10,
    workers: 6,
    vanguards: 2,
    rangers: 2,
    carriedResources: 0,
    activeFleetIds: ["f1"],
    localThreat: 0,
    localHarvestRate: 1.5,
    status: "READY",
    ...overrides,
  };
}

function makeSighting(overrides: Partial<EntitySighting> = {}): EntitySighting {
  return {
    key: "enemy-core-1",
    kind: "CORE",
    ownerUsername: "enemy1",
    position: [10, 10],
    sourceTenant: "t1",
    firstSeenTick: 90,
    lastSeenTick: 100,
    currentlyVisible: true,
    confidence: 1.0,
    evidence: "LIVE",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// Mission TTL 与生命周期
// ═══════════════════════════════════════════════════════════════

test("Mission: 未过期（currentTick == expiresAtTick 时仍有效）", () => {
  const m = makeMission({ issuedAtTick: 100, expiresAtTick: 200 });
  assert.equal(isMissionExpired(m, 200), false);
  assert.equal(isMissionExpired(m, 201), true);
});

test("Mission: 过期边界（currentTick > expiresAtTick 过期）", () => {
  const m = makeMission({ issuedAtTick: 100, expiresAtTick: 200 });
  assert.equal(isMissionExpired(m, 199), false);
  assert.equal(isMissionExpired(m, 200), false);
  assert.equal(isMissionExpired(m, 201), true);
  assert.equal(isMissionExpired(m, 1000), true);
});

test("Mission: isMissionTerminal 终态判定", () => {
  assert.equal(isMissionTerminal(makeMission({ status: "SATISFIED" })), true);
  assert.equal(isMissionTerminal(makeMission({ status: "CANCELLED" })), true);
  assert.equal(isMissionTerminal(makeMission({ status: "EXPIRED" })), true);
  assert.equal(isMissionTerminal(makeMission({ status: "FAILED" })), true);
  assert.equal(isMissionTerminal(makeMission({ status: "PROPOSED" })), false);
  assert.equal(isMissionTerminal(makeMission({ status: "ASSIGNED" })), false);
  assert.equal(isMissionTerminal(makeMission({ status: "ACTIVE" })), false);
});

test("Mission: isMissionActive 仅 ASSIGNED/ACTIVE + 未过期", () => {
  assert.equal(isMissionActive(makeMission({ status: "ASSIGNED" }), 150), true);
  assert.equal(isMissionActive(makeMission({ status: "ACTIVE" }), 150), true);
  assert.equal(isMissionActive(makeMission({ status: "PROPOSED" }), 150), false);
  assert.equal(isMissionActive(makeMission({ status: "SATISFIED" }), 150), false);
  // 过期的不活跃
  assert.equal(isMissionActive(makeMission({ status: "ACTIVE" }), 201), false);
});

test("Mission: isMissionStale 检测卡住任务", () => {
  const fresh = makeMission({ issuedAtTick: 100, status: "ACTIVE" });
  // 当前 tick 110，issued 100，差 10 ≤ DEFAULT_MISSION_STALE_TICKS(16)
  assert.equal(isMissionStale(fresh, 110), false);

  // 回归：ASSIGNED/ACTIVE 卡住超过 16 tick → stale（此前表达式取反导致永不 stale）
  const staleActive = makeMission({ issuedAtTick: 100, status: "ACTIVE" });
  assert.equal(isMissionStale(staleActive, 120), true);

  const staleAssigned = makeMission({ issuedAtTick: 100, status: "ASSIGNED" });
  assert.equal(isMissionStale(staleAssigned, 120), true);

  // PROPOSED 是尚未分配 → 不算 stale（由 Director 正常 replan 处理）
  const proposed = makeMission({ issuedAtTick: 100, status: "PROPOSED" });
  assert.equal(isMissionStale(proposed, 120), false);

  // 已 hard-expire → 不算 stale（走过期路径，过期是更明确的状态）
  const expired = makeMission({ issuedAtTick: 100, expiresAtTick: 110, status: "ACTIVE" });
  assert.equal(isMissionStale(expired, 120), false);

  // 终结态不报告 stale
  assert.equal(isMissionStale(makeMission({ issuedAtTick: 100, status: "SATISFIED" }), 200), false);
});

test("Mission: revision 比较", () => {
  const v1 = makeMission({ revision: 1 });
  const v2 = makeMission({ revision: 2 });
  const v2dup = makeMission({ revision: 2 });

  assert.equal(isNewerMissionRevision(v2, v1), true);
  assert.equal(isNewerMissionRevision(v1, v2), false);
  assert.equal(isNewerMissionRevision(v2dup, v2), false); // 相同 revision → 不更新

  assert.equal(compareMissionRevision(v1, v2), -1);
  assert.equal(compareMissionRevision(v2, v1), 1);
  assert.equal(compareMissionRevision(v1, v1), 0);
});

test("Mission: latestMission 取最新 revision", () => {
  assert.equal(latestMission([]), undefined);
  const missions = [
    makeMission({ id: "m1", revision: 1 }),
    makeMission({ id: "m3", revision: 3 }),
    makeMission({ id: "m2", revision: 2 }),
  ];
  const best = latestMission(missions);
  assert.ok(best !== undefined);
  assert.equal(best!.id, "m3");
  assert.equal(best!.revision, 3);
});

test("Mission: 所有 MissionKind 枚举值可构造", () => {
  const kinds = ["DEFEND", "SCOUT", "ASSEMBLE", "RAID", "INTERCEPT", "ESCORT", "RETREAT"] as const;
  for (const kind of kinds) {
    const m = makeMission({ kind });
    assert.equal(m.kind, kind);
  }
});

// ═══════════════════════════════════════════════════════════════
// Directive TTL / Stale / Revision
// ═══════════════════════════════════════════════════════════════

test("Directive: isDirectiveExpired 精确边界", () => {
  const d = makeDirective({ issuedAtTick: 100, expiresAtTick: 200 });
  assert.equal(isDirectiveExpired(d, 199), false);
  assert.equal(isDirectiveExpired(d, 200), false);
  assert.equal(isDirectiveExpired(d, 201), true);
});

test("Directive: isDirectivePending 尚未生效", () => {
  const d = makeDirective({ issuedAtTick: 100, expiresAtTick: 200 });
  assert.equal(isDirectivePending(d, 99), true);
  assert.equal(isDirectivePending(d, 100), false);
  assert.equal(isDirectivePending(d, 150), false);
});

test("Directive: isDirectiveActive 有效窗口内", () => {
  const d = makeDirective({ issuedAtTick: 100, expiresAtTick: 200 });
  assert.equal(isDirectiveActive(d, 99), false);   // pending
  assert.equal(isDirectiveActive(d, 100), true);
  assert.equal(isDirectiveActive(d, 150), true);
  assert.equal(isDirectiveActive(d, 200), true);
  assert.equal(isDirectiveActive(d, 201), false);  // expired
});

test("Directive: isDirectiveStale 检测过期 + 长期未推进", () => {
  const d = makeDirective({ issuedAtTick: 100, expiresAtTick: 200 });
  // 当前 tick 102，差 2 ≤ DEFAULT_DIRECTIVE_STALE_TICKS(4)
  assert.equal(isDirectiveStale(d, 102), false);
  // 当前 tick 106，差 6 > 4
  assert.equal(isDirectiveStale(d, 106), true);
  // 已过期 → 也视为 stale
  assert.equal(isDirectiveStale(d, 201), true);
});

test("Directive: isNewerRevision 严格大于", () => {
  assert.equal(isNewerRevision({ revision: 2 }, { revision: 1 }), true);
  assert.equal(isNewerRevision({ revision: 1 }, { revision: 2 }), false);
  assert.equal(isNewerRevision({ revision: 1 }, { revision: 1 }), false);
  assert.equal(isNewerRevision({ revision: 0 }, { revision: 0 }), false);
});

test("Directive: compareRevision 排序比较器", () => {
  assert.equal(compareRevision({ revision: 1 }, { revision: 2 }), -1);
  assert.equal(compareRevision({ revision: 2 }, { revision: 1 }), 1);
  assert.equal(compareRevision({ revision: 5 }, { revision: 5 }), 0);
});

// ═══════════════════════════════════════════════════════════════
// Directive 验证（fail-open）
// ═══════════════════════════════════════════════════════════════

test("Directive: 有效 directive 通过结构校验", () => {
  const d = makeDirective();
  const result = validateDirectiveForTenant(d, "t1");
  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
});

test("Directive: tenant 不匹配 → 拒绝", () => {
  const d = makeDirective({ tenantId: "t2" });
  const result = validateDirectiveForTenant(d, "t1");
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.field === "tenantId"));
});

test("Directive: revision < 0 → 拒绝", () => {
  const d = makeDirective({ revision: -1 });
  const result = validateDirectiveForTenant(d, "t1");
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.field === "revision"));
});

test("Directive: expiresAtTick ≤ issuedAtTick → 拒绝", () => {
  const d = makeDirective({ issuedAtTick: 200, expiresAtTick: 200 });
  const result = validateDirectiveForTenant(d, "t1");
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.field === "expiresAtTick"));
});

test("Directive: 有效期过长 → 拒绝", () => {
  const d = makeDirective({
    issuedAtTick: 0,
    expiresAtTick: MAX_DIRECTIVE_DURATION_TICKS + 1,
  });
  const result = validateDirectiveForTenant(d, "t1");
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.field === "expiresAtTick"));
});

test("Directive: 无 missionRef → 拒绝", () => {
  const d = makeDirective({ missionRefs: [] });
  const result = validateDirectiveForTenant(d, "t1");
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.field === "missionRefs"));
});

test("Directive: 无效 mode → 拒绝", () => {
  const d = makeDirective({ mode: "INVALID" as unknown as "AUTO" });
  const result = validateDirectiveForTenant(d, "t1");
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.field === "mode"));
});

test("Directive: 无效 source → 拒绝", () => {
  const d = makeDirective({ source: "unknown" as unknown as "auto" });
  const result = validateDirectiveForTenant(d, "t1");
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.field === "source"));
});

test("Directive: 多问题同时上报", () => {
  const d = makeDirective({
    tenantId: "t2",
    revision: -1,
    missionRefs: [],
    mode: "BAD" as unknown as "AUTO",
    source: "bad" as unknown as "auto",
  });
  const result = validateDirectiveForTenant(d, "t1");
  assert.equal(result.valid, false);
  assert.ok(result.issues.length >= 2, `expected >= 2 issues, got ${result.issues.length}`);
});

// ═══════════════════════════════════════════════════════════════
// evaluateDirective — 综合消费判定（fail-open 主入口）
// ═══════════════════════════════════════════════════════════════

test("evaluateDirective: 有效指令 → 可消费（issued 后仍在 stale 窗口内）", () => {
  const d = makeDirective({ tenantId: "t1", issuedAtTick: 100, expiresAtTick: 200 });
  // currentTick=101：101-100=1 ≤ DEFAULT_DIRECTIVE_STALE_TICKS(4)，未 stale
  const result = evaluateDirective(d, "t1", 101);
  assert.equal(result.consume, true);
  assert.equal(result.reason, null);
});

test("evaluateDirective: tenant 不匹配 → 不消费 (fail-open)", () => {
  const d = makeDirective({ tenantId: "t2" });
  const result = evaluateDirective(d, "t1", 150);
  assert.equal(result.consume, false);
  assert.ok(result.reason?.includes("invalid"));
  assert.ok(result.reason?.includes("tenantId"));
});

test("evaluateDirective: 过期 → 不消费 (fail-open)", () => {
  const d = makeDirective({ issuedAtTick: 100, expiresAtTick: 200 });
  const result = evaluateDirective(d, "t1", 201);
  assert.equal(result.consume, false);
  assert.equal(result.reason, "expired");
});

test("evaluateDirective: pending → 暂不消费", () => {
  const d = makeDirective({ issuedAtTick: 100, expiresAtTick: 200 });
  const result = evaluateDirective(d, "t1", 99);
  assert.equal(result.consume, false);
  assert.equal(result.reason, "pending");
});

test("evaluateDirective: 结构无效 → 不消费 (fail-open)", () => {
  const d = makeDirective({ revision: -5 });
  const result = evaluateDirective(d, "t1", 150);
  assert.equal(result.consume, false);
  assert.ok(result.reason?.includes("invalid"));
});

test("evaluateDirective: stale（窗口内但长期未推进）→ 不消费 (fail-open)", () => {
  const d = makeDirective({ issuedAtTick: 100, expiresAtTick: 200 });
  // currentTick=150：150-100=50 > DEFAULT_DIRECTIVE_STALE_TICKS(4) → stale
  // 指令仍在有效窗口内（100 ≤ 150 ≤ 200），但 director 失联/停机后不可再消费
  const result = evaluateDirective(d, "t1", 150);
  assert.equal(result.consume, false);
  assert.equal(result.reason, "stale");
});

test("evaluateDirective: maxStaleTicks 参数可显式放宽（DIRECT 短窗口场景）", () => {
  const d = makeDirective({ issuedAtTick: 100, expiresAtTick: 200 });
  // 默认阈值下 stale（105-100=5 > 4）
  assert.equal(evaluateDirective(d, "t1", 105).consume, false);
  // 显式放宽后消费（105-100=5 ≤ 10）
  const result = evaluateDirective(d, "t1", 105, 10);
  assert.equal(result.consume, true);
  assert.equal(result.reason, null);
});

test("evaluateDirective: 边界——issuedAtTick 当天生效", () => {
  const d = makeDirective({ issuedAtTick: 100, expiresAtTick: 200 });
  assert.equal(evaluateDirective(d, "t1", 100).consume, true);
  assert.equal(evaluateDirective(d, "t1", 99).consume, false);
});

test("evaluateDirective: 边界——expiresAtTick 当天仍有效", () => {
  // issuedAtTick=196 保证 currentTick=200 时仍在 stale 窗口内（200-196=4 ≤ 4）
  const d = makeDirective({ issuedAtTick: 196, expiresAtTick: 200 });
  assert.equal(evaluateDirective(d, "t1", 200).consume, true);
  assert.equal(evaluateDirective(d, "t1", 201).consume, false);
});

// ═══════════════════════════════════════════════════════════════
// FAIL-OPEN 语义验证
// ═══════════════════════════════════════════════════════════════

test("Fail-open: 过期 directive 不应构造动作——consumer 忽略并回退 local planner", () => {
  // 模拟 per-tick consumer 的行为：
  // 1. 收到 directive
  // 2. evaluateDirective → consume=false
  // 3. 不基于 directive 生成任何 Plan / action
  const d = makeDirective({ issuedAtTick: 100, expiresAtTick: 200 });

  // tick 201：directive 已过期
  const result = evaluateDirective(d, "t1", 201);
  assert.equal(result.consume, false);
  // consumer 应直接 return，不使用 directive 的任何字段构造动作
});

test("Fail-open: 无效 directive（tenant mismatch）不应被消费", () => {
  const d = makeDirective({ tenantId: "t3" });
  // t1 收到给 t3 的 directive
  const result = evaluateDirective(d, "t1", 150);
  assert.equal(result.consume, false);
  // t1 继续用自己的 local planner
});

test("Fail-open: 结构损坏的 directive 不能绕过验证", () => {
  // 即使 directive 在有效窗口内，结构问题也必须拒绝
  const d = makeDirective({
    tenantId: "t1",
    issuedAtTick: 100,
    expiresAtTick: 200,
    missionRefs: [],
    revision: -1,
  });
  const result = evaluateDirective(d, "t1", 150);
  assert.equal(result.consume, false);
});

// ═══════════════════════════════════════════════════════════════
// AUTO / ASSIST / DIRECT roundtrip 与结构校验
// ═══════════════════════════════════════════════════════════════

test("ControlMode: AUTO roundtrip", () => {
  const d = makeDirective({ mode: "AUTO", source: "auto" });
  const result = validateDirectiveForTenant(d, "t1");
  assert.equal(result.valid, true);
  assert.equal(d.mode, "AUTO");
  assert.equal(d.source, "auto");
});

test("ControlMode: ASSIST roundtrip", () => {
  const d = makeDirective({ mode: "ASSIST", source: "human" });
  const result = validateDirectiveForTenant(d, "t1");
  assert.equal(result.valid, true);
  assert.equal(d.mode, "ASSIST");
  assert.equal(d.source, "human");
});

test("ControlMode: DIRECT roundtrip", () => {
  const d = makeDirective({
    mode: "DIRECT",
    source: "human",
    explanation: "紧急手动接管 t1 Core 迁移",
  });
  const result = validateDirectiveForTenant(d, "t1");
  assert.equal(result.valid, true);
  assert.equal(d.mode, "DIRECT");
  assert.equal(d.source, "human");
  assert.equal(d.explanation, "紧急手动接管 t1 Core 迁移");
});

test("ControlMode: DIRECT 模式下 explanation 可选", () => {
  const d1 = makeDirective({ mode: "DIRECT", source: "human", explanation: undefined });
  assert.equal(d1.explanation, undefined);
  assert.equal(validateDirectiveForTenant(d1, "t1").valid, true);

  const d2 = makeDirective({ mode: "DIRECT", source: "human", explanation: "test" });
  assert.equal(d2.explanation, "test");
  assert.equal(validateDirectiveForTenant(d2, "t1").valid, true);
});

test("ControlMode: 所有三种 mode 均可与 auto/human source 组合", () => {
  const modes = ["AUTO", "ASSIST", "DIRECT"] as const;
  const sources = ["auto", "human"] as const;
  for (const mode of modes) {
    for (const source of sources) {
      const d = makeDirective({ mode, source });
      const result = validateDirectiveForTenant(d, "t1");
      assert.equal(result.valid, true, `mode=${mode} source=${source} should be valid`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// FleetRef vs TaskForce 跨 tenant 语义
// ═══════════════════════════════════════════════════════════════

test("FleetRef: 是 tenant-local 引用——设计上不阻止跨 tenant 构造，但语义约束应在上层 enforce", () => {
  // FleetRef 结构上只有 fleetId + tenantId——这表示"某个 tenant 的某个 fleet"。
  // 跨 tenant 的 FleetRef 可以存在（表示引用其他 tenant 的 fleet），
  // 但 FleetAction（真实动作）只能由 fleet 所属 tenant 执行。
  const ref: FleetRef = { fleetId: "f-t1-1", tenantId: "t1" };
  assert.equal(ref.tenantId, "t1");
  assert.equal(ref.fleetId, "f-t1-1");
});

test("TaskForce: 允许跨 tenant 绑定多个 FleetRef", () => {
  const tf: TaskForce = {
    id: "tf-1",
    missionId: "m-raid-1",
    fleetRefs: [
      { fleetId: "f-t1-1", tenantId: "t1" },
      { fleetId: "f-t2-1", tenantId: "t2" },
    ],
    commanderTenant: "t1",
    synchronization: "RALLY_BEFORE_ENGAGE",
  };
  assert.equal(tf.fleetRefs.length, 2);
  // 验证跨 tenant
  const tenantIds = new Set(tf.fleetRefs.map((r) => r.tenantId));
  assert.ok(tenantIds.has("t1"));
  assert.ok(tenantIds.has("t2"));
  assert.equal(tenantIds.size, 2);
});

test("TaskForce: FleetRef 可以全部来自同一 tenant（退化情况）", () => {
  const tf: TaskForce = {
    id: "tf-2",
    missionId: "m-defend-1",
    fleetRefs: [
      { fleetId: "f1", tenantId: "t1" },
      { fleetId: "f2", tenantId: "t1" },
    ],
    commanderTenant: "t1",
    synchronization: "LOOSE",
  };
  // 两个 FleetRef 都来自 t1——合法（单 tenant 多 Fleet）
  assert.equal(tf.fleetRefs.length, 2);
  for (const ref of tf.fleetRefs) {
    assert.equal(ref.tenantId, "t1");
  }
});

test("TaskForce: 空 FleetRef 列表可构造（由上层 contract 决定是否合法）", () => {
  const tf: TaskForce = {
    id: "tf-empty",
    missionId: "m-1",
    fleetRefs: [],
    commanderTenant: "t1",
    synchronization: "LOOSE",
  };
  assert.equal(tf.fleetRefs.length, 0);
});

test("TaskForce: commanderTenant 不要求也在 fleetRefs 中", () => {
  // commander 可以是协调者而不提供兵力
  const tf: TaskForce = {
    id: "tf-3",
    missionId: "m-1",
    fleetRefs: [{ fleetId: "f-t2-1", tenantId: "t2" }],
    commanderTenant: "t1",
    synchronization: "LOOSE",
  };
  assert.equal(tf.commanderTenant, "t1");
  assert.equal(tf.fleetRefs[0].tenantId, "t2");
});

test("FleetRef: validateFleetRefForTenant 强制 tenant-local", () => {
  const ref: FleetRef = { fleetId: "f-t1-1", tenantId: "t1" };
  assert.equal(validateFleetRefForTenant(ref, "t1"), true);
  assert.equal(validateFleetRefForTenant(ref, "t2"), false);
});

test("FleetRef: TaskForce 跨 tenant 时 FleetController 只消费自己 tenant 的 ref", () => {
  const tf: TaskForce = {
    id: "tf-raid",
    missionId: "m-raid-1",
    fleetRefs: [
      { fleetId: "f-t1-1", tenantId: "t1" },
      { fleetId: "f-t2-1", tenantId: "t2" },
      { fleetId: "f-t1-2", tenantId: "t1" },
    ],
    commanderTenant: "t1",
    synchronization: "RALLY_BEFORE_ENGAGE",
  };
  // t1 的 FleetController 拆解后只拿到自己的 ref
  assert.deepEqual(
    fleetRefsForTenant(tf, "t1"),
    [
      { fleetId: "f-t1-1", tenantId: "t1" },
      { fleetId: "f-t1-2", tenantId: "t1" },
    ],
  );
  // t1 的 FleetController 不能驱动 t2 的 Fleet（fail-open：忽略）
  assert.equal(validateFleetRefForTenant(tf.fleetRefs[1], "t1"), false);
});

// ═══════════════════════════════════════════════════════════════
// EntitySighting 置信度衰减
// ═══════════════════════════════════════════════════════════════

test("EntitySighting: sightingAge 计算年龄", () => {
  const s = makeSighting({ lastSeenTick: 100 });
  assert.equal(sightingAge(s, 100), 0);
  assert.equal(sightingAge(s, 105), 5);
  assert.equal(sightingAge(s, 95), 0); // future tick → clamp to 0
});

test("EntitySighting: isSightingFresh 新鲜度判定", () => {
  const s = makeSighting({ lastSeenTick: 100 });
  assert.equal(isSightingFresh(s, 100), true);   // age 0
  assert.equal(isSightingFresh(s, 108), true);   // age 8 == maxAge
  assert.equal(isSightingFresh(s, 109), false);  // age 9 > 8
});

test("EntitySighting: computeConfidence 指数衰减", () => {
  const s = makeSighting({ lastSeenTick: 100 });
  // age 0 → exp(0) = 1.0
  assert.ok(Math.abs(computeConfidence(s, 100, 8) - 1.0) < 0.001);
  // age 8 → exp(-8/8) = exp(-1) ≈ 0.368
  const at8 = computeConfidence(s, 108, 8);
  assert.ok(Math.abs(at8 - 0.368) < 0.01, `expected ~0.368, got ${at8}`);
  // age 很大 → clamp at floor
  const at100 = computeConfidence(s, 200, 8, 0.05);
  assert.ok(at100 >= 0.05, `expected >= 0.05, got ${at100}`);
});

test("EntitySighting: computeConfidence 不同 tau 衰减速度不同", () => {
  const s = makeSighting({ lastSeenTick: 100 });
  const fastDecay = computeConfidence(s, 108, 4);   // tau=4, age=8 → exp(-2)
  const slowDecay = computeConfidence(s, 108, 16);  // tau=16, age=8 → exp(-0.5)
  assert.ok(fastDecay < slowDecay, `fast=${fastDecay}, slow=${slowDecay}`);
});

// ═══════════════════════════════════════════════════════════════
// AllianceMemberReport / AllianceSnapshot
// ═══════════════════════════════════════════════════════════════

test("AllianceMemberReport: isMemberReportStale 检测过期报告", () => {
  const r = makeReport({ tick: 100 });
  assert.equal(isMemberReportStale(r, 100), false);
  assert.equal(isMemberReportStale(r, 108), false);  // age 8 == default
  assert.equal(isMemberReportStale(r, 109), true);   // age 9 > 8
});

test("AllianceSnapshot: validateSnapshot 基本结构校验", () => {
  const members = new Map([["t1", makeReport({ tenantId: "t1" })]]);
  const valid: AllianceSnapshot = {
    revision: 0,
    tickWindow: [0, 100],
    generatedAtMs: 100_000,
    members,
    sightings: [],
    allyEntityIds: new Set(),
    threat: projectThreatField([], 100, { generatedAtMs: 100_000 }),
    counts: computeForceCounts([], 100),
    treasuryTenant: "t1",
  };
  assert.deepEqual(validateSnapshot(valid), []);

  const badRevision: AllianceSnapshot = { ...valid, revision: -1 };
  assert.ok(validateSnapshot(badRevision).length > 0);

  const badWindow: AllianceSnapshot = { ...valid, tickWindow: [100, 0] };
  assert.ok(validateSnapshot(badWindow).length > 0);

  const badTreasury: AllianceSnapshot = { ...valid, treasuryTenant: "t2" };
  assert.ok(validateSnapshot(badTreasury).length > 0);
});

test("freshSightings: 过滤非新鲜目击", () => {
  const sightings: EntitySighting[] = [
    makeSighting({ key: "s1", lastSeenTick: 100 }),
    makeSighting({ key: "s2", lastSeenTick: 90 }),
    makeSighting({ key: "s3", lastSeenTick: 95, kind: "UNIT" }),
  ];
  const snapshot: AllianceSnapshot = {
    revision: 0,
    tickWindow: [0, 100],
    generatedAtMs: 100_000,
    members: new Map(),
    sightings,
    allyEntityIds: new Set(),
    threat: projectThreatField([], 100, { generatedAtMs: 100_000 }),
    counts: computeForceCounts([], 100),
    treasuryTenant: "t1",
  };
  // 当前 tick 100，maxAge=8 → s2(age10) 过期，s1/s3 新鲜
  const fresh = freshSightings(snapshot, 100, 8);
  assert.equal(fresh.length, 2);
  assert.ok(fresh.every((s) => s.key === "s1" || s.key === "s3"));
});

// ═══════════════════════════════════════════════════════════════
// tenantId 泛型：不写死为四租户
// ═══════════════════════════════════════════════════════════════

test("tenantId 泛型：支持任意字符串 tenantId（不限于 t1-t4）", () => {
  const tenants = ["t1", "t2", "t5", "tenant-alpha", "any-arbitrary-string"];
  for (const tid of tenants) {
    const d = makeDirective({ tenantId: tid });
    const result = validateDirectiveForTenant(d, tid);
    assert.equal(result.valid, true, `tenantId="${tid}" should be valid`);
  }
});

test("tenantId 泛型：不匹配时被拒绝（不限于四租户比较）", () => {
  const d = makeDirective({ tenantId: "tenant-alpha" });
  const result = evaluateDirective(d, "tenant-beta", 150);
  assert.equal(result.consume, false);
  assert.ok(result.reason?.includes("tenantId"));
});

// ═══════════════════════════════════════════════════════════════
// 不变量：合同层不含 Arena token / Plan / CandidateSink
// ═══════════════════════════════════════════════════════════════

test("合同层不变量：AllianceDirective 不含 Arena token 或 Plan 字段", () => {
  const d = makeDirective();
  // 验证不存在 token/plan 相关字段（TypeScript 编译时已保证——此处运行时验）
  assert.ok(!("token" in d));
  assert.ok(!("plan" in d));
  assert.ok(!("submit" in d));
  assert.ok(!("candidateSink" in d));
});

test("合同层不变量：所有 helper 不引用 CandidateSink", () => {
  // 所有导出 helper 的返回值不包含 Plan/Action/submit 相关类型
  // 这是一个设计级约束，由 TypeScript 编译时 enforced
  const d = makeDirective();
  const result = evaluateDirective(d, "t1", 150);
  // consume=true 时只返回 boolean + reason，不返回任何可写的 Plan/Action
  assert.equal(typeof result.consume, "boolean");
  assert.ok(result.reason === null || typeof result.reason === "string");
});

// ═══════════════════════════════════════════════════════════════
// DEFAULT 常量一致性
// ═══════════════════════════════════════════════════════════════

test("DEFAULT 常量：值在合理范围内", () => {
  assert.ok(DEFAULT_MISSION_STALE_TICKS > 0);
  assert.ok(DEFAULT_REPORT_STALE_TICKS > 0);
  assert.ok(MAX_DIRECTIVE_DURATION_TICKS > 0);
  // directive duration 上限应大于 stale 阈值
  assert.ok(MAX_DIRECTIVE_DURATION_TICKS > 4);
});


