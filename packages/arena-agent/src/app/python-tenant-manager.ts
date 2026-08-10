/** Python 第三方 agent 统一管理（2026-08-10，用户裁决"能管理 python"）。
 *  TS supervisor 直接 spawn python 客户端子进程（venv python -m bot.main，
 *  如 arena-hero-tactic v2），纳入统一生命周期：启动 / 心跳探活判死 /
 *  指数退避重启 / 日志追加归集 / 优雅停止（SIGTERM → 超时强杀树）。
 *
 * 与 restart-arena-hero-tactic.ps1 的区别（ps1 保留为兼容入口）：
 * - 心跳：stdoutLog（tactic.log）mtime 每 tick 刷新 = 心跳；TTL 超时判死
 *   自动重启（ps1 只启动不看护，死后永久死）
 * - 退出码采集 + lastError 台账（ps1 丢弃 exit code，err.log 每次覆盖）
 * - 日志追加 + 轮转语义（ps1 覆盖 tactic.log/err.log，历史证据截断）
 * - 代理剥离（2026-08-09 python 掉线根因：httpx 走 HTTP_PROXY →
 *   TransportError 循环；ps1 未复刻 env -u 修复）
 * - .env 白名单注入（值从不打印、不落仓）
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PythonAgentSpec {
  readonly tenantId: string;
  /** 客户端仓库根（PYTHONPATH 注入 + venv 默认路径基座）。 */
  readonly repoPath: string;
  /** venv python 可执行；缺省 <repoPath>/.venv/Scripts/python.exe。 */
  readonly venvPython?: string;
  /** 客户端模块入口；缺省 bot.main。 */
  readonly module?: string;
  /** 附加模块参数（如 --log-file tactic.log：心跳依赖 stdout log mtime
   *  每 tick 刷新，客户端必须把日志写到 <cwd>/tactic.log）。 */
  readonly args?: string[];
  /** 实例工作目录（每租户独立 .env / 日志 / memory 文件）。 */
  readonly cwd: string;
  /** 心跳超时判死（ms）；缺省 60_000（> 3 tick，15s/tick）。 */
  readonly heartbeatTtlMs?: number;
  /** 意外退出自动重启上限；缺省 5。 */
  readonly respawnLimit?: number;
  /** 重启基础延迟（指数退避，上限 120s）；缺省 5_000。 */
  readonly respawnDelayMs?: number;
}

export interface PythonTenantStatus {
  readonly tenantId: string;
  readonly pid: number | null;
  readonly alive: boolean;
  readonly lifecycle: "starting" | "running" | "dead" | "terminating";
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly lastError: string | null;
  readonly respawnCount: number;
  readonly lastHeartbeatAt: number | null;
  readonly spawnedAt: number | null;
}

export interface PythonTenantManagerOptions {
  /** 注入用（单测）；缺省 spawn(venvPython, ["-m", module], ...)。 */
  readonly spawn?: (command: string, args: readonly string[], spec: PythonAgentSpec, env: Record<string, string>) => ChildProcess;
  readonly forceKillTree?: (child: ChildProcess) => Promise<void>;
  /** 心跳轮询间隔（ms）；缺省 15_000。测试注入小值加速。 */
  readonly heartbeatPollMs?: number;
}

/** .env 白名单（键名）：值只注入进程 env，从不打印/落仓。 */
const ENV_WHITELIST = ["ARENA_HERO_API_KEY", "ARENA_HERO_TELEMETRY_ENDPOINT", "ARENA_HERO_TENANT"];

/** 代理 env：2026-08-09 python 掉线根因（httpx 走 127.0.0.1:7897 →
 *  TransportError 循环）；管理面启动时全部剥离。 */
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"];

export class PythonTenantManager extends EventEmitter {
  private readonly spec: PythonAgentSpec;
  private readonly options: PythonTenantManagerOptions;
  private readonly venvPython: string;
  private readonly module: string;
  private readonly heartbeatTtlMs: number;
  private readonly respawnLimit: number;
  private readonly respawnDelayMs: number;

