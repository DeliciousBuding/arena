/** 核心通道清障测试（2026-08-07，core-clearance-v1）：
 * 生产 t2 实证：核心格容量 2（含 Core）且是 worker 卸货唯一通道——Vanguard
 * 守位 homeCell 四邻全堵时回退核心格 → 满载 worker 4 邻格全 WAIT、
 * DEPOSIT_FAILED 77%，手操移开下 tick 又被放回。
 * 1. Vanguard 站在核心格 → 自动疏散（vanguard_clear_core）；
 * 2. 满载 worker 在核心格但核心满/迁移中卸不了 → 离开（worker_clear_core）；
 * 3. 变体关闭 = 历史行为零回归（不强制疏散）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, UnitSnapshot, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { resolveSafetyVariantConfig } from "../src/strategies/variant-registry.ts";

function vanguard(id: string, position: Position): UnitSnapshot {
  return { id, position, hp: 4, unitType: "VANGUARD", cargo: 0 };
}
function worker(id: string, position: Position, cargo: number): UnitSnapshot {
  return { id, position, hp: 2, unitType: "WORKER", cargo };
}

function makeState(opts: {
  tick?: number;
  units: UnitSnapshot[];
  vanguards: UnitSnapshot[];
  workers: UnitSnapshot[];
  rangers?: UnitSnapshot[];
  resourceSpace?: number;
  obstacleCells?: Position[];
  visibleEnemies?: VisibleEntity[];
  events?: { eventType: string; actorId: string | null; reasonCode: string | null; position: Position }[];
  visibleEnemies?: VisibleEntity[];
}): TickState {
  return {
    tick: opts.tick ?? 1,
    status: "ACTIVE",
    resources: 5,
    resourceCapacity: 10,
    resourceSpace: opts.resourceSpace ?? 10,
    population: opts.units.length,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: opts.units,
    workers: opts.workers,
    vanguards: opts.vanguards,
    rangers: opts.rangers ?? [],
    visibleEnemies: opts.visibleEnemies ?? [],
    resourceCells: new Set(),
    obstacleCells: new Set((opts.obstacleCells ?? []).map((c) => `${c[0]},${c[1]}`)),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: (opts.events ?? []).map((e, i) => ({
      eventId: `evt-${i}`,
      tick: opts.tick ?? 1,
      eventType: e.eventType,
      reasonCode: e.reasonCode,
      actorId: e.actorId,
      targetId: null,
      position: e.position,
      values: {},
    })),
  };
}

function clearConfig() {
  return { ...DEFAULT_SAFETY_CONFIG, coreClearance: true };
}

function intentsOf(plan: { intents?: Record<string, string> }): string[] {
  return Object.values(plan.intents ?? {});
}

test("核心通道清障：Vanguard 站核心格 → 自动疏散 vanguard_clear_core", () => {
  const planner = new SafetyPlanner(clearConfig());
  const v = vanguard("v00", [0, 0]);
  const plan = planner.decide({ state: makeState({ units: [v], vanguards: [v], workers: [] }), policy: undefined });
  const intents = intentsOf(plan);
  assert.ok(
    intents.includes("vanguard_clear_core"),
    `Vanguard 在核心格应疏散，实际 intents=${JSON.stringify(intents)}`,
  );
});

test("核心通道清障：满载 worker 在核心格卸不了（核心满）→ 离开 worker_clear_core", () => {
  const planner = new SafetyPlanner(clearConfig());
  const w = worker("w00", [0, 0], 1);
  const plan = planner.decide({
    state: makeState({ units: [w], vanguards: [], workers: [w], resourceSpace: 0 }),
    policy: undefined,
  });
  const intents = intentsOf(plan);
  assert.ok(
    intents.includes("worker_clear_core"),
    `满载 worker 应让位，实际 intents=${JSON.stringify(intents)}`,
  );
});

test("核心通道清障：空 worker 占核心格（无资源任务 idle）→ 疏散 worker_clear_core_empty", () => {
  const planner = new SafetyPlanner(clearConfig());
  const w = worker("w00", [0, 0], 0);
  const plan = planner.decide({
    state: makeState({ units: [w], vanguards: [], workers: [w], resourceSpace: 10 }),
    policy: undefined,
  });
  const intents = intentsOf(plan);
  assert.ok(
    intents.includes("worker_clear_core_empty"),
    `空 worker 应疏散让位（t2 实证：空 worker 占核心格 130+ tick、挡 SPAWN），
     实际 intents=${JSON.stringify(intents)}`,
  );
});

test("核心通道清障：空 worker 疏散优先物理空邻格（occ=0，不 MOVE_CONTESTED）", () => {
  const planner = new SafetyPlanner(clearConfig());
  // 核心 [0,0]；LEFT [-1,0] 被另一个 worker 占（occ=1），RIGHT [1,0] 空
  const idle = worker("w00", [0, 0], 0);
  const occupant = worker("w01", [-1, 0], 0);
  const plan = planner.decide({
    state: makeState({ units: [idle, occupant], vanguards: [], workers: [idle, occupant], resourceSpace: 10 }),
    policy: undefined,
  });
  const action = plan.unitActions["w00"];
  const intents = intentsOf(plan);
  assert.ok(intents.includes("worker_clear_core_empty"), `空 worker 应疏散，实际 ${JSON.stringify(intents)}`);
  assert.ok(action?.type === "MOVE", "疏散应为 MOVE");
  if (action?.type === "MOVE") {
    // RIGHT 物理空 → 移动方向必须指向 RIGHT（不进 occupied 的 LEFT → MOVE_CONTESTED）
    assert.equal(action.direction, "RIGHT", "空邻格优先：应移向空 RIGHT 而非被占 LEFT");
  }
});

test("核心通道清障：空 worker 疏散避开敌占邻格（不朝敌疏散送死）", () => {
  const planner = new SafetyPlanner(clearConfig());
  // 核心 [0,0]；RIGHT [1,0] 是空邻格但被敌方 Vanguard 占据（occupancyCounts
  // 不含敌人 → 旧实现 occ=0 会朝敌疏散），LEFT [-1,0] 物理空
  const idle = worker("w00", [0, 0], 0);
  const plan = planner.decide({
    state: makeState({
      units: [idle],
      vanguards: [],
      workers: [idle],
      resourceSpace: 10,
      visibleEnemies: [{
        id: "e1",
        position: [1, 0] as Position,
        hp: 2,
        unitType: "VANGUARD",
        kind: "UNIT" as const,
      }],
    }),
    policy: undefined,
  });
  const action = plan.unitActions["w00"];
  const intents = intentsOf(plan);
  assert.ok(intents.includes("worker_clear_core_empty"), `空 worker 应疏散，实际 ${JSON.stringify(intents)}`);
  if (action?.type === "MOVE") {
    assert.equal(action.direction, "LEFT", "敌占格视为不可疏散目标：应移向空 LEFT 而非敌占 RIGHT");
  }
});

test("核心通道清障：四邻全被占（occ=2）→ 仍疏散到外圈守位（不死等）", () => {
  const planner = new SafetyPlanner(clearConfig());
  const idle = worker("w00", [0, 0], 0);
  // 四邻各站 2 个单位（occ=2 全满）→ yieldAnchor 无空位 → coreGuardFallback 外圈
  const units = [idle];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    units.push(worker(`occ-${dx}-${dy}-1`, [dx, dy], 0));
    units.push(worker(`occ-${dx}-${dy}-2`, [dx, dy], 0));
  }
  const plan = planner.decide({
    state: makeState({
      units,
      vanguards: [],
      workers: units,
      resourceSpace: 10,
    }),
    policy: undefined,
  });
  const intents = intentsOf(plan);
  assert.ok(
    intents.includes("worker_clear_core_empty") || intents.includes("worker_clear_core"),
    `四邻全堵也应尝试疏散（回退外圈），实际 intents=${JSON.stringify(intents)}`,
  );
});

test("核心通道清障：Vanguard 在核心格 + 邻格被移动失败标记 → 仍疏散成功", () => {
  const planner = new SafetyPlanner(clearConfig());
  const v = vanguard("v00", [0, 0]);
  // tick1 邻格 [0,-1] 因 MOVE_DESTINATION_OCCUPIED 失败 → observe 写入瞬时障碍；
  // tick2 Vanguard 仍在核心格 → 疏散分支从剩余空邻格 [1,0] 走出（vanguard_clear_core）。
  planner.decide({
    state: makeState({
      units: [v], vanguards: [v], workers: [],
      events: [{ eventType: "UNIT_MOVE_FAILED", actorId: "v00", reasonCode: "MOVE_DESTINATION_OCCUPIED", position: [0, -1] }],
    }),
    policy: undefined,
  });
  const plan = planner.decide({ state: makeState({ units: [v], vanguards: [v], workers: [] }), policy: undefined });
  const intents = intentsOf(plan);
  assert.ok(
    intents.includes("vanguard_clear_core"),
    `邻格被瞬时标记时军事仍应疏散离开核心格，实际 intents=${JSON.stringify(intents)}`,
  );
});

test("核心通道清障：变体关闭 = 历史行为（不强制疏散，零回归）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG });
  const v = vanguard("v00", [0, 0]);
  const plan = planner.decide({ state: makeState({ units: [v], vanguards: [v], workers: [] }), policy: undefined });
  const intents = intentsOf(plan);
  assert.ok(
    !intents.includes("vanguard_clear_core"),
    `变体关闭不应疏散，实际 intents=${JSON.stringify(intents)}`,
  );
});

test("核心通道清障：variant registry 解析 core-clearance-v1", () => {
  const config = resolveSafetyVariantConfig("core-clearance-v1");
  assert.equal(config.coreClearance, true);
});


test("核心通道清障扩展：空载 worker 占核心格 → 疏散 worker_clear_core_empty（t2 130+tick 冻结实证）", () => {
  const planner = new SafetyPlanner(clearConfig());
  // 空载 worker 占核心格（无资源任务 WAIT），满载 worker 在邻格等卸货
  const empty = worker("w-empty", [0, 0], 0);
  const loaded = worker("w-full", [0, 1], 1);
  const plan = planner.decide({
    state: makeState({
      units: [empty, loaded],
      vanguards: [],
      workers: [empty, loaded],
      resourceSpace: 5,
    }),
    policy: undefined,
  });
  const intents = intentsOf(plan);
  assert.ok(
    intents.includes("worker_clear_core_empty"),
    `空载 worker 占核心格应疏散让位，实际 intents=${JSON.stringify(intents)}`,
  );
});

test("核心通道清障扩展：空载 worker 需回血（hp<满）留在核心格不疏散（主循环 HEAL 接管）", () => {
  const planner = new SafetyPlanner(clearConfig());
  const hurt = { id: "w-hurt", position: [0, 0] as Position, hp: 1, unitType: "WORKER" as const, cargo: 0 };
  const plan = planner.decide({
    state: makeState({ units: [hurt], vanguards: [], workers: [hurt], resourceSpace: 5 }),
    policy: undefined,
  });
  const intents = intentsOf(plan);
  assert.ok(
    intents.includes("heal"),
    `受伤空 worker 在核心格应 HEAL 而非疏散，实际 intents=${JSON.stringify(intents)}`,
  );
});


test("核心通道清障 follow-up：空邻格优先——RIGHT 有 worker(occ=1) 但 LEFT 空(occ=0) 时选 LEFT 疏散（t2 隔 tick 挡 SPAWN 8 次修复）", () => {
  const planner = new SafetyPlanner(clearConfig());
  // 核心格 [0,0] 空 worker；RIGHT [1,0] 有 worker(occ=1)；LEFT [-1,0] 物理空(occ=0)
  const empty = worker("w-core", [0, 0], 0);
  const rightNeighbor = worker("w-right", [1, 0], 0);
  const plan = planner.decide({
    state: makeState({
      units: [empty, rightNeighbor],
      vanguards: [],
      workers: [empty, rightNeighbor],
      resourceSpace: 5,
    }),
    policy: undefined,
  });
  const action = plan.unitActions["w-core"];
  assert.ok(action !== undefined, "核心格空 worker 应有动作");
  assert.equal(action.type, "MOVE", `应 MOVE 疏散，实际 ${JSON.stringify(action)}`);
  // 必须向 LEFT（空邻格）而非 RIGHT（有 worker 会 MOVE_CONTESTED 卡死）
  assert.equal(action.direction, "LEFT", `空邻格优先，实际方向=${action.direction}`);
  assert.ok(intentsOf(plan).includes("worker_clear_core_empty"), "intent 应为 worker_clear_core_empty");
});

test("核心通道清障 follow-up：瞬时 MOVE_FAILED 不得遮住唯一物理空邻格", () => {
  const planner = new SafetyPlanner(clearConfig());
  const w = worker("w-empty", [0, 0], 0);
  const blocked: Position[] = [[-1, 0], [0, 1], [0, -1]];
  // tick1 把唯一物理空格 [1,0] 记录成 MOVE_DESTINATION_OCCUPIED 瞬时失败。
  planner.decide({
    state: makeState({
      tick: 1, units: [w], vanguards: [], workers: [w], obstacleCells: blocked,
      events: [{ eventType: "UNIT_MOVE_FAILED", actorId: w.id, reasonCode: "MOVE_DESTINATION_OCCUPIED", position: [1, 0] }],
    }),
    policy: undefined,
  });
  // tick2 地形仍只有另外三格真障碍；[1,0] 物理空，应无视瞬时失败记忆疏散 RIGHT。
  const plan = planner.decide({
    state: makeState({ tick: 2, units: [w], vanguards: [], workers: [w], obstacleCells: blocked }),
    policy: undefined,
  });
  assert.equal(plan.intents?.[w.id], "worker_clear_core_empty");
  assert.deepEqual(plan.unitActions[w.id], { type: "MOVE", direction: "RIGHT" });
});

test("核心通道清障 follow-up：核心格 worker 永不被巡逻错峰 worker_hold_crowded 卡住", () => {
  // 故意关闭 coreClearance，单独验证 patrol-stagger 的独立不变量：占 Core 格必须离开，
  // 不能因为附近有 5+ worker 且有人更靠外就 WAIT。
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, coreClearance: false });
  const coreWorker = worker("w-core", [0, 0], 0);
  const others = [
    worker("w1", [1, 0], 0), worker("w2", [-1, 0], 0), worker("w3", [0, 1], 0),
    worker("w4", [0, -1], 0), worker("w5", [1, 1], 0), worker("w6", [2, 0], 0),
  ];
  const workers = [coreWorker, ...others];
  const plan = planner.decide({
    state: makeState({ units: workers, vanguards: [], workers }),
    policy: undefined,
  });
  assert.notEqual(plan.intents?.[coreWorker.id], "worker_hold_crowded");
  assert.equal(plan.intents?.[coreWorker.id], "patrol");
  assert.equal(plan.unitActions[coreWorker.id]?.type, "MOVE");
});

test("核心通道清障 follow-up：Core 被 worker 占用时远端回援先占外圈，不挤卸货 ring", () => {
  const planner = new SafetyPlanner({ ...clearConfig(), remoteReinforce: true });
  const occupant = worker("w-core", [0, 0], 0);
  const guard = vanguard("v-remote", [-6, -8]);
  const enemy: VisibleEntity = {
    id: "e-near", kind: "UNIT", position: [0, 5], hp: 3, unitType: "VANGUARD",
  };
  const plan = planner.decide({
    state: makeState({
      tick: 10,
      units: [occupant, guard], vanguards: [guard], workers: [occupant], visibleEnemies: [enemy],
    }),
    policy: undefined,
  });
  assert.equal(plan.intents?.[guard.id], "vanguard_reinforce");
  // index=0 的外圈 coreGuardFallback=[2,0]，从 [-6,-8] 首步 RIGHT；旧邻圈 [1,0] 首步 DOWN。
  assert.deepEqual(plan.unitActions[guard.id], { type: "MOVE", direction: "RIGHT" });
});


test("ring 疏散：核心格被空 worker 占用 + cheb-1 Vanguard → vanguard_ring_clear 让位（t2 卸货死锁实证）", () => {
  const planner = new SafetyPlanner(clearConfig());
  // t2 核心 (-30,38) 现场复刻：空 worker 占核心格，UP 2 满载、LEFT 1 守卫+1 满载、
  // RIGHT/DOWN 真障碍 → 空 worker 4 邻全堵。cheb-1 Vanguard 必须让位腾出核心邻格。
  const empty = worker("w-empty", [0, 0], 0);
  const loaded1 = worker("w-l1", [0, -1], 1);
  const loaded2 = worker("w-l2", [0, -1], 1);
  const v = vanguard("v00", [1, 0]);
  const plan = planner.decide({
    state: makeState({
      units: [empty, loaded1, loaded2, v],
      vanguards: [v],
      workers: [empty, loaded1, loaded2],
      obstacleCells: [[0, 1], [-1, 0]],
    }),
    policy: undefined,
  });
  assert.equal(
    plan.intents[v.id],
    "vanguard_ring_clear",
    `cheb-1 Vanguard 应让位到 cheb-2，实际=${plan.intents[v.id] ?? "(none)"}`,
  );
});

test("ring 疏散：核心格被空 worker 占用 + cheb-1 Ranger → ranger_ring_clear 让位", () => {
  const planner = new SafetyPlanner(clearConfig());
  const empty = worker("w-empty", [0, 0], 0);
  const r = { id: "r00", position: [1, 0] as Position, hp: 2, unitType: "RANGER" as const, cargo: 0 };
  const plan = planner.decide({
    state: makeState({
      units: [empty, r],
      vanguards: [],
      workers: [empty],
      rangers: [r],
      obstacleCells: [[0, 1], [-1, 0]],
    }),
    policy: undefined,
  });
  assert.equal(
    plan.intents[r.id],
    "ranger_ring_clear",
    `cheb-1 Ranger 应让位到 cheb-2，实际=${plan.intents[r.id] ?? "(none)"}`,
  );
});

test("ring 疏散：核心格未被 worker 占用 = 正常守位（零回归，无 vanguard_ring_clear）", () => {
  const planner = new SafetyPlanner(clearConfig());
  const v = vanguard("v00", [1, 0]);
  const plan = planner.decide({
    state: makeState({ units: [v], vanguards: [v], workers: [] }),
    policy: undefined,
  });
  assert.ok(
    !Object.values(plan.intents).includes("vanguard_ring_clear"),
    `核心格无 worker 时军事不强制让位，实际 intents=${JSON.stringify(intentsOf(plan))}`,
  );
});

test("ring 疏散：空 worker 全邻被堵/占满仍持续发疏散意图（coreGuardFallback 外圈锚点）", () => {
  const planner = new SafetyPlanner(clearConfig());
  const empty = worker("w-empty", [0, 0], 0);
  const loaded1 = worker("w-l1", [0, -1], 1);
  const loaded2 = worker("w-l2", [0, -1], 1);
  const v = vanguard("v00", [1, 0]);
  const plan = planner.decide({
    state: makeState({
      units: [empty, loaded1, loaded2, v],
      vanguards: [v],
      workers: [empty, loaded1, loaded2],
      obstacleCells: [[0, 1], [-1, 0], [1, 1], [-1, 1], [-1, -1], [1, -1]],
    }),
    policy: undefined,
  });
  assert.equal(
    plan.intents[empty.id],
    "worker_clear_core_empty",
    `空 worker 全堵时仍应发疏散意图，实际=${plan.intents[empty.id] ?? "(none)"}`,
  );
});
