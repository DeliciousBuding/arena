/**
 * DebugServer（切片 5）：租户集群只读观测 HTTP 端点。
 *
 * 端点：
 *   GET /health          → 各租户进程存活状态 + supervisor 版本
 *   GET /state?tenant=t1 → 该租户 runtime.jsonl 最后一行（决策/延迟/提交结果）
 *   GET /state?tenant=t1&stream=pi → pi.jsonl 最后一行（pi 事件流）
 *   GET /events?n=50     → supervisor.jsonl 尾部 N 行
 *   GET /tenants         → 配置中的租户列表
 *
 * 只读：不做 /command 写入（控制面留给后续切片；POST 语义需要跨进程通信协议）。
 */

import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TenantSupervisor } from "./tenant-supervisor.ts";

export interface DebugServerOptions {
  readonly repoRoot: string;
  readonly supervisor: TenantSupervisor;
  readonly port?: number;
  readonly host?: string;
}

export class DebugServer {
  private readonly options: DebugServerOptions;
  private readonly server: Server;
  private readonly tenantIds: string[];

  constructor(options: DebugServerOptions) {
    this.options = options;
    this.tenantIds = options.supervisor.status().map((entry) => entry.tenantId);
    this.server = createServer((req, res) => {
      this.route(req.url ?? "/", res).catch((error) => {
        this.json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });
  }

  listen(): Promise<void> {
    const port = this.options.port ?? 8120;
    const host = this.options.host ?? "127.0.0.1";
    return new Promise((resolvePromise) => {
      this.server.listen(port, host, () => resolvePromise());
    });
  }

  close(): Promise<void> {
    return new Promise((resolvePromise) => this.server.close(() => resolvePromise()));
  }

  address(): { host: string; port: number } | null {
    const addr = this.server.address();
    if (addr === null || typeof addr === "string") {
      return null;
    }
    return { host: addr.address, port: addr.port };
  }

  private async route(url: string, res: import("node:http").ServerResponse): Promise<void> {
    const urlObj = new URL(url, "http://localhost");
    const path = urlObj.pathname;
    if (path === "/health") {
      this.json(res, 200, {
        ok: true,
        tenants: this.options.supervisor.status(),
        allExited: this.options.supervisor.allExited(),
      });
      return;
    }
    if (path === "/tenants") {
      this.json(res, 200, { tenants: this.tenantIds });
      return;
    }
    if (path === "/state") {
      const tenant = urlObj.searchParams.get("tenant");
      if (tenant === null || !this.tenantIds.includes(tenant)) {
        this.json(res, 400, { error: `tenant 必须是 ${this.tenantIds.join("/")}` });
        return;
      }
      const stream = urlObj.searchParams.get("stream") ?? "runtime";
      const row = lastJsonlLine(join(this.options.repoRoot, "runtime", tenant, "telemetry", `${stream}.jsonl`));
      if (row === null) {
        this.json(res, 404, { error: `${stream}.jsonl 不存在或为空` });
        return;
      }
      this.json(res, 200, { tenant, stream, row });
      return;
    }
    if (path === "/events") {
      const nRaw = urlObj.searchParams.get("n");
      const n = nRaw === null ? 50 : Number(nRaw);
      const lines = readJsonlTail(join(this.options.repoRoot, "runtime", "supervisor.jsonl"), n);
      this.json(res, 200, { events: lines });
      return;
    }
    this.json(res, 404, { error: `unknown path: ${path}` });
  }

  private json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }
}

function lastJsonlLine(path: string): unknown | null {
  if (!existsSync(path)) {
    return null;
  }
  const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function readJsonlTail(path: string, n: number): unknown[] {
  if (!existsSync(path)) {
    return [];
  }
  const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  const tail = lines.slice(-n);
  const parsed: unknown[] = [];
  for (const line of tail) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // 忽略坏行（append 中截断）
    }
  }
  return parsed;
}
