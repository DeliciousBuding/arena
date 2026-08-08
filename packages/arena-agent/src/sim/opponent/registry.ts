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
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { TournEntry } from "./tournament.ts";
import { OpponentAdapter, PersistentSubprocessDecider } from "./opponent-adapter.ts";
import { HttpDecider } from "./http-decider.ts";

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

/** 内置对手（与 python-agents.json 同步维护）。 */
export const BUILTIN_OPPONENTS: Readonly<Record<string, OpponentSpec>> = {
  farmer: { name: "farmer", desc: "arena_farmer（榜二守矿型）", kind: "reference-python", pythonAgent: "farmer" },
  core: { name: "core", desc: "arena_core_agent（官方完整参考）", kind: "reference-python", pythonAgent: "core" },
};

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
