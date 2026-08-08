/**
 * W52 — 遗传算法搜索器（MacroPolicy 5 维 × vs-arena × holdout）。
 *
 * 移植 reference `arena-evolve/evolve/ga.py` 的 GA 类骨架（init_population /
 * _evaluate_all / next_generation / _tournament / _mutate / _genome_key / eval
 * cache），但搜索空间从 reference 的 13 维 GENES（worker_ratio/flee_hp/...）
 * 替换为生产 MacroPolicy 的 5 维：
 *   - posture（枚举：harvest/balanced/aggressive）
 *   - workerTarget（整数 1-16）
 *   - militaryRatio（浮点 0-1，生产由 militaryRatioEnabled 接线消费）
 *   - focusOffset（[-32,32]² 整数对或 null——相对被测者 Core 的偏移，生产由
 *     maxFocusDistance=32 截断；绝对坐标在 vs-arena slot 轮换下每 seed 不同，
 *     故搜索相对偏移、评估期换算成绝对 focusRegion）
 *   - attackPriority（枚举：core/workers/null）
 *
 * 评估对象 = 被测者（SUBJECT）在 spawn-profile 对局（W54 真实开局）中的
 * W51 fitness（fitness_from_detail 多目标评分）。holdout 独立种子复评冠军
 * 防过拟合；seed_pool 滚动让选择压力持续面对新地图；risk_lambda 风险调整
 * 惩罚"偶尔爆高、经常崩盘"的策略。并行用 worker_threads 池（reference 用
 * multiprocessing.Pool）——runEpisode 纯函数、SafetyPlanner 每代每个体 new
 * 一个（plannerFactory 已保证），worker 间无共享可变状态。
 *
 * 硬约束（用户裁决 2026-08-09）：
 *  1. runEpisode 纯函数可并行；SafetyPlanner 有状态——plannerFactory 每集
 *     每租户新建，worker 各自构造，零跨线程共享。
 *  2. focusRegion 生产被 maxFocusDistance=32 截断——搜索空间显式约束到
 *     [-32,32]² 相对偏移，评估期换算绝对坐标时由 SafetyPlanner 自然截断。
 *  3. champion 可能过拟合 eval_seeds——必须 holdout + seed_pool 滚动。
 *  4. vs-arena 评估需对手池——sim/opponent/spawn-profile.ts 已搭好。
 */

import { performance } from "node:perf_hooks";
import {
  Worker,
  isMainThread,
  workerData,
  parentPort,
} from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runEpisode } from "../../sim/harness/episode.ts";
import type { EpisodeResult, EpisodeTenant } from "../../sim/harness/episode.ts";
import { evaluateMultiSeed } from "./fitness.ts";
import type { FitnessDetail } from "./fitness.ts";
import type {
  AttackPriority,
  MacroPolicy,
  PolicyPosture,
} from "../../runtime/macro-policy.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../../strategies/safety-planner.ts";
import type { SafetyPlannerConfig } from "../../strategies/safety-planner-config.ts";
import {
  buildSpawnScenario,
  NoOpPlanner,
  rolesFor,
  SPAWN_SITES,
} from "../../sim/opponent/spawn-profile.ts";
import type { SpawnParticipant } from "../../sim/opponent/spawn-profile.ts";
import type { PlanProvider } from "../../runtime/decision-types.ts";

/**
 * 规则文件路径——相对 ga.ts 模块位置解析（cwd 无关），worker 线程同样可用。
 * ga.ts 在 `src/offline-learning/eval/`，规则在 `src/sim/contracts/`。
 */
export const GA_MANIFEST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "sim",
  "contracts",
  "rules-v0.14.json",
);

/** maxFocusDistance 生产值（SafetyPlanner-config.ts 默认 32）。 */
const MAX_FOCUS_DISTANCE = 32;

/** 被测者 id（与 vs-arena-spawn 一致）。 */
const SUBJECT_ID = "subject";

// ──────────────────────────────────────────────────────────────────────
// 搜索空间（Genome）
// ──────────────────────────────────────────────────────────────────────

/**
 * MacroPolicy 5 维基因组。focusOffset 是相对被测者 Core 的整数偏移
 * （[-32,32]² 或 null），评估期换算为绝对 focusRegion——vs-arena slot
 * 轮换使被测者 Core 每 seed 站点不同，搜索相对偏移才能跨 seed 一致生效。
 */
export interface MacroGenome {
  readonly posture: PolicyPosture;
  readonly workerTarget: number;
  readonly militaryRatio: number;
  readonly focusOffset: readonly [number, number] | null;
  readonly attackPriority: AttackPriority;
}

/** 默认基因组（对齐 DEFAULT_MACRO_POLICY）。 */
export const DEFAULT_MACRO_GENOME: MacroGenome = Object.freeze({
  posture: "balanced",
  workerTarget: 8,
  militaryRatio: 0.4,
  focusOffset: null,
  attackPriority: null,
});

