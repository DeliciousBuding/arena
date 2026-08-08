/**
 * vs-arena — 通用对抗矩阵 runner（2026-08-08，平台化；M2 2026-08-09）
 *
 * 从对手注册中心（registry.ts）拉取任意对手（内置 Python 参考 / HTTP 端点），
 * 与"我方案略"多 seed 对打；支持多版本对比（--me path: 跨 worktree 加载历史
 * 版本，--me2 第二版本 1v1/混战）、--matrix 交叉矩阵（多版本 × 多对手全组合
 * 1v1 + Wilson 95% CI）、场景/refill/落盘全配置。--record-dir 时按
 * evidence-v1 契约落盘 manifest.json + summary.json（rounds/ JSONL 保留）。
 *
 * 用法（cd packages/arena-agent）：
 *   npx tsx scripts/vs-arena.mts \
 *     [--me aggressive|defensive|balanced|path:<arena-agent 根>|<注册名>] \
 *     [--me2 aggressive|path:<arena-agent 根>]   # 第二版本（版本对比/同场混战） \
 *     [--matrix <版本1>,<版本2>,...]  # M2：交叉矩阵（每条目=“我”的版本，复用
 *                                     #      mineEntry 优先级：注册名>path:>配置档） \
 *     [--mode 1v1|ffa] \
 *     [--opponents farmer,core,waaiging,http://127.0.0.1:9000/decide] \
 *     [--seeds 1-8] [--ticks 200] \
 *     [--refill off|65|16|4|N]（默认 4=官方节奏） \
 *     [--scenario synthetic|survey:t1|survey:t1,t2,t3,t4] \
 *     [--record-dir <path>]
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";
import { runFreeForAll, runMatch, type TournEntry } from "../src/sim/opponent/tournament.ts";
import {
  COORDINATION_ROOT,
  opponentEntry,
  resolveOpponent,
  listMyVersions,
  lookupMyVersion,
  resolveVersion,
  validateMyVersions,
  currentEngineCommit,
  type OpponentSpec,
} from "../src/sim/opponent/registry.ts";
import {
  runMatrix,
  type MatrixComboResult,
  type MatrixOpponent,
  type MatrixVersion,
} from "../src/sim/opponent/matrix.ts";
import {
  buildSummary,
  writeEvidence,
  type EvidenceManifest,
  type EvidenceMode,
  type EvidenceParticipant,
  type EvidenceRound,
  type EvidenceSummary,
} from "../src/sim/opponent/evidence.ts";
import { formatWinRateCI, mean } from "../src/sim/opponent/stats.ts";
import {
  inWindow,
  makeSurveyScenario,
  pickWindow,
  readSurvey,
  WINDOW_SIZE,
} from "../src/sim/opponent/survey-scenario.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner, type SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const SURVEY_DIR = join(COORDINATION_ROOT, "data", "runtime", "survey");

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

const ME = argValue("--me") ?? "aggressive";
const MODE = argValue("--mode") ?? "1v1";
/** 版本对比分支（--me2 1v1）不消费 --opponents——显式传入时给指引，防静默丢对手。
 *  同场混战（--mode ffa）允许 --me2 + --opponents 同场参照（设计文档 §5 工作流 3）。 */
