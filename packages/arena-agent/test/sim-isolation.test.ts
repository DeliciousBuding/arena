/**
 * sim 隔离测试（S1）：checker self-test、CLI 输出路径策略、无凭据 smoke、workers 边界。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
const CHECKER = join(PKG_ROOT, "scripts", "check-sim-isolation.mjs");

function runChecker(args: readonly string[] = []): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [CHECKER, ...args], { encoding: "utf8", cwd: PKG_ROOT });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      code: e.status ?? 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
    };
  }
}

function runSim(args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const quoted = args.map((a) => `"${a.replaceAll('"', '\\"')}"`).join(" ");
  try {
    const stdout = execFileSync(`npx tsx src/cli/run-sim.ts ${quoted}`, {
      encoding: "utf8",
      cwd: PKG_ROOT,
      shell: true,
      env: { ...process.env, API_KEY: "", BASE_URL: "", WEBSOCKET_URL: "" },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      code: e.status ?? 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
    };
  }
}

test("S1: isolation checker self-test 能检出恶意 client import", () => {
  const result = runChecker(["--self-test"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /malicious client import \+ token both detected/);
});

test("S1: isolation checker 对当前 sim 目录通过", () => {
  const result = runChecker();
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /sim isolation OK/);
});

test("S1: no-op CLI 在无凭据环境下成功（无 .env 依赖）", () => {
  const result = runSim(["--ticks", "10", "--seed", "42"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /sim no-op ok: rules=v0\.11/);
});

test("S1: 输出落 runs/sim-* 且 manifest 为 sim.v1 schema", () => {
  const result = runSim(["--seed", "7"]);
  assert.equal(result.code, 0, result.stderr);
  const match = result.stdout.match(/out=(\S+)/);
  assert.ok(match, "output dir not reported");
  const runDir = match![1];
  assert.ok(runDir.includes(join(REPO_ROOT, "runs", "sim")));
  const manifestPath = join(runDir, "manifest.json");
  assert.ok(existsSync(manifestPath), "manifest.json missing");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schema, "sim.v1");
  assert.equal(manifest.rulesVersion, "v0.11");
  assert.equal(manifest.status, "no-op");
});

test("S1: 输出路径策略——绝对路径拒绝", () => {
  const result = runSim(["--output", resolve(REPO_ROOT, "runs", "sim-forbidden-abs")]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /absolute paths rejected/);
});

test("S1: 输出路径策略——路径穿越拒绝", () => {
  const result = runSim(["--output", "runs/sim/../run-other"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /path traversal rejected/);
});

test("S1: 输出路径策略——非 runs/sim-* 拒绝", () => {
  const result = runSim(["--output", "runs/run-other"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /must be under runs\/sim-\*/);
});

test("S1: workers 边界——0 与超上限拒绝", () => {
  assert.equal(runSim(["--workers", "0"]).code, 1);
  assert.equal(runSim(["--workers", "9"]).code, 1);
  assert.equal(runSim(["--workers", "8"]).code, 0);
});

test("S1: 非法参数拒绝", () => {
  assert.equal(runSim(["--ticks", "0"]).code, 1);
  assert.equal(runSim(["--ticks", "-1"]).code, 1);
  assert.equal(runSim(["--unknown"]).code, 1);
  assert.match(runSim(["--unknown"]).stderr, /unknown flag/);
});

test("S1: 运行前后 fixtures/mapstore 不被修改", () => {
  const fixtureDir = join(REPO_ROOT, "fixtures", "differential");
  const mapstore = join(REPO_ROOT, "mapstore");
  const snapshot = (dir: string): string | null => {
    if (!existsSync(dir)) return null;
    return readdirSync(dir, { recursive: true })
      .map((f) => {
        const p = join(dir, String(f));
        try {
          return `${String(f)}:${readFileSync(p).length}`;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .join("|");
  };
  const before = [snapshot(fixtureDir), snapshot(mapstore)];
  const result = runSim(["--ticks", "5"]);
  assert.equal(result.code, 0, result.stderr);
  const after = [snapshot(fixtureDir), snapshot(mapstore)];
  assert.deepEqual(after, before, "fixtures/mapstore modified by sim run");
});