const POSTURES: readonly PolicyPosture[] = ["harvest", "balanced", "aggressive"];
const ATTACK_PRIORITIES: readonly AttackPriority[] = ["core", "workers", null];

/** 基因维度的值域描述（reference gene_bounds 等价）。 */
export interface GeneBound {
  readonly name: "posture" | "workerTarget" | "militaryRatio" | "focusOffset" | "attackPriority";
  readonly kind: "enum" | "int" | "float" | "offset2d";
  readonly lo?: number;
  readonly hi?: number;
  readonly choices?: readonly unknown[];
}

export const GENE_BOUNDS: readonly GeneBound[] = [
  { name: "posture", kind: "enum", choices: POSTURES },
  { name: "workerTarget", kind: "int", lo: 1, hi: 16 },
  { name: "militaryRatio", kind: "float", lo: 0, hi: 1 },
  { name: "focusOffset", kind: "offset2d", lo: -MAX_FOCUS_DISTANCE, hi: MAX_FOCUS_DISTANCE },
  { name: "attackPriority", kind: "enum", choices: ATTACK_PRIORITIES },
];

// ──────────────────────────────────────────────────────────────────────
// 评估器（被测者在 spawn-profile 对局中的 fitness）
// ──────────────────────────────────────────────────────────────────────

/** 单个体评估结果。 */
export interface EvalResult {
  readonly fitness: number;
  readonly detail: FitnessDetail;
  /**
   * 对局总战斗伤害（所有玩家 damageDealt 之和，多种子平均）——仅作"有无战斗"
   * 诊断指标，不进 fitness 公式。被测者（newborn 1W/5res）在 50 tick 烟雾内
   * 通常造不出军事单位（VANGUARD=10/RANGER=12），故 detail.damage 恒为 0；
   * 但 OLD 对手会用 SafetyPlanner aggressive 互相交战——本字段暴露该战斗信号，
   * 使烟雾输出能验证"有战斗"（用户裁决 2026-08-09 damage>0 验证要求）。
   */
  readonly combatDamage?: number;
}

/**
 * 单个体评估器：给定基因 + 种子列表，返回 (fitness, detail)。
 * 纯函数语义（无跨调用可变状态）——可串行可并行（worker_threads）。
 */
export type IndividualEvaluator = (
  genome: MacroGenome,
  seeds: readonly number[],
) => Promise<EvalResult> | EvalResult;

/** spawn-profile 评估场景的可序列化配置（worker_threads 间传递）。 */
export interface SpawnProfileEvalSpec {
  readonly kind: "spawn-profile";
  readonly manifestPath: string;
  readonly ticks: number;
  readonly numPlayers: number;
  /** refill 节奏：null=关、N=每 N tick 补矿。 */
  readonly refillEveryTicks: number | null;
  /** 被测者 SafetyPlanner 配置覆盖（militaryRatioEnabled 自动置 true）。 */
  readonly subjectPlannerConfig: Partial<SafetyPlannerConfig>;
  /** 对手（OLD_BALANCED/OLD_AGGRESSIVE）SafetyPlanner 配置覆盖。 */
  readonly opponentPlannerConfig: Partial<SafetyPlannerConfig>;
}

/**
 * 构造 spawn-profile 评估器（vs-arena 真实开局：被测者 1W/5res 开局，
 * 老玩家带兵、弃坑残骸挂机、新生弱号）。每 seed 重建 participants +
 * scenario + tenants + planners（SafetyPlanner 每 episode new 一个，
 * 满足硬约束#1）。返回的函数可串行调用，也可在 worker 内运行。
 */
export function createSpawnProfileEvaluator(spec: SpawnProfileEvalSpec): IndividualEvaluator {
  const participants = buildParticipants(spec.numPlayers);
  const mySlot = 0;
  return (genome: MacroGenome, seeds: readonly number[]): EvalResult => {
    const runs: { result: EpisodeResult; playerId: string }[] = [];
    /** 累计每局所有玩家 damageDealt 之和——对局总战斗量诊断指标
     *  （不进 fitness，仅供"有战斗"验证；被测者 newborn 50tick 内造不出
     *  军事单位，detail.damage 恒 0，但 OLD 对手互相交战的伤害在此暴露）。 */
    let combatDamageSum = 0;
    for (const seed of seeds) {
      const { scenario, rotatedSlot } = buildSpawnScenario(participants, mySlot, seed);
      const subjectCorePos = SPAWN_SITES[rotatedSlot] ?? ([0, 0] as const);
      const focusRegion =
        genome.focusOffset === null
          ? null
          : ([
              subjectCorePos[0] + genome.focusOffset[0],
              subjectCorePos[1] + genome.focusOffset[1],
            ] as readonly [number, number]);
      const subjectPolicy: MacroPolicy = {
        posture: genome.posture,
        workerTarget: genome.workerTarget,
        militaryRatio: genome.militaryRatio,
        focusRegion,
        attackPriority: genome.attackPriority,
      };
      const result = runSpawnEpisode(spec, scenario, participants, mySlot, subjectPolicy);
      runs.push({ result, playerId: SUBJECT_ID });
      for (const ledger of Object.values(result.metrics.perPlayer)) {
        combatDamageSum += ledger.damageDealt;
      }
    }
    const evaluated = evaluateMultiSeed(runs, spec.ticks);
    return {
      fitness: evaluated.fitness,
      detail: evaluated.detail,
      combatDamage: seeds.length === 0 ? 0 : combatDamageSum / seeds.length,
    };
  };
}

