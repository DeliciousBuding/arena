/**
 * Settlement phase contracts：phase 注册、事件类型、unknown/unsupported 语义。
 *
 * 15 个内部 phase（architecture §6），每个 phase 映射官方结算阶段。
 * 结算只允许在 draft（settlement 内部可变副本）上操作；
 * settleTick 返回新 world 快照，失败时不返回半更新 world。
 */

import type { Plan, Position } from "../../domain/model.ts";
import type { RulesManifest } from "../contracts/rules-manifest.ts";
import type { SimFeature, SimWorld } from "../world/types.ts";

/** 与线上 event_type 对齐的结算事件；recipientPlayerId 仅供内部私有投递。 */
export interface ResolutionEvent {
  readonly tick: number;
  readonly eventType: string;
  readonly reasonCode: string | null;
  readonly actorId: string | null;
  readonly targetId: string | null;
  readonly position: Position | null;
  readonly values: Readonly<Record<string, unknown>> | null;
  /** Internal delivery metadata; omitted from SDK wire events. */
  readonly recipientPlayerId?: string;
}

/** unknown/不可预测效应（refill、对手动作）——不得伪装成 MATCH。 */
export interface UnknownEffect {
  readonly tick: number;
  readonly kind:
    | "refill"
    | "opponent-action"
    | "fog-of-war"
    | "rule-assumption"
    | "server-generated-id";
  readonly note: string;
}

/** 一个 phase 的输出。 */
export interface PhaseOutcome {
  readonly events: readonly ResolutionEvent[];
  readonly unknownEffects: readonly UnknownEffect[];
  readonly unsupported: readonly SimFeature[];
}

export interface Phase {
  readonly id: string;
  /** 官方阶段序号（resolution order 第几步，用于 manifest 映射）。 */
  readonly officialPhase: number;
  readonly run: (draft: SimWorld, ctx: PhaseContext) => PhaseOutcome;
}

export interface PhaseContext {
  /** 规则 manifest（refill cadence 等数值来源）。 */
  readonly rules: RulesManifest;
  /** 本 tick 冻结的完整计划（playerId → Plan）；缺失 action 等价 WAIT。 */
  readonly plans: ReadonlyMap<string, Plan>;
  /** 当前 phase 已消费的随机源（test-seeded refill 用；null = disabled）。 */
  readonly rng: (() => number) | null;
  /** 本 tick 输入触发的 unsupported feature（供 unsupported-* phase 报告）。 */
  readonly features: ReadonlySet<SimFeature>;
  /** Cells where a carried Beacon landed through death before P07. */
  readonly beaconPickupLockedCells: Set<string>;
  /** refill（实验可选；undefined = 不实现官方 refill）。chunk-quota 空槽模型，
   *  chunks = 世界载入时含自然点的 32×32 chunk。 */
  readonly refill?: {
    readonly chunks: readonly string[];
    readonly everyTicks: number;
  };
}

export const EMPTY_OUTCOME: PhaseOutcome = Object.freeze({
  events: [],
  unknownEffects: [],
  unsupported: [],
});

export function outcome(partial: Partial<PhaseOutcome> = {}): PhaseOutcome {
  return Object.freeze({
    events: partial.events ?? [],
    unknownEffects: partial.unknownEffects ?? [],
    unsupported: partial.unsupported ?? [],
  });
}

/** 构造 ResolutionEvent 的便捷函数。 */
export function eventOf(
  tick: number,
  eventType: string,
  opts: {
    reasonCode?: string | null;
    actorId?: string | null;
    targetId?: string | null;
    position?: Position | null;
    values?: Readonly<Record<string, unknown>> | null;
    recipientPlayerId?: string;
  } = {},
): ResolutionEvent {
  return Object.freeze({
    tick,
    eventType,
    reasonCode: opts.reasonCode ?? null,
    actorId: opts.actorId ?? null,
    targetId: opts.targetId ?? null,
    position: opts.position ?? null,
    values: opts.values ?? null,
    ...(opts.recipientPlayerId === undefined ? {} : { recipientPlayerId: opts.recipientPlayerId }),
  });
}
