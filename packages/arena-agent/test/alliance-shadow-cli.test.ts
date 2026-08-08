import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

async function runCli(file: string, args: readonly string[], env = process.env): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", resolve(PACKAGE_ROOT, "src", "cli", file), ...args], {
    cwd: PACKAGE_ROOT, stdio: ["ignore", "pipe", "pipe"], env,
  });
  let output = "";
  child.stdout!.on("data", (chunk) => { output += String(chunk); });
  child.stderr!.on("data", (chunk) => { output += String(chunk); });
  const code = await new Promise<number | null>((done) => child.once("exit", done));
  return { code, output };
}

test("alliance shadow CLI wiring: supervisor child args + tenant runtime options 都存在", () => {
  const supervisor = readFileSync(resolve(PACKAGE_ROOT, "src", "cli", "run-supervisor.ts"), "utf8");
  const tenant = readFileSync(resolve(PACKAGE_ROOT, "src", "cli", "run-tenant.ts"), "utf8");
  assert.match(supervisor, /tenantArgs\.push\("--record-alliance-shadow"\)/);
  assert.match(supervisor, /--alliance-shadow-interval-ticks=\$\{allianceShadowInterval\}/);
  assert.match(tenant, /recordAllianceShadow:\s*values\["record-alliance-shadow"\]\s*===\s*true/);
  assert.match(tenant, /allianceShadowIntervalTicks,/);
  assert.match(tenant, /createTenantAllianceIpcBridge/);
  assert.match(tenant, /onAllianceShadowFrame:/);
  assert.match(supervisor, /createCentralAllianceShadowRuntime/);
  assert.match(supervisor, /allianceDirectorView:/);
  assert.match(supervisor, /actionOwnership:\s*"none"/);
});

test("run-tenant: interval without enable flag fails before runtime", async () => {
  const result = await runCli("run-tenant.ts", ["--config=missing.json", "--alliance-shadow-interval-ticks=4"]);
  assert.equal(result.code, 1);
  assert.match(result.output, /只能与 --record-alliance-shadow 一起使用/);
});

test("run-supervisor: interval without enable flag fails before listener/spawn", async () => {
  const result = await runCli("run-supervisor.ts", [`--repo-root=${REPO_ROOT}`, "--alliance-shadow-interval-ticks=4"]);
  assert.equal(result.code, 1);
  assert.match(result.output, /requires --record-alliance-shadow/);
});

test("run-supervisor: env enable + interval passes argument validation", async () => {
  const blocker = createServer();
  await new Promise<void>((done) => blocker.listen(0, "127.0.0.1", done));
  const address = blocker.address();
  assert.notEqual(typeof address, "string");
  try {
    const result = await runCli("run-supervisor.ts", [], {
      ...process.env,
      ARENA_REPO_ROOT: REPO_ROOT,
      ARENA_RECORD_ALLIANCE_SHADOW: "true",
      ARENA_ALLIANCE_SHADOW_INTERVAL_TICKS: "3",
      ARENA_DEBUG_PORT: String((address as { port: number }).port),
    });
    assert.equal(result.code, 1);
    assert.match(result.output, /EADDRINUSE|address already in use/i);
    assert.doesNotMatch(result.output, /alliance-shadow-interval-ticks.*invalid|requires --record-alliance-shadow/i);
  } finally {
    await new Promise<void>((done) => blocker.close(() => done()));
  }
});


test("run-supervisor: Alliance Director cannot enable without full shadow frames", async () => {
  const result = await runCli("run-supervisor.ts", [`--repo-root=${REPO_ROOT}`, "--alliance-director-shadow"]);
  assert.equal(result.code, 1);
  assert.match(result.output, /requires --record-alliance-shadow/);
});

test("run-supervisor: Director timing options without Director enable fail fast", async () => {
  const result = await runCli("run-supervisor.ts", [`--repo-root=${REPO_ROOT}`, "--alliance-director-period-ticks=4"]);
  assert.equal(result.code, 1);
  assert.match(result.output, /timing options require --alliance-director-shadow/);
});

test("run-supervisor: env shadow+Director config passes validation and reaches debug bind", async () => {
  const blocker = createServer();
  await new Promise<void>((done) => blocker.listen(0, "127.0.0.1", done));
  const address = blocker.address();
  assert.notEqual(typeof address, "string");
  try {
    const result = await runCli("run-supervisor.ts", [], {
      ...process.env,
      ARENA_REPO_ROOT: REPO_ROOT,
      ARENA_RECORD_ALLIANCE_SHADOW: "true",
      ARENA_ALLIANCE_SHADOW_INTERVAL_TICKS: "3",
      ARENA_ALLIANCE_DIRECTOR_SHADOW: "true",
      ARENA_ALLIANCE_DIRECTOR_PERIOD_TICKS: "4",
      ARENA_ALLIANCE_DIRECTOR_MAX_SKEW_TICKS: "2",
      ARENA_DEBUG_PORT: String((address as { port: number }).port),
    });
    assert.equal(result.code, 1);
    assert.match(result.output, /EADDRINUSE|address already in use/i);
    assert.doesNotMatch(result.output, /requires --record-alliance-shadow|timing options require|invalid value/i);
  } finally {
    await new Promise<void>((done) => blocker.close(() => done()));
  }
});
