import type { Position, UnitAction, UnitSnapshot } from "../domain/model.ts";
import { manhattan } from "../domain/nav.ts";
import { chunkKeyFor } from "../domain/world.ts";
import type { WorkerProgressExpectation, WorkerProgressExpectations } from "../planning/progress-contract.ts";

/** Worker 局部活性异常。与租户级 StallKind 分层：这里只处理单 Worker。 */
export type WorkerLivenessKind =
  | "economic_no_progress"
  | "move_no_effect"
  | "oscillation"
  | "exploration_no_novelty"
  | "crowd_starvation"
  | "idle_wait";

export interface WorkerLivenessObservation {
  readonly tick: number;
  readonly workers: readonly UnitSnapshot[];
  readonly unitActions: Readonly<Record<string, UnitAction>>;
  readonly intents: Readonly<Record<string, string>>;
  /** Planner 显式声明的任务进展合同；未声明 = liveness 不猜任务目标。 */
  readonly progressExpectations?: WorkerProgressExpectations;
  /** 人类显式接管的单位不做自动活性恢复，避免与 DIRECT 控制打架。 */
  readonly humanControlledUnitIds?: ReadonlySet<string>;
}

export interface WorkerLivenessEvent {
  readonly kind: WorkerLivenessKind;
  readonly tick: number;
  readonly unitId: string;
  readonly streak: number;
  readonly position: Position;
  readonly cargo: number;
  readonly priorActionType: UnitAction["type"];
  readonly priorIntent: string;
  readonly recentPositions: readonly Position[];
  readonly uniqueRecentPositions: number;
  readonly explorationChunk: string;
  readonly knownExplorationChunks: number;
  readonly recoveryCount: number;
  /** 打转封锁闭环（W5）：恢复时把上次的 plannedMove 目标格作为封锁候选上报。
   *  safety-planner.recoverWorker 读取此字段后调 blockCell 把死目标冷却。
   *  仅对 movement-failure 类（oscillation / move_no_effect）填充，且目标龄
   *  >= FRESH_TARGET_TICKS 才填（新鲜目标保护：age<8 不封锁，避免误杀刚指派的
   *  合理新目标——参考 arena_hero_strategy.py:5932）。缺省 = undefined = 不封锁。 */
  readonly blockedTarget?: Position;
}

export interface WorkerLivenessOptions {
  /** 经济意图没有位移/cargo 变化的连续 Tick。生产 GO_RESOURCE+WAIT 用 6。 */
  readonly economicNoProgressTicks?: number;
  /** 连续提交 MOVE 但下一帧位置没变。 */
  readonly moveNoEffectTicks?: number;
  /** 最近窗口内 MOVE 很多、但只在极少数格循环。 */
  readonly oscillationWindowTicks?: number;
  readonly oscillationMaxUniqueCells?: number;
  /** 勘探/巡逻持续移动但没有进入任何新测绘 chunk 的上限。 */
  readonly explorationNoNoveltyTicks?: number;
  /** worker_hold_crowded 连续等待上限。 */
  readonly crowdStarvationTicks?: number;
  /** 其他非豁免 WAIT 连续上限。 */
  readonly idleWaitTicks?: number;
  /** 单位出生后的观察宽限，避免第一帧无前序结果误判。 */
  readonly graceTicks?: number;
  /** 自动恢复后同一 Worker 的重新告警冷却。 */
  readonly cooldownTicks?: number;
}

export const DEFAULT_WORKER_LIVENESS_OPTIONS: Required<WorkerLivenessOptions> = {
  economicNoProgressTicks: 6,
  moveNoEffectTicks: 4,
  oscillationWindowTicks: 12,
  oscillationMaxUniqueCells: 3,
  explorationNoNoveltyTicks: 32,
  crowdStarvationTicks: 6,
  idleWaitTicks: 8,
  graceTicks: 2,
  cooldownTicks: 8,
};

/** 打转封锁（W5）——参考 arena_hero_strategy.py:1292-1293。
 *  MOVE_FAILED 目标格冷却：把死目标写入 temporary_blocks，penalty=12 对
 *  MOVE_CONTESTED/MOVE_DESTINATION_OCCUPIED/MOVE_SWAP_BLOCKED（强竞争类，目标
 *  实际被占），penalty=4 其他失败（路径瞬时拥堵）。 */
