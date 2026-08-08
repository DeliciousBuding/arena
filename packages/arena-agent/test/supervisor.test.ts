/** Production-boundary tests for the native TenantSupervisor. No Arena network access. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TenantSupervisor, type SupervisorEvent, type TenantSpec } from "../src/app/tenant-supervisor.ts";
import { DebugServer } from "../src/app/debug-server.ts";
import { registerShutdownRequest } from "../src/app/process-shutdown.ts";
import { resolveArenaDataRoot } from "../src/app/data-root.ts";
import { compileRuntimeStrategyFile } from "../src/app/strategy-config.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
let nextPid = 41000;

test("data root resolution uses CLI, env, then sibling default precedence", () => {
  const repoRoot = resolve(tmpdir(), "arena-workspace", "arena-ts");
  assert.equal(resolveArenaDataRoot(repoRoot), resolve(repoRoot, "..", "data"));
  assert.equal(resolveArenaDataRoot(repoRoot, undefined, "env-data"), resolve(repoRoot, "env-data"));
  assert.equal(resolveArenaDataRoot(repoRoot, "cli-data", "env-data"), resolve(repoRoot, "cli-data"));
  assert.equal(resolveArenaDataRoot(repoRoot, "", "env-data"), resolve(repoRoot, "env-data"));
});

class FakeChild extends EventEmitter {
  readonly pid = nextPid++;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  connected = true;
  readonly sent: unknown[] = [];
  readonly killed: string[] = [];
  autoExitOnSend = false;
  onSend: ((message: unknown) => void) | null = null;

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    if (this.onSend !== null) queueMicrotask(() => this.onSend?.(message));
    if (this.autoExitOnSend) queueMicrotask(() => this.emitExit(0, null));
    return true;
  }

  kill(signal: string): boolean {
    this.killed.push(signal);
    return true;
  }

  emitExit(code: number | null, signal: string | null): void {
    if (!this.connected) return;
    this.connected = false;
    this.emit("exit", code, signal);
  }
}

interface TempRepo {
  readonly root: string;
  readonly dataRoot: string;
  readonly runtimeRoot: string;
  readonly envNames: readonly string[];
  cleanup(): void;
}

function makeTempRepo(
  tenants: readonly { file: string; tenantId: string; envName?: string; baseDir?: string }[] = [
    { file: "t1.json", tenantId: "t1" },
  ],
): TempRepo {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "arena-supervisor-"));
  const root = join(workspaceRoot, "arena-ts");
  const dataRoot = join(workspaceRoot, "data");
  const runtimeRoot = join(dataRoot, "runtime");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(runtimeRoot, "configs"), { recursive: true });
  const envNames: string[] = [];
  for (const tenant of tenants) {
    const envName = tenant.envName ?? `ARENA_TEST_${tenant.tenantId}_${Math.random().toString(16).slice(2)}`;
    process.env[envName] = "test-key-not-real";
    envNames.push(envName);
    writeFileSync(join(runtimeRoot, "configs", tenant.file), JSON.stringify({
      tenantId: tenant.tenantId,
      arenaTokenEnv: envName,
      decisionMode: "deterministic",
      submitEnabled: false,
      model: { provider: "test", id: "test-model" },
      baseDir: tenant.baseDir ?? "runtime",
    }));
  }
  return {
    root,
    dataRoot,
    runtimeRoot,
    envNames,
    cleanup() {
      for (const name of envNames) delete process.env[name];
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}

function fakeSpawn(children: Map<string, FakeChild>): (args: readonly string[], spec: TenantSpec) => ChildProcess {
  return (_args, spec) => {
    const child = new FakeChild();
    children.set(spec.tenantId, child);
    return child as unknown as ChildProcess;
  };
}

function writeLock(spec: TenantSpec, pid: number): void {
  mkdirSync(dirname(spec.lockPath), { recursive: true });
  writeFileSync(spec.lockPath, JSON.stringify({ pid, processRunId: "test-run" }));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timeout");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function requestJson(
  port: number,
  path: string,
  options: { method?: string } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: options.method ?? "GET" });
  return { status: response.status, body: await response.json() };
}

test("complete preflight happens before the first spawn", async () => {
  const repo = makeTempRepo([
    { file: "alpha.json", tenantId: "t1" },
    { file: "beta.json", tenantId: "t2" },
  ]);
  const children = new Map<string, FakeChild>();
  try {
    const supervisor = new TenantSupervisor({
      repoRoot: repo.root,
      configs: ["alpha.json", "beta.json"],
      spawnChild: fakeSpawn(children),
    });
    const results = await supervisor.start();
    assert.equal(supervisor.dataRoot, resolve(repo.dataRoot));
    assert.equal(supervisor.configRoot, resolve(repo.runtimeRoot, "configs"));
    assert.equal(supervisor.runtimeRoot, resolve(repo.runtimeRoot));
    assert.deepEqual([...results.keys()], ["t1", "t2"]);
    assert.equal(children.size, 2);
    assert.deepEqual(supervisor.status().map((row) => row.lifecycle), ["starting", "starting"]);
    for (const child of children.values()) child.autoExitOnSend = true;
    await supervisor.shutdown();
  } finally {
    repo.cleanup();
  }
});


test("preflight compiles variant registry before first spawn", async () => {
  const repo = makeTempRepo();
  const path = join(repo.runtimeRoot, "configs", "t1.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  raw.variants = ["not-a-real-variant-v1"];
  writeFileSync(path, JSON.stringify(raw));
  let spawnCount = 0;
  try {
    const supervisor = new TenantSupervisor({
      repoRoot: repo.root,
      configs: ["t1.json"],
      spawnChild: () => { spawnCount += 1; return new FakeChild() as unknown as ChildProcess; },
    });
    await assert.rejects(supervisor.start(), /unknown safety variant/);
    assert.equal(spawnCount, 0);
  } finally {
    repo.cleanup();
  }
});

test("config status is independent from writer readiness", async () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();
  try {
    const supervisor = new TenantSupervisor({ repoRoot: repo.root, configs: ["t1.json"], spawnChild: fakeSpawn(children) });
    await supervisor.start();
    const spec = supervisor.preflight()[0];
    const child = children.get("t1")!;
    writeLock(spec, child.pid);
    assert.equal(supervisor.status()[0].ready, true);
    assert.equal(supervisor.status()[0].configReady, false, "lock readiness must not imply config attestation");
    child.emit("message", {
      type: "arena.config_status",
      tenantId: "t1",
      configGeneration: 1,
      activeConfigHash: spec.configHash,
      activeStrategyHash: spec.strategyHash,
    });
    const status = supervisor.status()[0];
    assert.equal(status.ready, true);
    assert.equal(status.configReady, true);
    assert.equal(status.configGeneration, 1);
    child.autoExitOnSend = true;
    await supervisor.shutdown();
  } finally {
    repo.cleanup();
  }
});

test("variant-only reload waits for exact child ACK before applied", async () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();
  try {
    const supervisor = new TenantSupervisor({
      repoRoot: repo.root,
      configs: ["t1.json"],
      spawnChild: fakeSpawn(children),
      configReloadTimeoutMs: 200,
    });
    await supervisor.start();
    const spec = supervisor.preflight()[0];
    const child = children.get("t1")!;
    child.emit("message", {
      type: "arena.config_status",
      tenantId: "t1",
      configGeneration: 1,
      activeConfigHash: spec.configHash,
      activeStrategyHash: spec.strategyHash,
    });

    const path = spec.configPath;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.variants = ["worker-mission-v1"];
    writeFileSync(path, JSON.stringify(raw));
    const candidate = compileRuntimeStrategyFile(path);
    child.onSend = (message) => {
      const request = message as { type?: string; requestId?: string; expectedConfigHash?: string };
      if (request.type !== "arena.config_reload") return;
      assert.equal(request.expectedConfigHash, candidate.configHash);
      child.emit("message", {
        type: "arena.config_reload_result",
        requestId: request.requestId,
        tenantId: "t1",
        applied: true,
        configGeneration: 2,
        activeConfigHash: candidate.configHash,
        activeStrategyHash: candidate.strategyHash,
      });
    };
    const result = (await supervisor.reloadConfigs("t1")).t1!;
    assert.equal(result.sent, true);
    assert.equal(result.applied, true);
    assert.equal(result.configGeneration, 2);
    assert.equal(supervisor.status()[0].configReady, true);
    child.onSend = null;
    child.autoExitOnSend = true;
    await supervisor.shutdown();
  } finally {
    repo.cleanup();
  }
});

test("reload timeout from replaced child cannot poison respawned child config state", async () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();
  try {
    const supervisor = new TenantSupervisor({
      repoRoot: repo.root,
      configs: ["t1.json"],
      spawnChild: fakeSpawn(children),
      respawnDelayMs: 0,
      configReloadTimeoutMs: 80,
    });
    await supervisor.start();
    const spec = supervisor.preflight()[0];
    const first = children.get("t1")!;
    first.emit("message", {
      type: "arena.config_status",
      tenantId: "t1",
      configGeneration: 1,
      activeConfigHash: spec.configHash,
      activeStrategyHash: spec.strategyHash,
    });

    const raw = JSON.parse(readFileSync(spec.configPath, "utf8")) as Record<string, unknown>;
    raw.variants = ["worker-mission-v1"];
    writeFileSync(spec.configPath, JSON.stringify(raw));
    const candidate = compileRuntimeStrategyFile(spec.configPath);
    first.onSend = (message) => {
      if ((message as { type?: string }).type === "arena.config_reload") first.emitExit(3, null);
    };

    const reloadPromise = supervisor.reloadConfigs("t1");
    await waitUntil(() => children.get("t1") !== first);
    const replacement = children.get("t1")!;
    replacement.emit("message", {
      type: "arena.config_status",
      tenantId: "t1",
      configGeneration: 1,
      activeConfigHash: candidate.configHash,
      activeStrategyHash: candidate.strategyHash,
    });
    const result = (await reloadPromise).t1!;
    assert.equal(result.applied, false);
    assert.equal(result.errorCode, "ipc_unavailable");
    const status = supervisor.status()[0];
    assert.equal(status.configReady, true, "replacement child independently attested the desired config");
    assert.equal(status.lastConfigError, null, "old request timeout must not write into replacement child state");
    replacement.autoExitOnSend = true;
    await supervisor.shutdown();
  } finally {
    repo.cleanup();
  }
});

test("non-hot config changes return restart_required without sending IPC", async () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();
  try {
    const supervisor = new TenantSupervisor({ repoRoot: repo.root, configs: ["t1.json"], spawnChild: fakeSpawn(children) });
    await supervisor.start();
    const spec = supervisor.preflight()[0];
    const child = children.get("t1")!;
    child.emit("message", {
      type: "arena.config_status",
      tenantId: "t1",
      configGeneration: 1,
      activeConfigHash: spec.configHash,
      activeStrategyHash: spec.strategyHash,
    });
    const raw = JSON.parse(readFileSync(spec.configPath, "utf8")) as Record<string, unknown>;
    raw.submitEnabled = true;
    writeFileSync(spec.configPath, JSON.stringify(raw));
    const result = (await supervisor.reloadConfigs("t1")).t1!;
    assert.equal(result.sent, false);
    assert.equal(result.applied, false);
    assert.equal(result.errorCode, "restart_required");
    assert.ok(result.restartRequiredFields?.includes("submitEnabled"));
    assert.equal(child.sent.length, 0, "restart-required candidate must never reach child planner");
    assert.equal(supervisor.status()[0].configReady, false);
    child.autoExitOnSend = true;
    await supervisor.shutdown();
  } finally {
    repo.cleanup();
  }
});

test("external config/runtime roots support immutable releases", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arena-code-"));
  const configRoot = mkdtempSync(join(tmpdir(), "arena-config-"));
  const runtimeRoot = mkdtempSync(join(tmpdir(), "arena-runtime-"));
  const envName = `ARENA_EXTERNAL_${Math.random().toString(16).slice(2)}`;
  process.env[envName] = "test-key-not-real";
  writeFileSync(join(configRoot, "t1.json"), JSON.stringify({
    tenantId: "t1",
    arenaTokenEnv: envName,
    decisionMode: "deterministic",
    submitEnabled: false,
    model: { provider: "test", id: "test-model" },
    baseDir: runtimeRoot,
  }));
  const children = new Map<string, FakeChild>();
  try {
    const supervisor = new TenantSupervisor({
      repoRoot,
      configRoot,
      runtimeRoot,
      configs: ["t1.json"],
      spawnChild: fakeSpawn(children),
    });
    await supervisor.start();
    assert.equal(supervisor.configRoot, resolve(configRoot));
    assert.equal(supervisor.runtimeRoot, resolve(runtimeRoot));
    const spec = supervisor.preflight()[0];
    writeLock(spec, children.get("t1")!.pid);
    assert.equal(supervisor.isReady(), true);
    assert.equal(existsSync(join(runtimeRoot, "supervisor.jsonl")), true);
    children.get("t1")!.autoExitOnSend = true;
    await supervisor.shutdown();
  } finally {
    delete process.env[envName];
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("explicit runtimeRoot rejects tenant baseDir drift before spawn", async () => {
  const repo = makeTempRepo();
  const runtimeRoot = mkdtempSync(join(tmpdir(), "arena-runtime-"));
  let spawnCount = 0;
  try {
    const supervisor = new TenantSupervisor({
      repoRoot: repo.root,
      runtimeRoot,
      configs: ["t1.json"],
      spawnChild: () => {
        spawnCount += 1;
        return new FakeChild() as unknown as ChildProcess;
      },
    });
    await assert.rejects(supervisor.start(), /baseDir must match supervisor runtimeRoot/);
    assert.equal(spawnCount, 0);
  } finally {
    repo.cleanup();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("duplicate tenantId fails preflight with zero spawn", async () => {
  const repo = makeTempRepo([
    { file: "a.json", tenantId: "same" },
    { file: "b.json", tenantId: "same" },
  ]);
  let spawnCount = 0;
  try {
    const supervisor = new TenantSupervisor({
      repoRoot: repo.root,
      configs: ["a.json", "b.json"],
      spawnChild: () => { spawnCount += 1; return new FakeChild() as unknown as ChildProcess; },
    });
    await assert.rejects(supervisor.start(), /duplicate tenantId/);
    assert.equal(spawnCount, 0);
  } finally {
    repo.cleanup();
  }
});

test("duplicate config and path traversal fail before spawn", async () => {
  const repo = makeTempRepo();
  let spawnCount = 0;
  const spawnChild = (): ChildProcess => { spawnCount += 1; return new FakeChild() as unknown as ChildProcess; };
  try {
    await assert.rejects(
      new TenantSupervisor({ repoRoot: repo.root, configs: ["t1.json", "t1.json"], spawnChild }).start(),
      /duplicate config/,
    );
    await assert.rejects(
      new TenantSupervisor({ repoRoot: repo.root, configs: ["../outside.json"], spawnChild }).start(),
      /configured config root/,
    );
    assert.equal(spawnCount, 0);
  } finally {
    repo.cleanup();
  }
});

test("missing secret fails preflight with zero spawn", async () => {
  const repo = makeTempRepo();
  delete process.env[repo.envNames[0]];
  let spawnCount = 0;
  try {
    const supervisor = new TenantSupervisor({
      repoRoot: repo.root,
      configs: ["t1.json"],
      spawnChild: () => { spawnCount += 1; return new FakeChild() as unknown as ChildProcess; },
    });
    await assert.rejects(supervisor.start(), /env .* missing/);
    assert.equal(spawnCount, 0);
  } finally {
    repo.cleanup();
  }
});

test("mid-spawn failure rolls back already-started children", async () => {
  const repo = makeTempRepo([
    { file: "t1.json", tenantId: "t1" },
    { file: "t2.json", tenantId: "t2" },
  ]);
  const first = new FakeChild();
  first.autoExitOnSend = true;
  let calls = 0;
  try {
    const supervisor = new TenantSupervisor({
      repoRoot: repo.root,
      configs: ["t1.json", "t2.json"],
      shutdownTimeoutMs: 100,
      spawnChild: () => {
        calls += 1;
        if (calls === 2) throw new Error("synthetic spawn failure");
        return first as unknown as ChildProcess;
      },
    });
    await assert.rejects(supervisor.start(), /synthetic spawn failure/);
    assert.deepEqual(first.sent, [{ type: "arena.shutdown" }]);
    assert.equal(supervisor.allExited(), true);
  } finally {
    repo.cleanup();
  }
});

test("readiness requires a continuously matching writer-lock pid", async () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();
  try {
    const supervisor = new TenantSupervisor({ repoRoot: repo.root, configs: ["t1.json"], spawnChild: fakeSpawn(children) });
    await supervisor.start();
    const spec = supervisor.preflight()[0];
    const child = children.get("t1")!;
    assert.equal(supervisor.isReady(), false);
    writeLock(spec, child.pid + 1);
    assert.equal(supervisor.isReady(), false);
    writeLock(spec, child.pid);
    assert.equal(supervisor.isReady(), true);
    rmSync(spec.lockPath, { force: true });
    assert.equal(supervisor.isReady(), false);
    assert.equal(supervisor.status()[0].lifecycle, "degraded");
    child.autoExitOnSend = true;
    await supervisor.shutdown();
  } finally {
    repo.cleanup();
  }
});

test("shutdown requests graceful IPC cleanup and clears readiness", async () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();
  try {
    const supervisor = new TenantSupervisor({ repoRoot: repo.root, configs: ["t1.json"], spawnChild: fakeSpawn(children) });
    await supervisor.start();
    const child = children.get("t1")!;
    writeLock(supervisor.preflight()[0], child.pid);
    assert.equal(supervisor.isReady(), true);
    child.autoExitOnSend = true;
    await supervisor.shutdown();
    assert.deepEqual(child.sent, [{ type: "arena.shutdown" }]);
    assert.equal(supervisor.isReady(), false);
  } finally {
    repo.cleanup();
  }
});

test("unresponsive child escalates through injected process-tree killer", async () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();
  let forced = 0;
  try {
    const supervisor = new TenantSupervisor({
      repoRoot: repo.root,
      configs: ["t1.json"],
      spawnChild: fakeSpawn(children),
      shutdownTimeoutMs: 20,
      forceKillTree: async (child) => {
        forced += 1;
        (child as unknown as FakeChild).emitExit(null, "SIGKILL");
      },
    });
    await supervisor.start();
    await supervisor.shutdown();
    assert.equal(forced, 1);
    assert.equal(supervisor.allExited(), true);
  } finally {
    repo.cleanup();
  }
});

test("unexpected nonzero exit auto-respawns (not ready during restart)", async () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();
  const events: string[] = [];
  try {
    const supervisor = new TenantSupervisor({
      repoRoot: repo.root,
      configs: ["t1.json"],
      spawnChild: fakeSpawn(children),
      respawnDelayMs: 0,
      onEvent: (event) => events.push(`${event.type}:${event.tenantId}`),
    });
    await supervisor.start();
    const first = children.get("t1")!;
    first.emitExit(3, null);
    await waitUntil(() => events.includes("restarting:t1"));
    await waitUntil(() => children.get("t1") !== first); // respawn 完成（setTimeout 0 异步）
    const status = supervisor.status()[0];
    assert.notEqual(status.lifecycle, "ready", "restarting tenant is not ready");
    assert.equal(supervisor.isReady(), false);
    // 新 child 接管后写锁 → ready（自动重启闭环）
    writeLock(supervisor.preflight()[0], children.get("t1")!.pid);
    await waitUntil(() => supervisor.status()[0].lifecycle === "ready");
    assert.equal(supervisor.isReady(), true);
    for (const child of children.values()) child.autoExitOnSend = true;
    await supervisor.shutdown();
  } finally {
    repo.cleanup();
  }
});

test("DebugServer separates health from lock-backed readiness", async () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();
  const supervisor = new TenantSupervisor({ repoRoot: repo.root, configs: ["t1.json"], spawnChild: fakeSpawn(children) });
  const debug = new DebugServer({ repoRoot: repo.root, supervisor, port: 0 });
  try {
    await debug.listen();
    await supervisor.start();
    const port = debug.address()!.port;
    assert.equal((await requestJson(port, "/health")).status, 200);
    assert.equal((await requestJson(port, "/ready")).status, 503);
    assert.equal((await requestJson(port, "/config-ready")).status, 503);
    const spec = supervisor.preflight()[0];
    const child = children.get("t1")!;
    writeLock(spec, child.pid);
    const ready = await requestJson(port, "/ready");
    assert.equal(ready.status, 200);
    assert.equal(ready.body.ready, true);
    assert.equal((await requestJson(port, "/config-ready")).status, 503, "writer lock cannot attest config");
    child.emit("message", {
      type: "arena.config_status",
      tenantId: "t1",
      configGeneration: 1,
      activeConfigHash: spec.configHash,
      activeStrategyHash: spec.strategyHash,
    });
    const configReady = await requestJson(port, "/config-ready");
    assert.equal(configReady.status, 200);
    assert.equal(configReady.body.configReady, true);
    children.get("t1")!.autoExitOnSend = true;
    await supervisor.shutdown();
  } finally {
    await debug.close();
    repo.cleanup();
  }
});

test("DebugServer POST /shutdown triggers graceful IPC cleanup; GET rejected", async () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();
  const supervisor = new TenantSupervisor({
    repoRoot: repo.root,
    configs: ["t1.json"],
    spawnChild: fakeSpawn(children),
  });
  const debug = new DebugServer({ repoRoot: repo.root, supervisor, port: 0 });
  try {
    await debug.listen();
    await supervisor.start();
    const port = debug.address()!.port;
    children.get("t1")!.autoExitOnSend = true;
    const shutdown = await requestJson(port, "/shutdown", { method: "POST" });
    assert.equal(shutdown.status, 202);
    assert.equal(shutdown.body.shuttingDown, true);
    assert.deepEqual(children.get("t1")!.sent, [{ type: "arena.shutdown" }]);
    assert.equal(supervisor.allExited(), true);
    assert.equal(supervisor.isReady(), false);
    const get = await requestJson(port, "/shutdown");
    assert.equal(get.status, 405);
  } finally {
    await debug.close();
    repo.cleanup();
  }
});

test("DebugServer bounds events and rejects unbounded n", async () => {
  const repo = makeTempRepo();
  const supervisor = new TenantSupervisor({ repoRoot: repo.root, configs: ["t1.json"] });
  const debug = new DebugServer({ repoRoot: repo.root, supervisor, port: 0 });
  try {
    for (let i = 0; i < 500; i += 1) {
      appendFileSync(join(repo.runtimeRoot, "supervisor.jsonl"), `${JSON.stringify({ i, pad: "x".repeat(700) })}\n`);
    }
    await debug.listen();
    const port = debug.address()!.port;
    assert.equal((await requestJson(port, "/events?n=201")).status, 400);
    const tail = await requestJson(port, "/events?n=3");
    assert.deepEqual(tail.body.events.map((row: { i: number }) => row.i), [497, 498, 499]);
  } finally {
    await debug.close();
    repo.cleanup();
  }
});

test("DebugServer walks backward from a truncated JSONL tail", async () => {
  const repo = makeTempRepo();
  const supervisor = new TenantSupervisor({ repoRoot: repo.root, configs: ["t1.json"] });
  const debug = new DebugServer({ repoRoot: repo.root, supervisor, port: 0 });
  try {
    const path = join(repo.runtimeRoot, "t1", "telemetry", "runtime.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"tick":1}\n{"tick":2}\n{"tick":');
    await debug.listen();
    const result = await requestJson(debug.address()!.port, "/state?tenant=t1");
    assert.equal(result.status, 200);
    assert.equal(result.body.row.tick, 2);
  } finally {
    await debug.close();
    repo.cleanup();
  }
});



test("DebugServer reads rotated JSONL history without unbounded scans", async () => {
  const repo = makeTempRepo();
  const supervisor = new TenantSupervisor({ repoRoot: repo.root, configs: ["t1.json"] });
  const debug = new DebugServer({ repoRoot: repo.root, supervisor, port: 0 });
  try {
    const telemetry = join(repo.runtimeRoot, "t1", "telemetry");
    mkdirSync(telemetry, { recursive: true });
    writeFileSync(join(telemetry, "runtime.jsonl.1"), '{"tick":7}\n');
    writeFileSync(join(telemetry, "runtime.jsonl"), '{"tick":');
    const events = join(repo.runtimeRoot, "supervisor.jsonl");
    writeFileSync(`${events}.1`, '{"i":1}\n{"i":2}\n');
    writeFileSync(events, '{"i":3}\n');
    await debug.listen();
    const port = debug.address()!.port;
    const state = await requestJson(port, "/state?tenant=t1");
    assert.equal(state.body.row.tick, 7);
    const tail = await requestJson(port, "/events?n=3");
    assert.deepEqual(tail.body.events.map((row: { i: number }) => row.i), [1, 2, 3]);
  } finally {
    await debug.close();
    repo.cleanup();
  }
});

test("run-supervisor binds debug port before preflight and spawns zero children on conflict", async () => {
  const repo = makeTempRepo();
  const blocker = createNetServer();
  await new Promise<void>((resolvePromise) => blocker.listen(0, "127.0.0.1", resolvePromise));
  const address = blocker.address();
  assert.notEqual(typeof address, "string");
  const port = (address as { port: number }).port;
  try {
    const cli = resolve(PACKAGE_ROOT, "src", "cli", "run-supervisor.ts");
    const child = spawn(process.execPath, ["--import", "tsx", cli, `--repo-root=${repo.root}`, "--configs=t1", `--port=${port}`], {
      cwd: PACKAGE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let output = "";
    child.stdout!.on("data", (chunk) => { output += String(chunk); });
    child.stderr!.on("data", (chunk) => { output += String(chunk); });
    const code = await new Promise<number | null>((resolvePromise) => child.once("exit", resolvePromise));
    assert.equal(code, 1);
    assert.match(output, /EADDRINUSE|address already in use/i);
    const eventPath = join(repo.runtimeRoot, "supervisor.jsonl");
    const events = existsSync(eventPath) ? readFileSync(eventPath, "utf8") : "";
    assert.doesNotMatch(events, /"type":"spawned"/);
  } finally {
    await new Promise<void>((resolvePromise) => blocker.close(() => resolvePromise()));
    repo.cleanup();
  }
});

test("run-supervisor reads ARENA_* env vars and ARENA_SERVICE_MODE", async () => {
  const repo = makeTempRepo();
  const blocker = createNetServer();
  await new Promise<void>((resolvePromise) => blocker.listen(0, "127.0.0.1", resolvePromise));
  const address = blocker.address();
  assert.notEqual(typeof address, "string");
  const port = (address as { port: number }).port;
  try {
    const cli = resolve(PACKAGE_ROOT, "src", "cli", "run-supervisor.ts");
    const child = spawn(process.execPath, ["--import", "tsx", cli], {
      cwd: PACKAGE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ARENA_SERVICE_MODE: "shadow",
        ARENA_REPO_ROOT: repo.root,
        ARENA_CONFIG_DIR: join(repo.root, "configs"),
        ARENA_RUNTIME_DIR: join(repo.root, "runtime"),
        ARENA_CONFIGS: "t1",
        ARENA_DEBUG_PORT: String(port),
      },
    });
    let output = "";
    child.stdout!.on("data", (chunk) => { output += String(chunk); });
    child.stderr!.on("data", (chunk) => { output += String(chunk); });
    const code = await new Promise<number | null>((resolvePromise) => child.once("exit", resolvePromise));
    // Port conflict proves env wiring reached the real listener with zero spawns;
    // a missing env would have used the built-in 8120 default and likely bound it.
    assert.equal(code, 1);
    assert.match(output, /EADDRINUSE|address already in use/i);
    const eventPath = join(repo.root, "runtime", "supervisor.jsonl");
    const events = existsSync(eventPath) ? readFileSync(eventPath, "utf8") : "";
    assert.doesNotMatch(events, /"type":"spawned"/);
  } finally {
    await new Promise<void>((resolvePromise) => blocker.close(() => resolvePromise()));
    repo.cleanup();
  }
});

test("run-supervisor treats empty ARENA_* env as unset", async () => {
  const repo = makeTempRepo();
  const blocker = createNetServer();
  await new Promise<void>((resolvePromise) => blocker.listen(0, "127.0.0.1", resolvePromise));
  const address = blocker.address();
  assert.notEqual(typeof address, "string");
  const port = (address as { port: number }).port;
  try {
    const cli = resolve(PACKAGE_ROOT, "src", "cli", "run-supervisor.ts");
    const child = spawn(process.execPath, ["--import", "tsx", cli], {
      cwd: PACKAGE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ARENA_SERVICE_MODE: "shadow",
        ARENA_REPO_ROOT: repo.root,
        ARENA_CONFIG_DIR: join(repo.root, "configs"),
        ARENA_RUNTIME_DIR: join(repo.root, "runtime"),
        ARENA_CONFIGS: "t1",
        ARENA_DEBUG_PORT: String(port),
        // Empty values (compose ${VAR:-} expansion) must not fail arg validation.
        ARENA_LIVE_TICKS: "",
        ARENA_MAX_TICKS: "",
        ARENA_STARTUP_SYNC_TICKS: "",
        ARENA_SHUTDOWN_TIMEOUT_MS: "",
      },
    });
    let output = "";
    child.stdout!.on("data", (chunk) => { output += String(chunk); });
    child.stderr!.on("data", (chunk) => { output += String(chunk); });
    const code = await new Promise<number | null>((resolvePromise) => child.once("exit", resolvePromise));
    assert.equal(code, 1);
    assert.match(output, /EADDRINUSE|address already in use/i);
    assert.doesNotMatch(output, /invalid value/);
  } finally {
    await new Promise<void>((resolvePromise) => blocker.close(() => resolvePromise()));
    repo.cleanup();
  }
});

test("shutdown request bridge is idempotent and disposer removes listeners", () => {
  const source = new EventEmitter();
  let calls = 0;
  const dispose = registerShutdownRequest(() => { calls += 1; }, source as never);
  source.emit("message", { type: "other" });
  source.emit("message", { type: "arena.shutdown" });
  source.emit("message", { type: "arena.shutdown" });
  source.emit("SIGTERM");
  assert.equal(calls, 1);
  dispose();
  assert.equal(source.listenerCount("message"), 0);
  assert.equal(source.listenerCount("SIGINT"), 0);
  assert.equal(source.listenerCount("SIGTERM"), 0);
});

test("Supervisor IPC drives a real runTenant child to natural cleanup and exit", async () => {
  const repo = makeTempRepo();
  const marker = join(repo.root, "natural-cleanup.json");
  const script = join(repo.root, "run-tenant-child.mts");
  const runtimeModule = pathToFileURL(resolve(PACKAGE_ROOT, "src", "app", "tenant-runtime.ts")).href;
  const shutdownModule = pathToFileURL(resolve(PACKAGE_ROOT, "src", "app", "process-shutdown.ts")).href;
  const configPath = join(repo.runtimeRoot, "configs", "t1.json");
  writeFileSync(script, `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTenant } from ${JSON.stringify(runtimeModule)};
import { registerShutdownRequest } from ${JSON.stringify(shutdownModule)};
let clientClosed = false;
let runtimeClosed = false;
const client = {
  submitted: [],
  async *turns() { while (!clientClosed) await new Promise(r => setTimeout(r, 10)); },
  close() { clientClosed = true; },
};
const runtime = {
  bindCandidateSink() {},
  startDecision() { throw new Error("not used"); },
  health() { return { ready: true, activeRunId: null }; },
  async close() { runtimeClosed = true; },
};
try {
  await runTenant(${JSON.stringify(configPath)}, ${JSON.stringify(repo.root)}, {
    client, runtime, onSignal: registerShutdownRequest,
    decisionMode: "deterministic", submissionMode: "disabled",
  });
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
    clientClosed, runtimeClosed,
    lockExists: existsSync(join(${JSON.stringify(repo.runtimeRoot)}, "t1", "locks", "t1.lock")),
    connectedBeforeFinally: process.connected,
  }));
} finally {
  if (process.connected) process.disconnect();
}
`);
  let child: ChildProcess | null = null;
  try {
    const supervisor = new TenantSupervisor({
      repoRoot: repo.root,
      configs: ["t1.json"],
      shutdownTimeoutMs: 2000,
      spawnChild: () => {
        child = spawn(process.execPath, ["--import", "tsx", script], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true,
          detached: process.platform !== "win32",
          env: process.env,
        });
        return child;
      },
    });
    await supervisor.start();
    await waitUntil(() => supervisor.isReady(), 15000);
    await supervisor.shutdown();
    const result = JSON.parse(readFileSync(marker, "utf8"));
    assert.deepEqual(result, {
      clientClosed: true,
      runtimeClosed: true,
      lockExists: false,
      connectedBeforeFinally: true,
    });
    assert.equal(supervisor.allExited(), true);
  } finally {
    const remainingChild = child as ChildProcess | null;
    if (remainingChild !== null && remainingChild.exitCode === null) remainingChild.kill("SIGKILL");
    repo.cleanup();
  }
});

test("timeout escalation removes a real child and grandchild process tree", async () => {
  const repo = makeTempRepo();
  const pidsPath = join(repo.root, "tree-pids.json");
  const script = join(repo.root, "tree-child.mjs");
  writeFileSync(script, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);
`);
  let child: ChildProcess | null = null;
  try {
    const supervisor = new TenantSupervisor({
      repoRoot: repo.root,
      configs: ["t1.json"],
      shutdownTimeoutMs: 100,
      spawnChild: () => {
        child = spawn(process.execPath, [script], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true,
          detached: process.platform !== "win32",
          env: process.env,
        });
        return child;
      },
    });
    await supervisor.start();
    await waitUntil(() => existsSync(pidsPath), 15000);
    const pids = JSON.parse(readFileSync(pidsPath, "utf8")) as { child: number; grandchild: number };
    await supervisor.shutdown();
    await waitUntil(() => processStopped(pids.child) && processStopped(pids.grandchild), 5000);
    assert.equal(processStopped(pids.child), true);
    assert.equal(processStopped(pids.grandchild), true);
  } finally {
    const remainingChild = child as ChildProcess | null;
    if (remainingChild !== null && remainingChild.exitCode === null) remainingChild.kill("SIGKILL");
    repo.cleanup();
  }
});

function processStopped(pid: number): boolean {
  if (process.platform !== "win32") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.split(" ")[2] === "Z") return true;
    } catch {
      return true;
    }
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** 单租户意外退出自动重启（2026-08-08）：避免单线死 → watchdog 全量重启 → 空窗
 *  （t3 worker 减员即发生在该空窗）。带重启上限防崩溃循环。 */
