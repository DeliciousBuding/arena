/**
 * 迁移 conductor 进程核心（migration-system-v1 §1/§2/§3.2/§4/§6，M5）。
 *
 * 纯函数、无副作用：所有 IO（计划文件、租约锁、calibration 读取）由调用方
 * 注入（见 scripts/run-conductor.mts 壳）。状态转移唯一权威 =
 * state-machine.ts 的 `transition()`——本模块只做"检测条件 → 计算事件 →
 * transition"，任何直接改态都被禁止。
 *
 * 架构契约（§1）：conductor 唯一输出 migration-plan.json（调用方原子写），
 * 永不写 human-commands；runtime 只读计划，凭 lease + epoch + coreId 生效
 * （fail-closed）。中断分级（§2）：CORE_DAMAGED = 暂停（可恢复）；
 * CORE_DESTROYED / 代际变化 = RECOVERY_ABORT（禁止旧 legProgress 续迁）。
 *
 * M5 裁决（规格未定处，逐条注释）：
 * - **leg 与 burst 解耦**：leg 是 ≤legMaxCells(150) 格的审计粒度（§7），
 *   burst 是 8 格的状态机节奏。LEG_SETTLE_DONE 每个 burst 休整结束都发出；
 *   legIndex 仅在整腿完成（核心到达 legs[i].to）时 +1，lastLeg=true 仅当
 *   最后一腿完成——否则同腿继续推进。状态机只表达 LEG_MOVE⇄LEG_SETTLE
 *   交替，无法在 150 格腿内表达多次 burst，故以位置为真值解耦。
 * - **推进以核心位置为真值**：cellsThisLeg = 当前腿已完成格数（位置推导，
 *   `max(旧值, 路径下标-腿起点)`），起点首次 NORMAL 不计数、崩溃重启/写入
 *   丢失后自动前后校准，不会 off-by-one 或卡死；burst 边界 =
 *   `cellsThisLeg % burstCells == 0` 且本 tick 有新增推进。
 * - **lease 过期 = 本实例已失活/被接管**：除恢复检测外拒绝写盘（fail-closed，
 *   计划原样保留，reasons 注明"等待接管"）。
 * - **ABORT 两段式清理**：转入 ABORT 的 step 返回 state=ABORT 计划（磁盘留
 *   终态记录）；下一次 step（state==ABORT）返回 plan=null，请调用方
 *   clearMigrationPlan。
 * - **RECOVERY_ABORT 保留计划**（state=RECOVERY_ABORT）供指挥面审计，不续
 *   lease（无续迁意图；§2"恢复后重新 PLAN 新 operation"）。
 * - **stragglersReady 代理**：M5 输入无 worker 坐标，以"核心 harvestRadius
 *   内无新鲜近矿"为代理（§3.2 harvest-driven：荒漠段 minSettle 即走、
 *   富集段自动多停）；8 tick 新鲜窗口（§3.2"超过 4-8 tick 不作为'现在还有
 *   矿'的强证据"，取 8）。
 * - **"hp 满"阈值 = 规则契约 core.maxHp（v0.14 = 5）**：输入无 coreMaxHp；
 *   hp 未知（null）按满血处理（fail-safe 恢复方向）。
 * - **THREAT_ESCALATED 已接线（M8，migration-survival-v1 §3）**：LEG_SETTLE /
 *   DEFENSIVE_HOLD 中活跃敌核（新鲜目击 ≤escalateRadius=12）持续 ≥escalateTicks=10
 *   tick → 升级；窗口（600 tick）内前两次 = REPLAN 换目的地（非放弃长征），
 *   第三次 = THREAT_ESCALATED → ABORT（安全落：目的地周边持续被敌核占领）。
 *   受击（CORE_DAMAGED）优先于升级（被打先防御）。
 * - **战损补员已接线（M8，migration-survival-v1 §4）**：LEG_SETTLE 每 tick 做编成
 *   缺口检测（军事单位 < replenish.minMilitaryCount=6 持续 ≥minGapTicks=5）→
 *   写 plan.replenish（缺口数 + 缺口角色 + sinceTick）；缺口恢复 → 字段清除。
 *   迁移系统不产兵（产兵是 planner/经济层职责）——replenish 是请求不是指令。
 * - **停滞检测已接线（M6，migration-assist-v1 §4-D）**：LEG_MOVE 中核心
 *   NORMAL 未推进 ≥2 tick = 迁移失败签名（引擎拒：占位者不移走/争抢/容量
 *   R3/R4）→ 写 plan.clearRequests（destination + 前瞻）→ runtime 清路订单
 *   执行 → 清空验证（单位坐标观测）→ 复位续走；连续 3 次清路未果 → REPLAN
 *   （换路绕开占用带）；MOVING/推进即复位 stall 计数。
 */

import type { MigrationPhase } from "./state-machine.ts";
import { transition, type MigrationEvent } from "./state-machine.ts";
import type { MigrationLeg, MigrationPlanV1, MigrationPosition } from "./plan.ts";
import type { MigrationRuntimeConfig } from "./config.ts";
import { planRoute } from "./route.ts";
import { auditCorridor, type CorridorAuditOptions } from "./corridor.ts";
import { isMigrationLeaseFresh } from "./lease.ts";
import { degradationTable } from "./squads.ts";
import { CORE_DESTROYED_EVENT } from "./core-generation.ts";
import {
  MIGRATION_MIN_FRESH_RESOURCES,
  MIGRATION_RESOURCE_FRESH_WINDOW,
  MIGRATION_ENEMY_ACTIVE_WINDOW,
} from "../domain/migration-audit.ts";
import { selectTarget, DEFAULT_TARGET_SCORE_CONFIG, type TargetSurveyInput } from "./target.ts";

/** 引擎事件：核心受击（DEFENSIVE_HOLD 进入条件之一）。 */
export const CORE_DAMAGED_EVENT = "CORE_DAMAGED" as const;

/** 引擎事件：采集成功（W40 饿死跟踪重置源）。 */
export const HARVEST_SUCCEEDED_EVENT = "HARVEST_SUCCEEDED" as const;

/**
 * W40 饿死兜底：远离 [0,0] 死亡区的锚点阈值（Chebyshev）。
 * 参考 arena-evolve heuristic.py:1010-1030 "主动远离 [0,0] 死亡区"——
 * 兜底候选/方向锚点必须距原点 > 此值，避免核心被推向出生区枯竭死锁。
 */
export const STARVE_DEATH_ZONE_AVOID_RADIUS = 20;

/**
 * W40 饿死兜底：无已知矿格时的默认迁移步长（远离 [0,0] 方向锚点距核心的距离）。
 * 参考长征单腿 LEG_MAX_CELLS=150，饿死是小步试探 → 取 50 格（≈1/3 腿）。
 */
export const STARVE_FALLBACK_STEP_CELLS = 50;

/**
 * lease 续期窗口（§6.1 计划 lease.untilTick = tick + 本值）。
 * 裁决：规格要求 config 加 leaseHorizonTicks 默认 600，但 config.ts 属 M5
 * 只读边界——在 conductor 侧以常量实现，接线时并入配置节。
 */
export const CONDUCTOR_LEASE_HORIZON_TICKS = 600;

/** 腿段长上限（§7 legMaxCells=150）。 */
export const LEG_MAX_CELLS = 150;

/** HOLD 滞回最小退出 tick（§2"≥8-12 tick"取下限 8）。 */
export const CONDUCTOR_HOLD_MIN_TICKS = 8;

/** 近矿代理的新鲜窗口（§3.2：>4-8 tick 不算"现在还有矿"；取 8）。 */
export const NEAR_MINE_FRESH_WINDOW_TICKS = 8;

/** 核心满血阈值（规则契约 rules.core.maxHp，v0.14 = 5；输入无 coreMaxHp 时的裁决）。 */
export const CONDUCTOR_CORE_HP_FULL = 5;

const ACTIVE_PHASES: readonly MigrationPhase[] = [
  "PLAN",
  "LEG_MOVE",
  "LEG_SETTLE",
  "DEFENSIVE_HOLD",
];

