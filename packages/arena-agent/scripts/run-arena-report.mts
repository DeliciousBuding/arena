#!/usr/bin/env node
/**
 * run-arena-report — agent 评测跑批 + 报告组装 CLI（arena-bench-v2）
 *
 * 评测形态（arena-bench-v2，取代 v1 的 1v1 矩阵 + FFA 变体）：
 *   FFA 擂台标准化评测：场景模板 × 阵容（defaultContestants） × seed 笛卡尔跑批。
 *   - 场景模板注册表：scripts/bench-scenarios.json（radius/资源/randomDrop）
 *   - 阵容：src/sim/opponent/contestants.ts defaultContestants()（10 条目；
 *     --players N < 条目数取前 N 个，≥ 条目数全上）
 *   - 判定（每场）：存活 → 击杀数 → 资源 → 人口（击杀优先于发育，设计 §2）
 *   - 指标（每场景×条目，跨 seeds 聚合，设计 §4）：killRate / firstKillTick /
 *     survivalMedian / resourcesPerTick / damagePerLoss / populationPeak /
 *     beaconTicks / avgRank
 *   - 综合分：avgRank 60% + killRate 20% + survivalMedian 20% → 榜单
 * 报告：data/runs/sim/arena-bench-<id>/ 下 results.json（完整结构化数据）
 *       + report.html（深色主题，SVG 内嵌：综合榜单/场景×条目热图/雷达图）。
 *
 * 用法（cd packages/arena-agent）：
 *   npx tsx scripts/run-arena-report.mts \
 *     [--scenarios ffa-std,ffa-dense] [--seeds 1,2,3] [--ticks 2000] \
 *     [--players 8] [--out arena-bench] [--data-root PATH] [--force]
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  /** "standard" | "scarce"（scarce = 构建场景后每玩家资源盘减半，见 halveScenarioResources）。 */
  readonly resources: "standard" | "scarce";
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
    if (template.resources !== "standard" && template.resources !== "scarce") {
      throw new Error(`bench-scenarios.json: ${name}.resources must be "standard" or "scarce"`);
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
const SEEDS = intList(argValue("--seeds") ?? "1,2,3", "--seeds");
const SCENARIOS = scenarioList(argValue("--scenarios") ?? Object.keys(SCENARIO_REGISTRY).join(","), "--scenarios");
const PLAYERS = Number(argValue("--players") ?? 8);
if (!Number.isSafeInteger(PLAYERS) || PLAYERS < 2) {
  throw new Error(`--players must be a safe integer >= 2 (got ${String(argValue("--players"))})`);
}
const OUT_PREFIX = argValue("--out") ?? "arena-bench";

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
  readonly survivalMedian: number;
  readonly rankScore: number;
  readonly killScore: number;
  readonly survivalScore: number;
  /** 综合分 = avgRank 60% + killRate 20% + survivalMedian 20%（设计 §4）。 */
  readonly composite: number;
}

/* ------------------------------------------------------------------ *
 * 工具：排序 / 排名 / 聚合
 * ------------------------------------------------------------------ */

/** 竞争式排名（1,2,2,4）：sort key 存活 → 击杀 → 资源 → 人口（设计 §2，
 *  击杀优先于发育）。并列同分同排，下一名跳过。 */
