/**
 * 程序化场景分布校准（W53）——从 survey.db 实测分布拟合程序化生成器参数。
 *
 * 流程：
 *  1. 读 survey.db（data/runtime/survey/tN.db，默认 t1）计算真实分布：
 *     - per-chunk 障碍密度直方图（均值 + 标准差）
 *     - 障碍连通域大小分布（均值 + 最大值 + 直方图）
 *     - 资源空置率（0 资源 chunk 占比）
 *  2. 扫程序化生成器参数空间（obstacleDensity × clusterMaxSize × vacancyRate），
 *     每组用固定 seed 生成地形，算同一组指标，按归一化距离平方和选最接近的。
 *  3. 输出校准后的默认参数（JSON），可塞进 ProceduralWorldParams。
 *
 * 用法：
 *   cd packages/arena-agent && npx tsx scripts/calibrate-scenario-distribution.mts [--tenant t1] [--seed 1] [--data-root <path>]
 *
 * 真实性约束：survey.db 是长时段观测并集（矿被采空 → refill 再现），
 * 障碍是稳定的（地形不随时间变），资源需取最后目击 state=visible 的点。
 */
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { cellKey, type Position } from "../src/domain/model.ts";
import {
  generateProceduralTerrain,
  DEFAULT_PROCEDURAL_PARAMS,
  type ProceduralWorldParams,
} from "../src/sim/world/procedural.ts";
import { CHUNK_SIZE, chunkOf } from "../src/sim/world/chunks.ts";

interface CliArgs {
  tenant: string;
  seed: number;
  dataRoot: string | undefined;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const tenant = get("--tenant") ?? process.env.ARENA_SURVEY_TENANT ?? "t1";
  const seedStr = get("--seed") ?? process.env.ARENA_CALIB_SEED ?? "1";
  const seed = Number.parseInt(seedStr, 10);
  if (!Number.isFinite(seed) || seed < 0) {
    throw new Error(`invalid --seed: ${seedStr}`);
  }
  const dataRoot = get("--data-root") ?? process.env.ARENA_DATA_ROOT;
  return { tenant, seed, dataRoot };
}

function resolveSurveyDbPath(dataRoot: string | undefined, tenant: string): string {
  // data-root 优先（绝对或相对 cwd）；缺省回退 arena-ts 同级 data/
  // （与 src/app/data-root.ts 的 sibling ../data 策略一致：
  //   arena-ts/../data/runtime/survey/tN.db）。
  // packages/arena-agent/scripts → 上 4 级到 arena 根 → data/runtime/survey。
  if (dataRoot !== undefined) {
    return resolve(dataRoot, "runtime", "survey", `${tenant}.db`);
  }
  const scriptDir = fileURLToPath(new URL(".", import.meta.url));
  return resolve(scriptDir, "..", "..", "..", "..", "data", "runtime", "survey", `${tenant}.db`);
}

interface RealSurveyData {
  readonly resources: readonly Position[];
  readonly obstacles: readonly Position[];
}

function readSurveyData(dbPath: string): RealSurveyData {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const resources = db
      .prepare("SELECT x, y, state FROM resources WHERE state = 'visible'")
      .all()
      .map((row) => {
        const x = Number((row as { x: unknown }).x);
        const y = Number((row as { y: unknown }).y);
        return [x, y] as Position;
      });
    const obstacles = db
      .prepare("SELECT x, y FROM obstacles")
      .all()
      .map((row) => {
        const x = Number((row as { x: unknown }).x);
        const y = Number((row as { y: unknown }).y);
        return [x, y] as Position;
      });
    return { resources, obstacles };
  } finally {
    db.close();
  }
}

/** chunk 内非主干格数（32×32 - 十字主干 63 格 = 961）。主干 = local x=0 或 y=0。 */
const CHUNK_NON_BACKBONE_CELLS = CHUNK_SIZE * CHUNK_SIZE - (CHUNK_SIZE + CHUNK_SIZE - 1);

