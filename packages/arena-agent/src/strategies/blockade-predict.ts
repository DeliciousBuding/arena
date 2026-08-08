/**
 * 锁阵预判纯函数（2026-08-08，blockade-tactics-v1 阶段 0）：
 * 把"炼锁阵"（主动利用格子容量 2 + 移动冲突规则锁死敌方单位）的预判逻辑
 * 收敛为纯函数——不依赖 planner 状态，单测可复现。生产事实见
 * `../../../../docs/design/blockade-tactics-v1.md`。
 *
 * 三件套：
 * - enemyReturnPath：敌方单位"朝敌核心移动"的短程路径预测（锁点候选）；
 * - chokepointLockPoint：环境瓶颈锁点（敌核心邻格 / 资源旁必经格）——
 *   敌方必然经过，比纯路径预测更稳；
 * - suspectedBlocked：我方单位"疑似被锁"检测（连续 MOVE_FAILED + 位置未变）。
 */
import { cellKey, type Direction, type Position } from "../domain/model.ts";
import { manhattan } from "../domain/nav.ts";
import type { CoreHuntTarget, EnemyMemory } from "../domain/world.ts";

/** 锁点距离敌核心记忆的安全距离（Chebyshev，与 PREY_CORE_SAFE 同口径）：
 *  敌核心 8 格内 = 有守军风险，锁位单位过去会送死。 */
export const BLOCKADE_CORE_SAFE = 8;
/** 回程路径预测窗口（tick）：4 tick 内锁定；超出即放弃——敌方可能转向，
 *  长窗口不可靠（t2 实证敌方直线段 3-18 tick，短程延续概率高）。 */
export const BLOCKADE_PREDICT_TICKS = 4;

const DIRECTION_DELTA: Readonly<Record<Direction, readonly [number, number]>> = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
};

/** 回程预测：敌方单位当前移动方向 + 预测接下来 N 个目标格。 */
export interface EnemyReturnPrediction {
  readonly enemyId: string;
  /** 敌方单位类型（vanguard-blockade 只锁 WORKER——军事单位由战斗逻辑处理）。 */
  readonly enemyType: "WORKER" | "VANGUARD" | "RANGER";
  readonly position: Position;
  /** 当前移动方向（由 prevPosition → position 差分，须是纯卡向一步）。 */
  readonly direction: Direction;
  /** 预测接下来将进入的格（沿方向延续，遇障碍中断）。 */
  readonly nextCells: readonly Position[];
  /** 该方向指向的敌核心（若命中 coreHuntTargets）。 */
  readonly targetCore: Position | null;
}

/**
 * 敌方回程路径预测（纯函数）：移动中（有 prevPosition 差分）且当前移动方向
 * 使单位更接近某个敌核心记忆 → 判为"回程特征"，沿方向预测 nextCells。
 * 预测遇障碍中断（避免锁到假路径上）；无敌核心记忆时仍给"移动中"预测
 * （方向延续性在短窗口内成立，锁点选择由调用方按环境锁点优先级处理）。
 */
export function enemyReturnPath(
  hints: readonly EnemyMemory[],
  coreTargets: readonly CoreHuntTarget[],
  obstacles: ReadonlySet<string>,
  predictTicks = BLOCKADE_PREDICT_TICKS,
): readonly EnemyReturnPrediction[] {
  const predictions: EnemyReturnPrediction[] = [];
  for (const hint of hints) {
    if (hint.kind !== "UNIT" || hint.prevPosition === undefined) continue;
    const dx = hint.position[0] - hint.prevPosition[0];
    const dy = hint.position[1] - hint.prevPosition[1];
    // 必须是一步卡向移动（|dx|+|dy|==1）；原地/斜跳不算"移动中"
    if (Math.abs(dx) + Math.abs(dy) !== 1) continue;
    const direction: Direction = dy < 0 ? "UP" : dy > 0 ? "DOWN" : dx > 0 ? "RIGHT" : "LEFT";
    // 目标敌核心：移动方向使投影距离递减的最近敌核心。接受 CORE 目击与
    // WORKER_INFER 推断锚点（2026-08-08：开局只有 worker 迹象时无 CORE
    // 目击，终点封锁永不触发——推断核心由 worker 轨迹双向延伸得出，
    // 方向大致正确，锁错 30 tick 锁龄后放弃，风险可控）。
    let targetCore: Position | null = null;
    let targetDistance = Number.POSITIVE_INFINITY;
    const next = moveCell(hint.position, direction);
    for (const target of coreTargets) {
      const before = manhattan(hint.position, target.position);
      const after = manhattan(next, target.position);
      if (after < before && before < targetDistance) {
        targetCore = target.position;
        targetDistance = before;
      }
    }
    // 预测路径：沿方向延续，遇障碍/超窗中断
    const nextCells: Position[] = [];
    let cursor = hint.position;
    for (let i = 0; i < predictTicks; i += 1) {
      const candidate = moveCell(cursor, direction);
      if (obstacles.has(cellKey(candidate))) break;
      nextCells.push(candidate);
      cursor = candidate;
    }
    if (nextCells.length === 0) continue;
    predictions.push({
      enemyId: hint.id,
      enemyType: hint.unitType as "WORKER" | "VANGUARD" | "RANGER",
      position: hint.position,
      direction,
      nextCells,
      targetCore,
    });
  }
  return predictions;
}

