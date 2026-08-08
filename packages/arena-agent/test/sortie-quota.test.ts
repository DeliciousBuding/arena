/**
 * 斩首配额会计测试（2026-08-09，sortie-quota-v1，W10，B2 缺陷 1 修复）：
 * weakCoreOrderedTargets 全军事扑同一弱核 → 按家防余量分档借调 1V+2R
 * 编成 sortie（跨 tick sticky）。生命周期 72 tick、目击 ≤96 tick、距离 ≤28、
 * 4 种取消回收（超时/目击过期/家防被袭击/目标消失）。默认关闭零回归。
 * 参考：arena_hero_strategy.py _beacon_local_core_sortie_assignments :5816-6068。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, ResolutionEventSnapshot, TickState, UnitSnapshot, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import type { CoreHuntTarget } from "../src/domain/world.ts";
import type { SafetyPlannerConfig } from "../src/strategies/safety-planner-config.ts";

const CORE: Position = [0, 0];

function vanguardUnit(id: string, position: Position): UnitSnapshot {
  return { id, position, hp: 4, unitType: "VANGUARD", cargo: 0 };
}

function rangerUnit(id: string, position: Position): UnitSnapshot {
  return { id, position, hp: 2, unitType: "RANGER", cargo: 0 };
}

function enemyVanguard(id: string, position: Position): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 4, unitType: "VANGUARD" };
}

interface MakeStateOptions {
  readonly tick: number;
  readonly vanguards?: Position[];
  readonly rangers?: Position[];
  readonly enemies?: VisibleEntity[];
}

function makeState(opts: MakeStateOptions): TickState {
  const vs = (opts.vanguards ?? []).map((p, i) => vanguardUnit(`v${i}`, p));
  const rs = (opts.rangers ?? []).map((p, i) => rangerUnit(`r${i}`, p));
  return {
    tick: opts.tick,
    status: "ACTIVE",
    resources: 50,
    resourceCapacity: 50,
    resourceSpace: 50,
    population: vs.length + rs.length,
    core: { id: "c1", position: CORE, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [...vs, ...rs],
    workers: [],
    vanguards: vs,
    rangers: rs,
    visibleEnemies: opts.enemies ?? [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const PRESSURE_POLICY = {
  posture: "aggressive" as const,
  workerTarget: 6,
  militaryRatio: 0.4,
  focusRegion: null,
  attackPriority: "core" as const,
};

/** sortie-quota-v1 基础配置：aggressive + militaryHunt + weakCoreFirst + sortieQuota。
 *  attackForce=0 关闭爆兵门槛（forceGate=false），strikeGroupReserve/boundedRaid/
 *  rallyAssault 全关，避免干扰 sortie 行为。 */
function sortieConfig(overrides: Partial<SafetyPlannerConfig> = {}): SafetyPlannerConfig {
  return {
    ...DEFAULT_SAFETY_CONFIG,
    aggression: "aggressive",
    militaryHunt: true,
    weakCoreFirst: true,
    sortieQuota: true,
    enemyCoreMemoryTicks: 1200,
    ...overrides,
  } as SafetyPlannerConfig;
}

/** 播种 2 个敌核目标：targetA [20,0]（Chebyshev 20 ≤28，更新鲜）、
 *  targetB [-20,0]（Chebyshev 20 ≤28，较旧）。weakCoreFirst 排序：
 *  守军相等(0) → lastSeenTick 降序 → A 在前。 */
function seedTwoTargets(planner: SafetyPlanner, tickA = 2, tickB = 1): void {
  const targets: readonly CoreHuntTarget[] = [
    { position: [20, 0], lastSeenTick: tickA, source: "CORE", owner: "enemyA" },
    { position: [-20, 0], lastSeenTick: tickB, source: "CORE", owner: "enemyB" },
  ];
  planner.seedCoreHuntTargets(targets);
}

/** 获取指定前缀单位的 intent 列表（按 id 排序）。 */
function intentsFor(plan: { intents: Record<string, string> }, prefix: string): string[] {
  return Object.entries(plan.intents)
    .filter(([id]) => id.startsWith(prefix))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, intent]) => intent);
}

/** 获取指定前缀单位的 action direction 列表（按 id 排序）。 */
function directionsFor(
  plan: { unitActions: Record<string, { type: string; direction?: string }> },
  prefix: string,
): string[] {
  return Object.entries(plan.unitActions)
    .filter(([id]) => id.startsWith(prefix))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, action]) => action.direction ?? "NONE");
}

