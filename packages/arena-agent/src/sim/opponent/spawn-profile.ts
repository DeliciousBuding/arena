/**
 * W54 — Spawn Profile + Slot 轮换（2026-08-09）
 *
 * 模拟线上真实开局（reference arena-evolve/evolve/fitness.py:96-181）：
 * 被测新号 1 Worker + 5 资源开局；老玩家开局就带兵（7W/6R/6V 模板，
 * 19 人口，发育了几千 tick）；弃坑残骸挂机死 Core（2 Worker + 5 资源）；
 * 新生弱号 5 资源无单位。出生站点 8 个（SPAWN_SITES），被测者每局轮换
 * 站点（P0#16 消除固定 slot 结构性偏差）。
 *
 * 角色与 slot 解耦（reference 2026-08-06 裁决）：旧实现按 slot 硬编码
 * 对手类型，slot 轮换后角色错位。本模块按角色（role）建档案，slot 仅
 * 决定站点，不影响角色分配。
 */

import { emptyPlan, type Plan, type Position, type TickState, type UnitType } from "../../domain/model.ts";
import type { PlanProvider } from "../../runtime/decision-types.ts";

/** 对手角色（与 slot 解耦）。被测者（SUBJECT）单独由 buildSpawnScenario 标注，
 *  不属于 SpawnRole——SpawnRole 只描述对手。 */
export type SpawnRole = "OLD_BALANCED" | "OLD_AGGRESSIVE" | "STATIC" | "NEW_WEAK";

/** 出生档案：一个玩家开局时的资源 + 单位构成。 */
export interface SpawnProfile {
  readonly center: Position;
  readonly res: number;
  /** 缺省 = 无单位（新生弱号）。 */
  readonly units: Partial<Record<UnitType, number>>;
}

/** 出生站点（8 个）。2026-08-09 GA 烟雾校准：站点聚簇在原点 ±24 格内、
 *  最近邻 ~16-22 格——使 50 tick 烟雾内 SafetyPlanner aggressive 对手能侦察到
 *  被测者并发起攻坚（reference 真实开局 50 格分布在 ≥200 tick 评估才生效；
 *  烟雾需近距保证 damage > 0 可验证）。站点间 Core 距 ≥16，无重叠占用。 */
export const SPAWN_SITES: readonly Position[] = [
  [0, -18], [16, -9], [16, 9], [0, 18], [-16, 9], [-16, -9], [24, 0], [-24, 0],
];

/** 老玩家单位模板（reference 校准：敌方联盟 4 账号 72 单位 = 7W/6R/6V，
 *  战斗单位 61%——旧配置 worker 67% 太和平，评估低估冲突强度）。 */
const OLD_PLAYER_UNITS: Readonly<Record<UnitType, number>> = {
  WORKER: 7,
  RANGER: 6,
  VANGUARD: 6,
};

/** 挂机死 Core 模板：2 Worker + 5 资源（弃坑残骸，挂机不反击）。 */
const STATIC_UNITS: Readonly<Record<UnitType, number>> = {
  WORKER: 2,
  RANGER: 0,
  VANGUARD: 0,
};

/** 被测者（newborn）模板：1 Worker + 5 资源（官方起点 v0.14）。 */
const SUBJECT_UNITS: Readonly<Record<UnitType, number>> = {
  WORKER: 1,
  RANGER: 0,
  VANGUARD: 0,
};

/** 按角色建出生档案（与 LIVE_SPAWN_PROFILE 同语义）。 */
export function profileForRole(role: SpawnRole, site: Position): SpawnProfile {
  switch (role) {
    case "OLD_BALANCED":
      return { center: site, res: 20, units: { ...OLD_PLAYER_UNITS } };
    case "OLD_AGGRESSIVE":
      return { center: site, res: 10, units: { ...OLD_PLAYER_UNITS } };
    case "STATIC":
      return { center: site, res: 5, units: { ...STATIC_UNITS } };
    case "NEW_WEAK":
      return { center: site, res: 5, units: {} };
  }
}

/** 被测者出生档案（newborn：1 Worker + 5 资源）。 */
export function subjectProfile(site: Position): SpawnProfile {
  return { center: site, res: 5, units: { ...SUBJECT_UNITS } };
}