/** 环境锁点候选（优先级由调用方保证：敌核心邻格 > 资源旁 > 通道）。 */
export interface ChokepointLockPoint {
  readonly cell: Position;
  /** 锁点类型（决策/遥测用）。 */
  readonly kind: "enemy_core_adjacent" | "resource_adjacent" | "obstacle_pass";
}

/**
 * 环境瓶颈锁点（纯函数）：敌方必然经过的环境格——锁点选址优先于纯路径
 * 预测（不依赖敌方走直线）。优先级：
 * 1. 敌核心 4 邻格（空、非障碍、非占用）——封锁敌方卸货通道（DEPOSIT 需
 *    worker 与 Core 同格）；
 * 2. 资源点旁必经格（空）——敌方采集回程必经；
 * 3. 障碍窄通道（≥2 侧被障碍包围的空格）——一夫当关，整链回传失败。
 * 返回 null = 无可锁环境点。
 */
export function chokepointLockPoint(
  enemyCore: Position | null,
  resourceCells: readonly Position[],
  obstacles: ReadonlySet<string>,
  occupied: ReadonlySet<string>,
): ChokepointLockPoint | null {
  const free = (cell: Position): boolean =>
    !obstacles.has(cellKey(cell)) && !occupied.has(cellKey(cell));
  // 1. 敌核心邻格（首选，但敌核心 8 格内由调用方守卫，这里只做格级判定）
  if (enemyCore !== null) {
    for (const direction of ["UP", "RIGHT", "DOWN", "LEFT"] as const) {
      const cell = moveCell(enemyCore, direction);
      if (free(cell)) return { cell, kind: "enemy_core_adjacent" };
    }
  }
  // 2. 资源点旁（四邻第一个空格）
  for (const resource of resourceCells) {
    for (const direction of ["UP", "RIGHT", "DOWN", "LEFT"] as const) {
      const cell = moveCell(resource, direction);
      if (free(cell)) return { cell, kind: "resource_adjacent" };
    }
  }
  // 3. 障碍窄通道：≥2 侧被障碍包围的空格（不含已在资源/核心邻格处理过的，
  //    也不含敌核心格本身——Core 占据，锁位单位不能与敌 Core 同格）
  const candidates: Position[] = [];
  for (const obstacle of obstacles) {
    const [x, y] = obstacle.split(",").map(Number) as [number, number];
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    for (const direction of ["UP", "RIGHT", "DOWN", "LEFT"] as const) {
      const cell = moveCell([x, y], direction);
      if (!free(cell)) continue;
      if (enemyCore !== null && cell[0] === enemyCore[0] && cell[1] === enemyCore[1]) continue;
      const key = cellKey(cell);
      if (candidates.some((c) => cellKey(c) === key)) continue;
      const blockedSides = (["UP", "RIGHT", "DOWN", "LEFT"] as const)
        .filter((d) => obstacles.has(cellKey(moveCell(cell, d)))).length;
      if (blockedSides >= 2) {
        candidates.push(cell);
        // 确定性：按坐标排序后取第一个（避免遍历顺序不稳定）
        candidates.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        break;
      }
    }
  }
  if (candidates.length > 0) return { cell: candidates[0], kind: "obstacle_pass" };
  return null;
}

/**
 * 疑似被锁检测（纯函数）：单位连续 ≥threshold tick 移动被拒绝（MOVE_FAILED，
 * 含 MOVE_CONTESTED/MOVE_DESTINATION_OCCUPIED/CELL_UNIT_LIMIT）且位置未变
 * = 疑似被锁 → 调用方应换路/换目标（防无限重试同格；对齐 moveFailedAvoidance
 * 哲学但加位置校验——"绕行成功但路径重走"不算被锁）。
 */
export function suspectedBlocked(
  moveFailedStreak: ReadonlyMap<string, number>,
  unitId: string,
  position: Position,
  lastPosition: Position | undefined,
  threshold = 3,
): boolean {
  if (lastPosition === undefined) return false;
  if (position[0] !== lastPosition[0] || position[1] !== lastPosition[1]) return false;
  return (moveFailedStreak.get(unitId) ?? 0) >= threshold;
}