/** 构造 participants：被测者（SUBJECT）+ 对手（按 rolesFor 分配角色）。 */
function buildParticipants(numPlayers: number): SpawnParticipant[] {
  const roles = rolesFor(numPlayers);
  const participants: SpawnParticipant[] = [
    { id: SUBJECT_ID, username: "subject (me)", role: "SUBJECT" },
  ];
  for (let i = 0; i < roles.length; i += 1) {
    const role = roles[i]!;
    participants.push({
      id: `opp-${role.toLowerCase()}-${i}`,
      username: `opp ${role} #${i}`,
      role,
    });
  }
  return participants;
}

/** 跑一局 spawn-profile 对局（被测者注入 genome 派生的 MacroPolicy）。 */
function runSpawnEpisode(
  spec: SpawnProfileEvalSpec,
  scenario: unknown,
  participants: readonly SpawnParticipant[],
  mySlot: number,
  subjectPolicy: MacroPolicy,
): EpisodeResult {
  const opponentPolicy: MacroPolicy = {
    posture: "aggressive",
    workerTarget: 8,
    militaryRatio: 0.4,
    focusRegion: null,
    attackPriority: "core",
  };
  const tenants: EpisodeTenant[] = participants.map((participant) => ({
    id: participant.id,
    planner: "safety" as const,
    plannerConfig:
      participant.role === "SUBJECT"
        ? { ...spec.subjectPlannerConfig, militaryRatioEnabled: true }
        : participant.role === "STATIC" || participant.role === "NEW_WEAK"
          ? {}
          : { ...spec.opponentPlannerConfig },
    policy: participant.role === "SUBJECT" ? subjectPolicy : opponentPolicy,
  }));
  const plannerFactory = (tenant: EpisodeTenant): PlanProvider => {
    const participant = participants.find((p) => p.id === tenant.id);
    if (participant === undefined) throw new Error(`runSpawnEpisode: no participant for ${tenant.id}`);
    if (participant.role === "SUBJECT") {
      return new SafetyPlanner({
        ...DEFAULT_SAFETY_CONFIG,
        ...spec.subjectPlannerConfig,
        militaryRatioEnabled: true,
      });
    }
    if (participant.role === "STATIC" || participant.role === "NEW_WEAK") {
      return new NoOpPlanner();
    }
    return new SafetyPlanner({
      ...DEFAULT_SAFETY_CONFIG,
      aggression: "aggressive",
      attackForce: 2,
      ...spec.opponentPlannerConfig,
    });
  };
  const refill =
    spec.refillEveryTicks === null ? {} : { refill: { everyTicks: spec.refillEveryTicks } };
  return runEpisode({
    scenario,
    rulesPath: spec.manifestPath,
    seed: (scenario as { seed?: number }).seed ?? 0,
    ticks: spec.ticks,
    tenants,
    plannerFactory,
    rotateSlot: true,
    mySlot,
    validatePlans: true,
    ...refill,
  } as never);
}

// ──────────────────────────────────────────────────────────────────────
// 并行运行器（worker_threads 池 / 串行）
// ──────────────────────────────────────────────────────────────────────

/** 评估运行器接口——串行与 worker 池共用。 */
export interface EvaluationRunner {
  /** 按顺序评估所有 jobs，返回与输入同序的结果数组。 */
  map(
    jobs: readonly { readonly genome: MacroGenome; readonly seeds: readonly number[] }[],
  ): Promise<readonly EvalResult[]>;
  /** 释放资源（worker 池终止 worker；串行无操作）。 */
  close(): void;
}

/** 串行运行器（默认，workers ≤ 1）：在主线程同步调用评估器。 */
export class SerialRunner implements EvaluationRunner {
  private readonly evaluator: IndividualEvaluator;
  constructor(evaluator: IndividualEvaluator) {
    this.evaluator = evaluator;
  }
  async map(
    jobs: readonly { readonly genome: MacroGenome; readonly seeds: readonly number[] }[],
  ): Promise<readonly EvalResult[]> {
    const out: EvalResult[] = [];
    for (const job of jobs) {
      const result = await this.evaluator(job.genome, job.seeds);
      out.push(result);
    }
    return out;
  }
  close(): void {
    /* no-op */
  }
}

