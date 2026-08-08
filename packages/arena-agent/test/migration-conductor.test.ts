/**
 * 迁移 conductor 场景测试（migration-system-v1 §8 验收，M5）。
 *
 * 纯函数驱动：合成 survey/units + 引擎模拟（MOVING 4 tick/格）驱动
 * conductorStep 数百 tick，断言状态机转移（transitions 事件名）、走廊审计、
 * 节奏（burst/settle 交替、荒漠段快速续迁、cargo 阻滞）、中断分级
 * （CORE_DAMAGED → HOLD 滞回 / REPLAN / RECOVERY_ABORT / CANCEL）与
 * 完整迁移（3 seeds × 30 格 + 170 格分腿）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  conductorStep,
  CONDUCTOR_CORE_HP_FULL,
  CONDUCTOR_LEASE_HORIZON_TICKS,
  CORE_DAMAGED_EVENT,
  INITIAL_CONDUCTOR_HELD_STATE,
  type ConductorHeldState,
  type ConductorStepInput,
  type ConductorStepResult,
  type ConductorTransitionRecord,
} from "../src/migration/conductor.ts";
import { DEFAULT_MIGRATION_RUNTIME_CONFIG } from "../src/migration/config.ts";
import type { MigrationRuntimeConfig } from "../src/migration/config.ts";
import type { MigrationPlanV1 } from "../src/migration/plan.ts";

/** 墙钟基准（固定，纯函数确定性；1 tick = 1000ms，lease 心跳在 60s TTL 内）。 */
const NOW_BASE_MS = 1_800_000_000_000;
const TICK_MS = 1_000;
/** 模拟起始 tick（事件注入用绝对 tick 都以此为基：T0 + 偏移）。 */
const START_TICK = 1_000;
/** HOLD 滞回退出所需 tick（§2"≥8-12 tick"取 8；与 conductor.ts 常量一致）。 */
const CONDUCTOR_HOLD_TICKS_NEEDED = 8;
/** 引擎约束（§3.1）：核心 MOVING = 4 tick/格。 */
const MOVE_TICKS_PER_CELL = 4;

// ---------------------------------------------------------------------------
// 合成世界与引擎模拟
// ---------------------------------------------------------------------------

interface SimWorld {
  readonly resources: readonly { readonly x: number; readonly y: number; readonly lastSeenTick: number }[];
  readonly enemyCores: readonly { readonly x: number; readonly y: number; readonly lastSeenTick: number }[];
  /** 每 tick 单位快照（默认空；cargo 阻滞/清路验证注入用）。 */
  readonly unitsAt?: (tick: number, plan: MigrationPlanV1) => readonly {
    readonly id: string;
    readonly unitType: string;
    readonly cargo: number;
    readonly position?: readonly [number, number] | null;
  }[];
  /** 引擎事件注入（默认空）。 */
  readonly eventsAt?: (tick: number, plan: MigrationPlanV1) => readonly { readonly type?: string }[];
  /** 核心 hp 注入（默认满血）。 */
  readonly hpAt?: (tick: number, plan: MigrationPlanV1) => number | null;
  /** 核心 id 注入（默认沿用计划 originCoreId）。 */
  readonly coreId?: string | ((tick: number, plan: MigrationPlanV1) => string | null);
  /** cancel 注入（默认 false）。 */
  readonly cancelAt?: (tick: number, plan: MigrationPlanV1) => boolean;
  /** survey 每 tick 滚动刷新（模拟 survey-db；默认开）。 */
  readonly refreshSurvey?: boolean;
}

/** 荒漠世界：资源只聚集在路径起点（9 格 ≥ 审计下限 8），中段无近矿。 */
const DESERT_RESOURCES: readonly { readonly x: number; readonly y: number; readonly lastSeenTick: number }[] =
  (() => {
    const cells: { readonly x: number; readonly y: number; readonly lastSeenTick: number }[] = [];
    for (let x = 0; x <= 2; x += 1) {
      for (let y = 3; y <= 5; y += 1) {
        cells.push({ x, y, lastSeenTick: 0 }); // refreshSurvey 每 tick 更新
      }
    }
    return cells;
  })();

