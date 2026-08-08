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
  resourceSpace?: number;
  obstacleCells?: Position[];
  visibleEnemies?: VisibleEntity[];
  events?: { eventType: string; actorId: string | null; reasonCode: string | null; position: Position }[];
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
    rangers: [],
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
