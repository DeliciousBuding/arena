/**
 * Telemetry sink for the Arena Hero TS SDK（与 Python fork 同构，schema 唯一标准
 * 见 docs/design/agent-telemetry-bridge-v1.md §4）。
 *
 * 默认 no-op：官方 SDK 行为零变化。设置 ARENA_HERO_TELEMETRY_ENDPOINT 后才启用
 * HTTP 上报（后台定时批量，失败静默——绝不阻塞决策循环）。
 */

import type { PlayerState } from "./types.ts";

export const TELEMETRY_ENDPOINT_ENV = "ARENA_HERO_TELEMETRY_ENDPOINT";
export const TELEMETRY_TENANT_ENV = "ARENA_HERO_TENANT";
export const SDK_VERSION = "0.2.9-telemetry.1";

const FLUSH_INTERVAL_MS = 5000;
const FLUSH_BATCH_SIZE = 20;

export interface TelemetryEvent {
  readonly tenant: string;
  readonly instance: string;
  readonly ts: number;
  readonly event: "register" | "connection" | "tick_summary" | "disconnected";
  /** connection 事件：up|error；tick_summary 事件：玩家状态（PlayerStatus）。 */
  readonly status?: string;
  readonly error?: string;
  readonly tick?: number;
  readonly resources?: number;
  readonly population?: number;
  readonly core?: readonly [number, number] | null;
  readonly units?: number;
  readonly visible_enemies?: number;
  readonly api_key_tail?: string;
  readonly base_url?: string;
  readonly sdk_version?: string;
  readonly pid?: number;
  readonly platform?: string;
}

export interface TelemetrySink {
  emit(event: Omit<TelemetryEvent, "tenant" | "instance" | "ts">): void;
  close(): void;
}

/** 默认 sink：什么都不做（官方 SDK 行为）。 */
class NoopSink implements TelemetrySink {
  emit(): void {}
  close(): void {}
}

/** 后台定时批量上报（fire-and-forget，失败静默）。 */
class HttpTelemetrySink implements TelemetrySink {
  private readonly events: Array<Omit<TelemetryEvent, "tenant" | "instance" | "ts">> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly endpoint: string;
  private readonly tenant: string;
  private readonly instance: string;

  constructor(endpoint: string, tenant: string, instance: string) {
    this.endpoint = endpoint;
    this.tenant = tenant;
    this.instance = instance;
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  emit(event: Omit<TelemetryEvent, "tenant" | "instance" | "ts">): void {
    this.events.push(event);
    if (this.events.length >= FLUSH_BATCH_SIZE) {
      this.flush();
    }
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
    const payload = batch.map((e) => ({
      tenant: this.tenant,
      instance: this.instance,
      ts: Date.now() / 1000,
      ...e,
    }));
    // fire-and-forget：失败静默，遥测绝不能影响游戏
    fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: payload }),
    }).catch(() => {});
  }
}

export function buildTelemetry(apiKey: string, baseUrl: string): TelemetrySink {
  const endpoint = (process.env[TELEMETRY_ENDPOINT_ENV] ?? "").trim();
  if (!endpoint) return new NoopSink();
  const tenant = (process.env[TELEMETRY_TENANT_ENV] ?? "unknown").trim() || "unknown";
  const instance = apiKey.slice(-6) || "unknown";
  return new HttpTelemetrySink(endpoint, tenant, instance);
}

export function identityEvent(
  apiKey: string,
  baseUrl: string,
): Omit<TelemetryEvent, "tenant" | "instance" | "ts"> {
  return {
    event: "register",
    api_key_tail: apiKey.slice(-6),
    base_url: baseUrl,
    sdk_version: SDK_VERSION,
    pid: typeof process !== "undefined" ? process.pid : undefined,
    platform: typeof process !== "undefined" ? process.platform : undefined,
  };
}

/** 每 tick PlayerState 摘要（与 Python fork 同构）。 */
export function tickSummary(
  tick: number,
  state: PlayerState,
): Omit<TelemetryEvent, "tenant" | "instance" | "ts"> {
  const controlledCore = state.objects.find(
    (o): o is Extract<typeof o, { kind: "CORE" }> =>
      o.kind === "CORE" && o.controlled === true,
  );
  const units = state.objects.filter((o) => o.kind === "UNIT");
  return {
    event: "tick_summary",
    tick,
    status: state.status,
    resources: state.resources,
    population: state.population,
    core: controlledCore ? [...controlledCore.position] as [number, number] : null,
    units: units.length,
    visible_enemies: units.filter((u) => !u.controlled).length,
  };
}
