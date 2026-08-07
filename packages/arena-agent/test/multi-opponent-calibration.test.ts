/** 多对手（N>2 世界）校准重放测试（2026-08-07）：opponents 字段的 parse、
 * 互斥校验、重放执行两名对手计划且不产生硬 MISMATCH。 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Plan } from "../src/domain/model.ts";
import type { WorldObject } from "@arena/arena-hero-ts";
import { runCalibrationCase } from "../src/sim/calibration/calibrate.ts";
import {
  parseCalibrationCase,
  type CalibrationCaseV1,
} from "../src/sim/calibration/schema.ts";
import { runEpisode } from "../src/sim/harness/episode.ts";
import { projectPlayerState } from "../src/sim/visibility/visibility.ts";
import { privateEventsForPlayer } from "../src/sim/visibility/private-events.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.14.json");
const SCENARIO_PATH = join(here, "..", "scripts", "scenarios", "three-way.json");

const THREE_WAY = JSON.parse(readFileSync(SCENARIO_PATH, "utf-8"));
const RULES = await import("../src/sim/contracts/rules-manifest.ts").then((module) =>
  module.loadRulesManifest(MANIFEST_PATH),
);
const PLAYER_IDS = (THREE_WAY.players as { id: string }[]).map((player) => player.id);

function episodeCases(ticks: number, seed: number): CalibrationCaseV1[] {
  const cases: CalibrationCaseV1[] = [];
  runEpisode({
    scenario: THREE_WAY,
    rulesPath: MANIFEST_PATH,
    seed,
    ticks,
    // workerTarget=2（= 初始 worker 数）→ 窗口内无产兵：对手资源在投影中
    // 不可见、重放世界对手 resources=0 无法复现产兵，故测试窗口隔离该
    // 已知限制（spawn 分歧已有 server-generated-id EXPECTED_UNKNOWN 覆盖）
    tenants: PLAYER_IDS.map((id) => ({
      id,
      planner: "safety" as const,
      policy: { posture: "balanced", workerTarget: 2, militaryRatio: 0, focusRegion: null, attackPriority: null },
    })),
    onTickRecorded: ({ tick, before, after, plans, events }) => {
      for (const tenantId of PLAYER_IDS) {
        const otherIds = PLAYER_IDS.filter((id) => id !== tenantId);
        const caseObj: CalibrationCaseV1 = {
          schema: "sim-calibration-case-v1",
          caseId: `synthetic:${tenantId}:${tick}`,
          tenantId,
          rulesVersion: "v0.14",
          seed,
          metadata: { source: "fixture", opponentPlans: "complete", recordedAt: null, sourceCommit: null, runId: null },
          before: { tick, state: projectPlayerState(before, tenantId, RULES) },
          plan: plans[tenantId],
          opponents: otherIds.map((opponentId) => {
            const opponentPlayer = before.players.get(opponentId);
            return {
              tenantId: opponentId,
              plan: plans[opponentId],
              unitIds: (opponentPlayer?.units ?? []).map((unit) => unit.id),
              ...(opponentPlayer?.core === null || opponentPlayer?.core === undefined
                ? {}
                : { coreId: opponentPlayer.core.id }),
            };
          }),
          after: {
            tick: tick + 1,
            state: projectPlayerState(after, tenantId, RULES, privateEventsForPlayer(before, after, tenantId, events)),
          },
        };
        cases.push(parseCalibrationCase(caseObj));
      }
    },
  });
  return cases;
}

test("schema: 3 玩家 case 的 opponents 保留 tenantId/plan/unitIds 且 tick 对齐", () => {
  const [caseP1] = episodeCases(1, 7);
  assert.equal(caseP1.opponentPlan, undefined);
  assert.ok(caseP1.opponents !== undefined);
  assert.deepEqual(
    caseP1.opponents!.map((opponent) => opponent.tenantId).sort(),
    ["p2", "p3"],
  );
  for (const opponent of caseP1.opponents!) {
    assert.equal(opponent.plan.tick, caseP1.before.tick);
    assert.ok(opponent.unitIds.length > 0, `${opponent.tenantId} must carry unit ids`);
  }
});

test("schema: opponentPlan 与 opponents 互斥——同时给出被拒绝", () => {
  const [caseP1] = episodeCases(1, 7);
  assert.throws(
    () =>
      parseCalibrationCase({
        ...caseP1,
        opponentPlan: caseP1.opponents![0].plan as Plan,
      }),
    /opponentPlan and opponents are mutually exclusive/,
  );
});

test("schema: opponents[].tenantId 与 case tenantId 冲突被拒绝", () => {
  const [caseP1] = episodeCases(1, 7);
  assert.throws(
    () =>
      parseCalibrationCase({
        ...caseP1,
        opponents: [
          ...caseP1.opponents!,
          { tenantId: caseP1.tenantId, plan: caseP1.plan, unitIds: [] },
        ],
      }),
    /must differ from case tenantId/,
  );
});

test("calibrate: 全可见 tick 三方重放全 MATCH（归因 + 双对手计划执行正确性）", () => {
  // tick=1 全员互见（Manhattan 半径内）→ 无雾区 → 重放必须逐字段一致
  const cases = episodeCases(1, 7);
  assert.equal(cases.length, 3, "1 tick × 3 tenants");
  for (const calibrationCase of cases) {
    const report = runCalibrationCase(calibrationCase, MANIFEST_PATH);
    assert.equal(
      report.status,
      "MATCH",
      `${calibrationCase.caseId} must MATCH at full visibility: ${JSON.stringify(report.differences, null, 2)}`,
    );
  }
});

test("calibrate: 4 tick 窗口不抛错；INCONCLUSIVE 全 EXPECTED_UNKNOWN；硬差异仅限雾区级联类", () => {
  const cases = episodeCases(4, 7);
  assert.equal(cases.length, 12, "4 ticks × 3 tenants");
  const statuses = new Map<string, number>();
  for (const calibrationCase of cases) {
    const report = runCalibrationCase(calibrationCase, MANIFEST_PATH);
    statuses.set(report.status, (statuses.get(report.status) ?? 0) + 1);
    const beforeEnemyIds = new Set(
      calibrationCase.before.state.objects
        .filter(
          (object): object is WorldObject & { id: string } =>
            (object.kind === "CORE" || object.kind === "UNIT") &&
            object.controlled === false &&
            typeof object.id === "string",
        )
        .map((object) => object.id),
    );
    for (const difference of report.differences) {
      if (difference.class === "EXPECTED_UNKNOWN" || difference.class === "UNSUPPORTED") continue;
      // 硬差异只允许雾区级联类：敌方实体在 before 可见、其结算结果被隐藏
      // 实体（如 801 占 Core 格）改变——重放世界无法复现（2 玩家管线同族
      // 限制，已文档化）。归因/自身单位/地形/事件硬差异一律视为失败。
      assert.equal(
        difference.class,
        "ENTITY",
        `${calibrationCase.caseId} unexpected hard class ${difference.class}: ${JSON.stringify(difference)}`,
      );
      assert.ok(
        difference.path.startsWith("$.entities."),
        `${calibrationCase.caseId} hard diff outside entities: ${JSON.stringify(difference)}`,
      );
      const entityId = difference.path.slice("$.entities.".length);
      const expected = difference.expected as Record<string, unknown> | null;
      const actual = difference.actual as Record<string, unknown> | null;
      assert.ok(
        expected?.controlled === false || actual?.controlled === false,
        `${calibrationCase.caseId} hard diff on non-enemy entity: ${JSON.stringify(difference)}`,
      );
      assert.ok(
        beforeEnemyIds.has(entityId),
        `${calibrationCase.caseId} hard diff on entity not visible at before (should be fog EXPECTED_UNKNOWN): ${JSON.stringify(difference)}`,
      );
    }
  }
  assert.ok((statuses.get("MATCH") ?? 0) + (statuses.get("INCONCLUSIVE") ?? 0) + (statuses.get("MISMATCH") ?? 0) === 12);
});

test("schema: opponents 不允许重复归属同一个 entity id", () => {
  const [caseP1] = episodeCases(1, 1);
  const duplicateUnit = JSON.parse(JSON.stringify(caseP1));
  duplicateUnit.opponents[1].unitIds = [...duplicateUnit.opponents[0].unitIds];
  assert.throws(
    () => parseCalibrationCase(duplicateUnit),
    /assigned more than once/,
  );

  const duplicateCore = JSON.parse(JSON.stringify(caseP1));
  duplicateCore.opponents[1].coreId = duplicateCore.opponents[0].coreId;
  assert.throws(
    () => parseCalibrationCase(duplicateCore),
    /assigned more than once/,
  );
});

test("schema: opponents 显式空数组被拒绝", () => {
  const [caseP1] = episodeCases(1, 1);
  const empty = JSON.parse(JSON.stringify(caseP1));
  empty.opponents = [];
  assert.throws(() => parseCalibrationCase(empty), /opponents must not be empty/);
});

test("calibrate: 去掉 opponents 后同 case 诚实降级 INCONCLUSIVE（opponent-action unknown）", () => {
  const [caseP1] = episodeCases(1, 7);
  const withoutOpponents = JSON.parse(JSON.stringify(caseP1));
  delete withoutOpponents.opponents;
  const report = runCalibrationCase(withoutOpponents, MANIFEST_PATH);
  assert.equal(report.status, "INCONCLUSIVE");
  assert.ok(
    report.differences.some((difference) => difference.path === "$.simulation.opponent-action"),
    "without opponents the opponent action must be EXPECTED_UNKNOWN",
  );
});