function rankMatchPlayers(
  playerIds: readonly string[],
  result: ReturnType<typeof runFreeForAll>,
): Readonly<Record<string, number>> {
  interface ScoredPlayer {
    readonly playerId: string;
    readonly alive: boolean;
    readonly kills: number;
    readonly resources: number;
    readonly population: number;
  }
  const kills = result.perPlayerKills ?? {};
  const scored: ScoredPlayer[] = playerIds.map((playerId) => ({
    playerId,
    alive: result.coreAlive[playerId] ?? false,
    kills: kills[playerId] ?? 0,
    resources: result.finalResources[playerId] ?? 0,
    population: result.finalPopulation[playerId] ?? 0,
  }));
  scored.sort(
    (a, b) =>
      Number(b.alive) - Number(a.alive) ||
      b.kills - a.kills ||
      b.resources - a.resources ||
      b.population - a.population ||
      (a.playerId < b.playerId ? -1 : 1),
  );
  const sameScore = (a: ScoredPlayer, b: ScoredPlayer): boolean =>
    a.alive === b.alive && a.kills === b.kills && a.resources === b.resources && a.population === b.population;
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

/** 按 --players 裁剪阵容：N < 条目数取前 N 个；≥ 条目数全上。 */
function buildRoster(): { readonly contestants: readonly Contestant[] } {
  const all = defaultContestants();
  return { contestants: PLAYERS < all.length ? all.slice(0, PLAYERS) : all };
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
  return template.resources === "scarce" ? halveScenarioResources(scenario) : scenario;
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
    const entries = contestants.map((contestant) => contestant.entry(seed));
    const scenario = buildScenario(template, entries, seed);
    const result = runFreeForAll(entries, seed, ticks, RULES_PATH, { scenario });
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
    matches.push({ scenario: name, seed, winner: result.winner, rank, perPlayer });
  }

  // 跨 seeds 聚合（设计 §4；每个条目都出现在每场，缺失场次跳过）
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

/** 跨场景聚合榜单：avgRank（反向）/ killRate / survivalMedian 各自 min-max
 *  归一化后按 0.6/0.2/0.2 加权（设计 §4 综合分）。 */
function buildLeaderboard(scenarios: readonly ScenarioSummary[]): LeaderboardRow[] {
  const contestantIds = defaultContestants().map((contestant) => contestant.id);
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
      survivalScore: 0,
      composite: 0,
    });
  }
  const rankNormalize = minMaxNormalize(rows.map((row) => row.avgRank));
  const killNormalize = minMaxNormalize(rows.map((row) => row.killRate));
  const survivalNormalize = minMaxNormalize(rows.map((row) => row.survivalMedian));
  for (const row of rows) {
    row.rankScore = 1 - rankNormalize(row.avgRank);
    row.killScore = killNormalize(row.killRate);
    row.survivalScore = survivalNormalize(row.survivalMedian);
    row.composite = 0.6 * row.rankScore + 0.2 * row.killScore + 0.2 * row.survivalScore;
  }
  return rows.sort((a, b) => b.composite - a.composite);
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
      return (
        `<tr>` +
        `<td>${escapeHtml(row.contestantId)}</td>` +
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
): string {
  const scenarioLines = scenarios
    .map((s) => `${s.name}: radius=${s.template.radius}, 资源=${s.template.resources}${s.template.randomDrop === true ? ", randomDrop" : ""}`)
    .join("；");
  const entryLines = contestants
    .map((c) => `${c.id}（${c.kind}）：${c.configNote}`)
    .join("<br/>");
  return (
    `<div>场景模板（scripts/bench-scenarios.json）：${escapeHtml(scenarioLines)}</div>` +
    `<div>seeds=${SEEDS.join(",")} · ticks=${TICKS} · 每场玩家数=${PLAYERS}（取阵容前 ${Math.min(PLAYERS, contestants.length)} 个）· 规则 v0.14</div>` +
    `<div>判定（每场）：存活 → 击杀数 → 资源 → 人口；并列同分同排（竞争式排名）。</div>` +
    `<div>击杀归属：CORE_DESTROYED.values.destroyed_by（最终贡献伤害玩家的 username；` +
    `合成场景 username=playerId；多贡献者同记一杀，无贡献者不计——perPlayerKills 之和` +
    `可能小于全场击毁数）。首杀 tick = 首次被归属击杀的结算 tick。</div>` +
    `<div>指标（设计 §4）：killRate=场均击毁；firstKillTick=有击杀场次的场均首杀；` +
    `survivalMedian=aliveTicks/ticks 中位；resourcesPerTick=harvested/aliveTicks；` +
    `damagePerLoss=damageDealt/max(unitsLost,1)；populationPeak=场均人口峰值；` +
    `beaconTicks=beaconTicks/ticks 占比；avgRank=场均排名。` +
    `综合分=avgRank(反向 min-max)60% + killRate(min-max)20% + survivalMedian(min-max)20%。</div>` +
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
  readonly leaderboard: readonly LeaderboardRow[];
  readonly rawProfiles: Readonly<Record<string, AgentProfile>>;
  readonly normalizedProfiles: Readonly<Record<string, AgentProfile>>;
  readonly runDir: string;
}): string {
  const { ticks, seeds, players, generatedAt, contestants, scenarios, leaderboard, runDir } = args;
  const bars = barsSvg({
    title: "综合榜单（综合分 = avgRank 60% + killRate 20% + survivalMedian 20%）",
    items: leaderboard.map((row) => ({
      label: row.contestantId,
      value: row.composite,
      detail: `均排 ${fmt(row.avgRank, 2)} · 击杀 ${fmt(row.killRate, 2)}/场 · 存活 ${fmtPct(row.survivalMedian)}`,
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
<title>arena-bench-v2 Agent 评测报告</title>
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
  <h1>arena-bench-v2 · Agent 评测报告（FFA 擂台标准化）</h1>
  <div class="subtitle">深色评测报告 · SVG 内嵌（无外部资源）</div>
  <div class="params">scenarios=${scenarios.map((s) => s.name).join(",")} · seeds=${seeds.join(",")} · ticks=${ticks} · players=${players} · ${generatedAt}</div>

  <section class="card">
    <h2>1. 综合榜单（综合分）</h2>
    ${bars}
  </section>

  <section class="card">
    <h2>2. 场景 × 条目平均排名热图（绿=排名靠前，每场景内归一化）</h2>
    ${heatmap}
  </section>

  <section class="card">
    <h2>3. 击杀率表（实战证明段）</h2>
    ${killTableHtml(leaderboard, contestants, scenarios)}
  </section>

  <section class="card">
    <h2>4. 五维画像雷达图（全部场景 ledger 聚合 · 全体归一化）</h2>
    <div class="radar-row">${radars}</div>
  </section>

  <section class="card">
    <h2>5. 逐场景摘要</h2>
    ${scenarioTables}
  </section>

  <section class="card">
    <h2>6. 方法说明</h2>
    <div style="font-size:13px;line-height:1.8">${methodNotesHtml(contestants, scenarios)}</div>
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

function main(): number {
  if (hasFlag("--help")) {
    console.log(
      `usage: npx tsx scripts/run-arena-report.mts ` +
      `[--scenarios ffa-std,ffa-dense] [--seeds 1,2,3] [--ticks 2000] ` +
      `[--players 8] [--out arena-bench] [--data-root PATH] [--force]`,
    );
    console.log(`scenario registry: ${Object.keys(SCENARIO_REGISTRY).join(", ")}`);
    return 0;
  }

  const contestants = defaultContestants();
  const rosterSize = Math.min(PLAYERS, contestants.length);
  const generatedAt = new Date().toISOString();

  console.log(
    `arena-bench-v2：${SCENARIOS.length} 场景 × ${SEEDS.length} seeds × ${rosterSize} 玩家（阵容 ${contestants.length} 条目），ticks=${TICKS}`,
  );

  const roster = buildRoster().contestants;
  const scenarios = SCENARIOS.map((name) =>
    runScenario(name, SCENARIO_REGISTRY[name], SEEDS, TICKS, roster),
  );
  const leaderboard = buildLeaderboard(scenarios);

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
    rawProfiles[contestant.id] = computeAgentProfile(averageLedgers(pool), TICKS);
  }
  const normalizedProfiles = normalizeProfiles(rawProfiles);

  const identity = {
    kind: "arena-bench-v2",
    scenarios: SCENARIOS,
    seeds: SEEDS,
    ticks: TICKS,
    players: rosterSize,
  };
  const dataRoot = resolveArenaDataRoot(REPO_ROOT, argValue("--data-root"), process.env.ARENA_DATA_ROOT);
  const outputBase = resolveOutputBase(dataRoot, null);
  const runId = `${OUT_PREFIX}-${sha256Json(identity).slice(0, 12)}`;
  const runDir = prepareRunDir(outputBase, runId, hasFlag("--force"));

  const results = {
    schema: "arena.bench.report.v2",
    generatedAt,
    params: {
      scenarios: SCENARIOS,
      seeds: SEEDS,
      ticks: TICKS,
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
    leaderboard,
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
    ticks: TICKS,
    seeds: SEEDS,
    players: rosterSize,
    generatedAt,
    contestants,
    scenarios,
    leaderboard,
    rawProfiles,
    normalizedProfiles,
    runDir,
  });
  atomicWriteText(join(runDir, "report.html"), reportHtml);

  const totalMatches = scenarios.reduce((sum, scenario) => sum + scenario.matches.length, 0);
  console.log(`arena-bench ok: ${totalMatches} 场（${scenarios.length} 场景 × ${SEEDS.length} seeds）`);
  console.log(`  报告：${runDir}/report.html`);
  console.log(`  数据：${runDir}/results.json`);
  return 0;
}

process.exitCode = main();
