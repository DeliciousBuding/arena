/** P1 战术小队最小编成（tactical-squads-v1，2026-08-09，默认关）。
 *
 * 目标：给"每 tick 全局瞬时排序"的军事决策落一个**稳定 squad 身份**层——
 *   HOME_DEFENSE（2V+1R 守家）+ 多个 STRIKE（2V+1R 攻坚）+ MOBILE 余量，
 *   跨 tick sticky（成员身份不因移动/输入顺序漂移），home guard 不被借空。
 *
 * 复用 `alliance/local-fleet.ts` 的 partitionLocalFleets 结构契约（角色 /
 * 编成 2V1R / 命名 `tenant:home:0` `tenant:strike:N` / formation 语义），
 * 不另造第二套互斥模型。本模块是纯函数合约层：不 import 领域运行态模块
 * （与 local-fleet 同构），SafetyPlanner 装配时把 live units 原样传入。
 *
 * rally slot：每个 squad 有一个确定性 slot 索引，`rallyPointAtSlot` 按 slot
 * 从 8 方位候选错位取点——不同小队集结到不同格，杜绝"全员共享单一 rally
 * cell / 同一路径目标"。slot=0 时行为 = 历史 rallyPoint（首候选，零回归）。
 *
 * 默认关：SafetyPlanner 只在 config.tacticalSquads === true 时调用；关闭时
 * 本模块零消费（零回归）。
 */
import { cellKey, type Position } from "../domain/model.ts";
import { chebyshev, manhattan } from "../domain/nav.ts";
import {
  partitionLocalFleets,
  type LocalFleetRole,
  type LocalUnit,
} from "../alliance/local-fleet.ts";

export type TacticalSquadRole = LocalFleetRole;

/** 合约层最小单位形状：local-fleet LocalUnit + 可选坐标（home 锚点排序用）。 */
export interface SquadUnit extends LocalUnit {
  readonly position?: Position;
}

export interface TacticalSquadOptions {
  /** home 编队 Vanguard 容量（默认 2，对齐 local-fleet home 2V1R）。 */
  readonly homeVanguards?: number;
  /** home 编队 Ranger 容量（默认 1，对齐 local-fleet home 2V1R）。 */
  readonly homeRangers?: number;
  /** home 编队选择锚点（我方 Core 位置）：提供时按"距锚点最近 + id 决胜"选
   *  守家成员（sticky 优先）；缺省回退 id 排序（确定性）。 */
  readonly homeAnchor?: Position;
}

export interface TacticalSquad {
  readonly id: string;
  readonly role: TacticalSquadRole;
  /** 编队顺序索引（home=0，strike:0=1，strike:1=2…）：rally slot 推导用。 */
  readonly index: number;
  readonly vanguardIds: readonly string[];
  readonly rangerIds: readonly string[];
}

export interface SquadMembership {
  readonly squads: readonly TacticalSquad[];
  /** unitId → squadId（sticky 归属性）。 */
  readonly squadByUnit: ReadonlyMap<string, string>;
}

/** rally 集结位 8 方位距离（Chebyshev）。必须与 safety-planner.ts 的
 *  RALLY_DISTANCE 保持一致（slot=0 时 rallyPointAtSlot 行为等价历史 rallyPoint）。 */
export const RALLY_SLOT_DISTANCE = 5;

/** rally 方位候选数（8 方位，与 safety-planner rallyPoint 同构）。 */
export const RALLY_SLOT_COUNT = 8;

export const EMPTY_SQUAD_MEMBERSHIP: SquadMembership = Object.freeze({
  squads: Object.freeze([]),
  squadByUnit: Object.freeze(new Map<string, string>()),
});

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function squadMembers(squad: TacticalSquad): readonly string[] {
  return [...squad.vanguardIds, ...squad.rangerIds];
}

/** home 编队容量：{v, r}；STRIKE 容量 {2,1}（local-fleet 编成）；MOBILE 无上限。 */
function roleCaps(
  role: TacticalSquadRole,
  opts: TacticalSquadOptions,
): { v: number; r: number } | null {
  if (role === "HOME_DEFENSE") return { v: opts.homeVanguards ?? 2, r: opts.homeRangers ?? 1 };
  if (role === "STRIKE") return { v: 2, r: 1 };
  return null;
}

