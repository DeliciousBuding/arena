/**
 * survey-match — 真实测绘地图对局（2026-08-08）
 *
 * 从生产测绘库（data/runtime/survey/tN.db，各 tenant 观测的官方世界切片）导出
 * 真实资源点/障碍物，取资源密集窗口构造 1v1 场景，跑 vs arena_farmer 矩阵。
 *
 * 多战区（--db）：t1/t2/t3/t4 各 tenant 在不同战区活动（同格矿仅 2 个，无互证
 * 样本），每库代表一个真实战区。默认只跑 t1；传 --db t1,t2,t3,t4 跨全部战区
 * 评测（避免"只在单个战区评测"的偏差），输出分战区 + 汇总。
 *
 * 时间切片（避免"历史混杂"）：测绘库是 1.6 万 tick 内不同时刻存在的矿的并集
 * （矿被采空后 refill 会在同格或他处再现，last_seen_tick 各异）。全表当场景
 * 起点会把历史矿全部复活。--window-ticks 只取最近 N tick 内目击过的矿。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/survey-match.mts
 *       [--db t1,t2,t3,t4] [--window-ticks 5000] [--keep-harvested]
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runMatch, type TournEntry } from "../src/sim/opponent/tournament.ts";
import {
  OpponentAdapter,
  PersistentSubprocessDecider,
} from "../src/sim/opponent/opponent-adapter.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const TICKS = 200;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const COORDINATION_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..", "..", "..");
const FARMER_REPO = join(COORDINATION_ROOT, "reference", "arena-hero-agent");
const SDK_REPO = join(COORDINATION_ROOT, "reference", "arena-hero-python");
const SURVEY_DIR = join(COORDINATION_ROOT, "data", "runtime", "survey");
const OUT_DIR = join(COORDINATION_ROOT, "data", "runs", "sim", "survey-scene");

/** 窗口边长（格）：真实世界核心间距离远大于合成场景的 30 格，取 60 格窗口。 */
const WINDOW_SIZE = 60;

/** 时间切片参数：只取最近 N tick 目击过的矿（默认 5000，≈ max tick 的 7%）。 */
const WINDOW_ARG = process.argv.find((arg) => arg.startsWith("--window-ticks="));
const TIME_WINDOW_TICKS = WINDOW_ARG ? Number(WINDOW_ARG.slice("--window-ticks=".length)) : 5000;
/** 状态过滤：默认只取最后目击时 state=visible 的矿（观测终点仍有矿，最可信）；
 *  --keep-harvested 保留 harvested（最后目击时已采空——可能已被 refill，置信低）。 */
const KEEP_HARVESTED = process.argv.includes("--keep-harvested");
/** 多战区：--db t1,t2,t3,t4（默认 t1）。 */
const DB_ARG = process.argv.find((arg) => arg.startsWith("--db="));
const TENANTS = DB_ARG ? DB_ARG.slice("--db=".length).split(",") : ["t1"];

interface SurveyResource {
  readonly x: number;
  readonly y: number;
  readonly lastSeenTick: number;
  readonly state: string;
}

interface SurveyObstacle {
  readonly x: number;
  readonly y: number;
}

/** 从指定测绘库读取资源与障碍（tenant 视角观测）。时间切片：只取最近
 *  TIME_WINDOW_TICKS 内目击过的矿（防历史混杂——矿被采空/refill 再现，
 *  旧目击不代表当前存在）。 */
function readSurvey(tenant: string): {
  readonly resources: readonly SurveyResource[];
  readonly obstacles: readonly SurveyObstacle[];
  readonly maxSeenTick: number;
} {
  const db = new DatabaseSync(join(SURVEY_DIR, `${tenant}.db`), { readOnly: true });
  try {
    const maxSeenTick = Number(
      (db.prepare("SELECT MAX(last_seen_tick) AS m FROM resources").get() as { m: unknown }).m,
    );
    const floorTick = maxSeenTick - TIME_WINDOW_TICKS;
    const resources = db
      .prepare("SELECT x, y, last_seen_tick, state FROM resources WHERE last_seen_tick >= ?")
      .all(floorTick)
      .map((row) => ({
        x: Number((row as { x: unknown }).x),
        y: Number((row as { y: unknown }).y),
        lastSeenTick: Number((row as { last_seen_tick: unknown }).last_seen_tick),
        state: String((row as { state: unknown }).state),
      }))
      .filter((resource) => KEEP_HARVESTED || resource.state === "visible");
    const obstacles = db
      .prepare("SELECT x, y FROM obstacles")
      .all()
      .map((row) => ({ x: Number((row as { x: unknown }).x), y: Number((row as { y: unknown }).y) }));
    return { resources, obstacles, maxSeenTick };
  } finally {
    db.close();
  }
}

/** 选矿最密集的窗口：以每个矿点为锚扫描 WINDOW_SIZE 正方窗，取窗口内矿数最多者。
 *  （重心锚对小样本失效——t4 切片 14 矿分布散，重心窗口落空 0 矿。） */
