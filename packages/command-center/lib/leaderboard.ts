/**
 * 排行榜威胁情报：读取 data/leaderboard/ 最新官方快照（可手动 leaderboard-intel.py
 * 拉取，或面板服务端惰性拉取——2026-08-08 用户明确不要计划任务，改为请求驱动），
 * 返回三榜 + 威胁分级（伤害 top10 = ELITE_AGGRESSOR 猛攻蛆头子 / top30 =
 * AGGRESSOR）；另从各租户 calibration 的受控 CORE 提取我方官方账号名。
 *
 * 拉取策略（无计划任务/定时任务）：
 *  - 面板启动预热 + /api/leaderboard 请求时检查：快照 stale（>15min）且距上次
 *    拉取 ≥10min → 后台异步 fetch 官方一次（不阻塞请求，stale-while-revalidate）。
 *  - 也可手动跑 docs/progress/leaderboard-intel.py，或 POST /api/leaderboard/refresh。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, TENANTS, calibrationDir, latestRunDir, listCases, parseTick } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";

export interface LeaderboardProfile {
  username: string;
  rank: number;
  damage: number;
  tier: string;
}
export interface LeaderboardIntel {
  generatedAt: string;
  snapshot: string;
  /** 快照文件修改时间（ISO）。 */
  snapshotAt: string;
  /** 距快照 mtime 的秒数（每次读取动态计算，不随缓存陈旧）。 */
  ageSeconds: number;
  /** 快照是否过旧（>15 分钟，官方排行榜 ~15min 一档）——提示手动/惰性刷新。 */
  stale: boolean;
  beacon_ticks_held: Array<{ rank: number; username: string; score: number }>;
  damage_dealt: Array<{ rank: number; username: string; score: number }>;
  core_destruction_participations: Array<{ rank: number; username: string; score: number }>;
  profiles: LeaderboardProfile[];
}

type LeaderboardIntelCached = LeaderboardIntel & { snapshotAtMs: number };
const leaderboardCache = new TtlCache<LeaderboardIntelCached>(30_000); // 快照 15 分钟更新一次，30s 缓存足够
/** 快照陈旧阈值（秒）：官方排行榜 ~15min 一档，超过视为需要刷新。 */
const SNAPSHOT_STALE_SECONDS = 15 * 60;
/** 两次惰性拉取最小间隔（毫秒）：官方 15min 一档，10min 足够且不频繁打扰官方 API。 */
const FETCH_MIN_INTERVAL_MS = 10 * 60_000;

const OFFICIAL_API = "https://api.arenahero.io/api/v1/leaderboard";
const CATEGORIES = ["beacon_ticks_held", "damage_dealt", "core_destruction_participations"] as const;
const tierOf = (rank: number): string => (rank >= 1 && rank <= 10 ? "ELITE_AGGRESSOR" : rank <= 30 ? "AGGRESSOR" : "STANDARD");

interface RawLeaderboard {
  beacon_ticks_held?: Array<{ rank: number; username: string; score: number }>;
  damage_dealt?: Array<{ rank: number; username: string; score: number }>;
  core_destruction_participations?: Array<{ rank: number; username: string; score: number }>;
}

/** raw 快照 → 内部缓存对象（load 与 refresh 共用，避免逻辑漂移）。 */
function buildIntel(raw: RawLeaderboard, snapshotName: string, snapshotAtMs: number): LeaderboardIntelCached {
  const profiles = (raw.damage_dealt ?? []).map((row) => ({
    username: row.username,
    rank: row.rank,
    damage: row.score,
    tier: tierOf(row.rank),
  }));
  const ageSeconds = Math.max(0, Math.round((Date.now() - snapshotAtMs) / 1000));
  return {
    generatedAt: new Date().toISOString(),
    snapshot: snapshotName,
    snapshotAt: new Date(snapshotAtMs).toISOString(),
    ageSeconds,
    stale: ageSeconds > SNAPSHOT_STALE_SECONDS,
    beacon_ticks_held: raw.beacon_ticks_held ?? [],
    damage_dealt: raw.damage_dealt ?? [],
    core_destruction_participations: raw.core_destruction_participations ?? [],
    profiles,
    snapshotAtMs,
  };
}

export function loadLeaderboardIntel(): LeaderboardIntel | null {
  const now = Date.now();
  const hit = leaderboardCache.get("latest");
  if (hit !== undefined) {
    // 新鲜度动态计算（2026-08-08）：缓存对象不带 age，每次读取按快照 mtime 现算——
    // 前端可显示"快照 N 分钟前"并对陈旧快照提示刷新。
    const ageSeconds = Math.max(0, Math.round((now - hit.snapshotAtMs) / 1000));
    return { ...hit, ageSeconds, stale: ageSeconds > SNAPSHOT_STALE_SECONDS, snapshotAt: new Date(hit.snapshotAtMs).toISOString() };
  }
  const dir = join(DATA_ROOT, "leaderboard");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => /^leaderboard-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  try {
    const raw = JSON.parse(readFileSync(join(dir, files[0]), "utf8")) as RawLeaderboard;
    if (!Array.isArray(raw.damage_dealt)) return null;
    const st = statSync(join(dir, files[0]));
    const result = buildIntel(raw, files[0], st.mtimeMs);
    leaderboardCache.set("latest", result);
    return result;
  } catch {
    return null;
  }
}

