/** 事迹 CORE_DESTROYED 敌我语义测试（2026-08-08，叙事 A11）：
 *  我方被打爆(⚠ HIGH) / 敌方被摧毁(战果) / 自爆 三态叙事；
 *  destroyed_by 数组解析（兼容 string 旧数据）；两路径（calibration 扫描 /
 *  survey-db notable 行）同口径；target 保持完整核心 ID（去重键一致）。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deedFromEvent, deedFromNotableRow } from "../lib/deeds.ts";

const OUR_CORE = "ee9f1034-5261-450c-ad8a-5daaede58fb5";
const ENEMY_CORE = "13382cfd-6bb7-4fd5-89fe-b82b7a45e16f";

test("deeds: CORE_DESTROYED 我方核心被打爆 → ⚠ HIGH 叙事", () => {
  const d = deedFromEvent({
    event_type: "CORE_DESTROYED", tick: 73094, target_id: OUR_CORE,
    position: [118, 461], reason_code: "ATTACK",
    values: { destroyed_by: ["feiwu"] },
  }, "t3", 73094, new Set([OUR_CORE]));
  assert.ok(d);
  assert.equal(d.title, "我方核心被摧毁 ⚠");
  assert.equal(d.star, 4);
  assert.ok(d.detail.includes("被 feiwu 摧毁"), "detail 含摧毁者");
  assert.ok(d.detail.includes("ee9f1034"), "detail 含核心短 ID");
  assert.equal(d.target, OUR_CORE, "target 保持完整核心 ID（去重键一致性）");
});

test("deeds: CORE_DESTROYED 敌方核心被摧毁 → 战果叙事", () => {
  const d = deedFromEvent({
    event_type: "CORE_DESTROYED", tick: 70000, target_id: ENEMY_CORE,
    position: [120, 461], reason_code: "ATTACK",
    values: { destroyed_by: ["t3"] },
  }, "t3", 70000, new Set([OUR_CORE]));
  assert.ok(d);
  assert.equal(d.title, "敌方核心被摧毁");
  assert.equal(d.star, 4);
  assert.ok(d.detail.includes("被 t3 摧毁"));
  assert.equal(d.target, ENEMY_CORE);
});

test("deeds: CORE_DESTROYED 自爆 → 核心自爆（star 3）", () => {
  const d = deedFromEvent({
    event_type: "CORE_DESTROYED", tick: 70001, actor_id: "core-x",
    position: [1, 1], reason_code: "SELF_DESTRUCT", values: null,
  }, "t3", 70001, new Set());
  assert.ok(d);
  assert.equal(d.title, "核心自爆");
  assert.equal(d.star, 3);
  assert.ok(d.detail.includes("自爆放弃"));
});

test("deeds: CORE_DESTROYED destroyed_by 兼容 string 旧数据", () => {
  const d = deedFromEvent({
    event_type: "CORE_DESTROYED", tick: 70002, target_id: ENEMY_CORE,
    reason_code: "ATTACK", values: { destroyed_by: "t3" },
  }, "t3", 70002, new Set());
  assert.ok(d);
  assert.ok(d.detail.includes("被 t3 摧毁"));
});

test("deeds: 库行 CORE_DESTROYED 我方 → ⚠（destroyed_by JSON 数组解析）", () => {
  const d = deedFromNotableRow({
    tick: 73094, event_type: "CORE_DESTROYED", actor_id: null, target_id: OUR_CORE,
    x: 118, y: 461, amount: null, unit_type: null,
    reason_code: "ATTACK", destroyed_by: JSON.stringify(["feiwu"]), is_our_core: 1,
  }, "t3");
  assert.ok(d);
  assert.equal(d.title, "我方核心被摧毁 ⚠");
  assert.equal(d.star, 4);
  assert.ok(d.detail.includes("被 feiwu 摧毁"));
  assert.equal(d.target, OUR_CORE);
});

test("deeds: 库行 CORE_DESTROYED 敌方 → 战果叙事", () => {
  const d = deedFromNotableRow({
    tick: 70000, event_type: "CORE_DESTROYED", actor_id: null, target_id: ENEMY_CORE,
    x: 120, y: 461, amount: null, unit_type: null,
    reason_code: "ATTACK", destroyed_by: JSON.stringify(["t3"]), is_our_core: 0,
  }, "t3");
  assert.ok(d);
  assert.equal(d.title, "敌方核心被摧毁");
});

test("deeds: 库行 CORE_DESTROYED 自爆", () => {
  const d = deedFromNotableRow({
    tick: 70001, event_type: "CORE_DESTROYED", actor_id: "core-x", target_id: null,
    x: 1, y: 1, amount: null, unit_type: null,
    reason_code: "SELF_DESTRUCT", destroyed_by: null, is_our_core: 0,
  }, "t3");
  assert.ok(d);
  assert.equal(d.title, "核心自爆");
  assert.equal(d.star, 3);
});

test("deeds: 库行 CORE_DESTROYED 旧库缺列 → 兜底叙事（敌方）", () => {
  const d = deedFromNotableRow({
    tick: 70003, event_type: "CORE_DESTROYED", actor_id: null, target_id: ENEMY_CORE,
    x: 1, y: 1, amount: null, unit_type: null,
    reason_code: null, destroyed_by: null, is_our_core: null,
  }, "t3");
  assert.ok(d);
  assert.equal(d.title, "敌方核心被摧毁", "缺敌我信息时按战果兜底（不误报我方⚠）");
});
