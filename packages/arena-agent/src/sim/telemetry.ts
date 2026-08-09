/**
 * 模拟器遥测事件（2026-08-09，agent-telemetry-bridge-v1 §3.4）。
 *
 * 复用 SDK 的 tick_summary 契约。不产生在线身份（不发 register/connection）。
 *
 * 隔离合规：本模块是纯计算（无网络/survey-db 依赖），只在 sim/ 闭包内。
 * 实际上报由调用方（EpisodeConfig.telemetrySink）注入。
 */

import type { TickState } from "../domain/model.ts";

export const TELEMETRY_ENDPOINT_ENV = "ARENA_HERO_TELEMETRY_ENDPOINT";
export const TELEMETRY_TENANT_ENV = "ARENA_HERO_TENANT";

export interface SimTelemetrySink {
  emitTick(tick: number, state: TickState): void;
  close(): void;
}

/** 默认 sink：什么都不做。 */
class NoopSimSink implements SimTelemetrySink {
  emitTick(): void {}
  close(): void {}
}

/** 默认构造：返回 no-op（调用方通过 EpisodeConfig.telemetrySink 注入实际 sink）。 */
export function buildSimTelemetry(): SimTelemetrySink {
  return new NoopSimSink();
}

/** 每 tick 从 TickState 推导 tick_summary 摘要（与 @arena/arena-hero-ts tickSummary 契约一致）。 */
export function tickSummaryFromTickState(
  tick: number,
  state: TickState,
): Readonly<Record<string, unknown>> {
  return {
    event: "tick_summary",
    tick,
    status: state.status,
    resources: state.resources,
    population: state.population,
    core: state.core ? [state.core.position[0], state.core.position[1]] : null,
    units: state.units.length + state.workers.length + state.vanguards.length + state.rangers.length,
    visible_enemies: state.visibleEnemies.length,
  };
}