/**
 * worker_threads 池运行器（reference multiprocessing.Pool 的 TS 等价）。
 *
 * 自指 worker：本文件底部有 `!isMainThread && workerData?.kind ===
 * "ga-eval-worker"` 守卫，Worker(new URL(import.meta.url)) 加载本文件时
 * 进入 worker 循环。每个 worker 在 workerData 里收到 spec，构造一次
 * 评估器常驻；主线程投递 {jobId, genome, seeds} 任务，worker 跑完回
 * {jobId, fitness, detail} 或 {jobId, error}。runEpisode 纯函数 + 每
 * episode new SafetyPlanner（plannerFactory）→ worker 间零共享可变状态。
 */
export class WorkerPoolRunner implements EvaluationRunner {
  private readonly workers: Worker[] = [];
  /** 空闲 worker 栈——dispatch 取一个，response 归还一个。 */
  private readonly free: Worker[] = [];
  /** worker → 当前在跑的 (resolve, reject) 回调对（最多 1 个，串行投递）。 */
  private readonly resolvers = new Map<Worker, (result: EvalResult) => void>();
  private readonly rejecters = new Map<Worker, (error: Error) => void>();

  constructor(spec: SpawnProfileEvalSpec, workers: number) {
    const count = Math.max(1, Math.floor(workers));
    for (let i = 0; i < count; i += 1) {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { kind: "ga-eval-worker", spec },
      });
      worker.on("message", (message: unknown) => this.handleMessage(worker, message));
      worker.on("error", (error: Error) => this.handleError(worker, error));
      this.workers.push(worker);
      this.free.push(worker);
    }
  }

  async map(
    jobs: readonly { readonly genome: MacroGenome; readonly seeds: readonly number[] }[],
  ): Promise<readonly EvalResult[]> {
    if (jobs.length === 0) return [];
    const ordered: EvalResult[] = new Array(jobs.length);
    await Promise.all(
      jobs.map(async (job, index) => {
        const worker = await this.acquireFreeWorker();
        ordered[index] = await new Promise<EvalResult>((resolve, reject) => {
          this.resolvers.set(worker, resolve);
          this.rejecters.set(worker, reject);
          worker.postMessage({ genome: job.genome, seeds: job.seeds });
        });
      }),
    );
    return ordered;
  }

  close(): void {
    for (const worker of this.workers) {
      worker.terminate().catch(() => {});
    }
    this.workers.length = 0;
    this.free.length = 0;
    this.resolvers.clear();
    this.rejecters.clear();
  }

  private async acquireFreeWorker(): Promise<Worker> {
    const existing = this.free.pop();
    if (existing !== undefined) return existing;
    return new Promise<Worker>((resolve) => {
      const poll = (): void => {
        const worker = this.free.pop();
        if (worker !== undefined) resolve(worker);
        else setImmediate(poll);
      };
      setImmediate(poll);
    });
  }

  private handleMessage(worker: Worker, message: unknown): void {
    const messageObject = message as {
      fitness?: number;
      detail?: FitnessDetail;
      combatDamage?: number;
      error?: string;
    };
    const resolve = this.resolvers.get(worker);
    const reject = this.rejecters.get(worker);
    this.resolvers.delete(worker);
    this.rejecters.delete(worker);
    this.free.push(worker);
    if (messageObject.error !== undefined) {
      if (reject !== undefined) reject(new Error(messageObject.error));
    } else if (
      messageObject.fitness !== undefined &&
      messageObject.detail !== undefined &&
      resolve !== undefined
    ) {
      resolve({
        fitness: messageObject.fitness,
        detail: messageObject.detail,
        combatDamage: messageObject.combatDamage,
      });
    }
  }

  private handleError(worker: Worker, error: Error): void {
    const reject = this.rejecters.get(worker);
    this.resolvers.delete(worker);
    this.rejecters.delete(worker);
    if (!this.free.includes(worker)) this.free.push(worker);
    if (reject !== undefined) reject(error);
  }
}

// ──────────────────────────────────────────────────────────────────────
// GA 类（reference ga.py GA 的 TS 移植）
// ──────────────────────────────────────────────────────────────────────

export interface GAConfig {
  readonly popSize: number;
  readonly elites: number;
  readonly tournamentSize: number;
  readonly mutSigma: number;
  readonly crossoverRate: number;
  readonly seed: number;
  readonly evalSeeds: readonly number[];
  readonly holdoutSeeds: readonly number[];
  readonly seedPool: readonly number[];
  readonly seedRollover: number;
  readonly riskLambda: number;
  readonly prescreen: number;
  readonly workers: number;
  readonly maxTicks: number;
  readonly evaluatorSpec: SpawnProfileEvalSpec;
  /** warm start：初始种群围绕该基因扰动（reference init_genes）。 */
  readonly initGenome?: MacroGenome;
  /** 进度回调（done, total）——监控用，不影响进化。 */
  readonly progress?: (done: number, total: number) => void;
}