/** 确定性 PRNG（mulberry32）：seed 只影响障碍布局，迁移确定性由纯函数保证。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 合成世界（seed 决定走廊内资源布局；资源离路径行 ≥3 格，不挡直线路由）。 */
function seededWorld(seed: number, pathLength: number): SimWorld {
  const rng = mulberry32(seed);
  const seen = new Set<string>();
  const resources: { readonly x: number; readonly y: number; readonly lastSeenTick: number }[] = [];
  while (resources.length < 12) {
    const x = Math.floor(rng() * pathLength);
    const y = 3 + Math.floor(rng() * 5);
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resources.push({ x, y, lastSeenTick: 0 });
  }
  return { resources, enemyCores: [] };
}

function makeInitialPlan(targetX: number, startTick = 1000, overrides: Partial<MigrationPlanV1> = {}): MigrationPlanV1 {
  return {
    schema: "migration-plan-v1",
    operationId: "op-m5-test-01",
    revision: 1,
    conductorEpoch: 0,
    tenant: "t1",
    mode: "migrate",
    state: "PLAN",
    core: { originCoreId: "uuid-A", currentCoreId: "uuid-A", generation: 1 },
    lease: {
      untilTick: startTick + CONDUCTOR_LEASE_HORIZON_TICKS,
      heartbeatAt: new Date(NOW_BASE_MS + startTick * TICK_MS).toISOString(),
    },
    target: { x: targetX, y: 0, reason: "M5 合成测试目标" },
    path: { cells: [], corridorWidth: DEFAULT_MIGRATION_RUNTIME_CONFIG.corridor.width, lookahead: DEFAULT_MIGRATION_RUNTIME_CONFIG.corridor.lookahead },
    legs: [],
    legProgress: { legIndex: 0, cellsThisLeg: 0 },
    pace: { ...DEFAULT_MIGRATION_RUNTIME_CONFIG.pace },
    roles: { quotas: { escort: 40, sweep: 30, scout: 15, rear: 15 }, seed: 1 },
    conductor: { pid: 4242 },
    updatedAt: new Date(NOW_BASE_MS + startTick * TICK_MS).toISOString(),
    ...overrides,
  };
}

class MigrationSim {
  tick: number;
  nowMs: number;
  plan: MigrationPlanV1 | null;
  held: ConductorHeldState | null;
  readonly world: SimWorld;
  readonly config: MigrationRuntimeConfig;
  coreState: "NORMAL" | "MOVING";
  corePosition: readonly [number, number];
  coreId: string | null;
  hp: number | null;
  moveRemaining: number;
  readonly transitions: ConductorTransitionRecord[] = [];
  readonly reasonsLog: string[] = [];
  readonly leaseLog: { readonly tick: number; readonly nowMs: number; readonly untilTick: number }[] = [];
  readonly corePathLog: { readonly tick: number; readonly pathIndex: number }[] = [];

  constructor(
    plan: MigrationPlanV1 | null,
    world: SimWorld,
    startTick: number,
    startPosition: readonly [number, number],
    coreId: string | null,
  ) {
    this.plan = plan;
    this.world = world;
    this.tick = startTick;
    this.nowMs = NOW_BASE_MS + startTick * TICK_MS;
    this.config = DEFAULT_MIGRATION_RUNTIME_CONFIG;
    this.held = null;
    this.coreState = "NORMAL";
    this.corePosition = startPosition;
    this.coreId = coreId;
    this.hp = CONDUCTOR_CORE_HP_FULL;
    this.moveRemaining = 0;
  }

  /** 模拟"进程重启"：held 丢弃、计划从磁盘读回（引擎状态继续）。 */
  resumeFromDiskPlan(plan: MigrationPlanV1): void {
    this.plan = plan;
    this.held = null;
  }

  /** 模拟"conductor 停机期间游戏继续"：核心自行推进到指定路径格。 */
  teleportCoreTo(pathIndex: number): void {
    const cells = this.plan?.path.cells ?? [];
    const cell = cells[pathIndex];
    assert.notEqual(cell, undefined, `路径格 ${pathIndex} 不存在（路径 ${cells.length} 格）`);
    this.coreState = "NORMAL";
    this.corePosition = cell;
    this.moveRemaining = 0;
  }

  private survey(): ConductorStepInput["survey"] {
    const refresh = this.world.refreshSurvey !== false;
    const tick = this.tick;
    return {
      resources: this.world.resources.map((r) => (refresh ? { ...r, lastSeenTick: tick } : r)),
      enemyCores: this.world.enemyCores.map((e) => (refresh ? { ...e, lastSeenTick: tick } : e)),
    };
  }