interface DistributionMetrics {
  readonly obstacleDensityMean: number;
  readonly obstacleDensityStd: number;
  readonly componentSizeMean: number;
  readonly componentSizeMax: number;
  readonly vacancyRate: number;
}

/** 计算一组 cells 的分布指标（障碍 + 资源共用同一度量）。 */
function computeMetrics(
  obstacles: readonly Position[],
  resources: readonly Position[],
): DistributionMetrics {
  // ---- per-chunk 障碍密度 ----
  const obstacleByChunk = new Map<string, number>();
  for (const [x, y] of obstacles) {
    const [cx, cy] = chunkOf(x, y);
    const key = `${cx},${cy}`;
    obstacleByChunk.set(key, (obstacleByChunk.get(key) ?? 0) + 1);
  }
  const densitySamples: number[] = [];
  for (const [, count] of obstacleByChunk) {
    densitySamples.push(count / CHUNK_NON_BACKBONE_CELLS);
  }
  const obstacleDensityMean = densitySamples.length > 0
    ? densitySamples.reduce((a, b) => a + b, 0) / densitySamples.length
    : 0;
  const variance = densitySamples.length > 0
    ? densitySamples.reduce((sum, v) => sum + (v - obstacleDensityMean) ** 2, 0) / densitySamples.length
    : 0;
  const obstacleDensityStd = Math.sqrt(variance);

  // ---- 连通域大小分布（4-邻接 BFS）----
  const obstacleSet = new Set(obstacles.map((p) => cellKey(p)));
  const positionByKey = new Map(obstacles.map((p) => [cellKey(p), p] as const));
  const visited = new Set<string>();
  const componentSizes: number[] = [];
  for (const start of obstacles) {
    const startKey = cellKey(start);
    if (visited.has(startKey)) continue;
    const queue: Position[] = [start];
    visited.add(startKey);
    let size = 0;
    while (queue.length > 0) {
      const [cx, cy] = queue.shift()!;
      size += 1;
      const neighbors: readonly [number, number][] = [
        [cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1],
      ];
      for (const [nx, ny] of neighbors) {
        const nkey = cellKey([nx, ny]);
        if (visited.has(nkey) || !obstacleSet.has(nkey)) continue;
        visited.add(nkey);
        queue.push(positionByKey.get(nkey)!);
      }
    }
    componentSizes.push(size);
  }
  const componentSizeMean = componentSizes.length > 0
    ? componentSizes.reduce((a, b) => a + b, 0) / componentSizes.length
    : 0;
  const componentSizeMax = componentSizes.length > 0 ? Math.max(...componentSizes) : 0;

  // ---- 资源空置率：0 资源 chunk 占比（分母 = 含障碍或资源的 chunk 全集）----
  const resourceByChunk = new Set<string>();
  for (const [x, y] of resources) {
    const [cx, cy] = chunkOf(x, y);
    resourceByChunk.add(`${cx},${cy}`);
  }
  const allChunks = new Set<string>([...obstacleByChunk.keys(), ...resourceByChunk]);
  let vacantChunks = 0;
  for (const key of allChunks) {
    if (!resourceByChunk.has(key)) vacantChunks += 1;
  }
  const vacancyRate = allChunks.size > 0 ? vacantChunks / allChunks.size : 0;

  return {
    obstacleDensityMean,
    obstacleDensityStd,
    componentSizeMean,
    componentSizeMax,
    vacancyRate,
  };
}