export interface ConductorCoreSnapshot {
  readonly id: string | null;
  readonly position: readonly [number, number] | null;
  readonly state: "NORMAL" | "MOVING" | null;
  readonly hp: number | null;
}

export interface ConductorStepInput {
  /** 当前游戏 tick。 */
  readonly tick: number;
  /** 墙钟（lease 心跳 / 新鲜度判定）。 */
  readonly nowMs: number;
  /** 从 calibration/live 状态提取的核心快照（无核心观测 = null）。 */
  readonly core: ConductorCoreSnapshot | null;
  /** 引擎事件流（CORE_DESTROYED / CORE_DAMAGED 等）。 */
  readonly events: readonly { readonly type?: string }[];
  readonly units: readonly {
    readonly id: string;
    readonly unitType: string;
    readonly cargo: number;
    /** M6（migration-assist-v1 §4-D/§5）：单位坐标（清空验证用）；缺失 = null。 */
    readonly position: readonly [number, number] | null;
  }[];
  /** 走廊审计输入（与 M3 corridor.ts 对齐）。 */
  readonly survey: {
    readonly resources: readonly { readonly x: number; readonly y: number; readonly lastSeenTick: number }[];
    readonly enemyCores: readonly { readonly x: number; readonly y: number; readonly lastSeenTick: number }[];
    /** 静态地形障碍（OBSTACLE 格，引擎不可通行；缺失 = 空数组，兼容旧观测源）。 */
    readonly obstacles?: readonly { readonly x: number; readonly y: number }[];
  };
  readonly config: MigrationRuntimeConfig;
  /** 上一步的持有状态（HOLD 滞回计数等；null = 新进程重启续传）。 */
  readonly held: Readonly<ConductorHeldState> | null;
  /** 上一步写盘的计划（null = 无计划）。 */
  readonly plan: MigrationPlanV1 | null;
  /** human 取消意图（migration_cancel / 手操覆盖，经 command-plane 接线）。 */
  readonly cancelRequested?: boolean;
}

export interface ConductorHeldState {
  /** 窗口内 HOLD 进入次数（≥2 且窗口内 → REPLAN）。 */
  readonly holdEntryCount: number;
  /** 本窗口首次进入 HOLD 的 tick（0 = 无窗口）。 */
  readonly holdFirstTick: number;
  /** 当前 HOLD 持续 tick（滞回退出用）。 */
  readonly holdTicks: number;
  /** 当前 SETTLE 已过 tick（HOLD 中断期间冻结）。 */
  readonly settleElapsed: number;
  /** M6（migration-assist-v1 §4-D）：LEG_MOVE 中 NORMAL 未推进的连续 tick（MOVING/推进即复位）。 */
  readonly stallTicks: number;
  /** M6：清路重试计数（≥3 次仍未清空 → REPLAN）。 */
  readonly clearRetries: number;
  /** M8（migration-survival-v1 §3）：敌核贴脸持续 tick（敌核离开/升级复位）。 */
  readonly threatStallTicks: number;
  /** M8：威胁升级窗口首次贴脸 tick（0 = 无窗口）。 */
  readonly threatFirstTick: number;
  /** M8：窗口内威胁升级次数（≥2 → 第 3 次 THREAT_ESCALATED → ABORT）。 */
  readonly threatReplanCount: number;
  /** M8（migration-survival-v1 §4）：编成缺口持续 tick（缺口恢复/写请求后复位）。 */
  readonly gapTicks: number;
  /** W40：饿死持续 tick（无采集+无新鲜资源目击；HARVEST_SUCCEEDED/新鲜目击重置）。 */
  readonly starveSince: number;
  /** W40：饿死触发冷却截止 tick（触发后设 = tick + cooldown；此前不再触发）。 */
  readonly starveCooldownUntil: number;
}

export interface ConductorTransitionRecord {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly tick: number;
}

export interface ConductorStepResult {
  /** 更新后的计划（null = 应清理文件：无计划 / ABORT 收尾）。 */
  readonly plan: MigrationPlanV1 | null;
  /** 更新后的持有状态（conductor 内存持久，调用方保存）。 */
  readonly held: ConductorHeldState;
  /** 本 tick 生效的状态转移（仅 transition() applied=true 的）。 */
  readonly transitions: readonly ConductorTransitionRecord[];
  /** 中文决策理由（遥测日志用），每 tick 至少一条。 */
  readonly reasons: readonly string[];
  /**
   * W40 饿死触发信号（plan=null 且饿死条件达成）。shell（run-conductor.mts）
   * 据此调用 buildInitialPlan 写 PLAN 计划——**不直接 START_MOVE**，
   * 绕过 overlay 契约/单写者纪律（conductor 只输出信号，不写盘）。
   */
  readonly starveTrigger?: { readonly target: MigrationPosition; readonly reason: string };
}

export const INITIAL_CONDUCTOR_HELD_STATE: ConductorHeldState = {
  holdEntryCount: 0,
  holdFirstTick: 0,
  holdTicks: 0,
  settleElapsed: 0,
  stallTicks: 0,
  clearRetries: 0,
  threatStallTicks: 0,
  threatFirstTick: 0,
  threatReplanCount: 0,
  gapTicks: 0,
  starveSince: 0,
  starveCooldownUntil: 0,
};

const chebyshev = (first: readonly [number, number], second: { readonly x: number; readonly y: number }): number =>
  Math.max(Math.abs(first[0] - second.x), Math.abs(first[1] - second.y));

/** 路径格下标（起点/终点含端点）；不在路径上 = -1。 */
function pathIndexOf(cells: readonly (readonly [number, number])[], x: number, y: number): number {
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index]!;
    if (cell[0] === x && cell[1] === y) return index;
  }
  return -1;
}

/** 每次输出计划时刷新 lease 心跳（§6.1：untilTick = tick + horizon，heartbeatAt = nowMs）。 */
function refreshLease(plan: MigrationPlanV1, input: ConductorStepInput): MigrationPlanV1 {
  return {
    ...plan,
    lease: {
      untilTick: input.tick + CONDUCTOR_LEASE_HORIZON_TICKS,
      heartbeatAt: new Date(input.nowMs).toISOString(),
    },
    updatedAt: new Date(input.nowMs).toISOString(),
  };
}

/** 无转移的等待步：计划原样（仅心跳刷新）。 */
function waitStep(
  input: ConductorStepInput,
  plan: MigrationPlanV1,
  held: ConductorHeldState,
  transitions: readonly ConductorTransitionRecord[],
  reasons: readonly string[],
  reason: string,
): ConductorStepResult {
  return {
    plan: refreshLease(plan, input),
    held,
    transitions,
    reasons: [...reasons, reason],
  };
}

/** 走廊审计参数（§4：宽度走 config，阈值/窗口走领域常量）。 */
function corridorAuditOptions(config: MigrationRuntimeConfig): CorridorAuditOptions {
  return {
    corridorWidth: config.corridor.width,
    minFreshResources: MIGRATION_MIN_FRESH_RESOURCES,
    freshWindowTicks: MIGRATION_RESOURCE_FRESH_WINDOW,
    enemyActiveWindowTicks: MIGRATION_ENEMY_ACTIVE_WINDOW,
  };
}

/**
 * 障碍集 = 静态地形障碍 + 新鲜资源格 + 活跃敌核格（裁决：陈旧目击不设障
 * ——§3.2"超过 4-8 tick 的数据不作为'现在还有矿'的强证据"，资源 4 tick
 * refill；静态障碍永久有效）。
 */
function collectObstacles(
  survey: ConductorStepInput["survey"],
  tick: number,
): readonly (readonly [number, number])[] {
  const obstacles: (readonly [number, number])[] = [];
  for (const obstacle of survey.obstacles ?? []) {
    obstacles.push([obstacle.x, obstacle.y]);
  }
  for (const resource of survey.resources) {
    if (tick - resource.lastSeenTick <= MIGRATION_RESOURCE_FRESH_WINDOW) {
      obstacles.push([resource.x, resource.y]);
    }
  }
  for (const enemy of survey.enemyCores) {
    if (tick - enemy.lastSeenTick <= MIGRATION_ENEMY_ACTIVE_WINDOW) {
      obstacles.push([enemy.x, enemy.y]);
    }
  }
  return obstacles;
}