const ME2 = argValue("--me2");
if (ME2 !== undefined && argValue("--opponents") !== undefined && MODE !== "ffa") {
  console.error(
    `--me2 版本对比分支不接受 --opponents（对手不会参赛，横幅会撒谎）。\n` +
      `  1v1 版本对比：去掉 --opponents；\n` +
      `  带对手参照的同场混战：--mode ffa --me2 <版本> --opponents farmer,core,...`,
  );
  process.exit(1);
}
/** M2：交叉矩阵（每个条目都是"我"的一个版本，解析优先级同 mineEntry）。 */
const MATRIX_ARG = argValue("--matrix");
const MATRIX_SOURCES = MATRIX_ARG === undefined ? undefined : MATRIX_ARG.split(",");
if (MATRIX_SOURCES !== undefined) {
  if (argValue("--me") !== undefined) {
    console.error(
      `--matrix 已给出版本列表（${MATRIX_ARG}），--me 不适用——矩阵每一行版本来自 --matrix 条目。`,
    );
    process.exit(1);
  }
  if (ME2 !== undefined) {
    console.error(
      `--matrix 交叉矩阵与 --me2 版本对比分支互斥（矩阵条目本身已是"我"的多个版本）。\n` +
        `  交叉矩阵：--matrix <版本1>,<版本2>,... --opponents farmer,core,...\n` +
        `  版本对比：--me2 <版本>（无 --opponents）`,
    );
    process.exit(1);
  }
  if (MODE !== "1v1") {
    console.error(
      `--matrix 是 1v1 交叉矩阵（--mode 固定 1v1）。同场混战：--mode ffa --me2/--opponents。`,
    );
    process.exit(1);
  }
}
const OPPONENTS = (argValue("--opponents") ?? "farmer").split(",");
const TICKS = Number(argValue("--ticks") ?? 200);
const REFILL_RAW = argValue("--refill") ?? "4";
const REFILL_EVERY_TICKS: number | null =
  REFILL_RAW === "off" ? null : Number(REFILL_RAW);
const SCENARIO = argValue("--scenario") ?? "synthetic";
const RECORD_DIR = argValue("--record-dir");
const TIME_WINDOW_TICKS = Number(argValue("--window-ticks") ?? 5000);
const KEEP_HARVESTED = hasFlag("--keep-harvested");
const SEEDS_ARG = argValue("--seeds") ?? "1-8";
const SEEDS: number[] = (() => {
  const out: number[] = [];
  for (const part of SEEDS_ARG.split(",")) {
    const range = part.split("-").map(Number);
    if (range.length === 2) {
      for (let seed = range[0]; seed <= range[1]; seed += 1) out.push(seed);
    } else {
      out.push(range[0]);
    }
  }
  return out;
})();

/** --list-versions：列出注册表全部版本后退出。 */
if (hasFlag("--list-versions")) {
  console.log("我的策略版本注册表（my-versions.json，strategy-versioning-v1）：");
  for (const v of listMyVersions()) {
    const tag = v.kind === "git-tag" ? ` tag=${v.gitTag}` : "";
    const wip = v.meta?.wip === true ? " [WIP]" : "";
    const baseline = v.meta?.baseline === true ? " [baseline]" : "";
    console.log(`  ${v.name.padEnd(20)} ${v.kind.padEnd(13)}${tag}${baseline}${wip}  ${v.desc}`);
  }
  process.exit(0);
}

/** 注册表 schema 校验（fail-fast，防静默跑错版本）。 */
const versionErrors = validateMyVersions();
if (versionErrors.length > 0) {
  console.error("my-versions.json 校验失败：");
  for (const error of versionErrors) console.error(`  - ${error}`);
  process.exit(1);
}

/** 战绩可比窗口校验（M2）：当前 manifest 的 rulesVersion vs 注册条目记录的
 *  rulesVersion（缺省 v0.14）——不一致仅警告（不阻断），战绩跨规则窗口不可直接比较。 */
function readManifestRulesVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { rulesVersion?: string };
    return manifest.rulesVersion ?? "v0.14";
  } catch (error) {
    console.warn(`[rulesVersion] 读取 ${MANIFEST_PATH} 失败：${String(error)}——按 v0.14 处理`);
    return "v0.14";
  }
}
const RULES_VERSION = readManifestRulesVersion();
for (const version of listMyVersions()) {
  const recorded = version.rulesVersion ?? "v0.14";
  if (recorded !== RULES_VERSION) {
    console.warn(
      `[rulesVersion] ${version.name} 记录 rulesVersion=${recorded}，当前 manifest=${RULES_VERSION}——` +
        `该版本战绩与当前规则窗口不可直接比较`,
    );
  }
}

