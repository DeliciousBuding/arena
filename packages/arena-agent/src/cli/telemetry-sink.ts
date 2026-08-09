/**
 * 模拟器遥测 HTTP sink（agent-telemetry-bridge-v1 §3.4）——CLI 层共享模块。
 *
 * run-sim.ts 与 run-sim-server.ts 共用同一份实现（此前两处完全复制）：
 * 批量上报同一 ingest 端点（fire-and-forget，失败静默，绝不阻塞模拟循环）。
 *
 * 隔离合规：本文件在 cli/ 层（网络能力与 run-sim-server 同源授权）；传输用
 * node:http(s) 原生 POST（sim 闭包禁 fetch/长连接 token，此处不引入）。
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type { TickState } from "../domain/model.ts";
import {
  TELEMETRY_ENDPOINT_ENV,
  tickSummaryFromTickState,
  type SimTelemetrySink,
} from "../sim/telemetry.ts";

/** cli 层 HTTP sink：批量上报同一 ingest 端点（fire-and-forget，失败静默）。 */
class SimHttpSink implements SimTelemetrySink {
  private readonly events: Array<Record<string, unknown>> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly endpoint: string;
  private readonly tenant: string;

  constructor(endpoint: string, tenant: string) {
    this.endpoint = endpoint;
    this.tenant = tenant;
    this.timer = setInterval(() => this.flush(), 5000);
    this.timer.unref?.();
  }

  emitTick(tick: number, state: TickState): void {
    this.events.push({
      tenant: this.tenant,
      instance: this.tenant,
      ts: Date.now() / 1000,
      ...tickSummaryFromTickState(tick, state),
    });
    if (this.events.length >= 20) this.flush();
  }

  close(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  private flush(): void {
    if (this.events.length === 0) return;
    const batch = this.events.splice(0);
    postJsonSilent(this.endpoint, { events: batch });
  }
}

/** node:http(s) 原生 POST（隔离合规：sim 闭包禁 fetch/长连接 token）。 */
function postJsonSilent(endpoint: string, payload: unknown): void {
  const url = new URL(endpoint);
  const body = JSON.stringify(payload);
  const doRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
  const req = doRequest(
    {
      hostname: url.hostname,
      port: url.port !== "" ? Number(url.port) : undefined,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      res.resume();
    },
  );
  req.on("error", () => {});
  req.end(body);
}

/** env 配了 ingest 端点 → 每 tenant 一个 HTTP sink；否则全部 null（no-op）。 */
function buildSimTelemetryFactory(playerIds: readonly string[]): {
  readonly factory: (tenantId: string) => SimTelemetrySink | null;
  readonly closeAll: () => void;
} {
  const endpoint = (process.env[TELEMETRY_ENDPOINT_ENV] ?? "").trim();
  const sinks = new Map<string, SimHttpSink>();
  const factory = (tenantId: string): SimTelemetrySink | null => {
    if (!endpoint) return null;
    let sink = sinks.get(tenantId);
    if (sink === undefined) {
      // 模拟器租户命名空间：sim-<playerId>（与生产 t1-t4 区分，ingest 白名单接受 sim- 前缀）
      sink = new SimHttpSink(endpoint, `sim-${tenantId}`);
      sinks.set(tenantId, sink);
    }
    return sink;
  };
  const closeAll = () => {
    for (const sink of sinks.values()) sink.close();
  };
  return { factory, closeAll };
}

export { SimHttpSink, buildSimTelemetryFactory, postJsonSilent };