  private pathIndexOf(position: readonly [number, number]): number {
    const cells = this.plan?.path.cells ?? [];
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index]!;
      if (cell[0] === position[0] && cell[1] === position[1]) return index;
    }
    return -1;
  }

  /** 引擎模拟：LEG_MOVE + NORMAL → 下个 tick 起 MOVING（4 tick/格）→ 到达下一格。 */
  private advanceEngine(): void {
    if (this.plan === null) return;
    if (this.plan.state === "LEG_MOVE" && this.coreState === "NORMAL") {
      const index = this.pathIndexOf(this.corePosition);
      const cells = this.plan.path.cells;
      if (index >= 0 && index < cells.length - 1) {
        this.coreState = "MOVING";
        this.moveRemaining = MOVE_TICKS_PER_CELL;
      }
    } else if (this.coreState === "MOVING") {
      this.moveRemaining -= 1;
      if (this.moveRemaining <= 0) {
        this.coreState = "NORMAL";
        const index = this.pathIndexOf(this.corePosition);
        const next = this.plan!.path.cells[index + 1];
        if (next !== undefined) this.corePosition = next;
      }
    }
  }

  step(): ConductorStepResult {
    const plan = this.plan;
    assert.notEqual(plan, null, "模拟器必须有计划");
    const id =
      typeof this.world.coreId === "function" ? this.world.coreId(this.tick, plan!) : (this.world.coreId ?? this.coreId);
    const input: ConductorStepInput = {
      tick: this.tick,
      nowMs: this.nowMs,
      core: {
        id,
        position: this.corePosition,
        state: this.coreState,
        hp: this.world.hpAt?.(this.tick, plan!) ?? this.hp,
      },
      events: this.world.eventsAt?.(this.tick, plan!) ?? [],
      units: (this.world.unitsAt?.(this.tick, plan!) ?? []).map((unit) => ({
        id: unit.id,
        unitType: unit.unitType,
        cargo: unit.cargo,
        position: unit.position ?? null,
      })),
      survey: this.survey(),
      config: this.config,
      held: this.held,
      plan: plan!,
      cancelRequested: this.world.cancelAt?.(this.tick, plan!) ?? false,
    };
    const result = conductorStep(input);
    this.plan = result.plan;
    this.held = result.held;
    this.transitions.push(...result.transitions);
    this.reasonsLog.push(...result.reasons);
    this.corePathLog.push({ tick: this.tick, pathIndex: this.pathIndexOf(this.corePosition) });
    if (result.plan !== null) {
      this.leaseLog.push({ tick: this.tick, nowMs: this.nowMs, untilTick: result.plan.lease.untilTick });
    }
    this.advanceEngine();
    this.tick += 1;
    this.nowMs += TICK_MS;
    return result;
  }

  transitionEvents(): readonly string[] {
    return this.transitions.map((t) => t.event);
  }

  reasonsContain(substring: string): boolean {
    return this.reasonsLog.some((reason) => reason.includes(substring));
  }
}

function runUntil(sim: MigrationSim, predicate: (sim: MigrationSim) => boolean, maxTicks: number): void {
  for (let count = 0; count < maxTicks; count += 1) {
    sim.step();
    if (predicate(sim)) return;
  }
  assert.fail(
    `未在 ${maxTicks} tick 内满足条件（state=${sim.plan?.state ?? "null"}，tick=${sim.tick}，最后理由=${sim.transitions.length > 0 ? "" : "无转移"}）`,
  );
}

/** burst/settle 成对时长（tick）：entries = LEG_BURST_DONE，exits = LEG_SETTLE_DONE。 */
function settleDurations(sim: MigrationSim): number[] {
  const entries: number[] = [];
  const exits: number[] = [];
  for (const t of sim.transitions) {
    if (t.event === "LEG_BURST_DONE") entries.push(t.tick);
    if (t.event === "LEG_SETTLE_DONE") exits.push(t.tick);
  }
  assert.equal(entries.length, exits.length, "burst/settle 必须成对交替");
  return exits.map((exit, index) => exit - entries[index]!);
}

