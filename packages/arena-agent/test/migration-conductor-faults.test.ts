/**
 * 迁移 conductor 故障注入测试（migration-system-v1 §8 验收，M5）。
 *
 * 覆盖：conductor 崩溃重启续传（held=null + 计划从磁盘读回，legProgress 不
 * 倒退、不重新 PLAN）、lease 过期 fail-closed（拒绝续迁、计划原样保留）、
 * 锁 fencing（stale 接管 epoch+1，旧持有者 refresh/release 失效）、核心
 * 重生（currentCoreId ≠ originCoreId → RECOVERY_ABORT）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { conductorStep, CONDUCTOR_LEASE_HORIZON_TICKS } from "../src/migration/conductor.ts";
import {
  migrationPlanPath,
  readMigrationPlan,
  writeMigrationPlanAtomic,
} from "../src/migration/io.ts";
import { isMigrationLeaseFresh } from "../src/migration/lease.ts";
import {
  acquireConductorLock,
  refreshConductorLock,
  releaseConductorLock,
  type ConductorLockFile,
} from "../src/migration/lock.ts";
import { DEFAULT_MIGRATION_RUNTIME_CONFIG } from "../src/migration/config.ts";
import type { MigrationPlanV1 } from "../src/migration/plan.ts";

const NOW_BASE_MS = 1_800_000_000_000;
const TICK_MS = 1_000;

// ---------------------------------------------------------------------------
// 最小合成世界（与场景测试同构，但本文件自包含）
// ---------------------------------------------------------------------------

/** 起点矿簇（9 格 ≥ 审计下限 8）+ 中段荒漠：settle 在出簇后 30 tick 即走。 */
const RESOURCES: readonly { readonly x: number; readonly y: number; readonly lastSeenTick: number }[] =
  (() => {
    const cells: { readonly x: number; readonly y: number; readonly lastSeenTick: number }[] = [];
    for (let x = 0; x <= 2; x += 1) {
      for (let y = 3; y <= 5; y += 1) {
        cells.push({ x, y, lastSeenTick: 0 });
      }
    }
    return cells;
  })();

interface FaultWorld {
  readonly eventsAt?: (tick: number) => readonly { readonly type?: string }[];
  readonly coreIdAt?: (tick: number) => string | null;
  readonly hpAt?: (tick: number) => number | null;
}

function makePlan(startTick: number, overrides: Partial<MigrationPlanV1> = {}): MigrationPlanV1 {
  return {
    schema: "migration-plan-v1",
    operationId: "op-m5-fault-01",
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
    target: { x: 29, y: 0, reason: "M5 故障注入目标" },
    path: { cells: [], corridorWidth: 8, lookahead: 30 },
    legs: [],
    legProgress: { legIndex: 0, cellsThisLeg: 0 },
    pace: { ...DEFAULT_MIGRATION_RUNTIME_CONFIG.pace },
    roles: { quotas: { escort: 40, sweep: 30, scout: 15, rear: 15 }, seed: 1 },
    conductor: { pid: 4242 },
    updatedAt: new Date(NOW_BASE_MS + startTick * TICK_MS).toISOString(),
    ...overrides,
  };
}

/** 极简引擎模拟：LEG_MOVE + NORMAL → MOVING（4 tick）→ 下一格。 */
class EngineSim {
  tick: number;
  nowMs: number;
  plan: MigrationPlanV1 | null;
  readonly world: FaultWorld;
  coreState: "NORMAL" | "MOVING";
  corePosition: readonly [number, number];
  moveRemaining: number;
  readonly transitions: { readonly from: string; readonly to: string; readonly event: string; readonly tick: number }[] = [];

  constructor(plan: MigrationPlanV1 | null, world: FaultWorld, startTick: number) {
    this.tick = startTick;
    this.nowMs = NOW_BASE_MS + startTick * TICK_MS;
    this.plan = plan;
    this.world = world;
    this.coreState = "NORMAL";
    this.corePosition = [0, 0];
    this.moveRemaining = 0;
  }

  step(held: Readonly<{ readonly holdEntryCount: number; readonly holdFirstTick: number; readonly holdTicks: number; readonly settleElapsed: number }> | null): {
    readonly plan: MigrationPlanV1 | null;
    readonly held: { readonly holdEntryCount: number; readonly holdFirstTick: number; readonly holdTicks: number; readonly settleElapsed: number };
    readonly transitions: readonly { readonly from: string; readonly to: string; readonly event: string; readonly tick: number }[];
    readonly reasons: readonly string[];
  } {
    assert.notEqual(this.plan, null, "模拟器必须有计划");
    const result = conductorStep({
      tick: this.tick,
      nowMs: this.nowMs,
      core: {
        id: this.world.coreIdAt?.(this.tick) ?? this.plan!.core.currentCoreId,
        position: this.corePosition,
        state: this.coreState,
        hp: this.world.hpAt?.(this.tick) ?? 5,
      },
      events: this.world.eventsAt?.(this.tick) ?? [],
      units: [],
      survey: {
        resources: RESOURCES.map((r) => ({ ...r, lastSeenTick: this.tick })),
        enemyCores: [],
      },
      config: DEFAULT_MIGRATION_RUNTIME_CONFIG,
      held,
      plan: this.plan!,
    });
    this.plan = result.plan;
    this.transitions.push(...result.transitions);
    this.advanceEngine();
    this.tick += 1;
    this.nowMs += TICK_MS;
    return result;
  }