/** 满载 worker 数（readiness：迁移续走前必须清空，§3.2）。 */
function cargoWorkerCount(input: ConductorStepInput): number {
  return input.units.filter((unit) => unit.unitType === "WORKER" && unit.cargo > 0).length;
}

/**
 * 经济尾巴就绪代理（裁决见文件头）：worker 坐标不可知时以"核心
 * harvestRadius 内无新鲜近矿"为 proxy——荒漠段立即就绪（minSettle 即走），
 * 富集段拖住休整（harvest-driven 多停）。
 */
function stragglersReady(input: ConductorStepInput): boolean {
  const position = input.core?.position ?? null;
  if (position === null) return true; // worker 距核心不可知 → 默认就绪
  const radius = input.config.pace.harvestRadius;
  return !input.survey.resources.some(
    (resource) =>
      input.tick - resource.lastSeenTick <= NEAR_MINE_FRESH_WINDOW_TICKS &&
      chebyshev(position, resource) <= radius,
  );
}

/** 活跃敌核在 HOLD 进入半径内（§2：新鲜目击 ≤ hold.enterRadius）。 */
function activeEnemyNearCore(
  input: ConductorStepInput,
  enterRadius: number,
): boolean {
  const position = input.core?.position ?? null;
  if (position === null) return false; // 无法量距 → 不构成距离威胁（伤害事件另判）
  return input.survey.enemyCores.some(
    (enemy) =>
      input.tick - enemy.lastSeenTick <= MIGRATION_ENEMY_ACTIVE_WINDOW &&
      chebyshev(position, enemy) <= enterRadius,
  );
}

/** 每 ≤legMaxCells 格切一段腿；腿审计结果（informational，审批以整条路径审计为准）。 */
function buildLegs(
  cells: readonly (readonly [number, number])[],
  survey: ConductorStepInput["survey"],
  tick: number,
  options: CorridorAuditOptions,
): readonly MigrationLeg[] {
  const legs: MigrationLeg[] = [];
  for (let start = 0; start < cells.length; start += LEG_MAX_CELLS) {
    const segment = cells.slice(start, Math.min(cells.length, start + LEG_MAX_CELLS));
    const segmentPositions: MigrationPosition[] = segment.map(([x, y]) => ({ x, y }));
    const audit = auditCorridor(segmentPositions, survey, tick, options);
    legs.push({
      index: legs.length,
      from: { x: segment[0]![0], y: segment[0]![1] },
      to: { x: segment[segment.length - 1]![0], y: segment[segment.length - 1]![1] },
      audit: {
        ok: audit.ok,
        freshResources: audit.freshResourceCount,
        activeEnemyCores: audit.activeEnemyCoreCount,
      },
    });
  }
  return legs;
}

/**
 * M8 威胁升级（migration-survival-v1 §3）：LEG_SETTLE / DEFENSIVE_HOLD 共用。
 * 活跃敌核贴脸（≤escalateRadius）持续 ≥escalateTicks tick → 升级：
 * - 窗口（replanWindowTicks）内前两次：REPLAN_REQUESTED → PLAN（revision+1，
 *   换目的地重审，非放弃长征）；
 * - 第三次：THREAT_ESCALATED → ABORT（安全落：目的地周边持续被敌核占领）。
 * 敌核离开 → 计数复位。返回 null = 未触发（或仍在计数中），调用方继续常态逻辑。
 */
function escalateThreat(
  input: ConductorStepInput,
  plan: MigrationPlanV1,
  held: ConductorHeldState,
  transitions: readonly ConductorTransitionRecord[],
  reasons: readonly string[],
  context: string,
): ConductorStepResult | null {
  const threatConfig = input.config.threat ?? { escalateRadius: 12, escalateTicks: 10, replanWindowTicks: 600 };
  const threatNow = activeEnemyNearCore(input, threatConfig.escalateRadius);
  if (!threatNow) {
    // 敌核离开/目击陈旧 → 贴脸计数复位（窗口保留，升级计数仍有效）
    if (held.threatStallTicks === 0) return null;
    return waitStep(
      input,
      plan,
      { ...held, threatStallTicks: 0 },
      transitions,
      reasons,
      `${context}：敌核离开警戒半径 → 贴脸计数复位（升级计数 ${held.threatReplanCount} 保留）`,
    );
  }

  const stallTicks = held.threatStallTicks + 1;
  if (stallTicks < threatConfig.escalateTicks) {
    return waitStep(
      input,
      plan,
      { ...held, threatStallTicks: stallTicks, threatFirstTick: held.threatFirstTick > 0 ? held.threatFirstTick : input.tick },
      transitions,
      reasons,
      `${context}：活跃敌核贴脸持续 ${stallTicks}/${threatConfig.escalateTicks} tick（≤${threatConfig.escalateRadius} 格），计数中——未受击不放弃防御姿态`,
    );
  }

  const windowOpen =
    held.threatFirstTick > 0 &&
    input.tick - held.threatFirstTick <= threatConfig.replanWindowTicks;
  const replanCount = windowOpen ? held.threatReplanCount + 1 : 1;
  if (replanCount >= 3) {
    transition(plan.state, { type: "THREAT_ESCALATED" }); // 状态机校验：LEG_SETTLE/DEFENSIVE_HOLD → ABORT
    return {
      plan: refreshLease({ ...plan, state: "ABORT" }, input),
      held: { ...held, threatStallTicks: 0, threatFirstTick: 0, threatReplanCount: 0 },
      transitions: [...transitions, {
        from: plan.state,
        to: "ABORT",
        event: "THREAT_ESCALATED",
        tick: input.tick,
      }],
      reasons: [
        ...reasons,
        `${context}：敌核贴脸第 ${replanCount} 次升级（窗口自 tick ${held.threatFirstTick}）→ THREAT_ESCALATED → ABORT（目的地周边持续被敌核占领，安全落）`,
      ],
    };
  }
  transition(plan.state, { type: "REPLAN_REQUESTED" }); // 状态机校验：LEG_SETTLE/DEFENSIVE_HOLD → PLAN
  return {
    plan: refreshLease({ ...plan, state: "PLAN", revision: plan.revision + 1 }, input),
    held: { ...held, threatStallTicks: 0, threatFirstTick: input.tick, threatReplanCount: replanCount },
    transitions: [...transitions, {
      from: plan.state,
      to: "PLAN",
      event: "REPLAN_REQUESTED",
      tick: input.tick,
    }],
    reasons: [
      ...reasons,
      `${context}：敌核贴脸持续 ${threatConfig.escalateTicks} tick → REPLAN_REQUESTED → PLAN（revision ${plan.revision + 1}，换目的地绕开敌核带；窗口内第 ${replanCount} 次）`,
    ],
  };
}

/** 军事单位判定：非 WORKER 即为军事（Vanguard/Ranger 等；WORKER 只采矿）。 */
function militaryUnitCount(input: ConductorStepInput): number {
  return input.units.filter((unit) => unit.unitType !== "WORKER").length;
}

/**
 * M8 编成缺口检测（migration-survival-v1 §4）：LEG_SETTLE 每 tick 调用。
 * 军事单位 < minMilitaryCount 持续 ≥ minGapTicks → 写 plan.replenish
 * （缺口数 + 缺口角色 + sinceTick）；缺口恢复 → 字段清除。返回更新后的计划
 * （reasons 含缺口信息；无缺口变化返回原计划）。
 */
