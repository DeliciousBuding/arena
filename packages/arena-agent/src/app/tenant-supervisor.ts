/** Native multi-tenant process supervisor. One child process owns one tenant writer. */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { loadRuntimeConfig, type TenantRuntimeConfig } from "./runtime-config.ts";
import { resolveDeterministicVariantsConfig, resolveVariantsConfig } from "../strategies/variant-registry.ts";
import {
  resolveArenaDataRoot,
  resolveArenaRuntimeRoot,
  resolveTenantBaseDir,
} from "./data-root.ts";
import { appendJsonlLine } from "../telemetry/jsonl-writer.ts";

const execFileAsync = promisify(execFile);

export type TenantLifecycle =
  | "starting"
  | "ready"
  | "degraded"
  | "terminating"
  | "exited"
  | "failed";

export type SupervisorEventType =
  | "spawned"
  | "restarting"
  | "ready"
  | "readiness_lost"
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
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
}

export interface TenantSpec {
  readonly configName: string;
  readonly configPath: string;
  readonly config: TenantRuntimeConfig;
  readonly tenantId: string;
  readonly lockPath: string;
}

export interface TenantStatus {
  readonly tenantId: string;
  readonly pid: number | null;
  readonly alive: boolean;
  readonly ready: boolean;
  readonly lifecycle: TenantLifecycle;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly terminating: boolean;
  readonly lastError: string | null;
}

export interface TenantSupervisorOptions {
  readonly repoRoot: string;
  /** Shared data root. Defaults to the sibling directory ../data. */
  readonly dataRoot?: string;
  /** Tenant config directory. Relative paths resolve from repoRoot. */
  readonly configRoot?: string;
  /** Shared runtime root for events and tenant baseDir validation. */
  readonly runtimeRoot?: string;
  readonly configs: readonly string[];
  readonly tenantArgs?: readonly string[];
  readonly spawnChild?: (args: readonly string[], spec: TenantSpec) => ChildProcess;
  readonly forceKillTree?: (child: ChildProcess) => Promise<void>;
  readonly onEvent?: (event: SupervisorEvent) => void;
  /** 单租户意外退出自动重启（2026-08-08）：延迟 ms（缺省 5000）与上限（缺省 3）。 */
  readonly respawnDelayMs?: number;
  readonly respawnLimit?: number;
  readonly shutdownTimeoutMs?: number;
  readonly eventLogPath?: string;
}

interface TenantChild {
  readonly spec: TenantSpec;
  child: ChildProcess;
  pid: number;
  exitCode: number | null;
  exitSignal: string | null;
  exited: boolean;
  terminating: boolean;
  lifecycle: TenantLifecycle;
  everReady: boolean;
  lastError: string | null;
  /** 意外退出自动重启计数（超限交 watchdog 全量恢复）。 */
  respawnCount: number;
}

interface LockContent {
  readonly pid: number;
  readonly processRunId?: string;
}

export class TenantSupervisor {
  readonly repoRoot: string;
  readonly dataRoot: string;
  readonly configRoot: string;
  readonly runtimeRoot: string;

  private readonly options: TenantSupervisorOptions;
  private readonly children = new Map<string, TenantChild>();
  private specs: readonly TenantSpec[] | null = null;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly exitWaiters = new Set<() => void>();
  private readonly eventLogPath: string;

  constructor(options: TenantSupervisorOptions) {
    this.repoRoot = resolve(options.repoRoot);
    this.dataRoot = options.dataRoot === undefined
      ? resolveArenaDataRoot(this.repoRoot)
      : resolveFromRepo(this.repoRoot, options.dataRoot);
    const defaultRuntimeRoot = resolveArenaRuntimeRoot(this.dataRoot);
    this.configRoot = options.configRoot === undefined
      ? join(defaultRuntimeRoot, "configs")
      : resolveFromRepo(this.repoRoot, options.configRoot);
    this.runtimeRoot = options.runtimeRoot === undefined
      ? defaultRuntimeRoot
      : resolveFromRepo(this.repoRoot, options.runtimeRoot);
    this.options = options;
    mkdirSync(this.runtimeRoot, { recursive: true });
    this.eventLogPath = options.eventLogPath ?? join(this.runtimeRoot, "supervisor.jsonl");
    writeFileSync(this.eventLogPath, "", { flag: "a" });
  }

