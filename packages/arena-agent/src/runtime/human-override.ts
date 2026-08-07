/** 人类最高控制权：live 主循环提交前的人类指令覆盖（Manual > Agent > Safety）。
 *
 * 设计（现代工程实践，2026-08-07）：
 *  - 单一 writer 纪律：仅 tenant 主循环经官方 SDK 提交；人类指令是共享数据层，
 *    loop 在 turn.replace()/submit() 前把指令合并进最终计划——天然避免双 writer。
 *  - 最高优先：人类指令覆盖 agent/safety 计划中对应单位/核心的动作；无指令单位保留原计划。
 *  - 可审计：指令带 id/createdAt/note；合并结果（applied/rejected + 原因）进 TickOutcome 遥测，
 *    指挥面板可回显"命令已执行 / 被拒绝"。
 *  - 可回滚：store.mode=disabled 一键交还控制权给 agent；clear 清空全部指令。
 *  - 权威净校验：逐条基础检查（单位存在/动作适配单位类型）后，合并计划复用 validatePlan
 *    （与 agent 同一语义校验：障碍/移动容量/射程等），非法指令被剔除并上报原因。
 *
 * 存储格式 data/runtime/human-commands/<tenant>.json：
 *   { "version": 1, "mode": "override" | "disabled",
 *     "commands": [ { "id", "unitId", "action": { type, ...(domain 格式) }, "note", "createdAt" } ],
 *     "updatedAt": "ISO" }
 * 写入方 = 指挥面板（server.mjs POST /api/command）；读取方 = 本模块（每 tick 提交前）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cellKey, type CoreAction, type Direction, type Plan, type Position, type TickState, type UnitAction, type UnitSnapshot, type UnitType } from "../domain/model.ts";
import { stepTowardPath } from "../domain/nav.ts";
import { validatePlan } from "../domain/plan-validator.ts";

export interface HumanCommand {
  readonly id: string;
  readonly unitId: string;
  readonly action: Record<string, unknown>;
  readonly note?: string;
  readonly createdAt: string;
}

export type HumanGoalKind = "mine" | "goto";

/** 持续意图（任务）：不是单 tick 动作，而是一个会持续到完成/取消的目标。
 *  mine：移动到目标矿格 → 自动采集 → 满仓回仓 → 回来继续，直到目标采空或取消；
 *  goto：移动到目标点即完成（交还 agent）。 */
export interface HumanGoal {
  readonly id: string;
  readonly unitId: string;
  readonly kind: HumanGoalKind;
  readonly target: Position;
  readonly note?: string;
  readonly createdAt: string;
}

export interface HumanCommandStore {
  readonly version?: number;
  readonly mode: "override" | "disabled";
  /** 一键动作（单 tick 覆盖，最高优先）。 */
  readonly commands: readonly HumanCommand[];
  /** 持续意图（任务，多 tick 执行）。 */
  readonly goals: readonly HumanGoal[];
  readonly updatedAt?: string | null;
}

export interface HumanCommandSource {
  readonly tenantId: string;
  readonly storeDir: string;
}

export interface HumanRejection {
  readonly unitId: string;
  readonly reason: string;
}

export interface HumanOverrideResult {
  /** 合并后计划（human 指令覆盖后的最终提交计划；无指令时 == basePlan）。 */
  readonly plan: Plan;
  /** 是否有人类指令生效（mode=override 且至少一条应用成功）。 */
  readonly active: boolean;
  /** 应用成功的 unitId 列表。 */
  readonly applied: readonly string[];
  /** 被拒绝的指令（未知单位/动作不适配/语义校验失败）。 */
  readonly rejected: readonly HumanRejection[];
  /** 已完成意图的 unitId（如矿已采空 / 已到达目标点）——本 tick 起交还 agent。 */
  readonly satisfied: readonly string[];
  /** store 更新时间（遥测）。 */
  readonly updatedAt: string | null;
}

const DIRECTIONS: readonly Direction[] = ["UP", "DOWN", "LEFT", "RIGHT"];

