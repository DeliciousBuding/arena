/**
 * sim CLI 最小骨架（S1）：无网络提交能力的模拟器入口。
 *
 * S1 阶段仅支持 no-op scenario：加载规则 manifest → 校验输出路径策略 →
 * 写 runs/sim-<id>/manifest.json（schema sim.v1）→ 退出。
 * 结算引擎（S2+）接入后在同一入口扩展。
 *
 * 隔离边界（S1 起即强制）：
 * - 不读 .env、不 import SDK client、不创建 writer lock、不监听端口；
 * - 输出只允许写入 runs/sim-*（拒绝绝对路径与路径穿越）；
 * - 凭据只可能来自环境变量——本入口根本不读它们。
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRulesManifest, assertRulesSupported } from "../sim/contracts/rules-manifest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..", "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
const MANIFEST_PATH = join(PKG_ROOT, "src", "sim", "contracts", "rules-v0.11.json");

const SUPPORTED_RULES_VERSION = "v0.11";
const DEFAULT_WORKERS = 1;
const MAX_WORKERS = 8;
const SIM_SCHEMA_PREFIX = "sim.v1";

interface CliArgs {
  readonly scenario: string | null;
  readonly ticks: number;
  readonly seed: number;
  readonly output: string | null;
  readonly workers: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { scenario: null, ticks: 1, seed: 1, output: null, workers: DEFAULT_WORKERS };
  const mutable: {
    scenario: string | null;
    ticks: number;
    seed: number;
    output: string | null;
    workers: number;
  } = { ...args };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--scenario":
        if (value === undefined) throw new Error("--scenario requires a path");
        mutable.scenario = value;
        i += 1;
        break;
      case "--ticks": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new Error("--ticks must be a positive integer");
        mutable.ticks = n;
        i += 1;
        break;
      }
      case "--seed": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) throw new Error("--seed must be a non-negative integer");
        mutable.seed = n;
        i += 1;
        break;
      }
      case "--output":
        if (value === undefined) throw new Error("--output requires a path");
        mutable.output = value;
        i += 1;
        break;
      case "--workers": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new Error("--workers must be a positive integer");
        if (n > MAX_WORKERS) throw new Error(`--workers exceeds conservative cap ${MAX_WORKERS}`);
        mutable.workers = n;
        i += 1;
        break;
      }
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  return { ...mutable };
}

/** 输出路径策略：只允许 runs/sim-*（相对仓库根）；拒绝绝对路径与 .. 穿越。 */
function resolveOutputDir(raw: string | null): string {
  if (raw === null) {
    return join(REPO_ROOT, "runs", "sim-default");
  }
  if (isAbsolute(raw)) {
    throw new Error("output must be relative to repo root (absolute paths rejected: isolation policy)");
  }
  if (raw.includes("..")) {
    throw new Error("output path traversal rejected (.. not allowed)");
  }
  const resolved = resolve(REPO_ROOT, raw);
  const runsSim = resolve(REPO_ROOT, "runs", "sim");
  if (!resolved.startsWith(runsSim)) {
    throw new Error(`output must be under runs/sim-* (got ${raw})`);
  }
  return resolved;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const manifest = loadRulesManifest(MANIFEST_PATH);
  assertRulesSupported(manifest, SUPPORTED_RULES_VERSION);

  const outputDir = resolveOutputDir(args.output);
  const runId = `sim-${args.seed}-${Date.now().toString(36)}`;
  const runDir = join(outputDir, runId);
  mkdirSync(runDir, { recursive: true });

  const manifestRecord = {
    schema: SIM_SCHEMA_PREFIX,
    kind: "run-manifest",
    runId,
    rulesVersion: manifest.rulesVersion,
    rulesManifestHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 16),
    scenario: args.scenario,
    ticks: args.ticks,
    seed: args.seed,
    workers: args.workers,
    status: "no-op",
    note: "S1 skeleton: settlement engine not yet attached",
  };
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifestRecord, null, 2) + "\n");

  console.log(
    `sim no-op ok: rules=${manifest.rulesVersion} ticks=${args.ticks} seed=${args.seed} ` +
      `workers=${args.workers} out=${runDir}`,
  );
}

try {
  main();
} catch (error) {
  console.error(`sim: ${(error as Error).message}`);
  process.exit(1);
}