export interface GenerationReport {
  readonly generation: number;
  readonly bestFitness: number;
  readonly bestGenome: MacroGenome;
  readonly avgFitness: number;
  readonly holdout: EvalResult | null;
  readonly detail: FitnessDetail | null;
}

/** 简单确定性 PRNG（mulberry32）——GA 内部选择/变异用，不依赖 sim RNG。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: () => number, mean: number, sigma: number): number {
  // Box-Muller（reference random.gauss 等价）
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return mean + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** GA 遗传算法搜索器（reference arena-evolve/evolve/ga.py 的 TS 移植）。 */
export class GA {
  private readonly config: GAConfig;
  private readonly rng: () => number;
  private pop: MacroGenome[] = [];
  private fitness: number[] = [];
  private lastDetails: FitnessDetail[] = [];
  private readonly evalCache = new Map<string, EvalResult>();
  private lastHoldout: EvalResult | null = null;
  private activeEvalSeeds: readonly number[];
  private readonly runner: EvaluationRunner;
  private done = 0;
  private total = 0;

  constructor(config: GAConfig) {
    this.config = config;
    this.rng = mulberry32(config.seed);
    this.activeEvalSeeds = [...config.evalSeeds];
    this.runner =
      config.workers > 1
        ? new WorkerPoolRunner(config.evaluatorSpec, config.workers)
        : new SerialRunner(createSpawnProfileEvaluator(config.evaluatorSpec));
  }

  /** 释放运行器资源（worker 池终止 worker）。 */
  close(): void {
    this.runner.close();
  }

  /** 当前种群快照（只读）。 */
  getPopulation(): readonly MacroGenome[] {
    return this.pop;
  }

  /** 当前 fitness 快照（与种群同序）。 */
  getFitness(): readonly number[] {
    return this.fitness;
  }

  /** 最近一代冠军 holdout 复评结果（未跑 holdout = null）。 */
  getLastHoldout(): EvalResult | null {
    return this.lastHoldout;
  }

  // ── 初始化 ──────────────────────────────────────────────────────

  /** 初始化种群（reference init_population）：默认基因 ± 高斯扰动。 */
  initPopulation(): void {
    const base = this.config.initGenome ?? DEFAULT_MACRO_GENOME;
    this.pop = Array.from({ length: this.config.popSize }, () =>
      this.mutate(base, this.config.initGenome !== undefined ? 0.15 : 0.25),
    );
    this.fitness = new Array(this.config.popSize).fill(0);
    this.lastDetails = new Array(this.config.popSize).fill(emptyDetail());
  }

  // ── 评估 ────────────────────────────────────────────────────────

  /** 基因指纹（reference _genome_key）：数值 round 6 位 + 确定性字段序。 */
  genomeKey(genome: MacroGenome): string {
    const focus =
      genome.focusOffset === null
        ? null
        : [Math.round(genome.focusOffset[0] * 1e6) / 1e6, Math.round(genome.focusOffset[1] * 1e6) / 1e6];
    return JSON.stringify({
      posture: genome.posture,
      workerTarget: genome.workerTarget,
      militaryRatio: Math.round(genome.militaryRatio * 1e6) / 1e6,
      focusOffset: focus,
      attackPriority: genome.attackPriority,
    });
  }

  /** seed 列表键（用于 cache 键控，换批时清空）。 */
  private seedsKey(seeds: readonly number[]): string {
    return [...seeds].sort((a, b) => a - b).join(",");
  }

  private tickProgress(n: number): void {
    this.done += n;
    if (this.config.progress !== undefined) {
      try {
        this.config.progress(this.done, this.total);
      } catch {
        /* 监控回调不能影响进化 */
      }
    }
  }

  /**
   * 评估一批 (idx, genome, seeds) 任务，命中缓存直接复用（reference _run）。
   * 返回 {idx: EvalResult}。
   */
  private async runBatch(
    items: readonly { readonly idx: number; readonly genome: MacroGenome; readonly seeds: readonly number[] }[],
  ): Promise<ReadonlyMap<number, EvalResult>> {
    const out = new Map<number, EvalResult>();
    const todo: { readonly genome: MacroGenome; readonly seeds: readonly number[] }[] = [];
    const order: { readonly idx: number; readonly cacheKey: string }[] = [];
    for (const item of items) {
      const cacheKey = `${this.genomeKey(item.genome)}|${this.seedsKey(item.seeds)}`;
      const hit = this.evalCache.get(cacheKey);
      if (hit !== undefined) {
        out.set(item.idx, hit);
        this.tickProgress(1);
        continue;
      }
      todo.push({ genome: item.genome, seeds: item.seeds });
      order.push({ idx: item.idx, cacheKey });
    }
    if (todo.length > 0) {
      const results = await this.runner.map(todo);
      for (let i = 0; i < order.length; i += 1) {
        const result = results[i]!;
        this.evalCache.set(order[i]!.cacheKey, result);
        out.set(order[i]!.idx, result);
        this.tickProgress(1);
      }
    }
    return out;
  }