  private child: ChildProcess | null = null;
  private exited = true;
  private lifecycle: PythonTenantStatus["lifecycle"] = "starting";
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private lastError: string | null = null;
  private respawnCount = 0;
  private lastHeartbeatAt: number | null = null;
  private spawnedAt: number | null = null;
  private stopping = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly heartbeatPollMs: number;

  constructor(spec: PythonAgentSpec, options: PythonTenantManagerOptions = {}) {
    super();
    this.spec = spec;
    this.options = options;
    this.venvPython = spec.venvPython ?? join(spec.repoPath, ".venv", "Scripts", "python.exe");
    this.module = spec.module ?? "bot.main";
    this.heartbeatTtlMs = spec.heartbeatTtlMs ?? 60_000;
    this.respawnLimit = spec.respawnLimit ?? 5;
    this.respawnDelayMs = spec.respawnDelayMs ?? 5_000;
    this.heartbeatPollMs = options.heartbeatPollMs ?? 15_000;
  }

  start(): void {
    this.spawn();
    this.startHeartbeatWatch();
  }

  status(): PythonTenantStatus {
    return {
      tenantId: this.spec.tenantId,
      pid: this.child?.pid ?? null,
      alive: this.child !== null && !this.exited && !this.stopping,
      lifecycle: this.lifecycle,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      lastError: this.lastError,
      respawnCount: this.respawnCount,
      lastHeartbeatAt: this.lastHeartbeatAt,
      spawnedAt: this.spawnedAt,
    };
  }

  /** 单租户重启（watchdog 耗尽恢复 / 运维手动）：重置计数重建。 */
  restart(): boolean {
    if (this.stopping) return false;
    this.respawnCount = 0;
    if (this.child !== null && !this.exited) {
      void this.killChild();
      return true; // 重建由 exit 事件驱动
    }
    this.spawn();
    return true;
  }

  /** 优雅停止：SIGTERM（bot 退出路径会 save_world_memory）→ 超时强杀树。 */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.respawnTimer !== null) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.killChild();
  }

  private spawn(): void {
    if (this.stopping) return;
    const env = this.buildEnv();
    const child = (this.options.spawn ?? ((command, args, _spec, childEnv) => {
      const out = openSync(join(this.spec.cwd, "tactic.log"), "a");
      const err = openSync(join(this.spec.cwd, "tactic.err.log"), "a");
      const spawned = spawn(command, [...args], {
        cwd: this.spec.cwd,
        env: childEnv,
        stdio: ["ignore", out, err],
        shell: false,
        windowsHide: true,
      });
      closeSync(out);
      closeSync(err);
      return spawned;
    }))(this.venvPython, ["-m", this.module, ...(this.spec.args ?? [])], this.spec, env);

    this.child = child;
    this.exited = false;
    this.exitCode = null;
    this.exitSignal = null;
    this.lifecycle = "starting";
    this.spawnedAt = Date.now();
    this.emit("spawned", { tenantId: this.spec.tenantId, pid: child.pid });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return; // 新 child 接管后丢弃旧事件
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal ?? null;
      this.emit("exited", {
        tenantId: this.spec.tenantId,
        exitCode: code,
        exitSignal: signal ?? null,
        respawnCount: this.respawnCount,
      });
      if (this.stopping) {
        this.lifecycle = "dead";
        return;
      }
      if (this.respawnCount >= this.respawnLimit) {
        this.lifecycle = "dead";
        this.lastError = `respawn limit reached (${this.respawnLimit}), exitCode=${code}`;
        this.emit("exhausted", { tenantId: this.spec.tenantId, exitCode: code, respawnCount: this.respawnCount });
        return;
      }
      this.respawnCount += 1;
      this.lifecycle = "starting";
      const delayMs = Math.min(this.respawnDelayMs * 2 ** (this.respawnCount - 1), 120_000);
      this.emit("restarting", { tenantId: this.spec.tenantId, respawnCount: this.respawnCount, delayMs });
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        this.spawn();
      }, delayMs);
      this.respawnTimer.unref?.();
    });
    child.on("error", (error) => {
      this.lastError = `spawn error: ${error.message}`;
      this.emit("error", { tenantId: this.spec.tenantId, error: error.message });
    });
  }

  /** 心跳探活：stdoutLog mtime = 心跳（bot 每 tick 写日志）；TTL 超时判死。 */
  private startHeartbeatWatch(): void {
    this.heartbeatTimer = setInterval(() => {
      const mtimeMs = this.stdoutLogMtime();
      if (mtimeMs !== null) this.lastHeartbeatAt = mtimeMs;
      if (this.child === null || this.exited || this.stopping || this.lifecycle === "terminating") return;
      if (mtimeMs !== null && Date.now() - mtimeMs > this.heartbeatTtlMs) {
        this.lastError = `heartbeat stale > ${this.heartbeatTtlMs}ms (stdout log not advancing)`;
        this.emit("heartbeat_lost", { tenantId: this.spec.tenantId, staleMs: Date.now() - mtimeMs });
        void this.killChild(); // exit 事件驱动 respawn
      }
    }, this.heartbeatPollMs);
    this.heartbeatTimer.unref?.();
  }

  private stdoutLogMtime(): number | null {
    try {
      const path = join(this.spec.cwd, "tactic.log");
      return existsSync(path) ? statSync(path).mtimeMs : null;
    } catch {
      return null;
    }
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (child === null || this.exited) return;
    this.lifecycle = "terminating";
    try {
      child.kill("SIGTERM");
    } catch {
      // 进程可能已退出
    }
    await new Promise<void>((resolve) => {
      const startedAt = Date.now();
      const poll = setInterval(() => {
        if (this.exited || this.child !== child || Date.now() - startedAt > 8_000) {
          clearInterval(poll);
          resolve();
        }
      }, 100);
      poll.unref?.();
    });
    if (!this.exited && this.child === child) {
      try {
        await (this.options.forceKillTree ?? forceKillProcessTree)(child);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  /** 进程 env：继承 + PYTHONPATH=repo + .env 白名单注入 + 代理剥离。 */
  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !PROXY_ENV_KEYS.includes(key)) env[key] = value;
    }
    env.PYTHONPATH = this.spec.repoPath;
    try {
      const lines = readFileSync(join(this.spec.cwd, ".env"), "utf8").split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const name = trimmed.slice(0, eq).trim();
        if (ENV_WHITELIST.includes(name)) env[name] = trimmed.slice(eq + 1).trim();
      }
    } catch {
      // .env 缺失 = 仅继承 env（启动后由客户端自身报错）
    }
    return env;
  }
}

