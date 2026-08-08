/**
 * 变体注册映射（variant-registry）与生产 config `variants` 字段的单元测试：
 * - 已注册变体解析出正确 SafetyPlanner 配置；
 * - 未知变体 fail-fast；空/缺省 = 零覆盖；
 * - config schema 接受合法 variants、拒绝非法结构（非字符串数组）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveDeterministicVariantsConfig,
  resolveDeterministicVariantConfig,
  isSafetyVariant,
  resolveSafetyVariantConfig,
  resolveVariantsConfig,
} from "../src/strategies/variant-registry.ts";
import { Compile } from "typebox/compile";
import { RuntimeConfigSchema } from "../src/app/runtime-config.ts";

const validator = Compile(RuntimeConfigSchema);

test("variant registry: known ids resolve to expected config overrides", () => {
  assert.deepEqual(resolveSafetyVariantConfig("threat-recall-v1"), { threatRecall: true });
  assert.deepEqual(resolveSafetyVariantConfig("clear-path-v1"), { clearPath: true });
  assert.deepEqual(resolveSafetyVariantConfig("move-failed-avoidance-v1"), { moveFailedAvoidance: true });
  assert.deepEqual(resolveSafetyVariantConfig("threat-breakout-v1"), { threatBreakout: true });
  assert.deepEqual(resolveSafetyVariantConfig("core-evade-v1"), { coreEvade: true });
  assert.deepEqual(resolveSafetyVariantConfig("harvest-memory-mine-v1"), { harvestMemoryMine: true });
  assert.deepEqual(resolveSafetyVariantConfig("coordinated-fire-v1"), { coordinatedFire: true });
});

test("variant registry: core-threat-watch-v1 resolves coreThreatWatch", () => {
  assert.deepEqual(resolveSafetyVariantConfig("core-threat-watch-v1"), { coreThreatWatch: true });
  assert.equal(isSafetyVariant("core-threat-watch-v1"), true);
});

test("variant registry: unknown id fails fast", () => {
  assert.throws(() => resolveSafetyVariantConfig("no-such-variant"), /unknown safety variant/);
  assert.equal(isSafetyVariant("no-such-variant"), false);
  assert.equal(isSafetyVariant("threat-recall-v1"), true);
});

test("variant registry: empty or undefined variants list is zero override", () => {
  assert.deepEqual(resolveVariantsConfig(undefined), {});
  assert.deepEqual(resolveVariantsConfig([]), {});
});

test("variant registry: strike-core-v1 resolves safety + deterministic parts", () => {
  assert.deepEqual(resolveSafetyVariantConfig("strike-core-v1"), {
    aggression: "aggressive",
    attackForce: 6,
    boundedRaid: true,
    rangerMemoryShot: true,
    strikeGroupReserve: true,
    militarySearchDense: true,
    militaryRingHoldTicks: 20,
    enemyCoreMemoryTicks: 1200,
    militaryHunt: true,
  });
  assert.deepEqual(resolveDeterministicVariantConfig("strike-core-v1"), {
    vanguardRatio: 0.5,
    accumulateThreshold: 30,
  });
  // 无 deterministic 部分的变体 = 零覆盖（id 合法性由安全侧 fail-fast 负责）
  assert.deepEqual(resolveDeterministicVariantConfig("no-such-variant"), {});
  assert.deepEqual(resolveDeterministicVariantConfig("move-failed-avoidance-v1"), {});
  assert.deepEqual(resolveDeterministicVariantsConfig(["move-failed-avoidance-v1", "strike-core-v1"]), {
    vanguardRatio: 0.5,
    accumulateThreshold: 30,
  });
  assert.deepEqual(resolveDeterministicVariantsConfig(undefined), {});
  assert.deepEqual(resolveDeterministicVariantsConfig([]), {});
});
test("variant registry: multiple variants merge into one config", () => {
  const merged = resolveVariantsConfig(["threat-recall-v1", "core-evade-v1"]);
  assert.deepEqual(merged, { threatRecall: true, coreEvade: true });
});

test("variant registry: population-ceiling-30-v1 raises the spawn ceiling", () => {
  assert.deepEqual(resolveSafetyVariantConfig("population-ceiling-30-v1"), { populationCeiling: 30 });
  assert.equal(isSafetyVariant("population-ceiling-30-v1"), true);
  // 与 strike-core-v1 叠加（t1 生产组合）：天花板 30 生效，其余配置不变
  const merged = resolveVariantsConfig(["strike-core-v1", "population-ceiling-30-v1"]);
  assert.equal(merged.populationCeiling, 30);
  assert.equal(merged.aggression, "aggressive");
});

test("runtime config schema: accepts variants field and rejects malformed values", () => {
  const base = {
    tenantId: "t9",
    arenaTokenEnv: "ARENA_HERO_API_KEY_9",
    decisionMode: "deterministic",
    submitEnabled: false,
    model: { provider: "openai", id: "deepseek-v4-flash" },
  };
  assert.equal(validator.Check({ ...base, variants: ["threat-recall-v1"] }), true);
  assert.equal(validator.Check({ ...base, variants: [] }), true);
  assert.equal(validator.Check({ ...base, variants: [42] }), false);
  assert.equal(validator.Check({ ...base, variants: "threat-recall-v1" }), false);
});

