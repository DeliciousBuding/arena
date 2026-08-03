/**
 * TenantSupervisor（切片 5）：管理 4 个租户 run-tenant 子进程。
 *
 * - spawn 每租户一个子进程（run-tenant CLI，--config + --repoRoot 透传）；
 * - 事件流落 supervisor.jsonl（spawned / exited / signal / timeout_killed）；
 * - SIGINT/SIGTERM → 全子进程 SIGTERM，超时 SIGKILL（孤儿兜底）；
 * - 任一子进程异常退出不自动重启（本轮不做自愈，退出码聚合上报）；
 * - spawn 可注入（测试 fake child），核心逻辑与 CLI 解耦。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type SupervisorEventType =
  | "spawned"
  | "exited"
  | "signal_received"
  | "terminating"
  | "timeout_killed"
  | "all_exited"
  | "error";

export interface SupervisorEvent {
  readonly type: SupervisorEventType;
  readonly tenantId: string;
  readonly at: string;
  readonly detail?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
}

export interface TenantSupervisorOptions {
  readonly repoRoot: string;
  /** 相对 repoRoot/runtime/configs 的配置名（如 t1.json），顺序即租户顺序。 */
  readonly configs: readonly string[];
  /** 透传给 run-tenant 的固定参数（如 --live、--mode=...）。 */
  readonly tenantArgs?: readonly string[];
  /** 可注入 spawn（测试 fake child）。缺省用 node:child_process spawn。 */
  readonly spawnChild?: (args: readonly string[]) => ChildProcess;
  /** 事件回调（测试/日志用）。 */
  readonly onEvent?: (event: SupervisorEvent) => void;
  /** SIGTERM 后强制 SIGKILL 的超时（缺省 8000ms）。 */
  readonly shutdownTimeoutMs?: number;
  /** supervisor 事件落盘路径（缺省 <repoRoot>/runtime/supervisor.jsonl）。 */
  readonly eventLogPath?: string;
}

interface TenantChild {
  readonly tenantId: string;
  readonly child: ChildProcess;
  exitCode: number | null;
  exitSignal: string | null;
  exited: boolean;
  /** 关闭期间记录：已发 SIGTERM。 */
  terminating: boolean;
}

export class TenantSupervisor {
  readonly repoRoot: string;

  private readonly options: TenantSupervisorOptions;
  private readonly children = new Map<string, TenantChild>();
  private shuttingDown = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TenantSupervisorOptions) {
    this.repoRoot = options.repoRoot;
    this.options = options;
    mkdirSync(join(this.repoRoot, "runtime"), { recursive: true });
    const logPath = options.eventLogPath ?? join(this.repoRoot, "runtime", "supervisor.jsonl");
    if (!this.logInited) {
      writeFileSync(logPath, "", { flag: "a" });
      this.logInited = true;
    }
    this.eventLogPath = logPath;
  }

  private logInited = false;
  private readonly eventLogPath: string;

  /** 启动全部租户子进程（顺序与 configs 一致）。返回 tenantId → 是否启动成功。 */
  start(): Map<string, boolean> {
    const results = new Map<string, boolean>();
    for (const config of this.options.configs) {
      const tenantId = config.replace(/\.json$/, "");
      const args = [
        "--config",
        resolve(this.repoRoot, "runtime", "configs", config),
        "--repoRoot",
        this.repoRoot,
        ...(this.options.tenantArgs ?? []),
      ];
      try {
        const child = (this.options.spawnChild ?? ((argv) => spawnChildProcess(this.repoRoot, argv)))(args);
        const entry: TenantChild = {
          tenantId,
          child,
          exitCode: null,
          exitSignal: null,
          exited: false,
          terminating: false,
        };
        this.children.set(tenantId, entry);
        child.stdout?.on("data", (chunk) => process.stdout.write(`[${tenantId}] ${chunk}`));
        child.stderr?.on("data", (chunk) => process.stderr.write(`[${tenantId}] ${chunk}`));
        child.on("error", (error) => {
          this.emit("error", tenantId, error.message);
        });
        child.on("exit", (code, signal) => {
          entry.exitCode = code;
          entry.exitSignal = signal;
          entry.exited = true;
          this.emit("exited", tenantId, undefined, code, signal);
        });
        this.emit("spawned", tenantId, undefined, null, null);
        results.set(tenantId, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit("error", tenantId, message);
        results.set(tenantId, false);
      }
    }
    return results;
  }

  /** 当前租户存活状态（debug API 数据源）。 */
  status(): Array<{
    tenantId: string;
    alive: boolean;
    exitCode: number | null;
    exitSignal: string | null;
    terminating: boolean;
  }> {
    return [...this.children.entries()].map(([tenantId, entry]) => ({
      tenantId,
      alive: !entry.exited,
      exitCode: entry.exitCode,
      exitSignal: entry.exitSignal,
      terminating: entry.terminating,
    }));
  }

  /** 是否全部子进程已退出。 */
  allExited(): boolean {
    return this.children.size > 0 && [...this.children.values()].every((entry) => entry.exited);
  }

  /** 优雅关闭：全子进程 SIGTERM → 超时 SIGKILL。resolve 于全部退出。 */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.emit("terminating", "all", "SIGTERM to all tenants");
    for (const entry of this.children.values()) {
      entry.terminating = true;
      if (!entry.exited) {
        entry.child.kill("SIGTERM");
      }
    }
    const timeoutMs = this.options.shutdownTimeoutMs ?? 8000;
    if (this.closeTimer === null) {
      this.closeTimer = setTimeout(() => {
        for (const entry of this.children.values()) {
          if (!entry.exited) {
            this.emit("timeout_killed", entry.tenantId, `SIGKILL after ${timeoutMs}ms`);
            entry.child.kill("SIGKILL");
          }
        }
      }, timeoutMs);
      this.closeTimer.unref?.();
    }
    await this.waitForExit();
  }

  /** 等待全部退出（轮询 100ms；注入 fake child 时依赖其 exit 事件）。 */
  private waitForExit(): Promise<void> {
    return new Promise((resolvePromise) => {
      const poll = setInterval(() => {
        if (this.allExited()) {
          clearInterval(poll);
          this.emit("all_exited", "all", undefined, null, null);
          resolvePromise();
        }
      }, 100);
    });
  }

  private emit(
    type: SupervisorEventType,
    tenantId: string,
    detail?: string,
    exitCode?: number | null,
    signal?: string | null,
  ): void {
    const event: SupervisorEvent = {
      type,
      tenantId,
      at: new Date().toISOString(),
      ...(detail !== undefined ? { detail } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };
    this.options.onEvent?.(event);
    try {
      appendFileSync(this.eventLogPath, `${JSON.stringify(event)}\n`, "utf-8");
    } catch {
      // 事件落盘失败不阻塞关闭路径
    }
  }
}

/** 默认 spawn：node --import tsx 运行 run-tenant CLI（工作目录 = arena-agent）。 */
function spawnChildProcess(repoRoot: string, args: readonly string[]): ChildProcess {
  const cliPath = join(repoRoot, "packages", "arena-agent", "src", "cli", "run-tenant.ts");
  const cwd = join(repoRoot, "packages", "arena-agent");
  return spawn(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}