/** 领域动作从 wire/store 形状转换；非法形状返回 null（逐条拒绝）。 */
export function actionFromWire(action: Record<string, unknown>): UnitAction | CoreAction | null {
  if (!action || typeof action !== "object") return null;
  const type = String(action.type ?? "");
  switch (type) {
    case "WAIT":
      return { type: "WAIT" };
    case "MOVE":
    case "SWEEP":
    case "START_MOVE": {
      const direction = String(action.direction ?? "");
      if (!DIRECTIONS.includes(direction as Direction)) return null;
      return { type, direction: direction as Direction } as UnitAction | CoreAction;
    }
    case "SHOOT": {
      const targetId = action.targetId === null || action.targetId === undefined ? null : String(action.targetId);
      const ec = action.expectedCell;
      if (!Array.isArray(ec) || ec.length !== 2 || !ec.every((n) => Number.isInteger(n))) return null;
      return { type: "SHOOT", targetId, expectedCell: [Number(ec[0]), Number(ec[1])] } as UnitAction;
    }
    case "SPAWN": {
      const unitType = String(action.unitType ?? "");
      if (unitType !== "WORKER" && unitType !== "VANGUARD" && unitType !== "RANGER") return null;
      return { type: "SPAWN", unitType: unitType as UnitType } as CoreAction;
    }
    case "HARVEST":
    case "DEPOSIT":
    case "PICKUP_BEACON":
    case "DROP_BEACON":
    case "SELF_DESTRUCT":
    case "HEAL":
    case "REPAIR_SHIELD":
    case "CANCEL_MOVE":
      return { type } as UnitAction | CoreAction;
    default:
      return null;
  }
}

/** 读指令存储；缺失/损坏/mode=disabled → null（= 无人类控制）。 */
export function loadHumanCommands(source: HumanCommandSource): HumanCommandStore | null {
  const file = join(source.storeDir, `${source.tenantId}.json`);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const mode = raw.mode === "disabled" ? "disabled" : "override";
    if (mode === "disabled") return { mode, commands: [], goals: [] };
    const commands: HumanCommand[] = [];
    if (Array.isArray(raw.commands)) {
      for (const c of raw.commands) {
        if (c && typeof c === "object" && typeof c.unitId === "string" && c.action && typeof c.action === "object") {
          commands.push({
            id: String(c.id ?? `cmd-${commands.length}`),
            unitId: c.unitId,
            action: c.action as Record<string, unknown>,
            note: typeof c.note === "string" ? c.note : undefined,
            createdAt: typeof c.createdAt === "string" ? c.createdAt : new Date().toISOString(),
          });
        }
      }
    }
    const goals: HumanGoal[] = [];
    if (Array.isArray(raw.goals)) {
      for (const g of raw.goals) {
        if (g && typeof g === "object" && typeof g.unitId === "string" && g.kind === "mine" || (g && typeof g === "object" && g.kind === "goto")) {
          const kind: HumanGoalKind = g.kind === "goto" ? "goto" : "mine";
          const t = g.target;
          if (!Array.isArray(t) || t.length !== 2 || !Number.isInteger(t[0]) || !Number.isInteger(t[1])) continue;
          goals.push({
            id: String(g.id ?? `goal-${goals.length}`),
            unitId: String(g.unitId),
            kind,
            target: [Number(t[0]), Number(t[1])],
            note: typeof g.note === "string" ? g.note : undefined,
            createdAt: typeof g.createdAt === "string" ? g.createdAt : new Date().toISOString(),
          });
        }
      }
    }
    return { version: Number(raw.version ?? 1), mode, commands, goals, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null };
  } catch {
    return null;
  }
}

/** 基础检查：单位存在 + 动作适配单位类型（拒绝原因精确上报）。 */
function basicCheck(state: TickState, unitId: string, action: UnitAction | CoreAction): string | null {
  const unitsById = new Map<string, UnitSnapshot>(state.units.map((u) => [u.id, u]));
  const isCore = state.core !== null && unitId === state.core.id;
  if (!isCore && !unitsById.has(unitId)) return "unknown_unit";
  if (isCore) return null;
  const unit = unitsById.get(unitId)!;
  if (action.type === "HARVEST" || action.type === "DEPOSIT") {
    if (unit.unitType !== "WORKER") return "action_requires_worker";
  }
  if (action.type === "SWEEP" && unit.unitType !== "VANGUARD") return "action_requires_vanguard";
  if (action.type === "SHOOT" && unit.unitType !== "RANGER") return "action_requires_ranger";
  if (action.type === "PICKUP_BEACON" || action.type === "DROP_BEACON") {
    if (unit.unitType !== "WORKER" && unit.unitType !== "VANGUARD") return "beacon_requires_worker_or_vanguard";
  }
  return null;
}

/** 意图微控制器：给定单位与目标，计算本 tick 动作（人类意图，复用 stepTowardPath 寻路）。
 *  mine：cargo>0 → 回仓（在核心格则 DEPOSIT，否则向核心移动）；在目标资源格 → HARVEST；
 *        目标资源已消失且未在格上 → null（完成，交还 agent）；否则向目标移动。
 *  goto：到达目标点 → null（完成）；否则向目标移动。
 *  返回 null = 意图完成，本 tick 交还 agent。 */
