/** 矿刷新预测（2026-08-08，worker-mission-v1 Phase 2，G3 数据管道）：
 *  agent 侧直接从 survey-db 的 resource_seen_history 计算逐矿 dueInTicks——
 *  与 command-center lib/mine-patterns.ts 同算法（窗口切分 → avgGap/avgAbsent
 *  → 预测：lastEnd + avgAbsent），纯函数移植（agent 不依赖 command-center 包）。
 *  2026-08-08 契约对齐修复：predictedNextTick 由 lastStart+avgGap 改为
 *  lastEnd+avgAbsent（mine-patterns SSOT；实测旧公式 95% 格与 command-center
 *  分叉、最大差 72 tick——死矿剔除/即将刷新占位判定会不一致）。分配层消费：
 *  - dueInTicks ≤ refillLookahead（即将刷新）→ 值层加成，worker 提前占位；
 *  - dueInTicks < −deadMineOverdueTicks（疑似永久采空）→ 死矿剔除，不派 worker
 *    （t1 实证：14 worker 循环近核死种子、cargo=0 冻结）。
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openSurveyDb } from "./survey-db.ts";

/** 连续 tick 间隔 ≤ 该值视为同一出现窗口（矿可见跨 tick 抖动容忍，与
 *  command-center mine-patterns REFILL_GAP_TICKS 一致）。 */
const REFILL_GAP_TICKS = 5;

/** 出现窗口 ≥2 才可预测（与 mine-patterns 一致）。 */
const MIN_WINDOWS = 2;

/**
 * P0 修复：refill 预测 SQL 查询的 tick 回溯窗口。
 * resource_seen_history 跨 run 无限累积——SELECT 全表会导致 O(n) RAM + O(n log n)
 * 排序每调用。refill 周期最多 ~32 tick（4 个 refill 周期 × 8 tick），3000 tick
 * 窗口约 94 个周期——足够统计 avgGap/avgAbsent。
 */
export const REFILL_PREDICTION_WINDOW_TICKS = 3000;

export interface SeenRow {
  readonly cell: string;
  readonly tick: number;
}

/** 逐矿刷新预测（cell → 预测语义；仅含可预测格）。 */
export interface RefillPrediction {
  readonly cell: string;
  readonly windows: number;
  readonly avgGapTicks: number;
  readonly lastWindowStartTick: number;
  readonly predictedNextTick: number;
  readonly dueInTicks: number;
}

/** 窗口切分 + 周期估计（纯函数，mine-patterns 同算法移植）。
 *  行按 tick 升序输入；输出 Map<cell, RefillPrediction>，确定性排序。
 *  predictedNextTick = 最后窗口结束 + 平均缺席长（avgAbsent）——与
 *  command-center lib/mine-patterns.ts computeRefillPredictions 完全一致。 */
export function computeRefillPredictions(
  rows: readonly SeenRow[],
  currentTick: number,
): ReadonlyMap<string, RefillPrediction> {
  const byCell = new Map<string, number[]>();
  for (const row of rows) {
    const ticks = byCell.get(row.cell) ?? [];
    ticks.push(row.tick);
    byCell.set(row.cell, ticks);
  }
  const predictions = new Map<string, RefillPrediction>();
  for (const [cell, ticks] of byCell) {
    ticks.sort((a, b) => a - b);
    const windows: Array<{ start: number; end: number }> = [];
    let start = ticks[0], prevEnd = ticks[0];
    for (let i = 1; i < ticks.length; i += 1) {
      if (ticks[i] - prevEnd > REFILL_GAP_TICKS) {
        windows.push({ start, end: prevEnd });
        start = ticks[i];
      }
      prevEnd = ticks[i];
    }
    windows.push({ start, end: prevEnd });
    if (windows.length < MIN_WINDOWS) continue;
    const gaps: number[] = [];      // 窗口起始差（完整刷新周期）
    const absents: number[] = [];   // 缺席长（窗口间隔 − 前一窗口时长）
    for (let index = 1; index < windows.length; index += 1) {
      const gap = windows[index].start - windows[index - 1].start;
      gaps.push(gap);
      const dur = windows[index - 1].end - windows[index - 1].start;
      absents.push(gap - dur);
    }
    const avgGapTicks = Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length);
    const avgAbsent = Math.max(1, Math.round(absents.reduce((sum, a) => sum + a, 0) / absents.length));
    const lastWindowStartTick = windows[windows.length - 1].start;
    const lastEnd = windows[windows.length - 1].end;
    const predictedNextTick = lastEnd + avgAbsent;
    predictions.set(cell, {
      cell,
      windows: windows.length,
      avgGapTicks,
      lastWindowStartTick,
      predictedNextTick,
      dueInTicks: predictedNextTick - currentTick,
    });
  }
  return predictions;
}

/** 从 per-tenant survey db 加载 seen 历史并计算预测（只读）。
 *  db 缺失/无历史 = 空 Map（零回归——无预测时分配走既有行为）。 */
export function loadRefillPredictions(
  dataRoot: string,
  tenant: string,
  currentTick: number,
): ReadonlyMap<string, RefillPrediction> {
  let db: DatabaseSync;
  try {
    db = openSurveyDb(dataRoot, tenant, false);
  } catch {
    return new Map();
  }
  try {
    // P0 修复：WHERE tick > ? 窗口防 resource_seen_history 跨 run 无限累积
    // 导致全表加载 O(n) RAM + O(n log n) 排序。
    const horizonTick = Math.max(0, currentTick - REFILL_PREDICTION_WINDOW_TICKS);
    const rows = db
      .prepare("SELECT cell, tick FROM resource_seen_history WHERE tick > ? ORDER BY tick ASC")
      .all(horizonTick) as unknown as SeenRow[];
    return computeRefillPredictions(rows, currentTick);
  } catch {
    return new Map();
  } finally {
    db?.close();
  }
}

/** survey db 路径（openSurveyDb 同构；供诊断/测试）。 */
export function surveyDbPath(dataRoot: string, tenant: string): string {
  return join(dataRoot, "runtime", "survey", `${tenant}.db`);
}

export { MIN_WINDOWS, REFILL_GAP_TICKS };
