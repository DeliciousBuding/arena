/**
 * 声明式实验管线（2026-08-06 架构整理）：把散落实验脚本的重复样板
 * （场景工厂 × 变体 × seeds → EpisodeConfig → runEpisode → KPI 聚合 → txt 输出）
 * 收敛为"定义即实验"。实验脚本只声明场景、变体、KPI，管线负责跑批与报告。
 *
 * 用法：
 *   const report = runExperiment({
 *     id: "threat-recall",
 *     title: "威胁召回对打（p1 守方 on/off vs p2 aggressive）",
 *     scenario: (seed) => makeScenario(seed),
 *     variants: [
 *       { id: "recall-off", label: "p1 threatRecall=false", plannerConfig: { threatRecall: false } },
 *       { id: "recall-on", label: "p1 threatRecall=true", plannerConfig: { threatRecall: true } },
 *     ],
 *     seeds: [1, 2, 3],
 *     ticks: 300,
 *     refill: { everyTicks: 65 },
 *     extendedMetrics: (result, playerId) => ({ hits: ..., losses: ... }),
 *   });
 *   console.log(report.text);
 *
 * 输出：文本摘要（历史 *-result.txt 形态）+ 结构化 ExperimentReport（JSON）。
 */

import { writeFileSync } from "node:fs";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import {
  runEpisode,
  type EpisodeConfig,
  type EpisodeResult,
  type EpisodeTenant,
} from "../harness/episode.ts";
import type { SafetyPlannerConfig } from "../../strategies/safety-planner.ts";
import type { MacroPolicy } from "../../runtime/macro-policy.ts";
import { resolvePlannerVariant } from "./planner-variants.ts";

/** 实验变体：控制一方的 planner 行为。 */
export interface ExperimentVariantDef {
  /** 稳定 id（报告与归档用）。 */
  readonly id: string;
  /** 显示标签（文本摘要行首）。 */
  readonly label: string;
  /** 走变体注册表（resolvePlannerVariant）——已注册的命名变体。 */
  readonly plannerId?: string;
  /** 直接 SafetyPlanner 配置（threatRecall/moveFailedAvoidance 等布尔开关）。 */
  readonly plannerConfig?: Partial<SafetyPlannerConfig>;
  /** 低频策略注入（workerTarget/militaryRatio 等经济实验用，v0.2.12 通道）。 */
  readonly policy?: MacroPolicy;
  /** 按变体微调场景（rich 等），返回新场景。 */
  readonly scenarioModifier?: (scenario: unknown, seed: number) => unknown;
}

export interface ExperimentDefinition {
  readonly id: string;
  readonly title: string;
  /** 场景工厂（seed → scenario JSON）。 */
  readonly scenario: (seed: number) => unknown;
  readonly variants: readonly ExperimentVariantDef[];
  readonly seeds: readonly number[];
  readonly ticks: number;
  readonly rulesPath?: string;
  /** 实验侧 refill 近似（校准 cadence 65 等）。 */
  readonly refill?: { readonly everyTicks: number };
  /** 参与 A/B 的玩家（场景全部玩家；管线不做场景内省）。 */
  readonly players: readonly string[];
  /**
   * 自定义 KPI 提取（hits/losses 等事件口径），按玩家返回指标。
   * 不提供时报告只含内置指标（res/pop/delta/illegal）。
   */
  readonly extendedMetrics?: (result: EpisodeResult, playerId: string) => Record<string, number>;
  /** 输出路径（默认 `<id>-result.txt`，工作目录）。 */
  readonly outputPath?: string;
}

export interface ExperimentVariantRun {
  readonly variant: string;
  readonly seed: number;
  /** 参与玩家各自的内置 + 扩展指标。 */
  readonly players: Readonly<Record<string, Record<string, number>>>;
  readonly illegalPlans: number;
  readonly inconclusive: boolean;
}