if (SEEDS.length === 0) {
  console.error(`--seeds ${SEEDS_ARG} 解析为空（例：1-8 / 1,3,5）`);
  process.exit(1);
}

/** 我方一个版本条目的构造参数（id/描述 + 版本源）。 */
interface MineSpec {
  readonly id: string;
  readonly desc: string;
  /** path: 时加载该 arena-agent 根的实现，否则为配置档（aggressive/defensive/balanced）。 */
  readonly source: string;
}

/** 解析后的"我的版本"（entry + 版本源元数据，供 evidence participants 用）。 */
interface MineResolved {
  readonly entry: TournEntry;
  readonly kind: "config" | "git-tag" | "worktree-path";
  readonly source: string;
}

/** 构造一个"我"的版本条目：注册表名（my-versions.json）> path: 跨 worktree > 配置档。
 *  aggression：source 本身是配置档（--me2 defensive 等）时用 source；否则取全局 ME 推导。 */
async function mineEntry(spec: MineSpec): Promise<MineResolved> {
  const isConfigTier = spec.source === "aggressive" || spec.source === "defensive" || spec.source === "balanced";
  const aggression = isConfigTier
    ? (spec.source as "aggressive" | "defensive" | "balanced")
    : (ME === "defensive" ? "defensive" : ME === "balanced" ? "balanced" : "aggressive");
  // 1) 注册表名（strategy-versioning-v1 平台）
  const registered = lookupMyVersion(spec.source);
  if (registered !== undefined) {
    const resolved = await resolveVersion(spec.source, aggression);
    return {
      entry: { id: spec.id, desc: resolved.desc, build: resolved.build },
      kind: registered.kind,
      source: spec.source,
    };
  }
  // 2) path: 跨 worktree 动态加载
  if (spec.source.startsWith("path:")) {
    const agentRoot = spec.source.slice("path:".length).replaceAll("\\", "/");
    const modUrl = pathToFileURL(
      join(agentRoot.replace(/\/+$/, ""), "src/strategies/safety-planner.ts"),
    ).href;
    let mod: { SafetyPlanner: unknown; DEFAULT_SAFETY_CONFIG?: SafetyPlannerConfig };
    try {
      mod = (await import(modUrl)) as {
        SafetyPlanner: new (config?: SafetyPlannerConfig) => { decide: unknown };
        DEFAULT_SAFETY_CONFIG?: SafetyPlannerConfig;
      };
    } catch (error) {
      console.error(`版本加载失败 ${modUrl}: ${String(error)}`);
      process.exit(1);
    }
    const base: SafetyPlannerConfig = {
      ...(mod.DEFAULT_SAFETY_CONFIG ?? DEFAULT_SAFETY_CONFIG),
    };
    if (aggression === "defensive") {
      base.aggression = "defensive";
      base.attackForce = 0;
    } else if (aggression === "balanced") {
      base.aggression = "balanced";
      base.attackForce = 1;
    } else {
      base.aggression = "aggressive";
      base.attackForce = 2;
    }
    const Pl = mod.SafetyPlanner as new (config?: SafetyPlannerConfig) => { decide: unknown };
    return {
      entry: { id: spec.id, desc: spec.desc, build: () => new Pl(base) },
      kind: "worktree-path",
      source: spec.source,
    };
  }
  // 3) 配置档（aggressive/defensive/balanced）
  const base: SafetyPlannerConfig = { ...DEFAULT_SAFETY_CONFIG };
  if (aggression === "defensive") {
    base.aggression = "defensive";
    base.attackForce = 0;
  } else if (aggression === "balanced") {
    base.aggression = "balanced";
    base.attackForce = 1;
  } else {
    base.aggression = "aggressive";
    base.attackForce = 2;
  }
  return {
    entry: {
      id: spec.id,
      desc: spec.desc,
      build: () => new SafetyPlanner(base),
    },
    kind: "config",
    source: spec.source,
  };
}

