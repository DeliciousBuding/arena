#!/usr/bin/env node
/**
 * run-arena-report — agent 评测跑批 + 报告组装 CLI（arena-bench-v3）
 *
 * 评测形态（arena-bench-v3，审计 docs/analysis/bench-fairness-audit-2026-08-09.md
 *  §6 落地；取代 v2）：
 *   FFA 擂台标准化评测：场景模板 × 阵容（defaultContestants） × seed 笛卡尔跑批。
 *   - 场景模板注册表：scripts/bench-scenarios.json（radius/资源/randomDrop +
 *     v3 新增 center-race / depletion 后处理场景）
 *   - 阵容：src/sim/opponent/contestants.ts defaultContestants()（10 条目；
 *     --players N < 条目数取前 N 个，≥ 条目数全上）
 *   - 判定（每场，v3）：存活 → 击杀数 → 累计存款 deposited → 资源 → 人口
 *     （并列同分同排；v3 新增 deposited tie-break，审计 §6.4）
 *   - 胜者（v3）：与排名同链第 1 名（decideWinner 加击杀 + deposited 键，
 *     v3.3 补齐 deposited tie-break——审计 §1.4/§6.4）
 *   - 综合分（v3）：avgRank(反向 min-max) 60% + killRate 30% +
 *     resourcesPerTick 10%（v2 的 survivalMedian 20% 因同 tick 重生恒 1.0 移除，
 *     审计 §1.2/§6.2；字段保留兼容旧消费者）
 *   - 对照组：内置 ts-aggressive/ts-safety 与社区条目同场参赛、同归一化池
 *     一条龙排序（v3.4 同榜裁决 2026-08-10——同场对抗数据真实，分榜是外推
 *     口径逼的，非设计本意；kind=builtin 徽章保留在条目上；leaderboardControl
 *     保留为兼容字段）
 * 报告：data/runs/sim/arena-bench-<id>/ 下 results.json（schema
 *       arena.bench.report.v3，v2 字段向后兼容）
 *       + report.html（深色主题，SVG 内嵌：综合榜单/场景×条目热图/雷达图）。
 *
 * 用法（cd packages/arena-agent）：
 *   npx tsx scripts/run-arena-report.mts \
 *     [--scenarios ffa-std,ffa-dense] [--seeds 1,2,3,4,5] [--ticks 2000] \
 *     [--players 8] [--workers N] [--out arena-bench] [--data-root PATH] [--force]
 *
 * 分片/合并（并行跑批，2026-08-09）：--shard <i>/<n>（或 --shard <i>
 *   --shard-total <n>）+ --shard-by scenario|seed（默认 scenario）。全部
 *   （场景×seed）列表按维度确定性均分，本进程只跑第 i 片，写
 *   <runDir>/results.s<i>.json（runId 由完整参数决定，各片同目录）。
 *   全部片完成后 --merge <runDir>：读回分片、校验完整性（参数一致/
 *   无重叠/覆盖全笛卡尔集）、重算聚合/榜单/画像，写完整 results.json +
 *   report.html，并调用 scripts/arena_bench_plots.py 出图（契约：
 *   `python scripts/arena_bench_plots.py <results.json> --out <plots目录>`，
 *   脚本不存在则跳过并注明）。
 *
 * 并行（2026-08-09）：--workers N（默认 1 = 原有串行行为）。N > 1 时主进程
 *   把"场景×seed"组合分派给 N 个子进程（node:child_process spawn 同脚本
 *   `--worker <scenario> <seed>` 模式，--import tsx 加载），每子进程跑 1 场
 *   写单场结果 JSON 到临时目录，主进程读回后走同一套汇总/榜单/报告逻辑；
 *   失败场次记入 results.json errors 不中断整体（汇总时标注）。同一 seed
 *   同一场景结果与串行逐字节一致（确定性模拟）。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFreeForAll, makeArenaScenarioN, type TournEntry } from "../src/sim/opponent/tournament.ts";
import { defaultContestants, type Contestant } from "../src/sim/opponent/contestants.ts";
import { mean } from "../src/sim/opponent/stats.ts";
import {
  atomicWriteJson,
  atomicWriteText,
  prepareRunDir,
  resolveOutputBase,
  sha256Json,
  validateRunId,
} from "../src/sim/tools/artifacts.ts";
import { resolveArenaDataRoot } from "../src/app/data-root.ts";
import {
  computeAgentProfile,
  normalizeProfiles,
  type AgentProfile,
} from "../src/sim/viz/agent-profile.ts";
import {
  barsSvg,
  heatmapSvg,
  radarSvg,
  type HeatmapCell,
} from "../src/sim/viz/svg.ts";
import type { PlayerCostLedger } from "../src/sim/harness/episode.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
const RULES_PATH = join(PKG_ROOT, "src", "sim", "contracts", "rules-v0.14.json");
const SCENARIOS_PATH = join(here, "bench-scenarios.json");

/* ------------------------------------------------------------------ *
 * 场景模板注册表（Task 1：scripts/bench-scenarios.json）
 * ------------------------------------------------------------------ */

interface ScenarioTemplate {
  readonly radius: number;
  /** "standard" | "scarce" | "center-race" | "depletion"（见 loadScenarioRegistry 与各后处理函数）。 */
  readonly resources: "standard" | "scarce" | "center-race" | "depletion";
  readonly randomDrop?: boolean;
  readonly configNote?: string;
}

type ScenarioRegistry = Readonly<Record<string, ScenarioTemplate>>;

function loadScenarioRegistry(): ScenarioRegistry {
  const raw = JSON.parse(readFileSync(SCENARIOS_PATH, "utf8")) as Record<string, unknown>;
  const registry: Record<string, ScenarioTemplate> = {};
  for (const [name, value] of Object.entries(raw)) {
    const template = value as Partial<ScenarioTemplate>;
    if (typeof template.radius !== "number" || !Number.isFinite(template.radius) || template.radius <= 0) {
      throw new Error(`bench-scenarios.json: ${name}.radius must be a positive finite number`);
    }
    if (
      template.resources !== "standard" &&
      template.resources !== "scarce" &&
      template.resources !== "center-race" &&
      template.resources !== "depletion"
    ) {
      throw new Error(
        `bench-scenarios.json: ${name}.resources must be "standard"|"scarce"|"center-race"|"depletion"`,
      );
    }
    registry[name] = {
      radius: template.radius,
      resources: template.resources,
      randomDrop: template.randomDrop === true,
      configNote: typeof template.configNote === "string" ? template.configNote : undefined,
    };
  }
  return registry;
}

/**
 * scarce 变体实现（Task 1）：makeArenaScenarioN 无资源密度参数，采用最小侵入
 * 后处理——构建场景后把每个玩家的资源盘数量减半（4→2，隔一取一，保持
 * 空间对称）。场景 terrain.resources 按 players 序分组（每玩家 4 盘），
 * 与 randomDrop 的参与序洗牌兼容（resources 恒按 players[] 序生成）。
 */
function halveScenarioResources(scenario: unknown): unknown {
  const root = scenario as {
    readonly players: readonly unknown[];
    readonly terrain: { readonly obstacles: readonly unknown[]; readonly resources: readonly [number, number][] };
  };
  const playerCount = Math.max(1, root.players.length);
  const resources = root.terrain.resources;
  if (resources.length % playerCount !== 0) {
    throw new Error(`halveScenarioResources: resources ${resources.length} not divisible by players ${playerCount}`);
  }
  const perPlayer = resources.length / playerCount;
  const kept: [number, number][] = [];
  for (let player = 0; player < playerCount; player += 1) {
    for (let offset = 0; offset < perPlayer; offset += 1) {
      if (offset % 2 === 0) kept.push(resources[player * perPlayer + offset]);
    }
  }
  return {
    ...root,
    terrain: { ...root.terrain, resources: kept },
  };
}

/** v3 中央矿争夺：每玩家近距盘减半 + 地图中心 [0,0] 加 4 盘共享矿（强争夺点，
 *  与信标同位——抢矿即抢信标战略位；审计 §6.5）。 */
function addCenterRaceResources(scenario: unknown): unknown {
  const root = scenario as {
    readonly players: readonly unknown[];
    readonly terrain: { readonly obstacles: readonly unknown[]; readonly resources: readonly [number, number][] };
  };
  const halved = halveScenarioResources(scenario) as typeof root;
  const centerMines: [number, number][] = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];
  return {
    ...halved,
    terrain: { ...halved.terrain, resources: [...halved.terrain.resources, ...centerMines] },
  };
}

/** v3 资源枯竭压力（防御压力降级版）：每玩家资源盘 4→1（取每盘首格）——
 *  持久资源压力逼出兵争夺/抢矿；引擎暂无定时红队中性单位（审计 §6.6 降级说明）。 */
function depleteScenarioResources(scenario: unknown): unknown {
  const root = scenario as {
    readonly players: readonly unknown[];
    readonly terrain: { readonly obstacles: readonly unknown[]; readonly resources: readonly [number, number][] };
  };
  const playerCount = Math.max(1, root.players.length);
  const resources = root.terrain.resources;
  if (resources.length % playerCount !== 0) {
    throw new Error(`depleteScenarioResources: resources ${resources.length} not divisible by players ${playerCount}`);
  }
  const perPlayer = resources.length / playerCount;
  const kept: [number, number][] = [];
  for (let player = 0; player < playerCount; player += 1) {
    kept.push(resources[player * perPlayer]);
  }
  return {
    ...root,
    terrain: { ...root.terrain, resources: kept },
  };
}

