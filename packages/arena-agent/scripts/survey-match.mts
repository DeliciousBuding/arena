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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runMatch, type TournEntry } from "../src/sim/opponent/tournament.ts";
import {
  inWindow,
  makeSurveyScenario,
  pickWindow,
  readSurvey,
  WINDOW_SIZE,
} from "../src/sim/opponent/survey-scenario.ts";
import {
  OpponentAdapter,
  PersistentSubprocessDecider,
} from "../src/sim/opponent/opponent-adapter.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const TICKS = 200;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const COORDINATION_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..", "..", "..");
const FARMER_REPO = join(COORDINATION_ROOT, "reference", "third-party", "arena-hero-agent");
const SDK_REPO = join(COORDINATION_ROOT, "reference", "official", "arena-hero-python");
const SURVEY_DIR = join(COORDINATION_ROOT, "data", "runtime", "survey");
const OUT_DIR = join(COORDINATION_ROOT, "data", "runs", "sim", "survey-scene");

/** 时间切片参数：只取最近 N tick 目击过的矿（默认 5000，≈ max tick 的 7%）。 */
const WINDOW_ARG = process.argv.find((arg) => arg.startsWith("--window-ticks="));
const TIME_WINDOW_TICKS = WINDOW_ARG ? Number(WINDOW_ARG.slice("--window-ticks=".length)) : 5000;
/** 状态过滤：默认只取最后目击时 state=visible 的矿（观测终点仍有矿，最可信）；
 *  --keep-harvested 保留 harvested（最后目击时已采空——可能已被 refill，置信低）。 */
const KEEP_HARVESTED = process.argv.includes("--keep-harvested");
/** 多战区：--db t1,t2,t3,t4（默认 t1）。 */
const DB_ARG = process.argv.find((arg) => arg.startsWith("--db="));
const TENANTS = DB_ARG ? DB_ARG.slice("--db=".length).split(",") : ["t1"];

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
  const { resources, obstacles, maxSeenTick } = readSurvey(
    join(SURVEY_DIR, `${tenant}.db`),
    tenant,
    TIME_WINDOW_TICKS,
    KEEP_HARVESTED,
  );
  const anchor = pickWindow(resources);
  const window = { x0: anchor.x0, y0: anchor.y0 };
  const resourcesIn = resources.filter((c) => inWindow(window.x0, window.y0, c.x, c.y));
  const obstaclesIn = obstacles.filter((c) => inWindow(window.x0, window.y0, c.x, c.y));
  const states = new Map<string, number>();
  for (const resource of resourcesIn) {
    states.set(resource.state, (states.get(resource.state) ?? 0) + 1);
  }
  // M4-5：地形外扩 30 格重生环边距由 makeSurveyScenario 内部处理——这里传入
  // 全量切片；场景导出同时给出窗口内与边距后的地形规模。
  const exported = makeSurveyScenario(window, resources, obstacles, 1, "farmer-s1") as {
    terrain: { resources: unknown[]; obstacles: unknown[] };
  };
  writeFileSync(
    join(OUT_DIR, `survey-${tenant}-window.json`),
    JSON.stringify(exported, null, 1),
  );
  console.log(
    `战区 ${tenant}：切片 ${resources.length} 矿（tick ${maxSeenTick - TIME_WINDOW_TICKS}–${maxSeenTick}）` +
      `，窗口 x:[${window.x0},${window.x0 + WINDOW_SIZE}) y:[${window.y0},${window.y0 + WINDOW_SIZE})` +
      ` → 窗口内 ${resourcesIn.length} 矿 / ${obstaclesIn.length} 障碍` +
      `（含窗外 30 格边距：${exported.terrain.resources.length} 矿 / ${exported.terrain.obstacles.length} 障碍；` +
      `${[...states.entries()].map(([s, n]) => `${s}=${n}`).join(" ")}）`,
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
      scenario: makeSurveyScenario(window, resources, obstacles, seed, `farmer-s${seed}`),
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
