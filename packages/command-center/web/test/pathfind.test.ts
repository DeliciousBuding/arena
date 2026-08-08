/**
 * BFS 寻路测试（2026-08-08）：findPath 纯函数——直达/绕障/目标为障/动态单位不可穿/
 * 测绘记忆额外障碍/不可达。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { findPath } from "../src/engine/pathfind.ts";

const mkWorld = (objects: any[]) => ({ state: { objects } });
const key = (path: any[]) => path.map((p: any) => p.join(",")).join(">");

test("find-path: 直线可达", () => {
  const w = mkWorld([]);
  const p = findPath(w, [0, 0], [2, 0]);
  assert.ok(p);
  assert.equal(key(p), "0,0>1,0>2,0");
});

test("find-path: 障碍绕行（L 形）", () => {
  const w = mkWorld([{ kind: "OBSTACLE", positions: [[1, 0]] }]);
  const p = findPath(w, [0, 0], [2, 0]);
  assert.ok(p);
  assert.ok(!key(p).split(">").includes("1,0"));
  assert.equal(p[p.length - 1].join(","), "2,0");
});

test("find-path: 目标为障碍 → null", () => {
  const w = mkWorld([{ kind: "OBSTACLE", positions: [[2, 0]] }]);
  assert.equal(findPath(w, [0, 0], [2, 0]), null);
});

test("find-path: 动态单位不可穿（目标格除外）", () => {
  const w = mkWorld([{ kind: "UNIT", id: "blocker", position: [1, 0], controlled: false }]);
  const p = findPath(w, [0, 0], [2, 0]);
  assert.ok(!p || !key(p).split(">").includes("1,0"));
  // 目标是单位所在格：允许到达
  const p2 = findPath(w, [0, 0], [1, 0]);
  assert.ok(p2);
  assert.equal(p2[p2.length - 1].join(","), "1,0");
});

test("find-path: 测绘记忆额外障碍参与绕行", () => {
  const w = mkWorld([]);
  const extra = new Set(["1,0"]);
  const p = findPath(w, [0, 0], [2, 0], extra);
  assert.ok(p);
  assert.ok(!key(p).split(">").includes("1,0"));
});

test("find-path: 不可达 → null", () => {
  const w = mkWorld([{ kind: "OBSTACLE", positions: [[1, 0], [-1, 0], [0, 1], [0, -1]] }]); // 四邻全封
  assert.equal(findPath(w, [0, 0], [2, 0]), null);
});
