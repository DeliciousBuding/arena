/**
 * 官方排行榜威胁画像（2026-08-07，leaderboard-intel 数据源接入）：
 * 读取协调仓 `data/leaderboard/` 下的官方排行榜快照（由
 * docs/progress/leaderboard-intel.py 定期拉取），构建 username → 威胁画像
 * 映射——"伤害高 = 猛攻蛆"分级，供策略层在攻坚时对高威胁对手"留强"
 * （提高成型门槛 + 增加守家预留，防被偷家/反打）。
 *
 * 纯只读 + 降级设计：快照缺失/解析失败返回空 Map（无威胁情报 = 历史行为
 * 零回归）；运行时绝不联网（拉取是外部计划任务职责，live loop 保持确定性）。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 排行榜类别行（官方 /api/v1/leaderboard 返回形状）。 */
export interface LeaderboardRow {
  readonly rank: number;
  readonly username: string;
  readonly score: number;
}

/** 官方排行榜快照（三类榜单）。 */
export interface LeaderboardSnapshot {
  readonly ts?: string;
  readonly beacon_ticks_held: readonly LeaderboardRow[];
  readonly damage_dealt: readonly LeaderboardRow[];
  readonly core_destruction_participations: readonly LeaderboardRow[];
}

import { tierOfDamageRank, type ThreatProfile, type ThreatTier } from "../strategies/safety-planner-config.ts";

export type { ThreatProfile, ThreatTier } from "../strategies/safety-planner-config.ts";
export { tierOfDamageRank } from "../strategies/safety-planner-config.ts";

/** 快照 → 威胁画像映射（只保留上榜用户；未上榜 = 无画像 = STANDARD 语义）。 */
export function buildThreatProfiles(snapshot: LeaderboardSnapshot): ReadonlyMap<string, ThreatProfile> {
  const profiles = new Map<string, ThreatProfile>();
  for (const row of snapshot.damage_dealt) {
    const core = snapshot.core_destruction_participations.find((c) => c.username === row.username);
    profiles.set(row.username, {
      username: row.username,
      damageScore: row.score,
      damageRank: row.rank,
      coreScore: core?.score ?? 0,
      coreRank: core?.rank ?? Number.MAX_SAFE_INTEGER,
      tier: tierOfDamageRank(row.rank),
    });
  }
  return profiles;
}

/** 读取最新排行榜快照（按文件名时间降序取 leaderboard-*.json）；目录缺失/
 *  无快照/解析失败返回 null（降级 = 无威胁情报，零回归）。 */
export function loadLatestLeaderboardSnapshot(leaderboardRoot: string): LeaderboardSnapshot | null {
  try {
    if (!statSync(leaderboardRoot, { throwIfNoEntry: false })?.isDirectory()) return null;
    const files = readdirSync(leaderboardRoot)
      .filter((name) => /^leaderboard-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(name))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const raw = JSON.parse(readFileSync(join(leaderboardRoot, files[0]!), "utf8")) as LeaderboardSnapshot;
    if (!Array.isArray(raw.damage_dealt)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 从 dataRoot 加载威胁画像（路径 = <dataRoot>/leaderboard/）；缺失返回空 Map。 */
export function loadThreatProfiles(dataRoot: string): ReadonlyMap<string, ThreatProfile> {
  const snapshot = loadLatestLeaderboardSnapshot(join(dataRoot, "leaderboard"));
  return snapshot === null ? new Map() : buildThreatProfiles(snapshot);
}