function countType(members: readonly string[], unitById: ReadonlyMap<string, SquadUnit>, type: "VANGUARD" | "RANGER"): number {
  let n = 0;
  for (const id of members) if (unitById.get(id)?.unitType === type) n += 1;
  return n;
}

/** 单位是否可加入该编队（类型容量）：home 硬容量；strike 目标 2V1R、总额 ≤3
 *  （cross-fill 允许少 V 时补 R，与 local-fleet strike 填充同构）；mobile 无界。 */
function canAdd(
  role: TacticalSquadRole,
  caps: { v: number; r: number } | null,
  members: readonly string[],
  id: string,
  unitById: ReadonlyMap<string, SquadUnit>,
): boolean {
  const type = unitById.get(id)?.unitType;
  if (caps !== null && role === "HOME_DEFENSE") {
    if (type === "VANGUARD") return countType(members, unitById, "VANGUARD") < caps.v;
    if (type === "RANGER") return countType(members, unitById, "RANGER") < caps.r;
    return false;
  }
  if (role === "STRIKE") {
    if (members.length >= 3) return false;
    if (type === "VANGUARD") return countType(members, unitById, "VANGUARD") < 2;
    if (type === "RANGER") return countType(members, unitById, "RANGER") < 2;
    return false;
  }
  return true; // MOBILE
}

function buildSquad(
  id: string,
  role: TacticalSquadRole,
  index: number,
  members: readonly string[],
  unitById: ReadonlyMap<string, SquadUnit>,
): TacticalSquad {
  const vanguardIds = members.filter((m) => unitById.get(m)?.unitType === "VANGUARD").sort(stableCompare);
  const rangerIds = members.filter((m) => unitById.get(m)?.unitType === "RANGER").sort(stableCompare);
  return Object.freeze({
    id,
    role,
    index,
    vanguardIds: Object.freeze(vanguardIds),
    rangerIds: Object.freeze(rangerIds),
  });
}

/** 按锚点（Core）距离排序：近者优先，同距按 id 决胜（确定性）。 */
function sortByAnchor(units: readonly SquadUnit[], anchor: Position | undefined): SquadUnit[] {
  if (anchor === undefined) return [...units].sort((a, b) => stableCompare(a.id, b.id));
  return [...units].sort((a, b) => {
    const pa = a.position ?? anchor;
    const pb = b.position ?? anchor;
    const da = chebyshev(pa, anchor);
    const db = chebyshev(pb, anchor);
    return da - db || stableCompare(a.id, b.id);
  });
}

/** 战术小队编成（sticky 重算）。
 *
 * - 结构：复用 partitionLocalFleets 的编队骨架（角色顺序/命名/strike 数量）；
 * - sticky：上 tick 归属的存活成员优先保留在**原编队**（成员身份不漂移）；
 * - home 优先：home 编队先填满（sticky + 距锚点最近补员），strike/mobile
 *   只从**剩余未归属**单位取——home guard 绝不被借空；
 * - 确定性：同输入同输出（排序稳定 + 顺序无关）。
 */
