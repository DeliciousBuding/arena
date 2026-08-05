/**
 * 决策指挥链模拟级验证（2026-08-06 综合设计推进）：
 * 生产运行时机制（PolicyDiscipline → StallRecovery → planner 防呆）在模拟器
 * 上可复现——episode.policyProvider 模拟 LLM 低频决策（每 16 tick 输出坏
 * focusRegion），对比：无保护 vs discipline 链 vs full 链（+ detector/recovery）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { TickState } from "../src/domain/model.ts";
import { runEpisode } from "../src/sim/harness/episode.ts";
import { StallDetector } from "../src/runtime/stall-detector.ts";
import { StallRecovery } from "../src/runtime/stall-recovery.ts";
import { PolicyDiscipline } from "../src/runtime/policy-discipline.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FOCUS_EXILE_SCENARIO = JSON.parse(
  readFileSync(join(here, "fixtures", "sim", "scenario-focus-exile.json"), "utf8"),
) as unknown;
const RULES = join(here, "..", "src", "sim", "contracts", "rules-v0.11.json");

/** 坏 policy：focusRegion 指向北向远点（> maxFocusDistance=32）。worker 采完开局
 *  可见资源（[2,0]）回仓后空载——无保护被支走北上；纪律链禁言后留守巡逻。 */
const BAD_POLICY: MacroPolicy = {
  posture: "balanced",
  workerTarget: 8,
  militaryRatio: 0,
  focusRegion: [0, 40],
  attackPriority: null,
};

/** 模拟 LLM 低频决策：每 badInterval ticks 输出一次坏焦点，其余 null（保持上次）。 */
function llmBadFocus(badInterval: number, tick: number): MacroPolicy | null {
  return tick % badInterval === 0 ? BAD_POLICY : null;
}

const BAD_INTERVAL = 8;

type Provider = (tenantId: string, tick: number, state: TickState) => MacroPolicy | null;

interface RunOutcome {
  readonly resources: number;
  readonly workerPosition: readonly [number, number];
}

/** 无防呆执行层（maxFocusDistance=∞）：模拟 v0.2.15 旧生产语义——
 *  坏焦点直通执行层，纪律链的禁言价值在此可见。 */
const NO_FOCUS_GUARD = { ...DEFAULT_SAFETY_CONFIG, maxFocusDistance: Number.POSITIVE_INFINITY };

function runWithProvider(seed: number, provider: Provider, ticks = 60): RunOutcome {
  const result = runEpisode({
    scenario: FOCUS_EXILE_SCENARIO,
    rulesPath: RULES,
    seed,
    ticks,
    tenants: [{ id: "p1", planner: "deterministic" }],
    plannerFactory: () => new SafetyPlanner(NO_FOCUS_GUARD),
    policyProvider: provider,
  });
  const player = result.finalWorld.players.get("p1")!;
  const unit = [...player.units][0]!;
  return { resources: player.resources, workerPosition: unit.position };
}

/** 无保护：LLM 坏焦点直通（每 BAD_INTERVAL tick 注入，其余保持）。 */
function unprotectedProvider(): Provider {
  return (_tid, tick) => llmBadFocus(BAD_INTERVAL, tick);
}

/** discipline 链：坏焦点连续 2 次被禁言（focusRegion 强制 null）。 */
function disciplineProvider(): Provider {
  const discipline = new PolicyDiscipline({ invalidFocusThreshold: 2 });
  return (_tid, tick, state) => {
    const raw = llmBadFocus(BAD_INTERVAL, tick);
    const applied = discipline.apply(raw ?? BAD_POLICY, { tick, core: state.core });
    return applied.policy;
  };
}