function applyReplenishDetection(
  input: ConductorStepInput,
  plan: MigrationPlanV1,
  held: ConductorHeldState,
  reasons: readonly string[],
): { readonly plan: MigrationPlanV1; readonly held: ConductorHeldState; readonly reasons: readonly string[] } {
  const replenishConfig = input.config.replenish ?? { minMilitaryCount: 6, minGapTicks: 5 };
  const militaryCount = militaryUnitCount(input);
  const gap = replenishConfig.minMilitaryCount - militaryCount;

  if (gap <= 0) {
    if (plan.replenish === undefined && held.gapTicks === 0) return { plan, held, reasons };
    return {
      plan: refreshLease({ ...plan, replenish: undefined }, input),
      held: { ...held, gapTicks: 0 },
      reasons: [...reasons, `编成缺口恢复（军事单位 ${militaryCount} ≥ ${replenishConfig.minMilitaryCount}）→ replenish 请求清除`],
    };
  }

  if (plan.replenish !== undefined) {
    return { plan, held, reasons }; // 已请求，缺口未恢复 → 保持
  }
  const gapTicks = held.gapTicks + 1;
  if (gapTicks < replenishConfig.minGapTicks) {
    return {
      plan,
      held: { ...held, gapTicks },
      reasons: [...reasons, `编成缺口持续 ${gapTicks}/${replenishConfig.minGapTicks}（军事 ${militaryCount} < ${replenishConfig.minMilitaryCount}），防阵亡瞬间误报`],
    };
  }
  const sinceTick = input.tick - (gapTicks - 1); // 缺口首现 tick
  return {
    plan: refreshLease({ ...plan, replenish: { gap, missingRole: missingSquadRole(militaryCount), sinceTick } }, input),
    held: { ...held, gapTicks: 0 },
    reasons: [...reasons, `编成缺口确认（军事 ${militaryCount} < ${replenishConfig.minMilitaryCount}，缺口 ${gap}，自 tick ${sinceTick}）→ 写 plan.replenish（产兵交 planner/经济层）`],
  };
}

/**
 * 缺口角色推导（migration-survival-v1 §4.3）：退化表在 militaryCount+1 与
 * militaryCount 之间新增的槽位角色（如 5→6 新增 RG；缺员恢复满编时优先补它）。
 */
function missingSquadRole(militaryCount: number): "SC" | "SW" | "ES" | "RG" {
  const current = degradationTable(Math.max(0, militaryCount)).roles;
  const next = degradationTable(militaryCount + 1).roles;
  const remaining = new Set(next);
  for (const role of current) remaining.delete(role);
  const added = [...remaining][0];
  return added ?? "ES"; // 理论不可达（next 恒多 1 槽）；ES 为最安全兜底
}

/**
 * DEFENSIVE_HOLD 进入（CORE_DAMAGED，LEG_MOVE/LEG_SETTLE 共用）：
 * 窗口内第 2 次进入 → REPLAN（revision+1）；否则记入窗口并转入 HOLD。
 * 受击 tick 不推进计数（裁决：物理当前格由引擎自然完成，计数滞后于位置，
 * 恢复后位置闸门自动校准）。
 */
function enterDefensiveHold(
  input: ConductorStepInput,
  plan: MigrationPlanV1,
  held: ConductorHeldState,
  transitions: readonly ConductorTransitionRecord[],
  reasons: readonly string[],
  context: string,
): ConductorStepResult {
  const windowOpen =
    held.holdFirstTick > 0 &&
    input.tick - held.holdFirstTick <= input.config.hold.repeatWindowTicks;
  if (!windowOpen) {
    // 新窗口（或首次进入）：记首次 tick 并计数 1
    transition(plan.state, { type: "CORE_DAMAGED" }); // 状态机校验：LEG_MOVE/LEG_SETTLE → DEFENSIVE_HOLD 必生效
    return {
      plan: refreshLease({ ...plan, state: "DEFENSIVE_HOLD" }, input),
      held: { ...held, holdEntryCount: 1, holdFirstTick: input.tick, holdTicks: 0 },
      transitions: [...transitions, {
        from: plan.state,
        to: "DEFENSIVE_HOLD",
        event: "CORE_DAMAGED",
        tick: input.tick,
      }],
      reasons: [
        ...reasons,
        `${context}：CORE_DAMAGED → DEFENSIVE_HOLD（守军回防+治疗，不迁移；第 1 次进入，窗口自 tick ${input.tick} 起）`,
      ],
    };
  }
  const entryCount = held.holdEntryCount + 1;
  if (entryCount >= 2) {
    // 重复进入：600 tick 内 ≥2 次 → REPLAN/ABORT（裁决：取 REPLAN，revision+1）
    transition(plan.state, { type: "REPLAN_REQUESTED" }); // 状态机校验：DEFENSIVE_HOLD → PLAN 必生效
    return {
      plan: refreshLease({ ...plan, state: "PLAN", revision: plan.revision + 1 }, input),
      held,
      transitions: [...transitions, {
        from: plan.state,
        to: "PLAN",
        event: "REPLAN_REQUESTED",
        tick: input.tick,
      }],
      reasons: [
        ...reasons,
        `${context}：${input.config.hold.repeatWindowTicks} tick 内第 ${entryCount} 次受击（窗口自 tick ${held.holdFirstTick}）——REPLAN_REQUESTED → PLAN（revision ${plan.revision + 1}，重生成路线+重审走廊）`,
      ],
    };
  }
  const result = transition(plan.state, { type: "CORE_DAMAGED" });
  if (!result.applied) {
    // 防御性：事件在状态机中非法（如已处于 HOLD）→ no-op 保持原状态
    return waitStep(input, plan, held, transitions, reasons, `CORE_DAMAGED 未生效（fail-closed no-op）`);
  }
  return {
    plan: refreshLease({ ...plan, state: "DEFENSIVE_HOLD" }, input),
    held: { ...held, holdEntryCount: entryCount, holdTicks: 0 },
    transitions: [...transitions, {
      from: plan.state,
      to: "DEFENSIVE_HOLD",
      event: "CORE_DAMAGED",
      tick: input.tick,
    }],
    reasons: [...reasons, `${context}：CORE_DAMAGED → DEFENSIVE_HOLD（窗口内第 ${entryCount} 次）`],
  };
}

/** PLAN 态：真实路径生成 + 整条走廊审计（§4，段中活跃敌核即拒）。 */
function planPhaseStep(
  input: ConductorStepInput,
  plan: MigrationPlanV1,
  held: ConductorHeldState,
  transitions: readonly ConductorTransitionRecord[],
  reasons: readonly string[],
): ConductorStepResult {
  const position = input.core?.position ?? null;
  if (position === null) {
    return waitStep(input, plan, held, transitions, reasons, "PLAN：核心位置未知，等待校准（fail-closed）");
  }

  const obstacles = collectObstacles(input.survey, input.tick);
  const route = planRoute({ x: position[0], y: position[1] }, plan.target, obstacles);
  if (!route.ok) {
    const result = transition(plan.state, { type: "PLAN_REJECTED" });
    return {
      plan: refreshLease({ ...plan, state: "ABORT" }, input),
      held,
      transitions: [...transitions, {
        from: plan.state,
        to: "ABORT",
        event: "PLAN_REJECTED",
        tick: input.tick,
      }],
      reasons: [
        ...reasons,
        `PLAN 路线生成失败（${route.reason}）→ PLAN_REJECTED → ABORT（下一次 step 清理计划文件）`,
      ],
    };
  }

  const auditOptions = corridorAuditOptions(input.config);
  const audit = auditCorridor(route.path, input.survey, input.tick, auditOptions);
  if (!audit.ok) {
    const result = transition(plan.state, { type: "PLAN_REJECTED" });
    return {
      plan: refreshLease({ ...plan, state: "ABORT" }, input),
      held,
      transitions: [...transitions, {
        from: plan.state,
        to: "ABORT",
        event: "PLAN_REJECTED",
        tick: input.tick,
      }],
      reasons: [
        ...reasons,
        `PLAN 走廊审计拒绝（${audit.reasons.join("；")}）→ PLAN_REJECTED → ABORT（下一次 step 清理计划文件）`,
      ],
    };
  }

  const cells = route.path.map((cell) => [cell.x, cell.y] as const);
  const legs = buildLegs(cells, input.survey, input.tick, auditOptions);
  const result = transition(plan.state, { type: "PLAN_AUDITED" });
  return {
    plan: refreshLease(
      {
        ...plan,
        state: "LEG_MOVE",
        path: {
          cells,
          corridorWidth: input.config.corridor.width,
          lookahead: input.config.corridor.lookahead,
        },
        legs,
        legProgress: { legIndex: 0, cellsThisLeg: 0 },
      },
      input,
    ),
    // 新腿序列：HOLD 重复窗口清空（防 REPLAN 后立即再触发振荡）
    held: INITIAL_CONDUCTOR_HELD_STATE,
    transitions: [...transitions, {
      from: plan.state,
      to: "LEG_MOVE",
      event: "PLAN_AUDITED",
      tick: input.tick,
    }],
    reasons: [
      ...reasons,
      `PLAN 审计通过（走廊内新鲜资源 ${audit.freshResourceCount}，活跃敌核 ${audit.activeEnemyCoreCount}；路径 ${cells.length} 格 / ${legs.length} 腿）→ LEG_MOVE`,
    ],
  };
}

