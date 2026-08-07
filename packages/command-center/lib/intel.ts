/**
 * 联盟情报 + 快攻威胁评估：合并 4 租户 calibration 的敌人测绘（敌核心
 * owner/位置/最后目击 + 敌方活动单位数），关联官方排行榜威胁画像
 * （tier/伤害排名），输出 raid-risk 分级与信标载者推断；并构建"遭遇玩家"
 * 索引供排行榜标注。纯只读（30s 缓存）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TENANTS, calibrationDir, chebyshev, latestRunDir, listCases, manhattan, parseTick, type Position } from "./fs-jsonl.ts";
import { loadBeaconTrail } from "./trails.ts";
import { loadLeaderboardIntel } from "./leaderboard.ts";

/** 快攻威胁评估（raid-risk，镜像 arena-agent/src/domain/raid-risk.ts 常量与级联）：
 * 用户裁决"别人可以只派一些人来打"——威胁不能只看排行榜伤害：
 *  - 实测敌军战斗单位（Vanguard/Ranger）进入我方核心 18 格警戒圈：≥3 = CRITICAL、
 *    ≥1 = HIGH（小股快攻已到门口）；
 *  - 敌核心 ≤24 格 = HIGH、≤32 = MEDIUM（STANDARD 低伤害也成立——随时可派人）；
 *  - 排行榜 tier 只做先验加成（高伤害对手中程/远程升级），不作防御门槛；
 *  - 陈旧目击降一级（记忆老化威胁不确定，但不掉 NONE）。 */
const RAID_UNIT_WATCH_RADIUS = 18;
const RAID_CORE_RADIUS = 24;
const RAID_PARTY_SIZE = 3;
/** 面板"近期快攻活动"窗口（tick）：我方核心警戒圈内目击到敌军战斗单位距今
 *  不超过该窗口才算"活动中的快攻"（防 30-run 扫描把上千 tick 前的旧目击
 *  误报为 CRITICAL——t4 实证：659-1372 tick 前的单位被误报 4 个 CRITICAL）。 */
const RAID_ACTIVITY_WINDOW = 300;
function assessRaidRisk(input: { enemyCoreDistance: number; combatUnitsNear: number; tier: string; freshSighting: boolean }): { tier: string; reason: string } {
  const { enemyCoreDistance, combatUnitsNear, tier, freshSighting } = input;
  let tierRisk: string;
  let reason: string;
  if (combatUnitsNear >= RAID_PARTY_SIZE) {
    tierRisk = "CRITICAL";
    reason = `raid_party: ${combatUnitsNear} enemy combat units within ${RAID_UNIT_WATCH_RADIUS} of our core`;
  } else if (combatUnitsNear >= 1) {
    tierRisk = "HIGH";
    reason = `raid_scout: ${combatUnitsNear} enemy combat unit(s) within ${RAID_UNIT_WATCH_RADIUS} of our core`;
  } else if (enemyCoreDistance <= 8) {
    tierRisk = "CRITICAL";
    reason = `core_adjacent: enemy core ${enemyCoreDistance} cells away`;
  } else if (enemyCoreDistance <= RAID_CORE_RADIUS) {
    tierRisk = "HIGH";
    reason = `core_close: enemy core ${enemyCoreDistance} cells away (within ${RAID_CORE_RADIUS})`;
  } else if (enemyCoreDistance <= 32) {
    tierRisk = "MEDIUM";
    reason = `core_medium: enemy core ${enemyCoreDistance} cells away`;
  } else if (tier !== "STANDARD" && enemyCoreDistance <= 48) {
    tierRisk = "MEDIUM";
    reason = `aggressor_medium: ${tier} core ${enemyCoreDistance} cells away`;
  } else if (enemyCoreDistance <= 64) {
    tierRisk = "LOW";
    reason = `core_far: enemy core ${enemyCoreDistance} cells away`;
  } else if (tier !== "STANDARD" && enemyCoreDistance <= 96) {
    tierRisk = "LOW";
    reason = `aggressor_far: ${tier} core ${enemyCoreDistance} cells away`;
  } else {
    return { tier: "NONE", reason: "out_of_range" };
  }
  if (!freshSighting && tierRisk !== "LOW") {
    const downgraded = tierRisk === "CRITICAL" ? "HIGH" : tierRisk === "HIGH" ? "MEDIUM" : "LOW";
    return { tier: downgraded, reason: `${reason} (stale sighting)` };
  }
  return { tier: tierRisk, reason };
}