/** 核心路径下标单调性（位置为真值 → 路径推进不倒退）。 */
function assertPathMonotonic(sim: MigrationSim): void {
  let previous = -1;
  for (const entry of sim.corePathLog) {
    if (entry.pathIndex < 0) continue; // PLAN 阶段路径未生成
    assert.ok(entry.pathIndex >= previous, `tick ${entry.tick} 路径下标回退：${previous} → ${entry.pathIndex}`);
    previous = entry.pathIndex;
  }
}

// ---------------------------------------------------------------------------
// 场景 1：PLAN 审计拒绝（段中活跃敌核）与审计通过
// ---------------------------------------------------------------------------

test("场景1：敌核在路径中段（corridorWidth 内）→ PLAN_REJECTED → ABORT → 下次清理", () => {
  const world: SimWorld = {
    resources: DESERT_RESOURCES,
    enemyCores: [{ x: 15, y: 1, lastSeenTick: 0 }], // 活跃敌核，距路径中段 1 格
  };
  const sim = new MigrationSim(makeInitialPlan(29), world, 1000, [0, 0], "uuid-A");

  const first = sim.step();
  assert.equal(first.plan?.state, "ABORT", "审计拒绝应转入 ABORT");
  assert.ok(first.reasons.join("").includes("敌核"), `reasons 应含敌核原因：${first.reasons.join("|")}`);
  assert.ok(first.transitions.some((t) => t.event === "PLAN_REJECTED"), "应记录 PLAN_REJECTED 转移");

  const second = sim.step();
  assert.equal(second.plan, null, "ABORT 后下一步应返回 null（请调用方清理计划文件）");
});

test("场景1b：无活跃敌核 → 走廊审计通过 → LEG_MOVE", () => {
  const world: SimWorld = { resources: DESERT_RESOURCES, enemyCores: [] };
  const sim = new MigrationSim(makeInitialPlan(29), world, 1000, [0, 0], "uuid-A");

  const result = sim.step();
  assert.equal(result.plan?.state, "LEG_MOVE");
  assert.ok(result.transitions.some((t) => t.event === "PLAN_AUDITED"));
  assert.equal(result.plan?.path.cells.length, 30, "30 格直线路径");
  assert.equal(result.plan?.legs.length, 1, "30 格 ≤ legMaxCells(150) → 单腿");
  assert.equal(result.plan?.legs[0]?.audit.ok, true);
  assert.equal(result.plan?.legs[0]?.audit.activeEnemyCores, 0);
  assert.equal(result.plan?.path.corridorWidth, 8);
  assert.equal(result.plan?.path.lookahead, 30);
});

// ---------------------------------------------------------------------------
// 场景 2：荒漠段（起点矿簇之外无近矿）→ minSettle 即走；富集段自动多停；cargo 阻滞
// ---------------------------------------------------------------------------

test("场景2：荒漠段快速续迁（settle < maxSettle）；起点富集段多停（== maxSettle）；满载 worker 阻滞", () => {
  // 时序（T0=1000，单元格 5 tick 到达）：burst1 完成 1040 → 富集休整 1041..1160；
  // burst2 完成 1200 → 荒漠休整 1201..1230；cargo 窗口 [1225,1235] 把该次休整拖到 1236（36 tick）
  const cargoWindow: { from: number; to: number } = { from: START_TICK + 225, to: START_TICK + 235 };
  const world: SimWorld = {
    resources: DESERT_RESOURCES,
    enemyCores: [],
    unitsAt: (tick) =>
      tick >= cargoWindow.from && tick <= cargoWindow.to
        ? [{ id: "w1", unitType: "WORKER", cargo: 2 }]
        : [{ id: "w1", unitType: "WORKER", cargo: 0 }],
  };
  const sim = new MigrationSim(makeInitialPlan(29), world, START_TICK, [0, 0], "uuid-A");

  runUntil(sim, (s) => s.plan?.state === "ARRIVED", 3_000);
  assert.equal(sim.plan?.state, "ARRIVED");
  assert.deepEqual(
    settleDurations(sim),
    [120, 36, 30, 30],
    "富集段（起点矿簇近旁）多停至 maxSettle；cargo 阻滞 6 tick（30→36）；荒漠段 30 即走",
  );
  const lastSettle = settleDurations(sim)[2]!;
  assert.ok(lastSettle < 120, "荒漠段 settle 必须 < maxSettle");
  assertPathMonotonic(sim);
});