export const MOVE_CONTESTED_BLOCK_PENALTY = 12;
export const OTHER_MOVE_FAIL_BLOCK_PENALTY = 4;
/** 新鲜目标保护（参考 :5932）：plannedMove 目标龄 <此 tick 时不作为
 *  blockedTarget 上报，避免刚指派的合理新目标被 MOVE_FAILED 误封锁。 */
export const FRESH_TARGET_TICKS = 8;

/** 格子键（与 worker-task-planner.cellKey 同格式 "x,y"）。 */
function blockadeKey(target: Position): string {
  return `${target[0]},${target[1]}`;
}

interface Sample {
  readonly position: Position;
  readonly cargo: number;
  readonly actionType: UnitAction["type"];
  readonly intent: string;
}

interface WorkerTrack {
  firstTick: number;
  lastPosition: Position;
  lastCargo: number;
  lastAction: UnitAction;
  lastIntent: string;
  lastProgressExpectation: WorkerProgressExpectation | null;
  lastHumanControlled: boolean;
  economicNoProgress: number;
  moveNoEffect: number;
  explorationNoNovelty: number;
  crowdStarvation: number;
  idleWait: number;
  recent: Sample[];
  recoveryCount: number;
  cooldownUntilTick: number;
}

const ECONOMIC_INTENTS = new Set([
  "GO_RESOURCE",
  "HARVEST_CURRENT",
  "DEPOSIT",
  "harvest",
  "return_home",
  // GAP 1.2 fix（2026-08-10）：capacity_wait:DEPOSIT 需计入经济无推进——
  // 满载 worker 被入口满拒（capacity_wait:DEPOSIT）时 cargo 不变 →
  // economicNoProgress 累加 → 6 tick 后 economic_no_progress liveness
  // 事件触发 recoverWorker。旧版在 intentionalWait 豁免 + 不在
  // ECONOMIC_INTENTS → 无任何恢复路径（C7 只覆盖军事单位）。
  "capacity_wait:DEPOSIT",
]);

/** 有意等待：这些等待是协议/战术语义，不应被 generic idle detector 打断。 */
function intentionalWait(intent: string): boolean {
  return intent === "worker_hold_cargo_moving"
    || intent === "worker_yield_spawn"
    || intent === "worker_evade_cooldown"
    || intent === "worker_blockade"
    || intent === "capacity_wait:DEPOSIT";
}

function economicIntent(intent: string): boolean {
  return ECONOMIC_INTENTS.has(intent)
    || intent.startsWith("go_harvest")
    || intent.startsWith("capacity_wait:go_harvest");
}

function samePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function copyPosition(position: Position): Position {
  return [position[0], position[1]];
}

function uniquePositionCount(samples: readonly Sample[]): number {
  return new Set(samples.map((sample) => `${sample.position[0]},${sample.position[1]}`)).size;
}

/**
 * Worker 级活性追踪器。
 *
 * 关键语义：观测 tick=N 的位置，是 tick=N-1 计划执行后的结果，因此异常归因使用
 * track.lastAction/lastIntent，而不是当前刚生成、尚未结算的动作。这样能精确识别
 * "MOVE 提交了但没动"，也不会把下一步计划误当成已经执行。
 */