/* ------------------------------------------------------------------ *
 * CLI 参数（vs-arena 同款解析：--flag value 或 --flag=value）
 * ------------------------------------------------------------------ */

function argValue(flag: string): string | undefined {
  const equals = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (equals !== undefined) return equals.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  return undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

/** 逗号分隔非负整数（seeds）；空列表/非法值 fail-fast。 */
function intList(raw: string, flag: string): number[] {
  const parsed = raw.split(",").map((entry) => Number(entry));
  if (parsed.length === 0 || parsed.some((entry) => !Number.isSafeInteger(entry) || entry < 0)) {
    throw new Error(`${flag} must be a comma-separated list of non-negative safe integers (got "${raw}")`);
  }
  return [...new Set(parsed)].sort((a, b) => a - b);
}

const SCENARIO_REGISTRY = loadScenarioRegistry();

/** 场景名列表：未知场景名 fail-fast（防拼写错误静默少跑）。 */
function scenarioList(raw: string, flag: string): string[] {
  const names = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (names.length === 0) {
    throw new Error(`${flag} must be a comma-separated list of scenario names (got "${raw}")`);
  }
  for (const name of names) {
    if (!(name in SCENARIO_REGISTRY)) {
      throw new Error(`${flag} 含未知场景 "${name}"（注册表：${Object.keys(SCENARIO_REGISTRY).join(", ")}）`);
    }
  }
  return [...new Set(names)];
}

const TICKS = Number(argValue("--ticks") ?? 2000);
if (!Number.isSafeInteger(TICKS) || TICKS < 1) {
  throw new Error(`--ticks must be a positive safe integer (got ${String(argValue("--ticks"))})`);
}
const SEEDS = intList(argValue("--seeds") ?? "1,2,3,4,5", "--seeds");
const SCENARIOS = scenarioList(argValue("--scenarios") ?? Object.keys(SCENARIO_REGISTRY).join(","), "--scenarios");
const PLAYERS = Number(argValue("--players") ?? 8);
if (!Number.isSafeInteger(PLAYERS) || PLAYERS < 2) {
  throw new Error(`--players must be a safe integer >= 2 (got ${String(argValue("--players"))})`);
}
const WORKERS = Number(argValue("--workers") ?? 1);
if (!Number.isSafeInteger(WORKERS) || WORKERS < 1) {
  throw new Error(`--workers must be a positive safe integer (got ${String(argValue("--workers"))})`);
}
const OUT_PREFIX = argValue("--out") ?? "arena-bench";

/** P4g 决策流水线（2026-08-09）：--pipeline 启用 episode 流水线模式（prefetch
 *  提前发起 tick N+1 决策，主线程不再每 tick 同步等待桥决策——默认关 = 现有行为）。 */
const PIPELINE = hasFlag("--pipeline");

/** R2 桥状态投影（2026-08-09）：--bridge-projection 对白名单 agent（字段审计
 *  通过的 Python 对手）启用状态投影（省略恒 null 字段，payload -20.3%）——
 *  默认关 = 现状逐字节一致。见 docs/analysis/bridge-field-audit.md。 */
const BRIDGE_PROJECTION = hasFlag("--bridge-projection");

/** --shard-by 解析：scenario（默认）| seed。 */
function parseShardBy(): "scenario" | "seed" {
  const raw = argValue("--shard-by") ?? "scenario";
  if (raw === "scenario" || raw === "seed") return raw;
  throw new Error(`--shard-by 必须为 scenario 或 seed（got "${raw}"）`);
}

const SHARD_BY = parseShardBy();

/* ------------------------------------------------------------------ *
 * 结构类型
 * ------------------------------------------------------------------ */

/** 单场 per-player 数据（playerId = entry id，如 "farmer-s1"）。 */
interface MatchPlayerData {
  readonly kills: number;
  /** 首杀 tick（无击杀 = null）。 */
  readonly firstKillTick: number | null;
  readonly aliveTicks: number;
  readonly harvested: number;
  readonly deposited: number;
  readonly damageDealt: number;
  readonly beaconTicks: number;
  readonly unitsLost: number;
  readonly finalPopulation: number;
  readonly finalResources: number;
  readonly populationPeak: number;
  readonly ledger: PlayerCostLedger;
}

interface BenchMatch {
  readonly scenario: string;
  readonly seed: number;
  readonly winner: string | null;
  /** entry id → 本场排名（1 = 最佳；并列同分同排）。 */
  readonly rank: Readonly<Record<string, number>>;
  readonly perPlayer: Readonly<Record<string, MatchPlayerData>>;
  /** 击杀时序事件（tick 升序；v3.1，向后兼容——旧数据无此字段）。 */
  readonly killEvents?: readonly {
    readonly tick: number;
    readonly destroyedBy: readonly string[];
    readonly victim?: string;
  }[];
  /** per-tick 资源/人口采样（每 50 tick；v3.1 可观测性，向后兼容）。 */
  readonly perTickSamples?: readonly {
    readonly tick: number;
    readonly players: Readonly<Record<string, { readonly resources: number; readonly population: number }>>;
  }[];
}

/** 每场景×条目跨 seeds 聚合指标（设计 §4）。 */
interface EntryScenarioStats {
  /** 场均击毁核心数（本条目造成的）。 */
  readonly killRate: number;
  /** 场均首杀 tick（无击杀场次不参与均值；全部无击杀 = null）。 */
  readonly firstKillTick: number | null;
  /** 有击杀的场次数。 */
  readonly killMatches: number;
  /** 中位存活比例（aliveTicks / ticks 的中位数）。 */
  readonly survivalMedian: number;
  /** harvested / aliveTicks 的场均值。 */
  readonly resourcesPerTick: number;
  /** damageDealt / max(unitsLost,1) 的场均值。 */
  readonly damagePerLoss: number;
  /** 人口峰值的场均值。 */
  readonly populationPeak: number;
  /** 信标控制占比（beaconTicks / ticks）的场均值。 */
  readonly beaconTicks: number;
  /** 场均排名（存活→击杀→资源→人口）。 */
  readonly avgRank: number;
}

interface ScenarioSummary {
  readonly name: string;
  readonly template: ScenarioTemplate;
  readonly seedCount: number;
  readonly matches: readonly BenchMatch[];
  readonly perEntry: Readonly<Record<string, EntryScenarioStats>>;
}

/** 榜单条目（跨全部场景聚合）。 */
interface LeaderboardRow {
  readonly contestantId: string;
  readonly avgRank: number;
  readonly killRate: number;
  /** v2 兼容字段（恒 1.0 退化，保留仅供旧消费者；v3 权重不用）。 */
  readonly survivalMedian: number;
  readonly rankScore: number;
  readonly killScore: number;
  /** v3：经济分（resourcesPerTick min-max），替换失效的 survivalScore。 */
  readonly economyScore: number;
  /** v2 兼容字段（恒 1.0，保留）。 */
  readonly survivalScore: number;
  /** 综合分 = avgRank 60% + killRate 30% + economy 10%（v3，审计 §6.2）。 */
  readonly composite: number;
}

/** 榜单分区：main = 参与主榜 composite 排名的条目；control = 内置对照组
 *  （ts-aggressive/ts-safety，kind=builtin）——不参与主榜排名、单独展示
 *  （任务书条目面；与 v2 相比去内置特权，审计 §6.9）。 */
interface LeaderboardSection {
  readonly main: readonly LeaderboardRow[];
  readonly control: readonly LeaderboardRow[];
}

/* ------------------------------------------------------------------ *
 * 工具：排序 / 排名 / 聚合
 * ------------------------------------------------------------------ */

/** 竞争式排名（1,2,2,4）：sort key 存活 → 击杀 → 累计存款（deposited，v3
 *  tie-break，审计 §6.4）→ 资源 → 人口。并列同分同排，下一名跳过。 */
function rankMatchPlayers(
  playerIds: readonly string[],
  result: ReturnType<typeof runFreeForAll>,
): Readonly<Record<string, number>> {
  interface ScoredPlayer {
    readonly playerId: string;
    readonly alive: boolean;
    readonly kills: number;
    readonly deposited: number;
    readonly resources: number;
    readonly population: number;
  }
  const kills = result.perPlayerKills ?? {};
  const ledgers = result.perPlayerLedgers ?? {};
  const scored: ScoredPlayer[] = playerIds.map((playerId) => ({
    playerId,
    alive: result.coreAlive[playerId] ?? false,
    kills: kills[playerId] ?? 0,
    deposited: ledgers[playerId]?.deposited ?? 0,
    resources: result.finalResources[playerId] ?? 0,
    population: result.finalPopulation[playerId] ?? 0,
  }));
  scored.sort(
    (a, b) =>
      Number(b.alive) - Number(a.alive) ||
      b.kills - a.kills ||
      b.deposited - a.deposited ||
      b.resources - a.resources ||
      b.population - a.population ||
      (a.playerId < b.playerId ? -1 : 1),
  );
  const sameScore = (a: ScoredPlayer, b: ScoredPlayer): boolean =>
    a.alive === b.alive &&
    a.kills === b.kills &&
    a.deposited === b.deposited &&
    a.resources === b.resources &&
    a.population === b.population;
  const rank: Record<string, number> = {};
  let currentRank = 1;
  for (let index = 0; index < scored.length; index += 1) {
    if (index > 0 && !sameScore(scored[index], scored[index - 1])) {
      currentRank = index + 1;
    }
    rank[scored[index].playerId] = currentRank;
  }
  return rank;
}

/** 中位数（偶数样本取两中值均值；空数组 → NaN，调用方保证非空）。 */
function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 多场次 ledger 逐字段均值（五维画像聚合输入；populationPeak 一并均值化）。 */
const LEDGER_NUMERIC_FIELDS = [
  "harvested", "deposited", "damageDealt", "beaconTicks", "respawnCount",
  "unitsLost", "healCost", "repairCost", "spawnCost", "overflowDestroyed",
  "resourcesLost", "finalPopulation", "finalResources", "aliveTicks",
  "populationPeak", "unrecognizedEventCount", "decisionTimeouts",
] as const;

function averageLedgers(ledgers: readonly PlayerCostLedger[]): PlayerCostLedger {
  if (ledgers.length === 0) {
    throw new Error("averageLedgers: empty ledger pool");
  }
  const fieldMean = (field: (typeof LEDGER_NUMERIC_FIELDS)[number]): number =>
    mean(ledgers.map((ledger) => ledger[field]));
  const eventCounts: Record<string, number> = {};
  for (const category of Object.keys(ledgers[0].eventCounts)) {
    eventCounts[category] = mean(
      ledgers.map((ledger) => (ledger.eventCounts as Readonly<Record<string, number>>)[category] ?? 0),
    );
  }
  return {
    harvested: fieldMean("harvested"),
    deposited: fieldMean("deposited"),
    damageDealt: fieldMean("damageDealt"),
    beaconTicks: fieldMean("beaconTicks"),
    respawnCount: fieldMean("respawnCount"),
    unitsLost: fieldMean("unitsLost"),
    healCost: fieldMean("healCost"),
    repairCost: fieldMean("repairCost"),
    spawnCost: fieldMean("spawnCost"),
    overflowDestroyed: fieldMean("overflowDestroyed"),
    resourcesLost: fieldMean("resourcesLost"),
    finalPopulation: fieldMean("finalPopulation"),
    finalResources: fieldMean("finalResources"),
    aliveTicks: fieldMean("aliveTicks"),
    populationPeak: fieldMean("populationPeak"),
    eventCounts: eventCounts as PlayerCostLedger["eventCounts"],
    unrecognizedEventCount: fieldMean("unrecognizedEventCount"),
    decisionTimeouts: fieldMean("decisionTimeouts"),
  };
}

/* ------------------------------------------------------------------ *
 * 跑批：场景模板 × 阵容 × seed
 * ------------------------------------------------------------------ */

/** 按玩家数裁剪阵容：N < 条目数取前 N 个；≥ 条目数全上。 */
function buildRosterForPlayers(playerCount: number): readonly Contestant[] {
  const all = defaultContestants();
  return playerCount < all.length ? all.slice(0, playerCount) : all;
}

/** 按 --players 裁剪阵容（正常/分片路径；合并路径用分片文件里的 players）。 */
function buildRoster(): { readonly contestants: readonly Contestant[] } {
  return { contestants: buildRosterForPlayers(PLAYERS) };
}

function buildScenario(
  template: ScenarioTemplate,
  entries: readonly TournEntry[],
  seed: number,
): unknown {
  const scenario = makeArenaScenarioN(entries, seed, {
    radius: template.radius,
    ...(template.randomDrop === true ? { randomDrop: { seed } } : {}),
  });
  return template.resources === "scarce"
    ? halveScenarioResources(scenario)
    : template.resources === "center-race"
      ? addCenterRaceResources(scenario)
      : template.resources === "depletion"
        ? depleteScenarioResources(scenario)
        : scenario;
}

function runScenario(
  name: string,
  template: ScenarioTemplate,
  seeds: readonly number[],
  ticks: number,
  contestants: readonly Contestant[],
): ScenarioSummary {
  const matches: BenchMatch[] = [];
  for (const seed of seeds) {
    matches.push(runSingleMatch(name, template, seed, ticks, contestants));
  }
  return aggregateScenarioMatches(name, template, seeds, ticks, contestants, matches);
}

/** 跑单场对局（runFreeForAll 真实桥），返回规范化场次结果。子进程 --worker
 *  模式与主进程串行路径共用此函数——同一 seed 同一场景产出完全一致。 */
function runSingleMatch(
  name: string,
  template: ScenarioTemplate,
  seed: number,
  ticks: number,
  contestants: readonly Contestant[],
): BenchMatch {
  const entries = contestants.map((contestant) => contestant.entry(seed));
  const scenario = buildScenario(template, entries, seed);
  const result = runFreeForAll(entries, seed, ticks, RULES_PATH, {
    scenario,
    pipeline: PIPELINE,
    bridgeProjection: BRIDGE_PROJECTION,
  });
  const rank = rankMatchPlayers(entries.map((entry) => entry.id), result);
  const ledgers = result.perPlayerLedgers ?? {};
  const kills = result.perPlayerKills ?? {};
  const firstKillTicks = result.perPlayerFirstKillTicks ?? {};
  const perPlayer: Record<string, MatchPlayerData> = {};
  for (const entry of entries) {
    const ledger = ledgers[entry.id];
    if (ledger === undefined) {
      throw new Error(`runFreeForAll 缺 ${entry.id} 的 per-player ledger`);
    }
    perPlayer[entry.id] = {
      kills: kills[entry.id] ?? 0,
      firstKillTick: firstKillTicks[entry.id] ?? null,
      aliveTicks: ledger.aliveTicks,
      harvested: ledger.harvested,
      deposited: ledger.deposited,
      damageDealt: ledger.damageDealt,
      beaconTicks: ledger.beaconTicks,
      unitsLost: ledger.unitsLost,
      finalPopulation: ledger.finalPopulation,
      finalResources: ledger.finalResources,
      populationPeak: ledger.populationPeak,
      ledger,
    };
  }
  const winnerLabel = result.winner ?? "draw";
  const summaryLine = entries.map((entry) => `${entry.id} r${rank[entry.id]}`).join(" ");
  console.log(`[${name}] seed=${seed} winner=${winnerLabel} events=${result.eventCount} :: ${summaryLine}`);
  return {
    scenario: name,
    seed,
    winner: result.winner,
    rank,
    perPlayer,
    ...(result.killEvents === undefined ? {} : { killEvents: result.killEvents }),
    ...(result.perTickSamples === undefined ? {} : { perTickSamples: result.perTickSamples }),
  };
}

/** 跨 seeds 聚合（设计 §4；每个条目都出现在每场，缺失场次跳过）。跑批与
 *  汇总分离：串行路径与并行路径（子进程结果 JSON 读回）共用同一聚合。 */
function aggregateScenarioMatches(
  name: string,
  template: ScenarioTemplate,
  seeds: readonly number[],
  ticks: number,
  contestants: readonly Contestant[],
  matches: readonly BenchMatch[],
): ScenarioSummary {
  const perEntry: Record<string, EntryScenarioStats> = {};
  for (const contestant of contestants) {
    const playerIdBySeed = new Map(seeds.map((seed) => [seed, contestant.entry(seed).id]));
    const samples: { readonly data: MatchPlayerData; readonly rank: number }[] = [];
    for (const match of matches) {
      const playerId = playerIdBySeed.get(match.seed);
      const data = playerId === undefined ? undefined : match.perPlayer[playerId];
      if (data === undefined) continue;
      samples.push({ data, rank: match.rank[playerId] ?? matches.length });
    }
    const datas = samples.map((sample) => sample.data);
    const firstKillTicks = datas
      .map((data) => data.firstKillTick)
      .filter((tick): tick is number => tick !== null);
    perEntry[contestant.id] = {
      killRate: mean(datas.map((data) => data.kills)),
      firstKillTick: firstKillTicks.length > 0 ? mean(firstKillTicks) : null,
      killMatches: datas.filter((data) => data.kills > 0).length,
      survivalMedian: median(datas.map((data) => data.aliveTicks / ticks)),
      resourcesPerTick: mean(datas.map((data) => (data.aliveTicks > 0 ? data.harvested / data.aliveTicks : 0))),
      damagePerLoss: mean(datas.map((data) => data.damageDealt / Math.max(data.unitsLost, 1))),
      populationPeak: mean(datas.map((data) => data.populationPeak)),
      beaconTicks: mean(datas.map((data) => data.beaconTicks / ticks)),
      avgRank: mean(samples.map((sample) => sample.rank)),
    };
  }
  return { name, template, seedCount: seeds.length, matches, perEntry };
}

/* ------------------------------------------------------------------ *
 * 并行跑批：--workers N 子进程分派（--worker 单场模式）
 * ------------------------------------------------------------------ */

/** 子进程单场结果 JSON（--worker 输出到临时目录）。 */
interface WorkerMatchFile {
  readonly schema: "arena.bench.match.v1";
  readonly scenario: string;
  readonly seed: number;
  readonly winner: string | null;
  readonly rank: Readonly<Record<string, number>>;
  readonly perPlayer: Readonly<Record<string, MatchPlayerData>>;
  /** 击杀时序事件（v3.1；worker 序列化必须带上，否则主进程读回时丢失）。 */
  readonly killEvents?: readonly {
    readonly tick: number;
    readonly destroyedBy: readonly string[];
    readonly victim?: string;
  }[];
  /** per-tick 资源/人口采样（v3.1；worker 序列化必须带上，否则主进程读回时丢失）。 */
  readonly perTickSamples?: readonly {
    readonly tick: number;
    readonly players: Readonly<Record<string, { readonly resources: number; readonly population: number }>>;
  }[];
  /** 单场耗时（ms）。 */
  readonly elapsedMs: number;
}

/** 子进程失败 JSON（非 0 退出时写）。 */
interface WorkerErrorFile {
  readonly schema: "arena.bench.match.error.v1";
  readonly scenario: string;
  readonly seed: number;
  readonly message: string;
  readonly stack?: string;
}

/** 主进程汇总的失败场次记录（写入 results.json errors）。 */
interface MatchError {
  readonly scenario: string;
  readonly seed: number;
  readonly message: string;
}

function workerResultFileName(scenario: string, seed: number): string {
  return `match-${scenario}-s${seed}.json`;
}

function workerErrorFileName(scenario: string, seed: number): string {
  return `match-${scenario}-s${seed}.error.json`;
}

/** 解析 --worker <scenario> <seed> 子进程调用；非 worker 模式返回 null。 */
function parseWorkerInvocation(): { readonly scenario: string; readonly seed: number; readonly outDir: string } | null {
  const flagIndex = process.argv.indexOf("--worker");
  if (flagIndex < 0) return null;
  const scenario = process.argv[flagIndex + 1];
  const seedRaw = process.argv[flagIndex + 2];
  const outDir = argValue("--worker-out-dir");
  if (scenario === undefined || seedRaw === undefined || outDir === undefined) {
    throw new Error(`--worker 需要 <scenario> <seed> --worker-out-dir <dir>`);
  }
  const seed = Number(seedRaw);
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error(`--worker seed must be a non-negative safe integer (got "${seedRaw}")`);
  }
  if (!(scenario in SCENARIO_REGISTRY)) {
    throw new Error(`--worker 含未知场景 "${scenario}"`);
  }
  return { scenario, seed, outDir };
}

