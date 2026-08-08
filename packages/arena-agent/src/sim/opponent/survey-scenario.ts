/**
 * Survey Scenario — 真实测绘场景构造（2026-08-08）
 *
 * 从生产测绘库（data/runtime/survey/tN.db，tenant 观测的官方世界切片）导出
 * 真实资源点/障碍物，构造窗口化 1v1 场景。供 vs-arena / survey-match 共用。
 *
 * 真实性设计（对照真实机制）：
 * - 时间切片：测绘库是长时段内不同时刻矿的并集（矿被采空 → refill 再现），
 *   全表当场景起点会"复活历史矿"。只取最近 windowTicks 内目击过的矿。
 * - 状态过滤：默认仅最后目击 state=visible 的矿（观测终点仍有矿）；harvested
 *   格（采空）置信低，--keep-harvested 可保留。
 * - 多战区：各 tenant 在不同战区活动（同格互证样本≈0），每库 = 一个战区场景。
 */
import { DatabaseSync } from "node:sqlite";

export interface SurveyResource {
  readonly x: number;
  readonly y: number;
  readonly lastSeenTick: number;
  readonly state: string;
}

export interface SurveyObstacle {
  readonly x: number;
  readonly y: number;
}

export interface SurveyWindow {
  readonly x0: number;
  readonly y0: number;
}

export interface SurveySnapshot {
  readonly tenant: string;
  readonly resources: readonly SurveyResource[];
  readonly obstacles: readonly SurveyObstacle[];
  readonly maxSeenTick: number;
}

/** 从测绘库读取资源与障碍（tenant 视角观测）。时间切片 + 状态过滤防历史混杂。 */
export function readSurvey(
  dbPath: string,
  tenant: string,
  timeWindowTicks: number,
  keepHarvested: boolean,
): SurveySnapshot {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const maxSeenTick = Number(
      (db.prepare("SELECT MAX(last_seen_tick) AS m FROM resources").get() as { m: unknown }).m,
    );
    const floorTick = maxSeenTick - timeWindowTicks;
    const resources = db
      .prepare("SELECT x, y, last_seen_tick, state FROM resources WHERE last_seen_tick >= ?")
      .all(floorTick)
      .map((row) => ({
        x: Number((row as { x: unknown }).x),
        y: Number((row as { y: unknown }).y),
        lastSeenTick: Number((row as { last_seen_tick: unknown }).last_seen_tick),
        state: String((row as { state: unknown }).state),
      }))
      .filter((resource) => keepHarvested || resource.state === "visible");
    const obstacles = db
      .prepare("SELECT x, y FROM obstacles")
      .all()
      .map((row) => ({ x: Number((row as { x: unknown }).x), y: Number((row as { y: unknown }).y) }));
    return { tenant, resources, obstacles, maxSeenTick };
  } finally {
    db.close();
  }
}

export function inWindow(x0: number, y0: number, x: number, y: number): boolean {
  return x >= x0 && x < x0 + WINDOW_SIZE && y >= y0 && y < y0 + WINDOW_SIZE;
}

/** 窗口边长（格）：真实世界核心间距离远大于合成场景的 30 格，取 60 格窗口。 */
export const WINDOW_SIZE = 60;

/** 选矿最密集的窗口：以每个矿点为锚扫描 WINDOW_SIZE 正方窗，取窗口内矿数最多者。
 *  （重心锚对小样本失效——散点分布时重心窗口可能落空 0 矿。） */
export function pickWindow(resources: readonly SurveyResource[]): SurveyWindow {
  const half = Math.floor(WINDOW_SIZE / 2);
  let best = { x0: 0, y0: 0, count: -1 };
  for (const resource of resources) {
    const x0 = resource.x - half;
    const y0 = resource.y - half;
    let count = 0;
    for (const other of resources) {
      if (inWindow(x0, y0, other.x, other.y)) count += 1;
    }
    if (count > best.count) best = { x0, y0, count };
  }
  return { x0: best.x0, y0: best.y0 };
}

/** 由窗口切片构造 1v1 对打场景（窗口坐标系 0..WINDOW_SIZE，双方核心在两端）。
 *  opponentId 需与 runMatch 的对手 entry id 一致（场景 players 必须精确匹配）。 */
export function makeSurveyScenario(
  window: SurveyWindow,
  resourcesIn: readonly SurveyResource[],
  obstaclesIn: readonly SurveyObstacle[],
  seed: number,
  opponentId: string,
): unknown {
  const tx = (x: number): number => x - window.x0;
  const ty = (y: number): number => y - window.y0;
  const resources = resourcesIn.map((c) => [tx(c.x), ty(c.y)] as [number, number]);
  const obstacles = obstaclesIn.map((c) => [tx(c.x), ty(c.y)] as [number, number]);
  const coreY = Math.floor(WINDOW_SIZE / 2);
  return {
    rulesVersion: "v0.14",
    tick: 1,
    seed,
    players: [
      {
        id: "mine",
        username: "mine",
        resources: 25,
        core: {
          id: "491977e4-d3db-417b-8d82-2f5f3b5c8006",
          position: [2, coreY],
          hp: 5,
          shield: 5,
          state: "NORMAL",
          moveDirection: null,
          moveProgress: null,
          moveRequiredTicks: null,
          destination: null,
        },
        units: [
          { id: "22222222-0000-0000-0000-000000000000", position: [3, coreY], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-0000-0000-0000-000000000001", position: [2, coreY + 1], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-0000-0000-0000-000000000002", position: [1, coreY], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: opponentId,
        username: opponentId,
        resources: 25,
        core: {
          id: "9fe0ca6d-53cb-4dd5-a8f8-2e6925f19e72",
          position: [WINDOW_SIZE - 3, coreY],
          hp: 5,
          shield: 5,
          state: "NORMAL",
          moveDirection: null,
          moveProgress: null,
          moveRequiredTicks: null,
          destination: null,
        },
        units: [
          { id: "33333333-0000-0000-0000-000000000000", position: [WINDOW_SIZE - 4, coreY], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "33333333-0000-0000-0000-000000000001", position: [WINDOW_SIZE - 3, coreY + 1], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "33333333-0000-0000-0000-000000000002", position: [WINDOW_SIZE - 2, coreY], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles, resources },
    beacon: { position: [-100, -100], status: "GROUND", carrierId: null },
  };
}