// ---------------------------------------------------------------------------
// 场景 3：受击中断 → DEFENSIVE_HOLD 滞回（hp 未满不退出）→ THREAT_CLEARED → 续迁
// ---------------------------------------------------------------------------

test("场景3：LEG_MOVE 受击 → HOLD；hp 未满时滞回不退出；hp 回满 → THREAT_CLEARED → 恢复推进到 ARRIVED", () => {
  const hitTick = START_TICK + 245; // burst 3 中段（核心约在第 18 格）
  const world: SimWorld = {
    resources: DESERT_RESOURCES,
    enemyCores: [],
    eventsAt: (tick) => (tick === hitTick ? [{ type: CORE_DAMAGED_EVENT }] : []),
    // 受击后 hp=3 持续 10 tick（不满足"hp 满"），随后回满
    hpAt: (tick) => (tick >= hitTick && tick <= hitTick + 9 ? 3 : CONDUCTOR_CORE_HP_FULL),
  };
  const sim = new MigrationSim(makeInitialPlan(29), world, 1000, [0, 0], "uuid-A");

  runUntil(sim, (s) => s.transitions.some((t) => t.event === "CORE_DAMAGED"), 500);
  assert.equal(sim.plan?.state, "DEFENSIVE_HOLD");
  assert.ok(sim.held!.holdEntryCount >= 1);

  // hp 未满（3/5）：滞回已到 8 tick 仍不得退出（holdTicks 达 8 时仍处 HOLD）
  runUntil(sim, (s) => s.held!.holdTicks === CONDUCTOR_HOLD_TICKS_NEEDED && s.plan?.state === "DEFENSIVE_HOLD", 50);
  assert.equal(sim.plan?.state, "DEFENSIVE_HOLD", "hp 未满时即使无威胁 ≥8 tick 也不得退出");
  assert.equal(sim.held!.holdTicks, CONDUCTOR_HOLD_TICKS_NEEDED);

  // hp 回满 → THREAT_CLEARED → LEG_SETTLE
  runUntil(sim, (s) => s.transitions.some((t) => t.event === "THREAT_CLEARED"), 50);
  assert.equal(sim.plan?.state, "LEG_SETTLE");
  assert.ok(sim.held!.holdTicks >= 8, "退出时滞回计数 ≥ 8");

  // 恢复后继续推进到 ARRIVED
  runUntil(sim, (s) => s.plan?.state === "ARRIVED", 2_000);
  assert.equal(sim.plan?.state, "ARRIVED");
  assert.deepEqual(sim.plan!.core.currentCoreId, "uuid-A");
  assertPathMonotonic(sim);
});

// ---------------------------------------------------------------------------
// 场景 4：重复 HOLD → REPLAN（revision+1）
// ---------------------------------------------------------------------------

test("场景4：600 tick 内第 2 次受击 → REPLAN_REQUESTED → PLAN（revision+1），重新审计后继续", () => {
  const firstHit = START_TICK + 40; // burst 1 中段
  const secondHit = firstHit + 55; // 首次 HOLD 清退后、休整期间（< 600 tick 窗口）
  const world: SimWorld = {
    resources: DESERT_RESOURCES,
    enemyCores: [],
    eventsAt: (tick) =>
      tick === firstHit || tick === secondHit ? [{ type: CORE_DAMAGED_EVENT }] : [],
    hpAt: (tick) =>
      tick === firstHit || tick === secondHit ? 3 : CONDUCTOR_CORE_HP_FULL,
  };
  const sim = new MigrationSim(makeInitialPlan(29), world, 1000, [0, 0], "uuid-A");

  runUntil(sim, (s) => s.transitions.some((t) => t.event === "REPLAN_REQUESTED"), 500);
  assert.equal(sim.plan?.state, "PLAN", "重复进入 → REPLAN 回 PLAN");
  assert.equal(sim.plan?.revision, 2, "REPLAN 应 revision+1");
  const firstEntry = sim.transitions.find((t) => t.event === "CORE_DAMAGED")!.tick;
  assert.ok(secondHit - firstEntry <= 600, "两次受击在重复窗口内");

  // 重新 PLAN（世界无敌核 → 审计通过）→ LEG_MOVE → 继续到 ARRIVED
  runUntil(sim, (s) => s.plan?.state === "LEG_MOVE", 200);
  assert.ok(sim.transitionEvents().includes("PLAN_AUDITED"), "REPLAN 后重新审计通过");
  runUntil(sim, (s) => s.plan?.state === "ARRIVED", 2_000);
  assert.equal(sim.plan?.state, "ARRIVED");
  assert.equal(sim.plan?.revision, 2);
});