/** LEG_MOVE：burst 推进（位置为真值），达标/本腿完成 → LEG_SETTLE。 */
function legMoveStep(
  input: ConductorStepInput,
  plan: MigrationPlanV1,
  held: ConductorHeldState,
  transitions: readonly ConductorTransitionRecord[],
  reasons: readonly string[],
): ConductorStepResult {
  if (input.events.some((event) => event.type === CORE_DAMAGED_EVENT)) {
    return enterDefensiveHold(input, plan, held, transitions, reasons, "LEG_MOVE 中受击");
  }

  const core = input.core;
  if (core === null || core.state === null) {
    return waitStep(input, plan, held, transitions, reasons, "LEG_MOVE：核心状态未知，等待（fail-closed）");
  }
  if (core.state === "MOVING") {
    // M6：MOVING = 引擎正在推进，不算停滞（失败签名 = MOVING→NORMAL 位置未变，
    // 由下方 NORMAL 未推进分支从 0 重新计数捕获）。
    return waitStep(input, plan, { ...held, stallTicks: 0 }, transitions, reasons, "LEG_MOVE：核心 MOVING 中（引擎 4 tick/格），等待到达");
  }
  const position = core.position;
  if (position === null) {
    return waitStep(input, plan, held, transitions, reasons, "LEG_MOVE：核心位置未知，无法核对推进（fail-closed）");
  }

  const leg = plan.legs[plan.legProgress.legIndex];
  if (leg === undefined) {
    return waitStep(input, plan, held, transitions, reasons, "LEG_MOVE：legProgress.legIndex 越界（计划损坏，fail-closed）");
  }
  const legStartIndex = pathIndexOf(plan.path.cells, leg.from.x, leg.from.y);
  if (legStartIndex < 0) {
    return waitStep(input, plan, held, transitions, reasons, "LEG_MOVE：legs 与 path 不一致（计划损坏，fail-closed）");
  }

  const pathIndex = pathIndexOf(plan.path.cells, position[0], position[1]);
  if (pathIndex < 0) {
    return waitStep(input, plan, held, transitions, reasons, `LEG_MOVE：核心在 (${position[0]},${position[1]}) 偏离已审走廊（偏离检测/REPLAN 属 M6，fail-closed 等待）`);
  }
  // 腿完成 = 到达腿终点（位置为真值；1 格腿在起点即完成）
  if (position[0] === leg.to.x && position[1] === leg.to.y) {
    const result = transition(plan.state, { type: "LEG_BURST_DONE" });
    return {
      plan: refreshLease(
        { ...plan, state: "LEG_SETTLE", legProgress: { ...plan.legProgress, cellsThisLeg: Math.max(plan.legProgress.cellsThisLeg, pathIndex - legStartIndex) } },
        input,
      ),
      held: { ...held, settleElapsed: 0 },
      transitions: [...transitions, {
        from: plan.state,
        to: "LEG_SETTLE",
        event: "LEG_BURST_DONE",
        tick: input.tick,
      }],
      reasons: [...reasons, `LEG_MOVE：本腿完成（核心已到腿终点 (${leg.to.x},${leg.to.y})）→ LEG_SETTLE`],
    };
  }
  const nextCellsThisLeg = Math.max(plan.legProgress.cellsThisLeg, pathIndex - legStartIndex);
  const progressed = nextCellsThisLeg > plan.legProgress.cellsThisLeg;
  if (progressed && nextCellsThisLeg % input.config.pace.burstCells === 0) {
    const result = transition(plan.state, { type: "LEG_BURST_DONE" });
    return {
      plan: refreshLease(
        { ...plan, state: "LEG_SETTLE", legProgress: { ...plan.legProgress, cellsThisLeg: nextCellsThisLeg } },
        input,
      ),
      held: { ...held, settleElapsed: 0, stallTicks: 0 },
      transitions: [...transitions, {
        from: plan.state,
        to: "LEG_SETTLE",
        event: "LEG_BURST_DONE",
        tick: input.tick,
      }],
      reasons: [...reasons, `LEG_MOVE：burst ${nextCellsThisLeg}/${input.config.pace.burstCells} 达标 → LEG_SETTLE`],
    };
  }
  if (progressed) {
    return waitStep(
      input,
      { ...plan, legProgress: { ...plan.legProgress, cellsThisLeg: nextCellsThisLeg } },
      { ...held, stallTicks: 0 },
      transitions,
      reasons,
      `LEG_MOVE：burst 推进 ${nextCellsThisLeg}/${input.config.pace.burstCells}（已到 (${position[0]},${position[1]})）`,
    );
  }
  // 未推进（progressed=false）→ M6 停滞检测（migration-assist-v1 §4-D）：
  // NORMAL 且位置未变持续 ≥2 tick = 迁移失败签名（引擎拒：占位者不移走/
  // 争抢/容量，R3/R4）→ 生成清路请求。覆盖路径任意点（腿起点与 burst 中途
  // 同样适用——2026-08-09 生产实证：守卫单位站在核心行进方向的前方格，
  // 核心在 burst 中途 NORMAL 卡死，原实现只检测腿起点导致清路永不触发）。
  {
    const stallTicks = held.stallTicks + 1;
    if (stallTicks < 2) {
      return waitStep(
        input,
        plan,
        { ...held, stallTicks },
        transitions,
        reasons,
        `LEG_MOVE：核心 NORMAL 未推进（stall ${stallTicks}/2，等待引擎/清路）`,
      );
    }
    // 已有清路请求：验证目标格是否已清空（单位坐标观测，M6 §5）。
    if (plan.clearRequests !== undefined && plan.clearRequests.length > 0) {
      const cleared = plan.clearRequests.every((request) =>
        !input.units.some(
          (unit) =>
            unit.position !== null &&
            unit.position[0] === request.x &&
            unit.position[1] === request.y,
        ),
      );
      if (cleared) {
        return waitStep(
          input,
          { ...plan, clearRequests: undefined },
          { ...held, stallTicks: 0, clearRetries: 0 },
          transitions,
          reasons,
          `LEG_MOVE：清路完成（clearRequests 已清空）→ 复位 stall，等待 overlay 重发 START_MOVE`,
        );
      }
      if (held.clearRetries >= 2) {
        // 连续 3 次清路未果 → REPLAN（换路绕开占用带，migration-assist-v1 §4-D）
        const replan = transition(plan.state, { type: "REPLAN_REQUESTED" });
        void replan;
        return {
          plan: refreshLease(
            { ...plan, state: "PLAN", revision: plan.revision + 1, clearRequests: undefined },
            input,
          ),
          held: { ...held, stallTicks: 0, clearRetries: 0 },
          transitions: [...transitions, {
            from: plan.state,
            to: "PLAN",
            event: "REPLAN_REQUESTED",
            tick: input.tick,
          }],
          reasons: [
            ...reasons,
            `LEG_MOVE：清路 ${held.clearRetries + 1} 次未清空（单位占 destination）→ REPLAN（换路绕开占用带）`,
          ],
        };
      }
      return waitStep(
        input,
        plan,
        { ...held, stallTicks, clearRetries: held.clearRetries + 1 },
        transitions,
        reasons,
        `LEG_MOVE：清路重试 ${held.clearRetries + 1}/3（destination 仍有我方单位，runtime 清路订单执行中）`,
      );
    }
    // 首次失败：写 clearRequests（当前格下一格 + 前瞻 1 格），runtime 执行让路。
    const destinationIndex = pathIndex + 1;
    const destination = plan.path.cells[destinationIndex];
    if (destination === undefined) {
      return waitStep(input, plan, held, transitions, reasons, "LEG_MOVE：路径无下一格（计划损坏，fail-closed 等待）");
    }
    const clearRequests: { x: number; y: number; reason?: string }[] = [
      { x: destination[0], y: destination[1], reason: "destination" },
    ];
    const ahead = plan.path.cells[destinationIndex + 1];
    if (ahead !== undefined) {
      clearRequests.push({ x: ahead[0], y: ahead[1], reason: "ahead" });
    }
    return {
      plan: refreshLease(
        {
          ...plan,
          clearRequests,
          assist: { clearAheadCells: clearRequests.length, clearAheadReason: "blocked-retry" },
        },
        input,
      ),
      held: { ...held, stallTicks, clearRetries: 1 },
      transitions,
      reasons: [
        ...reasons,
        `LEG_MOVE：核心 NORMAL 未推进 ≥2 tick（迁移失败签名）→ 写 clearRequests（${clearRequests.length} 格：destination + 前瞻），runtime 清路订单执行中`,
      ],
    };
  }

  return waitStep(input, plan, held, transitions, reasons, `LEG_MOVE：burst ${nextCellsThisLeg}/${input.config.pace.burstCells}，等待移动`);
}

