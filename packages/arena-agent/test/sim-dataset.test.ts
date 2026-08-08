/** P1-1 offline dataset builder tests. */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { sha256Canonical } from "../src/domain/integrity.ts";
import { buildDataset } from "../src/sim/dataset/builder.ts";
import { validateMlSample } from "../src/sim/dataset/validate-sample.ts";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_SHARED_SCHEMA_DIR = join(PKG_ROOT, "test", "fixtures", "shared-data", "schema");
const RULES = join(PKG_ROOT, "src", "sim", "contracts", "rules-v0.14.json");
const RULES_V011 = join(PKG_ROOT, "src", "sim", "contracts", "rules-v0.11.json");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CORE = "11111111-1111-1111-1111-111111111111";
const WORKER = "22222222-2222-2222-2222-222222222222";
const OPPONENT = "99999999-9999-9999-9999-999999999999";

interface CaseOptions {
  readonly afterResources?: number;
  readonly workerAliveAfter?: boolean;
  readonly opponent?: boolean;
  readonly source?: "fixture" | "live-recorder";
  readonly runId?: string;
}

function stateAt(resources: number, opts: { workerAlive?: boolean; opponent?: boolean } = {}) {
  const objects: unknown[] = [
    {
      kind: "CORE", id: CORE, controlled: true, owner_username: "t1", position: [0, 0],
      hp: 5, shield: 5, state: "NORMAL", move_direction: null, move_progress: null,
      move_required_ticks: null, destination: null,
    },
  ];
  if (opts.workerAlive !== false) {
    objects.push({
      kind: "UNIT", id: WORKER, controlled: true, position: [1, 0], hp: 2,
      unit_type: "WORKER", cargo: 0,
    });
  }
  if (opts.opponent) {
    objects.push({
      kind: "UNIT", id: OPPONENT, controlled: false, position: [5, 5], hp: 2,
      unit_type: "WORKER", cargo: null,
    });
  }
  return {
    status: "ACTIVE", respawn_at_tick: null, resources,
    // v0.14 起服务器不再下发 maintenance 字段，normalize 后为 null；case
    // 契约允许 integer|null，与模拟器 v0.14 投影一致（避免伪 MISMATCH）。
    population: opts.workerAlive === false ? 0 : 1, population_tier: null, upkeep_next_tick: null,
    champion_beacon: { position: [3, 1], status: "GROUND", carrier_id: null },
    objects,
    events: [],
  };
}

/** A hand-built deterministic case (verified: MATCH for plain no-op cases). */
function makeCase(
  processRunId: string,
  tick: number,
  runId: string,
  options: CaseOptions = {},
): Record<string, unknown> {
  const opponent = options.opponent ?? false;
  const before = stateAt(10, { workerAlive: true, opponent });
  const after = stateAt(options.afterResources ?? 10, {
    workerAlive: options.workerAliveAfter ?? true,
    opponent,
  });
  return {
    schema: "sim-calibration-case-v1",
    caseId: `${processRunId}:${tick}`,
    tenantId: "t1",
    rulesVersion: "v0.14",
    seed: 0,
    metadata: {
      source: options.source ?? "fixture",
      opponentPlans: opponent ? "absent" : "complete",
      recordedAt: null,
      sourceCommit: COMMIT,
      runId,
    },
    before: { tick, state: before },
    plan: { tick, unitActions: {}, coreAction: null, intents: {} },
    after: { tick: tick + 1, state: after },
  };
}

interface TestDataset {
  readonly root: string;
  readonly dataRoot: string;
  readonly manifestPath: string;
}

