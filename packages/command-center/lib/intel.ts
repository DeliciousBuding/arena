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
import { loadTenantSurveyCached } from "./survey-cache.ts";
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
/** 贴脸敌核记忆合并半径（2026-08-08，intel 补全）：calibration 只扫近期
 *  run——survey 库 core_hunts 里贴脸但久未重新目击的敌核会漏报
 *  （t3 实证 969510853@[-527,258] 距核 3 格、euler_ghost@[-534,278] 20 格
 *  未进威胁列表，仅 clucky@17 报了 HIGH）。合并 survey 记忆：距我方核
 *  不超过 RAID_CORE_RADIUS 且目击距今不超过 SURVEY_MEMORY_WINDOW → 补进列表，
 *  陈旧降级（raid-risk 同口径）。 */
const SURVEY_MEMORY_RADIUS = 24;
const SURVEY_MEMORY_WINDOW = 10_000; // 联盟情报扫描 run 数（平衡覆盖与性能）
const INTEL_CASE_LIMIT = 8; // 联盟情报每个 run 取最近 N 个 case（核心是慢速目标，8 个足够捕获目击——2026-08-08 扫描减负 24→8，720→240 文件）

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
let intelRefreshing = false; // 后台刷新防抖：缓存过期只触发一次重扫

/**
 * 联盟情报读取（2026-08-08 stale-while-revalidate）：
 *  - 30s 内新鲜：直接返回缓存；
 *  - 过期但已有缓存：同步返回旧数据（stale），setTimeout 后台重扫一次
 *    （用户实测 leaderboard/intel 首开 3.4s——intel 冷扫描同步阻塞事件循环，
 *    前端所有轮询排队即"卡"。改为 stale 返回后请求永远毫秒级，重扫在后台，
 *    下一次轮询即新数据）；
 *  - 无缓存（首扫/兜底）：同步扫描一次（启动预热已 setImmediate 覆盖，极少触发）。
 */
export function loadAllianceIntel(): IntelPayload {
  const now = Date.now();
  if (intelCache.data.generatedAt !== "" && now - intelCache.at < 30_000) return intelCache.data;
  if (intelCache.data.generatedAt !== "" && !intelRefreshing) {
    intelRefreshing = true;
    setTimeout(() => {
      try { scanAllianceIntelNow(); } finally { intelRefreshing = false; }
    }, 0);
    return intelCache.data;
  }
  return scanAllianceIntelNow();
}
/** intel 全量扫描（从 calibration 读，纯同步；仅 loadAllianceIntel 内部调用）。 */
function scanAllianceIntelNow(): IntelPayload {
  const intel: IntelPayload = { generatedAt: new Date().toISOString(), tenants: [], enemies: [], totalEnemyCores: 0, beacons: [] };
  const lb = loadLeaderboardIntel();
  for (const tenant of TENANTS) {
    const runDir = latestRunDir(tenant);
    if (runDir === null) { intel.tenants.push({ tenant, runId: null, enemyCores: [], enemyUnits: 0 }); continue; }
    // 扫最近 RUN_SCAN 个 run（历史敌核心目击在旧 run——enemy-intel 同口径），
    // 每个 run 取 INTEL_CASE_LIMIT 个 case（核心是慢速目标，8 个足够捕获目击）：
    // 2026-08-08 目录 IO 去重：旧实现 sort 里对每个 run 重复
    // listCases(readdir) + parseTick（30 run × 2 次 readdir），扫描循环又 readdir
    // 一次。改为一次性缓存每个 run 的 case 列表与最高 tick，排序与扫描共用。
    const runNames = readdirSync(calibrationDir(tenant), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const runCaseCache = new Map<string, string[]>();
    const runMaxTick = new Map<string, number>();
    for (const rn of runNames) {
      const cases = listCases(tenant, rn);
      runCaseCache.set(rn, cases);
      let mx = -1;
      for (const f of cases) { const t = parseTick(f); if (t > mx) mx = t; }
      runMaxTick.set(rn, mx);
    }
    const runDirs = runNames
      .sort((a, b) => (runMaxTick.get(b) ?? -1) - (runMaxTick.get(a) ?? -1))
      .slice(0, RUN_SCAN);
    const seenCores = new Map<string, { position: Position; tick: number }>(); // owner -> { position, tick }
    let enemyUnitSightings = 0; // naive 目击条数（审计口径，不做兵力展示）
    let ourCore: Position | null = null; // 我方（controlled）Core 位置——快攻威胁距离基准
    let ourCoreTick = -1; // ourCore 对应的目击 tick（防旧 run 覆盖新位置）
    const combatNearCore = new Map<string, number>(); // 我方核心 18 格警戒圈内的敌军战斗单位 id -> 最近目击 tick
    const enemyUnitById = new Map<string, { unitType: string; position: Position; tick: number }>(); // 敌战斗单位最后目击记忆（面板敌情记忆层）
    let latestTick = 0; // 本租户扫描窗口内的最高 tick（新鲜度基准）
    for (const rd of runDirs) {
      const caseFiles = (runCaseCache.get(rd) ?? []).slice(-INTEL_CASE_LIMIT);
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
    // 贴脸敌核记忆合并（2026-08-08，intel 补全）：survey 库 core_hunts 是跨 run
    // 累积测绘（core-threat-watch/raid-risk 决策同源），calibration 扫描会漏掉
    // 近期未重新目击但贴脸的敌核——t3 实证 969510853@3 格 / euler_ghost@20 格
    // 未进威胁列表。距我方核不超过 SURVEY_MEMORY_RADIUS 且目击距今不超过
    // SURVEY_MEMORY_WINDOW 的记忆补进 seenCores（owner 去重，取 survey 最新 tick），
    // 陈旧目击由 assessRaidRisk 的 stale 降级处理（不误报 CRITICAL）。
    const survey = loadTenantSurveyCached(tenant).survey;
    if (survey?.coreCells && ourCore !== null) {
      for (const mem of survey.coreCells) {
        const owner = typeof mem.owner === "string" && mem.owner.length > 0 ? String(mem.owner) : null;
        if (owner === null) continue;
        if (seenCores.has(owner)) continue;
        const pos = [Number(mem.x), Number(mem.y)] as Position;
        if (!Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) continue;
        if (chebyshev(pos, ourCore) > SURVEY_MEMORY_RADIUS) continue;
        const tick = Number(mem.tick ?? 0);
        if (!Number.isFinite(tick) || latestTick - tick > SURVEY_MEMORY_WINDOW) continue;
        seenCores.set(owner, { position: pos, tick });
      }
    }
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
let encounteredCache: { at: number; data: Map<string, EncounterEntry[]> } = { at: 0, data: new Map() };
export function buildEncounteredIndex(): Map<string, EncounterEntry[]> {
  // 独立 30s 缓存（2026-08-08）：/api/leaderboard 每轮询都重建 Map（内部
  // 再触发 intel 读取）——缓存过期时会把 2.7s 冷扫描拉进 leaderboard 请求
  // 路径（实测首开 3.4s）。改为独立缓存，leaderboard 只读缓存 Map，永不触发重扫。
  const now = Date.now();
  if (now - encounteredCache.at < 30_000) return encounteredCache.data;
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
  encounteredCache = { at: Date.now(), data: index };
  return index;
}