/** 子进程入口：跑 1 场并写单场结果 JSON；失败写 error JSON 并返回非 0。 */
function runWorkerProcess(): number {
  const invocation = parseWorkerInvocation();
  if (invocation === null) return 2;
  const roster = buildRoster().contestants;
  const startedAt = Date.now();
  try {
    const match = runSingleMatch(
      invocation.scenario,
      SCENARIO_REGISTRY[invocation.scenario],
      invocation.seed,
      TICKS,
      roster,
    );
    const file: WorkerMatchFile = {
      schema: "arena.bench.match.v1",
      scenario: match.scenario,
      seed: match.seed,
      winner: match.winner,
      rank: match.rank,
      perPlayer: match.perPlayer,
      ...(match.killEvents === undefined ? {} : { killEvents: match.killEvents }),
      ...(match.perTickSamples === undefined ? {} : { perTickSamples: match.perTickSamples }),
      elapsedMs: Date.now() - startedAt,
    };
    atomicWriteJson(join(invocation.outDir, workerResultFileName(invocation.scenario, invocation.seed)), file);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[worker] ${invocation.scenario} seed=${invocation.seed} 失败：${message}`);
    try {
      const errorFile: WorkerErrorFile = {
        schema: "arena.bench.match.error.v1",
        scenario: invocation.scenario,
        seed: invocation.seed,
        message,
        stack: error instanceof Error ? error.stack : undefined,
      };
      atomicWriteJson(join(invocation.outDir, workerErrorFileName(invocation.scenario, invocation.seed)), errorFile);
    } catch {
      // 错误文件写失败不掩盖原始错误
    }
    return 1;
  }
}

/** 派发单场给一个子进程：spawn 同脚本 --worker 模式，等退出后读回结果 JSON。
 *  非 0 退出 / 结果缺失 / 解析失败 → 抛错（由调用方记入 MatchError）。 */
function runOneWorkerMatch(job: { readonly scenario: string; readonly seed: number }, outDir: string): Promise<BenchMatch> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [
        "--import", "tsx",
        fileURLToPath(import.meta.url),
        "--worker", job.scenario, String(job.seed),
        "--ticks", String(TICKS),
        "--players", String(PLAYERS),
        ...(PIPELINE ? ["--pipeline"] : []),
        "--worker-out-dir", outDir,
      ],
      { cwd: PKG_ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stderrTail = "";
    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-2000);
    });
    child.on("error", (error) => rejectPromise(new Error(`spawn 失败：${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        let detail = stderrTail.trim() || `exit ${code}${signal ? ` (${signal})` : ""}`;
        try {
          const errorFile = JSON.parse(
            readFileSync(join(outDir, workerErrorFileName(job.scenario, job.seed)), "utf8"),
          ) as WorkerErrorFile;
          if (typeof errorFile.message === "string" && errorFile.message.length > 0) {
            detail = errorFile.message;
          }
        } catch {
          // 错误文件缺失时退回 stderr 摘要
        }
        rejectPromise(new Error(detail));
        return;
      }
      try {
        const raw = JSON.parse(
          readFileSync(join(outDir, workerResultFileName(job.scenario, job.seed)), "utf8"),
        ) as WorkerMatchFile;
        if (raw.schema !== "arena.bench.match.v1") {
          throw new Error(`schema 不符：${String(raw.schema)}`);
        }
        resolvePromise({
          scenario: raw.scenario,
          seed: raw.seed,
          winner: raw.winner,
          rank: raw.rank,
          perPlayer: raw.perPlayer,
          ...(raw.killEvents === undefined ? {} : { killEvents: raw.killEvents }),
          ...(raw.perTickSamples === undefined ? {} : { perTickSamples: raw.perTickSamples }),
        });
      } catch (error) {
        rejectPromise(new Error(`结果 JSON 读取失败：${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

/** 并行跑批：--workers 个并发，FIFO 队列调度（完成后补下一个）；按
 *  场景×seed 笛卡尔序（与串行一致）返回场次。失败场次记入 errors。 */
async function runScenarioBatchParallel(
  contestants: readonly Contestant[],
  workers: number,
): Promise<{ readonly scenarios: readonly ScenarioSummary[]; readonly errors: readonly MatchError[] }> {
  const jobs: { readonly scenario: string; readonly seed: number }[] = [];
  for (const scenario of SCENARIOS) {
    for (const seed of SEEDS) {
      jobs.push({ scenario, seed });
    }
  }
  const outDir = mkdtempSync(join(tmpdir(), "arena-bench-workers-"));
  const results = new Map<string, BenchMatch>();
  const errors: MatchError[] = [];
  try {
    let nextJob = 0;
    const workerLoop = async (): Promise<void> => {
      while (nextJob < jobs.length) {
        const job = jobs[nextJob];
        nextJob += 1;
        try {
          const match = await runOneWorkerMatch(job, outDir);
          results.set(`${job.scenario}\u0000${job.seed}`, match);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[fail] ${job.scenario} seed=${job.seed}：${message}`);
          errors.push({ scenario: job.scenario, seed: job.seed, message });
        }
      }
    };
    const concurrency = Math.min(workers, jobs.length);
    await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  const scenarios = SCENARIOS.map((scenario) => {
    const matches = SEEDS.map((seed) => results.get(`${scenario}\u0000${seed}`)).filter(
      (match): match is BenchMatch => match !== undefined,
    );
    return aggregateScenarioMatches(scenario, SCENARIO_REGISTRY[scenario], SEEDS, TICKS, contestants, matches);
  });
  return { scenarios, errors };
}