test("single tenant unexpected exit auto-respawns (with limit)", async () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();
  const events: string[] = [];
  const supervisor = new TenantSupervisor({
    repoRoot: repo.root,
    configs: ["t1.json"],
    spawnChild: fakeSpawn(children),
    respawnDelayMs: 0,
    respawnLimit: 3,
    onEvent: (event) => events.push(`${event.type}:${event.tenantId}`),
  });
  try {
    await supervisor.start();
    const first = children.get("t1")!;
    assert.ok(first, "initial child spawned");
    const spec = supervisor.preflight()[0];
    writeLock(spec, first.pid);
    await waitUntil(() => supervisor.status()[0].lifecycle === "ready");

    first.emitExit(1, null); // 意外失败（非 terminating）
    await waitUntil(() => {
      const child = children.get("t1")!;
      return child !== first && events.includes("restarting:t1");
    });
    assert.ok(events.includes("restarting:t1"), `restarting event emitted, got=${events.join(",")}`);
    assert.notEqual(supervisor.status()[0].lifecycle, "failed", "respawned child should not be failed");

    writeLock(spec, children.get("t1")!.pid);
    await waitUntil(() => supervisor.status()[0].lifecycle === "ready");
    assert.equal(supervisor.status()[0].pid, children.get("t1")!.pid, "new child owns tenant lock");

    for (const child of children.values()) child.autoExitOnSend = true;
    await supervisor.shutdown();
  } finally {
    repo.cleanup();
  }
});

