/**
 * Telemetry sink for the Arena Hero TS SDK（与 Python fork 同构，schema 唯一标准
 * 见 docs/design/agent-telemetry-bridge-v1.md §4）。
 *
 * 默认 no-op：官方 SDK 行为零变化。设置 ARENA_HERO_TELEMETRY_ENDPOINT 后才启用
 * HTTP 上报（后台定时批量，失败静默——绝不阻塞决策循环）。
 */

import type { PlayerState } from "./types.ts";
import type { UnitType } from "./enums.ts";

export const TELEMETRY_ENDPOINT_ENV = "ARENA_HERO_TELEMETRY_ENDPOINT";
export const TELEMETRY_TENANT_ENV = "ARENA_HERO_TENANT";
export const TELEMETRY_MODE_ENV = "ARENA_HERO_MODE";
export const SDK_VERSION = "0.2.9-telemetry.3";

const FLUSH_INTERVAL_MS = 5000;
const FLUSH_BATCH_SIZE = 20;

export type AgentMode = "production" | "simulation";

/** 读取 agent 运行模式（ARENA_HERO_MODE，缺省 production）。 */
function readMode(): AgentMode {
  const mode = (process.env[TELEMETRY_MODE_ENV] ?? "").trim().toLowerCase();
  return mode === "simulation" ? "simulation" : "production";
}

export interface TelemetryEvent {
  readonly tenant: string;
  readonly instance: string;
  readonly ts: number;
  readonly event: "register" | "connection" | "tick_summary" | "disconnected";
  /** agent 运行模式（production|simulation），register 台账区分真实/模拟。 */
  readonly mode?: string;
  /** connection 事件：up|error；tick_summary 事件：玩家状态（PlayerStatus）。 */
  readonly status?: string;
  readonly error?: string;
  readonly tick?: number;
  readonly resources?: number;
  readonly population?: number;
  readonly core?: readonly [number, number] | null;
  readonly units?: number;
  readonly visible_enemies?: number;
  /** 测绘字段（python-mapping-telemetry-v1 §2.1，与 Python fork 载荷同构）。 */
  readonly resource_cells?: readonly (readonly [number, number])[];
  readonly obstacle_cells?: readonly (readonly [number, number])[];
  /** [id, unit_type, controlled(0|1), x, y, hp]，全部可见单位（含己方）。 */
  readonly units_seen?: readonly (readonly [string, UnitType, 0 | 1, number, number, number])[];
  /** [x, y, owner_username]，controlled=false 的 CORE。 */
  readonly enemy_cores?: readonly (readonly [number, number, string])[];
  /** 我方单位构成（telemetry-v3，2026-08-10）：controlled UNIT 按类型计数
   *  {WORKER/VANGUARD/RANGER: n}，command-center 台账落 vanguards/rangers 列。 */
  readonly controlled_by_type?: Readonly<Partial<Record<UnitType, number>>>;
  /** 状态消息体积（UTF-8 字节，telemetry-v2，2026-08-09；缺省 null）。 */
  readonly state_bytes?: number | null;
  /** 状态消息解析耗时（ms，telemetry-v2；缺省 null）。 */
  readonly parse_ms?: number | null;
  /** 上一 tick 决策耗时（ms）：Turn 创建 → 首次读取 plan/submit（telemetry-v2；缺省 null）。 */
  readonly prev_decision_ms?: number | null;
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
  private readonly mode: AgentMode;

  constructor(endpoint: string, tenant: string, instance: string, mode: AgentMode) {
    this.endpoint = endpoint;
    this.tenant = tenant;
    this.instance = instance;
    this.mode = mode;
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
      mode: this.mode,
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
  return new HttpTelemetrySink(endpoint, tenant, instance, readMode());
}

export function identityEvent(
  apiKey: string,
  baseUrl: string,
  mode?: AgentMode,
): Omit<TelemetryEvent, "tenant" | "instance" | "ts"> {
  const event = {
    event: "register" as const,
    api_key_tail: apiKey.slice(-6),
    base_url: baseUrl,
    sdk_version: SDK_VERSION,
    pid: typeof process !== "undefined" ? process.pid : undefined,
    platform: typeof process !== "undefined" ? process.platform : undefined,
  };
  // 缺省省略：HttpTelemetrySink 按 ARENA_HERO_MODE 注入同一字段
  return mode === undefined ? event : { ...event, mode };
}

/** 每 tick PlayerState 摘要（与 Python fork 同构，含测绘字段；
 *  载荷契约见 python-mapping-telemetry-v1 §2.1 + telemetry-v2/v3）。
 *  ``timing`` 为可选（telemetry-v2）：缺省时计时字段置 null，不改变既有调用。 */
export interface TickTiming {
  /** 状态消息体积（UTF-8 字节）。 */
  readonly stateBytes?: number;
  /** 状态消息解析耗时（ms）。 */
  readonly parseMs?: number;
  /** 上一 tick 决策耗时（ms，Turn 创建 → 首次读取 plan/submit）。 */
  readonly prevDecisionMs?: number;
}

/** 与 Python fork round(x, 3) 对齐的毫秒精度。 */
function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function tickSummary(
  tick: number,
  state: PlayerState,
  timing: TickTiming = {},
): Omit<TelemetryEvent, "tenant" | "instance" | "ts"> {
  const controlledCore = state.objects.find(
    (o): o is Extract<typeof o, { kind: "CORE" }> =>
      o.kind === "CORE" && o.controlled === true,
  );
  const units = state.objects.filter((o) => o.kind === "UNIT");
  const terrainCells = (kind: "RESOURCE" | "OBSTACLE"): readonly (readonly [number, number])[] =>
    state.objects
      .filter((o): o is Extract<typeof o, { kind: typeof kind }> => o.kind === kind)
      .flatMap((t) => t.positions);
  const enemyCores = state.objects
    .filter((o): o is Extract<typeof o, { kind: "CORE" }> => o.kind === "CORE" && !o.controlled)
    .map((c) => [c.position[0], c.position[1], c.owner_username] as const);
  // 我方单位构成（telemetry-v3）：controlled UNIT 按类型计数，与 Python fork
  // _materialize 同源（u.unit_type 即 WORKER/VANGUARD/RANGER 字面量）。
  const controlledByType: Partial<Record<UnitType, number>> = {};
  for (const unit of units) {
    if (!unit.controlled) continue;
    controlledByType[unit.unit_type] = (controlledByType[unit.unit_type] ?? 0) + 1;
  }
  return {
    event: "tick_summary",
    tick,
    status: state.status,
    resources: state.resources,
    population: state.population,
    core: controlledCore ? [...controlledCore.position] as [number, number] : null,
    units: units.length,
    visible_enemies: units.filter((u) => !u.controlled).length,
    controlled_by_type: controlledByType,
    state_bytes: timing.stateBytes ?? null,
    parse_ms: timing.parseMs !== undefined ? roundMs(timing.parseMs) : null,
    prev_decision_ms: timing.prevDecisionMs !== undefined ? roundMs(timing.prevDecisionMs) : null,
    resource_cells: terrainCells("RESOURCE"),
    obstacle_cells: terrainCells("OBSTACLE"),
    units_seen: units.map(
      (u) => [u.id, u.unit_type, u.controlled ? 1 : 0, u.position[0], u.position[1], u.hp] as const,
    ),
    enemy_cores: enemyCores,
  };
}