export interface ExperimentVariantAggregate {
  readonly variant: string;
  readonly label: string;
  readonly runs: number;
  /** 玩家级指标按 seed 均值。 */
  readonly players: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface ExperimentReport {
  readonly schema: "sim.experiment-report.v1";
  readonly id: string;
  readonly title: string;
  readonly ticks: number;
  readonly seeds: readonly number[];
  readonly variants: readonly string[];
  readonly runs: readonly ExperimentVariantRun[];
  readonly aggregates: readonly ExperimentVariantAggregate[];
  /** 文本摘要（历史 *-result.txt 形态，人工阅读）。 */
  readonly text: string;
}

const DEFAULT_RULES_PATH = "src/sim/contracts/rules-v0.11.json";

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function builtinMetrics(result: EpisodeResult, playerId: string): Record<string, number> {
  const player = result.finalWorld.players.get(playerId);
  if (player === undefined) return {};
  return {
    finalResources: player.resources,
    finalPopulation: player.units.length,
  };
}

function collectMetrics(
  def: ExperimentDefinition,
  result: EpisodeResult,
  playerIds: readonly string[],
): Record<string, Record<string, number>> {
  const collected: Record<string, Record<string, number>> = {};
  for (const playerId of playerIds) {
    const base = builtinMetrics(result, playerId);
    const extra = def.extendedMetrics?.(result, playerId) ?? {};
    collected[playerId] = { ...base, ...extra };
  }
  return collected;
}

/** 跑完整实验：全部 variant × seed，聚合均值并生成文本摘要。 */
export function runExperiment(def: ExperimentDefinition): ExperimentReport {
  const seeds = [...new Set(def.seeds)].sort((a, b) => a - b);
  if (seeds.length === 0) throw new Error("experiment requires at least one seed");
  if (def.variants.length === 0) throw new Error("experiment requires at least one variant");
  const rulesPath = def.rulesPath ?? DEFAULT_RULES_PATH;

  const playerIds = [...new Set(def.players)].sort(compareCodeUnit);
  if (playerIds.length === 0) throw new Error("experiment requires at least one player");

  const runs: ExperimentVariantRun[] = [];
  for (const variant of def.variants) {
    for (const seed of seeds) {
      const baseScenario = def.scenario(seed);
      const scenario = variant.scenarioModifier?.(baseScenario, seed) ?? baseScenario;
      // 命名变体走注册表注入（与 runAB 同一注入点）；plannerConfig 变体走
      // safety + plannerConfig（历史实验形态）。两者都让 EpisodeTenant.planner
      // 保持确定性/安全语义，行为差异由 plannerFactory/plannerConfig 表达。
      const registeredVariant =
        variant.plannerId !== undefined ? resolvePlannerVariant(variant.plannerId) : undefined;
      const tenants: EpisodeTenant[] = playerIds.map((id) => {
        if (registeredVariant !== undefined) {
          return { id, planner: "deterministic" };
        }
        if (variant.plannerConfig !== undefined) {
          return { id, planner: "safety", plannerConfig: variant.plannerConfig } as EpisodeTenant;
        }
        if (variant.policy !== undefined) {
          return { id, planner: "deterministic", policy: variant.policy } as EpisodeTenant;
        }
        return { id, planner: "deterministic" };
      });
      const config: EpisodeConfig = {
        scenario,
        rulesPath,
        seed,
        ticks: def.ticks,
        ...(def.refill !== undefined ? { refill: def.refill } : {}),
        tenants,
        ...(registeredVariant !== undefined
          ? { plannerFactory: (tenant) => registeredVariant.create(tenant.id) }
          : {}),
      };
      const result = runEpisode(config);
      const players = collectMetrics(def, result, playerIds);
      runs.push({
        variant: variant.id,
        seed,
        players,
        illegalPlans: result.metrics.illegalPlans,
        inconclusive: result.metrics.unsupported.length > 0,
      });
    }
  }

  const aggregates: ExperimentVariantAggregate[] = def.variants.map((variant) => {
    const matching = runs.filter((run) => run.variant === variant.id);
    const players: Record<string, Record<string, number>> = {};
    for (const playerId of playerIds) {
      const metricNames = [...new Set(matching.flatMap((run) => Object.keys(run.players[playerId] ?? {})))];
      const averaged: Record<string, number> = {};
      for (const name of metricNames) {
        averaged[name] = mean(
          matching.map((run) => run.players[playerId]?.[name] ?? 0),
        );
      }
      players[playerId] = averaged;
    }
    return { variant: variant.id, label: variant.label, runs: matching.length, players };
  });

  const text = renderText(def, aggregates, runs, playerIds);

  if (def.outputPath !== undefined) {
    writeFileSync(def.outputPath, text + "\n");
  }

  return {
    schema: "sim.experiment-report.v1",
    id: def.id,
    title: def.title,
    ticks: def.ticks,
    seeds,
    variants: def.variants.map((v) => v.id),
    runs,
    aggregates,
    text,
  };
}

function renderText(
  def: ExperimentDefinition,
  aggregates: readonly ExperimentVariantAggregate[],
  runs: readonly ExperimentVariantRun[],
  playerIds: readonly string[],
): string {
  const rows: string[] = [];
  rows.push(`${def.title}（${def.ticks} ticks × ${def.seeds.length} seeds）`);
  rows.push("=".repeat(84));
  for (const aggregate of aggregates) {
    const parts: string[] = [];
    for (const playerId of playerIds) {
      const metrics = aggregate.players[playerId] ?? {};
      for (const [name, value] of Object.entries(metrics)) {
        parts.push(`${playerId}.${name}=${value.toFixed(1)}`);
      }
    }
    rows.push(`${aggregate.label}: 均 ${parts.join(" ")}`);
    for (const run of runs.filter((r) => r.variant === aggregate.variant)) {
      const detail: string[] = [];
      for (const playerId of playerIds) {
        const metrics = run.players[playerId] ?? {};
        for (const [name, value] of Object.entries(metrics)) {
          detail.push(`${playerId}.${name}=${value.toFixed(1)}`);
        }
      }
      rows.push(`  seed ${run.seed}: ${detail.join(" ")}`);
    }
  }
  return rows.join("\n");
}