/** 自动重启超限后放弃（交 watchdog 全量恢复），并正常通知 exit waiters。 */
test("auto-respawn gives up after limit and reports final exit", async () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();
  const events: string[] = [];
  const supervisor = new TenantSupervisor({
    repoRoot: repo.root,
    configs: ["t1.json"],
    spawnChild: fakeSpawn(children),
    respawnDelayMs: 0,
    respawnLimit: 1,
    onEvent: (event) => events.push(`${event.type}:${event.tenantId}`),
  });
  try {
    await supervisor.start();
    const first = children.get("t1")!;
    writeLock(supervisor.preflight()[0], first.pid);
    await waitUntil(() => supervisor.status()[0].lifecycle === "ready");

    const exitedPromise = supervisor.waitForAllExited();
    first.emitExit(1, null);
    // limit=1：第一次退出触发一次 respawn，新 child 再退出 → 放弃
    await waitUntil(() => children.get("t1") !== first);
    const second = children.get("t1")!;
    second.emitExit(1, null);
    await exitedPromise;
    assert.equal(supervisor.status()[0].lifecycle, "failed", "limit reached → failed (watchdog handles)");
    assert.match(events.join(","), /restarting:t1/, "restart attempted before giving up");
    for (const child of children.values()) child.autoExitOnSend = true;
    await supervisor.shutdown();
  } finally {
    repo.cleanup();
  }
});

