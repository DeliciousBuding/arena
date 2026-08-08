/**
 * 联盟探索覆盖算法测试（2026-08-08，地图系统/共享测绘）：
 * - 联盟并集 + 观测跨度覆盖率；
 * - 每租户独家贡献（仅自己见过的 chunk）；
 * - 距核心未探索盲区（gap）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeExplorationStats } from "../lib/exploration-coverage.ts";

test("exploration: 并集/覆盖率/独家贡献", () => {
  const chunks = {
    t1: [
      { key: "0,0", lastSeenTick: 5000 },
      { key: "1,0", lastSeenTick: 5000 },
    ],
    t2: [
      { key: "0,0", lastSeenTick: 4900 },
      { key: "0,1", lastSeenTick: 5000 },
    ],
    t3: [],
    t4: [],
  };
  const stats = computeExplorationStats(chunks, { t1: [8, 8], t2: null, t3: null, t4: null }, 5100);
  assert.equal(stats.alliance.unionChunks, 3, "并集 (0,0)(1,0)(0,1) = 3");
  assert.equal(stats.world.spanChunks, 4, "观测跨度 2x2 = 4");
  assert.equal(stats.world.coveragePct, 75, "覆盖率 3/4 = 75%");
  assert.equal(stats.perTenant.t1.exclusiveChunks, 1, "t1 独家 (1,0)");
  assert.equal(stats.perTenant.t2.exclusiveChunks, 1, "t2 独家 (0,1)");
  assert.equal(stats.alliance.exclusiveByTenant.t1, 1);
  assert.equal(stats.alliance.exclusiveByTenant.t2, 1);
});

test("exploration: 距核心未探索盲区（gap）", () => {
  const chunks = {
    t1: [{ key: "0,0", lastSeenTick: 5000 }],
    t2: [], t3: [], t4: [],
  };
  const stats = computeExplorationStats(chunks, { t1: [8, 8], t2: null, t3: null, t4: null }, 5100);
  // 核心 (8,8) → chunk (0,0)；span = 1x1；半径 5 内且 span 内未探索 = (1,1) 等
  assert.ok(stats.gaps.length >= 1, "核心附近存在盲区");
  const near = stats.gaps.find((g) => g.cx === 1 && g.cy === 1);
  assert.ok(near, "span 内未探索格 (1,1) 是盲区");
  assert.equal(near?.nearCoreOf, "t1");
  assert.equal(near?.distChunks, 1);
});

test("exploration: 补测目标（旧观测近核 chunk 优先）", () => {
  // currentTick=10000，FRESH_WINDOW=2000 → <8000 视为旧
  const chunks = {
    t1: [
      { key: "0,0", lastSeenTick: 9000 },   // 新鲜，不补测
      { key: "1,0", lastSeenTick: 5000 },   // 旧，距核 (8,8)→chunk(0,0) dist1 → 补测
      { key: "5,5", lastSeenTick: 3000 },   // 旧，距核 chunk(0,0) dist5 → 补测
      { key: "20,20", lastSeenTick: 2000 }, // 旧，距核 dist20 > RESURVEY_RADIUS(8) → 不补测
    ],
    t2: [], t3: [], t4: [],
  };
  const stats = computeExplorationStats(chunks, { t1: [8, 8], t2: null, t3: null, t4: null }, 10000);
  const rs = stats.resurveyTargets;
  assert.ok(rs.length >= 2, "近核旧 chunk 进补测清单");
  assert.equal(rs.some((r) => r.key === "0,0"), false, "新鲜 chunk 不补测");
  assert.equal(rs.some((r) => r.key === "20,20"), false, "远核旧 chunk 不补测");
  const byKey = new Map(rs.map((r) => [r.key, r]));
  assert.equal(byKey.get("1,0")?.nearCoreOf, "t1");
  assert.equal(byKey.get("1,0")?.stalenessTicks, 5000, "10000-5000");
  // 最旧优先（5,5 的 staleness 7000 应在 1,0 的 5000 之前）
  if (rs.length >= 2) assert.ok(rs[0].stalenessTicks >= rs[1].stalenessTicks, "最旧优先排序");
});
