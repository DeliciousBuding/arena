/**
 * 联盟 no-fire 执行面测试（2026-08-08，alliance-no-fire-v1）：
 * 1) UNIT/CORE 友军从可见敌人中剔除（knownAllianceEntityId => never target，
 *    spec §5.5——敌方 UNIT 视图无 owner_username，只能按实体 id）；
 * 2) 真敌人照常打击（roster 只过滤已知友军 id）；
 * 3) 空 roster / 无 rosterRef = 零回归（alliedFilteredCount=0）；
 * 4) roster 文件契约往返（原子写 → 读取 → 解析；损坏降级 null）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { type AllianceRosterRef, EMPTY_ROSTER_ID_SET } from "../src/alliance/roster-file.ts";
import {
  ALLIANCE_ROSTER_SCHEMA,
  parseRosterFile,
  writeAllianceRosterFile,
  loadAllianceRosterFile,
  allianceRuntimeDir,
} from "../src/alliance/roster-file.ts";

function enemyUnit(id: string, position: Position, unitType: "VANGUARD" | "RANGER" = "RANGER"): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 4, unitType };
}

function enemyCore(id: string, position: Position, owner?: string): VisibleEntity {
  return { id, kind: "CORE", position, hp: 5, unitType: "VANGUARD", ownerUsername: owner };
}

function makeState(enemies: VisibleEntity[]): TickState {
  const ranger = { id: "r1", position: [1, 0] as Position, hp: 4, unitType: "RANGER" as const, cargo: 0 };
  return {
    tick: 1,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [ranger],
    workers: [],
    vanguards: [],
    rangers: [ranger],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const AGGRESSIVE = {
  ...DEFAULT_SAFETY_CONFIG,
  aggression: "aggressive" as const,
};

function shootTargets(planner: SafetyPlanner, state: TickState): string[] {
  const plan = planner.decide({ state });
  return Object.values(plan.unitActions)
    .filter((a) => a.type === "SHOOT")
    .map((a) => a.targetId)
    .filter((id): id is string => id !== null);
}

test("no-fire：联盟友军 UNIT 不被打击，真敌人照常", () => {
  const rosterRef: AllianceRosterRef = { allyEntityIds: new Set(["ally-u1", "ally-core"]) };
  const planner = new SafetyPlanner(AGGRESSIVE, undefined, undefined, rosterRef);
  // Ranger 射程 3：友军 UNIT [2,0] 与真敌 UNIT [3,0] 都在射程内
  const targets = shootTargets(planner, makeState([
    enemyUnit("ally-u1", [2, 0]),
    enemyUnit("enemy-e1", [3, 0]),
  ]));
  assert.ok(targets.includes("enemy-e1"), `应打真敌人，实际 targets=${JSON.stringify(targets)}`);
  assert.ok(!targets.includes("ally-u1"), `不得打友军，实际 targets=${JSON.stringify(targets)}`);
  assert.equal(planner.alliedFilteredCount, 1, "应过滤 1 个友军");
});

test("no-fire：联盟友军 CORE 不被攻坚/打击", () => {
  const rosterRef: AllianceRosterRef = { allyEntityIds: new Set(["ally-u1", "ally-core"]) };
  const planner = new SafetyPlanner(AGGRESSIVE, undefined, undefined, rosterRef);
  const targets = shootTargets(planner, makeState([
    enemyCore("ally-core", [2, 0]),
    enemyUnit("enemy-e2", [3, 0]),
  ]));
  assert.ok(targets.includes("enemy-e2"), `应打真敌人，实际 targets=${JSON.stringify(targets)}`);
  assert.ok(!targets.includes("ally-core"), `不得打友军核心，实际 targets=${JSON.stringify(targets)}`);
  assert.equal(planner.alliedFilteredCount, 1);
});

test("no-fire：无 rosterRef / 空集合 = 零回归", () => {
  const planner = new SafetyPlanner(AGGRESSIVE);
  const targets = shootTargets(planner, makeState([
    enemyUnit("u1", [2, 0]),
    enemyUnit("u2", [3, 0]),
  ]));
  assert.equal(planner.alliedFilteredCount, 0);
  assert.equal(targets.length, 1, "无 roster 时照常打最近敌人");
});

test("no-fire：只有友军在射程内时不空火友军", () => {
  const rosterRef: AllianceRosterRef = { allyEntityIds: new Set(["ally-u1"]) };
  const planner = new SafetyPlanner(AGGRESSIVE, undefined, undefined, rosterRef);
  const targets = shootTargets(planner, makeState([enemyUnit("ally-u1", [2, 0])]));
  assert.ok(!targets.includes("ally-u1"), `不得打友军，实际 targets=${JSON.stringify(targets)}`);
  assert.equal(planner.alliedFilteredCount, 1);
});

// ---------- roster 文件契约 ----------

test("roster 文件：原子写 → 读取往返；损坏降级 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-roster-"));
  try {
    const file = {
      schema: "alliance-roster-file-v1" as const,
      revision: 7,
      updatedAtMs: 123456789,
      allyEntityIds: ["core-a", "unit-1"],
    };
    writeAllianceRosterFile(dir, file);
    const loaded = loadAllianceRosterFile(dir);
    assert.ok(loaded !== null);
    assert.equal(loaded.revision, 7);
    assert.deepEqual([...loaded.allyEntityIds].sort(), ["core-a", "unit-1"]);
    // 缺失目录 → null
    assert.equal(loadAllianceRosterFile(join(dir, "missing")), null);
    // 损坏 → null
    writeFileSync(join(allianceRuntimeDir(dir), "roster.json"), "{not json", "utf8");
    assert.equal(loadAllianceRosterFile(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseRosterFile：非法 schema/字段降级 null", () => {
  assert.equal(parseRosterFile("{bad"), null);
  assert.equal(parseRosterFile(JSON.stringify({ schema: "other", allyEntityIds: [] })), null);
  assert.equal(parseRosterFile(JSON.stringify({ schema: ALLIANCE_ROSTER_SCHEMA, allyEntityIds: "x" })), null);
  const ok = parseRosterFile(JSON.stringify({ schema: ALLIANCE_ROSTER_SCHEMA, revision: 1, updatedAtMs: 2, allyEntityIds: ["a", "a", "b"] }));
  assert.ok(ok !== null);
  assert.deepEqual([...ok.allyEntityIds], ["a", "b"], "去重 + 排序");
});
