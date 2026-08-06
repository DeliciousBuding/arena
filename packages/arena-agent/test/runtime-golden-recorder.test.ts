/** S8b Runtime-Golden recorder: integrity, pairing and fail-open tests. */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Accepted, PlayerState } from "@arena/arena-hero-ts";
import type { Plan } from "../src/domain/model.ts";
import type { TickOutcome } from "../src/runtime/loop.ts";
import { sha256Canonical } from "../src/domain/integrity.ts";
import { RuntimeGoldenRecorder, type RuntimeGoldenDatasetManifest } from "../src/runtime-golden/recorder.ts";
import { parseCalibrationCase } from "../src/sim/calibration/schema.ts";

const WORKER = "22222222-2222-2222-2222-222222222222";

function state(resources: number): PlayerState {
  return {
    status: "ACTIVE",
    respawn_at_tick: null,
    resources,
    population: 1,
    population_tier: 0,
    upkeep_next_tick: 0,
    champion_beacon: { position: [10, 10], status: "GROUND", carrier_id: null },
    objects: [
      {
        kind: "CORE",
        id: "11111111-1111-1111-1111-111111111111",
        controlled: true,
        owner_username: "fixture",
        position: [0, 0],
        hp: 5,
        shield: 5,
        state: "NORMAL",
        move_direction: null,
        move_progress: null,
        move_required_ticks: null,
        destination: null,
      },
      {
        kind: "UNIT",
        id: WORKER,
        controlled: true,
        position: [1, 0],
        hp: 2,
        unit_type: "WORKER",
        cargo: 0,
      },
    ],
    events: [],
  };
}

function plan(tick: number): Plan {
  return {
    tick,
    unitActions: { [WORKER]: { type: "WAIT" } },
    coreAction: null,
    intents: { [WORKER]: "fixture" },
  };
}

/** v0.13+ cell fire：Ranger SHOOT 不带 targetId（空格射击），targetId 显式 null。 */
function cellFirePlan(tick: number): Plan {
  return {
    tick,
    unitActions: { [WORKER]: { type: "SHOOT", targetId: null, expectedCell: [2, 0] } },
    coreAction: null,
    intents: { [WORKER]: "fixture_cell_fire" },
  };
}

function receipt(tick: number): Accepted {
  return {
    accepted: true,
    tick,
    source: "AGENT",
    received_at: `2026-08-03T00:00:${String(tick % 60).padStart(2, "0")}Z`,
  };
}

function outcome(
  tick: number,
  rawState: PlayerState,
  submitted: boolean,
  planOverride: Plan = plan(tick),
): TickOutcome {
  return {
    tick,
    source: "deterministic",
    originalSource: "deterministic",
    repairCount: 0,
    plan: planOverride,
    accepted: submitted,
    submitAttempted: submitted,
    state: {
      tick,
      status: "ACTIVE",
      resources: rawState.resources,
      resourceCapacity: 10,
      resourceSpace: 10 - rawState.resources,
      population: 1,
      beacon: { position: [10, 10], status: "GROUND", carrierId: null },
      core: null,
      units: [],
      workers: [],
      vanguards: [],
      rangers: [],
      visibleEnemies: [],
      obstacleCells: new Set(),
      resourceCells: new Set(),
      events: [],
    },
    rawState,
    ...(submitted ? { receipt: receipt(tick) } : {}),
  };
}

function makeRecorder(outputDir: string, warnings: string[] = []): RuntimeGoldenRecorder {
  return new RuntimeGoldenRecorder({
    outputDir,
    processRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tenantId: "t1",
    rulesVersion: "v0.14",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    configHash: `sha256:${"a".repeat(64)}`,
    onWarning: (message) => warnings.push(message),
  });
}