  /** Validate the complete cluster before the first spawn. */
  preflight(): readonly TenantSpec[] {
    if (this.specs !== null) return this.specs;
    if (this.options.configs.length === 0) throw new Error("at least one tenant config is required");

    const configRoot = this.configRoot;
    const seenPaths = new Set<string>();
    const seenTenants = new Set<string>();
    const specs: TenantSpec[] = [];

    for (const configName of this.options.configs) {
      const configPath = resolve(configRoot, configName);
      const rel = relative(configRoot, configPath);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`config path must stay under configured config root: ${configName}`);
      }
      const key = configPath.toLowerCase();
      if (seenPaths.has(key)) throw new Error(`duplicate config path: ${configName}`);
      seenPaths.add(key);
      if (!existsSync(configPath) || !statSync(configPath).isFile()) {
        throw new Error(`config not found: ${configPath}`);
      }

      const config = loadRuntimeConfig(configPath);
      if (seenTenants.has(config.tenantId)) throw new Error(`duplicate tenantId: ${config.tenantId}`);
      seenTenants.add(config.tenantId);
      const secret = process.env[config.arenaTokenEnv];
      if (secret === undefined || secret.length === 0) {
        throw new Error(`env ${config.arenaTokenEnv} missing for tenant ${config.tenantId}`);
      }