// ---------------------------------------------------------------------------
// 场景 5：CORE_DESTROYED / 核心 id 变化 → RECOVERY_ABORT（计划保留供审计）
// ---------------------------------------------------------------------------

test("场景5a：CORE_DESTROYED → RECOVERY_ABORT，计划保留（state=RECOVERY_ABORT），后续 step 不再推进", () => {
  const world: SimWorld = {
    resources: DESERT_RESOURCES,
    enemyCores: [],
    eventsAt: (tick) => (tick === START_TICK + 60 ? [{ type: "CORE_DESTROYED" }] : []),
  };
  const sim = new MigrationSim(makeInitialPlan(29), world, 1000, [0, 0], "uuid-A");

  runUntil(sim, (s) => s.plan?.state === "RECOVERY_ABORT", 500);
  const plan = sim.plan!;
  assert.equal(plan.state, "RECOVERY_ABORT");
  assert.equal(plan.core.generation, 2, "核心被毁 → 代际 +1");
  assert.ok(sim.transitionEvents().includes("CORE_DESTROYED"), "应记录 CORE_DESTROYED 转移");
  assert.ok(sim.reasonsContain("禁止从旧 legProgress 续迁"), "reasons 应说明禁止续迁");

  const next = sim.step();
  assert.equal(next.plan?.state, "RECOVERY_ABORT", "终态计划保留（供指挥面审计），不自动转移");
  assert.equal(next.transitions.length, 0);
});

test("场景5b：core.id ≠ plan.core.originCoreId → CORE_GENERATION_CHANGED → RECOVERY_ABORT", () => {
  const world: SimWorld = {
    resources: DESERT_RESOURCES,
    enemyCores: [],
    coreId: (tick) => (tick >= START_TICK + 70 ? "uuid-B" : "uuid-A"), // 核心重生/换代
  };
  const sim = new MigrationSim(makeInitialPlan(29), world, 1000, [0, 0], "uuid-A");

  runUntil(sim, (s) => s.plan?.state === "RECOVERY_ABORT", 500);
  assert.equal(sim.plan?.state, "RECOVERY_ABORT");
  assert.equal(sim.plan?.core.currentCoreId, "uuid-B");
  assert.equal(sim.plan?.core.generation, 2);
  assert.ok(sim.transitionEvents().includes("CORE_GENERATION_CHANGED"));
});

// ---------------------------------------------------------------------------
// 场景 6：cancel → ABORT → 下一步清理
// ---------------------------------------------------------------------------

test("场景6：cancelRequested → CANCEL → ABORT → 下一步 plan=null 清理", () => {
  const world: SimWorld = {
    resources: DESERT_RESOURCES,
    enemyCores: [],
    cancelAt: (tick) => tick === START_TICK + 55,
  };
  const sim = new MigrationSim(makeInitialPlan(29), world, 1000, [0, 0], "uuid-A");

  runUntil(sim, (s) => s.transitions.some((t) => t.event === "CANCEL"), 500);
  assert.equal(sim.plan?.state, "ABORT", "CANCEL → ABORT");
  const next = sim.step();
  assert.equal(next.plan, null, "ABORT 后下一步应清理计划文件");
});

// ---------------------------------------------------------------------------
// 场景 7：完整迁移（3 seeds × 30 格 + 170 格分腿）
// ---------------------------------------------------------------------------