/** LEG_SETTLE：readiness 主导退出（§3.2），末腿完成 → ARRIVED。 */
function legSettleStep(
  input: ConductorStepInput,
  plan: MigrationPlanV1,
  held: ConductorHeldState,
  transitions: readonly ConductorTransitionRecord[],
  reasons: readonly string[],
): ConductorStepResult {
  if (input.events.some((event) => event.type === CORE_DAMAGED_EVENT)) {
    return enterDefensiveHold(input, plan, held, transitions, reasons, "LEG_SETTLE 中受击");
  }

  // M8（migration-survival-v1 §3）：敌核贴脸持续 → 升级（REPLAN 换目的地 / ABORT）。
  const escalated = escalateThreat(input, plan, held, transitions, reasons, "LEG_SETTLE");
  if (escalated !== null) return escalated;

  // M8（migration-survival-v1 §4）：战损编成缺口检测（SETTLE 是唯一产兵窗口）。
  const replenish = applyReplenishDetection(input, plan, held, reasons);
  if (replenish.plan !== plan || replenish.reasons.length > reasons.length) {
    held = replenish.held;
    reasons = replenish.reasons;
  }
  plan = replenish.plan;

  const settleElapsed = held.settleElapsed + 1;
  const leg = plan.legs[plan.legProgress.legIndex];
  if (leg === undefined) {
    return waitStep(input, plan, held, transitions, reasons, "LEG_SETTLE：legProgress.legIndex 越界（计划损坏，fail-closed）");
  }

  const position = input.core?.position ?? null;
  const legComplete =
    position !== null && position[0] === leg.to.x && position[1] === leg.to.y;
  const readiness =
    settleElapsed >= input.config.pace.minSettle &&
    cargoWorkerCount(input) === 0 &&
    stragglersReady(input);
  const forced = settleElapsed >= input.config.pace.maxSettle;

  if (!readiness && !forced) {
    return waitStep(
      input,
      plan,
      { ...held, settleElapsed },
      transitions,
      reasons,
      `LEG_SETTLE：休整 ${settleElapsed}/${input.config.pace.settleTarget}（满载 worker ${cargoWorkerCount(input)}、尾巴 ${stragglersReady(input) ? "就绪" : "未就绪"}）——readiness 未达成`,
    );
  }

  // 裁决（文件头）：lastLeg=true 仅当"最后一腿已完成"；未完成 → 同腿继续推进
  const lastLeg = legComplete && plan.legProgress.legIndex === plan.legs.length - 1;
  const nextPhase: MigrationPhase = lastLeg ? "ARRIVED" : "LEG_MOVE";
  const nextLegIndex = !lastLeg && legComplete ? plan.legProgress.legIndex + 1 : plan.legProgress.legIndex;
  const nextCellsThisLeg = !lastLeg && legComplete ? 0 : plan.legProgress.cellsThisLeg;
  const result = transition(plan.state, { type: "LEG_SETTLE_DONE", lastLeg });
  return {
    plan: refreshLease(
      {
        ...plan,
        state: nextPhase,
        legProgress: { legIndex: nextLegIndex, cellsThisLeg: nextCellsThisLeg },
      },
      input,
    ),
    held: { ...held, settleElapsed },
    transitions: [...transitions, {
      from: plan.state,
      to: nextPhase,
      event: "LEG_SETTLE_DONE",
      tick: input.tick,
    }],
    reasons: [
      ...reasons,
      lastLeg
        ? `LEG_SETTLE：${settleElapsed} tick 后 readiness/强制退出，最后一腿完成 → ARRIVED（迁移完成，等待 ARRIVED_SETTLE_DONE 归档）`
        : legComplete
          ? `LEG_SETTLE：${settleElapsed} tick 后退出，本腿完成 → LEG_MOVE（legIndex ${nextLegIndex}）`
          : `LEG_SETTLE：${settleElapsed} tick 后退出，本腿未完成 → LEG_MOVE 继续同腿（burst 计数 ${nextCellsThisLeg}）`,
    ],
  };
}

/** DEFENSIVE_HOLD：滞回退出（≥8 tick 无威胁且 HP 满 → THREAT_CLEARED → LEG_SETTLE）。 */
function defensiveHoldStep(
  input: ConductorStepInput,
  plan: MigrationPlanV1,
  held: ConductorHeldState,
  transitions: readonly ConductorTransitionRecord[],
  reasons: readonly string[],
): ConductorStepResult {
  const holdTicks = held.holdTicks + 1;
  const hp = input.core?.hp ?? null;
  const hpFull = hp === null || hp >= CONDUCTOR_CORE_HP_FULL;
  const hitRecently = input.events.some((event) => event.type === CORE_DAMAGED_EVENT) && hp !== null && hp < CONDUCTOR_CORE_HP_FULL;
  const threat = activeEnemyNearCore(input, input.config.hold.enterRadius) || hitRecently;

  if (threat) {
    // M8（migration-survival-v1 §3）：HOLD 中敌核贴脸持续 → 升级
    // （HOLD 是"被打暂停"，不是"敌占区长期驻留"——贴脸达标即换目的地/安全落）。
    const escalated = escalateThreat(input, plan, held, transitions, reasons, "DEFENSIVE_HOLD");
    if (escalated !== null) return escalated;
    return waitStep(
      input,
      plan,
      { ...held, holdTicks },
      transitions,
      reasons,
      `DEFENSIVE_HOLD：活跃敌核/受击威胁仍在，继续防御（holdTicks ${holdTicks}，hp ${hp ?? "未知"}）`,
    );
  }
  if (holdTicks >= CONDUCTOR_HOLD_MIN_TICKS && hpFull) {
    const result = transition(plan.state, { type: "THREAT_CLEARED" });
    return {
      plan: refreshLease({ ...plan, state: "LEG_SETTLE" }, input),
      held: { ...held, holdTicks },
      transitions: [...transitions, {
        from: plan.state,
        to: "LEG_SETTLE",
        event: "THREAT_CLEARED",
        tick: input.tick,
      }],
      reasons: [
        ...reasons,
        `DEFENSIVE_HOLD：无威胁持续 ${holdTicks} ≥ ${CONDUCTOR_HOLD_MIN_TICKS} tick 且 HP ${hp ?? "未知"} 满 → THREAT_CLEARED → LEG_SETTLE（恢复休整，中断的 settleElapsed ${held.settleElapsed} 继续）`,
      ],
    };
  }
  return waitStep(
    input,
    plan,
    { ...held, holdTicks },
    transitions,
    reasons,
    `DEFENSIVE_HOLD：无威胁，等待滞回（holdTicks ${holdTicks} < ${CONDUCTOR_HOLD_MIN_TICKS} 或 HP ${hp ?? "未知"} 未满）`,
  );
}

