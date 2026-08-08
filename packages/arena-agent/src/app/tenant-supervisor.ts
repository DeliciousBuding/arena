/** Native multi-tenant process supervisor. One child process owns one tenant writer. */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { TenantRuntimeConfig } from "./runtime-config.ts";
import { compileRuntimeStrategyFile, hotReloadCompatibility } from "./strategy-config.ts";
import {
  isTenantRuntimeIpcMessage,
  type ConfigReloadRequest,
  type ConfigReloadResult,
} from "./config-reload-protocol.ts";
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
  readonly configHash: string;
  readonly strategyHash: string;
  readonly tenantId: string;
  readonly lockPath: string;
}

export interface TenantStatus {
  readonly tenantId: string;
  readonly pid: number | null;
  readonly alive: boolean;
  /** Backward-compatible writer-lock readiness. */
  readonly ready: boolean;
  readonly lifecycle: TenantLifecycle;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly terminating: boolean;
  readonly lastError: string | null;
  /** Independent config attestation: process can be writer-ready while running stale config. */
  readonly configReady: boolean;
  readonly configGeneration: number;
  readonly activeConfigHash: string | null;
  readonly desiredConfigHash: string | null;
  readonly activeStrategyHash: string | null;
  readonly lastConfigError: string | null;
}

export interface SupervisorReloadResult {
  readonly sent: boolean;
  readonly applied: boolean;
  readonly configGeneration: number;
  readonly activeConfigHash: string | null;
  readonly desiredConfigHash: string | null;
  readonly activeStrategyHash: string | null;
  readonly errorCode?: ConfigReloadResult["errorCode"] | "ipc_unavailable" | "ack_timeout";
  readonly error: string | null;
  readonly restartRequiredFields?: readonly string[];
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
  readonly shutdownTimeoutMs?: number;
  /** Config reload request→ACK timeout. Kept short because live planner remains on last-good. */
  readonly configReloadTimeoutMs?: number;
  readonly eventLogPath?: string;
}

interface TenantChild {
  readonly spec: TenantSpec;
  readonly child: ChildProcess;
  readonly pid: number;
  exitCode: number | null;
  exitSignal: string | null;
  exited: boolean;
  terminating: boolean;
  lifecycle: TenantLifecycle;
  everReady: boolean;
  lastError: string | null;
  activeConfig: TenantRuntimeConfig;
  configGeneration: number;
  activeConfigHash: string | null;
  desiredConfigHash: string | null;
  activeStrategyHash: string | null;
  lastConfigError: string | null;
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

