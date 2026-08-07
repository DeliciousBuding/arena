/** 官方排行榜威胁画像单元测试（2026-08-07）：分级边界、快照解析、缺失降级。
 *  数据源 = docs/progress/leaderboard-intel.py 拉取的官方排行榜快照。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildThreatProfiles,
  loadLatestLeaderboardSnapshot,
  loadThreatProfiles,
  threatProfilesEqual,
  tierOfDamageRank,
  type LeaderboardSnapshot,
} from "../src/app/official-intel.ts";

const SNAPSHOT: LeaderboardSnapshot = {
  beacon_ticks_held: [{ rank: 3, username: "jerkman", score: 9399 }],
  damage_dealt: [
    { rank: 5, username: "jerkman", score: 1765 },
    { rank: 25, username: "mid_attacker", score: 600 },
    { rank: 99, username: "casual", score: 120 },
  ],
  core_destruction_participations: [{ rank: 9, username: "jerkman", score: 70 }],
};

test("tierOfDamageRank：1-10 = ELITE_AGGRESSOR，11-30 = AGGRESSOR，其余 STANDARD", () => {
  assert.equal(tierOfDamageRank(1), "ELITE_AGGRESSOR");
  assert.equal(tierOfDamageRank(5), "ELITE_AGGRESSOR");
  assert.equal(tierOfDamageRank(10), "ELITE_AGGRESSOR");
  assert.equal(tierOfDamageRank(11), "AGGRESSOR");
  assert.equal(tierOfDamageRank(30), "AGGRESSOR");
  assert.equal(tierOfDamageRank(31), "STANDARD");
  assert.equal(tierOfDamageRank(99), "STANDARD");
});

test("buildThreatProfiles：按 damage 行构建，合并 core 参与信息，tier 正确", () => {
  const profiles = buildThreatProfiles(SNAPSHOT);
  assert.equal(profiles.size, 3);
  const jerk = profiles.get("jerkman");
  assert.ok(jerk !== undefined);
  assert.equal(jerk.damageScore, 1765);
  assert.equal(jerk.damageRank, 5);
  assert.equal(jerk.coreScore, 70);
  assert.equal(jerk.coreRank, 9);
  assert.equal(jerk.tier, "ELITE_AGGRESSOR");
  assert.equal(profiles.get("mid_attacker")!.tier, "AGGRESSOR");
  assert.equal(profiles.get("casual")!.tier, "STANDARD");
});

test("buildThreatProfiles：未上 core 榜的玩家 core 信息缺省为空", () => {
  const profiles = buildThreatProfiles({
    beacon_ticks_held: [],
    damage_dealt: [{ rank: 2, username: "only_damage", score: 2000 }],
    core_destruction_participations: [],
  });
  const p = profiles.get("only_damage")!;
  assert.equal(p.coreScore, 0);
  assert.equal(p.coreRank, Number.MAX_SAFE_INTEGER);
});

test("loadLatestLeaderboardSnapshot：取文件名时间最新的快照", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-lb-"));
  try {
    writeFileSync(
      join(dir, "leaderboard-2026-08-07-13-00-00.json"),
      JSON.stringify({ damage_dealt: [{ rank: 1, username: "old", score: 1 }] }),
    );
    writeFileSync(
      join(dir, "leaderboard-2026-08-07-14-00-00.json"),
      JSON.stringify(SNAPSHOT),
    );
    const snap = loadLatestLeaderboardSnapshot(dir);
    assert.ok(snap !== null);
    assert.equal(snap.damage_dealt[0]!.username, "jerkman");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLatestLeaderboardSnapshot / loadThreatProfiles：目录缺失 → 降级 null / 空 Map", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-lb-empty-"));
  try {
    assert.equal(loadLatestLeaderboardSnapshot(join(dir, "missing")), null);
    assert.equal(loadThreatProfiles(dir).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadThreatProfiles：dataRoot/leaderboard 快照 → 非空画像", () => {
  const root = mkdtempSync(join(tmpdir(), "arena-lb-root-"));
  try {
    mkdirSync(join(root, "leaderboard"));
    writeFileSync(
      join(root, "leaderboard", "leaderboard-2026-08-07-14-00-00.json"),
      JSON.stringify(SNAPSHOT),
    );
    const profiles = loadThreatProfiles(root);
    assert.equal(profiles.get("jerkman")!.tier, "ELITE_AGGRESSOR");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("threatProfilesEqual：内容全等 true；任一字段变化/掉榜/新增 false", () => {
  const a = buildThreatProfiles(SNAPSHOT);
  const b = buildThreatProfiles(SNAPSHOT);
  assert.equal(threatProfilesEqual(a, b), true, "同一快照内容全等");
  // 伤害分变化
  const changedScore = buildThreatProfiles({
    ...SNAPSHOT,
    damage_dealt: SNAPSHOT.damage_dealt.map((r, i) => (i === 0 ? { ...r, score: r.score + 1 } : r)),
  });
  assert.equal(threatProfilesEqual(a, changedScore), false, "伤害分变化应不等");
  // 掉榜（用户移除）
  const removed = buildThreatProfiles({
    ...SNAPSHOT,
    damage_dealt: SNAPSHOT.damage_dealt.filter((r) => r.username !== "jerkman"),
  });
  assert.equal(threatProfilesEqual(a, removed), false, "掉榜应不等");
  // 新增用户
  const added = buildThreatProfiles({
    ...SNAPSHOT,
    damage_dealt: [...SNAPSHOT.damage_dealt, { rank: 50, username: "newbie", score: 300 }],
  });
  assert.equal(threatProfilesEqual(a, added), false, "新增应不等");
});