  private advanceEngine(): void {
    if (this.plan === null) return;
    if (this.plan.state === "LEG_MOVE" && this.coreState === "NORMAL") {
      const index = this.pathIndexOf(this.corePosition);
      if (index >= 0 && index < this.plan.path.cells.length - 1) {
        this.coreState = "MOVING";
        this.moveRemaining = 4;
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

  private pathIndexOf(position: readonly [number, number]): number {
    const cells = this.plan?.path.cells ?? [];
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index]!;
      if (cell[0] === position[0] && cell[1] === position[1]) return index;
    }
    return -1;
  }

  /** 模拟"conductor 停机期间游戏继续"：核心自行走 1 格（写入丢失也不得倒退）。 */
  walkOneCellDuringDowntime(): void {
    const cells = this.plan?.path.cells ?? [];
    const index = this.pathIndexOf(this.corePosition);
    const next = cells[index + 1];
    if (next !== undefined) {
      this.corePosition = next;
      this.coreState = "NORMAL";
    }
  }
}

// ---------------------------------------------------------------------------
// 故障 1：conductor 崩溃重启（断点续传，同一 operation）
// ---------------------------------------------------------------------------

test("故障1：崩溃重启 —— 计划从磁盘读回（held=null）续传：不倒退、不重新 PLAN，直达 ARRIVED", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-m5-conductor-crash-"));
  const planPath = migrationPlanPath(dir, "t1");
  try {
    const sim = new EngineSim(makePlan(1000), {}, 1000);
    let held: Readonly<{ readonly holdEntryCount: number; readonly holdFirstTick: number; readonly holdTicks: number; readonly settleElapsed: number }> | null = null;

    // 第一进程：推进 ~80 tick（进入第 2 个 burst），每步原子写盘
    for (let count = 0; count < 80; count += 1) {
      const result = sim.step(held);
      held = result.held;
      if (result.plan !== null) writeMigrationPlanAtomic(planPath, result.plan);
    }
    assert.ok(
      sim.plan?.state === "LEG_MOVE" || sim.plan?.state === "LEG_SETTLE",
      `崩溃点应在进行中状态（实得 ${sim.plan?.state}）`,
    );
    const diskPlan = readMigrationPlan(planPath);
    assert.equal(diskPlan.ok, true, "崩溃前计划必须已在磁盘");
    if (!diskPlan.ok) return;
    const operationId = diskPlan.plan.operationId;
    const revision = diskPlan.plan.revision;
    const legProgressBefore = diskPlan.plan.legProgress;

    // 崩溃：进程内存（held）全部丢失；期间游戏继续走 1 格（位置超前于落盘进度）
    sim.walkOneCellDuringDowntime();

    // 第二进程：held=null + 从磁盘读回计划续传
    const resumed = readMigrationPlan(planPath);
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    sim.plan = resumed.plan;
    const transitionsBefore = sim.transitions.length;

    const firstAfterResume = sim.step(null);
    assert.equal(firstAfterResume.plan?.operationId, operationId, "续传必须同一 operation");
    assert.equal(firstAfterResume.plan?.revision, revision, "续传不得重新 PLAN（revision 不变）");
    assert.ok(
      firstAfterResume.plan!.legProgress.cellsThisLeg >= legProgressBefore.cellsThisLeg,
      `legProgress 不得倒退：${legProgressBefore.cellsThisLeg} → ${firstAfterResume.plan!.legProgress.cellsThisLeg}`,
    );

    // 续传后无重审/重规划事件，直达 ARRIVED
    for (let count = 0; count < 2_000; count += 1) {
      const result = sim.step(held);
      held = result.held;
      if (result.plan !== null) writeMigrationPlanAtomic(planPath, result.plan);
      if (sim.plan?.state === "ARRIVED") break;
    }
    assert.equal(sim.plan?.state, "ARRIVED", "重启后应续传到 ARRIVED");
    assert.deepEqual(sim.corePosition, [29, 0]);
    const postResume = sim.transitions.slice(transitionsBefore);
    assert.ok(
      !postResume.some((t) => t.event === "REPLAN_REQUESTED" || t.event === "PLAN_REJECTED" || t.event === "INTENT_ACCEPTED"),
      `重启后不得重新 PLAN：${postResume.map((t) => t.event).join(",")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 故障 2：lease 过期（fail-closed：拒绝续迁）
// ---------------------------------------------------------------------------

test("故障2：lease 过期 → isMigrationLeaseFresh=false；step 拒绝续迁（计划原样保留、held 不变、无转移）", () => {
  const expiredTick = 6_000;
  const staleHeartbeatAt = new Date(NOW_BASE_MS - 120_000).toISOString(); // 心跳 2 分钟前（TTL 60s）
  const plan = makePlan(5_000, {
    lease: { untilTick: 5_000, heartbeatAt: staleHeartbeatAt }, // tick 与墙钟双双过期
  });

  assert.equal(isMigrationLeaseFresh(plan.lease, expiredTick, NOW_BASE_MS), false, "lease 应判定不新鲜");

  const held = { holdEntryCount: 1, holdFirstTick: 5_500, holdTicks: 2, settleElapsed: 0 };
  const result = conductorStep({
    tick: expiredTick,
    nowMs: NOW_BASE_MS,
    core: { id: "uuid-A", position: [8, 0], state: "NORMAL", hp: 5 },
    events: [],
    units: [],
    survey: { resources: [], enemyCores: [] },
    config: DEFAULT_MIGRATION_RUNTIME_CONFIG,
    held,
    plan,
  });
  assert.equal(result.plan, plan, "lease 过期时计划必须原样保留（不续心跳、不改状态）");
  assert.deepEqual(result.plan, plan);
  assert.equal(result.held, held, "lease 过期时 held 不变");
  assert.deepEqual(result.transitions, [], "lease 过期时不得转移");
  assert.ok(result.reasons.some((reason) => reason.includes("lease 过期")), `reasons 应注明 lease 过期：${result.reasons.join("|")}`);
});

// ---------------------------------------------------------------------------
// 故障 3：锁 fencing（stale 接管 epoch+1）——CLI 壳底层原语验证
// ---------------------------------------------------------------------------

test("故障3：锁 fencing —— stale 接管 epoch+1，旧持有者 refresh/release 全部失效", () => {
  // CLI 壳（run-conductor.mts）的锁逻辑就是 acquire → refresh → release 三个原语；
  // 脚本本身不可被 node:test import（main() 直跑），故在此直接断言其底层原语
  // 的 fencing 语义（与 lock.ts 单测互补：这里验证"接管"时序）。
  const dir = mkdtempSync(join(tmpdir(), "arena-m5-conductor-lock-"));
  const lockPath = join(dir, "t1.lock");
  try {
    // 旧 conductor（pid 1111）持锁
    const first = acquireConductorLock(lockPath, "t1", 1111);
    assert.deepEqual(first, { ok: true, epoch: 0, tookOver: false });
    assert.equal(refreshConductorLock(lockPath, "t1", 1111, 0), true, "持有者可续心跳");

    // 第二 conductor 抢锁：锁新鲜 → 拒绝（locked）
    const blocked = acquireConductorLock(lockPath, "t1", 2222);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.ok === false ? blocked.reason : "", "locked");

    // 旧 conductor 心跳停滞（模拟崩溃）：锁变 stale → 新 conductor 接管 epoch+1
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as ConductorLockFile;
    writeFileSync(lockPath, JSON.stringify({ ...raw, heartbeatAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }));
    const takeover = acquireConductorLock(lockPath, "t1", 2222);
    assert.deepEqual(takeover, { ok: true, epoch: 1, tookOver: true }, "stale 接管必须 epoch+1（fencing）");

    // fencing 生效：旧持有者的 refresh/release 全部失效（epoch 不匹配）
    assert.equal(refreshConductorLock(lockPath, "t1", 1111, 0), false, "旧 conductor 续心跳必须失败");
    assert.equal(releaseConductorLock(lockPath, "t1", 1111, 0), false, "旧 conductor 释放必须失败（防误删新持有者锁）");
    assert.equal(releaseConductorLock(lockPath, "t1", 2222, 1), true, "新持有者正常释放");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 故障 4：核心重生（currentCoreId ≠ originCoreId → RECOVERY_ABORT，spec §2）
// ---------------------------------------------------------------------------

test("故障4：核心重生 —— 计划 originCoreId=uuid-A，观测 uuid-B → RECOVERY_ABORT（禁止旧代际续迁）", () => {
  const sim = new EngineSim(
    makePlan(1_000, {
      state: "LEG_MOVE",
      path: { cells: [[0, 0], [1, 0], [2, 0]], corridorWidth: 8, lookahead: 30 },
      legs: [{ index: 0, from: { x: 0, y: 0 }, to: { x: 2, y: 0 }, audit: { ok: true, freshResources: 9, activeEnemyCores: 0 } }],
      legProgress: { legIndex: 0, cellsThisLeg: 1 },
    }),
    { coreIdAt: () => "uuid-B" }, // 核心被毁重生，全新 UUID
    1_000,
  );

  const result = sim.step(null);
  assert.equal(result.plan?.state, "RECOVERY_ABORT", "代际变化 → RECOVERY_ABORT");
  assert.equal(result.plan?.core.currentCoreId, "uuid-B");
  assert.equal(result.plan?.core.generation, 2, "代际 +1");
  assert.ok(result.transitions.some((t) => t.event === "CORE_GENERATION_CHANGED"));
  assert.ok(result.reasons.some((reason) => reason.includes("RECOVERY_ABORT")));

  // 计划保留（供审计），后续 step 不再推进
  const next = sim.step(null);
  assert.equal(next.plan?.state, "RECOVERY_ABORT");
  assert.equal(next.transitions.length, 0);
});
