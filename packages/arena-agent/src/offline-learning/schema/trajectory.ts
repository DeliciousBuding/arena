/**
 * 离线学习轨迹 schema（trajectory-v1）：episode 级序列数据，供 BC/DAgger/
 * Decision Transformer/MAPPO/QMIX 等序列模型消费。
 *
 * 与 ml-sample-v1（单 tick 样本）互补：trajectory-v1 保持完整时序结构，
 * 适合需要历史上下文的序列决策模型。每条轨迹 = 一个完整 episode 的全部 tick。
 *
 * 设计原则：
 * - JSONL/Arrow 双友好：所有字段为标量或固定宽度数组，无可变深度嵌套
 * - 确定性：trajectoryId = sha256(内容)，跨重建可复现
 * - 版本化：schema 字段声明版本，消费者按版本分支
 * - 零依赖：类型定义仅依赖 Node.js 内置 + 现有 domain 类型
 */

import { createHash } from "node:crypto";
import type { Plan, Position } from "../../domain/model.ts";
import { canonicalJson } from "../../sim/tools/artifacts.ts";

export const TRAJECTORY_SCHEMA_VERSION = "trajectory-v1" as const;

// ── 轨迹级元数据 ──

export interface TrajectoryMetadata {
  readonly episodeId: string;
  readonly tenantId: string;
  readonly rulesVersion: string;
  readonly rulesManifestHash: string;
  readonly seed: number;
  readonly tickCount: number;
  readonly source: "sim" | "live";
  readonly sourceCommit: string;
  readonly engineVersion: string;
  readonly startedAt: string;
  readonly completedAt?: string;
}

// ── 单步状态（精简投影，适合特征工程） ──

export interface TrajectoryStepState {
  /** 游戏 tick（1-based）。 */
  readonly tick: number;
  /** 核心资源量。 */
  readonly resources: number;
  /** 资源容量（pop × 5）。 */
  readonly resourceCapacity: number;
  /** 总人口（受控单位数）。 */
  readonly population: number;
  /** Worker 数量。 */
  readonly workers: number;
  /** Vanguard 数量。 */
  readonly vanguards: number;
  /** Ranger 数量。 */
  readonly rangers: number;
  /** Core HP。 */
  readonly coreHp: number;
  /** Core Shield。 */
  readonly coreShield: number;
  /** Core 位置 [x, y]。 */
  readonly corePosition: readonly [number, number];
  /** Core 状态（NORMAL/MOVING/RESPAWNING）。 */
  readonly coreState: string;
  /** 可见资源格数量。 */
  readonly visibleResourceCells: number;
  /** worker 携带资源总量。 */
  readonly carriedResources: number;
  /** 可见敌方 UNIT 数量。 */
  readonly visibleEnemyUnits: number;
  /** 可见敌方战斗单位（VANGUARD + RANGER）数量。 */
  readonly visibleEnemyCombat: number;
  /** 可见敌方 Core 数量。 */
  readonly visibleEnemyCores: number;
  /** 最近可见敌 Core 距离（Chebyshev，无可视为 null）。 */
  readonly nearestEnemyCoreDist: number | null;
  /** 最近可见敌战斗单位距离（Chebyshev，无可视为 null）。 */
  readonly nearestEnemyCombatDist: number | null;
  /** 威胁等级（NORMAL/ALERT/ENGAGED/BREAKOUT）。 */
  readonly threatLevel: string;
}

// ── 单步动作（精简投影） ──

export interface TrajectoryStepAction {
  /** 动作类型计数：move/harvest/deposit/wait/shoot/sweep/heal/spawn/self_destruct */
  readonly actionCounts: Readonly<Record<string, number>>;
  /** Core 动作类型（WAIT/SPAWN/HEAL/START_MOVE/CANCEL_MOVE 等，null=无）。 */
  readonly coreAction: string | null;
  /** 新 spawn 单位类型（WORKER/VANGUARD/RANGER，非 spawn 时为 null）。 */
  readonly spawnUnitType: string | null;
  /** intent 标签集合。 */
  readonly intents: readonly string[];
  /** 计划哈希（稳定 FNV-1a），用于审计/漂移检测。 */
  readonly planHash: string;
}

// ── 单步奖励/标签 ──