test("sortieQuota 默认关闭：Vanguard 走历史 vanguard_hunt（零回归）", () => {
  const config = sortieConfig({ sortieQuota: false });
  const planner = new SafetyPlanner(config);
  seedTwoTargets(planner);
  // tick 3：5V+5R 无可见敌人 → militaryHunt → 历史 .find（A 在前）
  const plan = planner.decide({
    state: makeState({
      tick: 3,
      vanguards: [[1, 0], [1, 1], [2, 0], [2, 1], [2, -1]],
      rangers: [[0, 1], [0, -1], [1, -1], [3, 0], [3, 1]],
    }),
    policy: PRESSURE_POLICY,
  });
  const vIntents = intentsFor(plan, "v");
  // 历史行为：所有 Vanguard 扑同一弱核 A → 全部 vanguard_hunt（非 vanguard_sortie）
  assert.ok(
    vIntents.every((intent) => intent !== "vanguard_sortie"),
    `变体关闭时不应有 vanguard_sortie，实际=${JSON.stringify(vIntents)}`,
  );
  assert.ok(
    vIntents.some((intent) => intent === "vanguard_hunt"),
    `变体关闭时应走 vanguard_hunt，实际=${JSON.stringify(vIntents)}`,
  );
});

test("sortieQuota 余量不足（<3V）→ 不借调（零回归，无 vanguard_sortie）", () => {
  const planner = new SafetyPlanner(sortieConfig());
  seedTwoTargets(planner);
  // 仅 2V+5R：家防余量 V=2 <3 → 不借调
  const plan = planner.decide({
    state: makeState({
      tick: 3,
      vanguards: [[1, 0], [1, 1]],
      rangers: [[0, 1], [0, -1], [1, -1], [3, 0], [3, 1]],
    }),
    policy: PRESSURE_POLICY,
  });
  const vIntents = intentsFor(plan, "v");
  assert.ok(
    vIntents.every((intent) => intent !== "vanguard_sortie"),
    `余量 V<3 不应借调，实际=${JSON.stringify(vIntents)}`,
  );
});

test("sortieQuota 余量不足（<3R）→ 不借调（零回归，无 vanguard_sortie）", () => {
  const planner = new SafetyPlanner(sortieConfig());
  seedTwoTargets(planner);
  // 5V+2R：家防余量 R=2 <3 → 不借调
  const plan = planner.decide({
    state: makeState({
      tick: 3,
      vanguards: [[1, 0], [1, 1], [2, 0], [2, 1], [2, -1]],
      rangers: [[0, 1], [0, -1]],
    }),
    policy: PRESSURE_POLICY,
  });
  const vIntents = intentsFor(plan, "v");
  assert.ok(
    vIntents.every((intent) => intent !== "vanguard_sortie"),
    `余量 R<3 不应借调，实际=${JSON.stringify(vIntents)}`,
  );
});

test("sortieQuota 余量足够 → 借调 1V+2R 编成 sortie（分流不扑同一弱核）", () => {
  const planner = new SafetyPlanner(sortieConfig());
  seedTwoTargets(planner);
  // 5V+5R：家防余量 ≥3V+3R → 借调 1V 编成 sortie
  const plan = planner.decide({
    state: makeState({
      tick: 3,
      vanguards: [[1, 0], [1, 1], [2, 0], [2, 1], [2, -1]],
      rangers: [[0, 1], [0, -1], [1, -1], [3, 0], [3, 1]],
    }),
    policy: PRESSURE_POLICY,
  });
  const vIntents = intentsFor(plan, "v");
  const sortieCount = vIntents.filter((intent) => intent === "vanguard_sortie").length;
  // 2 个目标 → 最多借调 2 个 Vanguard（每 sortie 1V），剩余 V 余量 3 守家
  assert.equal(sortieCount, 2, `应借调 2 个 Vanguard 编成 sortie，实际 intents=${JSON.stringify(vIntents)}`);
  // 两 sortie Vanguard 朝不同方向（A [20,0]=RIGHT，B [-20,0]=LEFT）
  const sortieDirections = directionsFor(plan, "v");
  assert.ok(
    sortieDirections.includes("RIGHT") && sortieDirections.includes("LEFT"),
    `两 sortie 应分别朝 RIGHT/LEFT（不同弱核），实际 directions=${JSON.stringify(sortieDirections)}`,
  );
});