export function reconcileTacticalSquads(
  units: readonly SquadUnit[],
  previous: ReadonlyMap<string, string> | null,
  tenantId: string,
  opts: TacticalSquadOptions = {},
): SquadMembership {
  if (units.length === 0) return EMPTY_SQUAD_MEMBERSHIP;
  const desired = partitionLocalFleets(units, tenantId);
  if (desired.length === 0) return EMPTY_SQUAD_MEMBERSHIP;

  const unitById = new Map(units.map((u) => [u.id, u]));
  const alive = new Set(units.map((u) => u.id));
  // 反向索引：squadId -> 上 tick 存活成员（去重，保持顺序）
  const prevMembers = new Map<string, string[]>();
  if (previous !== null) {
    for (const [unitId, squadId] of previous) {
      if (!alive.has(unitId)) continue;
      const list = prevMembers.get(squadId) ?? [];
      if (!list.includes(unitId)) list.push(unitId);
      prevMembers.set(squadId, list);
    }
  }

  const assigned = new Set<string>();
  const squads: TacticalSquad[] = [];

  desired.forEach((fleet, fleetIndex) => {
    if (fleet.role === "MOBILE") return; // mobile 最后统一收剩余
    const caps = roleCaps(fleet.role, opts);
    const members: string[] = [];
    // sticky 优先
    for (const id of prevMembers.get(fleet.id) ?? []) {
      if (assigned.has(id)) continue;
      if (!canAdd(fleet.role, caps, members, id, unitById)) continue;
      members.push(id);
      assigned.add(id);
    }
    // 补员池：home 按距锚点最近；strike 按"vanguard 优先（id 排序）+ ranger
    // （id 排序）"——与 local-fleet strike 2V1R 编成同构（纯 id 排序会让
    // ranger 'r' < vanguard 'v' 先入队，编成退化成 1V2R）。
    const unassignedUnits = units.filter((u) => !assigned.has(u.id));
    const pool = fleet.role === "HOME_DEFENSE"
      ? sortByAnchor(unassignedUnits, opts.homeAnchor)
      : [
          ...unassignedUnits.filter((u) => u.unitType === "VANGUARD").sort((a, b) => stableCompare(a.id, b.id)),
          ...unassignedUnits.filter((u) => u.unitType === "RANGER").sort((a, b) => stableCompare(a.id, b.id)),
        ];
    for (const u of pool) {
      if (assigned.has(u.id)) continue;
      if (!canAdd(fleet.role, caps, members, u.id, unitById)) continue;
      members.push(u.id);
      assigned.add(u.id);
    }
    if (members.length === 0) return;
    squads.push(buildSquad(fleet.id, fleet.role, fleetIndex, members, unitById));
  });

  // MOBILE / 兜底：全部未归属单位（含 local-fleet mobile 余量与任何遗留）收尾
  const leftover = units.filter((u) => !assigned.has(u.id)).sort((a, b) => stableCompare(a.id, b.id));
  if (leftover.length > 0) {
    const mobileFleet = desired.find((f) => f.role === "MOBILE");
    const mobileId = mobileFleet?.id ?? `${tenantId}:mobile:0`;
    const mobileIndex = mobileFleet !== undefined
      ? desired.indexOf(mobileFleet)
      : squads.length;
    squads.push(buildSquad(mobileId, "MOBILE", mobileIndex, leftover.map((u) => u.id), unitById));
  }

  const squadByUnit = new Map<string, string>();
  for (const squad of squads) {
    for (const id of squadMembers(squad)) squadByUnit.set(id, squad.id);
  }
  return Object.freeze({ squads: Object.freeze(squads), squadByUnit: Object.freeze(squadByUnit) });
}

/** squad 顺序索引 → rally slot（0..7）。home=0；strike:0=1；strike:1=2… */
export function rallySlotForSquad(squadIndex: number): number {
  return ((squadIndex % RALLY_SLOT_COUNT) + RALLY_SLOT_COUNT) % RALLY_SLOT_COUNT;
}

/** 按 slot 错位取 rally 集结位：8 方位候选按"距我方 Core 最近"排序，从
 *  slot 起点循环扫第一个非障碍/非资源点（slot=0 = 历史首候选语义）。 */
export function rallyPointAtSlot(
  target: Position,
  home: Position,
  obstacles: ReadonlySet<string>,
  resourceCells: ReadonlySet<string>,
  slot: number,
): Position {
  const offsets: ReadonlyArray<readonly [number, number]> = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  const candidates = offsets
    .map(([dx, dy]) => [target[0] + dx * RALLY_SLOT_DISTANCE, target[1] + dy * RALLY_SLOT_DISTANCE] as Position)
    .sort((a, b) => manhattan(a, home) - manhattan(b, home));
  const start = rallySlotForSquad(slot);
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[(start + i) % candidates.length]!;
    if (obstacles.has(cellKey(candidate))) continue;
    if (resourceCells.has(cellKey(candidate))) continue;
    return candidate;
  }
  return target;
}
