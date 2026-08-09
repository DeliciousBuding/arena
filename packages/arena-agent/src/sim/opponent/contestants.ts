/**
 * 参赛条目注册表（arena-bench-v2 §3，2026-08-09 设计定稿）
 *
 * 默认阵容 10 条目：5 社区 agent 默认配置 + 3 战术配置变体 + 2 内置对照。
 * 变体的配置支持性以 python-agents.json / reference agent 实际字段为准，
 * 不支持的降级为"默认构造 + configNote 注明"（设计文档 §3 明确允许）。
 *
 * 2026-08-09 实测结论（全部降级，证据见各 configNote）：
 *  - waaiging：registry construct.kwargs=[] 且无 decide_kwargs；
 *    SmartTactic.__init__(memory=None, *, control_path=None)——无任何进攻参数。
 *  - core：decide_kwargs=[target, mode]，但 arena_core_agent.plan_turn 的
 *    mode 仅支持 control/harvest（harvest=达 target 即止、control=无限对局），
 *    无 military 值（bridge CLI --mode choices 同此限制）。
 *  - farmer：construct.kwargs 含 worker_target，但 MAX_WORKER_TARGET =
 *    PLANNED_POPULATION_CAP(20) − DEFENSE_VANGUARD_TARGET(4) −
 *    DEFENSE_RANGER_TARGET(4) = 12 = DEFAULT_WORKER_TARGET——默认即上限，
 *    无法拉高。
 *
 * 内置对照（kind=builtin）不经过 Python 桥：ts-aggressive 用
 * DeterministicPlanner（构造同 episode.ts createPlanner deterministic 分支），
 * ts-safety 用保守 SafetyPlanner。
 */
import type { TournEntry } from "./tournament.ts";
import { opponentEntry, resolveOpponent } from "./registry.ts";
import { DeterministicPlanner } from "../../planning/deterministic-planner.ts";
import { SafetyPlanner } from "../../strategies/safety-planner.ts";
import {
  AGGRESSIVE_SAFETY_CONFIG,
  DEFAULT_SAFETY_CONFIG,
} from "../../strategies/safety-planner-config.ts";

/** 参赛条目（arena-bench-v2 §3）：id 唯一、entry 每 seed 独立构造。 */
export interface Contestant {
  readonly id: string;
  /** 展示名（中文，如 "farmer（守矿）"）。 */
  readonly label: string;
  readonly kind: "python" | "builtin";
  /** 配置说明（默认/变体参数/降级说明）。 */
  readonly configNote: string;
  /** 每 seed 构造（python 走 opponentEntry，内置走 planner）。 */
  readonly entry: (seed: number) => TournEntry;
}

/** python 条目：以 baseAgent 注册名构造（变体条目 base agent 默认构造、仅覆盖
 *  id/desc——注册表本身不含变体名，见各变体 configNote 的降级说明）。 */
function pythonContestant(
  id: string,
  baseAgent: string,
  label: string,
  configNote: string,
): Contestant {
  return {
    id,
    label,
    kind: "python",
    configNote,
    entry: (seed) =>
      opponentEntry(resolveOpponent(baseAgent), seed, {
        id: `${id}-s${seed}`,
        desc: label,
      }),
  };
}

/** ts-aggressive 的军事压制参数（2026-08-07 用户导向"积累后爆兵前压"语义）。 */
const AGGRESSIVE_VANGUARD_RATIO = 0.8;
const AGGRESSIVE_ACCUMULATE_THRESHOLD = 30;

/** 默认阵容：5 社区默认 + 3 变体（降级）+ 2 内置对照 = 10 条目。 */
export function defaultContestants(): Contestant[] {
  return [
    pythonContestant(
      "farmer",
      "farmer",
      "farmer（守矿）",
      "默认配置（arena-hero-agent CoreFarmer，worker_target=12/beacon_policy=retreat）",
    ),
    pythonContestant(
      "core",
      "core",
      "core（官方参考）",
      "默认配置（arena-hero-guide arena_core_agent，mode=harvest/target=30）",
    ),
    pythonContestant(
      "waaiging",
      "waaiging",
      "waaiging（战术）",
      "默认配置（arena-hero-clone-waaiging SmartTactic）",
    ),
    pythonContestant(
      "tactic",
      "tactic",
      "tactic（均衡防守）",
      "默认配置（arena-hero-tactic）",
    ),
    pythonContestant(
      "arena-evolve",
      "arena-evolve",
      "arena-evolve（进化冠军）",
      "默认冠军（arena-evolve evolve_v7_best）",
    ),
    pythonContestant(
      "waaiging-agg",
      "waaiging",
      "waaiging-agg（进攻变体）",
      "降级：注册表 construct.kwargs=[] 且无 decide_kwargs；SmartTactic 仅接受 " +
        "memory/control_path——无进攻参数可注入，entry 用默认构造",
    ),
    pythonContestant(
      "core-mil",
      "core",
      "core-mil（军事变体）",
      "降级：decide_kwargs 仅 target/mode，mode 实际支持 control/harvest（harvest=达 " +
        "target 即止、control=无限对局），无 military 值——entry 用默认构造",
    ),
    pythonContestant(
      "farmer-eco",
      "farmer",
      "farmer-eco（纯经济对照）",
      "降级：worker_target 默认即上限 12（MAX_WORKER_TARGET=20−4−4=12），无法拉高——" +
        "entry 用默认构造",
    ),
    {
      id: "ts-aggressive",
      label: "ts-aggressive（内置军事压制）",
      kind: "builtin",
      configNote:
        `内置对照：AGGRESSIVE_SAFETY_CONFIG + vanguardRatio=${AGGRESSIVE_VANGUARD_RATIO} ` +
        `+ accumulateThreshold=${AGGRESSIVE_ACCUMULATE_THRESHOLD}（积累期只产 Worker，` +
        "达标后全 Vanguard 爆兵前压）",
      entry: () => {
        const safetyConfig = { ...AGGRESSIVE_SAFETY_CONFIG };
        return {
          id: "ts-aggressive",
          desc: "ts-aggressive（内置军事压制）",
          build: () =>
            new DeterministicPlanner(
              undefined,
              new SafetyPlanner(safetyConfig),
              new SafetyPlanner(safetyConfig),
              AGGRESSIVE_VANGUARD_RATIO,
              AGGRESSIVE_ACCUMULATE_THRESHOLD,
            ),
        };
      },
    },
    {
      id: "ts-safety",
      label: "ts-safety（内置保守发育）",
      kind: "builtin",
      configNote: "内置对照：DEFAULT_SAFETY_CONFIG 保守配置（不主动前压，防守+发育）",
      entry: () => ({
        id: "ts-safety",
        desc: "ts-safety（内置保守发育）",
        build: () => new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
      }),
    },
  ];
}
