/**
 * 生产形态窗口评估（第四十六轮 python 工具 TS 化）：用 calibration 真实对局
 * 快照统计已注册变体的触发窗口——敌情可见度、敌距 Core 分布、threat-recall
 * 窗口（ALERT ≤12 格）、clear-path 窗口（满载 worker 2 格内敌）、
 * move-failed 频率。
 *
 * 口径（与 production-variant-window.py 一致，2026-08-06 第四十六轮）：
 * - before.state.objects 是决策时视野快照（我方 + 可见敌）；
 * - after.state.events 是当 tick 结算事件（含 UNIT_MOVE_FAILED）；
 * - 敌距我方 Core 用 Manhattan；ALERT 触发半径 12；RECALL 巡逻半径 4。
 *
 * 用法（CLI）：npx tsx scripts/variant-window.mts --tenant t1 --runtime <root>
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

interface Position {
  readonly x: number;
  readonly y: number;
}

interface SnapshotObject {
  readonly kind?: string;
  readonly controlled?: boolean;
  readonly position?: readonly [number, number];
  readonly unitType?: string;
  readonly cargo?: number | null;
}

interface SnapshotEvent {
  readonly eventType?: string;
  readonly actorId?: string;
}

interface CalibrationCase {
  readonly before: { readonly state: { readonly objects?: readonly SnapshotObject[] } };
  readonly after: { readonly state: { readonly events?: readonly SnapshotEvent[] } };
}

export interface VariantWindowReport {
  readonly schema: "sim.variant-window.v1";
  readonly tenant: string;
  readonly caseCount: number;
  readonly ticks: number;
  /** 可见敌 UNIT 的 tick 占比。 */
  readonly enemyVisibleRatio: number;
  /** 每 tick 最近敌距 Core 的分布（键 = 距离档，≤5/≤12/≤20/≤30/>30）。 */
  readonly minEnemyDistanceBuckets: Readonly<Record<string, number>>;
  /** threat-recall 窗口：敌距 Core ≤12（ALERT）tick 占比。 */
  readonly alertWindowRatio: number;
  /** clear-path 窗口：满载 worker 距敌 ≤2 tick 占比。 */
  readonly clearPathWindowRatio: number;
  /** move-failed 事件数与总事件数。 */
  readonly moveFailed: { readonly count: number; readonly total: number; readonly ratio: number };
}

function manhattan(a: Position, b: Position): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function asPosition(value: readonly [number, number] | undefined): Position | null {
  if (value === undefined || value.length < 2) return null;
  return { x: value[0], y: value[1] };
}

/** 统计某租户最新 calibration run 的变体触发窗口。 */
export function analyzeVariantWindow(runtimeRoot: string, tenant: string): VariantWindowReport {
  const calibrationRoot = join(runtimeRoot, "runtime", tenant, "calibration");
  const runDirs = readdirSync(calibrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, mtime: statMtime(join(calibrationRoot, entry.name)) }))
    .sort((a, b) => a.mtime - b.mtime);
  if (runDirs.length === 0) throw new Error(`no calibration runs for ${tenant}`);
  const latest = runDirs[runDirs.length - 1].name;
  const caseDir = join(calibrationRoot, latest, "cases");
  const caseFiles = readdirSync(caseDir).filter((name) => name.endsWith(".json")).sort();

  let ticks = 0;
  let enemyVisibleTicks = 0;
  let alertWindowTicks = 0;
  let clearPathWindowTicks = 0;
  const distanceBuckets: Record<string, number> = { "5": 0, "12": 0, "20": 0, "30": 0, "31": 0 };
  let moveFailed = 0;
  let eventTotal = 0;

  for (const file of caseFiles) {
    const parsed = JSON.parse(readFileSync(join(caseDir, file), "utf8")) as CalibrationCase;
    const objects = parsed.before?.state?.objects ?? [];
    ticks += 1;

    let core: Position | null = null;
    const myUnits: Array<{ type?: string; pos: Position; cargo?: number | null }> = [];
    const enemies: Position[] = [];
    for (const obj of objects) {
      if (obj.kind === "CORE") {
        const pos = asPosition(obj.position);
        if (obj.controlled === true && pos !== null) core = pos;
        continue;
      }
      if (obj.kind !== "UNIT") continue;
      const pos = asPosition(obj.position);
      if (pos === null) continue;
      if (obj.controlled === true) {
        myUnits.push({ type: obj.unitType, pos, cargo: obj.cargo });
      } else {
        enemies.push(pos);
      }
    }

    if (enemies.length > 0) {
      enemyVisibleTicks += 1;
      if (core !== null) {
        const minDistance = Math.min(...enemies.map((enemy) => manhattan(core!, enemy)));
        const bucket =
          minDistance <= 5 ? "5" : minDistance <= 12 ? "12" : minDistance <= 20 ? "20" : minDistance <= 30 ? "30" : "31";
        distanceBuckets[bucket] += 1;
        if (minDistance <= 12) alertWindowTicks += 1;
      }
      const hasFullWorkerNearEnemy = myUnits.some(
        (unit) =>
          unit.type === "WORKER" &&
          (unit.cargo ?? 0) > 0 &&
          enemies.some((enemy) => manhattan(unit.pos, enemy) <= 2),
      );
      if (hasFullWorkerNearEnemy) clearPathWindowTicks += 1;
    }

    const events = parsed.after?.state?.events ?? [];
    eventTotal += events.length;
    for (const event of events) {
      if (event.eventType === "UNIT_MOVE_FAILED") moveFailed += 1;
    }
  }

  const ratio = (count: number): number => (ticks === 0 ? 0 : count / ticks);
  return {
    schema: "sim.variant-window.v1",
    tenant,
    caseCount: caseFiles.length,
    ticks,
    enemyVisibleRatio: ratio(enemyVisibleTicks),
    minEnemyDistanceBuckets: distanceBuckets,
    alertWindowRatio: ratio(alertWindowTicks),
    clearPathWindowRatio: ratio(clearPathWindowTicks),
    moveFailed: {
      count: moveFailed,
      total: eventTotal,
      ratio: eventTotal === 0 ? 0 : moveFailed / eventTotal,
    },
  };
}

function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
