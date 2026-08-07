/**
 * 排行榜威胁情报：读取 data/leaderboard/ 最新官方快照（leaderboard-intel.py
 * 拉取），返回三榜 + 威胁分级（伤害 top10 = ELITE_AGGRESSOR 猛攻蛆头子 /
 * top30 = AGGRESSOR）；另从各租户 calibration 的受控 CORE 提取我方官方
 * 账号名。纯只读。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, TENANTS, calibrationDir, latestRunDir, listCases, parseTick } from "./fs-jsonl.ts";

export interface LeaderboardProfile {
  username: string;
  rank: number;
  damage: number;
  tier: string;
}
export interface LeaderboardIntel {
  generatedAt: string;
  snapshot: string;
  beacon_ticks_held: Array<{ rank: number; username: string; score: number }>;
  damage_dealt: Array<{ rank: number; username: string; score: number }>;
  core_destruction_participations: Array<{ rank: number; username: string; score: number }>;
  profiles: LeaderboardProfile[];
}

export function loadLeaderboardIntel(): LeaderboardIntel | null {
  const dir = join(DATA_ROOT, "leaderboard");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => /^leaderboard-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  try {
    const raw = JSON.parse(readFileSync(join(dir, files[0]), "utf8")) as {
      damage_dealt?: Array<{ rank: number; username: string; score: number }>;
      beacon_ticks_held?: Array<{ rank: number; username: string; score: number }>;
      core_destruction_participations?: Array<{ rank: number; username: string; score: number }>;
    };
    if (!Array.isArray(raw.damage_dealt)) return null;
    const tierOf = (rank: number): string => (rank >= 1 && rank <= 10 ? "ELITE_AGGRESSOR" : rank <= 30 ? "AGGRESSOR" : "STANDARD");
    const profiles = raw.damage_dealt.map((row) => ({
      username: row.username,
      rank: row.rank,
      damage: row.score,
      tier: tierOf(row.rank),
    }));
    return {
      generatedAt: new Date().toISOString(),
      snapshot: files[0],
      beacon_ticks_held: raw.beacon_ticks_held ?? [],
      damage_dealt: raw.damage_dealt ?? [],
      core_destruction_participations: raw.core_destruction_participations ?? [],
      profiles,
    };
  } catch {
    return null;
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