/* ------------------------------------------------------------------ *
 * 分片/合并：--shard <i>/<n> + --merge <dir>
 * ------------------------------------------------------------------ */

/** --shard 解析（两种写法）：`--shard 0/2` 或 `--shard 0 --shard-total 2`。
 *  未提供返回 null。 */
function parseShardArg(): { readonly index: number; readonly total: number } | null {
  const raw = argValue("--shard");
  if (raw === undefined) return null;
  let indexRaw = raw;
  let totalRaw = argValue("--shard-total");
  if (raw.includes("/")) {
    if (totalRaw !== undefined) {
      throw new Error(`--shard 写法冲突：--shard <i>/<n> 与 --shard-total 不能同时使用`);
    }
    const parts = raw.split("/");
    if (parts.length !== 2) {
      throw new Error(`--shard 格式：--shard <i>/<n> 或 --shard <i> --shard-total <n>（got "${raw}"）`);
    }
    indexRaw = parts[0];
    totalRaw = parts[1];
  }
  if (totalRaw === undefined) {
    throw new Error(`--shard 需要 --shard-total <n>（或 --shard <i>/<n> 格式）`);
  }
  const index = Number(indexRaw);
  const total = Number(totalRaw);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 1 || index < 0 || index >= total) {
    throw new Error(`--shard <i>/<n> 要求 0 <= i < n 且 n >= 1（got i=${indexRaw}, n=${totalRaw}）`);
  }
  return { index, total };
}

/** 确定性均分切片：list 按 shardTotal 片连续均分（长度差 ≤ 1，单调不重叠，
 *  覆盖全列表）。同 i/n 永远得到同一集合——分片可合并的前提。 */
function shardSlice<T>(list: readonly T[], shardIndex: number, shardTotal: number): T[] {
  const start = Math.floor((shardIndex * list.length) / shardTotal);
  const end = Math.floor(((shardIndex + 1) * list.length) / shardTotal);
  return list.slice(start, end);
}

/** 分片结果文件（<runDir>/results.s<i>.json，schema arena.bench.shard.v1）。
 *  params 是完整的（全部场景×seeds，runId 由此决定），shard 只描述运行范围；
 *  matches 只含本片场次，perPlayer 保留完整 ledger——合并时据此重算画像。 */