function goalActionForUnit(state: TickState, unit: UnitSnapshot, goal: HumanGoal): UnitAction | null {
  const obstacles = state.obstacleCells;
  const target = goal.target;
  if (goal.kind === "mine") {
    if (unit.cargo > 0) {
      const core = state.core;
      if (core === null) return { type: "WAIT" };
      const atCore = unit.position[0] === core.position[0] && unit.position[1] === core.position[1];
      if (atCore) return { type: "DEPOSIT" };
      const dir = stepTowardPath(unit.position, core.position, obstacles);
      return dir === null ? { type: "WAIT" } : { type: "MOVE", direction: dir };
    }
    const atTarget = unit.position[0] === target[0] && unit.position[1] === target[1];
    if (atTarget) return { type: "HARVEST" };
    if (!state.resourceCells.has(cellKey(target))) return null; // 矿已采空 → 完成
    const dir = stepTowardPath(unit.position, target, obstacles);
    return dir === null ? { type: "WAIT" } : { type: "MOVE", direction: dir };
  }
  // goto
  const atTarget = unit.position[0] === target[0] && unit.position[1] === target[1];
  if (atTarget) return null;
  const dir = stepTowardPath(unit.position, target, obstacles);
  return dir === null ? { type: "WAIT" } : { type: "MOVE", direction: dir };
}

/** 提交前合并人类指令（最高优先）。无指令/mode=disabled → 原计划原样返回。 */
export function applyHumanOverrides(
  state: TickState,
  basePlan: Plan,
  source: HumanCommandSource,
): HumanOverrideResult {
  const store = loadHumanCommands(source);
  if (store === null || store.mode !== "override" || (store.commands.length === 0 && store.goals.length === 0)) {
    return { plan: basePlan, active: false, applied: [], rejected: [], satisfied: [], updatedAt: null };
  }

  const unitActions: Record<string, UnitAction> = { ...basePlan.unitActions };
  let coreAction: CoreAction | null = basePlan.coreAction;
  const applied: string[] = [];
  const rejected: HumanRejection[] = [];

  for (const cmd of store.commands) {
    const action = actionFromWire(cmd.action);
    if (action === null) {
      rejected.push({ unitId: cmd.unitId, reason: "invalid_action" });
      continue;
    }
    const issue = basicCheck(state, cmd.unitId, action);
    if (issue !== null) {
      rejected.push({ unitId: cmd.unitId, reason: issue });
      continue;
    }
    const isCore = state.core !== null && cmd.unitId === state.core.id;
    if (isCore) {
      coreAction = action as CoreAction;
    } else {
      unitActions[cmd.unitId] = action as UnitAction;
    }
    applied.push(cmd.unitId);
  }

  // 持续意图（任务）：一键动作优先，未覆盖的单位按 goal 执行（人类意图 + agent 执行语义）
  const satisfied: string[] = [];
  const unitById = new Map<string, UnitSnapshot>(state.units.map((u) => [u.id, u]));
  const overriddenById = new Set<string>([...applied, ...(coreAction !== basePlan.coreAction && state.core ? [state.core.id] : [])]);
  for (const goal of store.goals) {
    if (overriddenById.has(goal.unitId)) continue;
    const unit = unitById.get(goal.unitId);
    if (!unit) { rejected.push({ unitId: goal.unitId, reason: "unknown_unit" }); continue; }
    const action = goalActionForUnit(state, unit, goal);
    if (action === null) {
      satisfied.push(goal.unitId); // 目标完成（到达/采空）→ 交还 agent
      continue;
    }
    unitActions[goal.unitId] = action;
    applied.push(goal.unitId);
    overriddenById.add(goal.unitId);
  }

  const merged: Plan = {
    tick: basePlan.tick,
    unitActions,
    coreAction,
    intents: basePlan.intents,
  };

  // 权威净校验（与 agent 同一语义：障碍/移动容量/射程/资源等）——非法人类动作被剔除并上报。
  const validation = validatePlan(state, merged);
  const plan = validation.plan;
  const issueActors = new Set(validation.issues.map((i) => i.actorId));
  const validatedRejected: HumanRejection[] = [];
  for (const unitId of applied) {
    if (issueActors.has(unitId)) {
      const msg = validation.issues.find((i) => i.actorId === unitId)?.message ?? "validation_failed";
      validatedRejected.push({ unitId, reason: msg });
    }
  }
  const finalApplied = applied.filter((id) => !issueActors.has(id));

  return {
    plan,
    active: finalApplied.length > 0,
    applied: finalApplied,
    rejected: [...rejected, ...validatedRejected],
    satisfied,
    updatedAt: store.updatedAt ?? null,
  };
}
