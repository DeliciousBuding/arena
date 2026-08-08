/**
 * conductor 租约锁（migration-system-v1 §6.2，评审 P0-3）。
 *
 * 防"旧 conductor / 第二 supervisor 复活继续发命令"：
 * - 原子创建（flag "wx"）独占锁文件；已存在且心跳未过期 → 拒绝（locked）；
 * - 心跳过期（stale）→ 接管：epoch+1（旧 conductor 的计划因 epoch 不匹配
 *   被 runtime 拒绝，fencing 生效）；
 * - release/refresh 只允许持有者（pid + epoch 匹配）。
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const CONDUCTOR_LOCK_SCHEMA = "conductor-lock-v1";

export interface ConductorLockFile {
  readonly schema: typeof CONDUCTOR_LOCK_SCHEMA;
  readonly tenant: string;
  readonly epoch: number;
  readonly pid: number;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
}

export interface ConductorLockOptions {
  /** 锁心跳 TTL（ms）；超过视为 stale，可接管。 */
  readonly heartbeatTtlMs?: number;
}

export type ConductorLockAcquireResult =
  | { readonly ok: true; readonly epoch: number; readonly tookOver: boolean }
  | {
      readonly ok: false;
      readonly reason: "locked" | "error";
      readonly holder?: { readonly pid: number; readonly epoch: number; readonly heartbeatAt: string };
      readonly message?: string;
    };

export const DEFAULT_LOCK_HEARTBEAT_TTL_MS = 60_000;

function nowIso(): string {
  return new Date().toISOString();
}

function parseLockFile(raw: string): ConductorLockFile | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.schema !== CONDUCTOR_LOCK_SCHEMA ||
      typeof parsed.tenant !== "string" ||
      typeof parsed.epoch !== "number" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.acquiredAt !== "string" ||
      typeof parsed.heartbeatAt !== "string"
    ) {
      return null;
    }
    return parsed as unknown as ConductorLockFile;
  } catch {
    return null;
  }
}

function isStale(lock: ConductorLockFile, nowMs: number, heartbeatTtlMs: number): boolean {
  const heartbeatAtMs = Date.parse(lock.heartbeatAt);
  if (Number.isNaN(heartbeatAtMs)) return true; // 心跳时间戳损坏 → 视为 stale（可接管）
  return nowMs - heartbeatAtMs > heartbeatTtlMs;
}

/**
 * 获取租户级 conductor 锁。成功时写入锁文件（含 epoch）；stale 接管返回
 * tookOver=true 且 epoch 为旧值 +1。
 */
export function acquireConductorLock(
  lockPath: string,
  tenant: string,
  pid: number,
  options: ConductorLockOptions = {},
): ConductorLockAcquireResult {
  const heartbeatTtlMs = options.heartbeatTtlMs ?? DEFAULT_LOCK_HEARTBEAT_TTL_MS;
  const nowMs = Date.now();
  const existing = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null;

  let nextEpoch = 0;
  let tookOver = false;
  if (existing !== null) {
    const lock = parseLockFile(existing);
    if (lock === null) {
      return { ok: false, reason: "error", message: "锁文件损坏（不可自动接管）" };
    }
    if (!isStale(lock, nowMs, heartbeatTtlMs)) {
      return {
        ok: false,
        reason: "locked",
        holder: { pid: lock.pid, epoch: lock.epoch, heartbeatAt: lock.heartbeatAt },
      };
    }
    nextEpoch = lock.epoch + 1;
    tookOver = true;
  }

  const now = nowIso();
  const lockFile: ConductorLockFile = {
    schema: CONDUCTOR_LOCK_SCHEMA,
    tenant,
    epoch: nextEpoch,
    pid,
    acquiredAt: now,
    heartbeatAt: now,
  };

  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    // 原子独占创建：已存在则失败（stale 场景先删再写，窗口极小且 runtime
    // 侧 epoch 校验兜底）。
    if (existsSync(lockPath) && !tookOver) {
      return { ok: false, reason: "locked", message: "锁文件已存在" };
    }
    if (tookOver) unlinkSync(lockPath);
    writeFileSync(lockPath, JSON.stringify(lockFile, null, 2), { encoding: "utf8", flag: "wx" });
    return { ok: true, epoch: nextEpoch, tookOver };
  } catch (error) {
    return {
      ok: false,
      reason: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 续心跳（仅持有者）。失败 = 锁被接管/已释放。 */
export function refreshConductorLock(
  lockPath: string,
  tenant: string,
  pid: number,
  epoch: number,
): boolean {
  if (!existsSync(lockPath)) return false;
  const lock = parseLockFile(readFileSync(lockPath, "utf8"));
  if (lock === null || lock.tenant !== tenant || lock.pid !== pid || lock.epoch !== epoch) {
    return false;
  }
  const updated: ConductorLockFile = { ...lock, heartbeatAt: nowIso() };
  writeFileSync(lockPath, JSON.stringify(updated, null, 2), "utf8");
  return true;
}

/** 释放锁（仅持有者；epoch 不匹配不删除——可能是新持有者，防误删）。 */
export function releaseConductorLock(
  lockPath: string,
  tenant: string,
  pid: number,
  epoch: number,
): boolean {
  if (!existsSync(lockPath)) return false;
  const lock = parseLockFile(readFileSync(lockPath, "utf8"));
  if (lock === null || lock.tenant !== tenant || lock.pid !== pid || lock.epoch !== epoch) {
    return false;
  }
  unlinkSync(lockPath);
  return true;
}
