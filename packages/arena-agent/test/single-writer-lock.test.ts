/**
 * SingleWriterLock 容器重启场景回归测试：
 * 旧容器销毁后锁文件残留，新容器内同号 PID 是别的进程（PID 复用）。
 * 存活判定必须校验 /proc/<pid>/stat 的 starttime，starttime 不一致 → 陈旧锁可回收。
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SingleWriterLock } from "../src/app/single-writer-lock.ts";

function writeLockFile(lockPath: string, content: Record<string, unknown>): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify(content), "utf-8");
}

function readStarttime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
    return afterComm.split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

test("lock：PID 复用（starttime 不一致）→ 陈旧锁可回收，不误判活锁", async (t) => {
  const realStarttime = readStarttime(process.pid);
  if (realStarttime === null) {
    t.skip("no /proc starttime available on this platform");
    return;
  }
  const base = mkdtempSync(join(tmpdir(), "lock-reuse-"));
  const lockDir = join(base, "locks");
  const lockPath = join(lockDir, "t1.lock");

  // 模拟旧容器残留：PID 恰好等于本进程（kill(pid,0) 会命中），但 starttime 是假的
  // （旧容器进程已死，新容器内同号 PID 的 starttime 必然不同）。
  const bogusStarttime = realStarttime === "1" ? "2" : "1";
  writeLockFile(lockPath, {
    pid: process.pid,
    processRunId: "stale-run-from-old-container",
    startedAt: new Date().toISOString(),
    starttime: bogusStarttime,
  });

  const lock = new SingleWriterLock(lockDir, "t1", "new-run");
  await lock.acquire();
  assert.equal(lock.isHeld, true, "陈旧锁应被回收");
  await lock.release();
  assert.equal(lock.isHeld, false);
});

test("lock：真活锁（PID 存在且 starttime 一致）→ 拒绝，不回收", async (t) => {
  const realStarttime = readStarttime(process.pid);
  if (realStarttime === null) {
    t.skip("no /proc starttime available on this platform");
    return;
  }
  const base = mkdtempSync(join(tmpdir(), "lock-live-"));
  const lockDir = join(base, "locks");
  const lockPath = join(lockDir, "t1.lock");

  writeLockFile(lockPath, {
    pid: process.pid,
    processRunId: "live-run",
    startedAt: new Date().toISOString(),
    starttime: realStarttime,
  });

  const lock = new SingleWriterLock(lockDir, "t1", "new-run");
  await assert.rejects(lock.acquire(), /live process/);
});

test("lock：旧格式锁（无 starttime）→ 保持历史行为（PID 存活即拒绝）", async () => {
  const base = mkdtempSync(join(tmpdir(), "lock-legacy-"));
  const lockDir = join(base, "locks");
  const lockPath = join(lockDir, "t1.lock");

  writeLockFile(lockPath, {
    pid: process.pid,
    processRunId: "legacy-run",
    startedAt: new Date().toISOString(),
  });

  const lock = new SingleWriterLock(lockDir, "t1", "new-run");
  await assert.rejects(lock.acquire(), /live process/);
});
