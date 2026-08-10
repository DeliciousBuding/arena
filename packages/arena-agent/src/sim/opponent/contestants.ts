/**
 * 参赛条目注册表（arena-bench-v3 §3，2026-08-09 设计定稿）
 *
 * 默认阵容 10 条目：5 社区 agent 默认配置 + 3 战术配置变体 + 2 内置对照。
 * 变体配置支持性（2026-08-09，R1 探针实测）：三个变体均已查实 agent 属性路径
 * 并接线 ARENA_CFG_* env（core-mil/farmer-eco 由父会话接线，waaiging-agg 由
 * R1 补充 memory.mode 路径）——SDK 层（probe_tool）验证键有效；**桥端通道当前
 * 未生效**（opponent-bridge.py import 官方 SDK 无 config_overrides，ImportError
 * 被吞——R2 桥接线遗留，见 docs/design/arena-bench-v3.md §3/§6）。
 *
 * 2026-08-09 实测结论（变体参数支持性，证据见各 configNote）：
 *  - waaiging：registry construct.kwargs=[] 且无 decide_kwargs；SmartTactic
 *    __init__(memory=None, *, control_path=None) 无进攻参数——但实例属性
 *    memory.mode（TacticMemory.mode，MODE_DEVELOP 默认）可经点分键
 *    memory.mode 注入，MODE_AGGRESS="aggress" 即进攻模式开关（R1 发现）。
 *  - core：decide_kwargs=[target, mode]，mode 仅支持 control/harvest
 *    （harvest=达 target 即止），无 military 值——变体用 target 缩短发育期
 *    （bridge CLI --mode choices 同此限制）。
 *  - farmer：construct.kwargs 含 worker_target（默认 12），可注入 8/6 等
 *    低于默认的值（worker_target 构造校验上限 12 不影响 setattr 注入）。
 *
 * 内置对照（kind=builtin）不经过 Python 桥：ts-aggressive 用
 * DeterministicPlanner（构造同 episode.ts createPlanner deterministic 分支），
 * ts-safety 用保守 SafetyPlanner。二者为"对照组"：不参与主榜 composite 排名
 * （单独展示，见 run-arena-report buildLeaderboard）。
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

/** python 条目：以 baseAgent 注册名构造（变体条目经 SDK 配置注入通道
 *  （ARENA_CFG_* env）真参数化——见 docs/analysis/sdk-config-injection-patch.md）。 */
function pythonContestant(
  id: string,
  baseAgent: string,
  label: string,
  configNote: string,
  configEnv?: Record<string, string>,
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
        ...(configEnv !== undefined ? { env: configEnv } : {}),
      }),
  };
}

/** ts-aggressive 的军事压制参数（2026-08-07 用户导向"积累后爆兵前压"语义）。 */
const AGGRESSIVE_VANGUARD_RATIO = 0.8;
const AGGRESSIVE_ACCUMULATE_THRESHOLD = 30;

/** 默认阵容：5 社区默认 + 3 变体（SDK 注入接线）+ 2 内置对照 = 10 条目。 */
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
      "core（双策略指南）",
      "默认配置（VelvetEvening 社区指南 arena_core_agent，mode=harvest/target=30）",
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
      "SDK 注入（config-injection v3，R1 接线）：ARENA_CFG_MEMORY_MODE=aggress " +
        "（TacticMemory.mode 点分路径——进攻模式开关，默认 develop→aggress；" +
        "SDK 层探针验证有效，桥端通道待 R2，见 v3 文档 §条目）",
      { ARENA_CFG_MEMORY_MODE: "aggress" },
    ),
    pythonContestant(
      "core-mil",
      "core",
      "core-mil（军事变体）",
      "SDK 注入（config-injection v3）：ARENA_CFG_TARGET=20 + ARENA_CFG_MODE=harvest " +
        "（提前结束经济扩张，省资源转兵力投入——mode 无 military 值，用 target 缩短发育期；" +
        "SDK 层 decide_kwargs 覆盖验证有效，桥端通道待 R2，见 v3 文档 §条目）",
      { ARENA_CFG_TARGET: "20", ARENA_CFG_MODE: "harvest" },
    ),
    pythonContestant(
      "farmer-eco",
      "farmer",
      "farmer-eco（纯经济对照）",
      "SDK 注入（config-injection v3）：ARENA_CFG_WORKER_TARGET=8（低于默认 12，" +
        "纯经济发育对照——任务书指定值；SDK 层探针验证有效，桥端通道待 R2，" +
        "见 v3 文档 §条目）",
      { ARENA_CFG_WORKER_TARGET: "8" },
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
