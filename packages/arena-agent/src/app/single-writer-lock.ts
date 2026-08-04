/**
 * 单写者锁（切片 4 阶段 5，Agent B 地界，leader 接管）。
 *
 * 红线（GPT 裁决）：同一租户 Python/TS 只能有一个提交者。
 * 实现：`O_CREAT | O_EXCL` 原子创建锁文件（绝不用"先 exists 再 write"竞态）；
 * 锁内容 = { pid, processRunId, startedAt, starttime }；存活判定分两步：
 *   1. `process.kill(pid, 0)` 探测（ESRCH=已死可回收；EACCES=存活拒绝）；
 *   2. 读 `/proc/<pid>/stat` 的 starttime 与锁内记录对比，防止 PID 复用误判
 *      （容器重启后新 namespace 内同号 PID 是别的进程，starttime 必不同 → 陈旧锁可回收）。
 * 活锁绝不自动抢占；释放只删自己的锁。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface LockContent {
  readonly pid: number;
  readonly processRunId: string;
  readonly startedAt: string;
  readonly starttime?: string;
}

/** 进程可被 signal 0 探测到（EACCES 也视为存活：存在但无权限）。 */
function isPidReachable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH：进程不存在；EACCES/EPERM：进程存在但无权限（存活）
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 读取 /proc/<pid>/stat 的 starttime（第 22 字段，进程启动时钟 tick）。
 *  comm 可能含空格/括号，因此从最后一个 ')' 之后开始切分。 */
function readStarttime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
    const fields = afterComm.split(" ");
    // fields[0] = state（第 3 字段）…… starttime 是第 22 字段 → 索引 19
    const starttime = fields[19];
    return typeof starttime === "string" && starttime.length > 0 ? starttime : null;
  } catch {
    return null;
  }
}

/** 锁持有者是否仍然存活。PID 存在且 starttime 与锁内记录一致才算真活锁；
 *  跨容器 PID 复用（starttime 不一致）视为陈旧锁，允许回收。 */
function lockOwnerAlive(existing: LockContent): boolean {
  if (!isPidReachable(existing.pid)) {
    return false;
  }
  if (existing.starttime === undefined) {
    // 旧格式锁（无 starttime）：退化为仅 PID 探测，保持历史行为。
    return true;
  }
  const currentStarttime = readStarttime(existing.pid);
  if (currentStarttime === null) {
    // 无法读取 /proc（如 Windows）：保守视为存活，宁可拒启也不误删活锁。
    return true;
  }
  return currentStarttime === existing.starttime;
}

export class SingleWriterLock {
  private readonly lockPath: string;
  private readonly reclaimPath: string;
  private readonly processRunId: string;
  private held = false;

  constructor(lockDir: string, tenantId: string, processRunId: string) {
    this.lockPath = join(lockDir, `${tenantId}.lock`);
    this.reclaimPath = `${this.lockPath}.reclaim`;
    this.processRunId = processRunId;
  }

  get isHeld(): boolean {
    return this.held;
  }

  /** 原子获取：直接用 `wx`（O_CREAT | O_EXCL），不再用 rename 模拟独占。
   *  已持有 → 幂等返回；他人活锁 → 抛错拒绝启动；陈旧锁（PID 已死或 PID 被复用）→
   *  先持有独立 reclaim guard，再删除陈旧锁并重试。 */
  async acquire(): Promise<void> {
    if (this.held) {
      return;
    }
    mkdirSync(dirname(this.lockPath), { recursive: true });
    const content = JSON.stringify({
      pid: process.pid,
      processRunId: this.processRunId,
      startedAt: new Date().toISOString(),
      starttime: readStarttime(process.pid) ?? undefined,
    } satisfies LockContent);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        writeFileSync(this.lockPath, content, { encoding: "utf-8", flag: "wx" });
        this.held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }

      const existing = this.readLock();
      if (existing === null) {
        throw new Error(`tenant lock exists but is unreadable; fail closed（${this.lockPath}）`);
      }
      if (lockOwnerAlive(existing)) {
        throw new Error(
          `tenant lock held by live process pid=${existing.pid} processRunId=${existing.processRunId}（${this.lockPath}）`,
        );
      }

      // 只有一个进程可以清理陈旧锁。其他竞争者 fail-closed，避免误删刚建立的新活锁。
      try {
        writeFileSync(this.reclaimPath, content, { encoding: "utf-8", flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`tenant stale-lock reclaim already in progress（${this.reclaimPath}）`);
        }
        throw error;
      }
      try {
        const current = this.readLock();
        if (current === null) {
          throw new Error(`tenant lock became unreadable during reclaim; fail closed（${this.lockPath}）`);
        }
        if (lockOwnerAlive(current)) {
          throw new Error(
            `tenant lock became live during reclaim pid=${current.pid} processRunId=${current.processRunId}（${this.lockPath}）`,
          );
        }
        rmSync(this.lockPath);
      } finally {
        rmSync(this.reclaimPath, { force: true });
      }
    }
    throw new Error(`tenant lock acquire race failed: ${this.lockPath}`);
  }

  /** 释放：只删自己的锁（processRunId 匹配才删，防误删他人）。 */
  async release(): Promise<void> {
    if (!this.held) {
      return;
    }
    const existing = this.readLock();
    if (existing !== null && existing.processRunId === this.processRunId) {
      rmSync(this.lockPath, { force: true });
    }
    this.held = false;
  }

  private readLock(): LockContent | null {
    try {
      const parsed = JSON.parse(readFileSync(this.lockPath, "utf-8")) as LockContent;
      return typeof parsed.pid === "number" ? parsed : null;
    } catch {
      return null;
    }
  }
}
