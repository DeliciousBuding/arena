/**
 * Settlement 主循环（S3 骨架）：phase 注册表、draft 管理、atomic commit。
 *
 * 固定顺序执行 15 个内部 phase（architecture §6，映射官方 resolution order）。
 * 所有 mutation 只在 structuredClone 的 draft 上进行；任一 phase 抛错或
 * invariant 失败 → 整体抛错，不返回半更新 world。
 *
 * 未实现的 resolver（movement/economy）在 S4/S5 注册进对应 phase；
 * unsupported-* phase 已实现输入检测（触发即标记 feature，不得静默跳过）。
 */

import type { Plan } from "../../domain/model.ts";
import type { RulesManifest } from "../contracts/rules-manifest.ts";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import type { SimFeature, SimWorld } from "../world/types.ts";
import { assertWorldInvariants } from "../world/world.ts";
import { coreMigrationPhase } from "./core-migration.ts";
import { economyPhases } from "./economy.ts";
import { movementPhase } from "./movement.ts";
import { EMPTY_OUTCOME, outcome, type Phase, type PhaseContext, type PhaseOutcome, type ResolutionEvent, type UnknownEffect } from "./phase.ts";

export interface SettlementContext {
  readonly rules: RulesManifest;
  /** test-seeded 随机源（refill-policy 用）；null = disabled。 */
  readonly rng: (() => number) | null;
}

export interface SettlementResult {
  readonly world: SimWorld;
  readonly events: readonly ResolutionEvent[];
  readonly unknownEffects: readonly UnknownEffect[];
  /** 本 tick 新触发的 unsupported feature。 */
  readonly unsupported: readonly SimFeature[];
}

export class SettlementError extends Error {
  constructor(message: string) {
    super(`settlement: ${message}`);
    this.name = "SettlementError";
  }
}

/* ---------------- unsupported 输入检测 ---------------- */

function scanUnsupported(world: SimWorld, plans: ReadonlyMap<string, Plan>): SimFeature[] {
  const hit = new Set<SimFeature>();
  for (const plan of plans.values()) {
    for (const action of Object.values(plan.unitActions)) {
      switch (action.type) {
        case "SWEEP":
        case "SHOOT":
          hit.add("combat");
          break;
        case "PICKUP_BEACON":
        case "DROP_BEACON":
          hit.add("beacon");
          break;
        default:
          break;
      }
    }
    if (plan.coreAction !== null) {
      switch (plan.coreAction.type) {
        case "PICKUP_BEACON":
        case "DROP_BEACON":
          hit.add("beacon");
          break;
        default:
          break;
      }
    }
  }
  for (const player of world.players.values()) {
    if (player.core?.state === "MOVING") {
      // 裸 MOVING（缺迁移字段）：外部快照进度未知，无法确定性推进，仍算 unsupported；
      // Sim 自产迁移（四字段齐全）由 P06 resolver 确定性推进，不算 unsupported。
      if (
        player.core.moveDirection === null ||
        player.core.moveProgress === null ||
        player.core.moveRequiredTicks === null ||
        player.core.destination === null
      ) {
        hit.add("core-migration");
      }
    }
    if (player.status === "RESPAWNING") {
      hit.add("respawn");
    }
  }
  return [...hit].sort();
}

/* ---------------- phase 注册表（S3 骨架，固定顺序） ---------------- */