  /**
   * 评估整个种群（reference _evaluate_all）。返回 [{fitness, detail}]，
   * 顺序与 self.pop 一致。prescreen 预筛：先跑首 seed，仅前 prescreen
   * 比例补齐其余 seed（淘汰者分数置 -inf，永远不被选择/成为精英）。
   */
  private async evaluateAll(): Promise<EvalResult[]> {
    const seeds = this.activeEvalSeeds;
    const usePrescreen =
      this.config.prescreen > 0 && seeds.length > 1 && this.config.popSize > 2;
    const keep = usePrescreen
      ? Math.max(2, Math.round(this.config.popSize * this.config.prescreen))
      : 0;
    this.done = 0;
    this.total = this.config.popSize + keep;
    if (!usePrescreen) {
      const got = await this.runBatch(
        this.pop.map((genome, idx) => ({ idx, genome, seeds })),
      );
      return this.pop.map((_, idx) => got.get(idx)!);
    }
    // 预筛：全员先跑第一个种子，幸存者补齐其余种子，按种子数加权合并。
    const first = seeds.slice(0, 1);
    const rest = seeds.slice(1);
    const stage1 = await this.runBatch(
      this.pop.map((genome, idx) => ({ idx, genome, seeds: first })),
    );
    const survivors = [...this.pop.keys()]
      .sort((a, b) => (stage1.get(b)?.fitness ?? 0) - (stage1.get(a)?.fitness ?? 0))
      .slice(0, keep);
    const stage2 = await this.runBatch(
      survivors.map((idx) => ({
        idx,
        genome: this.pop[idx]!,
        seeds: rest,
      })),
    );
    const results: EvalResult[] = new Array(this.config.popSize);
    for (let i = 0; i < this.config.popSize; i += 1) {
      if (survivors.includes(i)) {
        const part1 = stage1.get(i)!;
        const part2 = stage2.get(i)!;
        // 单 seed 与多 seed 均值方差不同——直接混比会让锦标赛选到"单局
        // 运气好"的个体；幸存者用多 seed 聚合结果（stage2 已含首 seed 之外
        // 的全部 seed 的聚合，但这里简化为取 stage2 的聚合结果，因 stage2
        // 的评估器对 rest seeds 已做 evaluateMultiSeed）。为口径一致，幸存者
        // 最终分数 = 重跑全部 seeds 的聚合（缓存命中后近零成本）。
        const fullEval = await this.runBatch([
          { idx: i, genome: this.pop[i]!, seeds },
        ]);
        results[i] = fullEval.get(i) ?? part2;
        void part1;
      } else {
        // 淘汰者：保留 detail 供监控，fitness=-inf（永不被选择）。
        results[i] = { fitness: Number.NEGATIVE_INFINITY, detail: stage1.get(i)?.detail ?? emptyDetail() };
      }
    }
    return results;
  }

