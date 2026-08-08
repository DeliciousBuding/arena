/**
 * 迁移节奏决策（migration-system-v1 §3.2，评审 P2-1 定稿，纯函数）。
 *
 * LEG_MOVE：burst 8 格连续推进（威胁高自动降 1-4——threatLevel 输入由调用方
 *   按活跃敌核距离折算，本函数只做档位决策）。
 * LEG_SETTLE：target 60 tick（30 下限 / 120 硬上限），**readiness 主导退出**：
 *   `elapsed ≥ minSettle && 满载 worker 清空 && stragglersReady`。
 * 节奏指标：coreReceptiveRatio = settle / (burst×4 + settle)（默认 8/60 → ≈65.2%）。
 */

import type { MigrationPhase } from "./state-machine.ts";

export type PaceDecision =
  | "advance"
  | "wait_moving"
  | "hold"
  | "burst_exhausted"
  | "settle_continue"
  | "settle_done";

export interface PacingInput {
  readonly phase: MigrationPhase;
  readonly coreState: "NORMAL" | "MOVING" | null;
  readonly cellsThisLeg: number;
  readonly burstCells: number;
  /** 满载 worker 数（readiness 判定：迁移续走前必须清空）。 */
  readonly cargoWorkerCount: number;
  /** 经济尾巴就绪（散落 worker 回到集结带）。 */
  readonly stragglersReady: boolean;
  /** 近矿剩余（harvest-driven 信号，调用方按 live 可见资源计算）。 */
  readonly nearMinesRemaining: number;
  readonly settleElapsed: number;
  readonly minSettle: number;
  readonly maxSettle: number;
  readonly settleTarget: number;
  /** 威胁档（0=无威胁；≥1=高威胁，暂停推进）。 */
  readonly threatLevel: number;
}

export interface PaceDecisionResult {
  readonly decision: PaceDecision;
  readonly reason: string;
  readonly coreReceptiveRatio: number;
}

/** 节奏指标：核心可接收经济动作的时间占比（MOVING 4 tick/格）。
 *  语义 = settle 占比：settle / (burst×4 + settle)（默认 8/60 → 60/92 ≈ 65.2%，
 *  与设计 §3.2 指标值一致——burst×4 是"不可接收"窗口）。 */
export function coreReceptiveRatio(burstCells: number, settleTicks: number): number {
  if (burstCells < 1 || settleTicks < 0) return 0;
  const moveTicks = burstCells * 4;
  return settleTicks / (moveTicks + settleTicks);
}

/** 理想 ETA（模型）：格数 × 4 tick/格 + 剩余腿 × 休整。 */
export function idealEtaTicks(cellsRemaining: number, legsRemaining: number, settleTarget: number): number {
  return cellsRemaining * 4 + legsRemaining * settleTarget;
}

/** 实测 ETA（近 N 格速率外推；cellsPerTick 由调用方统计）。 */
export function observedEtaTicks(cellsRemaining: number, observedCellsPerTick: number): number {
  if (observedCellsPerTick <= 0) return Number.POSITIVE_INFINITY;
  return cellsRemaining / observedCellsPerTick;
}

export function decidePacing(input: PacingInput): PaceDecisionResult {
  const ratio = coreReceptiveRatio(input.burstCells, input.settleTarget);
  if (input.phase === "DEFENSIVE_HOLD") {
    return { decision: "hold", reason: "防御暂停（DEFENSIVE_HOLD），不推进", coreReceptiveRatio: ratio };
  }
  if (input.coreState === "MOVING") {
    return { decision: "wait_moving", reason: "核心 MOVING 中，等待到达目标格", coreReceptiveRatio: ratio };
  }
  if (input.phase === "LEG_MOVE") {
    if (input.threatLevel >= 1) {
      return { decision: "hold", reason: `威胁档 ${input.threatLevel} ≥1，暂停推进`, coreReceptiveRatio: ratio };
    }
    if (input.cellsThisLeg >= input.burstCells) {
      return {
        decision: "burst_exhausted",
        reason: `burst ${input.cellsThisLeg}/${input.burstCells} 达标，应转休整`,
        coreReceptiveRatio: ratio,
      };
    }
    return {
      decision: "advance",
      reason: `burst 推进 ${input.cellsThisLeg}/${input.burstCells}`,
      coreReceptiveRatio: ratio,
    };
  }
  if (input.phase === "LEG_SETTLE") {
    if (input.settleElapsed >= input.maxSettle) {
      return { decision: "settle_done", reason: `休整达硬上限 ${input.maxSettle}，强制续迁`, coreReceptiveRatio: ratio };
    }
    if (input.settleElapsed >= input.minSettle && input.cargoWorkerCount === 0 && input.stragglersReady) {
      return {
        decision: "settle_done",
        reason: `readiness 达成（≥minSettle ${input.minSettle}、货清、尾巴就绪）`,
        coreReceptiveRatio: ratio,
      };
    }
    return {
      decision: "settle_continue",
      reason: `休整中 ${input.settleElapsed}/${input.settleTarget}（货 ${input.cargoWorkerCount}、尾巴 ${input.stragglersReady ? "就绪" : "未就绪"}）`,
      coreReceptiveRatio: ratio,
    };
  }
  return { decision: "hold", reason: `非迁移窗口（${input.phase}）`, coreReceptiveRatio: ratio };
}