const PHASES: readonly Phase[] = [
  {
    id: "P01-lock-final-plans",
    officialPhase: 1,
    run: () => EMPTY_OUTCOME,
  },
  ...economyPhases.slice(0, 3), // P02 self-destruct / P03 capacity-shrink / P04 upkeep
  {
    id: "P05-unit-movement",
    officialPhase: 4,
    run: movementPhase.run,
  },
  {
    id: "P06-core-migration",
    officialPhase: 5,
    run: coreMigrationPhase.run,
  },
  {
    id: "P07-unsupported-beacon-check",
    officialPhase: 7,
    run: (draft, ctx) => {
      if (ctx.features.has("beacon")) {
        return outcome({ unsupported: ["beacon"] });
      }
      return EMPTY_OUTCOME;
    },
  },
  ...economyPhases.slice(3, 4), // P08 harvest-and-deposit
  {
    id: "P09-unsupported-combat-check",
    officialPhase: 9,
    run: (draft, ctx) => {
      if (ctx.features.has("combat")) {
        return outcome({ unsupported: ["combat"] });
      }
      return EMPTY_OUTCOME;
    },
  },
  ...economyPhases.slice(4, 6), // P10 unit-heal / P11 core-action
  {
    id: "P12-unsupported-respawn-check",
    officialPhase: 12,
    run: (draft, ctx) => {
      if (ctx.features.has("respawn")) {
        return outcome({ unsupported: ["respawn"] });
      }
      return EMPTY_OUTCOME;
    },
  },
  {
    id: "P13-refill-policy",
    officialPhase: 13,
    run: (draft, ctx) => {
      // 官方 refill 是 server secret（seed 不可见）——MVP 每 refill cadence
      // 记录 unknown 效应，绝不伪装成 MATCH。test-seeded rng 存在时也不
      // 称为"官方 refill"，只是场景注入。
      const cadence = ctx.rules.rules.economy.refillEveryTicks;
      if ((draft.resolvedTickCount + 1) % cadence === 0) {
        return outcome({
          unknownEffects: [
            {
              tick: draft.tick,
              kind: "refill",
              note: `refill cadence (every ${cadence} ticks) reached; official placement is server-secret`,
            },
          ],
        });
      }
      return EMPTY_OUTCOME;
    },
  },
  {
    id: "P14-invariant-check-and-commit",
    officialPhase: 14,
    run: (draft) => {
      assertWorldInvariants(draft);
      return EMPTY_OUTCOME;
    },
  },
  {
    id: "P15-next-observation",
    officialPhase: 15,
    run: () => EMPTY_OUTCOME, // tick 递增在 settleTick 末尾统一做
  },
];

type PhaseRunner = (draft: SimWorld, ctx: PhaseContext) => PhaseOutcome;

/**
 * 结算一个 Tick：输入 world（tick N）+ plans → 输出新 world（tick N+1）。
 * 失败抛错，原 world 不被修改。
 */
export function settleTick(
  world: SimWorld,
  plans: ReadonlyMap<string, Plan>,
  context: SettlementContext,
): SettlementResult {
  if (plans.size === 0) {
    throw new SettlementError("no plans provided (every player must submit a plan)");
  }

  const draft: SimWorld = structuredClone(world);
  const features = new Set<SimFeature>(scanUnsupported(world, plans));
  const ctx: PhaseContext = { rules: context.rules, plans, rng: context.rng, features };
  const events: ResolutionEvent[] = [];
  const unknownEffects: UnknownEffect[] = [];
  const unsupported: SimFeature[] = [];

  for (const phase of PHASES) {
    const out = (phase.run as unknown as PhaseRunner)(draft, ctx);
    // 保留官方 phase 顺序，只在 phase 内稳定排序；不能把后阶段事件
    // 全局排到前阶段之前，否则 trace 不再反映真实结算时序。
    events.push(...sortEvents(out.events));
    unknownEffects.push(...out.unknownEffects);
    unsupported.push(...out.unsupported);
  }

  // P15：tick 推进 + resolvedTickCount 递增（invariant 已通过）
  const next: SimWorld = {
    ...draft,
    tick: draft.tick + 1,
    resolvedTickCount: draft.resolvedTickCount + 1,
    unsupportedFeatures: [...new Set([...world.unsupportedFeatures, ...unsupported])],
  };
  assertWorldInvariants(next);

  return {
    world: next,
    events,
    unknownEffects,
    unsupported: [...new Set(unsupported)].sort(),
  };
}

/** 稳定事件排序：phase 内按 (actorId, eventType) —— 与对象插入顺序无关。 */
function sortEvents(events: readonly ResolutionEvent[]): readonly ResolutionEvent[] {
  return [...events].sort((a, b) => {
    const byActor = compareCodeUnit(a.actorId ?? a.targetId ?? "", b.actorId ?? b.targetId ?? "");
    if (byActor !== 0) return byActor;
    return compareCodeUnit(a.eventType, b.eventType);
  });
}

/** 调试/诊断：列出 phase 顺序（供测试断言）。 */
export function phaseOrder(): readonly string[] {
  return PHASES.map((p) => p.id);
}

/** 便捷：从世界构造空计划（全部 WAIT）——测试与 harness 用。 */
export function idlePlans(world: SimWorld): ReadonlyMap<string, Plan> {
  const plans = new Map<string, Plan>();
  for (const player of world.players.values()) {
    const unitActions: Record<string, { readonly type: "WAIT" }> = {};
    for (const unit of player.units) {
      unitActions[unit.id] = { type: "WAIT" };
    }
    plans.set(player.id, { tick: world.tick, unitActions, coreAction: null, intents: {} });
  }
  return plans;
}

export { eventOf } from "./phase.ts";