  /**
   * 并行评估整个种群（reference evaluate）。返回 (best_fitness, best_genes,
   * avg_fitness)。holdout 独立种子复评冠军（不进选择压力）。
   */
  async evaluate(generation: number, verbose: boolean = false): Promise<GenerationReport> {
    // seed_pool 滚动（reference evaluate 开头）。
    if (
      this.config.seedRollover > 0 &&
      this.config.seedPool.length > this.config.evalSeeds.length
    ) {
      const batch = Math.floor(generation / this.config.seedRollover) * this.config.evalSeeds.length;
      const active = [...this.config.evalSeeds.keys()]
        .map((i) => this.config.seedPool[(batch + i) % this.config.seedPool.length]!)
        .sort((a, b) => a - b);
      if (active.join(",") !== this.activeEvalSeeds.join(",")) {
        this.activeEvalSeeds = active;
        this.evalCache.clear();
        if (verbose) console.log(`  [seeds] 滚动到 ${active.join(",")}`);
      }
    }
    const results = await this.evaluateAll();
    this.fitness = results.map((result) => result.fitness);
    this.lastDetails = results.map((result) => result.detail);
    if (this.config.riskLambda > 0) {
      this.fitness = this.fitness.map((fitness, index) =>
        fitness === Number.NEGATIVE_INFINITY
          ? fitness
          : fitness - this.config.riskLambda * (this.lastDetails[index]!.fitness_std ?? 0),
      );
    }
    const validFitness = this.fitness.filter((fitness) => fitness !== Number.NEGATIVE_INFINITY);
    const bestIdx = this.fitness.indexOf(Math.max(...this.fitness));
    const avg =
      validFitness.length === 0
        ? Number.NEGATIVE_INFINITY
        : validFitness.reduce((sum, fitness) => sum + fitness, 0) / validFitness.length;
    // holdout 复评冠军（不进选择压力，防固定种子记忆过拟合）。
    this.lastHoldout = null;
    if (this.config.holdoutSeeds.length > 0 && bestIdx >= 0) {
      try {
        const holdoutEvaluator = createSpawnProfileEvaluator(this.config.evaluatorSpec);
        const holdoutResult = await holdoutEvaluator(this.pop[bestIdx]!, this.config.holdoutSeeds);
        this.lastHoldout = holdoutResult;
      } catch (error) {
        console.log(
          `  [holdout] 评估失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (verbose) {
      const bestCombat = results[bestIdx]?.combatDamage ?? 0;
      const avgCombat =
        results.length === 0
          ? 0
          : results.reduce((sum, r) => sum + (r.combatDamage ?? 0), 0) / results.length;
      console.log(
        `  gen ${generation}: best=${this.fitness[bestIdx]!.toFixed(1)} ` +
          `avg=${avg.toFixed(1)} combat(best=${bestCombat.toFixed(1)} avg=${avgCombat.toFixed(1)}) ` +
          `best_detail=${JSON.stringify(this.lastDetails[bestIdx])}`,
      );
      if (this.lastHoldout !== null) {
        console.log(
          `  [holdout] best 独立种子复评: ${this.lastHoldout.fitness.toFixed(1)}` +
            ` combat=${(this.lastHoldout.combatDamage ?? 0).toFixed(1)}`,
        );
      }
    }
    return {
      generation,
      bestFitness: this.fitness[bestIdx]!,
      bestGenome: this.pop[bestIdx]!,
      avgFitness: avg,
      holdout: this.lastHoldout,
      detail: this.lastDetails[bestIdx] ?? null,
    };
  }

  // ── 选择 / 交叉 / 变异 ──────────────────────────────────────────

  /** 生成下一代（reference next_generation）：精英保留 + 锦标赛 + 均匀交叉 + 变异。 */
  async nextGeneration(): Promise<void> {
    const order = [...this.pop.keys()].sort((a, b) => this.fitness[b]! - this.fitness[a]!);
    const newPop: MacroGenome[] = order
      .slice(0, this.config.elites)
      .map((idx) => this.pop[idx]!)
      .map((genome) => ({ ...genome }));
    while (newPop.length < this.config.popSize) {
      const parent1 = this.tournament();
      const parent2 = this.tournament();
      // crossoverRate 概率触发均匀交叉；否则 child = parent1 拷贝（reference）。
      let child =
        this.rng() < this.config.crossoverRate
          ? this.crossover(parent1, parent2)
          : { ...parent1 };
      child = this.mutate(child, 1.0);
      newPop.push(child);
    }
    this.pop = newPop;
    this.fitness = new Array(this.config.popSize).fill(0);
    this.lastDetails = new Array(this.config.popSize).fill(emptyDetail());
  }

  /** 锦标赛选择（reference _tournament）：tournamentSize 中 fitness 最高者。 */
  private tournament(): MacroGenome {
    let best: MacroGenome | null = null;
    let bestFitness = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.config.tournamentSize; i += 1) {
      const idx = Math.floor(this.rng() * this.pop.length);
      if (this.fitness[idx]! > bestFitness) {
        best = this.pop[idx]!;
        bestFitness = this.fitness[idx]!;
      }
    }
    return best ?? this.pop[0]!;
  }

  /** 均匀交叉（reference next_generation 内）：每维 50% 取自 parent2。 */
  private crossover(parent1: MacroGenome, parent2: MacroGenome): MacroGenome {
    const takeFromP2 = (): boolean => this.rng() < 0.5;
    const posture = takeFromP2() ? parent2.posture : parent1.posture;
    const workerTarget = takeFromP2() ? parent2.workerTarget : parent1.workerTarget;
    const militaryRatio = takeFromP2() ? parent2.militaryRatio : parent1.militaryRatio;
    const attackPriority = takeFromP2() ? parent2.attackPriority : parent1.attackPriority;
    const focusOffset = crossoverFocusOffset(parent1.focusOffset, parent2.focusOffset, this.rng);
    return { posture, workerTarget, militaryRatio, focusOffset, attackPriority };
  }

  /**
   * 高斯变异（reference _mutate）：每维以 0.4 概率扰动；枚举随机取、整数
   * 高斯四舍五入后截断、浮点高斯截断、offset2d 每分量独立高斯 + 小概率
   * null 切换。返回新基因组（不修改原对象）。
   */
  private mutate(genome: MacroGenome, sigmaMult: number): MacroGenome {
    const mutateEnum = <T,>(value: T, choices: readonly T[]): T =>
      this.rng() < 0.4 ? choices[Math.floor(this.rng() * choices.length)]! : value;
    const posture = mutateEnum(genome.posture, POSTURES);
    const attackPriority = mutateEnum(genome.attackPriority, ATTACK_PRIORITIES);
    let workerTarget = genome.workerTarget;
    if (this.rng() < 0.4) {
      const sigma = (16 - 1) * this.config.mutSigma * sigmaMult;
      workerTarget = clamp(Math.round(gauss(this.rng, genome.workerTarget, sigma)), 1, 16);
    }
    let militaryRatio = genome.militaryRatio;
    if (this.rng() < 0.4) {
      const sigma = (1 - 0) * this.config.mutSigma * sigmaMult;
      militaryRatio = clamp(gauss(this.rng, genome.militaryRatio, sigma), 0, 1);
    }
    const focusOffset = mutateFocusOffset(
      genome.focusOffset,
      this.rng,
      this.config.mutSigma * sigmaMult,
    );
    return { posture, workerTarget, militaryRatio, focusOffset, attackPriority };
  }
}

/** focusOffset 交叉：两 null→null；一 null→50/50 取 set 或 null；两 set→dx/dy 各自 50/50。 */
function crossoverFocusOffset(
  a: readonly [number, number] | null,
  b: readonly [number, number] | null,
  rng: () => number,
): readonly [number, number] | null {
  if (a === null && b === null) return null;
  if (a === null) return rng() < 0.5 || b === null ? null : [b[0], b[1]];
  if (b === null) return rng() < 0.5 ? null : [a[0], a[1]];
  const dx = rng() < 0.5 ? b[0] : a[0];
  const dy = rng() < 0.5 ? b[1] : a[1];
  return [dx, dy];
}

/** focusOffset 变异：0.4 概率扰动 dx/dy（高斯 round clamp）；额外 0.1 概率 null 切换。 */
function mutateFocusOffset(
  offset: readonly [number, number] | null,
  rng: () => number,
  sigmaScaled: number,
): readonly [number, number] | null {
  const flipNull = rng() < 0.1;
  if (offset === null) {
    if (rng() < 0.4 || flipNull) {
      return [
        clamp(Math.round(gauss(rng, 0, (2 * MAX_FOCUS_DISTANCE) * sigmaScaled)), -MAX_FOCUS_DISTANCE, MAX_FOCUS_DISTANCE),
        clamp(Math.round(gauss(rng, 0, (2 * MAX_FOCUS_DISTANCE) * sigmaScaled)), -MAX_FOCUS_DISTANCE, MAX_FOCUS_DISTANCE),
      ];
    }
    return null;
  }
  if (flipNull) return null;
  let dx = offset[0];
  let dy = offset[1];
  if (rng() < 0.4) {
    dx = clamp(Math.round(gauss(rng, offset[0], (2 * MAX_FOCUS_DISTANCE) * sigmaScaled)), -MAX_FOCUS_DISTANCE, MAX_FOCUS_DISTANCE);
  }
  if (rng() < 0.4) {
    dy = clamp(Math.round(gauss(rng, offset[1], (2 * MAX_FOCUS_DISTANCE) * sigmaScaled)), -MAX_FOCUS_DISTANCE, MAX_FOCUS_DISTANCE);
  }
  return [dx, dy];
}

function emptyDetail(): FitnessDetail {
  return {
    harvested: 0,
    deposited: 0,
    res: 0,
    pop: 0,
    beacon: 0,
    alive_ticks: 0,
    damage: 0,
    lost: 0,
    respawn: 0,
    heal_cost: 0,
    repair_cost: 0,
    spawn_cost: 0,
    overflow_destroyed: 0,
    resources_lost: 0,
  };
}

// ──────────────────────────────────────────────────────────────────────
// worker_threads 自指入口（WorkerPoolRunner 的对端）
// ──────────────────────────────────────────────────────────────────────

/** worker 入口：加载本文件时若处于 worker 上下文则进入评估循环。 */
if (!isMainThread && workerData !== null && (workerData as { kind?: string }).kind === "ga-eval-worker") {
  void runEvalWorkerLoop(workerData as { spec: SpawnProfileEvalSpec });
}

async function runEvalWorkerLoop(data: { spec: SpawnProfileEvalSpec }): Promise<void> {
  const port = parentPort;
  if (port === null) return;
  const evaluator = createSpawnProfileEvaluator(data.spec);
  port.on("message", (message: unknown) => {
    const request = message as { jobId: number; genome: MacroGenome; seeds: readonly number[] };
    void (async () => {
      try {
        const result = await evaluator(request.genome, request.seeds);
        port.postMessage({
          jobId: request.jobId,
          fitness: result.fitness,
          detail: result.detail,
          combatDamage: result.combatDamage,
        });
      } catch (error) {
        port.postMessage({
          jobId: request.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
}

// 性能计时锚点（导出便于脚本/测试复用同一时钟）。
export function nowMs(): number {
  return performance.now();
}