      const compiled = compileRuntimeStrategyFile(configPath);
      const config = compiled.config;
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
        configHash: compiled.configHash,
        strategyHash: compiled.strategyHash,
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
        const child = (this.options.spawnChild ?? ((argv) => spawnChildProcess(this.repoRoot, argv)))(args, spec);
        if (!Number.isInteger(child.pid) || (child.pid ?? 0) <= 0) {
          throw new Error(`spawned child has no valid pid for tenant ${spec.tenantId}`);
        }
        const entry: TenantChild = {
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
          activeConfig: spec.config,
          configGeneration: 0,
          activeConfigHash: null,
          desiredConfigHash: spec.configHash,
          activeStrategyHash: null,
          lastConfigError: null,
        };
        this.children.set(spec.tenantId, entry);
        child.stdout?.on("data", (chunk) => process.stdout.write(`[${spec.tenantId}] ${chunk}`));
        child.stderr?.on("data", (chunk) => process.stderr.write(`[${spec.tenantId}] ${chunk}`));
        child.on("message", (message: unknown) => {
          if (!isTenantRuntimeIpcMessage(message) || message.tenantId !== spec.tenantId) return;
          entry.configGeneration = message.configGeneration;
          entry.activeConfigHash = message.activeConfigHash;
          entry.activeStrategyHash = message.activeStrategyHash;
          try {
            const current = compileRuntimeStrategyFile(entry.spec.configPath);
            entry.desiredConfigHash = current.configHash;
            if (current.configHash === message.activeConfigHash) entry.activeConfig = current.config;
          } catch {
            // status() exposes invalid desired config separately; never distrust the child's active attestation.
          }
          if (message.type === "arena.config_reload_result") {
            entry.lastConfigError = message.applied ? null : (message.error ?? message.errorCode ?? "config reload failed");
          }
        });
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
          if (!entry.terminating && code !== 0) {
            entry.lastError = `unexpected exit code=${String(code)} signal=${String(signal)}`;
          }
          this.emit("exited", spec.tenantId, undefined, entry.pid, code, signal);
          this.notifyExitWaiters();
        });
        this.emit("spawned", spec.tenantId, undefined, entry.pid, null, null);
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

  tenantIds(): readonly string[] {
    if (this.specs !== null) return this.specs.map((spec) => spec.tenantId);
    if (this.children.size > 0) return [...this.children.keys()];
    return this.options.configs.map((name) => name.replace(/\.json$/i, ""));
  }

  status(): TenantStatus[] {
    const statuses: TenantStatus[] = [];
    for (const entry of this.children.values()) {
      this.refreshReadiness(entry);
      this.refreshDesiredConfig(entry);
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
        configReady: entry.activeConfigHash !== null && entry.activeConfigHash === entry.desiredConfigHash,
        configGeneration: entry.configGeneration,
        activeConfigHash: entry.activeConfigHash,
        desiredConfigHash: entry.desiredConfigHash,
        activeStrategyHash: entry.activeStrategyHash,
        lastConfigError: entry.lastConfigError,
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

  /**
   * Two-phase strategy reload: supervisor compiles the candidate, rejects restart-required changes,
   * sends the exact candidate hash, and waits for a matching child ACK. A successful send is never
   * reported as an applied reload by itself.
   */
  async reloadConfigs(tenantId?: string): Promise<Readonly<Record<string, SupervisorReloadResult>>> {
    if (tenantId !== undefined && !this.children.has(tenantId)) {
      throw new Error(`unknown tenant: ${tenantId}`);
    }
    const selected = [...this.children.entries()].filter(([id]) => tenantId === undefined || id === tenantId);
    const pairs = await Promise.all(selected.map(async ([id, entry]) => [id, await this.reloadOne(entry)] as const));
    return Object.freeze(Object.fromEntries(pairs));
  }

  private async reloadOne(entry: TenantChild): Promise<SupervisorReloadResult> {
    let candidate;
    try {
      candidate = compileRuntimeStrategyFile(entry.spec.configPath);
      entry.desiredConfigHash = candidate.configHash;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.desiredConfigHash = null;
      entry.lastConfigError = message;
      return this.reloadResult(entry, false, false, "invalid_config", message);
    }

    const compatibility = hotReloadCompatibility(entry.activeConfig, candidate.config);
    if (!compatibility.compatible) {
      const message = `restart required for config fields: ${compatibility.restartRequiredFields.join(", ")}`;
      entry.lastConfigError = message;
      return this.reloadResult(
        entry,
        false,
        false,
        "restart_required",
        message,
        compatibility.restartRequiredFields,
      );
    }

    if (entry.activeConfigHash === candidate.configHash) {
      entry.activeConfig = candidate.config;
      entry.lastConfigError = null;
      return this.reloadResult(entry, false, true, undefined, null);
    }
    if (!entry.child.connected || typeof entry.child.send !== "function") {
      const message = "child IPC not connected";
      entry.lastConfigError = message;
      return this.reloadResult(entry, false, false, "ipc_unavailable", message);
    }

    const requestId = randomUUID();
    const request: ConfigReloadRequest = {
      type: "arena.config_reload",
      requestId,
      expectedConfigHash: candidate.configHash,
    };
    const timeoutMs = this.options.configReloadTimeoutMs ?? 3000;

    return new Promise<SupervisorReloadResult>((resolvePromise) => {
      let settled = false;
      const finish = (result: SupervisorReloadResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry.child.off("message", onMessage);
        resolvePromise(result);
      };
      const onMessage = (message: unknown): void => {
        if (!isTenantRuntimeIpcMessage(message)) return;
        if (message.type !== "arena.config_reload_result" || message.requestId !== requestId) return;
        if (message.tenantId !== entry.spec.tenantId) return;
        if (message.applied && message.activeConfigHash === candidate.configHash) {
          entry.activeConfig = candidate.config;
          entry.lastConfigError = null;
        } else if (!message.applied) {
          entry.lastConfigError = message.error ?? message.errorCode ?? "config reload failed";
        }
        finish({
          sent: true,
          applied: message.applied && message.activeConfigHash === candidate.configHash,
          configGeneration: message.configGeneration,
          activeConfigHash: message.activeConfigHash,
          desiredConfigHash: candidate.configHash,
          activeStrategyHash: message.activeStrategyHash,
          errorCode: message.errorCode,
          error: message.error ?? null,
          restartRequiredFields: message.restartRequiredFields,
        });
      };
      const timer = setTimeout(() => {
        const message = `config reload ACK timeout after ${timeoutMs}ms`;
        entry.lastConfigError = message;
        finish(this.reloadResult(entry, true, false, "ack_timeout", message));
      }, timeoutMs);
      timer.unref?.();
      entry.child.on("message", onMessage);
      try {
        entry.child.send(request, (error) => {
          if (error === null) return;
          const message = error.message;
          entry.lastConfigError = message;
          finish(this.reloadResult(entry, false, false, "ipc_unavailable", message));
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entry.lastConfigError = message;
        finish(this.reloadResult(entry, false, false, "ipc_unavailable", message));
      }
    });
  }

  private reloadResult(
    entry: TenantChild,
    sent: boolean,
    applied: boolean,
    errorCode: SupervisorReloadResult["errorCode"],
    error: string | null,
    restartRequiredFields?: readonly string[],
  ): SupervisorReloadResult {
    return {
      sent,
      applied,
      configGeneration: entry.configGeneration,
      activeConfigHash: entry.activeConfigHash,
      desiredConfigHash: entry.desiredConfigHash,
      activeStrategyHash: entry.activeStrategyHash,
      errorCode,
      error,
      restartRequiredFields,
    };
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

  private refreshDesiredConfig(entry: TenantChild): void {
    try {
      const desired = compileRuntimeStrategyFile(entry.spec.configPath);
      entry.desiredConfigHash = desired.configHash;
      const compatibility = hotReloadCompatibility(entry.activeConfig, desired.config);
      if (!compatibility.compatible) {
        entry.lastConfigError = `restart required for config fields: ${compatibility.restartRequiredFields.join(", ")}`;
      } else if (entry.activeConfigHash === desired.configHash) {
        entry.activeConfig = desired.config;
        entry.lastConfigError = null;
      }
    } catch (error) {
      entry.desiredConfigHash = null;
      entry.lastConfigError = error instanceof Error ? error.message : String(error);
    }
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
