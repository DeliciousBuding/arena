/**
 * 事件特效层测试（2026-08-08）：fx.ts 纯几何/生成逻辑——
 * 弹道曲线控制点、事件浮字生成、销毁碎片上限裁剪。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FX_LIFE_MS, FX_KIND_CN, shotCurveFx, spawnEventFx } from "../src/engine/fx.ts";

test("fx-shot-curve: 弹道曲线控制点在起终点之间且侧偏合法", () => {
  const a = { sx: 0, sy: 0 }, b = { sx: 100, sy: 0 };
  const c = shotCurveFx(a, b, 10);
  assert.ok(c, "非零长度应返回曲线");
  // 控制点 Y 应带侧偏（水平射线的法向偏移）
  assert.ok(Math.abs(c.controlY) > 0, "controlY 应侧偏: " + c.controlY);
  // 内收：startX 在 a 之后，endX 在 b 之前
  assert.ok(c.startX > 0 && c.startX < 50, "startX 应内收: " + c.startX);
  assert.ok(c.endX > 50 && c.endX < 100, "endX 应内收: " + c.endX);
  assert.equal(shotCurveFx(a, a, 10), null, "零长度返回 null");
});

test("fx-shot-curve: 垂直射线的侧偏方向确定（dy>0 → side=-1）", () => {
  const a = { sx: 0, sy: 0 }, b = { sx: 0, sy: 100 };
  const c = shotCurveFx(a, b, 10);
  assert.ok(c, "垂直应返回曲线");
  assert.ok(Math.abs(c.controlX) > 0, "controlX 应侧偏: " + c.controlX);
});

test("fx-kinds: 核心事件中文/颜色齐全", () => {
  assert.equal(FX_KIND_CN.CORE_DESTROYED.text, "摧毁!");
  assert.equal(FX_KIND_CN.HARVEST_SUCCEEDED.text, "+");
  assert.ok(FX_LIFE_MS > 0);
});

test("fx-spawn: 事件帧生成浮字 + 销毁碎片", () => {
  const tac: any = { eventFx: [], debris: [], fxSeq: 0 };
  const replayData = { eventFrames: [{ tick: 5, events: [
    { t: "HARVEST_SUCCEEDED", p: [1, 2], v: { amount: 3 } },
    { t: "UNIT_DESTROYED", p: [4, 5], v: {} },
    { t: "SHOT_HIT", f: [0, 0], q: [3, 0] },
    { t: "UNKNOWN_EVENT", p: [0, 0], v: {} },
  ] }] };
  spawnEventFx(tac, replayData, 5, 1000);
  const floats = tac.eventFx.filter((f: any) => f.text);
  assert.equal(floats.length, 1, "仅 HARVEST 有浮字（SHOT 走弹道、UNKNOWN 跳过）");
  assert.equal(floats[0].text, "+3");
  const shots = tac.eventFx.filter((f: any) => f.kind === "SHOT");
  assert.equal(shots.length, 1, "SHOT 事件生成弹道");
  assert.ok(tac.debris.length > 0, "UNIT_DESTROYED 生成碎片");
  // 无对应事件帧 → 无副作用
  const tac2: any = { eventFx: [], debris: [], fxSeq: 0 };
  spawnEventFx(tac2, replayData, 99, 1000);
  assert.equal(tac2.eventFx.length, 0);
  assert.equal(tac2.debris.length, 0);
});

test("fx-spawn: 上限裁剪（浮字 80 / 碎片 240）", () => {
  const tac: any = { eventFx: [], debris: [], fxSeq: 0 };
  const events = [];
  for (let i = 0; i < 50; i++) events.push({ t: "UNIT_DESTROYED", p: [i, 0], v: {} });
  const replayData = { eventFrames: [{ tick: 1, events }] };
  spawnEventFx(tac, replayData, 1, 0);
  assert.ok(tac.debris.length <= 240, "碎片上限 240，实际 " + tac.debris.length);
  assert.ok(tac.debris.length > 0);
});
