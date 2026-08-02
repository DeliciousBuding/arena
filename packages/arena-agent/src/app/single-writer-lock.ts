/**
 * 单写者锁（切片 4 阶段 5，Agent B 地界，leader 接管）。
 *
 * 红线（GPT 裁决）：同一租户 Python/TS 只能有一个提交者。
 * 实现：`O_CREAT | O_EXCL` 原子创建锁文件（绝不用"先 exists 再 write"竞态）；
 * 锁内容 = { pid, processRunId, startedAt }；存活判定用 process.kill(pid, 0) 探测
 * （ESRCH=已死可回收；EACCES=存活拒绝）。活锁绝不自动抢占；释放只删自己的锁。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface LockContent {
  readonly pid: number;
  readonly processRunId: string;
  readonly startedAt: string;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH：进程不存在（可回收）；EACCES/EPERM：进程存在但无权限（存活）
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class SingleWriterLock {
  private readonly lockPath: string;
  private readonly processRunId: string;
  private held = false;

  constructor(lockDir: string, tenantId: string, processRunId: string) {
    this.lockPath = join(lockDir, `${tenantId}.lock`);
    this.processRunId = processRunId;
  }

  get isHeld(): boolean {
    return this.held;
  }

  /** 原子获取：O_EXCL 语义（临时文件 + rename，Windows rename 不覆盖）。
   *  已持有 → 幂等返回；他人活锁 → 抛错拒绝启动；陈旧锁（PID 已死）→ 回收后重试一次。 */
  async acquire(): Promise<void> {
    if (this.held) {
      return;
    }
    mkdirSync(dirname(this.lockPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (existsSync(this.lockPath)) {
        const existing = this.readLock();
        if (existing !== null && isPidAlive(existing.pid)) {
          throw new Error(
            `tenant lock held by live process pid=${existing.pid} processRunId=${existing.processRunId}（${this.lockPath}）`,
          );
        }
        // 陈旧锁（PID 已死）：回收重试
        rmSync(this.lockPath, { force: true });
      }
      try {
        // 原子创建：临时文件写入后 rename（Windows 上 rename 到已存在目标会失败 = O_EXCL 语义）
        const tmpPath = `${this.lockPath}.${process.pid}.tmp`;
        writeFileSync(
          tmpPath,
          JSON.stringify({ pid: process.pid, processRunId: this.processRunId, startedAt: new Date().toISOString() } satisfies LockContent),
          "utf-8",
        );
        renameSync(tmpPath, this.lockPath);
        this.held = true;
        return;
      } catch {
        // rename 失败（目标已存在）：竞争失败，下一轮重试或报活锁
        if (attempt === 1) {
          throw new Error(`tenant lock acquire race failed: ${this.lockPath}`);
        }
      }
    }
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
