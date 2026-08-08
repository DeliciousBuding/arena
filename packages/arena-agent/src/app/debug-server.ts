/** Bounded local observability for TenantSupervisor; write control requires x-arena-token (W33). */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TenantSupervisor } from "./tenant-supervisor.ts";
import { rotatedJsonlPaths } from "../telemetry/jsonl-writer.ts";

const MAX_TAIL_BYTES = 256 * 1024;
const MAX_EVENT_ROWS = 200;
const STATE_STREAMS = new Set(["runtime", "decision", "outcome", "pi"]);
const AUTH_HEADER = "x-arena-token";
const DEFAULT_TOKEN_FILE = "debug-token";

export interface AllianceStrategyDebugControl {
  view(): unknown;
  requestProfile(name: string): { readonly accepted: boolean; readonly error?: string; readonly strategy: unknown };
  requestRollback(): { readonly accepted: boolean; readonly error?: string; readonly strategy: unknown };
  markLastGood(): { readonly accepted: boolean; readonly error?: string; readonly strategy: unknown };
}

export interface DebugServerOptions {
  readonly repoRoot: string;
  readonly supervisor: TenantSupervisor;
  /** Optional tokenless Alliance Director shadow view. Read-only observability only. */
  readonly allianceDirectorView?: () => unknown;
  /** Strategic profile control only; applies at Director replan boundaries and never owns Arena actions. */
  readonly allianceStrategyControl?: AllianceStrategyDebugControl;
  readonly port?: number;
  /** Ignored for binding: the debug API is always loopback-only (W33). Kept for CLI backward compatibility. */
  readonly host?: string;
  /** Fixed token for deterministic tests; a random token is generated when omitted. */
  readonly token?: string;
  /** File where the token is written for local callers; defaults to <runtimeRoot>/debug-token. */
  readonly tokenFile?: string;
}

export class DebugServer {
  private readonly options: DebugServerOptions;
  private readonly server: Server;
  /** Token required by write endpoints via the x-arena-token header. */
  readonly token: string;
  /** File the token is written to so local tooling can authenticate. */
  readonly tokenFile: string;

