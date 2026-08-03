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
import {
  RuntimeGoldenRecorder,
  type RuntimeGoldenDatasetManifest,
} from "../src/runtime-golden/recorder.ts";
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

function receipt(tick: number): Accepted {
  return {
    accepted: true,
    tick,
    source: "AGENT",
    received_at: `2026-08-03T00:00:${String(tick % 60).padStart(2, "0")}Z`,
  };
}

function outcome(tick: number, rawState: PlayerState, submitted: boolean): TickOutcome {
  return {
    tick,
    source: "deterministic",
    originalSource: "deterministic",
    repairCount: 0,
    plan: plan(tick),
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
    rulesVersion: "v0.11",
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