/** 多 python 租户聚合（2026-08-10）：run-supervisor 持有；提供统一
 *  start/stop/status/restart 与 supervisor.jsonl 事件落盘。 */
export class PythonTenantRegistry {
  private readonly managers: PythonTenantManager[] = [];

  constructor(
    specs: readonly PythonAgentSpec[],
    options: { onEvent?: (tenantId: string, type: string, detail?: string, pid?: number) => void } = {},
    managerOptions: PythonTenantManagerOptions = {},
  ) {
    for (const spec of specs) {
      const manager = new PythonTenantManager(spec, managerOptions);
      for (const type of ["spawned", "exited", "restarting", "exhausted", "heartbeat_lost", "error"] as const) {
        manager.on(type, (payload: { tenantId: string; pid?: number; exitCode?: number | null; respawnCount?: number }) => {
          const detail = type === "exited"
            ? `exitCode=${payload.exitCode ?? ""} respawnCount=${payload.respawnCount ?? 0}`
            : JSON.stringify(payload);
          options.onEvent?.(spec.tenantId, type, detail, payload.pid ?? manager.status().pid ?? undefined);
        });
      }
      this.managers.push(manager);
    }
  }

  start(): void {
    for (const manager of this.managers) manager.start();
  }

  async stop(): Promise<void> {
    await Promise.all(this.managers.map((manager) => manager.stop()));
  }

  status(): PythonTenantStatus[] {
    return this.managers.map((manager) => manager.status());
  }

  /** 单租户重启（watchdog 耗尽恢复 / 运维）。 */
  restartTenant(tenantId: string): boolean {
    const manager = this.managers.find((m) => m.status().tenantId === tenantId);
    return manager !== undefined ? manager.restart() : false;
  }
}

/** 进程树强杀（Windows taskkill /T；POSIX 进程组）。 */
export async function forceKillProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => resolve());
    });
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // 已退出
  }
}
