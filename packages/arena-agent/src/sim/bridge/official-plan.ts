/**
 * 官方 CommandPlan JSON 解析（桥接从外部策略进程接收决策，与 Rust 线
 * arena-sim-bridge 对偶）。形状：`{"tick":N,"unit_actions":{"<uuid>":
 * {"type":"MOVE","direction":"UP"}},"core_action":{"type":"SPAWN",
 * "unit_type":"WORKER"}}`。
 *
 * UUID → 模拟器 ID 反查：FNV-1a 不可逆——用"本 tick 全部单位 ID 的
 * canonical_uuid 正向映射表"反查；未知 UUID（外部策略引用陈旧/缺席单位）
 * 丢弃并计数（fail-open：不中止整局）。
 */

import type { CoreAction, Direction, Plan, UnitAction, UnitType } from "../../domain/model.ts";
import { canonicalUuid } from "./canonical-uuid.ts";

export interface PlanWarning {
  readonly kind: string;
  readonly detail: string;
}

interface OfficialPlanJson {
  readonly tick?: number;
  readonly unit_actions?: Record<string, Record<string, unknown>>;
  readonly core_action?: Record<string, unknown> | null;
}

/** 官方 CommandPlan JSON → domain Plan（uuid 反查 + 未知动作 fail-open）。 */
export function planFromOfficialJson(
  value: unknown,
  simIds: readonly string[],
): { readonly plan: Plan; readonly warnings: readonly PlanWarning[] } {
  const warnings: PlanWarning[] = [];
  const object = (value ?? {}) as OfficialPlanJson;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    warnings.push({ kind: "plan", detail: "plan is not an object" });
    return { plan: { tick: 0, unitActions: {}, coreAction: null, intents: {} }, warnings };
  }
  const tick = typeof object.tick === "number" ? object.tick : 0;

  const uuidToSim = new Map(simIds.map((id) => [canonicalUuid(id), id]));

  const unitActions: Record<string, UnitAction> = {};
  if (object.unit_actions !== undefined) {
    for (const [uuid, actionValue] of Object.entries(object.unit_actions)) {
      const simId = uuidToSim.get(uuid);
      if (simId === undefined) {
        warnings.push({ kind: "unit_action", detail: `${uuid}: unknown unit (stale/absent)` });
        continue;
      }
      const parsed = parseUnitAction(actionValue);
      if (parsed.kind === "ok") {
        unitActions[simId] = parsed.action;
      } else if (parsed.kind === "warn") {
        warnings.push({ kind: "unit_action", detail: `${uuid}: ${parsed.detail}` });
      }
    }
  }

  let coreAction: CoreAction | null = null;
  if (object.core_action !== undefined && object.core_action !== null) {
    const parsed = parseCoreAction(object.core_action);
    if (parsed.kind === "ok") {
      coreAction = parsed.action;
    } else if (parsed.kind === "warn") {
      warnings.push({ kind: "core_action", detail: parsed.detail });
    }
  }

  return {
    plan: { tick, unitActions, coreAction, intents: {} },
    warnings,
  };
}

type ParseResult<T> = { kind: "ok"; action: T } | { kind: "warn"; detail: string };

function parseUnitAction(value: Record<string, unknown>): ParseResult<UnitAction> {
  const actionType = typeof value.type === "string" ? value.type : null;
  if (actionType === null) {
    return { kind: "warn", detail: "action.type missing" };
  }
  const direction = parseDirection(value.direction);
  switch (actionType) {
    case "WAIT":
      return { kind: "ok", action: { type: "WAIT" } };
    case "MOVE":
      return direction === null
        ? { kind: "warn", detail: "MOVE without valid direction" }
        : { kind: "ok", action: { type: "MOVE", direction } };
    case "HARVEST":
      return { kind: "ok", action: { type: "HARVEST" } };
    case "DEPOSIT":
      return { kind: "ok", action: { type: "DEPOSIT" } };
    case "SWEEP":
      return direction === null
        ? { kind: "warn", detail: "SWEEP without valid direction" }
        : { kind: "ok", action: { type: "SWEEP", direction } };
    case "SHOOT": {
      const expectedCell = Array.isArray(value.expected_cell)
        ? ([Number(value.expected_cell[0]), Number(value.expected_cell[1])] as const)
        : null;
      if (expectedCell === null) {
        return { kind: "warn", detail: "SHOOT without expected_cell" };
      }
      // 2026-08-08 修复：服务端回显 cell-fire 的 target_id 可能是空串 ""（空格射击），
      // 空串与 null 语义等价；统一归一为 null，避免校准 schema 丢弃 case。
      const rawTargetId = value.target_id;
      const targetId =
        typeof rawTargetId === "string" && rawTargetId.length > 0 ? rawTargetId : null;
      return { kind: "ok", action: { type: "SHOOT", targetId, expectedCell } };
    }
    case "PICKUP_BEACON":
      return { kind: "ok", action: { type: "PICKUP_BEACON" } };
    case "DROP_BEACON":
      return { kind: "ok", action: { type: "DROP_BEACON" } };
    case "SELF_DESTRUCT":
      return { kind: "ok", action: { type: "SELF_DESTRUCT" } };
    case "HEAL":
      return { kind: "ok", action: { type: "HEAL" } };
    default:
      return { kind: "warn", detail: `unknown action type: ${actionType}` };
  }
}

function parseCoreAction(value: Record<string, unknown>): ParseResult<CoreAction> {
  const actionType = typeof value.type === "string" ? value.type : null;
  if (actionType === null) {
    return { kind: "warn", detail: "core_action.type missing" };
  }
  switch (actionType) {
    case "WAIT":
      return { kind: "ok", action: { type: "WAIT" } };
    case "SPAWN": {
      const unitType = parseUnitType(value.unit_type);
      return unitType === null
        ? { kind: "warn", detail: "SPAWN without valid unit_type" }
        : { kind: "ok", action: { type: "SPAWN", unitType } };
    }
    case "REPAIR_SHIELD":
      return { kind: "ok", action: { type: "REPAIR_SHIELD" } };
    case "HEAL":
      return { kind: "ok", action: { type: "HEAL" } };
    case "PICKUP_BEACON":
      return { kind: "ok", action: { type: "PICKUP_BEACON" } };
    case "DROP_BEACON":
      return { kind: "ok", action: { type: "DROP_BEACON" } };
    case "SELF_DESTRUCT":
      return { kind: "ok", action: { type: "SELF_DESTRUCT" } };
    // Core 迁移动作：solo 模拟不执行——忽略不报错（外部策略可能按其
    // 真实服务器配置发送）。
    case "START_MOVE":
    case "CANCEL_MOVE":
      return { kind: "warn", detail: `${actionType} ignored (solo sim)` };
    default:
      return { kind: "warn", detail: `unknown core action type: ${actionType}` };
  }
}

function parseDirection(value: unknown): Direction | null {
  if (value === "UP" || value === "DOWN" || value === "LEFT" || value === "RIGHT") {
    return value;
  }
  return null;
}

function parseUnitType(value: unknown): UnitType | null {
  if (value === "WORKER" || value === "VANGUARD" || value === "RANGER") {
    return value;
  }
  return null;
}

