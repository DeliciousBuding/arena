/**
 * Alliance shadow 测试（2026-08-08，spec Phase 1 收尾）：
 * 1) observationsFromState：受控实体 → roster id；可见敌人 → 目击；
 * 2) AllianceShadowWriter：跨 tick 目击累积去重、不可见衰减、interval 输出、
 *    JSONL 帧形状（schema alliance-shadow-snapshot-v1）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { observationsFromState, AllianceShadowWriter } from "../src/alliance/shadow.ts";
import type { TickState, VisibleEntity } from "../src/domain/model.ts";

function makeState(
  tick: number,
  opts: {
    enemies?: VisibleEntity[];
    units?: { id: string; unitType: "WORKER" | "VANGUARD" | "RANGER" }[];
    coreId?: string;
  } = {},
): TickState {
  const units = (opts.units ?? [{ id: "u1", unitType: "WORKER" as const }]).map((u) => ({
    id: u.id, position: [0, 0] as const, hp: 2, unitType: u.unitType, cargo: 0,
  }));
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 20,
    resourceSpace: 10,
    population: units.length,
    core: { id: opts.coreId ?? "core-1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "buding" },
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: units.filter((u) => u.unitType === "VANGUARD"),
    rangers: units.filter((u) => u.unitType === "RANGER"),
    visibleEnemies: opts.enemies ?? [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [10, 0], status: "GROUND", carrierId: null },
    events: [],
  };
}

test("observationsFromState：受控实体 → roster，可见敌人 → 目击", () => {
  const state = makeState(100, {
    units: [{ id: "u1", unitType: "WORKER" }, { id: "u2", unitType: "VANGUARD" }],
    enemies: [
      { id: "e1", kind: "UNIT", position: [5, 5], hp: 2, unitType: "VANGUARD" },
      { id: "c-enemy", kind: "CORE", position: [20, 20], hp: 5, ownerUsername: "jerkman" },
    ],
  });
  const { alliedIds, observations } = observationsFromState(state, "t2");
  assert.deepEqual([...alliedIds].sort(), ["core-1", "u1", "u2"]);
  assert.equal(observations.length, 2);
  assert.equal(observations[0].tenantId, "t2");
  assert.equal(observations[0].controlled, false);
  assert.ok(observations.some((o) => o.kind === "CORE" && o.ownerUsername === "jerkman"));
});

test("AllianceShadowWriter：跨 tick 累积去重 + 不可见衰减 + interval 帧", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-shadow-"));
  const path = join(dir, "alliance-shadow.jsonl");
  try {
    const writer = new AllianceShadowWriter({
      tenantId: "t2",
      processRunId: "run-1",
      path,
      intervalTicks: 4,
    });
    // tick 100：1 个可见战斗单位
    writer.onState(makeState(100, {
      enemies: [{ id: "e1", kind: "UNIT", position: [5, 5], hp: 2, unitType: "VANGUARD" }],
    }));
    // tick 101-103：同单位仍可见（去重累积）
    for (let t = 101; t <= 103; t += 1) {
      writer.onState(makeState(t, {
        enemies: [{ id: "e1", kind: "UNIT", position: [6, 6], hp: 2, unitType: "VANGUARD" }],
      }));
    }
    // tick 104：e1 消失（新敌人 e2）→ 该帧应输出
    writer.onState(makeState(104, {
      enemies: [{ id: "e2", kind: "UNIT", position: [10, 10], hp: 2, unitType: "RANGER" }],
    }));
    const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    // 首帧立即输出（tick 100），之后每 interval（4）一帧（tick 104）
    assert.equal(lines.length, 2);
    assert.equal(lines[0].tick, 100);
    const rec = lines[1];
    assert.equal(rec.schema, "alliance-shadow-snapshot-v1");
    assert.equal(rec.tenantId, "t2");
    assert.equal(rec.tick, 104);
    // 历史目击条数（审计）：e1 4 条 + e2 1 条
    assert.equal(rec.counts.historicalSightingCount, 5);
    // unique 战斗实体：e1 + e2 = 2
    assert.equal(rec.counts.recentUniqueCombat, 2);
    // e1 已不可见（衰减 <1），e2 可见
    const enemies: Array<{ key: string; currentlyVisible: boolean; confidence: number }> = rec.enemies;
    const e1 = enemies.find((x) => x.key === "UNIT:e1");
    const e2 = enemies.find((x) => x.key === "UNIT:e2");
    assert.ok(e1 !== undefined, "e1 missing");
    assert.ok(e2 !== undefined, "e2 missing");
    assert.equal(e1.currentlyVisible, false);
    assert.ok(e1.confidence < 1);
    assert.equal(e2.currentlyVisible, true);
    assert.equal(e2.confidence, 1);
    // roster：核心 + 每 tick 的单位（u1）→ 1 core + 1 unit
    assert.ok(rec.allyCount >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
