/** 敌核威胁提炼测试（2026-08-08，参谋建议第 11 层 + 决策输入共用）：
 *  collectCoreThreats——approaching / proximity / stale / 距离阈值过滤。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { collectCoreThreats } from "../lib/core-threats.ts";
import type { TrailPoint } from "../lib/trails.ts";

const pts = (list: Array<[number, number, number]>): TrailPoint[] =>
  list.map(([x, y, tick]) => ({ x, y, tick }));

test("core-threats: approaching——轨迹≥2点逼近且距≤60", () => {
  const trails = [{ username: "enemy_a", trail: pts([[0, 0, 100], [1, 0, 105], [2, 0, 110]]) }];
  const out = collectCoreThreats(trails, [10, 0], 5000);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "approaching");
  assert.equal(out[0].distCells, 8);
  assert.ok(out[0].speedCellsPerTick !== null && out[0].speedCellsPerTick > 0);
  assert.equal(out[0].stale, false, "目击时间 110 距当前 5000 很新");
});

test("core-threats: approaching 超出 60 格不提炼", () => {
  const trails = [{ username: "far", trail: pts([[0, 0, 100], [1, 0, 105], [2, 0, 110]]) }];
  assert.equal(collectCoreThreats(trails, [100, 0], 5000).length, 0, "距 98 > 60 跳过");
});

test("core-threats: proximity——单点目击方向未知但近距≤40", () => {
  const trails = [{ username: "close_one", trail: pts([[6, 6, 700]]) }];
  const out = collectCoreThreats(trails, [0, 0], 1000);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "proximity");
  assert.equal(out[0].distCells, 6);
  assert.equal(out[0].speedCellsPerTick, null);
});

test("core-threats: 近距但超 40 格不提炼", () => {
  const trails = [{ username: "mid", trail: pts([[50, 0, 700]]) }];
  assert.equal(collectCoreThreats(trails, [0, 0], 1000).length, 0, "距 50 > 40 跳过");
});

test("core-threats: stale——目击超 5000 tick 标记可能已离开", () => {
  const trails = [{ username: "ghost", trail: pts([[5, 5, 100]]) }];
  const out = collectCoreThreats(trails, [0, 0], 10000);
  assert.equal(out.length, 1);
  assert.equal(out[0].stale, true, "9900 tick 前目击 > 5000 → stale");
});

test("core-threats: 无友核 / 空轨迹 返回空", () => {
  assert.equal(collectCoreThreats([{ username: "x", trail: pts([[1, 1, 100]]) }], null, 1000).length, 0, "无友核");
  assert.equal(collectCoreThreats([], [0, 0], 1000).length, 0, "空轨迹");
  assert.equal(collectCoreThreats([{ username: "y", trail: [] }], [0, 0], 1000).length, 0);
});

test("core-threats: 排序——距离近优先，同距离时新鲜优先", () => {
  const trails = [
    { username: "far_fresh", trail: pts([[20, 0, 100]]) },   // 距 20
    { username: "near_stale", trail: pts([[5, 0, 100]]) },   // 距 5，但旧
    { username: "near_fresh", trail: pts([[6, 0, 900]]) },   // 距 6，新
  ];
  const out = collectCoreThreats(trails, [0, 0], 1000);
  assert.deepEqual(out.map((t) => t.username), ["near_stale", "near_fresh", "far_fresh"], "距离升序");
});
