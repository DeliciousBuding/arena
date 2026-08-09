/**
 * 饿死迁移兜底测试（W40 规格，M7 补位，2026-08-09）。
 *
 * 参考 arena-evolve heuristic.py：MIGRATE_STARVE_TICKS=300/MIGRATE_COOLDOWN=400，
 * 此处保守加倍 triggerTicks=600。覆盖规格全部 7 个用例：
 *
 * 1. 600 tick 无采集 + 无新鲜资源目击 → 触发 starveTrigger；
 * 2. 冷却期内不重触发；
 * 3. HARVEST_SUCCEEDED 事件重置 starveSince；
 * 4. selectTarget 无候选通过 → 兜底方向计划（不 ABORT，starveTrigger 仍带目标）；
 * 5. 已有计划 / --target 意图不覆盖（plan !== null → 不跑饿死检测）；
 * 6. coreEvade 活跃（敌核贴脸 / Core MOVING）不触发；
 * 7. 变体关零回归：starveTriggerTicks 未设 → 永不触发。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  conductorStep,
  INITIAL_CONDUCTOR_HELD_STATE,
  CONDUCTOR_LEASE_HORIZON_TICKS,
  HARVEST_SUCCEEDED_EVENT,
  STARVE_DEATH_ZONE_AVOID_RADIUS,
  type ConductorHeldState,
  type ConductorStepInput,
} from "../src/migration/conductor.ts";
import { DEFAULT_MIGRATION_RUNTIME_CONFIG } from "../src/migration/config.ts";
import type { MigrationRuntimeConfig } from "../src/migration/config.ts";
import type { MigrationPlanV1 } from "../src/migration/plan.ts";

const NOW_BASE_MS = 1_800_000_000_000;
const TICK_MS = 1_000;
const START_TICK = 1_000;

/** W40 测试用 config：开启饿死兜底（triggerTicks=600，cooldown=400，minAreaSeen=30）。 */
const STARVE_CONFIG: MigrationRuntimeConfig = {
  ...DEFAULT_MIGRATION_RUNTIME_CONFIG,
  starveTriggerTicks: 600,
  starveCooldownTicks: 400,
  starveMinAreaSeen: 30,
};

/**
 * 已勘探区域的陈旧矿格：>= minAreaSeen(30) 个，全部 lastSeenTick 远早于当前
 * tick（窗口 > triggerTicks）→ 满足"区域已勘探 + 无新鲜资源目击"双判据。
 * 所有矿格远离 [0,0] 死亡区（chebyshev > STARVE_DEATH_ZONE_AVOID_RADIUS）。
 */
function staleExploredResources(count: number, tick: number, triggerTicks: number): readonly { readonly x: number; readonly y: number; readonly lastSeenTick: number }[] {
  const cells: { readonly x: number; readonly y: number; readonly lastSeenTick: number }[] = [];
  const staleTick = tick - triggerTicks - 10; // 远超 triggerTicks 窗口
  let index = 0;
  while (cells.length < count) {
    // 沿 +x/+y 方向铺设，确保远离 [0,0] 死亡区
    const x = 25 + (index % 10) * 3;
    const y = 25 + Math.floor(index / 10) * 3;
    cells.push({ x, y, lastSeenTick: staleTick });
    index += 1;
  }
  return cells;
}

function makeCore(position: readonly [number, number] = [40, 40]): ConductorStepInput["core"] {
  return {
    id: "uuid-starve",
    position,
    state: "NORMAL",
    hp: 5,
  };
}