/**
 * conductor 单步决策（纯函数）。调用方负责：
 * - held 在本进程内存持久、跨进程丢弃（重启 = null）；
 * - plan 从磁盘读回（断点续传，仅同一 operation 合法——lease 过期即拒绝）；
 * - plan=null 返回时 clearMigrationPlan。
 */

// ---------------------------------------------------------------------------
// W40 饿死迁移兜底（M7 补位；plan=null 时跟踪，触发 → starveTrigger 信号）
// ---------------------------------------------------------------------------

/** 两个 MigrationPosition 的 Chebyshev 距离（target.ts 同名私有副本，此处独立以复用）。 */
function positionChebyshev(first: MigrationPosition, second: MigrationPosition): number {
  return Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y));
}

/**
 * W40 饿死兜底目的地选择（plan=null 且饿死条件达成时调用）。
 *
 * 策略（规格 §4）：
 * 1. **评分优先**：候选 = 已知矿格（survey.resources 位置）远离 [0,0] 死亡区者，
 *    交 selectTarget 评分（资源富集/安全/测绘覆盖）；
 * 2. **兜底候选注入**：selectTarget 无候选通过（硬门槛：活跃敌核/富集下限）→
 *    取距 [0,0] 最远的已知矿格（远离死亡区）；
 * 3. **无已知矿格**：沿核心当前方位远离 [0,0] 生成方向锚点（STARVE_FALLBACK_STEP_CELLS 格外）。
 *
 * 返回 null 仅当核心位置未知（无法生成方向）——对应"全方向 blocked → 放弃等冷却"。
 */