/** 场景来源：synthetic（合成布局）/ survey:t1,t2,...（真实测绘战区）。 */
function scenarioFor(seed: number, opponentId: string): unknown {
  if (!SCENARIO.startsWith("survey:")) return undefined;
  const tenants = SCENARIO.slice("survey:".length).split(",");
  const tenant = tenants[seed % tenants.length];
  const snapshot = readSurvey(join(SURVEY_DIR, `${tenant}.db`), tenant, TIME_WINDOW_TICKS, KEEP_HARVESTED);
  const window = pickWindow(snapshot.resources);
  const resourcesIn = snapshot.resources.filter((c) => inWindow(window.x0, window.y0, c.x, c.y));
  const obstaclesIn = snapshot.obstacles.filter((c) => inWindow(window.x0, window.y0, c.x, c.y));
  return makeSurveyScenario(window, resourcesIn, obstaclesIn, seed, opponentId);
}

const labelFor = (source: string): string =>
  source.startsWith("path:") ? `my safety @${source.slice("path:".length)}` : `my safety ${source}`;

/** 我方版本（非 matrix 模式：mine/mine2）。 */
let ours: MineResolved | null = null;
let ours2: MineResolved | null = null;
if (MATRIX_SOURCES === undefined) {
  const ME_DESC = labelFor(ME);
  const oursPromise = mineEntry({ id: "mine", desc: ME_DESC, source: ME });
  const ours2Promise = ME2 === undefined
    ? Promise.resolve(null)
    : mineEntry({ id: "mine2", desc: labelFor(ME2), source: ME2 });
  [ours, ours2] = await Promise.all([oursPromise, ours2Promise]);
}

const modeLabel = MODE === "ffa" ? "混战" : "vs";
if (MATRIX_SOURCES !== undefined) {
  console.log(
    `vs-arena：矩阵 ${MATRIX_ARG} × [${OPPONENTS.join(", ")}]（${TICKS} ticks × seeds[${SEEDS_ARG}]，` +
      `refill=${REFILL_RAW}，场景=${SCENARIO}）`,
  );
} else {
  console.log(
    `vs-arena：我方=${ours!.entry.desc}${ours2 !== null ? `；第二版本=${ours2.entry.desc}` : ""} ${modeLabel} [${OPPONENTS.join(", ")}]` +
      `（${TICKS} ticks × seeds[${SEEDS_ARG}]，refill=${REFILL_RAW}，场景=${SCENARIO}）`,
  );
}
console.log("=".repeat(96));

const wallStart = performance.now();

/* ------------------------------------------------------------------ *
 * Evidence（M2）：--record-dir 时按 evidence-v1 契约落盘。
 *  rounds 数组逐 seed；summary 含 wins/winRate/wilson95/meanResources；
 *  版本对比模式 seeds<12 时 summary 标 "underpowered": true。
 * ------------------------------------------------------------------ */

class EvidenceCollector {
  readonly rounds: EvidenceRound[] = [];
  private readonly wins = new Map<string, number>();
  private readonly matches = new Map<string, number>();
  private readonly resources = new Map<string, number[]>();

  /** 记录一局 + 累计统计。canonicalOf 把实际对局 player id 映射到 participants 规范 id
   *  （对手按 <name>-s<seed> 归并到 <name>）。 */
  add(round: EvidenceRound, canonicalOf: (playerId: string) => string): void {
    this.rounds.push(round);
    for (const [playerId, resource] of Object.entries(round.finalResources)) {
      const id = canonicalOf(playerId);
      this.matches.set(id, (this.matches.get(id) ?? 0) + 1);
      this.resources.set(id, [...(this.resources.get(id) ?? []), resource ?? 0]);
    }
    if (round.winner !== null) {
      const id = canonicalOf(round.winner);
      this.wins.set(id, (this.wins.get(id) ?? 0) + 1);
    }
  }