export class WorkerLivenessTracker {
  private readonly options: Required<WorkerLivenessOptions>;
  private readonly tracks = new Map<string, WorkerTrack>();
  /** Global coverage known to this runtime (seeded from survey-db + newly visited worker chunks). */
  private readonly knownExplorationChunks = new Set<string>();
  /** 打转封锁（W5）：死目标格冷却。key=`${x},${y}`，value=到期 tick（exclusive，
   *  currentTick >= expiry 即过期释放）。MOVE_FAILED 目标格写入，WorkerTaskPlanner
   *  在 Hungarian 候选排序时 isCellBlocked 排后——防 Hungarian 把打转 worker 重派
   *  回同一死目标（"检测→恢复→重派→再打转"循环）。参考 :1292-1293。 */
  private readonly temporaryBlocks = new Map<string, number>();
  /** workerId → 上次计划的目的地（plannedMove）。MOVE_FAILED 时据此知道封哪个格；
   *  UNIT_MOVE_SUCCEEDED 时由 clearPlannedMove 清除。调用方（planner/tenant-runtime）
   *  在生成 GO_RESOURCE 计划时 recordPlannedMove 登记。 */
  private readonly plannedMoves = new Map<string, Position>();
  /** workerId → plannedMove 登记时的 tick。新鲜目标（age<FRESH_TARGET_TICKS）
   *  不作为 blockedTarget 上报（误封锁保护）。 */
  private readonly plannedMoveSinceTick = new Map<string, number>();

  constructor(options: WorkerLivenessOptions = {}) {
    this.options = { ...DEFAULT_WORKER_LIVENESS_OPTIONS, ...options };
    if (this.options.oscillationWindowTicks < 4) throw new Error("oscillationWindowTicks must be >= 4");
    if (this.options.oscillationMaxUniqueCells < 1) throw new Error("oscillationMaxUniqueCells must be >= 1");
    if (this.options.explorationNoNoveltyTicks < 1) throw new Error("explorationNoNoveltyTicks must be >= 1");
  }

  seedKnownChunks(chunks: Iterable<string>): void {
    for (const key of chunks) this.knownExplorationChunks.add(key);
  }

  /** 登记该 worker 本 tick 计划的目的地（GO_RESOURCE target 等）。MOVE_FAILED
   *  时 WorkerLivenessTracker 据此把目标格写入 temporaryBlocks。currentTick 缺省
   *  = 不记龄（视为非新鲜，可被封锁——保留与旧调用方兼容的零回归回退）。 */
  recordPlannedMove(unitId: string, target: Position, currentTick?: number): void {
    this.plannedMoves.set(unitId, copyPosition(target));
    if (currentTick !== undefined) this.plannedMoveSinceTick.set(unitId, currentTick);
  }

  /** UNIT_MOVE_SUCCEEDED 时清该 worker 的 plannedMove 记账（目标已到达，不再
   *  是封锁候选）。参考 :1292 UNIT_MOVE_SUCCEEDED 时清 planned_moves。 */
  clearPlannedMove(unitId: string): void {
    this.plannedMoves.delete(unitId);
    this.plannedMoveSinceTick.delete(unitId);
  }

  /** 把目标格写入封锁冷却至 currentTick + penaltyTicks。penaltyTicks 用
   *  MOVE_CONTESTED_BLOCK_PENALTY（12）或 OTHER_MOVE_FAIL_BLOCK_PENALTY（4）。
   *  重复封锁取较晚到期（max），避免短 penalty 覆盖长 penalty 提前释放。 */
  blockCell(target: Position, currentTick: number, penaltyTicks: number): void {
    if (penaltyTicks < 0) return;
    const key = blockadeKey(target);
    const expiry = currentTick + penaltyTicks;
    const previous = this.temporaryBlocks.get(key);
    if (previous === undefined || expiry > previous) {
      this.temporaryBlocks.set(key, expiry);
    }
  }

  /** 目标格是否处于封锁冷却。到期自动清理（lazy：读时删过期项），过期返回 false。
   *  WorkerTaskPlanner 在 Hungarian 候选排序时调用——封锁格排后（不剔除，保证
   *  全部候选都被封锁时仍能分配）。 */
  isCellBlocked(target: Position, currentTick: number): boolean {
    const key = blockadeKey(target);
    const expiry = this.temporaryBlocks.get(key);
    if (expiry === undefined) return false;
    if (currentTick >= expiry) {
      this.temporaryBlocks.delete(key);
      return false;
    }
    return true;
  }

