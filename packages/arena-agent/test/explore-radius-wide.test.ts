/**
 * 探索半径模式化 + wide 合并测试（W8，2026-08-09）。
 *
 * 问题（A1 D1 四重夹击）：exploreRadius=8（5 环 40 格封顶）+
 * MEMORY_MAX_DIRECT_DISTANCE=40 + HARVEST_MEMORY_MAX_DIST=40 +
 * 生产 maxCollectionDistance=24；矿带中位 139 格永远进不了候选（t3 事故）。
 *
 * 本变体（explore-radius-wide-v1，默认关闭零回归）：
 *  - src/domain/nav.ts 新增模式化 leash 纯函数（对齐 reference/arena-hero-
 *    clone-waaiging HEAD 26675e36 半径常量区 :109-130）；
 *  - src/strategies/safety-planner-config.ts 加 exploreRadiusWide 开关 +
 *    WIDE_EXPLORE_DEFAULTS 默认值常量（消费接线由收口统一处理，此处只验
 *    半径配置正确）。
 *
 * netValue 门槛（远矿净价值加成）接线由收口处理，本测试不覆盖。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGGRESS_SWEEP_INITIAL_RADIUS,
  AGGRESS_SWEEP_MAX,
  AGGRESS_SWEEP_STEP,
  BEACON_SWEEP_INITIAL_RADIUS,
  BEACON_SWEEP_MAX,
  BEACON_SWEEP_STEP,
  DEVELOP_LEASH_DISTANCE,
  RETURN_TOLERANCE,
  aggressSweepRadius,
  beaconSweepRadius,
  developLeash,
  returnTolerance,
} from "../src/domain/nav.ts";
import {
  AGGRESSIVE_SAFETY_CONFIG,
  DEFAULT_SAFETY_CONFIG,
  WIDE_EXPLORE_DEFAULTS,
  type SafetyPlannerConfig,
} from "../src/strategies/safety-planner-config.ts";

// ── 模式化 leash 纯函数（对齐 reference 半径常量区） ────────────────────────

test("developLeash 返回 38（对齐 DEVELOP_RESOURCE_TARGET_CORE_LEASH_DISTANCE :109）", () => {
  assert.equal(DEVELOP_LEASH_DISTANCE, 38);
  assert.equal(developLeash(0), 38);
  assert.equal(developLeash(38), 38);
  assert.equal(developLeash(139), 38);
  assert.equal(developLeash(1e9), 38);
});

test("developLeash 拒绝非有限/负数 coreDist", () => {
  assert.throws(() => developLeash(-1), /coreDist/);
  assert.throws(() => developLeash(NaN), /coreDist/);
  assert.throws(() => developLeash(Number.NEGATIVE_INFINITY), /coreDist/);
});

test("aggressSweepRadius 返回 {initial=10, step=8, max=28}（对齐 :113-115）", () => {
  assert.equal(AGGRESS_SWEEP_INITIAL_RADIUS, 10);
  assert.equal(AGGRESS_SWEEP_STEP, 8);
  assert.equal(AGGRESS_SWEEP_MAX, 28);
  const schedule = aggressSweepRadius(0);
  assert.equal(schedule.initial, 10);
  assert.equal(schedule.step, 8);
  assert.equal(schedule.max, 28);
  // 不同 sweepStep 返回同一固定调度（调度三元组不随迭代序号变化）
  assert.deepEqual(aggressSweepRadius(3), aggressSweepRadius(7));
});

test("aggressSweepRadius 拒绝非整数/负 sweepStep", () => {
  assert.throws(() => aggressSweepRadius(-1), /sweepStep/);
  assert.throws(() => aggressSweepRadius(1.5), /sweepStep/);
});

test("beaconSweepRadius 返回 {initial=12, step=6, max=36}（对齐 :119-121）", () => {
  assert.equal(BEACON_SWEEP_INITIAL_RADIUS, 12);
  assert.equal(BEACON_SWEEP_STEP, 6);
  assert.equal(BEACON_SWEEP_MAX, 36);
  const schedule = beaconSweepRadius();
  assert.equal(schedule.initial, 12);
  assert.equal(schedule.step, 6);
  assert.equal(schedule.max, 36);
});

test("returnTolerance 返回 4（对齐 reference :126 返程回退容差）", () => {
  assert.equal(RETURN_TOLERANCE, 4);
  assert.equal(returnTolerance(), 4);
});

test("模式化调度三元组之间互不混淆（aggress ≠ beacon）", () => {
  assert.notDeepEqual(aggressSweepRadius(0), beaconSweepRadius());
});

// ── WIDE_EXPLORE_DEFAULTS 默认值（wide 模式联动） ──────────────────────────

test("WIDE_EXPLORE_DEFAULTS 放大半径与采集上限以纳入远矿", () => {
  assert.equal(WIDE_EXPLORE_DEFAULTS.exploreRadius, 16);
  assert.equal(WIDE_EXPLORE_DEFAULTS.harvestMemoryMaxDist, 80);
  assert.equal(WIDE_EXPLORE_DEFAULTS.maxCollectionDistanceWide, 64);
});

test("WIDE_EXPLORE_DEFAULTS 模式化 leash 字段对齐 reference", () => {
  assert.equal(WIDE_EXPLORE_DEFAULTS.developLeashDist, 38);
  assert.equal(WIDE_EXPLORE_DEFAULTS.aggressSweepMax, 28);
  assert.equal(WIDE_EXPLORE_DEFAULTS.beaconSweepMax, 36);
});

test("WIDE_EXPLORE_DEFAULTS 与 nav.ts 纯函数常量一致", () => {
  assert.equal(WIDE_EXPLORE_DEFAULTS.developLeashDist, DEVELOP_LEASH_DISTANCE);
  assert.equal(WIDE_EXPLORE_DEFAULTS.aggressSweepMax, AGGRESS_SWEEP_MAX);
  assert.equal(WIDE_EXPLORE_DEFAULTS.beaconSweepMax, BEACON_SWEEP_MAX);
});

// ── 零回归：exploreRadiusWide 默认关闭 ──────────────────────────────────────

test("DEFAULT_SAFETY_CONFIG 未启用 wide 模式（零回归）", () => {
  assert.equal(DEFAULT_SAFETY_CONFIG.exploreRadius, 8);
  assert.equal(DEFAULT_SAFETY_CONFIG.exploreRadiusWide, undefined);
  assert.equal(DEFAULT_SAFETY_CONFIG.maxCollectionDistanceWide, undefined);
  assert.equal(DEFAULT_SAFETY_CONFIG.developLeashDist, undefined);
  assert.equal(DEFAULT_SAFETY_CONFIG.aggressSweepMax, undefined);
  assert.equal(DEFAULT_SAFETY_CONFIG.beaconSweepMax, undefined);
});

test("AGGRESSIVE_SAFETY_CONFIG 同样未启用 wide 模式（零回归）", () => {
  assert.equal(AGGRESSIVE_SAFETY_CONFIG.exploreRadius, 8);
  assert.equal(AGGRESSIVE_SAFETY_CONFIG.exploreRadiusWide, undefined);
});

test("exploreRadiusWide=true 配置可构造（类型 + 字段就绪，消费由收口接线）", () => {
  const wideConfig: SafetyPlannerConfig = {
    ...DEFAULT_SAFETY_CONFIG,
    exploreRadiusWide: true,
  };
  assert.equal(wideConfig.exploreRadiusWide, true);
  // 探索半径 effective 值由消费侧按 WIDE_EXPLORE_DEFAULTS.exploreRadius 取（16）
  assert.equal(WIDE_EXPLORE_DEFAULTS.exploreRadius, 16);
  assert.equal(WIDE_EXPLORE_DEFAULTS.harvestMemoryMaxDist, 80);
  assert.equal(WIDE_EXPLORE_DEFAULTS.maxCollectionDistanceWide, 64);
});

test("exploreRadiusWide=false/undefined 时 exploreRadius 保持 8（零回归）", () => {
  const offExplicit: SafetyPlannerConfig = {
    ...DEFAULT_SAFETY_CONFIG,
    exploreRadiusWide: false,
  };
  assert.equal(offExplicit.exploreRadius, 8);
  assert.equal(offExplicit.exploreRadiusWide, false);
  const offImplicit: SafetyPlannerConfig = { ...DEFAULT_SAFETY_CONFIG };
  assert.equal(offImplicit.exploreRadius, 8);
  assert.equal(offImplicit.exploreRadiusWide, undefined);
});