function pickStarveTarget(
  input: ConductorStepInput,
  minAreaSeen: number,
): MigrationPosition | null {
  void minAreaSeen; // minAreaSeen 仅作触发前置（区域已勘探），选目标时不直接用
  const core = input.core;
  if (core?.position === null || core === null) return null;
  const origin: MigrationPosition = { x: core.position[0], y: core.position[1] };
  const deathZone: MigrationPosition = { x: 0, y: 0 };

  // 1. 候选 = 已知矿格远离 [0,0] 死亡区者（去重）
  const seen = new Set<string>();
  const candidates: MigrationPosition[] = [];
  for (const resource of input.survey.resources) {
    const position: MigrationPosition = { x: resource.x, y: resource.y };
    if (positionChebyshev(position, deathZone) <= STARVE_DEATH_ZONE_AVOID_RADIUS) continue;
    const key = `${position.x},${position.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(position);
  }

  // 评分优先：selectTarget（资源富集/安全/测绘覆盖硬门槛）
  const targetConfig = input.config.targetScore ?? DEFAULT_TARGET_SCORE_CONFIG;
  // W60 方向承诺（direction-commitment-v1）：把 config.directionCommitment
  // 的 band/bonus 并入评分配置，并把上一轮 plan.target 作为 lastTarget（方向
  // 承诺锚点）注入 survey——selectTarget 内对落在 band 内的候选加 bonus，
  // 防饿死兜底重触发时换方向（plan=null 时无 lastTarget = 零回归）。
  const commitment = input.config.directionCommitment;
  const targetConfigWithCommitment = commitment === undefined
    ? targetConfig
    : {
        ...targetConfig,
        commitmentBand: commitment.commitmentBand,
        commitmentBonus: commitment.commitmentBonus,
      };
  const lastTarget = input.plan?.target;
  const surveyInput: TargetSurveyInput = {
    resources: input.survey.resources,
    enemyCores: input.survey.enemyCores,
    lastTarget: lastTarget === undefined ? null : { x: lastTarget.x, y: lastTarget.y },
  };
  const selected = selectTarget(candidates, surveyInput, targetConfigWithCommitment, input.tick);
  if (selected !== null) return selected.target;

  // 2. 兜底候选注入：距 [0,0] 最远的已知矿格（远离死亡区）
  if (candidates.length > 0) {
    let farthest = candidates[0]!;
    for (const candidate of candidates) {
      if (positionChebyshev(candidate, deathZone) > positionChebyshev(farthest, deathZone)) {
        farthest = candidate;
      }
    }
    return farthest;
  }

  // 3. 无已知矿格：沿核心当前方位远离 [0,0] 生成方向锚点
  //    核心已在死亡区内 → 默认正方位（+x/+y）外出；否则沿核心所在象限外推。
  const stepX = origin.x === 0 ? STARVE_FALLBACK_STEP_CELLS : Math.sign(origin.x) * STARVE_FALLBACK_STEP_CELLS;
  const stepY = origin.y === 0 ? STARVE_FALLBACK_STEP_CELLS : Math.sign(origin.y) * STARVE_FALLBACK_STEP_CELLS;
  return { x: origin.x + stepX, y: origin.y + stepY };
}

/**
 * W40 饿死检测（纯函数；plan=null 时由 conductorStep 调用）。
 *
 * 双判据 AND（规格 §2）：
 * - **事件源**：observation.events 含 HARVEST_SUCCEEDED → 重置 starveSince；
 * - **survey 记忆**：无新鲜资源目击（窗口 > starveTriggerTicks，即任一资源
 *   lastSeenTick 距今 ≤ triggerTicks 即视为有新鲜目击 → 不满足此判据）。
 *
 * 触发前置（规格 §5）：
 * - **Core 非 MOVING**（coreEvade 活跃/正在移动不触发——避免与既有
 *   DEFENSIVE_HOLD/ABORT 仲裁冲突；饿死计划写入后自动继承这些机制）；
 * - **coreEvade 不活跃**：活跃敌核贴脸（≤ hold.enterRadius）时不触发
 *   （防御优先于饿死迁移）。
 *
 * 触发后：starveSince 复位、starveCooldownUntil = tick + cooldownTicks。
 * 变体零回归：config.starveTriggerTicks === undefined → 永不触发（DEFAULT 不设）。
 */
function detectStarvation(
  input: ConductorStepInput,
  held: ConductorHeldState,
): {
  readonly held: ConductorHeldState;
  readonly trigger: { readonly target: MigrationPosition; readonly reason: string } | null;
  readonly reasons: readonly string[];
} {
  const triggerTicks = input.config.starveTriggerTicks;
  if (triggerTicks === undefined) {
    return { held, trigger: null, reasons: [] }; // 变体未启用饿死兜底 → 零影响
  }
  const cooldownTicks = input.config.starveCooldownTicks ?? 400;
  const minAreaSeen = input.config.starveMinAreaSeen ?? 30;
  const reasons: string[] = [];

  // 事件源：HARVEST_SUCCEEDED 即重置 starveSince（采集成功 = 当前区域仍有产出）
  const harvested = input.events.some((event) => event.type === HARVEST_SUCCEEDED_EVENT);
  // survey 记忆：新鲜资源目击（窗口 = minAreaSeen；近期见过矿 = 区域未枯竭）
  const freshSighting = input.survey.resources.some(
    (resource) => input.tick - resource.lastSeenTick <= minAreaSeen,
  );

  let starveSince = held.starveSince;
  if (harvested || freshSighting) {
    starveSince = 0;
  } else {
    starveSince += 1;
  }
  const updatedHeld: ConductorHeldState = { ...held, starveSince };

  // 触发前置：Core 非 MOVING（正在移动不触发；coreEvade/移动让位给既有机制）
  const core = input.core;
  if (core === null || core.state === null || core.state === "MOVING") {
    return {
      held: updatedHeld,
      trigger: null,
      reasons: [...reasons, `饿死跟踪 ${starveSince}/${triggerTicks}（核心缺失/MOVING，暂不触发）`],
    };
  }
  // coreEvade 活跃（敌核贴脸）不触发——防御优先于饿死迁移
  if (activeEnemyNearCore(input, input.config.hold.enterRadius)) {
    return {
      held: updatedHeld,
      trigger: null,
      reasons: [...reasons, `饿死跟踪 ${starveSince}/${triggerTicks}（coreEvade 活跃/敌核贴脸，暂不触发）`],
    };
  }

  // 触发条件 AND：
  // A. starveSince >= triggerTicks（事件源：triggerTicks 内无采集/无新鲜目击）
  // B. survey 无新鲜资源目击窗口 > triggerTicks（survey 记忆枯竭：任一资源
  //    lastSeenTick 距今 ≤ triggerTicks 即视为有目击 → 不满足）
  const noFreshWithinTriggerWindow = !input.survey.resources.some(
    (resource) => input.tick - resource.lastSeenTick <= triggerTicks,
  );
  // C. 区域已勘探：已知矿格 >= minAreaSeen（area_seen > 30 前置；未勘探足够
  //    不触发——可能只是没探到矿，非真枯竭）
  const areaExplored = input.survey.resources.length >= minAreaSeen;
  // D. 冷却：tick >= starveCooldownUntil
  const cooldownElapsed = input.tick >= held.starveCooldownUntil;

  if (
    starveSince >= triggerTicks &&
    noFreshWithinTriggerWindow &&
    areaExplored &&
    cooldownElapsed
  ) {
    const target = pickStarveTarget(input, minAreaSeen);
    if (target === null) {
      return {
        held: updatedHeld,
        trigger: null,
        reasons: [...reasons, `饿死 ${starveSince} >= ${triggerTicks} 但无可用兜底方向（核心位置未知/全 blocked）→ 等冷却`],
      };
    }
    const cooldownUntil = input.tick + cooldownTicks;
    return {
      held: { ...updatedHeld, starveSince: 0, starveCooldownUntil: cooldownUntil },
      trigger: {
        target,
        reason: `饿死兜底迁移（${starveSince} tick 无采集/无新鲜资源目击，远离 [0,0] 死亡区）`,
      },
      reasons: [...reasons, `饿死触发：${starveSince} >= ${triggerTicks} tick 无采集 + survey 无新鲜目击 + 区域已勘探（${input.survey.resources.length} >= ${minAreaSeen}）→ 兜底迁移计划（目标 [${target.x},${target.y}]，冷却 ${cooldownTicks} tick）`],
    };
  }

  return {
    held: updatedHeld,
    trigger: null,
    reasons: [...reasons, `饿死跟踪 ${starveSince}/${triggerTicks}（新鲜目击=${freshSighting}，区域勘探=${input.survey.resources.length}/${minAreaSeen}，冷却未过=${!cooldownElapsed}）`],
  };
}

export function conductorStep(input: ConductorStepInput): ConductorStepResult {
  const held = input.held ?? INITIAL_CONDUCTOR_HELD_STATE;
  if (input.plan === null) {
    // W40：饿死兜底检测（plan=null 且无 --target 时 shell 据信号 buildInitialPlan 写 PLAN 计划）
    const starve = detectStarvation(input, held);
    return {
      plan: null,
      held: starve.held,
      transitions: [],
      reasons: ["无迁移意图，IDLE", ...starve.reasons],
      starveTrigger: starve.trigger ?? undefined,
    };
  }

  const plan = input.plan;
  const transitions: ConductorTransitionRecord[] = [];
  const reasons: string[] = [];

  // receive 模式：接应方不推进核心（§5.4；M5 只执行 migrate 模式）
  if (plan.mode !== "migrate") {
    return { plan, held, transitions, reasons: [`${plan.mode} 模式：接应端不推进核心（M5 未实现 receive 推进）`] };
  }

  // 终态先行（ABORT 两段式清理：本步直接返回 null）
  switch (plan.state) {
    case "ABORT":
      return { plan: null, held, transitions, reasons: ["计划已 ABORT：返回 null，请调用方 clearMigrationPlan 清理计划文件"] };
    case "RECOVERY_ABORT":
      return { plan, held, transitions, reasons: ["RECOVERY_ABORT 终态：计划保留供指挥面审计（等待 RECOVERY_DONE 后以新 operation 重新 PLAN，不续旧 legProgress）"] };
    case "ARRIVED":
      return { plan, held, transitions, reasons: ["ARRIVED 终态：迁移完成，等待 ARRIVED_SETTLE_DONE 归档"] };
    case "IDLE":
      return { plan, held, transitions, reasons: ["IDLE：计划存在但无执行意图（等待 INTENT_ACCEPTED）"] };
    case "PLAN":
    case "LEG_MOVE":
    case "LEG_SETTLE":
    case "DEFENSIVE_HOLD":
      break;
    default:
      return { plan, held, transitions, reasons: [`未知状态 ${plan.state}：fail-closed 不推进`] };
  }

  // 恢复中止最高优先（§2 中止分级：CORE_DESTROYED / currentCoreId ≠ originCoreId，
  // 两者均非 null 才比较 id；核心观测缺失不触发——可能为测绘间隙）
  const destroyed = input.events.some((event) => event.type === CORE_DESTROYED_EVENT);
  const coreIdChanged =
    input.core !== null &&
    input.core.id !== null &&
    plan.core.originCoreId !== null &&
    input.core.id !== plan.core.originCoreId;
  if (destroyed || coreIdChanged) {
    const event: MigrationEvent = destroyed
      ? { type: "CORE_DESTROYED" }
      : { type: "CORE_GENERATION_CHANGED" };
    const result = transition(plan.state, event);
    if (result.applied) {
      return {
        // 裁决（文件头）：RECOVERY_ABORT 保留计划供审计，不续 lease
        plan: {
          ...plan,
          state: "RECOVERY_ABORT",
          core: {
            ...plan.core,
            currentCoreId: input.core?.id ?? null,
            generation: plan.core.generation + 1,
          },
        },
        held,
        transitions: [...transitions, {
          from: plan.state,
          to: "RECOVERY_ABORT",
          event: event.type,
          tick: input.tick,
        }],
        reasons: [
          ...reasons,
          destroyed
            ? "检测到 CORE_DESTROYED：→ RECOVERY_ABORT（核心被毁，禁止从旧 legProgress 续迁；计划保留供审计）"
            : `核心 id 变化（origin ${plan.core.originCoreId} → current ${input.core!.id}）：CORE_GENERATION_CHANGED → RECOVERY_ABORT（禁止旧代际续迁）`,
        ],
      };
    }
  }

  // lease 过期 = 本 conductor 实例已失活/被接管：拒绝续迁（fail-closed）
  if (!isMigrationLeaseFresh(plan.lease, input.tick, input.nowMs)) {
    return {
      plan,
      held,
      transitions,
      reasons: ["lease 过期：等待接管（fail-closed，拒绝续迁；计划原样保留，runtime 侧已停走）"],
    };
  }

  // 用户取消（任何非终态 → ABORT；终态已在上方返回）
  if (input.cancelRequested === true) {
    const result = transition(plan.state, { type: "CANCEL" });
    if (result.applied) {
      return {
        plan: refreshLease({ ...plan, state: "ABORT" }, input),
        held,
        transitions: [...transitions, {
          from: plan.state,
          to: "ABORT",
          event: "CANCEL",
          tick: input.tick,
        }],
        reasons: ["指挥面取消意图（CANCEL）→ ABORT（下一次 step 返回 null 清理计划文件）"],
      };
    }
  }

  switch (plan.state) {
    case "PLAN":
      return planPhaseStep(input, plan, held, transitions, reasons);
    case "LEG_MOVE":
      return legMoveStep(input, plan, held, transitions, reasons);
    case "LEG_SETTLE":
      return legSettleStep(input, plan, held, transitions, reasons);
    case "DEFENSIVE_HOLD":
      return defensiveHoldStep(input, plan, held, transitions, reasons);
    default:
      // 上方已过滤，防御性兜底
      return { plan, held, transitions, reasons: [...reasons, `未知状态 ${plan.state}：fail-closed`] };
  }
}
