/**
 * 工具上下文（切片 4-4B，总任务书 2.1）：每个 active run 独立。
 *
 * 权威值源（GPT 裁决 1）：runId/tenantId/tick/stateHash 只从 ToolContext 读取，
 * LLM 参数必须显式回显并与 ctx 一致（不一致 → context_mismatch 拒绝）。
 * 工具不得读取"当前全局 Tick"或任何全局 Lease。
 */

import type { CandidateSink } from "../../../runtime/decision-types.ts";

/** 本 Tick 冻结地图快照（第一版不请求 Python /map/query、不读实时可变 World；
 *  真正共享 SQLite MapStore 在切片 5 接入，届时替换 Provider 不改工具接口）。 */
export interface MapSnapshot {
  readonly stats: {
    readonly width: number;
    readonly height: number;
    readonly obstacleCount: number;
    readonly resourceCellCount: number;
  };
  readonly resources: ReadonlyArray<{ readonly position: [number, number]; readonly kind?: string }>;
  readonly obstacles: ReadonlyArray<[number, number]>;
  readonly allies: ReadonlyArray<{
    readonly id: string;
    readonly unitType: string;
    readonly position: [number, number];
  }>;
  readonly enemies: ReadonlyArray<{
    readonly id: string;
    readonly unitType: string;
    readonly position: [number, number];
  }>;
}

/** 每个 active run 的工具上下文。planCalls/closed 由 arena_plan 工具写入（写入口关闭）。 */
export interface ToolContext {
  readonly runId: string;
  readonly tenantId: string;
  readonly tick: number;
  readonly stateHash: string;
  readonly mapSnapshot: MapSnapshot | null;
  readonly sink: CandidateSink;
  /** arena_plan 成功调用次数（必须且只能 1 次；>0 即 duplicate）。 */
  planCalls: number;
  /** 写入口关闭标志：arena_plan 调用后置 true。 */
  closed: boolean;
}

/** 创建新 run 的 ToolContext（runtime 每次 startDecision 调用）。 */
export function createToolContext(input: {
  readonly runId: string;
  readonly tenantId: string;
  readonly tick: number;
  readonly stateHash: string;
  readonly mapSnapshot: MapSnapshot | null;
  readonly sink: CandidateSink;
}): ToolContext {
  return { ...input, planCalls: 0, closed: false };
}
