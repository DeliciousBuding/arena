/** 敌情狩猎测试（2026-08-07，持久敌情测绘）：启动播种"最后已知敌 Core 位置"
 * 后，aggressive 军事回访并拆毁远距敌 Core（home [-619,-154] → [-658,-128]，
 * ~65 曼哈顿）——t1 生产实证：无播种时军队在旧位置空转、环搜几何近失（16
 * 方位射线距迁移后 Core ~6 格 > 视野 4），本测试锁定"有播种 → 定向攻坚"。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { runEpisode } from "../src/sim/harness/episode.ts";
import { DeterministicPlanner } from "../src/planning/deterministic-planner.ts";
import { WorkerTaskPlanner } from "../src/planning/worker-task-planner.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { VARIANT_SAFETY_CONFIG } from "../src/strategies/variant-registry.ts";
import type { CoreHuntTarget } from "../src/domain/world.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.14.json");
const AGGRESSIVE_POLICY: MacroPolicy = {
  posture: "aggressive", workerTarget: 12, militaryRatio: 0.4, focusRegion: null, attackPriority: "core",
};

function scenario(seed: number) {
  const units = [];
  for (let i = 0; i < 5; i++) {
    units.push({ id: `22222222-2222-2222-2222-2222222222${String(i).padStart(2, "0")}`, owner: "p1", position: [-619 + i, -150], hp: 4, unitType: "VANGUARD", cargo: 0 });
  }
  for (let i = 0; i < 4; i++) {
    units.push({ id: `22222222-2222-2222-2222-2222222223${String(i).padStart(2, "0")}`, owner: "p1", position: [-622 + i, -152], hp: 2, unitType: "RANGER", cargo: 0 });
  }
  for (let i = 0; i < 12; i++) {
    units.push({ id: `22222222-2222-2222-2222-2222222224${String(i).padStart(2, "0")}`, owner: "p1", position: [-615 - i, -156], hp: 2, unitType: "WORKER", cargo: 0 });
  }
  return {
    rulesVersion: "v0.14", tick: 1, seed,
    players: [
      { id: "p1", username: "p1", resources: 41, core: { id: "11111111-1111-1111-1111-111111111111", position: [-619, -154], hp: 5, shield: 5, state: "NORMAL" }, units },
      { id: "p2", username: "p2", resources: 0, core: { id: "44444444-4444-4444-4444-444444444444", position: [-658, -128], hp: 5, shield: 5, state: "NORMAL" }, units: [] },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: { position: [-50, -223], status: "GROUND", carrierId: null },
  };
}

function run(seeded: boolean, seed: number) {
  const safetyConfig = { ...DEFAULT_SAFETY_CONFIG, ...VARIANT_SAFETY_CONFIG["strike-core-v1"] };
  const seeds: readonly CoreHuntTarget[] = seeded
    ? [{ position: [-658, -128], lastSeenTick: 1, source: "CORE" }]
    : [];
  const result = runEpisode({
    scenario: scenario(seed), rulesPath: MANIFEST_PATH, seed, ticks: 300, tenants: [
      { id: "p1", planner: "deterministic", policy: AGGRESSIVE_POLICY },
      { id: "p2", planner: "deterministic", policy: AGGRESSIVE_POLICY },
    ],
    plannerFactory: (tenant) =>
      tenant.id === "p1"
        ? new DeterministicPlanner(
            new WorkerTaskPlanner(),
            new SafetyPlanner(safetyConfig),
            new SafetyPlanner(safetyConfig),
            0.5, 30, undefined, seeds,
          )
        : new DeterministicPlanner(),
  });
  let p2Down = -1;
  let huntIntents = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "CORE_DESTROYED" && String(event.targetId ?? "").startsWith("4444")) {
        p2Down = record.tick;
      }
    }
    for (const intent of Object.values(record.plans?.["p1"]?.intents ?? {})) {
      if (intent === "vanguard_hunt") huntIntents += 1;
    }
  }
  return { p2Down, huntIntents };
}

test("敌情狩猎：播种最后已知敌 Core → 定向回访并拆毁（vanguard_hunt 触发）", () => {
  const { p2Down, huntIntents } = run(true, 7);
  assert.ok(p2Down > 0, `有播种应在预算内拆毁敌 Core，实际 p2Down=${p2Down}`);
  assert.ok(p2Down < 150, `有播种应快速接敌（无播种环搜 235 tick 才到），实际 p2Down=${p2Down}`);
  assert.ok(huntIntents > 0, `应产生 vanguard_hunt 意图，实际 hunt=${huntIntents}`);
});

test("敌情狩猎：无播种对照组 → 同预算内不产生 vanguard_hunt（环搜盲区）", () => {
  const { p2Down, huntIntents } = run(false, 7);
  assert.equal(huntIntents, 0, "无播种不触发 vanguard_hunt");
  assert.ok(p2Down > 150, `无播种环搜慢（>150），实际 p2Down=${p2Down}`);
});
