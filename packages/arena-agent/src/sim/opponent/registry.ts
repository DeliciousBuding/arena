/**
 * Opponent Registry — 对手注册中心（2026-08-08，平台化）
 *
 * 统一入口把"对手名字/端点"解析为 TournEntry：内置 reference Python 对手
 * （farmer/core，经 python-agents.json + 常驻桥）与任意 HTTP 端点
 * （http:// 前缀 → HttpDecider，任何语言服务可当对手）。
 *
 * 新增对手的两种路径：
 *  1. Python 脚本：scripts/python-agents.json 加条目（桥接零改动）；
 *  2. HTTP 服务：任何语言实现 POST {tick,state} → CommandPlan JSON，
 *     直接传端点（vs-arena --opponents http://host:port/decide）。
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { TournEntry } from "./tournament.ts";
import { OpponentAdapter, PersistentSubprocessDecider } from "./opponent-adapter.ts";
import { HttpDecider } from "./http-decider.ts";
import type { SafetyPlannerConfig } from "../../strategies/safety-planner.ts";
import { DEFAULT_SAFETY_CONFIG } from "../../strategies/safety-planner.ts";
import type { AggressionLevel } from "../../strategies/safety-planner-config.ts";
import type { PlanProvider } from "../../runtime/decision-types.ts";

/** 协调根 = 从本文件向上找到第一个含 reference/arena-hero-python 的目录
 *  （主工作树 6 级、.worktrees/<分支> 深一层——硬编码层级在 worktree 会落空）。 */
function findCoordinationRoot(from: string): string {
  let dir = from;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "reference", "arena-hero-python"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("coordination root (reference/arena-hero-python) not found");
}

export const COORDINATION_ROOT = findCoordinationRoot(fileURLToPath(new URL("..", import.meta.url)));
const FARMER_REPO = join(COORDINATION_ROOT, "reference", "arena-hero-agent");
const SDK_REPO = join(COORDINATION_ROOT, "reference", "arena-hero-python");

export type OpponentKind = "reference-python" | "http";

export interface OpponentSpec {
  readonly name: string;
  readonly desc: string;
  readonly kind: OpponentKind;
  /** reference-python 时：python-agents.json 注册名（farmer/core/自定义）。 */
  readonly pythonAgent?: string;
  /** http 时：POST {tick,state} → CommandPlan JSON 的端点。 */
  readonly endpoint?: string;
}

/** python-agents.json 注册表路径（单一事实源：Python 对手在此登记，TS 侧自动可见）。 */
const PYTHON_AGENTS_JSON = fileURLToPath(
  new URL("../../../scripts/python-agents.json", import.meta.url),
);

/** 从 python-agents.json 动态构建内置对手（注册表加条目 → TS 零改动可用）。 */
function loadBuiltinOpponents(): Readonly<Record<string, OpponentSpec>> {
  const raw = JSON.parse(readFileSync(PYTHON_AGENTS_JSON, "utf8")) as {
    agents: Readonly<Record<string, { readonly desc?: string }>>;
  };
  const builtin: Record<string, OpponentSpec> = {};
  for (const [name, entry] of Object.entries(raw.agents)) {
    builtin[name] = {
      name,
      desc: entry.desc ?? name,
      kind: "reference-python",
      pythonAgent: name,
    };
  }
  return builtin;
}

/** 内置对手（由 python-agents.json 驱动，勿手写列表）。 */
export const BUILTIN_OPPONENTS: Readonly<Record<string, OpponentSpec>> = loadBuiltinOpponents();

/** 解析对手名/端点：内置名 → 内置 spec；http:// 前缀 → HTTP spec。 */
export function resolveOpponent(name: string): OpponentSpec {
  if (name.startsWith("http://") || name.startsWith("https://")) {
    return { name, desc: `http:${name}`, kind: "http", endpoint: name };
  }
  const builtin = BUILTIN_OPPONENTS[name];
  if (builtin === undefined) {
    throw new Error(
      `unknown opponent ${name} (builtin: ${Object.keys(BUILTIN_OPPONENTS).join(", ")}; http:// 端点直接传 URL)`,
    );
  }
  return builtin;
}

/** 由 spec 构造可参赛条目（每 seed 独立 state-slot，随用随起）。 */
export function opponentEntry(spec: OpponentSpec, seed: number): TournEntry {
  const opponentId = `${spec.name}-s${seed}`;
  if (spec.kind === "http") {
    return {
      id: opponentId,
      desc: spec.desc,
      build: () => new OpponentAdapter(new HttpDecider(spec.endpoint!), opponentId, spec.name),
    };
  }
  const slotDir = join(tmpdir(), `arena-vs-${spec.pythonAgent}`);
  mkdirSync(slotDir, { recursive: true });
  return {
    id: opponentId,
    desc: spec.desc,
    build: () => {
      const decider = new PersistentSubprocessDecider({
        farmerRepoDir: FARMER_REPO,
        sdkRepoDir: SDK_REPO,
        farmerPath: join(FARMER_REPO, "arena_farmer.py"),
        stateSlot: join(slotDir, `slot-${seed}-${randomUUID()}.pkl`),
        agent: spec.pythonAgent as "farmer" | "core",
      });
      return new OpponentAdapter(decider, opponentId, spec.name);
    },
  };
}

/* ------------------------------------------------------------------ *
 * 我的策略版本注册表（strategy-versioning-v1，见根仓 docs/design/）
 * 注册名 → 版本源：config（当前代码+配置档）/ worktree-path（开发中）/
 * git-tag（已发布不可变，git archive 解包到缓存后 import）。
 * ------------------------------------------------------------------ */

