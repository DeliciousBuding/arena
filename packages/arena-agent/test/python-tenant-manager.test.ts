/** PythonTenantManager 单元测试（2026-08-10）：fake spawn 子进程，不启真实
 *  python；验证生命周期/重启/心跳判死/env 注入/代理剥离。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { PythonTenantManager, PythonTenantRegistry, type PythonAgentSpec } from "../src/app/python-tenant-manager.ts";

let nextPid = 51000;

class FakePyChild extends EventEmitter {
  readonly pid = nextPid++;
  readonly killed: string[] = [];
  connected = true;
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

interface TestEnv {
  readonly cwd: string;
  cleanup(): void;
}

function makeTestEnv(): TestEnv {
  const cwd = mkdtempSync(join(tmpdir(), "arena-python-"));
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, ".env"), [
    "ARENA_HERO_API_KEY=test-key-not-real",
    "ARENA_HERO_TELEMETRY_ENDPOINT=http://127.0.0.1:8787/api/ingest/agents",
    "ARENA_HERO_TENANT=t2",
    "SOME_OTHER_VAR=not-injected",
  ].join("\n"));
  return {
    cwd,
    cleanup() {
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function makeSpec(cwd: string, overrides: Partial<PythonAgentSpec> = {}): PythonAgentSpec {
  return {
    tenantId: "t2",
    repoPath: "D:/fake/repo/arena-hero-tactic",
    venvPython: "D:/fake/repo/arena-hero-tactic/.venv/Scripts/python.exe",
    module: "bot.main",
    cwd,
    heartbeatTtlMs: 60_000,
    respawnLimit: 2,
    respawnDelayMs: 0,
    ...overrides,
  };
}

function captureEnv(spawned: Map<string, Record<string, string>>, children: Map<string, FakePyChild>, argsSeen?: string[][]) {
  return (_command: string, args: readonly string[], spec: PythonAgentSpec, env: Record<string, string>) => {
    spawned.set(spec.tenantId, env);
    argsSeen?.push([...args]);
    const child = new FakePyChild();
    children.set(spec.tenantId, child);
    return child as unknown as ChildProcess;
  };
}

test("python spawn: env whitelist injection + proxy kept by default + PYTHONPATH", async () => {
  const env = makeTestEnv();
  process.env.HTTP_PROXY = "http://127.0.0.1:7897";
  const spawned = new Map<string, Record<string, string>>();
  const children = new Map<string, FakePyChild>();
  const argsSeen: string[][] = [];
  const manager = new PythonTenantManager(makeSpec(env.cwd, { args: ["--log-file", "tactic.log"] }), {
    spawn: captureEnv(spawned, children, argsSeen),
    heartbeatPollMs: 1000,
    forceKillTree: async () => {}, // fake child 无真实进程：避免 taskkill 误杀/拖慢
  });
  try {
    manager.start();
    const childEnv = spawned.get("t2")!;
    assert.equal(childEnv.ARENA_HERO_API_KEY, "test-key-not-real", ".env 白名单注入");
    assert.equal(childEnv.ARENA_HERO_TELEMETRY_ENDPOINT, "http://127.0.0.1:8787/api/ingest/agents");
    assert.equal(childEnv.ARENA_HERO_TENANT, "t2");
    assert.equal(childEnv.SOME_OTHER_VAR, undefined, ".env 非白名单变量不注入");
    assert.equal(childEnv.HTTP_PROXY, "http://127.0.0.1:7897", "默认保留代理（官方 API 需走代理）");
    assert.equal(childEnv.PYTHONPATH, "D:/fake/repo/arena-hero-tactic");
    assert.deepEqual(argsSeen[0], ["-m", "bot.main", "--log-file", "tactic.log"], "args 透传给模块");
    const status = manager.status();
    assert.equal(status.tenantId, "t2");
    assert.equal(status.alive, true);
    assert.equal(status.lifecycle, "starting");
    // stripProxy: true 显式剥离
    await manager.stop();
    const stripped = new PythonTenantManager(makeSpec(env.cwd, { stripProxy: true }), {
      spawn: captureEnv(spawned, children),
      heartbeatPollMs: 1000,
    });
    stripped.start();
    const strippedEnv = spawned.get("t2")!;
    assert.equal(strippedEnv.HTTP_PROXY, undefined, "stripProxy=true 时剥离代理");
    await stripped.stop();
  } finally {
    delete process.env.HTTP_PROXY;
    env.cleanup();
  }
});

test("python boot grace: stale log within grace not killed, after grace killed", async () => {
  const env = makeTestEnv();
  const spawned = new Map<string, Record<string, string>>();
  const children = new Map<string, FakePyChild>();
  // tactic.log 写入过去时间 = 心跳超时（但 bootGraceMs 内不判死）
  const logPath = join(env.cwd, "tactic.log");
  writeFileSync(logPath, "tick\n");
  utimesSync(logPath, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  const manager = new PythonTenantManager(makeSpec(env.cwd, { heartbeatTtlMs: 60_000, bootGraceMs: 80 }), {
    spawn: captureEnv(spawned, children),
    heartbeatPollMs: 25,
    forceKillTree: async () => {},
  });
  let heartbeatLost = 0;
  manager.on("heartbeat_lost", () => { heartbeatLost += 1; });
  try {
    manager.start();
    const first = children.get("t2")!;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(heartbeatLost, 0, "boot grace 内心跳 stale 不判死");
    assert.equal(manager.status().alive, true, "boot grace 内 alive");
    // 超过 boot grace（80ms）后 stale 判死
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(heartbeatLost, 1, "超过 boot grace 后心跳超时判死");
    assert.ok(first.killed.includes("SIGTERM"), "超时后 SIGTERM 终止");
    await manager.stop();
  } finally {
    env.cleanup();
  }
});

test("python respawn: unexpected exit backoffs and respawns with count", async () => {
  const env = makeTestEnv();
  const spawned = new Map<string, Record<string, string>>();
  const children = new Map<string, FakePyChild>();
  const manager = new PythonTenantManager(makeSpec(env.cwd), {
    spawn: captureEnv(spawned, children),
    heartbeatPollMs: 1000,
    forceKillTree: async () => {},
  });
  try {
    manager.start();
    const first = children.get("t2")!;
    first.emitExit(1, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.status().respawnCount, 1);
    assert.notEqual(children.get("t2"), first, "respawn 产生新 child");
    const second = children.get("t2")!;
    second.emitExit(1, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.status().respawnCount, 2);
    assert.notEqual(children.get("t2"), second);
  } finally {
    await manager.stop();
    env.cleanup();
  }
});

test("python respawn: limit exhausted -> dead + exhausted event", async () => {
  const env = makeTestEnv();
  const spawned = new Map<string, Record<string, string>>();
  const children = new Map<string, FakePyChild>();
  const manager = new PythonTenantManager(makeSpec(env.cwd, { respawnLimit: 2 }), {
    spawn: captureEnv(spawned, children),
    heartbeatPollMs: 1000,
    forceKillTree: async () => {},
  });
  let exhausted = 0;
  manager.on("exhausted", () => { exhausted += 1; });
  try {
    manager.start();
    children.get("t2")!.emitExit(1, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    children.get("t2")!.emitExit(1, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const third = children.get("t2")!;
    third.emitExit(1, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(children.get("t2"), third, "耗尽后不再自动重建");
    assert.equal(exhausted, 1);
    const status = manager.status();
    assert.equal(status.lifecycle, "dead");
    assert.match(status.lastError ?? "", /respawn limit reached/);
  } finally {
    await manager.stop();
    env.cleanup();
  }
});

test("python heartbeat: stale stdout log -> kill + respawn (dead-detection)", async () => {
  const env = makeTestEnv();
  const spawned = new Map<string, Record<string, string>>();
  const children = new Map<string, FakePyChild>();
  // tactic.log 写入过去时间 = 心跳超时
  const logPath = join(env.cwd, "tactic.log");
  writeFileSync(logPath, "tick\n");
  utimesSync(logPath, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  const manager = new PythonTenantManager(makeSpec(env.cwd, { heartbeatTtlMs: 60_000, bootGraceMs: 0 }), {
    spawn: captureEnv(spawned, children),
    heartbeatPollMs: 25,
    forceKillTree: async () => {},
  });
  let heartbeatLost = 0;
  manager.on("heartbeat_lost", () => { heartbeatLost += 1; });
  try {
    manager.start();
    const first = children.get("t2")!;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(heartbeatLost, 1, "心跳超时触发 heartbeat_lost");
    assert.ok(first.killed.includes("SIGTERM"), "超时后 SIGTERM 终止");
    // SIGTERM 后 fake child 不自动退出 → 8s 强杀路径；这里验证事件已发即可
    await manager.stop();
  } finally {
    env.cleanup();
  }
});

test("python registry reload: changed spec restarts, added starts, removed stops", async () => {
  const env = makeTestEnv();
  const spawned = new Map<string, Record<string, string>>();
  const children = new Map<string, FakePyChild>();
  const base = makeSpec(env.cwd, { tenantId: "t5", args: ["--log-file", "tactic.log"] });
  const registry = new PythonTenantRegistry([base], {}, {
    spawn: captureEnv(spawned, children),
    heartbeatPollMs: 1000,
    forceKillTree: async () => {},
  });
  try {
    registry.start();
    const first = children.get("t5")!;
    // spec 变更 → 旧实例 stop（SIGTERM）+ 新 spec 重建
    await registry.reload([{ ...base, args: ["--genes", "x.json"] }]);
    assert.notEqual(children.get("t5"), first, "变更后重建新 child");
    assert.ok(first.killed.includes("SIGTERM"), "旧实例收到 SIGTERM");
    const afterRestart = registry.status();
    assert.equal(afterRestart.length, 1);
    assert.equal(afterRestart[0].respawnCount, 0, "重建重置计数");
    assert.deepEqual(afterRestart[0].pid, children.get("t5")!.pid);
    // 新增 t6
    await registry.reload([{ ...base, args: ["--genes", "x.json"] }, { ...base, tenantId: "t6" }]);
    assert.ok(children.has("t6"), "新增租户启动");
    assert.equal(registry.status().length, 2);
    // 删除 t6
    await registry.reload([{ ...base, args: ["--genes", "x.json"] }]);
    assert.equal(registry.status().length, 1);
    assert.ok(children.get("t6")!.killed.includes("SIGTERM"), "删除租户被 stop");
    assert.equal(registry.status()[0].tenantId, "t5");
  } finally {
    await registry.stop();
    env.cleanup();
  }
});

test("python stop: SIGTERM graceful, no respawn after stop", async () => {
  const env = makeTestEnv();
  const spawned = new Map<string, Record<string, string>>();
  const children = new Map<string, FakePyChild>();
  const manager = new PythonTenantManager(makeSpec(env.cwd), {
    spawn: captureEnv(spawned, children),
    heartbeatPollMs: 1000,
    forceKillTree: async () => {},
  });
  try {
    manager.start();
    const first = children.get("t2")!;
    await manager.stop();
    assert.ok(first.killed.includes("SIGTERM"), "stop 发 SIGTERM");
    assert.equal(manager.status().alive, false);
    // stop 后 child exit 不再触发 respawn
    const spawnedBefore = children.get("t2");
    first.emitExit(0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(children.get("t2"), spawnedBefore, "stop 后不 respawn");
  } finally {
    env.cleanup();
  }
});