function pickWindow(resources: readonly SurveyResource[]): { readonly x0: number; readonly y0: number } {
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

function inWindow(x0: number, y0: number, x: number, y: number): boolean {
  return x >= x0 && x < x0 + WINDOW_SIZE && y >= y0 && y < y0 + WINDOW_SIZE;
}

function makeSurveyScenario(
  window: { readonly x0: number; readonly y0: number },
  resourcesIn: readonly SurveyResource[],
  obstaclesIn: readonly SurveyObstacle[],
  seed: number,
): unknown {
  // 窗口坐标系：把真实坐标平移为 0..WINDOW_SIZE
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
        id: `farmer-s${seed}`,
        username: `farmer-s${seed}`,
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

const ours: TournEntry = {
  id: "mine",
  desc: "my safety aggressive",
  build: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", attackForce: 2 }),
};

function farmerEntry(seed: number): TournEntry {
  const slotDir = join(tmpdir(), "arena-survey-match");
  mkdirSync(slotDir, { recursive: true });
  return {
    id: `farmer-s${seed}`,
    desc: "arena_farmer",
    build: () => {
      const decider = new PersistentSubprocessDecider({
        farmerRepoDir: FARMER_REPO,
        sdkRepoDir: SDK_REPO,
        farmerPath: join(FARMER_REPO, "arena_farmer.py"),
        stateSlot: join(slotDir, `slot-${seed}-${randomUUID()}.pkl`),
      });
      return new OpponentAdapter(decider, `farmer-s${seed}`, "farmer");
    },
  };
}

const wallStart = performance.now();
const totalWins = { n: 0 };
const totalFarmerWins = { n: 0 };
const totalMatches = { n: 0 };
mkdirSync(OUT_DIR, { recursive: true });

for (const tenant of TENANTS) {
  const { resources, obstacles, maxSeenTick } = readSurvey(tenant);
  const anchor = pickWindow(resources);
  const window = { x0: anchor.x0, y0: anchor.y0 };
  const resourcesIn = resources.filter((c) => inWindow(window.x0, window.y0, c.x, c.y));
  const obstaclesIn = obstacles.filter((c) => inWindow(window.x0, window.y0, c.x, c.y));
  const states = new Map<string, number>();
  for (const resource of resourcesIn) {
    states.set(resource.state, (states.get(resource.state) ?? 0) + 1);
  }
  writeFileSync(
    join(OUT_DIR, `survey-${tenant}-window.json`),
    JSON.stringify(makeSurveyScenario(window, resourcesIn, obstaclesIn, 1), null, 1),
  );
  console.log(
    `战区 ${tenant}：切片 ${resources.length} 矿（tick ${maxSeenTick - TIME_WINDOW_TICKS}–${maxSeenTick}）` +
      `，窗口 x:[${window.x0},${window.x0 + WINDOW_SIZE}) y:[${window.y0},${window.y0 + WINDOW_SIZE})` +
      ` → 窗口内 ${resourcesIn.length} 矿 / ${obstaclesIn.length} 障碍（${[...states.entries()].map(([s, n]) => `${s}=${n}`).join(" ")}）`,
  );

  const wins = { n: 0 };
  const farmerWins = { n: 0 };
  const myResources: number[] = [];
  const farmerResources: number[] = [];
  for (const seed of SEEDS) {
    const farmer = farmerEntry(seed);
    const result = runMatch(ours, farmer, seed, TICKS, MANIFEST_PATH, {
      validatePlans: false,
      refillEveryTicks: 65,
      scenario: makeSurveyScenario(window, resourcesIn, obstaclesIn, seed),
    });
    if (result.winner === ours.id) wins.n += 1;
    else if (result.winner === farmer.id) farmerWins.n += 1;
    myResources.push(result.finalResources[ours.id]);
    farmerResources.push(result.finalResources[farmer.id]);
    totalWins.n += result.winner === ours.id ? 1 : 0;
    totalFarmerWins.n += result.winner === farmer.id ? 1 : 0;
    totalMatches.n += 1;
  }
  const mean = (values: number[]): string => (values.reduce((s, v) => s + v, 0) / values.length).toFixed(1);
  console.log(
    `  战区 ${tenant} 汇总：我胜率=${(wins.n / SEEDS.length) * 100}%  farmer=${(farmerWins.n / SEEDS.length) * 100}%` +
      ` | 我均资源=${mean(myResources)}  farmer均资源=${mean(farmerResources)}`,
  );
}

const wallSec = (performance.now() - wallStart) / 1000;
console.log("=".repeat(96));
if (TENANTS.length > 1) {
  console.log(
    `跨 ${TENANTS.length} 战区汇总（${totalMatches.n} 局）：我胜率=${((totalWins.n / totalMatches.n) * 100).toFixed(1)}%` +
      `  farmer=${((totalFarmerWins.n / totalMatches.n) * 100).toFixed(1)}%  耗时 ${wallSec.toFixed(1)}s`,
  );
}
console.log(`场景导出：${join(OUT_DIR, "survey-*-window.json")}`);
