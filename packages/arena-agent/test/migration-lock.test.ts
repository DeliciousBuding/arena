/**
 * conductor 租约锁测试（migration-system-v1 §6.2，评审 P0-3）：
 * 独占获取 / 活跃锁拒绝 / stale 接管 epoch+1 / 仅持有者可释放刷新。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  acquireConductorLock,
  refreshConductorLock,
  releaseConductorLock,
} from "../src/migration/lock.ts";

const TTL_MS = 60_000;

function makeLockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "arena-migration-lock-"));
  return join(dir, "t1.lock.json");
}

test("conductor-lock: 首次获取成功（epoch=0）", () => {
  const path = makeLockPath();
  const result = acquireConductorLock(path, "t1", 111, { heartbeatTtlMs: TTL_MS });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.epoch, 0);
    assert.equal(result.tookOver, false);
  }
  rmSync(path, { force: true, recursive: true });
});

test("conductor-lock: 活跃锁被第二个 conductor 拒绝（locked）", () => {
  const path = makeLockPath();
  acquireConductorLock(path, "t1", 111, { heartbeatTtlMs: TTL_MS });
  const second = acquireConductorLock(path, "t1", 222, { heartbeatTtlMs: TTL_MS });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.reason, "locked");
    assert.equal(second.holder?.pid, 111);
  }
  rmSync(path, { force: true, recursive: true });
});

test("conductor-lock: stale 锁被接管，epoch+1（fencing）", () => {
  const path = makeLockPath();
  acquireConductorLock(path, "t1", 111, { heartbeatTtlMs: TTL_MS });
  // 模拟旧 conductor 心跳过期（改锁文件 heartbeatAt 为 2 分钟前）
  const lock = JSON.parse(readFileSync(path, "utf8"));
  lock.heartbeatAt = new Date(Date.now() - 2 * 60_000).toISOString();
  writeFileSync(path, JSON.stringify(lock));

  const takeover = acquireConductorLock(path, "t1", 222, { heartbeatTtlMs: TTL_MS });
  assert.equal(takeover.ok, true);
  if (takeover.ok) {
    assert.equal(takeover.tookOver, true);
    assert.equal(takeover.epoch, 1);
  }
  rmSync(path, { force: true, recursive: true });
});

test("conductor-lock: 接管后旧持有者 refresh 失败、新持有者 refresh 成功", () => {
  const path = makeLockPath();
  acquireConductorLock(path, "t1", 111, { heartbeatTtlMs: TTL_MS });
  const lock = JSON.parse(readFileSync(path, "utf8"));
  lock.heartbeatAt = new Date(Date.now() - 2 * 60_000).toISOString();
  writeFileSync(path, JSON.stringify(lock));

  acquireConductorLock(path, "t1", 222, { heartbeatTtlMs: TTL_MS });
  // 旧持有者（pid 111, epoch 0）refresh 必须失败
  assert.equal(refreshConductorLock(path, "t1", 111, 0), false);
  // 新持有者（pid 222, epoch 1）refresh 成功
  assert.equal(refreshConductorLock(path, "t1", 222, 1), true);
  rmSync(path, { force: true, recursive: true });
});

test("conductor-lock: 仅持有者可释放（epoch 不匹配不误删）", () => {
  const path = makeLockPath();
  acquireConductorLock(path, "t1", 111, { heartbeatTtlMs: TTL_MS });
  // 旧 epoch 释放失败（防御误删新持有者）
  assert.equal(releaseConductorLock(path, "t1", 111, 5), false);
  assert.equal(existsSync(path), true);
  // 正确 epoch 释放成功
  assert.equal(releaseConductorLock(path, "t1", 111, 0), true);
  assert.equal(existsSync(path), false);
  rmSync(path, { force: true, recursive: true });
});

test("conductor-lock: 释放后可重新获取（epoch 重置为 0）", () => {
  const path = makeLockPath();
  acquireConductorLock(path, "t1", 111, { heartbeatTtlMs: TTL_MS });
  releaseConductorLock(path, "t1", 111, 0);
  const again = acquireConductorLock(path, "t1", 333, { heartbeatTtlMs: TTL_MS });
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.epoch, 0);
  rmSync(path, { force: true, recursive: true });
});