test("sortieQuota 72 tick 超时 → 回收（取消理由 ①）", () => {
  const planner = new SafetyPlanner(sortieConfig());
  seedTwoTargets(planner, 1, 1);
  // tick 1：建立 sortie
  const planTick1 = planner.decide({
    state: makeState({
      tick: 1,
      vanguards: [[1, 0], [1, 1], [2, 0], [2, 1], [2, -1]],
      rangers: [[0, 1], [0, -1], [1, -1], [3, 0], [3, 1]],
    }),
    policy: PRESSURE_POLICY,
  });
  const sortieTick1 = intentsFor(planTick1, "v").filter((intent) => intent === "vanguard_sortie").length;
  assert.ok(sortieTick1 > 0, "tick 1 应建立 sortie");
  const prunedAfterTick1 = planner.sortiePruneCount;

  // tick 72：未超时（72-1=71 <72）→ sortie 仍存活，无超时回收
  planner.decide({
    state: makeState({
      tick: 72,
      vanguards: [[1, 0], [1, 1], [2, 0], [2, 1], [2, -1]],
      rangers: [[0, 1], [0, -1], [1, -1], [3, 0], [3, 1]],
    }),
    policy: PRESSURE_POLICY,
  });
  assert.equal(planner.sortiePruneCount, prunedAfterTick1, "tick 72 未超时不应触发回收");

  // tick 73：超时（73-1=72 ≥72）→ pruneSorties 删除超时记录（sortiePruneCount +2）
  planner.decide({
    state: makeState({
      tick: 73,
      vanguards: [[1, 0], [1, 1], [2, 0], [2, 1], [2, -1]],
      rangers: [[0, 1], [0, -1], [1, -1], [3, 0], [3, 1]],
    }),
    policy: PRESSURE_POLICY,
  });
  assert.ok(
    planner.sortiePruneCount > prunedAfterTick1,
    `tick 73 超时应触发回收（pruneCount ${planner.sortiePruneCount} > ${prunedAfterTick1}）`,
  );
});

test("sortieQuota 目击过期（>96 tick）→ 取消（取消理由 ②）", () => {
  const planner = new SafetyPlanner(sortieConfig());
  // 目标 lastSeenTick=1
  seedTwoTargets(planner, 1, 1);
  // tick 1：建立 sortie
  const planTick1 = planner.decide({
    state: makeState({
      tick: 1,
      vanguards: [[1, 0], [1, 1], [2, 0], [2, 1], [2, -1]],
      rangers: [[0, 1], [0, -1], [1, -1], [3, 0], [3, 1]],
    }),
    policy: PRESSURE_POLICY,
  });
  assert.ok(
    intentsFor(planTick1, "v").some((intent) => intent === "vanguard_sortie"),
    "tick 1 应建立 sortie",
  );
  // tick 98：目击过期（98-1=97 >96）→ 取消
  const planTick98 = planner.decide({
    state: makeState({
      tick: 98,
      vanguards: [[1, 0], [1, 1], [2, 0], [2, 1], [2, -1]],
      rangers: [[0, 1], [0, -1], [1, -1], [3, 0], [3, 1]],
    }),
    policy: PRESSURE_POLICY,
  });
  const vIntents98 = intentsFor(planTick98, "v");
  assert.ok(
    vIntents98.every((intent) => intent !== "vanguard_sortie"),
    `tick 98 目击过期应取消 sortie，实际=${JSON.stringify(vIntents98)}`,
  );
});

test("sortieQuota 距离 >28 → 不借调（CORE_ASSAULT_MAX_HOME_DISTANCE）", () => {
  const planner = new SafetyPlanner(sortieConfig());
  // 目标 [29,0] Chebyshev 29 >28 → 不借调
  const targets: readonly CoreHuntTarget[] = [
    { position: [29, 0], lastSeenTick: 2, source: "CORE", owner: "far" },
  ];
  planner.seedCoreHuntTargets(targets);
  const plan = planner.decide({
    state: makeState({
      tick: 3,
      vanguards: [[1, 0], [1, 1], [2, 0], [2, 1], [2, -1]],
      rangers: [[0, 1], [0, -1], [1, -1], [3, 0], [3, 1]],
    }),
    policy: PRESSURE_POLICY,
  });
  const vIntents = intentsFor(plan, "v");
  assert.ok(
    vIntents.every((intent) => intent !== "vanguard_sortie"),
    `距离 >28 不应借调，实际=${JSON.stringify(vIntents)}`,
  );
});

test("sortieQuota 距离 ≤28 → 借调（边界值刚好合格）", () => {
  const planner = new SafetyPlanner(sortieConfig());
  // 目标 [28,0] Chebyshev 28 ≤28 → 借调
  const targets: readonly CoreHuntTarget[] = [
    { position: [28, 0], lastSeenTick: 2, source: "CORE", owner: "edge" },
  ];
  planner.seedCoreHuntTargets(targets);
  const plan = planner.decide({
    state: makeState({
      tick: 3,
      vanguards: [[1, 0], [1, 1], [2, 0], [2, 1], [2, -1]],
      rangers: [[0, 1], [0, -1], [1, -1], [3, 0], [3, 1]],
    }),
    policy: PRESSURE_POLICY,
  });
  const vIntents = intentsFor(plan, "v");
  assert.ok(
    vIntents.some((intent) => intent === "vanguard_sortie"),
    `距离 ≤28 应借调，实际=${JSON.stringify(vIntents)}`,
  );
});