/** Write a runtime-golden dataset under <root>/runtime/t1/calibration/<id>. */
function writeDataset(
  root: string,
  processRunId: string,
  cases: readonly Record<string, unknown>[],
): TestDataset {
  const datasetDir = join(root, "runtime", "t1", "calibration", processRunId);
  const casesDir = join(datasetDir, "cases");
  mkdirSync(casesDir, { recursive: true });
  const manifest = {
    schema: "runtime-golden-dataset-v1",
    datasetId: processRunId,
    tenantId: "t1",
    rulesVersion: "v0.14",
    sourceCommit: COMMIT,
    configHash: `sha256:${"a".repeat(64)}`,
    startedAt: "2026-08-03T00:00:00Z",
    completedAt: "2026-08-03T00:00:01Z",
    caseCount: cases.length,
    skippedRejected: 0,
    droppedPending: 0,
    errorCount: 0,
    cases: cases.map((caseValue, index) => {
      const tick = (caseValue.before as { tick: number }).tick;
      const file = `cases/${String(index + 1).padStart(10, "0")}.json`;
      return {
        caseId: caseValue.caseId,
        tick,
        file,
        caseSha256: sha256Canonical(caseValue),
        beforeSha256: sha256Canonical(caseValue.before),
        planSha256: sha256Canonical(caseValue.plan),
        afterSha256: sha256Canonical(caseValue.after),
        receipt: { accepted: true, tick, source: "AGENT", receivedAt: "2026-08-03T00:00:00Z" },
      };
    }),
    errors: [],
  };
  writeFileSync(join(datasetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  for (const [index, caseValue] of cases.entries()) {
    writeFileSync(
      join(casesDir, `${String(index + 1).padStart(10, "0")}.json`),
      `${JSON.stringify(caseValue, null, 2)}\n`,
      "utf8",
    );
  }
  return { root, dataRoot: root, manifestPath: join(datasetDir, "manifest.json") };
}

function buildOptions(dataset: TestDataset, overrides: Partial<Parameters<typeof buildDataset>[0]> = {}) {
  return {
    inputPath: dataset.manifestPath,
    rulesPath: RULES,
    dataRoot: dataset.dataRoot,
    ...overrides,
  };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Authoritative cross-check against the real shared schemas via ajv. */
function createSchemaValidator() {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Ajv2020 = require("ajv/dist/2020.js") as new (options: object) => {
    addSchema(schema: unknown, key: string): void;
    addFormat(name: string, definition: object): void;
    validate(key: string, instance: unknown): boolean;
  };
  const validator = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  validator.addFormat("date-time", {
    type: "string",
    validate: (value: string) =>
      /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u.test(value) &&
      Number.isFinite(Date.parse(value)),
  });
  validator.addFormat("uri-reference", {
    type: "string",
    validate: (value: string) =>
      !/[\u0000-\u0020\u007f]/u.test(value) && !/%(?![0-9a-fA-F]{2})/u.test(value),
  });
  const schemaDir = BUNDLED_SHARED_SCHEMA_DIR;
  const ids = [
    "sim-calibration-case-v1",
    "ml-sample-v1",
    "dataset-manifest-v1",
    "dataset-registry-entry-v1",
  ];
  for (const name of ids) {
    const schema = readJson(join(schemaDir, `${name}.schema.json`));
    validator.addSchema(schema, schema.$id as string);
  }
  const validate = (schemaName: string, instance: unknown): boolean =>
    validator.validate(`https://arena.local/schemas/${schemaName}.schema.json`, instance);
  return { validate, ids };
}

function chain(
  processRunId: string,
  runId: string,
  ticks: readonly number[],
  caseOptions: CaseOptions = {},
): Record<string, unknown>[] {
  // The engine records a server-secret refill EXPECTED_UNKNOWN at every 4th
  // tick (refillEveryTicks=4 in both the v0.11 and v0.14 rules), so plain
  // no-op cases at tick % 4 == 0 calibrate INCONCLUSIVE and are published with
  // sampleStatus "inconclusive". Chains that need full tick coverage pass a
  // hard difference (e.g. afterResources) so those ticks calibrate MISMATCH,
  // which is published with sampleStatus null (the recorded outcome is still
  // ground truth).
  return ticks.map((tick) => makeCase(processRunId, tick, runId, caseOptions));
}

test("sim:dataset derives ml-sample rows, labels and manifest from a MATCH chain", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-dataset-derive-"));
  try {
    const cases = chain("p1", "run-a", Array.from({ length: 60 }, (_, index) => index + 1), {
      afterResources: 8,
    });
    const dataset = writeDataset(root, "p1", cases);
    const result = buildDataset(buildOptions(dataset));
    assert.equal(result.gatePassed, true);
    assert.equal(result.sampleCount, 60);
    assert.equal(result.report.calibration.statusCounts.MISMATCH, 60);
    const samples = readJsonl(join(result.datasetDir, "samples.jsonl"));
    assert.equal(samples.length, 60);

    // Derivation: state=before, plan=case.plan, outcome from before/after diff.
    const first = samples[0]!;
    assert.equal(first.schema, "ml-sample-v1");
    assert.deepEqual(first.state, cases[0]!.before);
    assert.deepEqual(first.plan, cases[0]!.plan);
    assert.deepEqual(first.outcome, { coreResourceDelta: -2, workerDelta: 0, deaths: 0 });
    assert.match(first.sampleId as string, /^[0-9a-f]{64}$/u);

    // Default deterministic policy when no telemetry exists.
    assert.deepEqual(first.policy, {
      policyId: "deterministic", policyVersion: null, posture: "balanced",
      workerTarget: 8, militaryRatio: 0.3, parametersHash: null,
    });

    // Full 50-tick windows only for ticks 1..10 (t+50 <= 60).
    const complete = samples.filter((sample) =>
      (sample.label as Record<string, unknown>).windowComplete === true);
    const incomplete = samples.filter((sample) =>
      (sample.label as Record<string, unknown>).windowComplete === false);
    assert.equal(complete.length, 10);
    assert.equal(incomplete.length, 50);
    assert.deepEqual((first.label as Record<string, unknown>).windowEndTick, 51);
    assert.equal((first.label as Record<string, unknown>).net20, -40);
    assert.equal((samples[59]!.label as Record<string, unknown>).windowEndTick, null);
    assert.equal((samples[59]!.label as Record<string, unknown>).windowComplete, false);
    assert.equal((samples[59]!.label as Record<string, unknown>).net20, 0);

    // Live/sim provenance follows the case metadata source.
    assert.equal((first.provenance as Record<string, unknown>).source, "sim");
    assert.equal((first.provenance as Record<string, unknown>).runId, "run-a");
    assert.equal(
      ((first.provenance as Record<string, unknown>).sourceRefs as Array<{ kind: string }>)[0]!.kind,
      "calibration-case",
    );

    // MISMATCH cases are published (the recorded outcome is ground truth) but
    // are neither "conclusive" nor "inconclusive": sampleStatus stays null.
    assert.equal((first.provenance as Record<string, unknown>).sampleStatus, null);
    assert.equal(result.report.counts.conclusiveSamples, 0);
    assert.equal(result.report.counts.inconclusiveSamples, 0);
    assert.deepEqual(result.report.quarantineByReason, {});

    // 2026-08-08 契约两维：MISMATCH 发布样本 sampleStatus=null →
    // simReplayConfidence=unsupported；sim 源 observed=false →
    // usableForSupervisedLearning=false（真实监督资格只看 observed && complete）。
    assert.equal((first.provenance as Record<string, unknown>).simReplayConfidence, "unsupported");
    assert.deepEqual((first.provenance as Record<string, unknown>).realLabelValidity, {
      observed: false,
      lineageValid: true,
      windowComplete: (first.label as Record<string, unknown>).windowComplete,
      usableForSupervisedLearning: false,
    });
    assert.deepEqual(result.report.simReplayConfidenceCounts, {
      match: 0, expectedUnknown: 0, mismatch: 0, unsupported: 60,
    });
    assert.equal(result.report.realLabelValidity.observedSamples, 0);
    assert.equal(result.report.realLabelValidity.lineageValidSamples, 60);
    assert.equal(result.report.realLabelValidity.windowCompleteSamples, 10);
    assert.equal(result.report.realLabelValidity.usableForSupervisedLearning, 0);

    // Manifest consistency.
    const manifest = readJson(join(result.datasetDir, "manifest.json"));
    assert.equal(manifest.schema, "dataset-manifest-v1");
    assert.deepEqual(manifest.counts, {
      samples: 60, liveSamples: 0, simSamples: 60,
      completeLabelWindows: 10, incompleteLabelWindows: 50,
    });
    const artifacts = manifest.artifacts as Array<Record<string, unknown>>;
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]!.path, "samples.jsonl");
    assert.equal(artifacts[0]!.recordCount, 60);
    assert.equal(artifacts[0]!.sha256, result.samplesHash);
    assert.match(manifest.datasetHash as string, /^[0-9a-f]{64}$/u);

    // Chronological split: one run => everything in train.
    const report = result.report;
    assert.equal(report.splits.counts.train.samples, 60);
    assert.equal(report.splits.counts.validation.samples, 0);
    assert.equal(report.splits.counts.test.samples, 0);
    assert.equal(report.counts.schemaFailures, 0);
    assert.equal(report.counts.quarantineTotal, 0);
    assert.equal(report.registry.appended, true);

    // Authoritative cross-check against the real shared schemas.
    const schemaValidator = createSchemaValidator();
    for (const sample of samples) {
      assert.equal(schemaValidator.validate("ml-sample-v1", sample), true);
    }
    assert.equal(schemaValidator.validate("dataset-manifest-v1", manifest), true);
    const registry = readJsonl(join(result.datasetDir, "..", "registry.jsonl"));
    assert.equal(schemaValidator.validate("dataset-registry-entry-v1", registry[registry.length - 1]), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sim:dataset accumulates label windows across per-tick runIds in one consecutive segment", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-dataset-segment-"));
  try {
    // Real recorder shape: runId is per-tick (`<processRunId>:<tenant>:<tick>:<seq>`),
    // so grouping by runId would yield 1-tick windows. Grouping by
    // (processRunId, tick-consecutive-segment) must accumulate windows.
    const processRunId = "p1";
    const cases = Array.from({ length: 60 }, (_, index) => index + 1).map((tick) =>
      makeCase(processRunId, tick, `${processRunId}:t2:${tick}:1`));
    const dataset = writeDataset(root, processRunId, cases);
    const result = buildDataset(buildOptions(dataset));
    assert.equal(result.gatePassed, true);
    assert.equal(result.sampleCount, 60);
    const samples = readJsonl(join(result.datasetDir, "samples.jsonl"));
    assert.equal(samples.length, 60);
    const byTick = new Map<number, Record<string, unknown>>();
    for (const sample of samples) {
      const provenance = sample.provenance as Record<string, unknown>;
      byTick.set(provenance.tick as number, sample);
    }
    // One consecutive segment of 60 ticks: windows accumulate and ticks 1..10
    // get complete 50-tick lookahead.
    assert.equal(result.report.counts.completeLabelWindows, 10);
    assert.equal(result.report.counts.incompleteLabelWindows, 50);
    assert.equal((byTick.get(1)!.label as Record<string, unknown>).windowComplete, true);
    assert.equal((byTick.get(1)!.label as Record<string, unknown>).windowEndTick, 51);
    // No-op cases at tick % 4 == 0 calibrate INCONCLUSIVE (refill
    // EXPECTED_UNKNOWN only) and are published honestly, not quarantined.
    assert.equal(result.report.counts.quarantineTotal, 0);
    assert.equal(result.report.counts.inconclusiveSamples, 15);
    assert.equal(result.report.counts.conclusiveSamples, 45);
    assert.equal(
      (byTick.get(4)!.provenance as Record<string, unknown>).sampleStatus,
      "inconclusive",
    );
    assert.equal(
      (byTick.get(1)!.provenance as Record<string, unknown>).sampleStatus,
      "conclusive",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sim:dataset truncates windows on tick gaps and counts them", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-dataset-gap-"));
  try {
    // Ticks 1..24 and 26..60: tick 25 is missing.
    const ticks = [
      ...Array.from({ length: 24 }, (_, index) => index + 1),
      ...Array.from({ length: 35 }, (_, index) => index + 26),
    ];
    const cases = chain("p1", "run-a", ticks, { afterResources: 8 });
    const dataset = writeDataset(root, "p1", cases);
    const result = buildDataset(buildOptions(dataset));
    const samples = readJsonl(join(result.datasetDir, "samples.jsonl"));
    const byTick = new Map<number, Record<string, unknown>>();
    for (const sample of samples) {
      const provenance = sample.provenance as Record<string, unknown>;
      byTick.set(provenance.tick as number, sample);
    }
    // Sample at tick 20: lookahead 21..24, then the gap at 25.
    const at20 = byTick.get(20)!;
    assert.equal((at20.label as Record<string, unknown>).windowComplete, false);
    assert.equal((at20.label as Record<string, unknown>).windowEndTick, 24);
    // Sample at tick 24: only tick 25 is missing immediately.
    const at24 = byTick.get(24)!;
    assert.equal((at24.label as Record<string, unknown>).windowComplete, false);
    assert.equal((at24.label as Record<string, unknown>).windowEndTick, null);
    // Last sample has no lookahead at all.
    const last = byTick.get(60)!;
    assert.equal((last.label as Record<string, unknown>).windowComplete, false);
    assert.equal((last.label as Record<string, unknown>).windowEndTick, null);
    assert.equal(result.report.counts.completeLabelWindows, 0);
    assert.equal(result.report.counts.incompleteLabelWindows, 59);
    // One tick-gap (24 -> 26) plus the chain tail (60).
    assert.equal(result.report.counts.tickGapCases, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sim:dataset computes net20/deathProb20/coreRisk50 from window cases", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-dataset-label-"));
  try {
    const processRunId = "p1";
    const cases: Record<string, unknown>[] = [];
    for (let tick = 1; tick <= 60; tick += 1) {
      // +1 resource each tick; the worker dies at tick 30.
      const options: CaseOptions = {
        afterResources: 11,
        ...(tick === 30 ? { workerAliveAfter: false } : {}),
      };
      cases.push(makeCase(processRunId, tick, "run-a", options));
    }
    const dataset = writeDataset(root, processRunId, cases);
    const result = buildDataset(buildOptions(dataset));
    const samples = readJsonl(join(result.datasetDir, "samples.jsonl"));
    const byTick = new Map<number, Record<string, unknown>>();
    for (const sample of samples) {
      const provenance = sample.provenance as Record<string, unknown>;
      byTick.set(provenance.tick as number, sample);
    }
    // Sample at tick 1: full window => net20 sums 20 deltas of +1, end tick 51.
    const at1 = byTick.get(1)!;
    assert.equal((at1.label as Record<string, unknown>).windowComplete, true);
    assert.equal((at1.label as Record<string, unknown>).windowEndTick, 51);
    assert.equal((at1.label as Record<string, unknown>).net20, 20);
    assert.equal((at1.label as Record<string, unknown>).deathProb20, 0);
    // Sample at tick 20: the 50-tick window (21..70) is cut off by the chain
    // end at 60, but the usable part (21..40) still includes the death at 30.
    const at20 = byTick.get(20)!;
    assert.equal((at20.label as Record<string, unknown>).windowComplete, false);
    assert.equal((at20.label as Record<string, unknown>).windowEndTick, 60);
    assert.equal((at20.label as Record<string, unknown>).deathProb20, 1);
    assert.equal((at20.label as Record<string, unknown>).net20, 20);
    // Sample at tick 29: the death at 30 falls inside the 20-tick net window.
    const at29 = byTick.get(29)!;
    assert.equal((at29.label as Record<string, unknown>).deathProb20, 1);
    // Sample at tick 35: death is before the window.
    const at35 = byTick.get(35)!;
    assert.equal((at35.label as Record<string, unknown>).deathProb20, 0);
    // Outcome.deaths is the single-tick before/after diff.
    assert.equal((byTick.get(29)!.outcome as Record<string, unknown>).deaths, 0);
    assert.equal((byTick.get(30)!.outcome as Record<string, unknown>).deaths, 1);
    assert.equal((byTick.get(30)!.outcome as Record<string, unknown>).workerDelta, -1);
    // Resources never reach zero, so the core risk label stays 0.
    assert.equal((at20.label as Record<string, unknown>).coreRisk50, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sim:dataset publishes INCONCLUSIVE EXPECTED_UNKNOWN-only cases with sampleStatus inconclusive", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-dataset-inconclusive-"));
  try {
    const processRunId = "p1";
    const clean = chain(processRunId, "run-clean", [1, 2, 3]);
    const inconclusive = [4, 5, 6].map((tick) =>
      makeCase(processRunId, tick, "run-inconclusive", { opponent: true }));
    const dataset = writeDataset(root, processRunId, [...clean, ...inconclusive]);
    const result = buildDataset(buildOptions(dataset));
    assert.equal(result.gatePassed, true);
    // INCONCLUSIVE with only EXPECTED_UNKNOWN differences is published with an
    // honest sampleStatus; opponentPlans=absent is the standard calibration
    // form and is no longer a quarantine condition.
    assert.equal(result.sampleCount, 6);
    assert.equal(result.report.counts.inconclusiveCases, 3);
    assert.equal(result.report.counts.inconclusiveSamples, 3);
    assert.equal(result.report.counts.conclusiveSamples, 3);
    assert.equal(result.report.counts.absentOpponentPlansCount, 3);
    assert.equal(result.report.counts.quarantineTotal, 0);
    assert.equal(result.report.counts.casesParsed, 6);
    assert.deepEqual(result.report.quarantine, []);
    assert.deepEqual(result.report.quarantineByReason, {});
    const samples = readJsonl(join(result.datasetDir, "samples.jsonl"));
    assert.equal(samples.length, 6);
    for (const sample of samples) {
      const provenance = sample.provenance as Record<string, unknown>;
      const expectedStatus = provenance.runId === "run-inconclusive" ? "inconclusive" : "conclusive";
      assert.equal(provenance.sampleStatus, expectedStatus);
    }
    // 2026-08-08 契约两维：conclusive → match；INCONCLUSIVE(EXPECTED_UNKNOWN)
    // → expectedUnknown——两者都是可发布的真实监督样本。
    for (const sample of samples) {
      const provenance = sample.provenance as Record<string, unknown>;
      const expectedConfidence = provenance.runId === "run-inconclusive"
        ? "expectedUnknown"
        : "match";
      assert.equal(provenance.simReplayConfidence, expectedConfidence);
    }
    assert.deepEqual(result.report.simReplayConfidenceCounts, {
      match: 3, expectedUnknown: 3, mismatch: 0, unsupported: 0,
    });
    // Calibration taxonomy recorded in the report.
    assert.equal(result.report.calibration.statusCounts.INCONCLUSIVE, 3);
    assert.equal(result.report.calibration.statusCounts.MATCH, 3);
    assert.ok(result.report.calibration.taxonomyCounts.EXPECTED_UNKNOWN > 0);
    assert.ok(result.report.calibration.expectedUnknownCount > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sim:dataset realLabelValidity: live-recorder 源 observed=true、usable 跟随完整窗口", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-dataset-rlv-live-"));
  try {
    const processRunId = "p1";
    // live-recorder 源 60 tick 连续链：完整窗口 10（t+50<=60），其余 50 不完整。
    // 不传 afterResources（无硬差异）→ tick%4==0 处产生 EXPECTED_UNKNOWN
    // INCONCLUSIVE，验证"EXPECTED_UNKNOWN 不否决真实监督资格"。
    const cases = chain(processRunId, "run-live", Array.from({ length: 60 }, (_, index) => index + 1), {
      source: "live-recorder",
    });
    const dataset = writeDataset(root, processRunId, cases);
    const result = buildDataset(buildOptions(dataset));
    assert.equal(result.gatePassed, true);
    const samples = readJsonl(join(result.datasetDir, "samples.jsonl"));
    assert.equal(samples.length, 60);
    for (const sample of samples) {
      const provenance = sample.provenance as Record<string, unknown>;
      assert.equal(provenance.source, "live");
      const validity = provenance.realLabelValidity as Record<string, boolean>;
      assert.equal(validity.observed, true, "live 源标签由真实服务器后续观测计算");
      assert.equal(validity.lineageValid, true);
      assert.equal(validity.windowComplete, (sample.label as Record<string, unknown>).windowComplete);
      assert.equal(
        validity.usableForSupervisedLearning,
        (sample.label as Record<string, unknown>).windowComplete === true,
        "usable = observed && lineageValid && windowComplete",
      );
    }
    // report 两维统计：live 全部 observed；usable = 完整窗口数。
    assert.equal(result.report.realLabelValidity.observedSamples, 60);
    assert.equal(result.report.realLabelValidity.lineageValidSamples, 60);
    assert.equal(result.report.realLabelValidity.windowCompleteSamples, 10);
    assert.equal(result.report.realLabelValidity.usableForSupervisedLearning, 10);
    assert.equal(
      result.report.realLabelValidity.usableForSupervisedLearning,
      result.report.counts.completeLabelWindows,
    );
    // 真实监督资格与 simReplayConfidence 正交：EXPECTED_UNKNOWN 不否决 usable。
    assert.ok(result.report.simReplayConfidenceCounts.expectedUnknown > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sim:dataset fails closed on rules version mismatch", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-dataset-version-"));
  try {
    const processRunId = "p1";
    const dataset = writeDataset(root, processRunId, chain(processRunId, "run-a", [1, 2]));
    const manifestPath = dataset.manifestPath;
    const manifest = readJson(manifestPath);
    manifest.rulesVersion = "v0.99";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    assert.throws(
      () => buildDataset(buildOptions(dataset)),
      /rules version mismatch \(fail closed\)/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sim:dataset v0.11 显式回退: 历史 v0.11 数据集 fail closed（不伪标 v0.14）", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-dataset-v011-"));
  try {
    const processRunId = "p1";
    const dataset = writeDataset(root, processRunId, chain(processRunId, "run-a", [1, 2]));
    // 把默认 v0.14 case 的版本标记改回 v0.11，模拟历史数据集（不重算 hash，
    // 版本检查在 hash 校验之前 fail closed，本就是负向用例）。
    const manifestPath = dataset.manifestPath;
    const manifest = readJson(manifestPath);
    manifest.rulesVersion = "v0.11";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    assert.throws(
      () => buildDataset(buildOptions(dataset)),
      /rules version mismatch \(fail closed\)/u,
    );
    // 显式 --rules v0.11 也不可用：dataset builder 的 SUPPORTED_RULES_VERSION
    // 已是 v0.14，v0.11 数据集必须走 calibrate-dataset（S8b）路径，而不是
    // 被静默当成 v0.14 数据。
    assert.throws(
      () => buildDataset(buildOptions(dataset, { rulesPath: RULES_V011 })),
      /v0\.14/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sim:dataset quarantines duplicate (runId, tick) cases", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-dataset-dup-"));
  try {
    const processRunId = "p1";
    const original = makeCase(processRunId, 1, "run-a");
    const duplicate = makeCase(processRunId, 1, "run-a");
    duplicate.caseId = `${processRunId}:1-dup`;
    const dataset = writeDataset(root, processRunId, [original, duplicate]);
    const result = buildDataset(buildOptions(dataset));
    assert.equal(result.sampleCount, 1);
    assert.equal(result.report.counts.duplicateCases, 1);
    assert.equal(result.report.counts.quarantineTotal, 1);
    assert.equal(result.report.quarantine[0]!.reason, "duplicate");
    assert.deepEqual(result.report.quarantineByReason, { duplicate: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sim:dataset splits chronologically by run without leakage", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-dataset-split-"));
  try {
    const processRunId = "p1";
    const cases: Record<string, unknown>[] = [];
    for (let run = 1; run <= 7; run += 1) {
      // Windows group by (processRunId, tick-consecutive-segment), so each run
      // needs its own non-adjacent tick range to form a separate segment.
      const base = (run - 1) * 10;
      cases.push(...chain(
        processRunId,
        `run-${run}`,
        [base + 1, base + 2, base + 3, base + 4, base + 5],
        { afterResources: 8 },
      ));
    }
    const dataset = writeDataset(root, processRunId, cases);
    const result = buildDataset(buildOptions(dataset));
    assert.equal(result.gatePassed, true);
    const report = result.report;
    // 7 runs -> 5 train / 1 validation / 1 test (round(4.9), round(1.05)).
    assert.equal(report.splits.counts.train.runs, 5);
    assert.equal(report.splits.counts.validation.runs, 1);
    assert.equal(report.splits.counts.test.runs, 1);
    assert.equal(report.splits.counts.train.samples, 25);
    assert.equal(report.splits.counts.validation.samples, 5);
    assert.equal(report.splits.counts.test.samples, 5);
    assert.equal(
      report.splits.counts.train.samples + report.splits.counts.validation.samples +
        report.splits.counts.test.samples,
      result.sampleCount,
    );
    // Leakage check: every run maps to exactly one split and every sample of a
    // run shares the run's split.
    const runSplit = new Map<string, string>();
    for (const assignment of report.splits.runAssignments) {
      assert.equal(runSplit.has(assignment.runId), false);
      runSplit.set(assignment.runId, assignment.split);
      assert.equal(assignment.sampleCount, 5);
    }
    const samples = readJsonl(join(result.datasetDir, "samples.jsonl"));
    for (const sample of samples) {
      const provenance = sample.provenance as Record<string, unknown>;
      const segmentNumber = Math.floor(((provenance.tick as number) - 1) / 10) + 1;
      const segmentKey = `seg-${String(segmentNumber).padStart(6, "0")}`;
      const assigned = runSplit.get(segmentKey);
      assert.notEqual(assigned, undefined);
    }
    assert.equal(report.splits.leakChecks.runCrossesSplit, 0);
    assert.equal(report.splits.leakChecks.sampleInMultipleSplits, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sim:dataset aligns telemetry policy by tick with deterministic baseline fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-dataset-policy-"));
  try {
    const processRunId = "p1";
    const dataset = writeDataset(root, processRunId, chain(processRunId, "run-a", [1, 2, 3, 4, 5, 6], {
      afterResources: 8,
    }));
    // Telemetry updates at ticks 5 (posture outside the schema enum) and 10.
    const policyDir = join(root, "runtime", "t1", "telemetry");
    mkdirSync(policyDir, { recursive: true });
    const policyLines = [
      { at: "2026-08-03T00:00:05Z", tenantId: "t1", type: "policy_update", tick: 5, policy: "{\"posture\":\"aggressive\",\"workerTarget\":3,\"militaryRatio\":0.6}" },
      { at: "2026-08-03T00:00:10Z", tenantId: "t1", type: "policy_update", tick: 10, policy: "{\"posture\":\"defense\",\"workerTarget\":9,\"militaryRatio\":0.2}" },
    ];
    writeFileSync(join(policyDir, "policy.jsonl"), `${policyLines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
    const result = buildDataset(buildOptions(dataset));
    const samples = readJsonl(join(result.datasetDir, "samples.jsonl"));
    const byTick = new Map<number, Record<string, unknown>>();
    for (const sample of samples) {
      const provenance = sample.provenance as Record<string, unknown>;
      byTick.set(provenance.tick as number, sample);
    }
    // Before any update: deterministic baseline.
    assert.deepEqual(byTick.get(1)!.policy, {
      policyId: "deterministic", policyVersion: null, posture: "balanced",
      workerTarget: 8, militaryRatio: 0.3, parametersHash: null,
    });
    // Tick >= 5: last update with tick <= sample tick (aggressive -> posture null).
    const at5 = byTick.get(5)!.policy as Record<string, unknown>;
    assert.equal(at5.policyId, "telemetry-policy");
    assert.equal(at5.posture, null);
    assert.equal(at5.workerTarget, 3);
    assert.equal(at5.militaryRatio, 0.6);
    assert.match(at5.parametersHash as string, /^[0-9a-f]{64}$/u);
    // Tick >= 10 (no case at 10; case at 6 keeps update 5; no update after 6 in this chain).
    assert.equal(result.report.counts.policyPostureNormalized, 2);
    assert.equal(result.report.counts.policyParseErrors, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sim:dataset distinguishes live and sim source share", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-dataset-source-"));
  try {
    const processRunId = "p1";
    const live = [1, 2, 3].map((tick) =>
      makeCase(processRunId, tick, "run-live", { source: "live-recorder" }));
    const sim = [4, 5, 6].map((tick) =>
      makeCase(processRunId, tick, "run-sim", { afterResources: 8 }));
    const dataset = writeDataset(root, processRunId, [...live, ...sim]);
    const result = buildDataset(buildOptions(dataset));
    const samples = readJsonl(join(result.datasetDir, "samples.jsonl"));
    assert.equal(samples.filter((sample) =>
      (sample.provenance as Record<string, unknown>).source === "live").length, 3);
    assert.equal(samples.filter((sample) =>
      (sample.provenance as Record<string, unknown>).source === "sim").length, 3);
    const manifest = readJson(join(result.datasetDir, "manifest.json"));
    assert.equal((manifest.counts as Record<string, unknown>).liveSamples, 3);
    assert.equal((manifest.counts as Record<string, unknown>).simSamples, 3);
    assert.deepEqual(result.report.sourceShare, {
      live: 3, sim: 3, byTenant: { t1: 6 }, byEngine: { "arena-ts": 6 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sim:dataset registry append is idempotent and preserves prior rows", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-dataset-registry-"));
  try {
    const processRunId = "p1";
    const dataset = writeDataset(root, processRunId, chain(processRunId, "run-a", [1, 2, 3]));
    const options = buildOptions(dataset);
    const first = buildDataset(options);
    assert.equal(first.report.registry.appended, true);
    const second = buildDataset({ ...options, force: true });
    assert.equal(second.report.registry.appended, false);
    assert.equal(second.report.registry.reason, "identical datasetHash entry already present");
    assert.equal(second.datasetHash, first.datasetHash);
    const registry = readJsonl(join(first.datasetDir, "..", "registry.jsonl"));
    assert.equal(registry.length, 1);
    assert.equal(registry[0]!.datasetId, "p1");
    assert.equal(registry[0]!.status, "candidate");
    assert.equal(registry[0]!.datasetHash, first.datasetHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sim:dataset schema validator rejects invalid samples (red) and accepts valid ones (green)", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-dataset-schema-"));
  try {
    const processRunId = "p1";
    const dataset = writeDataset(root, processRunId, chain(processRunId, "run-a", [1, 2]));
    const result = buildDataset(buildOptions(dataset));
    const valid = readJsonl(join(result.datasetDir, "samples.jsonl"))[0]!;
    assert.deepEqual(validateMlSample(valid), []);
    // The authoritative ajv check agrees.
    const schemaValidator = createSchemaValidator();
    assert.equal(schemaValidator.validate("ml-sample-v1", valid), true);

    // Red cases: each mutation must be rejected by both validators.
    const invalidDeathProb = structuredClone(valid);
    (invalidDeathProb.label as Record<string, unknown>).deathProb20 = 1.5;
    assert.notDeepEqual(validateMlSample(invalidDeathProb), []);
    assert.equal(schemaValidator.validate("ml-sample-v1", invalidDeathProb), false);

    const invalidHash = structuredClone(valid);
    (invalidHash.provenance as Record<string, unknown>).rulesManifestHash = "not-a-hash";
    assert.notDeepEqual(validateMlSample(invalidHash), []);
    assert.equal(schemaValidator.validate("ml-sample-v1", invalidHash), false);

    const invalidWindow = structuredClone(valid);
    (invalidWindow.label as Record<string, unknown>).windowComplete = true;
    (invalidWindow.label as Record<string, unknown>).windowEndTick = null;
    assert.notDeepEqual(validateMlSample(invalidWindow), []);
    assert.equal(schemaValidator.validate("ml-sample-v1", invalidWindow), false);

    const extraKey = structuredClone(valid);
    (extraKey as Record<string, unknown>).bogus = 1;
    assert.notDeepEqual(validateMlSample(extraKey), []);
    assert.equal(schemaValidator.validate("ml-sample-v1", extraKey), false);

    const invalidStatus = structuredClone(valid);
    (invalidStatus.provenance as Record<string, unknown>).sampleStatus = "bogus";
    assert.notDeepEqual(validateMlSample(invalidStatus), []);
    assert.equal(schemaValidator.validate("ml-sample-v1", invalidStatus), false);

    const nullStatus = structuredClone(valid);
    (nullStatus.provenance as Record<string, unknown>).sampleStatus = null;
    assert.deepEqual(validateMlSample(nullStatus), []);
    assert.equal(schemaValidator.validate("ml-sample-v1", nullStatus), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sim:dataset refuses to overwrite an existing dataset directory without --force", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-dataset-force-"));
  try {
    const processRunId = "p1";
    const dataset = writeDataset(root, processRunId, chain(processRunId, "run-a", [1, 2]));
    const options = buildOptions(dataset);
    buildDataset(options);
    assert.throws(() => buildDataset(options), /already exists/u);
    const forced = buildDataset({ ...options, force: true });
    assert.equal(forced.gatePassed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
