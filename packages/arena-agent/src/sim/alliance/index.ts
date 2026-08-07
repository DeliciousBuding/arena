/**
 * Alliance Simulator — barrel export（Phase 2）。
 *
 * 约束：
 * - 不含 Arena token、Plan、CandidateSink
 * - 所有导出为纯类型、纯函数或确定性实现
 * - 模拟器输出仅 data/runs/sim
 *
 * 最后更新：2026-08-08
 */

// 核心类型
export type {
  AllianceEpisodeConfig,
  AllianceEpisodeResult,
  AllianceKPI,
  AllianceTraceEntry,
  AllianceDirector,
  DirectorFaultKind,
  DirectorFaultEvent,
} from "./types.ts";

// Director 实现
export {
  NoopAllianceDirector,
  FixedAllianceDirector,
} from "./director.ts";
export type { FixedDirectorConfig } from "./director.ts";

// KPI
export { AllianceKpiCollector } from "./kpi.ts";

// Episode 入口
export { runAllianceEpisode } from "./alliance-episode.ts";