/**
 * 按玩家数生成对手角色序列（reference _roles_for）。
 * - 6 玩家（5 对手）：2 老 + 2 挂 + 1 新；
 * - 8 玩家（7 对手）：3 老 + 2 挂 + 2 新。
 * 老玩家第一个 = OLD_BALANCED，其余 = OLD_AGGRESSIVE（reference ROLE_OLD1/2/3）。
 */
export function rolesFor(numPlayers: number): SpawnRole[] {
  if (numPlayers < 2) {
    throw new Error(`rolesFor: numPlayers must be >= 2, got ${numPlayers}`);
  }
  const numOpponents = numPlayers - 1;
  const oldCount = numOpponents <= 5 ? 2 : 3;
  const staticCount = 2;
  const weakCount = Math.max(0, numOpponents - oldCount - staticCount);
  const roles: SpawnRole[] = [];
  for (let index = 0; index < oldCount; index += 1) {
    roles.push(index === 0 ? "OLD_BALANCED" : "OLD_AGGRESSIVE");
  }
  for (let index = 0; index < staticCount && roles.length < numOpponents; index += 1) {
    roles.push("STATIC");
  }
  for (let index = 0; index < weakCount; index += 1) {
    roles.push("NEW_WEAK");
  }
  return roles;
}

/** NoOpPlanner — 挂机死 Core（reference StaticStrategy 等价）：完全不行动，
 *  Core 存在但不反击。模拟真实世界里的无操作死 Core / 弃坑残骸。
 *  实现：返回 emptyPlan(tick)（无 coreAction、无 unitActions），与 reference
 *  `{"core": None, "units": {}}` 语义一致。 */
export class NoOpPlanner implements PlanProvider {
  decide(input: { readonly state: TickState }): Plan {
    return emptyPlan(input.state.tick);
  }
}

/** 按 role 构造一个 PlanProvider（与 reference _strategy_for_role 对齐）。 */
export function plannerForRole(role: SpawnRole): PlanProvider {
  switch (role) {
    case "STATIC":
      return new NoOpPlanner();
    case "OLD_BALANCED":
    case "OLD_AGGRESSIVE":
    case "NEW_WEAK":
      // 老玩家/新生弱号的具体策略由调用方（vs-arena-spawn）通过 SafetyPlanner
      // 配置注入；本函数只兜底 STATIC（NoOp），其余返回 NoOp 作为占位。
      // 真实策略注入走 buildSpawnScenario 之外的 tournament/registry 路径。
      return new NoOpPlanner();
  }
}

/* ---------------- scenario 构造 ---------------- */

/** 出生场景参与者：SUBJECT = 被测者；其余 = 对手角色。 */
export interface SpawnParticipant {
  readonly id: string;
  readonly username?: string;
  readonly role: "SUBJECT" | SpawnRole;
}

/** 出生场景构造结果：scenario JSON + rotatedSlot（被测者实际所在站点序）。 */
export interface SpawnScenarioResult {
  readonly scenario: unknown;
  readonly rotatedSlot: number;
}

/** Core id 前缀（每玩家一个 canonical UUID；8 站点 → 8 前缀，SPAWN_SITES 限制下足够）。 */
const CORE_ID_PREFIXES: readonly string[] = [
  "491977e4-d3db-417b-8d82-2f5f3b5c8006",
  "9fe0ca6d-53cb-4dd5-a8f8-2e6925f19e72",
  "1c8a4b2e-7f6d-4a3e-9c1b-5d2e8f4a6b7c",
  "6a3f9c1e-2b4d-4e8a-9f3c-7d1e5a8b2c4d",
  "7b4e0d2f-3c5e-4f9b-a04d-8e2f6b9c3d5e",
  "8c5f1e3a-4d6f-4abc-b05e-9f3a7c4d8e6f",
  "9d6a2f4b-5e7a-4bcd-c16f-0a4b8d5e9f70",
  "0e7b3a5c-6f8b-4cde-d27a-1b5c9e6f0a81",
];

