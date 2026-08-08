/**
 * 对手桥测试（对抗测试平台）：
 *  - protoPlanToPlan：外部 agent 黑盒防御——unit_actions 偶发 null action 跳过；
 *  - 常驻桥端到端（core 对手）：arena_core_agent 全链路短对局。
 *
 * 子进程测试依赖本机 reference/ 仓库 + Python——环境缺失时自动跳过。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { protoPlanToPlan, type ProtoCommandPlan } from "../src/sim/opponent/protocol-bridge.ts";
import { runMatch, type TournEntry } from "../src/sim/opponent/tournament.ts";
import {
  OpponentAdapter,
  PersistentSubprocessDecider,
} from "../src/sim/opponent/opponent-adapter.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function findCoordinationRoot(start: string): string {
  let current = start;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, "reference", "arena-hero-python"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(PACKAGE_ROOT, "..", "..", "..");
}
const COORDINATION_ROOT = findCoordinationRoot(PACKAGE_ROOT);
const CORE_REPO = join(COORDINATION_ROOT, "reference", "arena-hero-guide");
const SDK_REPO = join(COORDINATION_ROOT, "reference", "arena-hero-python");
const FARMER_REPO = join(COORDINATION_ROOT, "reference", "arena-hero-agent");
const EVOLVE_REPO = join(COORDINATION_ROOT, "reference", "arena-evolve");

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";

test("protoPlanToPlan：unit_actions 偶发 null action 跳过（外部 agent 黑盒防御）", () => {
  const plan: ProtoCommandPlan = {
    tick: 1,
    unit_actions: {
      "33333333-0000-0000-0000-000000000007": { type: "MOVE", direction: "UP" },
      "33333333-0000-0000-0000-000000000017": null, // 官方 SDK 序列化偶发 null
      "33333333-0000-0000-0000-000000000027": { type: "HARVEST" },
    },
    core_action: { type: "SPAWN", unit_type: "WORKER" },
  };
  const translated = protoPlanToPlan(plan, "core");
  // null action 被跳过：不崩、不产生空动作
  assert.deepEqual(Object.keys(translated.unitActions).sort(), [
    "33333333-0000-0000-0000-000000000007",
    "33333333-0000-0000-0000-000000000027",
  ]);
  assert.equal(translated.unitActions["33333333-0000-0000-0000-000000000007"].type, "MOVE");
  assert.equal(translated.coreAction?.type, "SPAWN");
});

const reposAvailable = [CORE_REPO, SDK_REPO, FARMER_REPO].every(existsSync);
const evolveAvailable = [SDK_REPO, FARMER_REPO, EVOLVE_REPO].every(existsSync);

test(
  "常驻桥：arena_core_agent 端到端短对局（--agent core 全链路）",
  { skip: reposAvailable ? false : "reference 仓库缺失（arena-hero-guide/python/agent）" },
  () => {
    const ours: TournEntry = {
      id: "mine",
      desc: "my safety aggressive",
      build: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", attackForce: 2 }),
    };
    const opponent: TournEntry = {
      id: "core-s1",
      desc: "arena_core_agent",
      build: () => {
        const decider = new PersistentSubprocessDecider({
          farmerRepoDir: FARMER_REPO,
          sdkRepoDir: SDK_REPO,
          farmerPath: join(FARMER_REPO, "arena_farmer.py"),
          agent: "core",
        });
        return new OpponentAdapter(decider, "core-s1", "core");
      },
    };
    const result = runMatch(ours, opponent, 1, 5, MANIFEST_PATH, { validatePlans: false });
    // 对局完整跑完，无崩溃；双方都有结算数据
    assert.equal(result.tickCount, 5);
    assert.ok(result.eventCount > 0);
    assert.ok(result.finalResources["mine"] !== undefined);
    assert.ok(result.finalResources["core-s1"] !== undefined);
  },
);

test(
  "常驻桥：arena-evolve 进化冠军可作为模拟器对手端到端运行",
  { skip: evolveAvailable ? false : "reference 仓库缺失（arena-evolve/python/agent）" },
  () => {
    const ours: TournEntry = {
      id: "mine",
      desc: "my safety aggressive",
      build: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", attackForce: 2 }),
    };
    const opponent: TournEntry = {
      id: "arena-evolve-s1",
      desc: "arena-evolve evolved champion",
      build: () => {
        const decider = new PersistentSubprocessDecider({
          farmerRepoDir: FARMER_REPO,
          sdkRepoDir: SDK_REPO,
          farmerPath: join(FARMER_REPO, "arena_farmer.py"),
          agent: "arena-evolve",
        });
        return new OpponentAdapter(decider, "arena-evolve-s1", "arena-evolve");
      },
    };
    const result = runMatch(ours, opponent, 1, 5, MANIFEST_PATH, { validatePlans: false });
    assert.equal(result.tickCount, 5);
    assert.ok(result.eventCount > 0);
    assert.ok(result.finalResources["mine"] !== undefined);
    assert.ok(result.finalResources["arena-evolve-s1"] !== undefined);
  },
);
