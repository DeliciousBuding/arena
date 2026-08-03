/**
 * TenantSupervisor 测试：fake child 注入，零真实进程。
 * 覆盖：spawn 全部 configs、SIGTERM 优雅关闭、SIGKILL 超时兜底、exit 记录、事件流。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TenantSupervisor, type SupervisorEvent } from "../src/app/tenant-supervisor.ts";

/** Fake ChildProcess：可手动触发 exit；记录 kill 信号。 */
class FakeChild extends EventEmitter {
  killed: string[] = [];
  stdout: EventEmitter = new EventEmitter();
  stderr: EventEmitter = new EventEmitter();

  kill(signal: string): boolean {
    this.killed.push(signal);
    return true;
  }

  emitExit(code: number | null, signal: string | null = null): void {
    this.emit("exit", code, signal);
  }
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-test-"));
  mkdirSync(join(dir, "runtime", "configs"), { recursive: true });
  for (const tenant of ["t1", "t2", "t3", "t4"]) {
    writeFileSync(join(dir, "runtime", "configs", `${tenant}.json`), "{}");
  }
  return dir;
}

test("supervisor spawns all configured tenants and records events", async () => {
  const repo = makeTempRepo();
  const eventLogPath = join(repo, "runtime", "supervisor-test.jsonl");
  const spawned: string[] = [];
  const events: SupervisorEvent[] = [];
  const children = new Map<string, FakeChild>();

  const supervisor = new TenantSupervisor({
    repoRoot: repo,
    configs: ["t1.json", "t2.json", "t3.json", "t4.json"],
    eventLogPath,
    onEvent: (event) => events.push(event),
    spawnChild: (args) => {
      const configIdx = args.findIndex((a) => a === "--config");
      const configPath = args[configIdx + 1];
      const tenantId = configPath.split(/[\\/]/).pop()!.replace(/\.json$/, "");
      spawned.push(tenantId);
      const child = new FakeChild();
      children.set(tenantId, child);
      return child as unknown as ReturnType<TenantSupervisorOptions_spawn>;
    },
  });

  const results = supervisor.start();
  assert.deepEqual([...results.keys()], ["t1", "t2", "t3", "t4"]);
  assert.deepEqual(spawned, ["t1", "t2", "t3", "t4"]);
  assert.equal(supervisor.allExited(), false);

  // 全部正常退出
  for (const child of children.values()) {
    child.emitExit(0);
  }
  assert.equal(supervisor.allExited(), true);
  assert.ok(events.some((e) => e.type === "spawned"));
  assert.ok(events.some((e) => e.type === "exited" && e.exitCode === 0));

  // 事件落盘
  const log = readFileSync(eventLogPath, "utf-8");
  assert.ok(log.includes('"type":"spawned"'));
  assert.ok(log.includes('"type":"exited"'));

  rmSync(repo, { recursive: true, force: true });
});

test("shutdown sends SIGTERM to all alive children then all_exited", async () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();
  const events: SupervisorEvent[] = [];

  const supervisor = new TenantSupervisor({
    repoRoot: repo,
    configs: ["t1.json", "t2.json"],
    eventLogPath: join(repo, "runtime", "supervisor-test2.jsonl"),
    onEvent: (event) => events.push(event),
    spawnChild: (args) => {
      const configIdx = args.findIndex((a) => a === "--config");
      const tenantId = args[configIdx + 1].split(/[\\/]/).pop()!.replace(/\.json$/, "");
      const child = new FakeChild();
      children.set(tenantId, child);
      return child as unknown as ReturnType<TenantSupervisorOptions_spawn>;
    },
  });

  supervisor.start();
  const shutdownPromise = supervisor.shutdown();

  // 子进程立即响应 SIGTERM 退出
  for (const child of children.values()) {
    assert.deepEqual(child.killed, ["SIGTERM"]);
    child.emitExit(0, "SIGTERM");
  }
  await shutdownPromise;

  assert.equal(supervisor.allExited(), true);
  assert.ok(events.some((e) => e.type === "terminating"));
  assert.ok(events.some((e) => e.type === "all_exited"));

  rmSync(repo, { recursive: true, force: true });
});

test("shutdown escalates to SIGKILL when child ignores SIGTERM", async () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();
  const events: SupervisorEvent[] = [];

  const supervisor = new TenantSupervisor({
    repoRoot: repo,
    configs: ["t1.json", "t2.json"],
    eventLogPath: join(repo, "runtime", "supervisor-test3.jsonl"),
    shutdownTimeoutMs: 300,
    onEvent: (event) => events.push(event),
    spawnChild: (args) => {
      const configIdx = args.findIndex((a) => a === "--config");
      const tenantId = args[configIdx + 1].split(/[\\/]/).pop()!.replace(/\.json$/, "");
      const child = new FakeChild();
      children.set(tenantId, child);
      return child as unknown as ReturnType<TenantSupervisorOptions_spawn>;
    },
  });

  supervisor.start();
  const shutdownPromise = supervisor.shutdown();

  // 子进程忽略 SIGTERM → 等 300ms 兜底 SIGKILL
  await new Promise((resolve) => setTimeout(resolve, 450));
  for (const child of children.values()) {
    assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
    child.emitExit(null, "SIGKILL");
  }
  await shutdownPromise;

  assert.ok(events.some((e) => e.type === "timeout_killed"));
  assert.equal(supervisor.allExited(), true);

  rmSync(repo, { recursive: true, force: true });
});

test("status reflects alive/dead/exitCode", () => {
  const repo = makeTempRepo();
  const children = new Map<string, FakeChild>();

  const supervisor = new TenantSupervisor({
    repoRoot: repo,
    configs: ["t1.json"],
    eventLogPath: join(repo, "runtime", "supervisor-test4.jsonl"),
    spawnChild: (args) => {
      const child = new FakeChild();
      children.set("t1", child);
      return child as unknown as ReturnType<TenantSupervisorOptions_spawn>;
    },
  });

  supervisor.start();
  assert.equal(supervisor.status()[0].alive, true);
  children.get("t1")!.emitExit(3);
  const status = supervisor.status()[0];
  assert.equal(status.alive, false);
  assert.equal(status.exitCode, 3);

  rmSync(repo, { recursive: true, force: true });
});

/** 类型辅助：TenantSupervisorOptions.spawnChild 的返回类型。 */
type TenantSupervisorOptions_spawn = (
  args: readonly string[],
) => import("node:child_process").ChildProcess;