/** 单位 id 前缀（8 位 hex，每玩家一个；单位 id 尾部带 playerIndex+unitIndex 唯一）。 */
const UNIT_ID_PREFIXES: readonly string[] = [
  "22222222", "33333333", "44444444", "55555555",
  "66666666", "77777777", "88888888", "99999999",
];

/** 单位类型 → 满血（world.ts HP_MAX：WORKER=2 / RANGER=2 / VANGUARD=4）。 */
const HP_BY_TYPE: Readonly<Record<UnitType, number>> = {
  WORKER: 2,
  RANGER: 2,
  VANGUARD: 4,
};

function pad6(value: number): string {
  return String(value).padStart(6, "0");
}

function makeUnitId(playerIndex: number, unitIndex: number): string {
  const prefix = UNIT_ID_PREFIXES[playerIndex % UNIT_ID_PREFIXES.length]!;
  const tail = `${pad6(playerIndex)}${pad6(unitIndex)}`;
  return `${prefix}-0000-0000-0000-${tail}`;
}

function makeCoreId(playerIndex: number): string {
  return CORE_ID_PREFIXES[playerIndex % CORE_ID_PREFIXES.length]!;
}

/** 在原点附近生成 count 个互不重叠的小偏移（chebyshev 半径 1..r 扩张），
 *  避开 (0,0)（Core 占位）。每个偏移最多复用 1 次 → 每格 ≤2 实体（Core 自占
 *  一格 = 1 实体，单位各占独立格 = 1 实体/格，满足 occupancy ≤2）。 */
function ringOffsets(count: number): readonly Position[] {
  const offsets: Position[] = [];
  for (let radius = 1; offsets.length < count && radius <= 8; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        offsets.push([dx, dy]);
        if (offsets.length >= count) break;
      }
      if (offsets.length >= count) break;
    }
  }
  return offsets;
}

/** 按 profile 生成初始单位列表（id 确定性派生 + 满血 + cargo 0）。 */
function buildUnits(
  ownerId: string,
  playerIndex: number,
  profile: SpawnProfile,
): readonly {
  readonly id: string;
  readonly owner: string;
  readonly position: Position;
  readonly hp: number;
  readonly unitType: UnitType;
  readonly cargo: number;
}[] {
  const entries = (Object.entries(profile.units) as [UnitType, number | undefined][]);
  const total = entries.reduce((sum, [, count]) => sum + (count ?? 0), 0);
  const offsets = ringOffsets(total);
  const units: {
    id: string;
    owner: string;
    position: Position;
    hp: number;
    unitType: UnitType;
    cargo: number;
  }[] = [];
  let unitIndex = 0;
  for (const [unitType, count] of entries) {
    const resolved = count ?? 0;
    for (let i = 0; i < resolved; i += 1) {
      const offset = offsets[unitIndex]!;
      units.push({
        id: makeUnitId(playerIndex, unitIndex),
        owner: ownerId,
        position: [profile.center[0] + offset[0], profile.center[1] + offset[1]],
        hp: HP_BY_TYPE[unitType],
        unitType,
        cargo: 0,
      });
      unitIndex += 1;
    }
  }
  return units;
}

/** 为单个站点生成近距资源节点（4 个，chebyshev 半径 1-2，避开 Core 格）。
 *  Worker 起手即可采集，保证对局可发育。 */
function resourceNodesForSite(center: Position): readonly Position[] {
  const offsets = ringOffsets(4);
  return offsets.map((offset) => [center[0] + offset[0], center[1] + offset[1]] as Position);
}

/**
 * 构造出生场景：被测者占 SPAWN_SITES[rotatedSlot]，对手按相对环序分配
 * 站点（reference _build_live_setup）。场景 players[] 按站点序（site 0..n-1）
 * 排列——runEpisode rotateSlot=true 时 tenants 顺序与之对齐。
 *
 * 角色分配（caller 职责）：caller 用 rolesFor(numPlayers) 得到对手角色序列，
 * 据此构造 participants（每人 .role 即其角色）。buildSpawnScenario 尊重
 * participant.role——SUBJECT 用 subjectProfile；其余用 profileForRole(participant.role)。
 * 对手按 participants index 序（排除 SUBJECT）映射到相对环序站点
 * （site = (rotatedSlot + 1 + i) % n）。
 *
 * participants[mySlot] 必须是 SUBJECT；站点集取前 n 个（n ≤ 8）。
 */
