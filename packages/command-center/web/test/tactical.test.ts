/**
 * 战术规则层测试（2026-08-08）：tactical.ts 纯常量 + 纯函数——
 * 单位成本/核心容量/意图标签/近邻命中/障碍地形/移动可达方向。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  tactUnitCost, tactCoreCapacity, intentLabelCn,
  tactObjectNear, tactObjectAt, tactTerrain, tactHostileAt, tactMoveTargets,
} from "../src/engine/tactical.ts";

const mkWorld = (objects: any[]) => ({ state: { objects } });

test("tact-unit-cost: 人口阶梯 1.3 指数（pop<20 基准价）", () => {
  assert.equal(tactUnitCost("WORKER", 5), 5);
  assert.equal(tactUnitCost("VANGUARD", 0), 10);
  assert.equal(tactUnitCost("WORKER", 20), Math.round(5 * 1.3));       // 6.5 → 7
  assert.equal(tactUnitCost("WORKER", 24), Math.round(5 * 1.3));       // 6.5 → 7（未跨档）
  assert.equal(tactUnitCost("WORKER", 25), Math.round(5 * Math.pow(1.3, 2))); // 8.45 → 8
});

test("tact-core-capacity: 下限 10，人口×5", () => {
  assert.equal(tactCoreCapacity(0), 10);
  assert.equal(tactCoreCapacity(10), 50);
  assert.equal(tactCoreCapacity(-5), 10);
});

test("intent-label: 意图短中文标签映射", () => {
  assert.equal(intentLabelCn("vanguard_hunt"), "猎敌");
  assert.equal(intentLabelCn("capacity_wait:ranger_move"), "等容");
  assert.equal(intentLabelCn("DEPOSIT"), "交付");
  assert.equal(intentLabelCn("WAIT"), null);
  assert.equal(intentLabelCn("NOTHING_TO_DO"), null);
  assert.equal(intentLabelCn(null), null);
  assert.equal(intentLabelCn("go_harvest_mem"), "采忆");
});

test("tact-object-near: 切比雪夫半径内最近单位", () => {
  const w = mkWorld([
    { kind: "UNIT", id: "a", position: [0, 0] },
    { kind: "UNIT", id: "b", position: [3, 3] },
  ]);
  assert.equal(tactObjectNear(w, 1, 0, 2)?.id, "a");
  assert.equal(tactObjectNear(w, 2, 0, 1), null); // a 距 (2,0)=2 超半径
  assert.equal(tactObjectNear(w, 2, 2, 1)?.id, "b");
});

test("tact-object-at: 精确格命中，跳过地形", () => {
  const w = mkWorld([
    { kind: "OBSTACLE", positions: [[1, 1]] },
    { kind: "RESOURCE", positions: [[2, 2]] },
    { kind: "UNIT", id: "u", position: [3, 3] },
  ]);
  assert.equal(tactObjectAt(w, 1, 1), null);
  assert.equal(tactObjectAt(w, 2, 2), null);
  assert.equal(tactObjectAt(w, 3, 3)?.id, "u");
  assert.equal(tactObjectAt(null, 3, 3), null);
});

test("tact-terrain/hostile: 障碍格键集 + 敌情判定", () => {
  const w = mkWorld([
    { kind: "OBSTACLE", positions: [[0, 0], [1, 1]] },
    { kind: "UNIT", id: "enemy", position: [5, 5], controlled: false },
    { kind: "CORE", id: "mycore", position: [6, 6], controlled: true },
  ]);
  const obs = tactTerrain(w, "OBSTACLE");
  assert.ok(obs.has("0,0") && obs.has("1,1") && !obs.has("2,2"));
  assert.equal(tactHostileAt(w, [5, 5], false), true);
  assert.equal(tactHostileAt(w, [6, 6], false), false);
  assert.equal(tactHostileAt(w, [6, 6], true), true); // includeOwnCore
  assert.equal(tactHostileAt(w, [9, 9], false), false);
});

test("tact-move-targets: 障碍/敌格排除 + 四方向可达", () => {
  const w = mkWorld([
    { kind: "OBSTACLE", positions: [[6, 5]] },     // 挡住 RIGHT
    { kind: "UNIT", id: "enemy", position: [5, 4], controlled: false }, // 挡住 UP
    { kind: "UNIT", id: "me", position: [5, 5], controlled: true },
  ]);
  const me = w.state.objects[2];
  const targets = tactMoveTargets(w, me).map((t: any) => t.join(",")).sort();
  assert.deepEqual(targets, ["4,5", "5,6"]); // LEFT + DOWN
  // 非受控单位/无位置 → 空
  assert.deepEqual(tactMoveTargets(w, w.state.objects[1]), []);
});