test("TenantSupervisor routes child IPC and targeted sends without affecting writer lifecycle", async () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();
  const received: Array<{ tenantId: string; message: unknown }> = [];
  const supervisor = new TenantSupervisor({
    repoRoot: repo.root,
    configs: ["t1.json"],
    spawnChild: fakeSpawn(children),
    onChildMessage: (tenantId, message) => received.push({ tenantId, message }),
  });
  try {
    await supervisor.start();
    const child = children.get("t1")!;
    const probe = { type: "arena.alliance.frame", schemaVersion: 1, tenantId: "t1" };
    child.emit("message", probe);
    assert.deepEqual(received, [{ tenantId: "t1", message: probe }]);
    assert.equal(supervisor.sendToTenant("t1", { type: "arena.alliance.directive", revision: 1 }), true);
    assert.deepEqual(child.sent.at(-1), { type: "arena.alliance.directive", revision: 1 });
    assert.equal(supervisor.sendToTenant("missing", { type: "probe" }), false);
    child.autoExitOnSend = true;
    await supervisor.shutdown();
  } finally {
    repo.cleanup();
  }
});

test("DebugServer GET /alliance-director exposes read-only ASSIST_ONLY contract", async () => {
  const repo = makeTempRepo();
  const supervisor = new TenantSupervisor({ repoRoot: repo.root, configs: ["t1.json"] });
  const debug = new DebugServer({
    repoRoot: repo.root,
    supervisor,
    port: 0,
    allianceDirectorView: () => ({ enabled: true, mode: "ASSIST_ONLY", actionOwnership: "none", revision: 7 }),
  });
  try {
    await debug.listen();
    const port = debug.address()!.port;
    const get = await requestJson(port, "/alliance-director");
    assert.equal(get.status, 200);
    assert.equal(get.body.mode, "ASSIST_ONLY");
    assert.equal(get.body.actionOwnership, "none");
    assert.equal(get.body.revision, 7);
    const post = await requestJson(port, "/alliance-director", { method: "POST" });
    assert.equal(post.status, 405);
  } finally {
    await debug.close();
    repo.cleanup();
  }
});

