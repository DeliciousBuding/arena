/**
 * AI 指挥接入层——安全护栏（command-plane v1，2026-08-08）。
 *
 * 复用 migration-audit 的判定思想（敌核贴脸/弃富投贫），扩展到通用命令：
 *  - 敌核贴脸：意图目标 60 格内活跃敌核 >0 → 拒绝（可 force）
 *  - 弃富投贫：迁核目标区新鲜资源 < 阈值 → 拒绝（可 force）
 *  - 信标禁区：(-11,-1) 半径内 → 拒绝（不可 force）
 *  - 双写保护：同一 tenant 已有活跃 AI intent → 拒绝（幂等除外）
 *  - 单位能力：unitType 与动作匹配
 * 纯函数；数据不可读时 fail-closed 拒绝（不是放行）。
 */

import type { GuardrailReason, Intent } from "./protocol.ts";

/** 敌核记忆（survey.core_hunts 行）。 */
export interface EnemyCoreMemory {
  readonly x: number;
  readonly y: number;
  readonly lastSeenTick: number;
}
export interface KnownResource {
  readonly x: number;
  readonly y: number;
  readonly lastSeenTick: number;
}
export interface ActiveIntentState {
  /** 当前活跃 intent 数量（按 tenant）。 */
  readonly activeCount: number;
  /** 活跃 intent id 列表（幂等检测）。 */
  readonly activeIntentIds: readonly string[];
}

export interface GuardrailContext {
  readonly tenant: string;
  readonly currentTick: number;
  readonly enemyCores: readonly EnemyCoreMemory[];
  readonly resources: readonly KnownResource[];
  readonly active: ActiveIntentState;
}

const BEACON: readonly [number, number] = [-11, -1];
const DEFAULT_AVOID_ENEMY = 60;
const DEFAULT_RESOURCE_RADIUS = 30;
const MIN_FRESH_RESOURCES = 8;
const RESOURCE_FRESH_WINDOW = 4000;
const ENEMY_ACTIVE_WINDOW = 3000;
const BEACON_SAFE = 60;

function cheb(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

/** 目标点敌核贴脸检查：返回拒绝原因（无则 null）。 */
function enemyProximityCheck(
  target: readonly [number, number],
  ctx: GuardrailContext,
  avoidWithin: number,
): GuardrailReason | null {
  const active = ctx.enemyCores.filter(
    (e) => cheb([e.x, e.y], target) <= avoidWithin
      && ctx.currentTick - e.lastSeenTick <= ENEMY_ACTIVE_WINDOW,
  );
  if (active.length === 0) return null;
  return {
    code: "enemy_proximity",
    detail: `目标 ${target} ${avoidWithin} 格内有 ${active.length} 个活跃敌核记忆`,
    evidence: { activeEnemies: active.slice(0, 10).map((e) => ({ x: e.x, y: e.y, lastSeenTick: e.lastSeenTick })) },
  };
}

/** 目标区资源贫瘠检查（迁核专用）：目标 30 格内新鲜资源 < 8。 */
function resourcePovertyCheck(
  target: readonly [number, number],
  ctx: GuardrailContext,
): GuardrailReason | null {
  const near = ctx.resources.filter((r) => cheb([r.x, r.y], target) <= DEFAULT_RESOURCE_RADIUS);
  const fresh = near.filter((r) => ctx.currentTick - r.lastSeenTick <= RESOURCE_FRESH_WINDOW);
  if (fresh.length >= MIN_FRESH_RESOURCES) return null;
  return {
    code: "resource_poverty",
    detail: `目标 ${target} ${DEFAULT_RESOURCE_RADIUS} 格内新鲜资源 ${fresh.length} < ${MIN_FRESH_RESOURCES}（已知 ${near.length}）——弃富投贫`,
    evidence: { fresh: fresh.length, known: near.length },
  };
}

/** 信标禁区检查：目标/路径不得进入信标安全半径。 */
function beaconProximityCheck(
  target: readonly [number, number],
  phases: readonly (readonly [number, number])[] | undefined,
  safeRadius: number,
): GuardrailReason | null {
  const pts = [target, ...(phases ?? [])];
  const tooClose = pts.filter((p) => cheb(p, BEACON) <= safeRadius);
  if (tooClose.length === 0) return null;
  return {
    code: "beacon_zone",
    detail: `目标/阶段 ${tooClose.join(" ")} 进入信标 ${BEACON} 安全半径 ${safeRadius} 内——禁区`,
    evidence: { beacon: BEACON, tooClose },
  };
}

/** 双写保护：同 tenant 已有活跃 AI intent（幂等同 id 除外）。 */
function concurrencyCheck(intent: Intent, ctx: GuardrailContext): GuardrailReason | null {
  if (ctx.active.activeCount === 0) return null;
  if (ctx.active.activeIntentIds.includes(intent.intentId)) return null; // 幂等重放
  return {
    code: "concurrent_intent",
    detail: `tenant ${ctx.tenant} 已有 ${ctx.active.activeCount} 个活跃 AI intent——先 cancel 再下发`,
    evidence: { activeIds: ctx.active.activeIntentIds },
  };
}

/** 通用命令护栏入口。返回全部拒绝原因（空=通过）。 */
export function runGuardrails(
  intent: Intent,
  ctx: GuardrailContext,
): readonly GuardrailReason[] {
  const reasons: GuardrailReason[] = [];
  const target = intent.spec.target;
  const c = intent.constraints ?? {};
  const avoidWithin = c.avoidEnemyWithin ?? DEFAULT_AVOID_ENEMY;
  const beaconRadius = c.beaconSafeRadius ?? BEACON_SAFE;

  // 信标禁区：不可 force
  const beacon = beaconProximityCheck(target, intent.spec.phases, beaconRadius);
  if (beacon) reasons.push(beacon);

  // 敌核贴脸：可 force（有理由）
  const enemy = enemyProximityCheck(target, ctx, avoidWithin);
  if (enemy && !(c.force && c.forceReason)) reasons.push(enemy);

  // 弃富投贫：迁核专用，可 force
  if (intent.spec.kind === "core_migrate") {
    const poverty = resourcePovertyCheck(target, ctx);
    if (poverty && !(c.force && c.forceReason)) reasons.push(poverty);
  }

  // 双写保护：AI 意图唯一活跃
  const conc = concurrencyCheck(intent, ctx);
  if (conc) reasons.push(conc);

  return reasons;
}

/** 单位能力匹配（v1 最小集）：动作类型是否适配单位类型。 */
export function checkUnitCapability(unitType: string, actionType: string): GuardrailReason | null {
  const map: Record<string, readonly string[]> = {
    WORKER: ["MOVE", "SWEEP", "HARVEST", "DEPOSIT"],
    VANGUARD: ["MOVE", "SWEEP", "SHOOT", "START_MOVE"],
    RANGER: ["MOVE", "SWEEP", "SHOOT", "START_MOVE"],
  };
  const allowed = map[unitType] ?? [];
  if (allowed.includes(actionType)) return null;
  return {
    code: "unit_capability",
    detail: `单位 ${unitType} 不支持动作 ${actionType}`,
  };
}