const RUN_SCAN = 30; // 联盟情报扫描 run 数（平衡覆盖与性能）
const INTEL_CASE_LIMIT = 24; // 联盟情报每个 run 取最近 N 个 case（与测绘一致，保证核心目击不丢）

export interface IntelEnemy {
  username: string;
  position: Position;
  lastSeenTick: number;
  tier: string;
  damageRank: number | null;
  distanceToFriendlyCore: number | null;
  raidRisk: string;
  raidReason: string;
  raidActivityAge: number | null;
  tenant: string;
}
export interface IntelPayload {
  generatedAt: string;
  tenants: Array<Record<string, unknown>>;
  enemies: IntelEnemy[];
  totalEnemyCores: number;
  beacons: Array<Record<string, unknown>>;
}

/** 联盟情报缓存（30s，与排行榜缓存一致——面板轮询不重复扫描 calibration）。 */
let intelCache: { at: number; data: IntelPayload } = { at: 0, data: { generatedAt: "", tenants: [], enemies: [], totalEnemyCores: 0, beacons: [] } };
export function loadAllianceIntel(): IntelPayload {
  const now = Date.now();
  if (intelCache.data.generatedAt !== "" && now - intelCache.at < 30_000) return intelCache.data;
  const intel: IntelPayload = { generatedAt: new Date().toISOString(), tenants: [], enemies: [], totalEnemyCores: 0, beacons: [] };
  const lb = loadLeaderboardIntel();
  for (const tenant of TENANTS) {
    const runDir = latestRunDir(tenant);
    if (runDir === null) { intel.tenants.push({ tenant, runId: null, enemyCores: [], enemyUnits: 0 }); continue; }
    // 扫最近 RUN_SCAN 个 run（历史敌核心目击在旧 run——enemy-intel 同口径），
    // 每个 run 取 INTEL_CASE_LIMIT 个 case（核心是慢速目标，8 个足够捕获目击）：
    const runDirs = readdirSync(calibrationDir(tenant), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => {
        const ta = listCases(tenant, a).map(parseTick).reduce((x, y) => Math.max(x, y), 0);
        const tb = listCases(tenant, b).map(parseTick).reduce((x, y) => Math.max(x, y), 0);
        return tb - ta;
      })
      .slice(0, RUN_SCAN);
    const seenCores = new Map<string, { position: Position; tick: number }>(); // owner -> { position, tick }
    let enemyUnitSightings = 0; // naive 目击条数（审计口径，不做兵力展示）
    let ourCore: Position | null = null; // 我方（controlled）Core 位置——快攻威胁距离基准
    let ourCoreTick = -1; // ourCore 对应的目击 tick（防旧 run 覆盖新位置）
    const combatNearCore = new Map<string, number>(); // 我方核心 18 格警戒圈内的敌军战斗单位 id -> 最近目击 tick
    const enemyUnitById = new Map<string, { unitType: string; position: Position; tick: number }>(); // 敌战斗单位最后目击记忆（面板敌情记忆层）
    let latestTick = 0; // 本租户扫描窗口内的最高 tick（新鲜度基准）
    for (const rd of runDirs) {
      const caseFiles = listCases(tenant, rd).slice(-INTEL_CASE_LIMIT);
      for (const file of caseFiles) {
        const tick = parseTick(file);
        let raw: { before?: { state?: { objects?: Array<Record<string, unknown>> } } } | null = null;
        try { raw = JSON.parse(readFileSync(join(calibrationDir(tenant), rd, "cases", file), "utf8")); } catch { continue; }
        const state = raw?.before?.state;
        if (!state?.objects) continue;
        if (tick > latestTick) latestTick = tick;
        for (const obj of state.objects) {
          if (obj.kind === "CORE" && obj.controlled) {
            // 只接受更新鲜的核心位置——runDirs 按最新优先迭代但旧 run 会
            // 覆盖 ourCore，核心迁移后（如 t4 (98,84)→(434,-149)）距离/威胁
            // 会用旧位置计算（bug，2026-08-07 实测面板显示旧核心）。
            if (ourCoreTick < tick) {
              ourCore = obj.position as Position;
              ourCoreTick = tick;
            }
          } else if (obj.kind === "CORE" && !obj.controlled && obj.owner_username) {
            const prev = seenCores.get(obj.owner_username as string);
            if (prev === undefined || tick > prev.tick) seenCores.set(obj.owner_username as string, { position: obj.position as Position, tick });
          } else if (obj.kind === "UNIT" && !obj.controlled && obj.unit_type !== "WORKER") {
            enemyUnitSightings += 1; // naive：同 id 多 tick 目击会重复放大（spec §1.1），仅审计
            if (ourCore !== null && manhattan(obj.position as Position, ourCore) <= RAID_UNIT_WATCH_RADIUS) {
              const prev = combatNearCore.get(obj.id as string);
              if (prev === undefined || tick > prev) combatNearCore.set(obj.id as string, tick);
            }
            // 记忆层：任何敌战斗单位的最后目击（id 级去重，供面板画半透明敌情标记）
            const prevUnit = enemyUnitById.get(obj.id as string);
            if (prevUnit === undefined || tick > prevUnit.tick) {
              enemyUnitById.set(obj.id as string, { unitType: (obj.unit_type as string) ?? "VANGUARD", position: obj.position as Position, tick });
            }
          }
        }
      }
    }
    // 近期快攻活动：警戒圈内目击距今 ≤ RAID_ACTIVITY_WINDOW 才算"活动中的快攻"
    // （t4 实证：旧目击 659+ tick 会被误报 CRITICAL——仅核心距离决定风险）。
    const recentCombat = [...combatNearCore.entries()]
      .filter(([, t]) => latestTick - t <= RAID_ACTIVITY_WINDOW)
      .map(([id, t]) => ({ id, age: latestTick - t }));
    const recentCount = recentCombat.length;
    const maxRecentAge = recentCount > 0 ? Math.max(...recentCombat.map((c) => c.age)) : null;
    const enemyCores = [...seenCores.entries()].map(([username, info]): Omit<IntelEnemy, "tenant"> => {
      const profile = lb?.profiles?.find((p) => p.username === username);
      // 快攻威胁（raid-risk）：距离 = 敌核心到我们 Core 的 Chebyshev；实测接近
      // 单位 = 我方 18 格警戒圈内**近期**（≤300 tick）目击到的敌军战斗单位；
      // 敌核心目击 >2000 tick（CORE_HUNT_STICKY_TICKS 同口径）视为陈旧降级。
      const distance = ourCore === null ? null : chebyshev(info.position, ourCore);
      const raid = distance === null
        ? { tier: "UNKNOWN", reason: "no_friendly_core" }
        : assessRaidRisk({
            enemyCoreDistance: distance,
            combatUnitsNear: recentCount,
            tier: profile?.tier ?? "STANDARD",
            freshSighting: latestTick - info.tick <= 2000,
          });
      return {
        username,
        position: info.position,
        lastSeenTick: info.tick,
        tier: profile?.tier ?? "STANDARD",
        damageRank: profile?.rank ?? null,
        distanceToFriendlyCore: distance,
        raidRisk: raid.tier,
        raidReason: raid.reason,
        raidActivityAge: maxRecentAge,
      };
    }).sort((a, b) => (b.lastSeenTick - a.lastSeenTick) || a.username.localeCompare(b.username));
    const enemyUnitMemory = [...enemyUnitById.entries()]
      .map(([id, u]) => ({ id, unitType: u.unitType, position: u.position, lastSeenTick: u.tick }))
      .sort((a, b) => b.lastSeenTick - a.lastSeenTick)
      .slice(0, 100); // 上限 100：面板敌情记忆层（单位是动态目标，只取最近目击）
    intel.tenants.push({
      tenant,
      runId: runDir,
      enemyCores,
      // 2026-08-08 alliance-model：enemyUnits 改为 id 级去重 unique 战斗单位数
      // （enemyUnitById.size）；naive 条数保留 enemyUnitSightings 供审计。
      // 旧 `enemyUnits += 1` 会重复累加——离线实证 494 naive vs 44 unique
      // （放大 11.23x），"83 敌单位"即此类假象。
      enemyUnits: enemyUnitById.size,
      enemyUnitSightings,
      enemyUnitMemory,
      ourCore,
      combatUnitsNearCore: recentCount,
      raidActivityAge: maxRecentAge,
    });
    intel.enemies.push(...enemyCores.map((e) => ({ ...e, tenant })));
    intel.totalEnemyCores += enemyCores.length;
  }
  intel.enemies.sort((a, b) => (b.lastSeenTick - a.lastSeenTick) || a.username.localeCompare(b.username));
  // 信标状态 + 载者推断：轨迹最近点 = 当前位置；近 12 tick 内移动过
  // = 载者活动（敌方核心携带/漂移）；距信标 ≤30 的已知敌核心 = 载者猜测（如 jerkman）。
  intel.beacons = [];
  for (const t of intel.tenants) {
    if (!t.runId) continue;
    const trail = loadBeaconTrail(t.tenant as string);
    if (!trail.length) continue;
    const last = trail[trail.length - 1];
    const prev = trail.length >= 2 ? trail[trail.length - 2] : null;
    const moving = prev !== null && (last.tick - prev.tick) <= 12 && (last.x !== prev.x || last.y !== prev.y);
    let carrierGuess: string | null = null;
    let carrierDist: number | null = null;
    let best = 31;
    for (const e of intel.enemies) {
      const d = Math.max(Math.abs(e.position[0] - last.x), Math.abs(e.position[1] - last.y));
      if (d < best) { best = d; carrierGuess = e.username; }
    }
    if (best <= 30) carrierDist = best;
    intel.beacons.push({ tenant: t.tenant, x: last.x, y: last.y, tick: last.tick, moving, carrierGuess, carrierDist });
  }
  intelCache = { at: Date.now(), data: intel };
  return intel;
}

export interface EncounterEntry {
  tenant: string;
  lastSeenTick: number | null;
  distanceToFriendlyCore: number | null;
  raidRisk: string | null;
}

/** 遭遇玩家索引：username -> 目击详情（由 /api/intel 的联盟敌人测绘构建，30s 缓存），
 *  供排行榜标注"遇到过"的玩家（哪几个租户目击过、最后目击 tick、距离、快攻威胁）。 */
export function buildEncounteredIndex(): Map<string, EncounterEntry[]> {
  const alliance = loadAllianceIntel();
  const index = new Map<string, EncounterEntry[]>(); // username -> [{ tenant, lastSeenTick, distanceToFriendlyCore, raidRisk }]
  for (const enemy of alliance?.enemies ?? []) {
    if (!enemy?.username) continue;
    const list = index.get(enemy.username) ?? [];
    if (!list.some((e) => e.tenant === enemy.tenant)) {
      list.push({
        tenant: enemy.tenant,
        lastSeenTick: enemy.lastSeenTick ?? null,
        distanceToFriendlyCore: enemy.distanceToFriendlyCore ?? null,
        raidRisk: enemy.raidRisk ?? null,
      });
    }
    index.set(enemy.username, list);
  }
  return index;
}