test("S8b: accepted plan + next raw state → strict case + integrity manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-golden-"));
  try {
    const recorder = makeRecorder(root);
    recorder.observe(outcome(10, state(4), true));
    recorder.observe(outcome(11, state(5), false));
    const result = await recorder.close();

    assert.equal(result.caseCount, 1);
    assert.equal(result.errorCount, 0);
    assert.equal(result.droppedPending, 0);
    assert.ok(existsSync(result.manifestPath));

    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as RuntimeGoldenDatasetManifest;
    assert.equal(manifest.schema, "runtime-golden-dataset-v1");
    assert.equal(manifest.caseCount, 1);
    assert.equal(manifest.rulesVersion, "v0.14", "recorder 落盘 rulesVersion 跟随 options（默认 v0.14）");
    assert.equal(manifest.cases[0]?.receipt.tick, 10);
    const casePath = join(root, manifest.cases[0]!.file);
    const rawCase = JSON.parse(readFileSync(casePath, "utf8"));
    const parsed = parseCalibrationCase(rawCase);
    assert.equal(parsed.before.state.resources, 4);
    assert.equal(parsed.after.state.resources, 5);
    assert.equal(parsed.plan.tick, 10);
    assert.equal(manifest.cases[0]!.caseSha256, sha256Canonical(rawCase));
    assert.equal(manifest.cases[0]!.beforeSha256, sha256Canonical(rawCase.before));
    assert.equal(manifest.cases[0]!.planSha256, sha256Canonical(rawCase.plan));
    assert.equal(manifest.cases[0]!.afterSha256, sha256Canonical(rawCase.after));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S8b: v0.11 显式回退——options.rulesVersion=v0.11 仍落盘 v0.11 case", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-golden-"));
  try {
    const recorder = new RuntimeGoldenRecorder({
      outputDir: root,
      processRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      tenantId: "t1",
      rulesVersion: "v0.11",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      configHash: `sha256:${"a".repeat(64)}`,
    });
    recorder.observe(outcome(10, state(4), true));
    recorder.observe(outcome(11, state(5), false));
    const result = await recorder.close();
    assert.equal(result.caseCount, 1);
    assert.equal(result.errorCount, 0);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as RuntimeGoldenDatasetManifest;
    assert.equal(manifest.rulesVersion, "v0.11", "显式 v0.11 options 不得被默认版本覆盖");
    const rawCase = JSON.parse(readFileSync(join(root, manifest.cases[0]!.file), "utf8"));
    assert.equal(rawCase.rulesVersion, "v0.11");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S8b v0.13: cell fire SHOOT（targetId null）plan 正常落盘不丢弃", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-golden-"));
  try {
    const recorder = makeRecorder(root);
    recorder.observe(outcome(10, state(4), true, cellFirePlan(10)));
    recorder.observe(outcome(11, state(5), false));
    const result = await recorder.close();

    assert.equal(result.caseCount, 1, "cell fire plan 不得因 targetId null 被丢弃");
    assert.equal(result.errorCount, 0);
    const rawCase = JSON.parse(readFileSync(join(root, "cases", "0000000010.json"), "utf8"));
    const parsed = parseCalibrationCase(rawCase);
    const action = parsed.plan.unitActions[WORKER];
    assert.equal(action.type, "SHOOT");
    if (action.type === "SHOOT") {
      assert.equal(action.targetId, null);
      assert.deepEqual(action.expectedCell, [2, 0]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S8b: missing drain drops pending case instead of forging after state", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-golden-"));
  const warnings: string[] = [];
  try {
    const recorder = makeRecorder(root, warnings);
    recorder.observe(outcome(10, state(4), true));
    const result = await recorder.close();
    assert.equal(result.caseCount, 0);
    assert.equal(result.droppedPending, 1);
    assert.ok(warnings.some((message) => message.includes("no next raw state")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S8b: v0.14 state 缺 maintenance 字段 → case 落盘显式 null，不按旧协议推导", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-golden-"));
  try {
    const recorder = makeRecorder(root);
    // 2026-08-06 生产 dump 真实形态：服务器不再下发 population_tier /
    // upkeep_next_tick，normalize 后为 null。
    const v014Before = structuredClone(state(4)) as PlayerState;
    v014Before.population_tier = null;
    v014Before.upkeep_next_tick = null;
    const v014After = structuredClone(state(5)) as PlayerState;
    v014After.population_tier = null;
    v014After.upkeep_next_tick = null;
    recorder.observe(outcome(10, v014Before, true));
    recorder.observe(outcome(11, v014After, false));
    const result = await recorder.close();

    // 若此断言失败，说明 case 契约解析器（sim/calibration/schema.ts）尚未
    // 放宽为可接受 null（共享 schema 已放宽为 integer|null，待同步）。
    assert.equal(result.caseCount, 1, "null maintenance fields must pass the case contract");
    assert.equal(result.errorCount, 0);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as RuntimeGoldenDatasetManifest;
    const rawCase = JSON.parse(readFileSync(join(root, manifest.cases[0]!.file), "utf8"));
    // 真实 dump 形态：服务器未下发的字段必须原样落盘为显式 null，而不是
    // 用旧协议公式（floor(population/20) 等）推导出的伪装值。
    assert.equal(rawCase.before.state.population_tier, null, "before.population_tier must stay null");
    assert.equal(rawCase.before.state.upkeep_next_tick, null, "before.upkeep_next_tick must stay null");
    assert.equal(rawCase.after.state.population_tier, null, "after.population_tier must stay null");
    assert.equal(rawCase.after.state.upkeep_next_tick, null, "after.upkeep_next_tick must stay null");
    // 契约往返：共享 schema optional 后，case 解析器应能接受并保留 null。
    const parsed = parseCalibrationCase(rawCase);
    assert.equal(parsed.before.state.population_tier, null);
    assert.equal(parsed.before.state.upkeep_next_tick, null);
    assert.equal(parsed.after.state.population_tier, null);
    assert.equal(parsed.after.state.upkeep_next_tick, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S8b: 旧消息（服务器仍下发 maintenance 值）原样保留，不改写为 null", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-golden-"));
  try {
    const recorder = makeRecorder(root);
    const legacyBefore = structuredClone(state(4)) as PlayerState;
    legacyBefore.population_tier = 7;
    legacyBefore.upkeep_next_tick = 9;
    const legacyAfter = structuredClone(state(5)) as PlayerState;
    legacyAfter.population_tier = 7;
    legacyAfter.upkeep_next_tick = 9;
    recorder.observe(outcome(10, legacyBefore, true));
    recorder.observe(outcome(11, legacyAfter, false));
    const result = await recorder.close();

    assert.equal(result.caseCount, 1);
    assert.equal(result.errorCount, 0);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as RuntimeGoldenDatasetManifest;
    const rawCase = JSON.parse(readFileSync(join(root, manifest.cases[0]!.file), "utf8"));
    assert.equal(rawCase.before.state.population_tier, 7, "server-provided value must be preserved");
    assert.equal(rawCase.before.state.upkeep_next_tick, 9, "server-provided value must be preserved");
    assert.equal(rawCase.after.state.population_tier, 7, "server-provided value must be preserved");
    assert.equal(rawCase.after.state.upkeep_next_tick, 9, "server-provided value must be preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S8b: one invalid case does not poison the next valid state pair", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-golden-"));
  try {
    const recorder = makeRecorder(root);
    const invalid = structuredClone(state(4)) as PlayerState;
    invalid.population = 9;
    recorder.observe(outcome(10, invalid, true));
    recorder.observe(outcome(11, state(4), true));
    recorder.observe(outcome(12, state(5), false));
    const result = await recorder.close();
    assert.equal(result.errorCount, 1, "第一个非法 case 显式报错");
    assert.equal(result.caseCount, 1, "后续合法 pair 仍必须落盘");
    assert.equal(result.droppedPending, 0);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as RuntimeGoldenDatasetManifest;
    assert.equal(manifest.cases[0]?.tick, 11);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S8b: server field fingerprint change writes a version_fingerprint warning line", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-golden-"));
  try {
    const warningPath = join(root, "telemetry", "calibration-recorder.jsonl");
    const recorder = new RuntimeGoldenRecorder({
      outputDir: root,
      processRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      tenantId: "t1",
      rulesVersion: "v0.11",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      configHash: `sha256:${"a".repeat(64)}`,
      versionFingerprintLogPath: warningPath,
    });
    // Legacy protocol: the server sends population_tier / upkeep_next_tick.
    recorder.observe(outcome(10, state(4), true));
    recorder.observe(outcome(11, state(5), false));
    // v0.14 protocol: the server no longer sends the fields (null after normalize).
    const v014Before = structuredClone(state(6)) as PlayerState;
    v014Before.population_tier = null;
    v014Before.upkeep_next_tick = null;
    const v014After = structuredClone(state(7)) as PlayerState;
    v014After.population_tier = null;
    v014After.upkeep_next_tick = null;
    recorder.observe(outcome(12, v014Before, true));
    recorder.observe(outcome(13, v014After, false));
    const result = await recorder.close();
    assert.equal(result.caseCount, 2, "fingerprint warning must not affect case persistence");
    assert.equal(result.errorCount, 0);
    const lines = readFileSync(warningPath, "utf8").trim().split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 1, "exactly one warning per fingerprint change");
    assert.equal(lines[0]!.type, "version_fingerprint");
    assert.equal(lines[0]!.fingerprint, "population_tier=absent;upkeep_next_tick=absent");
    assert.equal(lines[0]!.previousFingerprint, "population_tier=present;upkeep_next_tick=present");
    assert.equal(typeof lines[0]!.at, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S8b: write failure is fail-open and becomes explicit recorder error", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-golden-"));
  const warnings: string[] = [];
  try {
    const recorder = makeRecorder(root, warnings);
    rmSync(join(root, "cases"), { recursive: true, force: true });
    writeFileSync(join(root, "cases"), "not-a-directory", "utf8");
    recorder.observe(outcome(10, state(4), true));
    recorder.observe(outcome(11, state(5), false));
    const result = await recorder.close();
    assert.equal(result.caseCount, 0);
    assert.ok(result.errorCount >= 1);
    assert.ok(warnings.some((message) => message.startsWith("case:10:")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