/**
 * 锁位配对（纯函数，2026-08-08）：回程预测目标 × 空闲巡逻 worker → 贪心配对
 * （每目标 1 锁位手，每 worker 至多 1 目标）。确定性：目标按
 * （targetCore 有无，enemyId）排序，worker 按（距离，id）排序。
 * 两档锁点策略：
 * 1. 终点封锁（targetCore 已知，2026-08-08 修复）：锁手直接部署到敌核心
 *    入口邻格（敌方回程必经）——锁手与敌方同速永远追不上路径（A/B 实证
 *    敌方一路畅通），堵终点是唯一稳赢的拦截；锁龄由调用方按入口锁放宽
 *    （BLOCKADE_CORE_LOCK_MAX_TICKS），防"锁手提前 15 tick 到达、10 tick
 *    锁龄先满而敌方未到"的提前放弃；
 * 2. 中途拦截（targetCore 未知）：遍历预测路径 nextCells 选"锁手可提前/
 *    同时到达"的格（margin = 敌方距格 - 锁手距格 最大）——锁手恰好在
 *    路径前方时提前站桩；全追不上时选 margin 最大的格（敌方被其他格
 *    挡下后锁手仍有机会）。
 * 返回 unitId → lockPoint（拦截格，站桩即挡）。 */
export function pairBlockadeTargets(
  predictions: readonly EnemyReturnPrediction[],
  idleWorkers: readonly { id: string; position: Position }[],
  cap: number,
): Map<string, Position> {
  const assignment = new Map<string, Position>();
  if (cap <= 0 || idleWorkers.length === 0 || predictions.length === 0) return assignment;
  const available = [...idleWorkers].sort((a, b) => a.id.localeCompare(b.id));
  // 目标排序：有 targetCore（朝敌核心回程）优先，其次 enemyId 字典序（确定性）
  const ordered = [...predictions].sort((a, b) => {
    const aCore = a.targetCore === null ? 0 : 1;
    const bCore = b.targetCore === null ? 0 : 1;
    return bCore - aCore || a.enemyId.localeCompare(b.enemyId);
  });
  for (const prediction of ordered) {
    if (assignment.size >= cap) break;
    if (prediction.targetCore !== null) {
      // 终点封锁：锁核心入口邻格（敌方位置侧四邻之一，选离敌方最近的
      // 空口——敌方必然从该方向进核心）。离入口最近的空闲 worker 前往
      // 站桩；同一入口只配 1 人（防两锁手挤一格）。
      const entry = coreEntryPoint(prediction.targetCore, prediction.position);
      let best: { id: string; position: Position } | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const worker of available) {
        if (assignment.has(worker.id)) continue;
        // 已被其他预测锁到同一入口 → 换邻格（循环尝试四邻）
        const distance = manhattan(worker.position, entry);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = worker;
        }
      }
      if (best === null) break;
      assignment.set(best.id, entry);
      continue;
    }
    // 中途拦截点选择：对每个候选锁手，遍历预测路径格，选"敌方距离 - 锁手
    // 距离"最大的格（锁手提前量最大 = 最早能站住的路口）；确定性 tie-break。
    let bestWorker: { id: string; position: Position } | null = null;
    let bestPoint: Position | null = null;
    let bestMargin = Number.NEGATIVE_INFINITY;
    for (const worker of available) {
      if (assignment.has(worker.id)) continue;
      for (const cell of prediction.nextCells) {
        const enemyDistance = manhattan(prediction.position, cell);
        const workerDistance = manhattan(worker.position, cell);
        const margin = enemyDistance - workerDistance;
        if (margin > bestMargin) {
          bestMargin = margin;
          bestWorker = worker;
          bestPoint = cell;
        }
      }
    }
    if (bestWorker === null || bestPoint === null) break;
    assignment.set(bestWorker.id, bestPoint);
  }
  return assignment;
}

/** 核心入口邻格：targetCore 四邻中离敌方当前最近的格（敌方最后一段必然
 *  从最近的口进核心）。 */
function coreEntryPoint(targetCore: Position, enemyPosition: Position): Position {
  const entries: Position[] = [
    [targetCore[0] + 1, targetCore[1]],
    [targetCore[0] - 1, targetCore[1]],
    [targetCore[0], targetCore[1] + 1],
    [targetCore[0], targetCore[1] - 1],
  ];
  return entries.sort(
    (a, b) =>
      manhattan(a, enemyPosition) - manhattan(b, enemyPosition) ||
      a[0] - b[0] ||
      a[1] - b[1],
  )[0];
}

/** 沿卡向移动一格。 */
function moveCell(position: Position, direction: Direction): Position {
  const [dx, dy] = DIRECTION_DELTA[direction];
  return [position[0] + dx, position[1] + dy];
}