  onObservation(obs: WorkerLivenessObservation): readonly WorkerLivenessEvent[] {
    const live = new Set(obs.workers.map((worker) => worker.id));
    for (const id of this.tracks.keys()) {
      if (!live.has(id)) {
        this.tracks.delete(id);
        // worker 消失同步清记账，防 id 复用时残留旧 plannedMove 干扰新鲜目标判定。
        this.plannedMoves.delete(id);
        this.plannedMoveSinceTick.delete(id);
      }
    }

    const human = obs.humanControlledUnitIds ?? new Set<string>();
    const events: WorkerLivenessEvent[] = [];
    const workerChunks = new Map(obs.workers.map((worker) => [worker.id, chunkKeyFor(worker.position)] as const));
    const novelChunks = new Set(
      [...new Set(workerChunks.values())].filter((key) => !this.knownExplorationChunks.has(key)),
    );
    for (const key of workerChunks.values()) this.knownExplorationChunks.add(key);

    for (const worker of obs.workers) {
      const action = obs.unitActions[worker.id] ?? { type: "WAIT" };
      const intent = obs.intents[worker.id] ?? "WAIT_UNCLAIMED";
      const previous = this.tracks.get(worker.id);
      if (previous === undefined) {
        this.tracks.set(worker.id, {
          firstTick: obs.tick,
          lastPosition: copyPosition(worker.position),
          lastCargo: worker.cargo,
          lastAction: action,
          lastIntent: intent,
          lastProgressExpectation: obs.progressExpectations?.get(worker.id) ?? null,
          lastHumanControlled: human.has(worker.id),
          economicNoProgress: 0,
          moveNoEffect: 0,
          explorationNoNovelty: 0,
          crowdStarvation: 0,
          idleWait: 0,
          recent: [{ position: copyPosition(worker.position), cargo: worker.cargo, actionType: action.type, intent }],
          recoveryCount: 0,
          cooldownUntilTick: 0,
        });
        continue;
      }

      const moved = !samePosition(previous.lastPosition, worker.position);
      const cargoChanged = previous.lastCargo !== worker.cargo;
      const physicalProgress = moved || cargoChanged;
      const explicitHuman = previous.lastHumanControlled;
      const exemptWait = intentionalWait(previous.lastIntent);
      const oldEnough = obs.tick - previous.firstTick >= this.options.graceTicks;

      if (explicitHuman) {
        this.resetStreaks(previous);
      } else {
        previous.moveNoEffect = previous.lastAction.type === "MOVE" && !moved
          ? previous.moveNoEffect + 1
          : 0;
        let taskProgress = physicalProgress;
        if (previous.lastProgressExpectation?.kind === "target") {
          const before = manhattan(previous.lastPosition, previous.lastProgressExpectation.target);
          const after = manhattan(worker.position, previous.lastProgressExpectation.target);
          taskProgress = cargoChanged || after < before;
        } else if (previous.lastProgressExpectation?.kind === "cargo_change") {
          taskProgress = cargoChanged;
        }
        previous.economicNoProgress = economicIntent(previous.lastIntent) && !taskProgress
          ? previous.economicNoProgress + 1
          : 0;
        const currentChunk = workerChunks.get(worker.id)!;
        const previousChunk = chunkKeyFor(previous.lastPosition);
        const coverageProgress = novelChunks.has(currentChunk) || currentChunk !== previousChunk;
        previous.explorationNoNovelty = previous.lastProgressExpectation?.kind === "novel_coverage" && !coverageProgress
          ? previous.explorationNoNovelty + 1
          : 0;
        previous.crowdStarvation = previous.lastIntent === "worker_hold_crowded" && !physicalProgress
          ? previous.crowdStarvation + 1
          : 0;
        previous.idleWait = previous.lastAction.type === "WAIT" && !exemptWait && !physicalProgress
          ? previous.idleWait + 1
          : 0;
      }

      previous.recent.push({
        position: copyPosition(worker.position),
        cargo: worker.cargo,
        actionType: action.type,
        intent,
      });
      if (previous.recent.length > this.options.oscillationWindowTicks) previous.recent.shift();

      if (oldEnough && !explicitHuman && obs.tick >= previous.cooldownUntilTick) {
        const candidate = this.detect(previous);
        if (candidate !== null) {
          previous.recoveryCount += 1;
          events.push({
            kind: candidate.kind,
            tick: obs.tick,
            unitId: worker.id,
            streak: candidate.streak,
            position: copyPosition(worker.position),
            cargo: worker.cargo,
            priorActionType: previous.lastAction.type,
            priorIntent: previous.lastIntent,
            recentPositions: previous.recent.map((sample) => copyPosition(sample.position)),
            uniqueRecentPositions: uniquePositionCount(previous.recent),
            explorationChunk: workerChunks.get(worker.id)!,
            knownExplorationChunks: this.knownExplorationChunks.size,
            recoveryCount: previous.recoveryCount,
            blockedTarget: this.computeBlockedTarget(candidate.kind, worker.id, obs.tick),
          });
          previous.cooldownUntilTick = obs.tick + this.options.cooldownTicks;
          previous.recent = [{ position: copyPosition(worker.position), cargo: worker.cargo, actionType: action.type, intent }];
          this.resetStreaks(previous);
        }
      }

      previous.lastPosition = copyPosition(worker.position);
      previous.lastCargo = worker.cargo;
      previous.lastAction = action;
      previous.lastIntent = intent;
      previous.lastProgressExpectation = obs.progressExpectations?.get(worker.id) ?? null;
      previous.lastHumanControlled = human.has(worker.id);
    }
    return events;
  }