/** 归一化距离平方和（越小越接近）。各维度按经验范围归一化防量纲失衡。 */
function distanceSquared(real: DistributionMetrics, candidate: DistributionMetrics): number {
  const densityRange = 0.30; // 密度经验波动范围 ~0-30%
  const componentMeanRange = 4; // 连通域均值经验范围 ~1-5
  const componentMaxRange = 20; // 连通域最大值经验范围 ~1-20
  const vacancyRange = 0.50; // 空置率范围 ~0-50%
  const dDensity = (real.obstacleDensityMean - candidate.obstacleDensityMean) / densityRange;
  const dCompMean = (real.componentSizeMean - candidate.componentSizeMean) / componentMeanRange;
  const dCompMax = (real.componentSizeMax - candidate.componentSizeMax) / componentMaxRange;
  const dVacancy = (real.vacancyRate - candidate.vacancyRate) / vacancyRange;
  return dDensity * dDensity + dCompMean * dCompMean + dCompMax * dCompMax + dVacancy * dVacancy;
}

interface CandidateResult {
  readonly params: ProceduralWorldParams;
  readonly metrics: DistributionMetrics;
  readonly distance: number;
}

function scanParameterSpace(
  realMetrics: DistributionMetrics,
  seed: number,
): CandidateResult {
  const densities = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50];
  const clusterMaxSizes = [8, 10, 12, 14, 16];
  const vacancyRates = [0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50];
  let best: CandidateResult | null = null;
  let evaluated = 0;
  for (const obstacleDensity of densities) {
    for (const clusterMaxSize of clusterMaxSizes) {
      for (const vacancyRate of vacancyRates) {
        const params: ProceduralWorldParams = {
          obstacleDensity,
          clusterMaxSize,
          vacancyRate,
          chunkRange: DEFAULT_PROCEDURAL_PARAMS.chunkRange,
        };
        const terrain = generateProceduralTerrain(params, seed);
        const metrics = computeMetrics(terrain.obstacles, terrain.resources);
        const distance = distanceSquared(realMetrics, metrics);
        evaluated += 1;
        const result: CandidateResult = { params, metrics, distance };
        if (best === null || result.distance < best.distance) best = result;
      }
    }
  }
  if (best === null) throw new Error("parameter scan produced no candidates");
  return best;
}

function formatMetrics(label: string, metrics: DistributionMetrics): string {
  return [
    `${label}:`,
    `  obstacle density  mean=${(metrics.obstacleDensityMean * 100).toFixed(2)}%  std=${(metrics.obstacleDensityStd * 100).toFixed(2)}%`,
    `  component size    mean=${metrics.componentSizeMean.toFixed(2)}  max=${metrics.componentSizeMax}`,
    `  vacancy rate      ${(metrics.vacancyRate * 100).toFixed(2)}%`,
  ].join("\n");
}

function main(): void {
  const args = parseArgs(process.argv);
  const dbPath = resolveSurveyDbPath(args.dataRoot, args.tenant);
  console.log(`W53 程序化场景分布校准`);
  console.log(`survey.db: ${dbPath}`);
  console.log(`scan seed: ${args.seed}`);
  console.log("=".repeat(72));

  const survey = readSurveyData(dbPath);
  console.log(`survey 读取：obstacles=${survey.obstacles.length}  resources(visible)=${survey.resources.length}`);

  const realMetrics = computeMetrics(survey.obstacles, survey.resources);
  console.log(formatMetrics("real (survey)", realMetrics));
  console.log("-".repeat(72));

  const best = scanParameterSpace(realMetrics, args.seed);
  console.log(formatMetrics("best procedural candidate", best.metrics));
  console.log(`distance² = ${best.distance.toFixed(5)}`);
  console.log("-".repeat(72));

  const calibrated = {
    obstacleDensity: best.params.obstacleDensity,
    clusterMaxSize: best.params.clusterMaxSize,
    vacancyRate: best.params.vacancyRate,
    chunkRange: best.params.chunkRange ?? DEFAULT_PROCEDURAL_PARAMS.chunkRange,
  };
  console.log("校准后的默认参数（ProceduralWorldParams）：");
  console.log(JSON.stringify(calibrated, null, 2));
  console.log("");
  console.log("用法：runMatch(a, b, seed, ticks, rulesPath, { procedural: <above> })");
}

main();