test("DebugServer /alliance-strategy queues profile/rollback/mark-good control without action ownership", async () => {
  const repo = makeTempRepo();
  const supervisor = new TenantSupervisor({ repoRoot: repo.root, configs: ["t1.json"] });
  let active = "balanced";
  let pending: unknown = null;
  let lastGood: string | null = null;
  const view = () => ({ active, pending, lastGood, mode: "ASSIST_ONLY", actionOwnership: "none" });
  const debug = new DebugServer({
    repoRoot: repo.root,
    supervisor,
    port: 0,
    allianceStrategyControl: {
      view,
      requestProfile: (name) => {
        if (name === "missing") return { accepted: false, error: "unknown profile", strategy: view() };
        pending = { action: "select", profile: name };
        return { accepted: true, strategy: view() };
      },
      requestRollback: () => {
        pending = { action: "rollback" };
        return { accepted: true, strategy: view() };
      },
      markLastGood: () => {
        lastGood = active;
        return { accepted: true, strategy: view() };
      },
    },
  });
  try {
    await debug.listen();
    const port = debug.address()!.port;
    const get = await requestJson(port, "/alliance-strategy");
    assert.equal(get.status, 200);
    assert.equal(get.body.actionOwnership, "none");

    const select = await requestJson(port, "/alliance-strategy?profile=aggressive", { method: "POST" });
    assert.equal(select.status, 202);
    assert.deepEqual(select.body.strategy.pending, { action: "select", profile: "aggressive" });
    assert.equal(active, "balanced", "debug control queues only; Director replan owns activation");

    const invalid = await requestJson(port, "/alliance-strategy?profile=missing", { method: "POST" });
    assert.equal(invalid.status, 400);
    const rollback = await requestJson(port, "/alliance-strategy?action=rollback", { method: "POST" });
    assert.equal(rollback.status, 202);
    assert.deepEqual(rollback.body.strategy.pending, { action: "rollback" });
    const good = await requestJson(port, "/alliance-strategy?action=mark-good", { method: "POST" });
    assert.equal(good.status, 202);
    assert.equal(good.body.strategy.lastGood, "balanced");
    const malformed = await requestJson(port, "/alliance-strategy", { method: "POST" });
    assert.equal(malformed.status, 400);
  } finally {
    await debug.close();
    repo.cleanup();
  }
});