interface ShardFile {
  readonly schema: "arena.bench.shard.v1";
  readonly shard: { readonly index: number; readonly total: number; readonly by: "scenario" | "seed" };
  readonly params: {
    readonly scenarios: readonly string[];
    readonly seeds: readonly number[];
    readonly ticks: number;
    readonly players: number;
    readonly rulesVersion: string;
  };
  readonly matches: readonly BenchMatch[];
  readonly errors: readonly MatchError[];
}

function shardFileName(index: number): string {
  return `results.s${index}.json`;
}

const SHARD_FILE_PATTERN = /^results\.s(\d+)\.json$/u;

/** 分片共享 runDir：只 mkdir 不删除——并发分片进程写同一目录（runId 由完整
 *  参数决定，各片一致）；不能用 prepareRunDir（其 --force 会删掉其他片的文件）。 */
function ensureShardRunDir(outputBase: string, runId: string): string {
  validateRunId(runId);
  const runDir = resolve(outputBase, runId);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

/** --merge <dir> 解析：相对 runs/sim 解析（也接受 runs/sim 前缀或绝对路径），
 *  必须已存在。 */
function resolveMergeRunDir(dataRoot: string, raw: string): string {
  const outputBase = resolveOutputBase(dataRoot, null);
  const parts = raw.split(/[\\/]+/u);
  const normalized = parts[0] === "runs" && parts[1] === "sim" ? parts.slice(2).join("/") : raw;
  const candidate = resolve(outputBase, normalized);
  if (relative(outputBase, candidate).startsWith("..")) {
    throw new Error(`--merge 目标必须在 runs/sim 下（got "${raw}"）`);
  }
  if (!existsSync(candidate)) {
    throw new Error(`--merge 目录不存在：${candidate}`);
  }
  return candidate;
}

/** 读目录下全部 results.s*.json，按分片号升序返回；无分片文件 fail-fast。 */
function readShardFiles(runDir: string): ShardFile[] {
  const names = readdirSync(runDir)
    .filter((name) => SHARD_FILE_PATTERN.test(name))
    .sort((a, b) => {
      const aIndex = Number(a.match(SHARD_FILE_PATTERN)![1]);
      const bIndex = Number(b.match(SHARD_FILE_PATTERN)![1]);
      return aIndex - bIndex;
    });
  if (names.length === 0) {
    throw new Error(`--merge 目录没有分片文件（期望 results.s*.json）：${runDir}`);
  }
  return names.map((name) => {
    const raw = JSON.parse(readFileSync(join(runDir, name), "utf8")) as Partial<ShardFile>;
    if (raw.schema !== "arena.bench.shard.v1") {
      throw new Error(`${name}: schema 不符（got ${String(raw.schema)}）`);
    }
    return raw as ShardFile;
  });
}

function sameRunParams(a: ShardFile["params"], b: ShardFile["params"]): boolean {
  return (
    a.ticks === b.ticks &&
    a.players === b.players &&
    a.rulesVersion === b.rulesVersion &&
    a.scenarios.length === b.scenarios.length &&
    a.scenarios.every((scenario, index) => scenario === b.scenarios[index]) &&
    a.seeds.length === b.seeds.length &&
    a.seeds.every((seed, index) => seed === b.seeds[index])
  );
}

/** 分片模式：只跑本片（scenario 片 = 场景列表均分；seed 片 = seeds 列表均分）
 *  的全部对局，写 <runDir>/results.s<i>.json；不生成报告/图（由 --merge 统一做）。 */
async function runShardMode(
  shard: { readonly index: number; readonly total: number },
  shardBy: "scenario" | "seed",
): Promise<number> {
  const scenarios = shardBy === "scenario" ? shardSlice(SCENARIOS, shard.index, shard.total) : SCENARIOS;
  const seeds = shardBy === "seed" ? shardSlice(SEEDS, shard.index, shard.total) : SEEDS;
  const roster = buildRoster().contestants;
  console.log(
    `arena-bench-v3 分片 ${shard.index + 1}/${shard.total}（按${shardBy === "scenario" ? "场景" : "seed"}）：` +
      `本片 ${scenarios.length} 场景 × ${seeds.length} seeds × ${roster.length} 玩家，ticks=${TICKS}`,
  );
  const matches: BenchMatch[] = [];
  const errors: MatchError[] = [];
  for (const scenario of scenarios) {
    for (const seed of seeds) {
      try {
        matches.push(runSingleMatch(scenario, SCENARIO_REGISTRY[scenario], seed, TICKS, roster));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[shard ${shard.index}/${shard.total}] ${scenario} seed=${seed} 失败：${message}`);
        errors.push({ scenario, seed, message });
      }
    }
  }
  const dataRoot = resolveArenaDataRoot(REPO_ROOT, argValue("--data-root"), process.env.ARENA_DATA_ROOT);
  const outputBase = resolveOutputBase(dataRoot, null);
  const rosterSize = Math.min(PLAYERS, defaultContestants().length);
  // runId 由完整参数决定（与其它分片一致）→ 全部片落在同一 runDir
  const identity = { kind: "arena-bench-v3", scenarios: SCENARIOS, seeds: SEEDS, ticks: TICKS, players: rosterSize };
  const runId = `${OUT_PREFIX}-${sha256Json(identity).slice(0, 12)}`;
  const runDir = ensureShardRunDir(outputBase, runId);
  const shardFile: ShardFile = {
    schema: "arena.bench.shard.v1",
    shard: { index: shard.index, total: shard.total, by: shardBy },
    params: {
      scenarios: SCENARIOS,
      seeds: SEEDS,
      ticks: TICKS,
      players: rosterSize,
      rulesVersion: "v0.14",
    },
    matches,
    errors,
  };
  atomicWriteJson(join(runDir, shardFileName(shard.index)), shardFile);
  console.log(`分片完成：${matches.length} 场（${errors.length} 失败）`);
  console.log(`  分片数据：${join(runDir, shardFileName(shard.index))}`);
  console.log(`  全部片完成后合并：npx tsx scripts/run-arena-report.mts --merge ${relative(outputBase, runDir)}`);
  return 0;
}

/** 合并模式：读 <dir> 下全部分片，校验完整性（参数一致/无重叠/覆盖全笛卡尔集），
 *  重算聚合 + 榜单 + 画像，写完整 results.json + report.html，并调用出图脚本。 */
async function runMergeMode(rawDir: string): Promise<number> {
  const dataRoot = resolveArenaDataRoot(REPO_ROOT, argValue("--data-root"), process.env.ARENA_DATA_ROOT);
  const runDir = resolveMergeRunDir(dataRoot, rawDir);
  const shardFiles = readShardFiles(runDir);
  const params = shardFiles[0].params;
  for (const file of shardFiles) {
    if (!sameRunParams(file.params, params)) {
      throw new Error(
        `${shardFileName(file.shard.index)}: 参数与分片 0 不一致（scenarios/seeds/ticks/players 必须完全一致才能合并）`,
      );
    }
  }
  const total = shardFiles[0].shard.total;
  const by = shardFiles[0].shard.by;
  for (const file of shardFiles) {
    if (file.shard.total !== total || file.shard.by !== by) {
      throw new Error(`${shardFileName(file.shard.index)}: shard 元信息不一致（total/by 必须一致）`);
    }
  }
  for (let index = 0; index < total; index += 1) {
    if (!shardFiles.some((file) => file.shard.index === index)) {
      throw new Error(`缺少分片 ${index}/${total}（已找到：${shardFiles.map((f) => f.shard.index).join(",")}）`);
    }
  }
  for (const scenario of params.scenarios) {
    if (!(scenario in SCENARIO_REGISTRY)) {
      throw new Error(`分片含未知场景 "${scenario}"（与当前注册表不符）`);
    }
  }
  const seen = new Set<string>();
  const matchesByScenario = new Map<string, BenchMatch[]>();
  const errors: MatchError[] = [];
  for (const file of shardFiles) {
    for (const match of file.matches) {
      const key = `${match.scenario}\u0000${match.seed}`;
      if (seen.has(key)) {
        throw new Error(`场次重复（分片重叠）：${match.scenario} seed=${match.seed}`);
      }
      seen.add(key);
      const list = matchesByScenario.get(match.scenario);
      if (list === undefined) matchesByScenario.set(match.scenario, [match]);
      else list.push(match);
    }
    for (const error of file.errors) {
      const key = `${error.scenario}\u0000${error.seed}`;
      if (seen.has(key)) {
        throw new Error(`场次重复（分片重叠）：${error.scenario} seed=${error.seed}`);
      }
      seen.add(key);
      errors.push(error);
    }
  }
  const expected = new Set(params.scenarios.flatMap((scenario) => params.seeds.map((seed) => `${scenario}\u0000${seed}`)));
  const missing = [...expected].filter((key) => !seen.has(key));
  if (missing.length > 0) {
    const sample = missing.slice(0, 5).map((key) => key.replace("\u0000", " seed=")).join("；");
    throw new Error(`合并不完整：缺 ${missing.length} 场（如 ${sample}）。确认所有分片都已成功完成。`);
  }
  const contestants = defaultContestants();
  const roster = buildRosterForPlayers(params.players);
  const scenarios = params.scenarios.map((scenario) => {
    const matches = (matchesByScenario.get(scenario) ?? []).sort((a, b) => a.seed - b.seed);
    return aggregateScenarioMatches(scenario, SCENARIO_REGISTRY[scenario], params.seeds, params.ticks, roster, matches);
  });
  const generatedAt = new Date().toISOString();
  console.log(
    `merge：${shardFiles.length} 个分片 → ${scenarios.length} 场景 × ${params.seeds.length} seeds（errors=${errors.length}）`,
  );
  await writeRunArtifacts({
    runDir,
    generatedAt,
    scenarios,
    errors,
    contestants,
    rosterSize: params.players,
    seeds: params.seeds,
    ticks: params.ticks,
  });
  console.log(`  分片文件保留于 ${runDir}/results.s*.json（审计）`);
  return 0;
}

/** Python 出图脚本（scripts/arena_bench_plots.py，并行会话开发中）：
 *  契约 `python scripts/arena_bench_plots.py <results.json> --out <plots目录>`，
 *  在 <plots目录> 写 PNG/SVG。脚本不存在则跳过并注明（results.json 不受影响）。 */
async function maybeRunPlots(runDir: string): Promise<void> {
  const plotsScript = join(here, "arena_bench_plots.py");
  if (!existsSync(plotsScript)) {
    console.log("  plots：跳过（scripts/arena_bench_plots.py 尚不存在）");
    return;
  }
  const plotsDir = join(runDir, "plots");
  mkdirSync(plotsDir, { recursive: true });
  await new Promise<void>((resolvePromise) => {
    const child = spawn("python", [plotsScript, join(runDir, "results.json"), "--out", plotsDir], {
      cwd: PKG_ROOT,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    child.on("error", (error) => {
      console.warn(`  plots：python 启动失败：${error.message}`);
      resolvePromise();
    });
    child.once("exit", (code) => {
      if (code === 0) {
        console.log(`  plots：${plotsDir}`);
      } else {
        console.warn(`  plots：脚本退出码 ${code}（results.json/report.html 不受影响）`);
      }
      resolvePromise();
    });
  });
}

/** 组装并落盘完整报告（results.json + report.html + plots/）。串行/并行/合并
 *  三路径共用——保证合并结果与串行跑聚合逐字节一致（除 generatedAt/errors）。 */
async function writeRunArtifacts(args: {
  readonly runDir: string;
  readonly generatedAt: string;
  readonly scenarios: readonly ScenarioSummary[];
  readonly errors: readonly MatchError[];
  readonly contestants: readonly Contestant[];
  readonly rosterSize: number;
  readonly seeds: readonly number[];
  readonly ticks: number;
}): Promise<void> {
  const { runDir, generatedAt, scenarios, errors, contestants, rosterSize, seeds, ticks } = args;
  const leaderboardSection = buildLeaderboard(scenarios);

  // 五维画像：全部场景 × seeds 的 ledger 聚合 → 均值 → 画像 → 全体归一化
  const ledgerPool: Record<string, PlayerCostLedger[]> = {};
  for (const contestant of contestants) ledgerPool[contestant.id] = [];
  for (const scenario of scenarios) {
    for (const match of scenario.matches) {
      for (const [playerId, data] of Object.entries(match.perPlayer)) {
        const entryId = playerId.replace(/-s\d+$/u, "");
        ledgerPool[entryId]?.push(data.ledger);
      }
    }
  }
  const rawProfiles: Record<string, AgentProfile> = {};
  for (const contestant of contestants) {
    const pool = ledgerPool[contestant.id];
    if (pool === undefined || pool.length === 0) continue;
    rawProfiles[contestant.id] = computeAgentProfile(averageLedgers(pool), ticks);
  }
  const normalizedProfiles = normalizeProfiles(rawProfiles);

  const results = {
    schema: "arena.bench.report.v3",
    generatedAt,
    params: {
      scenarios: scenarios.map((scenario) => scenario.name),
      seeds,
      ticks,
      players: rosterSize,
      rulesVersion: "v0.14",
    },
    contestants: contestants.map((contestant) => ({
      id: contestant.id,
      label: contestant.label,
      kind: contestant.kind,
      configNote: contestant.configNote,
    })),
    scenarios: scenarios.map((scenario) => ({
      name: scenario.name,
      template: scenario.template,
      seedCount: scenario.seedCount,
      perEntry: scenario.perEntry,
      matches: scenario.matches.map((match) => ({
        seed: match.seed,
        winner: match.winner,
        rank: match.rank,
        killEvents: match.killEvents ?? [],
        ...(match.perTickSamples === undefined ? {} : { perTickSamples: match.perTickSamples }),
        perPlayer: Object.fromEntries(
          Object.entries(match.perPlayer).map(([playerId, data]) => [
            playerId,
            {
              kills: data.kills,
              firstKillTick: data.firstKillTick,
              aliveTicks: data.aliveTicks,
              harvested: data.harvested,
              deposited: data.deposited,
              damageDealt: data.damageDealt,
              beaconTicks: data.beaconTicks,
              unitsLost: data.unitsLost,
              finalPopulation: data.finalPopulation,
              finalResources: data.finalResources,
              populationPeak: data.populationPeak,
            },
          ]),
        ),
      })),
    })),
    leaderboard: leaderboardSection.main,
    /** 内置对照组（ts-aggressive/ts-safety）：v3.4 同榜裁决后为兼容字段——
     *  与主榜同一归一化池分数（0-1 无外推）、行 = 对照子集；新消费者读
     *  leaderboard（10 条一条龙）即可。 */
    leaderboardControl: leaderboardSection.control,
    /** v3 判定口径（审计 bench-fairness-audit-2026-08-09 §6 落地）：
     *  1) winner 与排名同链：存活→击杀→deposited→资源→人口（decideWinner
     *     加 kills + deposited 键，与 rankMatchPlayers 链一致——v3.3 补齐
     *     deposited tie-break，修复全员存活击杀平时 winner≠rank1 的系统矛盾）；
     *  2) 排名 tie-break：存活→击杀→deposited→资源→人口（并列不再落
     *     playerId 字典序，消除出生位噪声）；
     *  3) 综合分 = rank 60% + kill 30% + economy 10%（economy=resourcesPerTick
     *     min-max）；survivalMedian 20% 移除（同 tick 重生机制下恒 1.0）；
     *  4) 击杀归属保持 v2 口径（CORE_DESTROYED.destroyed_by，聚合层注释：
     *     最后 tick 偏置/同 tick 集火多记/sweep 伤害不入 damageDealt 账本——
     *     ≥20% 伤害占比归属需改结算层，v3 不实施，逐字节一致性优先）；
     *  5) 归一化池 = 全部参赛条目（含内置对照）——10 条同池 0-1 一条龙
     *     （v3.4 同榜裁决 2026-08-10，取代"对照套主榜基准外推 >1"口径；
     *     kind=builtin 徽章保留在条目上）。 */
    notes: [
      "winner/排名同链：存活→击杀→deposited→资源→人口（审计 §1.4/§6.4，v3.3 补齐 deposited）",
      "排名 tie-break 新增 deposited（累计存款）（审计 §6.4）",
      "综合分：rank 60% + kill 30% + economy 10%；survivalMedian 20% 移除（恒 1.0，审计 §1.2）",
      "击杀归属口径：destroyed_by 同 tick 集火多记/最后一击偏置保留（审计 §2d），聚合层注释",
      "同榜裁决（v3.4 2026-08-10）：内置 ts-aggressive/ts-safety 同池一条龙排序（10 条 0-1）",
    ],
    errors: errors.map((error) => ({
      scenario: error.scenario,
      seed: error.seed,
      error: error.message,
    })),
    profiles: Object.fromEntries(
      contestants
        .filter((contestant) => rawProfiles[contestant.id] !== undefined)
        .map((contestant) => [
          contestant.id,
          { raw: rawProfiles[contestant.id], normalized: normalizedProfiles[contestant.id] },
        ]),
    ),
  };
  atomicWriteJson(join(runDir, "results.json"), results);

  const reportHtml = buildReportHtml({
    ticks,
    seeds,
    players: rosterSize,
    generatedAt,
    contestants,
    scenarios,
    leaderboard: leaderboardSection,
    errors,
    rawProfiles,
    normalizedProfiles,
    runDir,
  });
  atomicWriteText(join(runDir, "report.html"), reportHtml);

  await maybeRunPlots(runDir);

  const totalMatches = scenarios.reduce((sum, scenario) => sum + scenario.matches.length, 0);
  if (errors.length > 0) {
    console.warn(`arena-bench 警告：${errors.length} 场失败（结果已标注）：`);
    for (const error of errors) {
      console.warn(`  - ${error.scenario} seed=${error.seed}：${error.message}`);
    }
  }
  console.log(`arena-bench ok: ${totalMatches} 场（${scenarios.length} 场景 × ${seeds.length} seeds）`);
  console.log(`  报告：${runDir}/report.html`);
  console.log(`  数据：${runDir}/results.json`);
}

/* ------------------------------------------------------------------ *
 * 报告组装：results.json + report.html
 * ------------------------------------------------------------------ */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "∞";
}

function fmtPct(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

/** min-max 归一化（span=0 时全 1）；返回映射函数。 */
function minMaxNormalize(values: readonly number[]): (value: number) => number {
  const finite = values.filter(Number.isFinite);
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (finite.length === 0 || max <= min) return () => 1;
  return (value) => (value - min) / (max - min);
}

/** 跨场景聚合榜单（v3.4 同榜裁决 2026-08-10）：**全部参赛条目**（含内置
 *  对照 ts-aggressive/ts-safety）同一归一化池 0-1 排序——内置条目同场参赛、
 *  数据真实（avgRank/killRate/资源全有），"分开两个榜"是被外推分数口径逼
 *  的，非设计本意；kind=builtin 徽章保留在条目上。归一化 min-max 在全部
 *  参赛行上做（10 条一条龙）；leaderboardControl 保留为兼容字段（同池分数、
 *  对照子集，旧消费者零改动降级）。 */
function buildLeaderboard(scenarios: readonly ScenarioSummary[]): LeaderboardSection {
  const contestants = defaultContestants();
  const contestantIds = contestants.map((contestant) => contestant.id);
  const rows: LeaderboardRow[] = [];
  for (const contestantId of contestantIds) {
    const stats = scenarios
      .map((scenario) => scenario.perEntry[contestantId])
      .filter((stats): stats is EntryScenarioStats => stats !== undefined);
    if (stats.length === 0) continue;
    rows.push({
      contestantId,
      avgRank: mean(stats.map((s) => s.avgRank)),
      killRate: mean(stats.map((s) => s.killRate)),
      survivalMedian: mean(stats.map((s) => s.survivalMedian)),
      rankScore: 0,
      killScore: 0,
      economyScore: 0,
      survivalScore: 0,
      composite: 0,
    });
  }
  const isControl = new Set(
    contestants.filter((contestant) => contestant.kind === "builtin").map((contestant) => contestant.id),
  );
  // 归一化池 = 全部参赛条目（10 条同池，0-1 无外推）
  const rankNormalize = minMaxNormalize(rows.map((row) => row.avgRank));
  const killNormalize = minMaxNormalize(rows.map((row) => row.killRate));
  // 经济维度与 rank/kill 同基准：条目级跨场景均值池 min-max（2026-08-10
  // 评分口径一致性修复——原实现用场景级全量池，与另两维基准不一致）。
  const economyNormalize = minMaxNormalize(
    rows.map((row) =>
      mean(
        scenarios
          .map((scenario) => scenario.perEntry[row.contestantId])
          .filter((stats): stats is EntryScenarioStats => stats !== undefined)
          .map((stats) => stats.resourcesPerTick),
      ),
    ),
  );
  const scoreRow = (row: LeaderboardRow): LeaderboardRow => {
    const ownEconomy = mean(
      scenarios
        .map((scenario) => scenario.perEntry[row.contestantId])
        .filter((stats): stats is EntryScenarioStats => stats !== undefined)
        .map((stats) => stats.resourcesPerTick),
    );
    const scored = {
      ...row,
      rankScore: 1 - rankNormalize(row.avgRank),
      killScore: killNormalize(row.killRate),
      economyScore: economyNormalize(ownEconomy),
      // v2 兼容：survivalScore 恒 1（span=0 时 minMaxNormalize 返回 () => 1）。
      survivalScore: 1,
    };
    return { ...scored, composite: 0.6 * scored.rankScore + 0.3 * scored.killScore + 0.1 * scored.economyScore };
  };
  const scoredAll = rows.map(scoreRow).sort((a, b) => b.composite - a.composite);
  return {
    main: scoredAll,
    control: scoredAll.filter((row) => isControl.has(row.contestantId)),
  };
}

/** 场景×条目排名热图：每场景内 avgRank min-max（1=最佳 → 绿）。 */
function rankHeatmap(scenarios: readonly ScenarioSummary[]): string {
  const rows = scenarios.map((scenario) => scenario.name);
  const cols = defaultContestants().map((contestant) => contestant.id);
  const cell: (row: string, col: string) => HeatmapCell = (row, col) => {
    const stats = scenarios.find((s) => s.name === row)?.perEntry[col];
    if (stats === undefined) return { value: 0, label: "" };
    const ranks = Object.values(scenarios.find((s) => s.name === row)!.perEntry)
      .map((s) => s.avgRank)
      .filter(Number.isFinite);
    const normalize = minMaxNormalize(ranks);
    return { value: 1 - normalize(stats.avgRank), label: `均排 ${fmt(stats.avgRank, 1)}` };
  };
  return heatmapSvg({ rows, cols, cell });
}

function killTableHtml(
  rows: readonly LeaderboardRow[],
  contestants: readonly Contestant[],
  scenarios: readonly ScenarioSummary[],
): string {
  const contestantOf = new Map(contestants.map((c) => [c.id, c]));
  const body = rows
    .map((row) => {
      const contestant = contestantOf.get(row.contestantId);
      const stats = scenarios
        .map((scenario) => scenario.perEntry[row.contestantId])
        .filter((stats): stats is EntryScenarioStats => stats !== undefined);
      const firstKill = stats.some((s) => s.firstKillTick !== null)
        ? fmt(mean(stats.map((s) => s.firstKillTick).filter((t): t is number => t !== null)))
        : "∞";
      const killMatches = stats.reduce((sum, s) => sum + s.killMatches, 0);
      const totalMatches = scenarios.reduce((sum, scenario) => sum + scenario.seedCount, 0);
      const controlTag = contestant?.kind === "builtin" ? " · 对照组" : "";
      return (
        `<tr>` +
        `<td>${escapeHtml(row.contestantId)}${controlTag}</td>` +
        `<td>${escapeHtml(contestant?.label ?? "")}</td>` +
        `<td>${fmt(row.killRate, 2)}</td>` +
        `<td>${firstKill}</td>` +
        `<td>${killMatches}/${totalMatches}</td>` +
        `<td class="muted">${escapeHtml(contestant?.configNote ?? "")}</td>` +
        `</tr>`
      );
    })
    .join("\n");
  return (
    `<table><thead><tr><th>条目</th><th>标签</th><th>killRate（场均击杀）</th>` +
    `<th>场均首杀 tick</th><th>击杀场次</th><th>配置</th></tr></thead><tbody>${body}</tbody></table>`
  );
}

function scenarioTablesHtml(scenarios: readonly ScenarioSummary[]): string {
  return scenarios
    .map((scenario) => {
      const rows = defaultContestants()
        .map((contestant) => {
          const stats = scenario.perEntry[contestant.id];
          if (stats === undefined) return "";
          return (
            `<tr>` +
            `<td>${escapeHtml(contestant.id)}</td>` +
            `<td>${fmt(stats.resourcesPerTick, 1)}</td>` +
            `<td>${fmt(stats.populationPeak, 1)}</td>` +
            `<td>${fmtPct(stats.survivalMedian)}</td>` +
            `<td>${fmt(stats.killRate, 2)}</td>` +
            `<td>${stats.firstKillTick === null ? "∞" : fmt(stats.firstKillTick, 0)}</td>` +
            `<td>${fmt(stats.avgRank, 1)}</td>` +
            `</tr>`
          );
        })
        .join("\n");
      return (
        `<div style="margin-bottom:20px">` +
        `<h3 style="margin:0 0 8px;font-size:15px">${escapeHtml(scenario.name)} ` +
        `（radius ${scenario.template.radius} · ${scenario.template.resources} · ` +
        `${scenario.template.randomDrop === true ? "randomDrop" : "圆周"} · ${scenario.seedCount} seeds）</h3>` +
        `<table><thead><tr><th>条目</th><th>资源/tick</th><th>人口峰值</th><th>存活中位</th>` +
        `<th>场均击杀</th><th>首杀 tick</th><th>均排</th></tr></thead><tbody>${rows}</tbody></table>` +
        `</div>`
      );
    })
    .join("\n");
}

function methodNotesHtml(
  contestants: readonly Contestant[],
  scenarios: readonly ScenarioSummary[],
  seeds: readonly number[],
  ticks: number,
  players: number,
): string {
  const scenarioLines = scenarios
    .map((s) => `${s.name}: radius=${s.template.radius}, 资源=${s.template.resources}${s.template.randomDrop === true ? ", randomDrop" : ""}`)
    .join("；");
  const entryLines = contestants
    .map((c) => `${c.id}（${c.kind}）：${c.configNote}`)
    .join("<br/>");
  return (
    `<div>场景模板（scripts/bench-scenarios.json）：${escapeHtml(scenarioLines)}</div>` +
    `<div>seeds=${seeds.join(",")} · ticks=${ticks} · 每场玩家数=${players}（取阵容前 ${Math.min(players, contestants.length)} 个）· 规则 v0.14</div>` +
    `<div>判定（每场，v3）：存活 → 击杀数 → 累计存款 deposited（v3 tie-break）→ 资源 → 人口；` +
    `并列同分同排（竞争式排名）。胜者 = 同链第 1 名（唯一时；并列 draw）——与排名判定统一` +
    `（v2 的 decideWinner 资源优先已加击杀键，审计 §1.4）。</div>` +
    `<div>击杀归属口径（v3 聚合层注释，审计 §2d）：CORE_DESTROYED.values.destroyed_by` +
    `（最终贡献伤害玩家的 username；合成场景 username=playerId；多贡献者同记一杀，` +
    `无贡献者不计）。已知局限：最后一 tick 偏置（早 100 tick 的伤害不算击杀归属）、` +
    `同 tick 集火多记（perPlayerKills 之和可能大于全场击毁数）、SWEEP 命中计入归属但` +
    `不入 damageDealt 账本——≥20% 伤害占比归属需改结算层（v3 不实施，逐字节一致性优先）。` +
    `首杀 tick = 首次被归属击杀的结算 tick。</div>` +
    `<div>指标（设计 §4）：killRate=场均击毁；firstKillTick=有击杀场次的场均首杀；` +
    `survivalMedian=aliveTicks/ticks 中位（v2 残留指标，恒 1.0 已退出权重）；` +
    `resourcesPerTick=harvested/aliveTicks；damagePerLoss=damageDealt/max(unitsLost,1)；` +
    `populationPeak=场均人口峰值；beaconTicks=beaconTicks/ticks 占比；avgRank=场均排名。` +
    `综合分（v3）=avgRank(反向 min-max)60% + killRate(min-max)30% + ` +
    `resourcesPerTick(min-max)10%（survivalMedian 20% 因同 tick 重生恒 1.0 移除，审计 §1.2）。</div>` +
    `<div>对照组：内置条目（ts-aggressive/ts-safety，kind=builtin）不参与主榜 composite ` +
    `排名，单独展示（leaderboardControl）——审计 §6.9 内置去特权。</div>` +
    `<div>条目配置：<br/>${entryLines}</div>`
  );
}

function buildReportHtml(args: {
  readonly ticks: number;
  readonly seeds: readonly number[];
  readonly players: number;
  readonly generatedAt: string;
  readonly contestants: readonly Contestant[];
  readonly scenarios: readonly ScenarioSummary[];
  readonly leaderboard: LeaderboardSection;
  readonly errors: readonly MatchError[];
  readonly rawProfiles: Readonly<Record<string, AgentProfile>>;
  readonly normalizedProfiles: Readonly<Record<string, AgentProfile>>;
  readonly runDir: string;
}): string {
  const { ticks, seeds, players, generatedAt, contestants, scenarios, leaderboard, errors, runDir } = args;
  const bars = barsSvg({
    title: "主榜（综合分 = avgRank 60% + killRate 30% + economy 10%；v3）",
    items: leaderboard.main.map((row) => ({
      label: row.contestantId,
      value: row.composite,
      detail: `均排 ${fmt(row.avgRank, 2)} · 击杀 ${fmt(row.killRate, 2)}/场 · 经济 ${fmt(row.economyScore, 2)}`,
    })),
  });
  const controlBars = barsSvg({
    title: "对照组（内置条目，不参与主榜 composite 排名）",
    items: leaderboard.control.map((row) => ({
      label: row.contestantId,
      value: row.composite,
      detail: `均排 ${fmt(row.avgRank, 2)} · 击杀 ${fmt(row.killRate, 2)}/场 · 经济 ${fmt(row.economyScore, 2)}`,
    })),
  });
  const heatmap = rankHeatmap(scenarios);
  const radars = contestants
    .map((contestant) => {
      const profile = args.normalizedProfiles[contestant.id];
      if (profile === undefined) return "";
      return radarSvg({ title: contestant.label, profile });
    })
    .join("\n");
  const scenarioTables = scenarioTablesHtml(scenarios);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>arena-bench-v3 Agent 评测报告</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --text:#e6edf3; --muted:#8b949e; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",sans-serif; }
  .wrap { max-width:1280px; margin:0 auto; padding:32px 24px 48px; }
  h1 { margin:0 0 6px; font-size:26px; font-weight:700; }
  .subtitle { color:var(--muted); font-size:13px; margin-bottom:8px; }
  .params { color:var(--muted); font-size:13px; font-family:ui-monospace,Menlo,Consolas,monospace; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px;
    padding:20px; margin:20px 0; overflow-x:auto; }
  .card h2 { margin:0 0 14px; font-size:18px; font-weight:600; }
  .radar-row { display:flex; flex-wrap:wrap; gap:14px; }
  .radar-row svg { border-radius:8px; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th, td { border:1px solid var(--border); padding:7px 10px; text-align:left; }
  th { background:#1c2128; color:var(--text); font-weight:600; white-space:nowrap; }
  tr:nth-child(even) td { background:#141a22; }
  .muted { color:var(--muted); font-size:11px; }
  footer { margin-top:28px; color:var(--muted); font-size:12px; line-height:1.7; }
</style>
</head>
<body>
<div class="wrap">
  <h1>arena-bench-v3 · Agent 评测报告（FFA 擂台标准化）</h1>
  <div class="subtitle">深色评测报告 · SVG 内嵌（无外部资源）· v3 判定（rank 60% + kill 30% + economy 10%）</div>
  <div class="params">scenarios=${scenarios.map((s) => s.name).join(",")} · seeds=${seeds.join(",")} · ticks=${ticks} · players=${players} · ${generatedAt}</div>

  <section class="card">
    <h2>1. 综合榜单（主榜 composite，v3）</h2>
    ${bars}
    ${leaderboard.control.length === 0
      ? ""
      : `<h2 style="margin-top:18px">对照组（内置条目：不参与主榜 composite 排名，单独展示）</h2>
         ${controlBars}`}
  </section>

  <section class="card">
    <h2>2. 场景 × 条目平均排名热图（绿=排名靠前，每场景内归一化）</h2>
    ${heatmap}
  </section>

  <section class="card">
    <h2>3. 击杀率表（实战证明段）</h2>
    ${killTableHtml([...leaderboard.main, ...leaderboard.control], contestants, scenarios)}
  </section>

  <section class="card">
    <h2>4. 五维画像雷达图（全部场景 ledger 聚合 · 全体归一化）</h2>
    <div class="radar-row">${radars}</div>
  </section>

  <section class="card">
    <h2>5. 逐场景摘要</h2>
    ${scenarioTables}
  </section>

  ${errors.length === 0
    ? ""
    : `<section class="card"><h2>失败场次（${errors.length}，不计入聚合）</h2><ul>${errors
        .map((error) => `<li>${escapeHtml(error.scenario)} seed=${error.seed}：${escapeHtml(error.message)}</li>`)
        .join("")}</ul></section>`}

  <section class="card">
    <h2>6. 方法说明</h2>
    <div style="font-size:13px;line-height:1.8">${methodNotesHtml(contestants, scenarios, seeds, ticks, players)}</div>
  </section>

  <footer>
    <div>评测方法：FFA 擂台标准化跑批——场景模板 × 阵容 × seed 笛卡尔；每场 runFreeForAll
      （真实桥），场景 radius 圆周布局（randomDrop 场景由 seed 派生出生），
      scarce 变体 = 构建场景后每玩家资源盘减半（4→2）。规则版本 v0.14，refill 官方节奏 4 ticks。</div>
    <div>数据：${escapeHtml(runDir)}</div>
  </footer>
</div>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main(): Promise<number> {
  if (hasFlag("--help")) {
    console.log(
      `usage: npx tsx scripts/run-arena-report.mts ` +
      `[--scenarios ffa-std,ffa-dense] [--seeds 1,2,3,4,5] [--ticks 2000] ` +
      `[--players 8] [--workers N] [--out arena-bench] [--data-root PATH] [--force] ` +
      `[--pipeline] [--bridge-projection]\n` +
      `  --pipeline   P4g 决策流水线（prefetch 提前发起 tick N+1 决策，消除主线程每\n` +
      `               tick 同步等待桥决策的空闲；结果与串行逐字节一致，仅墙钟更快）\n` +
      `  --bridge-projection   R2 桥状态投影（白名单 agent 省略恒 null 字段，默认关）\n` +
      `分片/合并（并行跑批）：--shard <i>/<n>（或 --shard <i> --shard-total <n>）` +
      `[--shard-by scenario|seed]（默认 scenario）→ 只跑第 i 片\n` +
      `  --merge <runDir> → 合并全部分片（results.s*.json）为完整 results.json + report.html + plots`,
    );
    console.log(`scenario registry: ${Object.keys(SCENARIO_REGISTRY).join(", ")}`);
    return 0;
  }

  // 子进程模式：只跑单场并写结果 JSON（由 --workers 主进程分派）
  if (hasFlag("--worker")) {
    return runWorkerProcess();
  }

  // 分片/合并模式（互斥）
  const mergeArg = argValue("--merge");
  const shardArg = parseShardArg();
  if (mergeArg !== undefined && shardArg !== null) {
    throw new Error("--merge 与 --shard 互斥，二选一");
  }
  if (mergeArg !== undefined) return runMergeMode(mergeArg);
  if (shardArg !== null) return runShardMode(shardArg, SHARD_BY);

  const contestants = defaultContestants();
  const rosterSize = Math.min(PLAYERS, contestants.length);
  const generatedAt = new Date().toISOString();

  console.log(
    `arena-bench-v3：${SCENARIOS.length} 场景 × ${SEEDS.length} seeds × ${rosterSize} 玩家（阵容 ${contestants.length} 条目），ticks=${TICKS}，workers=${WORKERS}${PIPELINE ? "，pipeline=ON" : ""}`,
  );

  const roster = buildRoster().contestants;
  let scenarios: readonly ScenarioSummary[];
  let errors: readonly MatchError[];
  if (WORKERS > 1) {
    const parallel = await runScenarioBatchParallel(roster, WORKERS);
    scenarios = parallel.scenarios;
    errors = parallel.errors;
  } else {
    scenarios = SCENARIOS.map((name) =>
      runScenario(name, SCENARIO_REGISTRY[name], SEEDS, TICKS, roster),
    );
    errors = [];
  }

  const identity = {
    kind: "arena-bench-v3",
    scenarios: SCENARIOS,
    seeds: SEEDS,
    ticks: TICKS,
    players: rosterSize,
  };
  const dataRoot = resolveArenaDataRoot(REPO_ROOT, argValue("--data-root"), process.env.ARENA_DATA_ROOT);
  const outputBase = resolveOutputBase(dataRoot, null);
  const runId = `${OUT_PREFIX}-${sha256Json(identity).slice(0, 12)}`;
  const runDir = prepareRunDir(outputBase, runId, hasFlag("--force"));

  await writeRunArtifacts({ runDir, generatedAt, scenarios, errors, contestants, rosterSize, seeds: SEEDS, ticks: TICKS });
  return 0;
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  },
);
