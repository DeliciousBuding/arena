/**
 * 实验管线（experiment-pipeline）与变体注册表扩展的单元测试：
 * - 管线：声明式定义 → 报告结构正确（schema/聚合/文本摘要）、plannerConfig 变体生效、
 *   plannerId 变体走注册表、未知变体 fail-fast；
 * - 注册表：新增候选变体（threat-recall-v1/move-failed-avoidance-v1/
 *   threat-breakout-v1/core-evade-v1）可解析且构造出 SafetyPlanner。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runExperiment } from "../src/sim/tools/experiment-pipeline.ts";
import { isPlannerVariant, resolvePlannerVariant } from "../src/sim/tools/planner-variants.ts";
import { SafetyPlanner } from "../src/strategies/safety-planner.ts";
import type { EpisodeResult } from "../src/sim/harness/episode.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO = JSON.parse(
  readFileSync(join(here, "fixtures", "sim", "scenario-basic.json"), "utf8"),
) as unknown;

test("experiment pipeline: report shape and text output", () => {
  const report = runExperiment({
    id: "pipeline-smoke",
    title: "管线冒烟（双变体对照）",
    scenario: () => SCENARIO,
    variants: [
      { id: "base", label: "基线", plannerConfig: {} },
      { id: "recall", label: "召回", plannerConfig: { threatRecall: true } },
    ],
    seeds: [1],
    ticks: 60,
    players: ["p1"],
    outputPath: undefined,
  });
  assert.equal(report.schema, "sim.experiment-report.v1");
  assert.equal(report.variants.length, 2);
  assert.equal(report.runs.length, 2);
  assert.equal(report.aggregates.length, 2);
  assert.ok(report.text.includes("管线冒烟"));
  assert.ok(report.aggregates[0].players.p1.finalPopulation >= 0);
});

test("experiment pipeline: custom metrics collected per player", () => {
  const report = runExperiment({
    id: "pipeline-metrics",
    title: "自定义 KPI",
    scenario: () => SCENARIO,
    variants: [{ id: "base", label: "基线", plannerConfig: {} }],
    seeds: [1],
    ticks: 30,
    players: ["p1"],
    extendedMetrics: (result: EpisodeResult) => {
      let harvests = 0;
      for (const record of result.records) {
        for (const event of record.events) {
          if (event.eventType === "HARVEST_SUCCEEDED") harvests += 1;
        }
      }
      return { harvests };
    },
    outputPath: undefined,
  });
  const metrics = report.aggregates[0].players.p1;
  assert.ok("harvests" in metrics, "custom metric should appear in aggregate");
  assert.ok("finalResources" in metrics, "builtin metric should also appear");
});

test("experiment pipeline: registered variant id is injected via registry", () => {
  const report = runExperiment({
    id: "pipeline-registry",
    title: "注册表变体",
    scenario: () => SCENARIO,
    variants: [{ id: "clear-path", label: "清障", plannerId: "clear-path-v1" }],
    seeds: [1],
    ticks: 30,
    players: ["p1"],
    outputPath: undefined,
  });
  assert.equal(report.runs[0].variant, "clear-path");
});

test("experiment pipeline: unknown variant id fails fast", () => {
  assert.throws(
    () =>
      runExperiment({
        id: "pipeline-bad",
        title: "未知变体",
        scenario: () => SCENARIO,
        variants: [{ id: "ghost", label: "幽灵", plannerId: "no-such-variant" }],
        seeds: [1],
        ticks: 10,
        players: ["p1"],
        outputPath: undefined,
      }),
    /unknown planner variant/,
  );
});

test("variant registry: all registered candidate variants resolve to SafetyPlanner", () => {
  for (const id of [
    "clear-path-v1",
    "threat-recall-v1",
    "move-failed-avoidance-v1",
    "threat-breakout-v1",
    "core-evade-v1",
  ]) {
    assert.ok(isPlannerVariant(id), `${id} should be registered`);
    const provider = resolvePlannerVariant(id).create("p1");
    assert.ok(provider instanceof SafetyPlanner, `${id} should build a SafetyPlanner`);
  }
});