      const baseDir = resolveTenantBaseDir(this.dataRoot, config.baseDir);
      if (baseDir !== this.runtimeRoot) {
        throw new Error(
          `tenant ${config.tenantId} baseDir must match supervisor runtimeRoot: ${this.runtimeRoot}`,
        );
      }
      specs.push({
        configName,
        configPath,
        config,
        tenantId: config.tenantId,
        lockPath: join(baseDir, config.tenantId, "locks", `${config.tenantId}.lock`),
      });
    }

    this.specs = Object.freeze(specs);
    return this.specs;
  }

  /** Start all tenants only after complete preflight. Partial spawn is rolled back. */
  async start(): Promise<Map<string, boolean>> {
    if (this.children.size > 0) throw new Error("supervisor already started");
    const specs = this.preflight();
    const results = new Map<string, boolean>();

    try {
      for (const spec of specs) {
        const args = [
          "--config",
          spec.configPath,
          "--repoRoot",
          this.repoRoot,
          "--data-root",
          this.dataRoot,
          ...(this.options.tenantArgs ?? []),
        ];
        const entry = this.spawnTenant(spec, null);
        this.children.set(spec.tenantId, entry);
        results.set(spec.tenantId, true);
      }
      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("error", "cluster", `partial start rollback: ${message}`);
      await this.shutdown();
      throw error;
    }
  }

  /** 构建单租户启动参数（start/respawn 共用）。 */
  private buildTenantArgs(spec: TenantSpec): string[] {
    return [
      "--config",
      spec.configPath,
      "--repoRoot",
      this.repoRoot,
      "--data-root",
      this.dataRoot,
      ...(this.options.tenantArgs ?? []),
    ];
  }

  /** Spawn 一个租户 child 并挂监听（start 与 respawn 共用）。previous 非空时
   *  复用 entry 对象（新 child 接管），children map 引用保持稳定。 */
  private spawnTenant(spec: TenantSpec, previous: TenantChild | null): TenantChild {
    const args = this.buildTenantArgs(spec);
    const child = (this.options.spawnChild ?? ((argv) => spawnChildProcess(this.repoRoot, argv)))(args, spec);
    if (!Number.isInteger(child.pid) || (child.pid ?? 0) <= 0) {
      throw new Error(`spawned child has no valid pid for tenant ${spec.tenantId}`);
    }
    const entry: TenantChild = previous ?? {
      spec,
      child,
      pid: child.pid!,
      exitCode: null,
      exitSignal: null,
      exited: false,
      terminating: false,
      lifecycle: "starting",
      everReady: false,
      lastError: null,
      respawnCount: 0,
    };
    if (previous !== null) {
      entry.child = child;
      entry.pid = child.pid!;
      entry.exitCode = null;
      entry.exitSignal = null;
      entry.exited = false;
      entry.lifecycle = "starting";
    }
    child.stdout?.on("data", (chunk) => process.stdout.write(`[${spec.tenantId}] ${chunk}`));
    child.stderr?.on("data", (chunk) => process.stderr.write(`[${spec.tenantId}] ${chunk}`));
    child.on("error", (error) => {
      entry.lastError = error.message;
      if (!entry.terminating) entry.lifecycle = "failed";
      this.emit("error", spec.tenantId, error.message, entry.pid);
    });
    child.on("exit", (code, signal) => {
      entry.exitCode = code;
      entry.exitSignal = signal;
      entry.exited = true;
      entry.lifecycle = entry.terminating || code === 0 ? "exited" : "failed";
      const finalExit = entry.terminating || code === 0 || !this.scheduleRespawn(entry, code, signal);
      if (finalExit) {
        if (!entry.terminating && code !== 0) {
          entry.lastError = `unexpected exit code=${String(code)} signal=${String(signal)}`;
        }
        this.emit("exited", spec.tenantId, undefined, entry.pid, code, signal);
        this.notifyExitWaiters();
      }
    });
    this.emit("spawned", spec.tenantId, undefined, entry.pid, null, null);
    return entry;
  }

  /** 单租户意外退出自动重启（2026-08-08）：避免单线死 → watchdog 全量重启 →
   *  空窗（t3 worker 减员即发生在该空窗）。带重启上限防崩溃循环；超限交
   *  watchdog 全量恢复。返回 true = 已接管（不触发 final-exit 通知）。 */
  private scheduleRespawn(entry: TenantChild, code: number | null, signal: string | null): boolean {
    if (entry.terminating || this.shuttingDown) return false;
    const limit = this.options.respawnLimit ?? 3;
    if (entry.respawnCount >= limit) {
      entry.lastError = `unexpected exit code=${String(code)} signal=${String(signal)}; respawn limit ${limit} reached`;
      return false;
    }
    entry.respawnCount += 1;
    entry.lifecycle = "starting";
    this.emit("restarting", entry.spec.tenantId, `auto-respawn ${entry.respawnCount}/${limit} after exit code=${String(code)}`, entry.pid);
    const delayMs = this.options.respawnDelayMs ?? 5000;
    setTimeout(() => { void this.respawnTenant(entry); }, delayMs).unref?.();
    return true;
  }

  /** 延迟后重建租户 child（entry 复用；锁由 run-tenant 自检/自清，异常时交
   *  watchdog 全量恢复）。 */
  private async respawnTenant(entry: TenantChild): Promise<void> {
    if (entry.terminating || this.shuttingDown) return;
    try {
      this.spawnTenant(entry.spec, entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.lastError = message;
      entry.lifecycle = "failed";
      this.emit("error", entry.spec.tenantId, `respawn failed: ${message}`, entry.pid);
      this.emit("exited", entry.spec.tenantId, undefined, entry.pid, null, null);
      this.notifyExitWaiters();
    }
  }

  tenantIds(): readonly string[] {
    if (this.specs !== null) return this.specs.map((spec) => spec.tenantId);
    if (this.children.size > 0) return [...this.children.keys()];
    return this.options.configs.map((name) => name.replace(/\.json$/i, ""));
  }

  status(): TenantStatus[] {
    const statuses: TenantStatus[] = [];
    for (const entry of this.children.values()) {
      this.refreshReadiness(entry);
      statuses.push({
        tenantId: entry.spec.tenantId,
        pid: entry.pid,
        alive: !entry.exited,
        ready: entry.lifecycle === "ready",
        lifecycle: entry.lifecycle,
        exitCode: entry.exitCode,
        exitSignal: entry.exitSignal,
        terminating: entry.terminating,
        lastError: entry.lastError,
      });
    }
    return statuses;
  }

  isReady(): boolean {
    const expected = this.specs?.length ?? 0;
    const statuses = this.status();
    return expected > 0 && statuses.length === expected && statuses.every((entry) => entry.ready);
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  allExited(): boolean {
    return this.children.size > 0 && [...this.children.values()].every((entry) => entry.exited);
  }

  waitForAllExited(): Promise<void> {
    if (this.children.size === 0 || this.allExited()) return Promise.resolve();
    return new Promise((resolvePromise) => this.exitWaiters.add(resolvePromise));
  }

  /** Ask each child to clean itself through IPC; force-kill the complete tree on timeout. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }

  /** 配置热加载（2026-08-08）：按租户重读 config → schema/变体 preflight →
   *  IPC 通知 child 应用（child 内部 last-good，非法配置不应用）。
   *  tenantId 缺省 = 全部。返回每租户 sent/error。 */
  reloadConfigs(tenantId?: string): Readonly<Record<string, { sent: boolean; error: string | null }>> {
    const result: Record<string, { sent: boolean; error: string | null }> = {};
    for (const [id, entry] of this.children) {
      if (tenantId !== undefined && id !== tenantId) continue;
      try {
        const nextConfig = loadRuntimeConfig(entry.spec.configPath);
        resolveVariantsConfig(nextConfig.variants);
        resolveDeterministicVariantsConfig(nextConfig.variants);
        if (entry.child.connected && typeof entry.child.send === "function") {
          entry.child.send({ type: "arena.config_reload" }, () => {});
          result[id] = { sent: true, error: null };
        } else {
          result[id] = { sent: false, error: "child IPC not connected" };
        }
      } catch (error) {
        result[id] = { sent: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return result;
  }

  private async shutdownInternal(): Promise<void> {
    if (this.children.size === 0 || this.allExited()) return;
    this.emit("terminating", "all", "arena.shutdown to all tenants");

    for (const entry of this.children.values()) {
      if (entry.exited) continue;
      entry.terminating = true;
      entry.lifecycle = "terminating";
      try {
        if (entry.child.connected && typeof entry.child.send === "function") {
          entry.child.send({ type: "arena.shutdown" }, () => {});
        } else {
          entry.child.kill("SIGTERM");
        }
      } catch (error) {
        entry.lastError = error instanceof Error ? error.message : String(error);
      }
    }

    const timeoutMs = this.options.shutdownTimeoutMs ?? 8000;
    this.closeTimer = setTimeout(() => {
      void Promise.all([...this.children.values()].map(async (entry) => {
        if (entry.exited) return;
        this.emit("timeout_killed", entry.spec.tenantId, `process tree kill after ${timeoutMs}ms`, entry.pid);
        try {
          await (this.options.forceKillTree ?? forceKillProcessTree)(entry.child);
        } catch (error) {
          entry.lastError = error instanceof Error ? error.message : String(error);
          this.emit("error", entry.spec.tenantId, entry.lastError, entry.pid);
        }
      }));
    }, timeoutMs);
    this.closeTimer.unref?.();

    await this.waitForAllExited();
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.emit("all_exited", "all");
  }

  private refreshReadiness(entry: TenantChild): void {
    if (entry.exited || entry.terminating || entry.lifecycle === "failed") return;
    const lock = readLock(entry.spec.lockPath);
    const ready = lock?.pid === entry.pid;
    if (ready) {
      if (entry.lifecycle !== "ready") {
        entry.lifecycle = "ready";
        entry.everReady = true;
        entry.lastError = null;
        this.emit("ready", entry.spec.tenantId, undefined, entry.pid);
      }
      return;
    }

    if (entry.lifecycle === "ready" || entry.everReady) {
      entry.lifecycle = "degraded";
      entry.lastError = "single-writer lock missing or pid mismatch";
      this.emit("readiness_lost", entry.spec.tenantId, entry.lastError, entry.pid);
    } else {
      entry.lifecycle = "starting";
    }
  }

  private notifyExitWaiters(): void {
    if (!this.allExited()) return;
    for (const resolvePromise of this.exitWaiters) resolvePromise();
    this.exitWaiters.clear();
  }

  private emit(
    type: SupervisorEventType,
    tenantId: string,
    detail?: string,
    pid?: number,
    exitCode?: number | null,
    signal?: string | null,
  ): void {
    const event: SupervisorEvent = {
      type,
      tenantId,
      at: new Date().toISOString(),
      ...(detail !== undefined ? { detail } : {}),
      ...(pid !== undefined ? { pid } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };
    this.options.onEvent?.(event);
    try {
      appendJsonlLine(this.eventLogPath, JSON.stringify(event));
    } catch {
      // Observability must not block the safety path.
    }
  }
}

function resolveFromRepo(repoRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(repoRoot, path);
}

function readLock(path: string): LockContent | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<LockContent>;
    return Number.isInteger(parsed.pid) ? { pid: parsed.pid!, processRunId: parsed.processRunId } : null;
  } catch {
    return null;
  }
}

function spawnChildProcess(repoRoot: string, args: readonly string[]): ChildProcess {
  const cliPath = join(repoRoot, "packages", "arena-agent", "src", "cli", "run-tenant.ts");
  return spawn(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: join(repoRoot, "packages", "arena-agent"),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
}

async function forceKillProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid! <= 0) return;
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("not found")) throw error;
    }
    return;
  }
  try {
    process.kill(-pid!, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