export interface TrajectoryStepLabel {
  /** 即时资源变化（after.resources - before.resources）。 */
  readonly immediateResourceDelta: number;
  /** 即时人口变化。 */
  readonly immediatePopulationDelta: number;
  /** 单位死亡数（本 tick 损失）。 */
  readonly deaths: number;
  /** 滚动 20-tick 净资源变化（前瞻窗口）。 */
  readonly netResourceDelta20: number;
  /** 滚动 20-tick 死亡概率。 */
  readonly deathProb20: number;
  /** 滚动 50-tick Core 风险（0/1）。 */
  readonly coreRisk50: 0 | 1;
  /** 标签窗口是否完整（前瞻数据充足）。 */
  readonly windowComplete: boolean;
}

// ── 完整轨迹步 ──

export interface TrajectoryStep {
  readonly state: TrajectoryStepState;
  readonly action: TrajectoryStepAction;
  readonly label: TrajectoryStepLabel;
}

// ── 完整轨迹 ──

export interface TrajectoryV1 {
  readonly schema: typeof TRAJECTORY_SCHEMA_VERSION;
  readonly trajectoryId: string;
  readonly metadata: TrajectoryMetadata;
  readonly steps: readonly TrajectoryStep[];
}

// ── 工厂函数 ──

/** 从 EpisodeResult + EpisodeRecord 提取单步状态投影。 */
export function projectStepState(
  world: { readonly tick: number; readonly players: ReadonlyMap<string, {
    readonly id: string; readonly resources: number; readonly units: readonly {
      readonly id: string; readonly kind: string; readonly unitType?: string;
      readonly cargo: number; readonly hp: number; readonly position: Position;
      readonly controlled?: boolean;
    }[]; readonly core: { readonly id: string; readonly hp: number;
      readonly shield: number; readonly position: Position;
      readonly state: string; } | null;
  }> },
  tenantId: string,
  visibleEnemies: readonly { readonly kind: string; readonly unitType?: string;
    readonly position: Position }[],
  threatLevel: string,
): TrajectoryStepState {
  const player = world.players.get(tenantId);
  if (!player) throw new Error(`player ${tenantId} not found`);
  const workers = player.units.filter((u) => u.unitType === "WORKER");
  const vanguards = player.units.filter((u) => u.unitType === "VANGUARD");
  const rangers = player.units.filter((u) => u.unitType === "RANGER");
  const combatEnemies = visibleEnemies.filter(
    (e) => e.kind === "UNIT" && (e.unitType === "VANGUARD" || e.unitType === "RANGER"),
  );
  const enemyCores = visibleEnemies.filter((e) => e.kind === "CORE");

  const corePos = player.core?.position ?? [0, 0] as const;

  function chebyshev(a: readonly [number, number], b: readonly [number, number]): number {
    return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  }

  const nearestEnemyCoreDist = enemyCores.length > 0
    ? Math.min(...enemyCores.map((e) => chebyshev(corePos, e.position)))
    : null;
  const nearestEnemyCombatDist = combatEnemies.length > 0
    ? Math.min(...combatEnemies.map((e) => chebyshev(corePos, e.position)))
    : null;

  return {
    tick: world.tick,
    resources: player.resources,
    resourceCapacity: player.units.length * 5,
    population: player.units.length,
    workers: workers.length,
    vanguards: vanguards.length,
    rangers: rangers.length,
    coreHp: player.core?.hp ?? 0,
    coreShield: player.core?.shield ?? 0,
    corePosition: corePos,
    coreState: player.core?.state ?? "RESPAWNING",
    visibleResourceCells: 0, // caller fills
    carriedResources: workers.reduce((sum, w) => sum + w.cargo, 0),
    visibleEnemyUnits: visibleEnemies.filter((e) => e.kind === "UNIT").length,
    visibleEnemyCombat: combatEnemies.length,
    visibleEnemyCores: enemyCores.length,
    nearestEnemyCoreDist,
    nearestEnemyCombatDist,
    threatLevel,
  };
}

/** 从 Plan + DecisionTrace 提取单步动作投影。 */
export function projectStepAction(
  plan: Plan,
  planHash: string,
): TrajectoryStepAction {
  const actionCounts: Record<string, number> = {};
  for (const action of Object.values(plan.unitActions)) {
    const type = (action as { type: string }).type;
    actionCounts[type] = (actionCounts[type] ?? 0) + 1;
  }
  const coreActionRecord = plan.coreAction as { type: string } | null;
  let coreAction: string | null = null;
  let spawnUnitType: string | null = null;
  if (coreActionRecord !== null) {
    coreAction = coreActionRecord.type;
    if (coreAction === "SPAWN") {
      spawnUnitType = (coreActionRecord as { unitType?: string }).unitType ?? null;
    }
  }
  return {
    actionCounts,
    coreAction,
    spawnUnitType,
    intents: Object.keys(plan.intents ?? {}),
    planHash,
  };
}

