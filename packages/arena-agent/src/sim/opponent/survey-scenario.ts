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
import { cellKey } from "../../domain/model.ts";

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

/**
 * 重生环外扩边距（M4-5）：官方重生候选在距核心 20-30 Manhattan 环带，而
 * survey 场景双方核心位于窗口内缘（x=2 / x=WINDOW_SIZE-3）——若地形只映射
 * 窗口内，环带大半落在窗外"无障碍/无资源"的空白区，重生位置失真（官方窗外
 * 是程序化障碍密布的连续网格）。外扩 30 格（= 重生环最大半径）把环带内的
 * 障碍/资源纳入场景地形。
 */
export const RESPAWN_RING_MARGIN = 30;

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

/** 信标落点（M4-2）：survey 场景平移窗口中心 [WINDOW_SIZE/2, coreY]（= 双方
 *  核心 [2,coreY]/[WINDOW_SIZE-3,coreY] 的几何中心，距两核 28/27，均 > 视野 5，
 *  开局不可见）。官方语义信标路径恒 EMPTY（无障碍）——若中心恰是障碍格，
 *  按确定性曼哈顿螺旋取最近的窗口内非障碍格。 */
function beaconGroundPosition(obstacles: readonly (readonly [number, number])[]): [number, number] {
  const obstacleKeys = new Set(obstacles.map(([x, y]) => cellKey([x, y])));
  const center: [number, number] = [Math.floor(WINDOW_SIZE / 2), Math.floor(WINDOW_SIZE / 2)];
  if (!obstacleKeys.has(cellKey(center))) return center;
  for (let radius = 1; radius <= WINDOW_SIZE; radius += 1) {
    for (const [dx, dy] of BEACON_SCAN_DIRECTIONS) {
      const candidate: [number, number] = [center[0] + dx * radius, center[1] + dy * radius];
      if (candidate[0] < 0 || candidate[0] >= WINDOW_SIZE) continue;
      if (candidate[1] < 0 || candidate[1] >= WINDOW_SIZE) continue;
      if (!obstacleKeys.has(cellKey(candidate))) return candidate;
    }
  }
  return center;
}

/** 信标回退扫描的 4 个主轴方向（曼哈顿螺旋逐圈）。 */
const BEACON_SCAN_DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

/** 由窗口切片构造 1v1 对打场景（窗口坐标系 0..WINDOW_SIZE，双方核心在两端）。
 *  opponentId 需与 runMatch 的对手 entry id 一致（场景 players 必须精确匹配）。
 *  M4-3：起点 = 官方 5 资源 + 1 worker（worker 取原 3 位置首格）。
 *  M4-5：地形映射外扩 RESPAWN_RING_MARGIN=30 格——官方重生候选在核心 20-30
 *  环带，外扩边距让环带内的障碍/资源仍进入场景（窗外不是"无障碍空白区"）。 */
export function makeSurveyScenario(
  window: SurveyWindow,
  resourcesIn: readonly SurveyResource[],
  obstaclesIn: readonly SurveyObstacle[],
  seed: number,
  opponentId: string,
): unknown {
  const tx = (x: number): number => x - window.x0;
  const ty = (y: number): number => y - window.y0;
  const inExpanded = (x: number, y: number): boolean =>
    x >= window.x0 - RESPAWN_RING_MARGIN &&
    x < window.x0 + WINDOW_SIZE + RESPAWN_RING_MARGIN &&
    y >= window.y0 - RESPAWN_RING_MARGIN &&
    y < window.y0 + WINDOW_SIZE + RESPAWN_RING_MARGIN;
  const resources = resourcesIn
    .filter((c) => inExpanded(c.x, c.y))
    .map((c) => [tx(c.x), ty(c.y)] as [number, number]);
  const obstacles = obstaclesIn
    .filter((c) => inExpanded(c.x, c.y))
    .map((c) => [tx(c.x), ty(c.y)] as [number, number]);
  const coreY = Math.floor(WINDOW_SIZE / 2);
  return {
    rulesVersion: "v0.14",
    tick: 1,
    seed,
    players: [
      {
        id: "mine",
        username: "mine",
        resources: 5,
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
        ],
      },
      {
        id: opponentId,
        username: opponentId,
        resources: 5,
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
        ],
      },
    ],
    terrain: { obstacles, resources },
    beacon: { position: beaconGroundPosition(obstacles), status: "GROUND", carrierId: null },
  };
}