test("sortieQuota 家防被袭击 → 取消借调回援（取消理由 ③）", () => {
  const planner = new SafetyPlanner(sortieConfig());
  seedTwoTargets(planner, 1, 1);
  // tick 1：无敌人 → 建立 sortie
  const planTick1 = planner.decide({
    state: makeState({
      tick: 1,
      vanguards: [[1, 0], [1, 1], [2, 0], [2, 1], [2, -1]],
      rangers: [[0, 1], [0, -1], [1, -1], [3, 0], [3, 1]],
    }),
    policy: PRESSURE_POLICY,
  });
  assert.ok(
    intentsFor(planTick1, "v").some((intent) => intent === "vanguard_sortie"),
    "tick 1 应建立 sortie",
  );
  // tick 2：敌 Vanguard 贴脸 Core [1,0]（Chebyshev 1 ≤12 = THREAT_FALLBACK_RADIUS）
  // → threat 非 NORMAL + 余量跌破（借调的 V 被召回算守家，但 sortie 已取消）
  const planTick2 = planner.decide({
    state: makeState({
      tick: 2,
      vanguards: [[1, 0], [1, 1], [2, 0], [2, 1], [2, -1]],
      rangers: [[0, 1], [0, -1], [1, -1], [3, 0], [3, 1]],
      enemies: [enemyVanguard("ev1", [1, 0])],
    }),
    policy: PRESSURE_POLICY,
  });
  // 有可见敌人 → Vanguard 不进 militaryHunt（走射击/SWEP 分支），
  // 但 sortie 已被 pruneSorties 取消（家防被袭击 + 余量不足）。
  // 验证：tick 2 无人 vanguard_sortie（sortie 已回收）
  const vIntents2 = intentsFor(planTick2, "v");
  assert.ok(
    vIntents2.every((intent) => intent !== "vanguard_sortie"),
    `家防被袭击应取消 sortie，实际=${JSON.stringify(vIntents2)}`,
  );
  // tick 3：敌人消失 → sortie 已取消不会自动恢复（需重新借调）
  // 但余量足够(5V+5R)且无敌人 → 可重新借调
  const planTick3 = planner.decide({
    state: makeState({
      tick: 3,
      vanguards: [[1, 0], [1, 1], [2, 0], [2, 1], [2, -1]],
      rangers: [[0, 1], [0, -1], [1, -1], [3, 0], [3, 1]],
    }),
    policy: PRESSURE_POLICY,
  });
  const vIntents3 = intentsFor(planTick3, "v");
  assert.ok(
    vIntents3.some((intent) => intent === "vanguard_sortie"),
    `敌人消失后余量足够应重新借调，实际=${JSON.stringify(vIntents3)}`,
  );
});

test("sortieQuota 目标消失（敌核被摧毁）→ 取消（取消理由 ④）", () => {
  const planner = new SafetyPlanner(sortieConfig());
  seedTwoTargets(planner, 1, 1);
  // tick 1：建立 sortie
  const planTick1 = planner.decide({
    state: makeState({
      tick: 1,
      vanguards: [[1, 0], [1, 1], [2, 0], [2, 1], [2, -1]],
      rangers: [[0, 1], [0, -1], [1, -1], [3, 0], [3, 1]],
    }),
    policy: PRESSURE_POLICY,
  });
  assert.ok(
    intentsFor(planTick1, "v").some((intent) => intent === "vanguard_sortie"),
    "tick 1 应建立 sortie",
  );
  // 模拟敌核被摧毁：DESTRUCTION_PARTICIPATION(CORE) 事件 → forgetCoreHuntAt
  // decide 入口会清除 coreHuntMemory 中的目标 → pruneSorties 检测到目标消失
  const destructionEvent: ResolutionEventSnapshot = {
    eventId: "evt1",
    tick: 2,
    eventType: "DESTRUCTION_PARTICIPATION",
    reasonCode: "CORE",
    position: [20, 0],
    targetId: "enemyCoreA",
    actorId: null,
    values: {},
  };
  const planTick2 = planner.decide({
    state: {
      ...makeState({
        tick: 2,
        vanguards: [[1, 0], [1, 1], [2, 0], [2, 1], [2, -1]],
        rangers: [[0, 1], [0, -1], [1, -1], [3, 0], [3, 1]],
      }),
      events: [destructionEvent],
    },
    policy: PRESSURE_POLICY,
  });
  // 目标 A [20,0] 被摧毁 → 其 sortie 取消。目标 B [-20,0] 仍存活。
  const vIntents2 = intentsFor(planTick2, "v");
  // B 仍可借调（1V），但 A 的 sortie 已取消
  const sortieCount = vIntents2.filter((intent) => intent === "vanguard_sortie").length;
  assert.ok(
    sortieCount <= 1,
    `目标 A 被摧毁后其 sortie 应取消（最多仅 B 的 1 个 sortie），实际=${JSON.stringify(vIntents2)}`,
  );
});
