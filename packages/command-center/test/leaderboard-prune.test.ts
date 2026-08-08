import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneLeaderboardSnapshots } from "../lib/leaderboard.ts";

test("leaderboard: 快照保留策略——只留最近 96 个快照，history 不裁剪", () => {
  const dir = mkdtempSync(join(tmpdir(), "lb-prune-"));
  try {
    // 造 100 个历史快照（文件名 UTC 时间序）+ 1 个 history.jsonl
    const pad = (n: number): string => String(n).padStart(2, "0");
    for (let i = 0; i < 100; i++) {
      const h = pad(Math.floor(i / 60));
      const m = pad(i % 60);
      const name = `leaderboard-2026-08-01-${h}-${m}-00.json`;
      writeFileSync(join(dir, name), "{}", "utf8");
    }
    writeFileSync(join(dir, "history.jsonl"), "x\n", "utf8");
    pruneLeaderboardSnapshots(dir);
    const left = readdirSync(dir).filter((f) => f.startsWith("leaderboard-"));
    assert.equal(left.length, 96, "只保留最近 96 个快照");
    // 保留的是最新 96 个（文件名排序）
    const names = left.sort();
    assert.ok(names[0] > "leaderboard-2026-08-01-00-00-00.json", "最旧快照已清");
    assert.equal(names[names.length - 1], "leaderboard-2026-08-01-01-39-00.json", "最新快照保留");
    assert.ok(readdirSync(dir).includes("history.jsonl"), "history.jsonl 不裁剪");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leaderboard: 快照保留策略——少于上限不删任何文件（幂等）", () => {
  const dir = mkdtempSync(join(tmpdir(), "lb-prune-keep-"));
  try {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `leaderboard-2026-08-01-00-0${i}-00.json`), "{}", "utf8");
    }
    pruneLeaderboardSnapshots(dir);
    assert.equal(readdirSync(dir).filter((f) => f.startsWith("leaderboard-")).length, 5, "少于上限不删");
    pruneLeaderboardSnapshots(dir); // 幂等
    assert.equal(readdirSync(dir).filter((f) => f.startsWith("leaderboard-")).length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