  summary(participants: readonly EvidenceParticipant[], underpowered = false): EvidenceSummary {
    const stats = new Map<string, { wins: number; matches: number; resources: readonly number[] }>();
    for (const participant of participants) {
      stats.set(participant.id, {
        wins: this.wins.get(participant.id) ?? 0,
        matches: this.matches.get(participant.id) ?? 0,
        resources: this.resources.get(participant.id) ?? [],
      });
    }
    return buildSummary(participants, stats, { underpowered });
  }
}

/** 跑完一批后按 evidence-v1 写 manifest.json + summary.json（JSONL 落盘保留）。 */
function finalizeEvidence(
  collector: EvidenceCollector,
  participants: readonly EvidenceParticipant[],
  mode: EvidenceMode,
  opts: { underpowered?: boolean } = {},
): void {
  if (RECORD_DIR === undefined) return;
  const manifest: EvidenceManifest = {
    schema: "arena-ts/evidence/v1",
    generatedAt: new Date().toISOString(),
    rulesVersion: RULES_VERSION,
    engineCommit: currentEngineCommit(),
    mode,
    refillEveryTicks: REFILL_EVERY_TICKS,
    scenario: SCENARIO,
    ticks: TICKS,
    seeds: SEEDS,
    participants,
    rounds: collector.rounds,
    summary: collector.summary(participants, opts.underpowered),
  };
  writeEvidence(RECORD_DIR, manifest);
  console.log(`证据已落盘：${join(RECORD_DIR, "manifest.json")} + summary.json（${collector.rounds.length} 局）`);
}

/** 对手 → MatrixOpponent（每 seed 独立条目，id 约定 <name>-s<seed>）。 */
function matrixOpponentOf(spec: OpponentSpec): MatrixOpponent {
  return {
    name: spec.name,
    desc: spec.desc,
    kind: spec.kind,
    source: spec.name,
    entry: (seed) => opponentEntry(spec, seed),
  };
}

/** 1v1 组合汇总表（每组合：胜率 + Wilson 95% CI + 均资源）。 */
function printComboTable(combos: readonly MatrixComboResult[]): void {
  for (const combo of combos) {
    const versionRate = formatWinRateCI(combo.versionWins, combo.matches.length);
    const opponentRate = formatWinRateCI(combo.opponentWins, combo.matches.length);
    console.log(
      `  ${combo.version.entry.desc.padEnd(30)} vs ${combo.opponent.desc}` +
        `  我胜率=${versionRate}  对手=${opponentRate}` +
        ` | 我均资源=${combo.versionMeanResources.toFixed(1)}  对手均资源=${combo.opponentMeanResources.toFixed(1)}`,
    );
  }
}

/** 1v1（含 --matrix 与单版本 --opponents）统一走交叉矩阵 runner。 */
function runOneVsOneMatrix(
  versions: readonly MatrixVersion[],
  opponents: readonly MatrixOpponent[],
  mode: EvidenceMode,
  label: string,
): void {
  if (RECORD_DIR !== undefined) mkdirSync(RECORD_DIR, { recursive: true });
  const combos = runMatrix(versions, opponents, SEEDS, {
    ticks: TICKS,
    rulesPath: MANIFEST_PATH,
    validatePlans: false,
    refillEveryTicks: REFILL_EVERY_TICKS,
    scenarioFor,
    recordDir: RECORD_DIR,
  });
  console.log(`矩阵汇总（${label}，seeds[${SEEDS_ARG}]）：`);
  printComboTable(combos);
  const participants: EvidenceParticipant[] = [
    ...versions.map((version) => ({
      id: version.entry.id,
      desc: version.entry.desc,
      kind: version.kind,
      source: version.source,
    })),
    ...opponents.map((opponent) => ({
      id: opponent.name,
      desc: opponent.desc,
      kind: opponent.kind,
      source: opponent.source,
    })),
  ];
  const collector = new EvidenceCollector();
  for (const combo of combos) {
    for (const match of combo.matches) {
      const opponentSeedId = `${combo.opponent.name}-s${match.seed}`;
      collector.add(
        {
          seed: match.seed,
          winner: match.result.winner,
          finalResources: match.result.finalResources,
          finalPopulation: match.result.finalPopulation,
          coreAlive: match.result.coreAlive,
        },
        (playerId) => (playerId === opponentSeedId ? combo.opponent.name : playerId),
      );
    }
  }
  finalizeEvidence(collector, participants, mode);
  const wallSec = (performance.now() - wallStart) / 1000;
  console.log("-".repeat(96));
  const totalMatches = combos.reduce((n, combo) => n + combo.matches.length, 0);
  console.log(`总耗时 ${wallSec.toFixed(1)}s（${((wallSec * 1000) / (TICKS * totalMatches)).toFixed(1)}ms/tick/局）`);
}

