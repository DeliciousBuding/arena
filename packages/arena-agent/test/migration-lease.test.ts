/**
 * 迁移 lease 生效契约测试（migration-system-v1 §6.2，评审 P0-3）：
 * tick/墙钟双条件；任一过期或损坏 → fail-closed。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isMigrationLeaseFresh, migrationOrderAllowed } from "../src/migration/lease.ts";

const NOW_MS = Date.parse("2026-08-08T21:30:00.000Z");
const HEARTBEAT = "2026-08-08T21:30:00.000Z";

function lease(untilTick: number, heartbeatAt: string) {
  return { untilTick, heartbeatAt };
}

test("lease: tick 与心跳均新鲜 → 生效", () => {
  assert.equal(isMigrationLeaseFresh(lease(74123, HEARTBEAT), 74000, NOW_MS), true);
});

test("lease: tick 过期 → 不生效（fail-closed）", () => {
  assert.equal(isMigrationLeaseFresh(lease(73999, HEARTBEAT), 74000, NOW_MS), false);
});

test("lease: 心跳过期（超过 TTL）→ 不生效", () => {
  const staleHeartbeat = new Date(NOW_MS - 61_000).toISOString();
  assert.equal(isMigrationLeaseFresh(lease(74123, staleHeartbeat), 74000, NOW_MS), false);
});

test("lease: 心跳刚好在 TTL 内 → 生效", () => {
  const edgeHeartbeat = new Date(NOW_MS - 60_000).toISOString();
  assert.equal(isMigrationLeaseFresh(lease(74123, edgeHeartbeat), 74000, NOW_MS), true);
});

test("lease: 自定义 TTL 生效", () => {
  const staleHeartbeat = new Date(NOW_MS - 31_000).toISOString();
  assert.equal(
    isMigrationLeaseFresh(lease(74123, staleHeartbeat), 74000, NOW_MS, { heartbeatTtlMs: 30_000 }),
    false,
  );
});

test("lease: 心跳时间戳非法 → 不生效（fail-closed）", () => {
  assert.equal(isMigrationLeaseFresh(lease(74123, "not-a-date"), 74000, NOW_MS), false);
});

test("lease: 非有限数字输入 → 不生效", () => {
  assert.equal(isMigrationLeaseFresh(lease(Number.NaN, HEARTBEAT), 74000, NOW_MS), false);
  assert.equal(isMigrationLeaseFresh(lease(74123, HEARTBEAT), Number.POSITIVE_INFINITY, NOW_MS), false);
});

test("migrationOrderAllowed: 与 lease 判定一致（订单执行前置条件）", () => {
  assert.equal(migrationOrderAllowed(lease(74123, HEARTBEAT), 74000, NOW_MS), true);
  assert.equal(migrationOrderAllowed(lease(73999, HEARTBEAT), 74000, NOW_MS), false);
});
