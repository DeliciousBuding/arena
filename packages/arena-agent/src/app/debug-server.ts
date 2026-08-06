/** Bounded, read-only local observability for TenantSupervisor. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { TenantSupervisor } from "./tenant-supervisor.ts";
import { rotatedJsonlPaths } from "../telemetry/jsonl-writer.ts";

const MAX_TAIL_BYTES = 256 * 1024;
const MAX_EVENT_ROWS = 200;
const STATE_STREAMS = new Set(["runtime", "decision", "outcome", "pi"]);

export interface DebugServerOptions {
  readonly repoRoot: string;
  readonly supervisor: TenantSupervisor;
  readonly port?: number;
  readonly host?: string;
}

export class DebugServer {
  private readonly options: DebugServerOptions;
  private readonly server: Server;

  constructor(options: DebugServerOptions) {
    this.options = options;
    this.server = createServer((req, res) => {
      this.route(req, res).catch((error) => {
        this.json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });
  }

  listen(): Promise<void> {
    const port = this.options.port ?? 8120;
    const host = this.options.host ?? "127.0.0.1";
    return new Promise((resolvePromise, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen(port, host, () => {
        this.server.off("error", onError);
        resolvePromise();
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
    if (path === "/shutdown" && req.method === "POST") {
      // 受控优雅关停（2026-08-07 增加）：触发 supervisor.shutdown()，tenant 经
      // IPC 收到 arena.shutdown 后执行 cleanup stack——recorder.close() 写
      // manifest，最后释放 writer lock。仅 127.0.0.1 可及（listen 默认绑定）；
      // 非 POST 一律 405。看护/受控重启先走这里，硬杀只作兜底。
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