/** 从 EpisodeTickMeasurement + label 提取单步标签投影。 */
export function projectStepLabel(
  beforeResources: number,
  afterResources: number,
  beforeUnits: number,
  afterUnits: number,
  deaths: number,
  netResourceDelta20: number,
  deathProb20: number,
  coreRisk50: 0 | 1,
  windowComplete: boolean,
): TrajectoryStepLabel {
  return {
    immediateResourceDelta: afterResources - beforeResources,
    immediatePopulationDelta: afterUnits - beforeUnits,
    deaths,
    netResourceDelta20,
    deathProb20,
    coreRisk50,
    windowComplete,
  };
}

/** 计算轨迹的确定性 ID：sha256(canonicalJson(steps))。 */
export function computeTrajectoryId(steps: readonly TrajectoryStep[]): string {
  return createHash("sha256").update(canonicalJson(steps)).digest("hex");
}

// ── schema 自检 ──

/** 位置必须为 [number, number]。 */
function isPosition(v: unknown): v is readonly [number, number] {
  return Array.isArray(v) && v.length === 2 &&
    typeof v[0] === "number" && Number.isSafeInteger(v[0]) &&
    typeof v[1] === "number" && Number.isSafeInteger(v[1]);
}

/**
 * 验证 TrajectoryV1 结构合法性。不验证语义/游戏规则。
 * 返回问题描述数组（空 = 合法）。
 */
export function validateTrajectoryV1(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["root must be an object"];
  }
  const t = value as Record<string, unknown>;

  if (t.schema !== TRAJECTORY_SCHEMA_VERSION) {
    problems.push(`schema must be "${TRAJECTORY_SCHEMA_VERSION}"`);
  }
  if (typeof t.trajectoryId !== "string" || t.trajectoryId.length === 0) {
    problems.push("trajectoryId must be non-empty string");
  }
  if (typeof t.metadata !== "object" || t.metadata === null) {
    problems.push("metadata must be an object");
  } else {
    const m = t.metadata as Record<string, unknown>;
    if (!Number.isSafeInteger(m.tickCount) || (m.tickCount as number) < 1) {
      problems.push("metadata.tickCount must be positive integer");
    }
    if (!Number.isSafeInteger(m.seed)) {
      problems.push("metadata.seed must be integer");
    }
  }
  if (!Array.isArray(t.steps)) {
    problems.push("steps must be an array");
  } else if (t.steps.length === 0) {
    problems.push("steps must not be empty");
  } else {
    for (const [i, step] of t.steps.entries()) {
      const s = step as Record<string, unknown> | undefined;
      if (typeof s !== "object" || s === null) {
        problems.push(`steps[${i}] must be an object`);
        continue;
      }
      // 验证 state
      const state = s.state as Record<string, unknown> | undefined;
      if (typeof state !== "object" || state === null) {
        problems.push(`steps[${i}].state must be an object`);
      } else {
        if (!Number.isSafeInteger(state.tick)) problems.push(`steps[${i}].state.tick must be integer`);
        if (!Number.isSafeInteger(state.resources)) problems.push(`steps[${i}].state.resources must be integer`);
        if (!isPosition(state.corePosition)) problems.push(`steps[${i}].state.corePosition must be [x,y]`);
      }
      // 验证 action
      const action = s.action as Record<string, unknown> | undefined;
      if (typeof action !== "object" || action === null) {
        problems.push(`steps[${i}].action must be an object`);
      } else {
        if (typeof action.planHash !== "string") problems.push(`steps[${i}].action.planHash must be string`);
      }
      // 验证 label
      const label = s.label as Record<string, unknown> | undefined;
      if (typeof label !== "object" || label === null) {
        problems.push(`steps[${i}].label must be an object`);
      } else {
        if (!Number.isSafeInteger(label.deaths)) problems.push(`steps[${i}].label.deaths must be integer`);
        if (label.coreRisk50 !== 0 && label.coreRisk50 !== 1) {
          problems.push(`steps[${i}].label.coreRisk50 must be 0 or 1`);
        }
      }
    }
  }

  if (problems.length > 0) return problems;
  return [];
}