/** full 链：discipline + detector（观测 delta）+ recovery（stall 时覆盖 focus）。 */
function fullChainProvider(): Provider {
  const discipline = new PolicyDiscipline({ invalidFocusThreshold: 2 });
  const detector = new StallDetector();
  const recovery = new StallRecovery();
  let prevResources: number | null = null;
  return (_tid, tick, state) => {
    const delta = prevResources === null ? 0 : state.resources - prevResources;
    prevResources = state.resources;
    const stallEvents = detector.onObservation({
      tick,
      coreResourceDelta: delta,
      workerCount: state.workers.length,
      workerCargoTotal: state.workers.reduce((sum, w) => sum + w.cargo, 0),
      workerMeanDistanceFromCore: state.core === null ? undefined : Math.max(...state.workers.map((w) => Math.abs(w.position[0] - state.core!.position[0]) + Math.abs(w.position[1] - state.core!.position[1])), 0),
      harvestCount: 0,
      depositCount: 0,
      moveCount: 1,
      waitCount: 0,
      intentCounts: {},
      cargoWorkerFingerprint: null,
    });
    recovery.observe(stallEvents, {
      tick,
      coreResourceDelta: delta,
      harvestCount: 0,
      depositCount: 0,
    });
    const raw = llmBadFocus(BAD_INTERVAL, tick);
    const disciplined = discipline.apply(raw ?? BAD_POLICY, { tick, core: state.core });
    return recovery.policyFor(disciplined.policy);
  };
}

test("指挥链模拟：discipline 链阻止坏焦点远征（worker 留守 vs 被支走）", () => {
  const none = runWithProvider(1, unprotectedProvider());
  const disciplined = runWithProvider(1, disciplineProvider());
  // 无保护：worker 采完回仓后空载被坏 focus 支走北上（y 大）
  assert.ok(
    none.workerPosition[1] >= 10,
    `无保护 worker 应被支走北上（pos=${JSON.stringify(none.workerPosition)}）`,
  );
  // discipline：禁言后 focus 无效 → worker 留守巡逻圈（exploreRadius=8）
  assert.ok(
    disciplined.workerPosition[1] <= 10,
    `discipline worker 应留守巡逻圈（pos=${JSON.stringify(disciplined.workerPosition)}）`,
  );
  assert.ok(
    disciplined.workerPosition[1] < none.workerPosition[1],
    `discipline 应阻止远征（disc=${disciplined.workerPosition[1]} vs none=${none.workerPosition[1]}）`,
  );
});

test("指挥链模拟：full 链（discipline + detector + recovery）阻止坏焦点远征", () => {
  const none = runWithProvider(1, unprotectedProvider());
  const full = runWithProvider(1, fullChainProvider());
  assert.ok(
    full.workerPosition[1] < none.workerPosition[1],
    `full 链应阻止远征（full=${full.workerPosition[1]} vs none=${none.workerPosition[1]}）`,
  );
});

test("指挥链模拟：recovery 状态机推进（触发 recovering → 恢复回 idle → 再触发）", () => {
  const recovery = new StallRecovery();
  const detector = new StallDetector({ warmupTicks: 0 }); // 关闭开局宽限，慢速类立即生效
  const events: string[] = [];
  for (let tick = 1; tick <= 200; tick += 1) {
    const stallEvents = detector.onObservation({
      tick,
      coreResourceDelta: 0,
      workerCount: 1,
      workerCargoTotal: 0,
      workerMeanDistanceFromCore: 5,
      harvestCount: 0,
      depositCount: 0,
      moveCount: 1,
      waitCount: 0,
      intentCounts: { patrol: 1 },
      cargoWorkerFingerprint: null,
    });
    const transition = recovery.observe(stallEvents, {
      tick,
      coreResourceDelta: 0,
      harvestCount: 0,
      depositCount: 0,
    });
    if (transition !== null) events.push(`${transition.state}:${transition.kind ?? "none"}`);
    if (tick === 100) {
      const recovered = recovery.observe([], { tick, coreResourceDelta: 2, harvestCount: 1, depositCount: 0 });
      if (recovered !== null) events.push(`${recovered.state}:${recovered.kind ?? "none"}`);
    }
  }
  assert.ok(events.some((e) => e.startsWith("recovering")), "stall 触发 recovering");
  assert.ok(events.some((e) => e.startsWith("idle")), "恢复后回 idle");
});