/** 注册表条目（my-versions.json schema）。 */
export interface MyVersionEntry {
  readonly name: string;
  readonly desc: string;
  readonly kind: "config" | "git-tag" | "worktree-path";
  readonly gitTag?: string;
  readonly worktreePath?: string;
  /** 相对 arena-agent 根（config/worktree-path 类型）或 arena-agent 根相对仓内路径（git-tag 解包后）。 */
  readonly module: string;
  readonly config?: Readonly<Partial<SafetyPlannerConfig>>;
  readonly meta?: { readonly created?: string; readonly baseline?: boolean; readonly wip?: boolean };
}

const MY_VERSIONS_JSON = fileURLToPath(
  new URL("../../../scripts/my-versions.json", import.meta.url),
);

/** arena-ts 仓根（registry.ts 位于 packages/arena-agent/src/sim/opponent/）。 */
const ARENA_TS_ROOT = join(COORDINATION_ROOT, "arena-ts");
/** arena-agent 包根（当前 worktree 的，config 档在此解析模块）。 */
const ARENA_AGENT_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function loadMyVersions(): Readonly<Record<string, MyVersionEntry>> {
  const raw = JSON.parse(readFileSync(MY_VERSIONS_JSON, "utf8")) as {
    versions: Readonly<Record<string, Omit<MyVersionEntry, "name">>>;
  };
  const out: Record<string, MyVersionEntry> = {};
  for (const [name, entry] of Object.entries(raw.versions)) {
    out[name] = { name, ...entry };
  }
  return out;
}

/** 列出注册表全部版本（vs-arena --list-versions 用）。 */
export function listMyVersions(): readonly MyVersionEntry[] {
  return Object.values(loadMyVersions());
}

/** 材料化一个 git tag 到缓存目录（git archive + tar 解包，缓存命中即跳过）。 */
function materializeTag(tag: string): string {
  const cacheDir = join(tmpdir(), `arena-versions/${tag}`);
  const marker = join(cacheDir, ".ready");
  if (existsSync(marker)) return cacheDir;
  mkdirSync(cacheDir, { recursive: true });
  const tarOut = execFileSync("git", ["-C", ARENA_TS_ROOT, "archive", "--format=tar", tag,
    "packages/arena-agent/src", "packages/arena-agent/scripts"], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", cacheDir], { input: tarOut, stdio: "pipe", maxBuffer: 256 * 1024 * 1024 });
  writeFileSync(marker, new Date().toISOString());
  return cacheDir;
}

/** 从模块文件构造"我的版本"条目（动态 import，版本完全隔离）。 */
async function buildVersionEntry(
  modulePath: string,
  version: MyVersionEntry,
  id: string,
  aggression: "aggressive" | "defensive" | "balanced",
): Promise<TournEntry> {
  const modUrl = pathToFileURL(modulePath).href;
  let mod: { SafetyPlanner?: new (config?: SafetyPlannerConfig) => PlanProvider; DEFAULT_SAFETY_CONFIG?: SafetyPlannerConfig };
  try {
    mod = (await import(modUrl)) as { SafetyPlanner: new (config?: SafetyPlannerConfig) => PlanProvider; DEFAULT_SAFETY_CONFIG?: SafetyPlannerConfig };
  } catch (error) {
    throw new Error(`版本加载失败 ${modUrl}: ${String(error)}`);
  }
  const Pl = mod.SafetyPlanner;
  if (Pl === undefined) {
    throw new Error(`版本模块无 SafetyPlanner 导出：${modUrl}`);
  }
  // "balanced" 是运行时尚（AggressionLevel 仅 defensive/aggressive；balanced =
  // 保持默认攻击性 + attackForce 1 的折中档，与 vs-arena 语义一致）。
  const base: SafetyPlannerConfig = {
    ...(mod.DEFAULT_SAFETY_CONFIG ?? DEFAULT_SAFETY_CONFIG),
    ...(version.config ?? {}),
  };
  const finalAggression: AggressionLevel =
    aggression === "balanced" ? (base.aggression ?? "aggressive") : aggression;
  const frozen: SafetyPlannerConfig = {
    ...base,
    aggression: finalAggression,
    attackForce: aggression === "defensive" ? 0 : aggression === "balanced" ? 1 : 2,
  };
  return { id, desc: version.desc, build: () => new Pl(frozen) };
}

/** 解析注册表名 → 我的版本条目（config 档 = 当前代码库）。 */
export async function resolveVersion(
  name: string,
  aggression: "aggressive" | "defensive" | "balanced" = "aggressive",
): Promise<TournEntry> {
  const version = loadMyVersions()[name];
  if (version === undefined) {
    throw new Error(`unknown my-version ${name}（注册表：${Object.keys(loadMyVersions()).join(", ")}）`);
  }
  if (version.kind === "git-tag") {
    const cacheDir = materializeTag(version.gitTag!);
    return buildVersionEntry(
      join(cacheDir, "packages/arena-agent", version.module),
      version, `mine-${name}`, aggression,
    );
  }
  if (version.kind === "worktree-path") {
    return buildVersionEntry(
      join(version.worktreePath!, version.module),
      version, `mine-${name}`, aggression,
    );
  }
  return buildVersionEntry(join(ARENA_AGENT_ROOT, version.module), version, `mine-${name}`, aggression);
}