  constructor(options: DebugServerOptions) {
    this.options = options;
    this.token = options.token ?? randomBytes(32).toString("hex");
    const configuredPort = options.port ?? 8120;
    this.tokenFile = options.tokenFile ?? join(
      options.supervisor.runtimeRoot,
      configuredPort === 8120 ? DEFAULT_TOKEN_FILE : `${DEFAULT_TOKEN_FILE}-${configuredPort}`,
    );
    this.server = createServer((req, res) => {
      this.route(req, res).catch((error) => {
        this.json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });
  }

  listen(): Promise<void> {
    const port = this.options.port ?? 8120;
    // W33: the debug API is strictly local; any externally supplied host is ignored.
    const host = "127.0.0.1";
    return new Promise((resolvePromise, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen(port, host, () => {
        this.server.off("error", onError);
        // Publish credentials only after this server actually owns the socket.
        // A failed second supervisor must never overwrite the live server token.
        try {
          writeDebugToken(this.tokenFile, this.token);
          resolvePromise();
        } catch (error) {
          this.server.close(() => reject(error));
        }
      });
    });
  }

  close(): Promise<void> {
    if (!this.server.listening) return Promise.resolve();
    return new Promise((resolvePromise, reject) => {
      this.server.close((error) => error === undefined ? resolvePromise() : reject(error));
    });
  }

  address(): { host: string; port: number } | null {
    const addr = this.server.address();
    if (addr === null || typeof addr === "string") return null;
    return { host: addr.address, port: addr.port };
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const urlObj = new URL(req.url ?? "/", "http://localhost");
    const path = urlObj.pathname;

    if (path === "/health") {
      this.json(res, 200, {
        ok: true,
        shuttingDown: this.options.supervisor.isShuttingDown(),
        tenants: this.options.supervisor.status(),
      });
      return;
    }
    if (path === "/ready") {
      const ready = this.options.supervisor.isReady();
      this.json(res, ready ? 200 : 503, { ready, tenants: this.options.supervisor.status() });
      return;
    }
    if (path === "/tenants") {
      this.json(res, 200, { tenants: this.options.supervisor.tenantIds() });
      return;
    }
    if (path === "/config") {
      this.json(res, 200, { tenants: this.options.supervisor.status() });
      return;
    }
    if (path === "/config-ready") {
      const tenants = this.options.supervisor.status();
      const configReady = tenants.length > 0 && tenants.every((tenant) => tenant.configReady);
      this.json(res, configReady ? 200 : 503, { configReady, tenants });
      return;
    }
    if (path === "/state") {
      const tenantIds = this.options.supervisor.tenantIds();
      const tenant = urlObj.searchParams.get("tenant");
      if (tenant === null || !tenantIds.includes(tenant)) {
        this.json(res, 400, { error: `tenant must be one of: ${tenantIds.join(", ")}` });
        return;
      }
      const stream = urlObj.searchParams.get("stream") ?? "runtime";
      if (!STATE_STREAMS.has(stream)) {
        this.json(res, 400, { error: `stream must be one of: ${[...STATE_STREAMS].join(", ")}` });
        return;
      }
      const row = lastValidJsonlRow(
        join(this.options.supervisor.runtimeRoot, tenant, "telemetry", `${stream}.jsonl`),
      );
      if (row === null) {
        this.json(res, 404, { error: `${stream}.jsonl has no complete JSON record` });
        return;
      }
      this.json(res, 200, { tenant, stream, row });
      return;
    }
    if (path === "/alliance-director") {
      if (req.method !== undefined && req.method !== "GET") {
        this.json(res, 405, { error: "method not allowed; use GET /alliance-director" });
        return;
      }
      const view = this.options.allianceDirectorView?.();
      this.json(res, 200, view ?? { enabled: false, mode: "ASSIST_ONLY", actionOwnership: "none", available: false });
      return;
    }
    if (path === "/alliance-strategy") {
      const control = this.options.allianceStrategyControl;
      if (req.method === undefined || req.method === "GET") {
        this.json(res, 200, control?.view() ?? { available: false, mode: "ASSIST_ONLY", actionOwnership: "none" });
        return;
      }
      if (req.method !== "POST") {
        this.json(res, 405, { error: "method not allowed; use GET/POST /alliance-strategy" });
        return;
      }
      if (!this.requireToken(req, res)) return;
      if (control === undefined) {
        this.json(res, 503, { error: "Alliance strategic control is unavailable" });
        return;
      }
      const profile = urlObj.searchParams.get("profile");
      const action = urlObj.searchParams.get("action");
      const result = profile !== null
        ? control.requestProfile(profile)
        : action === "rollback"
          ? control.requestRollback()
          : action === "mark-good"
            ? control.markLastGood()
            : null;
      if (result === null) {
        this.json(res, 400, { error: "use ?profile=<registered> or ?action=rollback|mark-good" });
        return;
      }
      this.json(res, result.accepted ? 202 : 400, result);
      return;
    }
    if (path === "/events") {
      const raw = urlObj.searchParams.get("n");
      const n = raw === null ? 50 : Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > MAX_EVENT_ROWS) {
        this.json(res, 400, { error: `n must be an integer between 1 and ${MAX_EVENT_ROWS}` });
        return;
      }
      this.json(res, 200, {
        events: readJsonlTail(join(this.options.supervisor.runtimeRoot, "supervisor.jsonl"), n),
      });
      return;
    }
    if (path === "/config-reload" && req.method === "POST") {
      if (!this.requireToken(req, res)) return;
      // Two-phase hot reload: compile/preflight → exact-hash IPC → child apply ACK. Non-hot fields
      // return restart_required instead of silently creating a half-old/half-new runtime.
      const tenantParam = urlObj.searchParams.get("tenant");
      try {
        const results = await this.options.supervisor.reloadConfigs(tenantParam ?? undefined);
        const values = Object.values(results);
        const applied = values.length > 0 && values.every((result) => result.applied);
        const restartRequired = values.some((result) => result.errorCode === "restart_required");
        this.json(res, applied ? 200 : restartRequired ? 409 : 503, { applied, reloaded: results });
      } catch (error) {
        this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (path === "/config-reload") {
      this.json(res, 405, { error: "method not allowed; use POST /config-reload" });
      return;
    }
    if (path === "/shutdown" && req.method === "POST") {
      // 受控优雅关停（2026-08-07 增加）：触发 supervisor.shutdown()，tenant 经
      // IPC 收到 arena.shutdown 后执行 cleanup stack——recorder.close() 写
      // manifest，最后释放 writer lock。仅 127.0.0.1 可及（listen 强制绑定，
      // W33），且需 x-arena-token；非 POST 一律 405。看护/受控重启先走这里，
      // 硬杀只作兜底。
      if (!this.requireToken(req, res)) return;
      void this.options.supervisor.shutdown();
      this.json(res, 202, { shuttingDown: true });
      return;
    }
    if (path === "/shutdown") {
      this.json(res, 405, { error: "method not allowed; use POST /shutdown" });
      return;
    }
    this.json(res, 404, { error: `unknown path: ${path}` });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  private requireToken(req: IncomingMessage, res: ServerResponse): boolean {
    const header = req.headers[AUTH_HEADER];
    // Header may be string | string[] | undefined; normalize to first value.
    const provided = typeof header === "string" ? header : Array.isArray(header) && header.length > 0 ? header[0] : undefined;
    if (tokenMatches(provided, this.token)) return true;
    this.json(res, 401, { error: `unauthorized: missing or invalid ${AUTH_HEADER} header` });
    return false;
  }
}

/** Constant-time comparison; undefined/malformed/mismatched values are rejected. */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

function writeDebugToken(tokenFile: string, token: string): void {
  try {
    mkdirSync(dirname(tokenFile), { recursive: true });
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  } catch (error) {
    throw new Error(
      `cannot write debug token to ${tokenFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function lastValidJsonlRow(path: string): unknown | null {
  for (const candidate of [path, ...rotatedJsonlPaths(path)]) {
    const lines = tailLines(candidate);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        // A concurrent append may leave the final line incomplete; walk backward.
      }
    }
  }
  return null;
}

function readJsonlTail(path: string, n: number): unknown[] {
  const parsed: unknown[] = [];
  const oldestFirst = [...rotatedJsonlPaths(path)].reverse().concat(path);
  for (const candidate of oldestFirst) {
    for (const line of tailLines(candidate)) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // Ignore incomplete/bad append records; never read beyond the bounded tail.
      }
    }
  }
  return parsed.slice(-n);
}

function tailLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return [];
    const length = Math.min(size, MAX_TAIL_BYTES);
    const offset = size - length;
    const buffer = Buffer.allocUnsafe(length);
    const bytes = readSync(fd, buffer, 0, length, offset);
    let text = buffer.subarray(0, bytes).toString("utf8");
    if (offset > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline < 0 ? "" : text.slice(firstNewline + 1);
    }
    return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  } finally {
    closeSync(fd);
  }
}