/** 上次主动拉取官方时间戳（惰性刷新防抖：间隔内不重复拉）。 */
let lastFetchAt = 0;
let refreshing = false; // 并发防抖：同一时刻只允许一个后台拉取

/**
 * 惰性刷新检查（2026-08-08，请求驱动，无计划任务）：调用方（/api/leaderboard）
 * 在请求时检查——快照 stale 且距上次拉取 ≥10min → 后台异步拉一次（不 await、
 * 不阻塞请求，返回旧数据；下一次请求即新快照）。用户明确不要计划任务/定时任务，
 * 排行榜数据由面板常驻服务维护，不依赖系统调度。
 */
export function maybeRefreshLeaderboardLazy(): void {
  const lb = loadLeaderboardIntel();
  if (!lb || !lb.stale) return;
  const now = Date.now();
  if (now - lastFetchAt < FETCH_MIN_INTERVAL_MS || refreshing) return;
  lastFetchAt = now;
  refreshing = true;
  void refreshLeaderboardFromOfficial().finally(() => { refreshing = false; });
}

/** 拉取官方排行榜一次：写快照 JSON + 追加 history.jsonl（格式与
 *  leaderboard-intel.py 一致），并刷新内存缓存。POST /api/leaderboard/refresh
 *  或启动预热调用；失败返回错误字符串（调用方记录，不抛）。 */
export async function refreshLeaderboardFromOfficial(): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(OFFICIAL_API, {
      headers: { accept: "application/json", "user-agent": "arena-ts leaderboard-intel/1.0", referer: "https://app.arenahero.io/" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return { ok: false, error: "HTTP " + resp.status };
    const raw = (await resp.json()) as RawLeaderboard;
    for (const cat of CATEGORIES) {
      if (!Array.isArray(raw[cat])) return { ok: false, error: "leaderboard missing category " + cat };
    }
    const dir = join(DATA_ROOT, "leaderboard");
    mkdirSync(dir, { recursive: true });
    const ts = new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");
    const snapName = "leaderboard-" + ts.getUTCFullYear() + "-" + pad(ts.getUTCMonth() + 1) + "-" + pad(ts.getUTCDate()) + "-" +
      pad(ts.getUTCHours()) + "-" + pad(ts.getUTCMinutes()) + "-" + pad(ts.getUTCSeconds()) + ".json";
    writeFileSync(join(dir, snapName), JSON.stringify(raw, null, 2), "utf8");
    const tsUTC = ts.toISOString().replace(/\.\d{3}Z$/, "Z");
    const row: Record<string, unknown> = { ts: tsUTC, epoch_s: Math.floor(ts.getTime() / 1000) };
    for (const cat of CATEGORIES) row[cat] = raw[cat];
    appendFileSync(join(dir, "history.jsonl"), JSON.stringify(row) + "\n", "utf8");
    const result = buildIntel(raw, snapName, ts.getTime());
    leaderboardCache.set("latest", result);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** 我方 4 租户的官方账号名：从各租户最新 calibration 的受控 CORE（controlled=true）
 *  owner_username 提取（账号不变，60s 缓存足够）。排行榜按 username 标注"我们"。 */
let oursCache: { at: number; data: Array<{ tenant: string; username: string }> } = { at: 0, data: [] };
export function loadOurUsernames(): Array<{ tenant: string; username: string }> {
  const now = Date.now();
  if (oursCache.data.length > 0 && now - oursCache.at < 60_000) return oursCache.data;
  const ours: Array<{ tenant: string; username: string }> = [];
  for (const tenant of TENANTS) {
    const runDir = latestRunDir(tenant);
    if (runDir === null) continue;
    const caseFiles = listCases(tenant, runDir).slice(-24);
    let username: string | null = null;
    let bestTick = -1;
    for (const file of caseFiles) {
      const tick = parseTick(file);
      let raw: { before?: { state?: { objects?: Array<Record<string, unknown>> } }; after?: { state?: { objects?: Array<Record<string, unknown>> } } } | null = null;
      try { raw = JSON.parse(readFileSync(join(calibrationDir(tenant), runDir, "cases", file), "utf8")); } catch { continue; }
      for (const state of [raw?.before?.state, raw?.after?.state]) {
        if (!state?.objects) continue;
        for (const obj of state.objects) {
          if (obj?.kind === "CORE" && obj.controlled === true && typeof obj.owner_username === "string" && obj.owner_username && tick >= bestTick) {
            bestTick = tick;
            username = obj.owner_username;
          }
        }
      }
    }
    if (username) ours.push({ tenant, username });
  }
  oursCache = { at: now, data: ours };
  return ours;
}