test("Supervisor + central Alliance shadow: frames -> ASSIST directives -> ACK, never Arena actions", async () => {
  const repo = makeTempRepo([{ file: "t1.json", tenantId: "t1" }, { file: "t2.json", tenantId: "t2" }]);
  const children = new Map<string, FakeChild>();
  const { createCentralAllianceShadowRuntime } = await import("../src/alliance/runtime/central-shadow-runtime.ts");
  const { createFrameMessage, createAckMessage } = await import("../src/alliance/runtime/ipc.ts");
  let central: ReturnType<typeof createCentralAllianceShadowRuntime> | null = null;
  const supervisor = new TenantSupervisor({
    repoRoot: repo.root,
    configs: ["t1.json", "t2.json"],
    spawnChild: fakeSpawn(children),
    onChildMessage: (tenantId, message) => central?.onChildMessage(tenantId, message),
  });
  const makeFrame = (tenantId: string, tick: number, x: number) => ({
    schema: "alliance-shadow-frame-v1" as const,
    processRunId: `run-${tenantId}`,
    tenantId,
    tick,
    observedAtMs: tick * 1000,
    member: {
      tenantId, tick, observedAtMs: tick * 1000,
      core: { id: `core-${tenantId}`, position: [x, 0] as const, hp: 5, shield: 5, moving: false },
      resources: 10, resourceCapacity: 50, population: 8, workers: 2, vanguards: 4, rangers: 2,
      carriedResources: 0, activeFleetIds: [`${tenantId}:home:0`, `${tenantId}:strike:0`],
      localThreat: 0, localHarvestRate: 0, status: "READY" as const,
    },
    sightings: [], allyEntityIds: [`core-${tenantId}`], historicalSightingCount: 0,
  });
  try {
    await supervisor.start();
    central = createCentralAllianceShadowRuntime({
      enabled: true, expectedTenants: ["t1", "t2"], periodTicks: 1, maxSkewTicks: 0,
      send: (tenantId, message) => supervisor.sendToTenant(tenantId, message),
    });
    children.get("t1")!.emit("message", createFrameMessage(makeFrame("t1", 100, 0)));
    assert.equal(children.get("t1")!.sent.length, 0, "partial frame set must not emit directive");
    children.get("t2")!.emit("message", createFrameMessage(makeFrame("t2", 100, 5)));
    for (const tenantId of ["t1", "t2"]) {
      const messages = children.get(tenantId)!.sent as Array<any>;
      const d = messages.find((m) => m.type === "arena.alliance.directive");
      assert.ok(d, `${tenantId} should receive an ASSIST directive`);
      assert.equal(d.directive.mode, "ASSIST");
      assert.equal("unitActions" in d, false);
      assert.equal("coreAction" in d, false);
      assert.equal("submit" in d, false);
      children.get(tenantId)!.emit("message", createAckMessage(tenantId, 100, d.revision, "accepted", "stored only"));
    }
    const view = central.view() as any;
    assert.equal(view.mode, "ASSIST_ONLY");
    assert.equal(view.actionOwnership, "none");
    assert.equal(view.runtime.ackCount, 2);
    assert.equal(view.runtime.ackRecords.filter((r: any) => r.state === "accepted").length, 2);
    assert.ok(view.policy.missions.length >= 2);

    for (const child of children.values()) child.autoExitOnSend = true;
    await supervisor.shutdown();
  } finally {
    repo.cleanup();
  }
});