export function buildSpawnScenario(
  participants: readonly SpawnParticipant[],
  mySlot: number,
  seed: number,
): SpawnScenarioResult {
  const numPlayers = participants.length;
  if (numPlayers < 2 || numPlayers > SPAWN_SITES.length) {
    throw new Error(
      `buildSpawnScenario: participants must be 2..${SPAWN_SITES.length}, got ${numPlayers}`,
    );
  }
  if (mySlot < 0 || mySlot >= numPlayers || !Number.isInteger(mySlot)) {
    throw new Error(`buildSpawnScenario: mySlot out of range [0,${numPlayers}): ${mySlot}`);
  }
  if (participants[mySlot]?.role !== "SUBJECT") {
    throw new Error(
      `buildSpawnScenario: participants[${mySlot}].role must be SUBJECT, got ${participants[mySlot]?.role}`,
    );
  }
  // 校验：非 SUBJECT 参与者的 role 必须是合法 SpawnRole
  for (let i = 0; i < numPlayers; i += 1) {
    const role = participants[i]!.role;
    if (role !== "SUBJECT") {
      const valid: SpawnRole[] = ["OLD_BALANCED", "OLD_AGGRESSIVE", "STATIC", "NEW_WEAK"];
      if (!valid.includes(role)) {
        throw new Error(`buildSpawnScenario: participants[${i}].role invalid: ${role}`);
      }
    }
  }

  const rotatedSlot = ((mySlot + seed) % numPlayers + numPlayers) % numPlayers;
  const sites = SPAWN_SITES.slice(0, numPlayers);
  const opponents: SpawnParticipant[] = participants.filter((_, index) => index !== mySlot);

  const playersBySite: SpawnParticipant[] = new Array(numPlayers);
  const profileBySite: SpawnProfile[] = new Array(numPlayers);
  playersBySite[rotatedSlot] = participants[mySlot]!;
  profileBySite[rotatedSlot] = subjectProfile(sites[rotatedSlot]!);

  for (let i = 0; i < opponents.length; i += 1) {
    const site = (rotatedSlot + 1 + i) % numPlayers;
    const opponent = opponents[i]!;
    playersBySite[site] = opponent;
    profileBySite[site] = profileForRole(opponent.role as SpawnRole, sites[site]!);
  }

  // 防御：每个 site 都已填充
  for (let site = 0; site < numPlayers; site += 1) {
    if (playersBySite[site] === undefined) {
      throw new Error(`buildSpawnScenario: site ${site} unfilled (internal error)`);
    }
  }

  const players = playersBySite.map((participant, siteIndex) => {
    const profile = profileBySite[siteIndex]!;
    const core = {
      id: makeCoreId(siteIndex),
      position: [profile.center[0], profile.center[1]] as Position,
      hp: 5,
      shield: 5,
      state: "NORMAL" as const,
      moveDirection: null,
      moveProgress: null,
      moveRequiredTicks: null,
      destination: null,
    };
    return {
      id: participant.id,
      username: participant.username ?? participant.id,
      resources: profile.res,
      core,
      units: buildUnits(participant.id, siteIndex, profile),
    };
  });

  const resources = sites.flatMap((site) => resourceNodesForSite(site));

  return {
    scenario: {
      rulesVersion: "v0.14",
      tick: 1,
      seed,
      players,
      terrain: { obstacles: [], resources, piles: [] },
      beacon: { position: [0, 0], status: "GROUND" as const, carrierId: null },
    },
    rotatedSlot,
  };
}

/** 从 participants 推导被测者 slot（SUBJECT 所在 index）。 */
export function findSubjectSlot(participants: readonly SpawnParticipant[]): number {
  const index = participants.findIndex((participant) => participant.role === "SUBJECT");
  if (index < 0) {
    throw new Error("findSubjectSlot: no SUBJECT participant found");
  }
  return index;
}