function starveStep(
  held: Readonly<ConductorHeldState> | null,
  tick: number,
  config: MigrationRuntimeConfig = STARVE_CONFIG,
  overrides: Partial<ConductorStepInput> = {},
) {
  return conductorStep({
    tick,
    nowMs: NOW_BASE_MS + tick * TICK_MS,
    core: makeCore(),
    events: [],
    units: [],
    survey: {
      resources: staleExploredResources(40, tick, config.starveTriggerTicks ?? 600),
      enemyCores: [],
    },
    config,
    held,
    plan: null, // 饿死检测只在 plan=null 时跑
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 用例 1：600 tick 无采集 + 无新鲜资源目击 → 触发
// ---------------------------------------------------------------------------

test("用例1：600 tick 无采集 + 无新鲜资源目击 → starveSince 达标 → starveTrigger 触发（带目标）", () => {
  // starveSince 每个 starving tick +1；从 0 到 600 需 600 次 +1。
  // 第 1 个 starving tick = START_TICK（starveSince 0→1）；第 600 个 = START_TICK+599（starveSince 599→600 达标）
  const triggerTick = START_TICK + 599;
  let held: ConductorHeldState = INITIAL_CONDUCTOR_HELD_STATE;
  // 推进 598 tick（starveSince 1..598，均 < 600 不触发）
  for (let tick = START_TICK; tick < triggerTick; tick += 1) {
    const result = starveStep(held, tick);
    held = result.held;
    assert.equal(result.starveTrigger, undefined, `tick ${tick}（starveSince ${held.starveSince}）不应触发`);
  }
  // 第 600 个 starving tick：starveSince 599→600 ≥ 600 → 触发
  const triggered = starveStep(held, triggerTick);
  assert.notEqual(triggered.starveTrigger, undefined, "600 tick 无采集应触发饿死兜底");
  assert.ok(triggered.starveTrigger!.target.x !== 0 || triggered.starveTrigger!.target.y !== 0, "兜底目标不得落在 [0,0] 死亡区");
  assert.equal(triggered.held.starveSince, 0, "触发后 starveSince 应复位");
  assert.equal(triggered.held.starveCooldownUntil, triggerTick + 400, "冷却应 = tick + cooldownTicks");
});

// ---------------------------------------------------------------------------
// 用例 2：冷却期内不重触发
// ---------------------------------------------------------------------------

test("用例2：冷却期内（400 tick）不重触发；冷却+starveSince 再次达标后重触发", () => {
  const triggerTick = START_TICK + 599;
  // 先触发一次
  let held: ConductorHeldState = INITIAL_CONDUCTOR_HELD_STATE;
  for (let tick = START_TICK; tick <= triggerTick; tick += 1) {
    held = starveStep(held, tick).held;
  }
  assert.equal(held.starveCooldownUntil, triggerTick + 400, "触发后应设冷却");
  assert.equal(held.starveSince, 0, "触发后 starveSince 应复位");

  // 冷却期内（triggerTick+1 .. triggerTick+399）：starveSince 累积但 cooldown 阻止触发
  for (let offset = 1; offset <= 399; offset += 1) {
    const tick = triggerTick + offset;
    const result = starveStep(held, tick);
    held = result.held;
    assert.equal(result.starveTrigger, undefined, `冷却内 tick ${tick}（offset ${offset}）不得重触发`);
  }
  // 冷却到期（triggerTick+400）：starveSince=400 < 600，不触发
  // 此后 starveSince 继续累积；到 triggerTick+599 时 starveSince=599，triggerTick+600 时 600 达标
  const cooldownEndTick = triggerTick + 400;
  for (let tick = cooldownEndTick; tick < triggerTick + 600; tick += 1) {
    const result = starveStep(held, tick);
    held = result.held;
    assert.equal(result.starveTrigger, undefined, `冷却后 starveSince 未达标的 tick ${tick} 不得触发`);
  }
  // triggerTick+600：starveSince 599→600 达标 → 重触发
  const retriggered = starveStep(held, triggerTick + 600);
  assert.notEqual(retriggered.starveTrigger, undefined, "冷却到期且 starveSince 再次达标应重触发");
});

// ---------------------------------------------------------------------------
// 用例 3：HARVEST_SUCCEEDED 事件重置 starveSince
// ---------------------------------------------------------------------------

test("用例3：HARVEST_SUCCEEDED 事件 → starveSince 重置为 0（即便已累积 598）", () => {
  let held: ConductorHeldState = INITIAL_CONDUCTOR_HELD_STATE;
  // 累积 598 tick（starveSince=598，差 2 不触发）
  for (let tick = START_TICK; tick < START_TICK + 598; tick += 1) {
    held = starveStep(held, tick).held;
  }
  assert.equal(held.starveSince, 598, "598 tick 后 starveSince 应为 598");
  // 注入 HARVEST_SUCCEEDED → 重置（本 tick starveSince 归 0，不 +1）
  const harvestTick = START_TICK + 598;
  const result = starveStep(held, harvestTick, STARVE_CONFIG, {
    events: [{ type: HARVEST_SUCCEEDED_EVENT }],
  });
  assert.equal(result.held.starveSince, 0, "HARVEST_SUCCEEDED 应重置 starveSince");
  assert.equal(result.starveTrigger, undefined, "重置后 starveSince=0 不得触发");
});

// ---------------------------------------------------------------------------
// 用例 4：无候选 → 兜底方向计划（不 ABORT）
// ---------------------------------------------------------------------------

test("用例4：selectTarget 无候选通过（资源陈旧/不达富集下限）→ 兜底方向锚点（远离 [0,0]），starveTrigger 仍带目标", () => {
  // 手动构造就绪态（starveSince=600，冷却已过），直接验证触发 + 兜底目标
  const readyHeld: ConductorHeldState = {
    ...INITIAL_CONDUCTOR_HELD_STATE,
    starveSince: 600,
    starveCooldownUntil: 0, // 冷却已过
  };
  const triggered = starveStep(readyHeld, START_TICK + 700);
  assert.notEqual(triggered.starveTrigger, undefined, "starveSince=600 + 冷却已过应触发");
  const target = triggered.starveTrigger!.target;
  // 兜底目标必须远离 [0,0] 死亡区（chebyshev > STARVE_DEATH_ZONE_AVOID_RADIUS）
  const distanceFromOrigin = Math.max(Math.abs(target.x), Math.abs(target.y));
  assert.ok(
    distanceFromOrigin > STARVE_DEATH_ZONE_AVOID_RADIUS,
    `兜底目标 [${target.x},${target.y}] 必须远离 [0,0] 死亡区（> ${STARVE_DEATH_ZONE_AVOID_RADIUS}）`,
  );
});

// ---------------------------------------------------------------------------
// 用例 5：已有计划 / --target 意图不覆盖
// ---------------------------------------------------------------------------

test("用例5：plan !== null（已有计划）→ 不跑饿死检测（starveTrigger 永远 undefined）", () => {
  const plan: MigrationPlanV1 = {
    schema: "migration-plan-v1",
    operationId: "op-starve-existing",
    revision: 1,
    conductorEpoch: 0,
    tenant: "t1",
    mode: "migrate",
    state: "PLAN",
    core: { originCoreId: "uuid-starve", currentCoreId: "uuid-starve", generation: 1 },
    lease: {
      untilTick: START_TICK + 600 + CONDUCTOR_LEASE_HORIZON_TICKS,
      heartbeatAt: new Date(NOW_BASE_MS + (START_TICK + 600) * TICK_MS).toISOString(),
    },
    target: { x: 100, y: 100, reason: "已有 --target 意图" },
    path: { cells: [], corridorWidth: 8, lookahead: 30 },
    legs: [],
    legProgress: { legIndex: 0, cellsThisLeg: 0 },
    pace: { ...DEFAULT_MIGRATION_RUNTIME_CONFIG.pace },
    roles: { quotas: { escort: 40, sweep: 30, scout: 15, rear: 15 }, seed: 1 },
    conductor: { pid: 4242 },
    updatedAt: new Date(NOW_BASE_MS + START_TICK * TICK_MS).toISOString(),
  };
  // 即便 starveSince 已累积 600+，有计划就不触发
  const readyHeld: ConductorHeldState = {
    ...INITIAL_CONDUCTOR_HELD_STATE,
    starveSince: 700,
    starveCooldownUntil: 0,
  };
  const result = conductorStep({
    tick: START_TICK + 700,
    nowMs: NOW_BASE_MS + (START_TICK + 700) * TICK_MS,
    core: makeCore(),
    events: [],
    units: [],
    survey: {
      resources: staleExploredResources(40, START_TICK + 700, 600),
      enemyCores: [],
    },
    config: STARVE_CONFIG,
    held: readyHeld,
    plan, // 有计划
  });
  assert.equal(result.starveTrigger, undefined, "已有计划时不得输出饿死信号");
  // plan !== null → conductor 走正常 PLAN 阶段（不返回 null）
  assert.notEqual(result.plan, null, "已有计划应正常推进（不返回 null）");
});

// ---------------------------------------------------------------------------
// 用例 6：coreEvade 中不触发
// ---------------------------------------------------------------------------

test("用例6a：Core MOVING（coreEvade/移动中）→ 不触发饿死", () => {
  const readyHeld: ConductorHeldState = {
    ...INITIAL_CONDUCTOR_HELD_STATE,
    starveSince: 600,
    starveCooldownUntil: 0,
  };
  const result = starveStep(readyHeld, START_TICK + 700, STARVE_CONFIG, {
    core: { id: "uuid-starve", position: [40, 40], state: "MOVING", hp: 5 },
  });
  assert.equal(result.starveTrigger, undefined, "Core MOVING 时不得触发饿死");
  assert.ok(result.reasons.some((r) => r.includes("MOVING")), `reasons 应注明 MOVING：${result.reasons.join("|")}`);
});

test("用例6b：活跃敌核贴脸（coreEvade 活跃，≤ hold.enterRadius=12）→ 不触发饿死", () => {
  const readyHeld: ConductorHeldState = {
    ...INITIAL_CONDUCTOR_HELD_STATE,
    starveSince: 600,
    starveCooldownUntil: 0,
  };
  const result = starveStep(readyHeld, START_TICK + 700, STARVE_CONFIG, {
    survey: {
      resources: staleExploredResources(40, START_TICK + 700, 600),
      enemyCores: [{ x: 48, y: 40, lastSeenTick: START_TICK + 700 }], // 距核心 [40,40] = 8 ≤ 12
    },
  });
  assert.equal(result.starveTrigger, undefined, "coreEvade 活跃（敌核贴脸）时不得触发饿死");
  assert.ok(result.reasons.some((r) => r.includes("coreEvade")), `reasons 应注明 coreEvade：${result.reasons.join("|")}`);
});

// ---------------------------------------------------------------------------
// 用例 7：变体关零回归（starveTriggerTicks 未设 → 永不触发）
// ---------------------------------------------------------------------------

test("用例7：变体关零回归——config.starveTriggerTicks undefined → 600+ tick 无采集也不触发", () => {
  let held: ConductorHeldState = INITIAL_CONDUCTOR_HELD_STATE;
  const configWithoutStarve = DEFAULT_MIGRATION_RUNTIME_CONFIG; // 未设 starve 字段
  for (let tick = START_TICK; tick < START_TICK + 800; tick += 1) {
    const result = starveStep(held, tick, configWithoutStarve);
    held = result.held;
    assert.equal(result.starveTrigger, undefined, `零回归：tick ${tick} 不得触发`);
  }
  // starveSince 保持 0（未启用检测不累积）
  assert.equal(held.starveSince, 0, "零回归：未启用时 starveSince 不得累积");
});
// ---------------------------------------------------------------------------
// 用例 8：per-game-tick 去重（run-conductor 同 tick 多次轮询不得 3x 压缩）
// ---------------------------------------------------------------------------

test("用例8：同 tick 3 次轮询 → starveSince 只按游戏 tick 增长", () => {
  const first = starveStep(INITIAL_CONDUCTOR_HELD_STATE, 1_000);
  assert.equal(first.held.starveSince, 1, "首个 starving 游戏 tick 计 1");
  assert.equal(first.held.starveRecordedTick, 1_000, "计数同时记录当前游戏 tick");
  const poll2 = starveStep(first.held, 1_000);
  assert.equal(poll2.held.starveSince, 1, "同 tick 第二次轮询不得累加");
  const poll3 = starveStep(poll2.held, 1_000);
  assert.equal(poll3.held.starveSince, 1, "同 tick 第三次轮询仍不得累加");
  const nextTick = starveStep(poll3.held, 1_001);
  assert.equal(nextTick.held.starveSince, 2, "下一游戏 tick 才累加");
  assert.equal(nextTick.held.starveRecordedTick, 1_001);
});
