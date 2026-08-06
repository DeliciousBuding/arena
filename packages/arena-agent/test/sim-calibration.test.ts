/** S8a calibration schema, replay and discrepancy classification tests. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Plan, Position, UnitType } from "../src/domain/model.ts";
import { runCalibrationCase } from "../src/sim/calibration/calibrate.ts";
import {
  parseCalibrationCase,
  type CalibrationCaseV1,
} from "../src/sim/calibration/schema.ts";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";
import { idlePlans, settleTick } from "../src/sim/engine/settlement.ts";
import { projectPlayerState } from "../src/sim/visibility/visibility.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";
import type { SimWorld } from "../src/sim/world/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.14.json");
const V011_MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.11.json");
const SCHEMA_PATH = join(here, "..", "src", "sim", "calibration", "sim-calibration-case-v1.schema.json");
const rules = loadRulesManifest(MANIFEST_PATH);
const P1_CORE = "11111111-1111-1111-1111-111111111111";
const P1_UNIT = "22222222-2222-2222-2222-222222222222";

function makeWorld(opts: {
  tick?: number;
  resources?: number;
  units?: readonly {
    id: string;
    position: Position;
    hp?: number;
    unitType?: UnitType;
    cargo?: number;
  }[];
  terrainResources?: readonly Position[];
} = {}): SimWorld {
  return worldFromScenario({
    rulesVersion: "v0.14",
    tick: opts.tick ?? 1,
    seed: 42,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: opts.resources ?? 5,
        core: {
          id: P1_CORE,
          position: [0, 0],
          hp: 5,
          shield: 5,
          state: "NORMAL",
        },
        units: (opts.units ?? [
          { id: P1_UNIT, position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ]).map((unit) => ({
          id: unit.id,
          owner: "p1",
          position: unit.position,
          hp: unit.hp ?? (unit.unitType === "VANGUARD" ? 4 : 2),
          unitType: unit.unitType ?? "WORKER",
          cargo: unit.cargo ?? 0,
        })),
      },
    ],
    terrain: { obstacles: [], resources: opts.terrainResources ?? [[2, 0]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  });
}

function buildCase(world: SimWorld, plan: Plan, caseId = "case-match"): CalibrationCaseV1 {
  const beforeState = projectPlayerState(world, "p1", rules);
  const result = settleTick(world, new Map([["p1", plan]]), { rules, rng: null });
  const afterState = projectPlayerState(result.world, "p1", rules, result.events);
  return {
    schema: "sim-calibration-case-v1",
    caseId,
    tenantId: "p1",
    rulesVersion: "v0.14",
    seed: 42,
    metadata: {
      source: "fixture",
      opponentPlans: "complete",
      recordedAt: null,
      sourceCommit: null,
      runId: null,
    },
    before: { tick: world.tick, state: beforeState },
    plan,
    after: { tick: result.world.tick, state: afterState },
  };
}

function waitPlan(tick: number): Plan {
  return {
    tick,
    unitActions: { [P1_UNIT]: { type: "WAIT" } },
    coreAction: null,
    intents: {},
  };
}

test("S8a: exact one-tick replay → MATCH", () => {
  const calibrationCase = buildCase(makeWorld(), waitPlan(1));
  const report = runCalibrationCase(calibrationCase, MANIFEST_PATH);
  assert.equal(report.status, "MATCH");
  assert.equal(report.differences.length, 0);
  assert.match(report.rulesManifestHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.predictedState, calibrationCase.after.state);
});

test("S8a: old state-only fixture / missing full plan is rejected", () => {
  const calibrationCase = buildCase(makeWorld(), waitPlan(1));
  const { plan: _plan, ...stateOnly } = calibrationCase;
  assert.throws(() => parseCalibrationCase(stateOnly), /root.plan is required/);
});

test("S8a: published JSON Schema pins v1 and requires full plan", () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
    properties: { schema: { const: string } };
    required: string[];
    additionalProperties: boolean;
  };
  assert.equal(schema.properties.schema.const, "sim-calibration-case-v1");
  assert.ok(schema.required.includes("plan"));
  assert.equal(schema.additionalProperties, false);
});

test("S8a: schema is strict and tick relationship fails closed", () => {
  const calibrationCase = buildCase(makeWorld(), waitPlan(1));
  assert.throws(
    () => parseCalibrationCase({ ...calibrationCase, extra: true }),
    /root.extra is not allowed/,
  );
  assert.throws(
    () => parseCalibrationCase({ ...calibrationCase, plan: { ...calibrationCase.plan, tick: 2 } }),
    /plan.tick 2 does not match before.tick 1/,
  );
  assert.throws(
    () => parseCalibrationCase({ ...calibrationCase, after: { ...calibrationCase.after, tick: 9 } }),
    /after.tick 9 must equal before.tick \+ 1/,
  );

  const planWithExtraField = structuredClone(calibrationCase);
  (planWithExtraField.plan.unitActions as Record<string, unknown>)[P1_UNIT] = {
    type: "WAIT",
    extra: true,
  };
  assert.throws(
    () => parseCalibrationCase(planWithExtraField),
    new RegExp(`plan\\.unitActions\\.${P1_UNIT}\\.extra is not allowed`),
  );

  const stateWithInvalidCargo = structuredClone(calibrationCase);
  const controlledWorker = stateWithInvalidCargo.before.state.objects.find(
    (object) => object.kind === "UNIT" && object.controlled === true,
  );
  assert.ok(controlledWorker !== undefined && controlledWorker.kind === "UNIT");
  controlledWorker.controlled = false;
  assert.throws(
    () => parseCalibrationCase(stateWithInvalidCargo),
    /cargo is only valid for controlled Workers/,
  );

  const stateWithEventExtra = structuredClone(
    buildCase(
      makeWorld({
        units: [{ id: P1_UNIT, position: [1, 0], unitType: "WORKER", hp: 2, cargo: 1 }],
        terrainResources: [],
      }),
      {
        tick: 1,
        unitActions: { [P1_UNIT]: { type: "SELF_DESTRUCT" } },
        coreAction: null,
        intents: {},
      },
    ),
  );
  assert.ok(stateWithEventExtra.after.state.events.length > 0);
  (stateWithEventExtra.after.state.events[0] as unknown as Record<string, unknown>).extra = true;
  assert.throws(
    () => parseCalibrationCase(stateWithEventExtra),
    /after\.state\.events\[0\]\.extra is not allowed/,
  );
});

test("S8a: stale rules case is rejected before replay", () => {
  const calibrationCase = buildCase(makeWorld(), waitPlan(1));
  assert.throws(
    () => runCalibrationCase({ ...calibrationCase, rulesVersion: "v0.10" }, MANIFEST_PATH),
    /stale rules: case=v0.10, manifest=v0.14/,
  );
});

test("S8a: v0.11 历史 case 显式回退——rules-v0.11 manifest 仍可 MATCH", () => {
  const v011Rules = loadRulesManifest(V011_MANIFEST_PATH);
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 42,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 5,
        core: { id: P1_CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P1_UNIT, owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [[2, 0]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  });
  const beforeState = projectPlayerState(world, "p1", v011Rules);
  const result = settleTick(world, new Map([["p1", waitPlan(1)]]), { rules: v011Rules, rng: null });
  const afterState = projectPlayerState(result.world, "p1", v011Rules, result.events);
  const v011Case: CalibrationCaseV1 = {
    schema: "sim-calibration-case-v1",
    caseId: "case-v011-fallback",
    tenantId: "p1",
    rulesVersion: "v0.11",
    seed: 42,
    metadata: {
      source: "fixture",
      opponentPlans: "complete",
      recordedAt: null,
      sourceCommit: null,
      runId: null,
    },
    before: { tick: 1, state: beforeState },
    plan: waitPlan(1),
    after: { tick: 2, state: afterState },
  };
  const report = runCalibrationCase(v011Case, V011_MANIFEST_PATH);
  assert.equal(report.status, "MATCH");
  assert.equal(report.differences.length, 0);
});

test("S8a v0.13: cell fire SHOOT（targetId null）通过 case 解析，targeted SHOOT 保持严格", () => {
  const calibrationCase = buildCase(makeWorld(), waitPlan(1));
  const cellFire = structuredClone(calibrationCase);
  (cellFire.plan.unitActions as Record<string, unknown>)[P1_UNIT] = {
    type: "SHOOT",
    targetId: null,
    expectedCell: [2, 0],
  };
  const parsed = parseCalibrationCase(cellFire);
  const action = parsed.plan.unitActions[P1_UNIT];
  assert.equal(action.type, "SHOOT");
  if (action.type === "SHOOT") {
    assert.equal(action.targetId, null);
    assert.deepEqual(action.expectedCell, [2, 0]);
  }

  // 反向严格性：targeted SHOOT 仍必须带非空 targetId，缺 targetId 直接拒绝。
  const targeted = structuredClone(calibrationCase);
  (targeted.plan.unitActions as Record<string, unknown>)[P1_UNIT] = {
    type: "SHOOT",
    expectedCell: [2, 0],
  };
  assert.throws(() => parseCalibrationCase(targeted), /plan\.unitActions\..+\.targetId is required/);
  assert.throws(
    () => parseCalibrationCase({
      ...targeted,
      plan: {
        ...targeted.plan,
        unitActions: {
          [P1_UNIT]: { type: "SHOOT", targetId: "", expectedCell: [2, 0] },
        },
      },
    }),
    /targetId must be a non-empty string/,
  );
});

test("S8a: scalar/entity/terrain/event corruption is classified as MISMATCH", () => {
  const world = makeWorld();
  const plan: Plan = {
    tick: 1,
    unitActions: { [P1_UNIT]: { type: "MOVE", direction: "UP" } },
    coreAction: null,
    intents: {},
  };
  const calibrationCase = buildCase(world, plan, "case-corrupt");
  const after = structuredClone(calibrationCase.after.state);
  after.resources += 1;
  const unit = after.objects.find((object) => object.kind === "UNIT" && object.controlled === true);
  assert.ok(unit !== undefined && unit.kind === "UNIT");
  unit.hp = 1;
  const terrain = after.objects.find((object) => object.kind === "RESOURCE");
  assert.ok(terrain !== undefined && terrain.kind === "RESOURCE");
  (terrain.positions as Position[])[0] = [3, 0];
  assert.ok(after.events.length > 0);
  after.events[0].event_type = "BROKEN_EVENT";

  const report = runCalibrationCase(
    { ...calibrationCase, after: { ...calibrationCase.after, state: after } },
    MANIFEST_PATH,
  );
  assert.equal(report.status, "MISMATCH");
  const classes = new Set(report.differences.map((difference) => difference.class));
  assert.ok(classes.has("STATE"));
  assert.ok(classes.has("ENTITY"));
  assert.ok(classes.has("TERRAIN"));
  assert.ok(classes.has("EVENT"));
});

test("S8a: server-generated spawn UUID is normalized and reported INCONCLUSIVE", () => {
  const world = makeWorld({ units: [], resources: 5, terrainResources: [] });
  const plan: Plan = {
    tick: 1,
    unitActions: {},
    coreAction: { type: "SPAWN", unitType: "WORKER" },
    intents: {},
  };
  const calibrationCase = buildCase(world, plan, "case-spawn");
  const after = structuredClone(calibrationCase.after.state);
  const spawned = after.objects.find((object) => object.kind === "UNIT" && object.controlled === true);
  assert.ok(spawned !== undefined && spawned.kind === "UNIT");
  const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  spawned.id = serverId;
  const spawnEvent = after.events.find((event) => event.event_type === "CORE_SPAWN_SUCCEEDED");
  assert.ok(spawnEvent !== undefined);
  spawnEvent.target_id = serverId;

  const report = runCalibrationCase(
    { ...calibrationCase, after: { ...calibrationCase.after, state: after } },
    MANIFEST_PATH,
  );
  assert.equal(report.status, "INCONCLUSIVE");
  assert.ok(report.differences.some((difference) =>
    difference.class === "EXPECTED_UNKNOWN" && difference.path.includes("server-generated-id"),
  ));
  assert.equal(
    report.differences.some((difference) => ["STATE", "ENTITY", "TERRAIN", "EVENT"].includes(difference.class)),
    false,
  );
});


test("S8a: private respawn placement and replacement UUIDs stay INCONCLUSIVE, not hard mismatch", () => {
  const p2Core = "99999999-9999-9999-9999-999999999999";
  const world = worldFromScenario({
    rulesVersion: "v0.14",
    tick: 1,
    seed: 42,
    players: [
      {
        id: "p1",
        username: "p1",
        status: "RESPAWNING",
        respawnAtTick: 1,
        resources: 0,
        core: null,
        units: [],
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: p2Core, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  });
  const fullResult = settleTick(world, idlePlans(world), { rules, rng: null });
  const beforeState = projectPlayerState(world, "p1", rules);
  const afterState = structuredClone(projectPlayerState(fullResult.world, "p1", rules, fullResult.events));
  const core = afterState.objects.find((object) => object.kind === "CORE" && object.controlled);
  const worker = afterState.objects.find((object) => object.kind === "UNIT" && object.controlled);
  const event = afterState.events.find((candidate) => candidate.event_type === "CORE_RESPAWNED");
  assert.ok(core !== undefined && core.kind === "CORE");
  assert.ok(worker !== undefined && worker.kind === "UNIT");
  assert.ok(event !== undefined);
  const serverCoreId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const serverWorkerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  core.id = serverCoreId;
  worker.id = serverWorkerId;
  event.target_id = serverCoreId;

  const calibrationCase: CalibrationCaseV1 = {
    schema: "sim-calibration-case-v1",
    caseId: "case-respawn-private",
    tenantId: "p1",
    rulesVersion: "v0.14",
    seed: 42,
    metadata: {
      source: "fixture",
      opponentPlans: "complete",
      recordedAt: null,
      sourceCommit: null,
      runId: null,
    },
    before: { tick: world.tick, state: beforeState },
    plan: { tick: world.tick, unitActions: {}, coreAction: null, intents: {} },
    after: { tick: fullResult.world.tick, state: afterState },
  };
  const report = runCalibrationCase(calibrationCase, MANIFEST_PATH);
  assert.equal(report.status, "INCONCLUSIVE");
  assert.ok(report.differences.some((difference) =>
    difference.class === "EXPECTED_UNKNOWN" && difference.path === "$.simulation.respawn-placement",
  ));
  assert.equal(
    report.differences.some((difference) => ["STATE", "ENTITY", "EVENT"].includes(difference.class)),
    false,
  );
});

test("S8a: combat 已实现——SWEEP 无目标时预测与真实差异如实分类 MISMATCH", () => {
  const vanguardId = "33333333-3333-3333-3333-333333333333";
  const world = makeWorld({
    units: [{ id: vanguardId, position: [1, 0], unitType: "VANGUARD", hp: 4 }],
    terrainResources: [],
  });
  const plan: Plan = {
    tick: 1,
    unitActions: { [vanguardId]: { type: "SWEEP", direction: "RIGHT" } },
    coreAction: null,
    intents: {},
  };
  const calibrationCase = buildCase(world, plan, "case-combat");
  const after = structuredClone(calibrationCase.after.state);
  const vanguard = after.objects.find((object) => object.kind === "UNIT" && object.controlled === true);
  assert.ok(vanguard !== undefined && vanguard.kind === "UNIT");
  vanguard.hp = 3;
  const report = runCalibrationCase(
    { ...calibrationCase, after: { ...calibrationCase.after, state: after } },
    MANIFEST_PATH,
  );
  // 单玩家可见世界：SWEEP 目标格无对象 → 模拟器预测 hp 不变；真实 hp 掉 1 无解释 → MISMATCH
  assert.equal(report.status, "MISMATCH");
  assert.ok(report.differences.some((difference) => difference.class === "ENTITY"));
  // combat 不再作为 unsupported feature
  assert.ok(!report.unsupported.includes("combat"));
});

test("S8a: 对手不可观测时 combat 伤害差异是 EXPECTED_UNKNOWN，不误报 MISMATCH", () => {
  const vanguardId = "33333333-3333-3333-3333-333333333333";
  const opponentId = "99999999-9999-9999-9999-999999999999";
  const world = makeWorld({
    units: [{ id: vanguardId, position: [1, 0], unitType: "VANGUARD", hp: 4 }],
    terrainResources: [],
  });
  const plan: Plan = {
    tick: 1,
    unitActions: { [vanguardId]: { type: "SWEEP", direction: "RIGHT" } },
    coreAction: null,
    intents: {},
  };
  const calibrationCase = buildCase(world, plan, "case-combat-opponent");
  const after = structuredClone(calibrationCase.after.state);
  const vanguard = after.objects.find((object) => object.kind === "UNIT" && object.controlled === true);
  assert.ok(vanguard !== undefined && vanguard.kind === "UNIT");
  vanguard.hp = 3;
  // 注入不可观测对手单位（before 中 uncontrolled 对象）→ opponentUnknown=true
  const mutableCase = calibrationCase as unknown as {
    before: { state: { objects: Array<Record<string, unknown>> } };
  };
  mutableCase.before.state.objects.push({
    kind: "UNIT",
    id: opponentId,
    controlled: false,
    position: [2, 0],
    hp: 2,
    unit_type: "WORKER",
    cargo: null,
  });
  const report = runCalibrationCase(
    { ...calibrationCase, after: { ...calibrationCase.after, state: after } },
    MANIFEST_PATH,
  );
  // 对手动作不可观测 → 差异降级 EXPECTED_UNKNOWN，整体 INCONCLUSIVE 而非 MISMATCH
  assert.equal(report.status, "INCONCLUSIVE");
  assert.ok(report.differences.some((difference) => difference.class === "EXPECTED_UNKNOWN"));
  assert.equal(report.differences.some((difference) => difference.class === "ENTITY"), false);
});

test("S8a: refill cadence is explicit EXPECTED_UNKNOWN", () => {
  const world = makeWorld({ tick: 4, terrainResources: [] });
  const calibrationCase = buildCase(world, waitPlan(4), "case-refill");
  const report = runCalibrationCase(calibrationCase, MANIFEST_PATH);
  assert.equal(report.status, "INCONCLUSIVE");
  assert.ok(report.unknownEffects.some((effect) => effect.kind === "refill"));
  assert.ok(report.differences.some((difference) =>
    difference.class === "EXPECTED_UNKNOWN" && difference.path.includes("refill"),
  ));
});

test("S8a: newly revealed hidden terrain is EXPECTED_UNKNOWN, not a rules mismatch", () => {
  const world = makeWorld({
    units: [{ id: P1_UNIT, position: [5, 0], unitType: "WORKER", hp: 2 }],
    terrainResources: [],
  });
  const plan: Plan = {
    tick: 1,
    unitActions: { [P1_UNIT]: { type: "MOVE", direction: "RIGHT" } },
    coreAction: null,
    intents: {},
  };
  const calibrationCase = buildCase(world, plan, "case-hidden-terrain");
  const after = structuredClone(calibrationCase.after.state);
  (after.objects as Array<(typeof after.objects)[number]>).push({
    kind: "RESOURCE",
    positions: [[9, 0]],
  });

  const report = runCalibrationCase(
    { ...calibrationCase, after: { ...calibrationCase.after, state: after } },
    MANIFEST_PATH,
  );
  assert.equal(report.status, "INCONCLUSIVE");
  assert.ok(report.differences.some((difference) =>
    difference.class === "EXPECTED_UNKNOWN" && difference.path.includes("terrain.resources.9,0"),
  ));
  assert.equal(report.differences.some((difference) => difference.class === "TERRAIN"), false);
});

test("S8a: RESOURCE node vs dropped-cargo pile ambiguity is EXPECTED_UNKNOWN", () => {
  const world = makeWorld({
    units: [{ id: P1_UNIT, position: [1, 0], unitType: "WORKER", hp: 2 }],
    terrainResources: [[1, 0]],
  });
  const plan: Plan = {
    tick: 1,
    unitActions: { [P1_UNIT]: { type: "HARVEST" } },
    coreAction: null,
    intents: {},
  };
  const calibrationCase = buildCase(world, plan, "case-pile-ambiguity");
  const after = structuredClone(calibrationCase.after.state);
  const worker = after.objects.find((object) => object.kind === "UNIT" && object.controlled === true);
  assert.ok(worker !== undefined && worker.kind === "UNIT");
  worker.cargo = 2;
  const harvest = after.events.find((event) => event.event_type === "HARVEST_SUCCEEDED");
  assert.ok(harvest !== undefined);
  harvest.values = { amount: 2, source: "DROPPED_CARGO" };
  (after.objects as Array<(typeof after.objects)[number]>).push({
    kind: "RESOURCE",
    positions: [[1, 0]],
  });

  const report = runCalibrationCase(
    { ...calibrationCase, after: { ...calibrationCase.after, state: after } },
    MANIFEST_PATH,
  );
  assert.equal(report.status, "INCONCLUSIVE");
  assert.ok(report.differences.some((difference) =>
    difference.class === "EXPECTED_UNKNOWN" && difference.path.includes("resource-source"),
  ));
  assert.equal(
    report.differences.some((difference) => ["ENTITY", "TERRAIN", "EVENT"].includes(difference.class)),
    false,
  );
});

test("S8a: event phase order is compared and reordering is an EVENT mismatch", () => {
  const world = makeWorld({
    units: [{ id: P1_UNIT, position: [1, 0], unitType: "WORKER", hp: 2, cargo: 1 }],
    terrainResources: [],
  });
  const plan: Plan = {
    tick: 1,
    unitActions: { [P1_UNIT]: { type: "SELF_DESTRUCT" } },
    coreAction: null,
    intents: {},
  };
  const calibrationCase = buildCase(world, plan, "case-event-order");
  assert.ok(calibrationCase.after.state.events.length >= 2);
  const after = structuredClone(calibrationCase.after.state);
  after.events = [...after.events].reverse();

  const report = runCalibrationCase(
    { ...calibrationCase, after: { ...calibrationCase.after, state: after } },
    MANIFEST_PATH,
  );
  assert.equal(report.status, "MISMATCH");
  assert.ok(report.differences.some((difference) => difference.class === "EVENT"));
});

test("S8a: missing opponent full plan makes dynamic differences INCONCLUSIVE", () => {
  const baseCase = buildCase(makeWorld(), waitPlan(1), "case-opponent-unknown");
  const calibrationCase: CalibrationCaseV1 = {
    ...baseCase,
    metadata: { ...baseCase.metadata, opponentPlans: "absent" },
  };
  const before = structuredClone(calibrationCase.before.state);
  (before.objects as Array<(typeof before.objects)[number]>).push({
    kind: "UNIT",
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    controlled: false,
    position: [2, 0],
    hp: 2,
    unit_type: "WORKER",
    cargo: null,
  });
  const after = structuredClone(calibrationCase.after.state);
  const worker = after.objects.find((object) => object.kind === "UNIT" && object.controlled === true);
  assert.ok(worker !== undefined && worker.kind === "UNIT");
  worker.hp = 1;

  const report = runCalibrationCase(
    {
      ...calibrationCase,
      before: { ...calibrationCase.before, state: before },
      after: { ...calibrationCase.after, state: after },
    },
    MANIFEST_PATH,
  );
  assert.equal(report.status, "INCONCLUSIVE");
  assert.ok(report.differences.some((difference) =>
    difference.class === "EXPECTED_UNKNOWN" && difference.path.includes("opponent-action"),
  ));
  assert.equal(report.differences.some((difference) => difference.class === "ENTITY"), false);
});

test("S8a: visibility-limited Beacon status makes harvest bonus differences INCONCLUSIVE", () => {
  const world = makeWorld({
    units: [{ id: P1_UNIT, position: [1, 0], unitType: "WORKER", hp: 2 }],
    terrainResources: [[1, 0]],
  });
  const plan: Plan = {
    tick: 1,
    unitActions: { [P1_UNIT]: { type: "HARVEST" } },
    coreAction: null,
    intents: {},
  };
  const calibrationCase = buildCase(world, plan, "case-beacon-unknown");
  const before = structuredClone(calibrationCase.before.state);
  before.champion_beacon.status = null;
  const after = structuredClone(calibrationCase.after.state);
  after.champion_beacon.status = null;
  const worker = after.objects.find((object) => object.kind === "UNIT" && object.controlled === true);
  assert.ok(worker !== undefined && worker.kind === "UNIT");
  worker.cargo = 2;
  const harvest = after.events.find((event) => event.event_type === "HARVEST_SUCCEEDED");
  assert.ok(harvest !== undefined);
  harvest.values = { amount: 2, source: "RESOURCE_NODE" };

  const report = runCalibrationCase(
    {
      ...calibrationCase,
      before: { ...calibrationCase.before, state: before },
      after: { ...calibrationCase.after, state: after },
    },
    MANIFEST_PATH,
  );
  assert.equal(report.status, "INCONCLUSIVE");
  assert.ok(report.differences.some((difference) =>
    difference.class === "EXPECTED_UNKNOWN" && difference.path.includes("simulation.beacon"),
  ));
  assert.equal(
    report.differences.some((difference) => ["ENTITY", "EVENT", "STATE"].includes(difference.class)),
    false,
  );
});