/** FFA 模式：我方（及可选第二版本）与全部对手同场混战，按参与方统计胜场。 */
if (MODE === "ffa") {
  const specs = OPPONENTS.map((name) => resolveOpponent(name));
  const participants: TournEntry[] = [ours!.entry, ...(ours2 !== null ? [ours2.entry] : [])];
  const wins = new Map<string, number>(participants.map((p) => [p.id, 0]));
  const finals = new Map<string, number[]>([
    ...specs.map((spec) => [spec.name, []] as [string, number[]]),
    ...participants.map((p) => [p.id, []] as [string, number[]]),
  ]);
  const evidenceParticipants: EvidenceParticipant[] = [
    ...participants.map((p) => ({
      id: p.id,
      desc: p.desc,
      kind: (p.id === "mine2" ? ours2!.kind : ours!.kind),
      source: (p.id === "mine2" ? ours2!.source : ours!.source),
    })),
    ...specs.map((spec) => ({ id: spec.name, desc: spec.desc, kind: spec.kind, source: spec.name })),
  ];
  const collector = new EvidenceCollector();
  for (const seed of SEEDS) {
    const entries = [...participants, ...specs.map((spec) => opponentEntry(spec, seed))];
    const recordTo =
      RECORD_DIR === undefined ? undefined : join(RECORD_DIR, `ffa-s${seed}.jsonl`);
    if (RECORD_DIR !== undefined) mkdirSync(RECORD_DIR, { recursive: true });
    const result = runFreeForAll(entries, seed, TICKS, MANIFEST_PATH, {
      validatePlans: false,
      refillEveryTicks: REFILL_EVERY_TICKS,
      ...(recordTo === undefined ? {} : { recordTo }),
    });
    if (result.winner !== null) {
      const winnerKey = specs.find((s) => result.winner === `${s.name}-s${seed}`)?.name;
      if (result.winner === "mine" || result.winner === "mine2" || winnerKey !== undefined) {
        const key = result.winner === "mine" || result.winner === "mine2" ? result.winner : winnerKey!;
        wins.set(key, (wins.get(key) ?? 0) + 1);
      }
    }
    for (const [key, values] of finals) {
      const playerId = key.startsWith("mine") ? key : `${key}-s${seed}`;
      values.push(result.finalResources[playerId] ?? 0);
    }
    collector.add(
      {
        seed,
        winner: result.winner,
        finalResources: result.finalResources,
        finalPopulation: result.finalPopulation,
        coreAlive: result.coreAlive,
      },
      (playerId) => specs.find((s) => playerId === `${s.name}-s${seed}`)?.name ?? playerId,
    );
  }
  for (const spec of specs) {
    console.log(
      `混战 ${spec.desc.padEnd(30)} 胜率=${formatWinRateCI(wins.get(spec.name) ?? 0, SEEDS.length)} | 均资源=${mean(finals.get(spec.name) ?? []).toFixed(1)}`,
    );
  }
  for (const p of participants) {
    console.log(
      `混战 ${p.desc.padEnd(30)} 胜率=${formatWinRateCI(wins.get(p.id) ?? 0, SEEDS.length)} | 均资源=${mean(finals.get(p.id) ?? []).toFixed(1)}`,
    );
  }
  finalizeEvidence(collector, evidenceParticipants, "ffa");
  const wallSec = (performance.now() - wallStart) / 1000;
  console.log("-".repeat(96));
  console.log(`总耗时 ${wallSec.toFixed(1)}s（${((wallSec * 1000) / (TICKS * SEEDS.length)).toFixed(1)}ms/tick/场）`);
} else if (ours2 !== null) {
  // 版本对比：我（mine）vs 第二版本（mine2），每 seed 1v1
  const wins = { mine: 0, mine2: 0 };
  const res = { mine: [] as number[], mine2: [] as number[] };
  const evidenceParticipants: EvidenceParticipant[] = [
    { id: ours!.entry.id, desc: ours!.entry.desc, kind: ours!.kind, source: ours!.source },
    { id: ours2.entry.id, desc: ours2.entry.desc, kind: ours2.kind, source: ours2.source },
  ];
  const collector = new EvidenceCollector();
  for (const seed of SEEDS) {
    const recordTo =
      RECORD_DIR === undefined ? undefined : join(RECORD_DIR, `v1v2-s${seed}.jsonl`);
    if (RECORD_DIR !== undefined) mkdirSync(RECORD_DIR, { recursive: true });
    const result = runMatch(ours!.entry, ours2.entry, seed, TICKS, MANIFEST_PATH, {
      validatePlans: false,
      refillEveryTicks: REFILL_EVERY_TICKS,
      ...(recordTo === undefined ? {} : { recordTo }),
    });
    if (result.winner === "mine") wins.mine += 1;
    else if (result.winner === "mine2") wins.mine2 += 1;
    res.mine.push(result.finalResources["mine"]);
    res.mine2.push(result.finalResources["mine2"]);
    collector.add(
      {
        seed,
        winner: result.winner,
        finalResources: result.finalResources,
        finalPopulation: result.finalPopulation,
        coreAlive: result.coreAlive,
      },
      (playerId) => playerId,
    );
  }
  console.log(`版本对比 ${ours!.entry.desc.padEnd(34)} 胜率=${formatWinRateCI(wins.mine, SEEDS.length)} | 均资源=${mean(res.mine).toFixed(1)}`);
  console.log(`版本对比 ${ours2.entry.desc.padEnd(34)} 胜率=${formatWinRateCI(wins.mine2, SEEDS.length)} | 均资源=${mean(res.mine2).toFixed(1)}`);
  finalizeEvidence(collector, evidenceParticipants, "version-compare", {
    underpowered: SEEDS.length < 12,
  });
  const wallSec = (performance.now() - wallStart) / 1000;
  console.log("-".repeat(96));
  console.log(`总耗时 ${wallSec.toFixed(1)}s（${((wallSec * 1000) / (TICKS * SEEDS.length)).toFixed(1)}ms/tick/局）`);
} else {
  // --matrix 交叉矩阵：多版本 × 多对手全组合（未给 --matrix 时退化为
  // 单版本 × 多对手，等价于原 --opponents 1v1 分支，id 保持 "mine"）。
  const sources: string[] = MATRIX_SOURCES ?? [ME];
  const seenIds = new Set<string>();
  const versions: MatrixVersion[] = await Promise.all(
    sources.map(async (source, index) => {
      const id =
        MATRIX_SOURCES === undefined
          ? "mine"
          : `mine-${source.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
      const uniqueId = (() => {
        if (!seenIds.has(id)) {
          seenIds.add(id);
          return id;
        }
        let suffix = `${id}-${index + 1}`;
        while (seenIds.has(suffix)) suffix = `${suffix}-${index + 1}`;
        seenIds.add(suffix);
        return suffix;
      })();
      const resolved = await mineEntry({ id: uniqueId, desc: labelFor(source), source });
      return { entry: resolved.entry, kind: resolved.kind, source: resolved.source };
    }),
  );
  const opponents = OPPONENTS.map((name) => matrixOpponentOf(resolveOpponent(name)));
  runOneVsOneMatrix(versions, opponents, "matrix", versions.map((v) => v.source).join(", "));
}
