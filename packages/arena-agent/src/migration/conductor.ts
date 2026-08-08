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
 * - **THREAT_ESCALATED 未接线**：M5 行为清单不含"敌核贴脸持续→ABORT"；
 *   活跃敌核持续 → 无限期 HOLD 直至目击陈旧（安全侧），后续里程碑接入。
 * - **停滞检测未接线**：核心长时间不推进（引擎异常）→ 挂起等待；§2 列示的
 *   停滞检测属 runtime driver 细节，留 M6。
 */

import type { MigrationPhase } from "./state-machine.ts";
import { transition, type MigrationEvent } from "./state-machine.ts";
import type { MigrationLeg, MigrationPlanV1, MigrationPosition } from "./plan.ts";
import type { MigrationRuntimeConfig } from "./config.ts";
import { planRoute } from "./route.ts";
import { auditCorridor, type CorridorAuditOptions } from "./corridor.ts";
import { isMigrationLeaseFresh } from "./lease.ts";
import { CORE_DESTROYED_EVENT } from "./core-generation.ts";
import {
  MIGRATION_MIN_FRESH_RESOURCES,
  MIGRATION_RESOURCE_FRESH_WINDOW,
  MIGRATION_ENEMY_ACTIVE_WINDOW,
} from "../domain/migration-audit.ts";

/** 引擎事件：核心受击（DEFENSIVE_HOLD 进入条件之一）。 */
export const CORE_DAMAGED_EVENT = "CORE_DAMAGED" as const;

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
  }[];
  /** 走廊审计输入（与 M3 corridor.ts 对齐）。 */
  readonly survey: {
    readonly resources: readonly { readonly x: number; readonly y: number; readonly lastSeenTick: number }[];
    readonly enemyCores: readonly { readonly x: number; readonly y: number; readonly lastSeenTick: number }[];
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
}

export const INITIAL_CONDUCTOR_HELD_STATE: ConductorHeldState = {
  holdEntryCount: 0,
  holdFirstTick: 0,
  holdTicks: 0,
  settleElapsed: 0,
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
 * 障碍集 = 新鲜资源格 + 活跃敌核格（裁决：陈旧目击不设障——§3.2"超过
 * 4-8 tick 的数据不作为'现在还有矿'的强证据"，资源 4 tick refill）。
 */
function collectObstacles(
  survey: ConductorStepInput["survey"],
  tick: number,
): readonly (readonly [number, number])[] {
  const obstacles: (readonly [number, number])[] = [];
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
    return waitStep(input, plan, held, transitions, reasons, "LEG_MOVE：核心 MOVING 中（引擎 4 tick/格），等待到达");
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
  if (pathIndex <= legStartIndex) {
    return waitStep(input, plan, held, transitions, reasons, "LEG_MOVE：核心在腿起点，等待引擎移动（overlay 已发 START_MOVE）");
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
      held: { ...held, settleElapsed: 0 },
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
      held,
      transitions,
      reasons,
      `LEG_MOVE：burst 推进 ${nextCellsThisLeg}/${input.config.pace.burstCells}（已到 (${position[0]},${position[1]})）`,
    );
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
export function conductorStep(input: ConductorStepInput): ConductorStepResult {
  const held = input.held ?? INITIAL_CONDUCTOR_HELD_STATE;
  if (input.plan === null) {
    // 零影响：无迁移意图
    return { plan: null, held, transitions: [], reasons: ["无迁移意图，IDLE"] };
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