  private detect(track: WorkerTrack): { kind: WorkerLivenessKind; streak: number } | null {
    // 越具体越优先；一次只触发一种，避免同 Tick 对同 Worker 连续 reset。
    if (track.crowdStarvation >= this.options.crowdStarvationTicks) {
      return { kind: "crowd_starvation", streak: track.crowdStarvation };
    }
    if (track.economicNoProgress >= this.options.economicNoProgressTicks) {
      return { kind: "economic_no_progress", streak: track.economicNoProgress };
    }
    if (track.moveNoEffect >= this.options.moveNoEffectTicks) {
      return { kind: "move_no_effect", streak: track.moveNoEffect };
    }
    if (track.explorationNoNovelty >= this.options.explorationNoNoveltyTicks) {
      return { kind: "exploration_no_novelty", streak: track.explorationNoNovelty };
    }
    if (track.recent.length >= this.options.oscillationWindowTicks) {
      const moveAttempts = track.recent.filter((sample) => sample.actionType === "MOVE").length;
      const uniqueCargo = new Set(track.recent.map((sample) => sample.cargo)).size;
      if (
        moveAttempts >= Math.ceil(this.options.oscillationWindowTicks * 0.6)
        && uniquePositionCount(track.recent) <= this.options.oscillationMaxUniqueCells
        && uniqueCargo === 1
      ) {
        return { kind: "oscillation", streak: track.recent.length };
      }
    }
    if (track.idleWait >= this.options.idleWaitTicks) {
      return { kind: "idle_wait", streak: track.idleWait };
    }
    return null;
  }

  /** 计算事件应上报的 blockedTarget。仅 oscillation / move_no_effect（movement-
   *  failure 类）才上报——这两类的恢复才会把死目标格封锁。新鲜目标（age<
   *  FRESH_TARGET_TICKS，:5932）返回 undefined：刚指派的合理新目标不应被 MOVE_FAILED
   *  误封锁。plannedMove 未登记（调用方未 record）也返回 undefined（零回归）。 */
  private computeBlockedTarget(
    kind: WorkerLivenessKind,
    unitId: string,
    currentTick: number,
  ): Position | undefined {
    if (kind !== "oscillation" && kind !== "move_no_effect") return undefined;
    const target = this.plannedMoves.get(unitId);
    if (target === undefined) return undefined;
    const sinceTick = this.plannedMoveSinceTick.get(unitId);
    if (sinceTick === undefined) return copyPosition(target); // 无龄信息：视为非新鲜，可封锁
    const age = currentTick - sinceTick;
    if (age < FRESH_TARGET_TICKS) return undefined; // 新鲜目标保护
    return copyPosition(target);
  }

  private resetStreaks(track: WorkerTrack): void {
    track.economicNoProgress = 0;
    track.moveNoEffect = 0;
    track.explorationNoNovelty = 0;
    track.crowdStarvation = 0;
    track.idleWait = 0;
  }
}