test("场景7a：完整迁移 30 格 × 3 seeds —— 逐格推进、burst/settle 交替、lease 每步刷新、终态 ARRIVED", () => {
  for (const seed of [1, 2, 3]) {
    const sim = new MigrationSim(makeInitialPlan(29), seededWorld(seed, 30), 1000, [0, 0], "uuid-A");
    runUntil(sim, (s) => s.plan?.state === "ARRIVED", 3_000);
    assert.equal(sim.plan?.state, "ARRIVED", `seed ${seed} 应到达 ARRIVED`);
    assert.deepEqual(sim.corePosition, [29, 0], `seed ${seed} 核心应停在目标格`);
    assert.equal(sim.plan!.revision, 1, `seed ${seed} 无障碍重审，revision 保持 1（同一 operation 直达）`);

    // burst/settle 交替：LEG_BURST_DONE 与 LEG_SETTLE_DONE 交替出现且以 SETTLE_DONE 收尾
    const rhythm = sim.transitionEvents().filter((e) => e === "LEG_BURST_DONE" || e === "LEG_SETTLE_DONE");
    assert.ok(rhythm.length >= 8, `seed ${seed} 应有 ≥4 组 burst/settle 交替（实得 ${rhythm.length}）`);
    rhythm.forEach((event, index) => {
      const expected = index % 2 === 0 ? "LEG_BURST_DONE" : "LEG_SETTLE_DONE";
      assert.equal(event, expected, `seed ${seed} 节奏应交替（第 ${index} 个）`);
    });
    assert.equal(rhythm[rhythm.length - 1], "LEG_SETTLE_DONE", `seed ${seed} 以休整结束收尾`);

    // 路径逐格推进（位置单调）
    assertPathMonotonic(sim);

    // lease 每步刷新：untilTick = tick + horizon，heartbeatAt = nowMs
    assert.ok(sim.leaseLog.length > 100, `seed ${seed} lease 应每步刷新`);
    for (const entry of sim.leaseLog) {
      assert.equal(entry.untilTick, entry.tick + CONDUCTOR_LEASE_HORIZON_TICKS, `seed ${seed} tick ${entry.tick} lease 过期线`);
    }
  }
});

test("场景7b：170 格路径 → 按 legMaxCells(150) 分 2 腿，legIndex 跨腿推进，终态 ARRIVED", () => {
  const sim = new MigrationSim(makeInitialPlan(169), seededWorld(7, 170), 1000, [0, 0], "uuid-A");
  runUntil(sim, (s) => s.plan?.state === "LEG_MOVE", 100);
  assert.equal(sim.plan?.path.cells.length, 170);
  assert.equal(sim.plan?.legs.length, 2, "170 格应分 2 腿（150 + 20）");
  assert.equal(sim.plan?.legs[0]?.index, 0);
  assert.equal(sim.plan?.legs[1]?.index, 1);
  assert.equal(sim.plan?.legs[1]?.to.x, 169);

  runUntil(sim, (s) => s.plan?.legProgress.legIndex === 1, 4_000);
  assert.ok(sim.transitionEvents().includes("LEG_SETTLE_DONE"), "第一腿完成应发出 LEG_SETTLE_DONE");
  assert.equal(sim.plan!.legProgress.cellsThisLeg, 0, "跨腿后 burst 计数归零");

  runUntil(sim, (s) => s.plan?.state === "ARRIVED", 6_000);
  assert.equal(sim.plan?.state, "ARRIVED");
  assert.deepEqual(sim.corePosition, [169, 0]);
});

// ---------------------------------------------------------------------------
// 场景 8：零影响（无计划）
// ---------------------------------------------------------------------------

test("场景8：无计划输入 → plan=null、无转移、held 不变、reasons 注明 IDLE", () => {
  const held: ConductorHeldState = { holdEntryCount: 2, holdFirstTick: 700, holdTicks: 3, settleElapsed: 12, stallTicks: 0, clearRetries: 0 };
  const input: ConductorStepInput = {
    tick: 500,
    nowMs: NOW_BASE_MS,
    core: null,
    events: [{ type: "CORE_DESTROYED" }], // 无计划时事件一律忽略
    units: [],
    survey: { resources: [], enemyCores: [] },
    config: DEFAULT_MIGRATION_RUNTIME_CONFIG,
    held,
    plan: null,
  };
  const result = conductorStep(input);
  assert.equal(result.plan, null);
  assert.deepEqual(result.transitions, []);
  assert.equal(result.held, held, "held 应原样透传");
  assert.deepEqual(result.reasons, ["无迁移意图，IDLE"]);

  // 新进程（held=null）同样零影响，返回初始 held
  const fresh = conductorStep({ ...input, held: null });
  assert.deepEqual(fresh.held, INITIAL_CONDUCTOR_HELD_STATE);
});
