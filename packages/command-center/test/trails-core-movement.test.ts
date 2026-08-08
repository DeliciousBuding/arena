/** 敌核移动方向测试（2026-08-08，参谋建议第 11 层·raid-defense 输入）：
 *  computeCoreMovement——从敌核轨迹最近两点判相对友核的
 *  approaching / retreating / stationary / unknown 四分支 + 距离/速度。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCoreMovement } from "../lib/trails.ts";
import type { TrailPoint } from "../lib/trails.ts";

const pts = (list: Array<[number, number, number]>): TrailPoint[] =>
  list.map(([x, y, tick]) => ({ x, y, tick }));

test("core-movement: approaching——距离变小 + 速度", () => {
  const trail = pts([[0, 0, 100], [1, 0, 105], [2, 0, 110]]); // 敌核向右逼近友核 (10,0)
  const mv = computeCoreMovement(trail, [10, 0]);
  assert.equal(mv.direction, "approaching");
  assert.equal(mv.distToCoreCells, 8, "最近点 (2,0) 距 (10,0) 切比雪夫 = 8");
  assert.ok(mv.speedCellsPerTick !== null && mv.speedCellsPerTick > 0, "速度 > 0");
  assert.equal(mv.speedCellsPerTick, 0.2, "(2-1)/(110-105) = 0.2 格/tick");
});

test("core-movement: retreating——距离变大", () => {
  const trail = pts([[5, 0, 100], [6, 0, 105]]); // 远离友核 (0,0)
  const mv = computeCoreMovement(trail, [0, 0]);
  assert.equal(mv.direction, "retreating");
  assert.equal(mv.distToCoreCells, 6);
});

test("core-movement: stationary——同格不动 + 速度 0", () => {
  const trail = pts([[3, 3, 100], [3, 3, 110]]);
  const mv = computeCoreMovement(trail, [0, 0]);
  assert.equal(mv.direction, "stationary");
  assert.equal(mv.speedCellsPerTick, 0);
});

test("core-movement: 微小抖动 ±0.4 格不算逼近（APPROACH_EPS=0.5）", () => {
  const trail = pts([[9, 0, 100], [9.4, 0, 110]]); // delta = 0.4 < 0.5
  const mv = computeCoreMovement(trail, [10, 0]);
  assert.equal(mv.direction, "stationary", "0.4 格抖动 → 不误报逼近");
});

test("core-movement: unknown——轨迹不足 2 点 / 无友核坐标", () => {
  assert.equal(computeCoreMovement(pts([[1, 1, 100]]), [0, 0]).direction, "unknown", "单点 → unknown");
  assert.equal(computeCoreMovement([], [0, 0]).direction, "unknown", "空轨迹 → unknown");
  assert.equal(computeCoreMovement(pts([[0, 0, 100], [1, 1, 110]]), null).direction, "unknown", "无友核 → unknown");
  const mv = computeCoreMovement(pts([[0, 0, 100], [1, 1, 110]]), null);
  assert.equal(mv.distToCoreCells, null);
  assert.equal(mv.speedCellsPerTick, null);
});

test("core-movement: 同 tick 两点 → 速度 0（不除零）", () => {
  const trail = pts([[0, 0, 100], [5, 0, 100]]);
  const mv = computeCoreMovement(trail, [10, 0]);
  assert.equal(mv.speedCellsPerTick, 0, "dTick=0 → 速度 0 防除零");
  assert.ok(mv.direction === "approaching" || mv.direction === "retreating", "方向仍可判（距离差存在）");
});
