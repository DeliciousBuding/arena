import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StrategicPolicyRegistry,
  StrategicPolicySelector,
  computeProfileHash,
  BALANCED_PROFILE,
  AGGRESSIVE_PROFILE,
  DEFEND_PROFILE,
} from "../src/alliance/strategic-policy.ts";

test("strategic-policy: contentHash 稳定且区分 profile", () => {
  const a = computeProfileHash(BALANCED_PROFILE);
  const b = computeProfileHash(AGGRESSIVE_PROFILE);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, b);
  // 同输入同输出
  assert.equal(computeProfileHash(BALANCED_PROFILE), a);
});

test("strategic-policy: registry 静态注册——重复/未知/默认约束", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(AGGRESSIVE_PROFILE);
  assert.throws(() => registry.register(BALANCED_PROFILE), /already registered/);
  assert.throws(() => registry.setDefault("nope"), /not registered/);
  registry.setDefault("aggressive");
  assert.equal(registry.defaultName, "aggressive");
  assert.equal(registry.get("balanced")?.name, "balanced");
  assert.equal(registry.get("missing"), undefined);
  assert.equal(registry.list().length, 2);
});

test("strategic-policy: selector 首次 select → default；后续 sticky", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  const selector = new StrategicPolicySelector(registry, { maxHistory: 4 });
  const first = selector.select(10);
  assert.equal(first.reason, "default");
  assert.equal(first.profile.name, "balanced");
  assert.equal(first.previousHash, null);
  const second = selector.select(20);
  assert.equal(second.reason, "sticky");
  assert.equal(second.profile.name, "balanced");
  assert.equal(second.previousHash, first.profile.contentHash);
  assert.equal(second.revision, 2);
});

test("strategic-policy: explicitOverride 在 replan 边界 hot-switch", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(AGGRESSIVE_PROFILE);
  const selector = new StrategicPolicySelector(registry);
  const switched = selector.select(30, "aggressive");
  assert.equal(switched.reason, "explicit-override:aggressive");
  assert.equal(switched.profile.name, "aggressive");
  // 无 override → sticky 保持 aggressive
  assert.equal(selector.select(40).profile.name, "aggressive");
});

test("strategic-policy: 无效 override 名 → sticky（Director 不因配置错误停机）", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  const selector = new StrategicPolicySelector(registry);
  const selection = selector.select(10, "does-not-exist");
  assert.equal(selection.profile.name, "balanced");
  assert.match(selection.reason, /explicit-override-not-found/);
});

test("strategic-policy: markLastGood + rollback 回到 lastGood", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(AGGRESSIVE_PROFILE);
  const selector = new StrategicPolicySelector(registry);
  selector.select(10); // balanced
  selector.markLastGood();
  selector.select(20, "aggressive");
  assert.equal(selector.lastGoodProfile?.name, "balanced");
  const rolled = selector.rollback(30);
  assert.equal(rolled.reason, "rollback-to-last-good");
  assert.equal(rolled.profile.name, "balanced");
  assert.equal(rolled.previousHash, AGGRESSIVE_PROFILE.contentHash);
  assert.equal(rolled.lastGoodHash, BALANCED_PROFILE.contentHash);
});

test("strategic-policy: 无 lastGood 时 rollback 回 default", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  registry.register(DEFEND_PROFILE);
  const selector = new StrategicPolicySelector(registry);
  selector.select(10, "defend-only");
  const rolled = selector.rollback(20);
  assert.equal(rolled.reason, "rollback-to-default");
  assert.equal(rolled.profile.name, "balanced");
});

test("strategic-policy: history 有界（maxHistory）", () => {
  const registry = new StrategicPolicyRegistry();
  registry.register(BALANCED_PROFILE);
  const selector = new StrategicPolicySelector(registry, { maxHistory: 3 });
  for (let tick = 1; tick <= 10; tick += 1) selector.select(tick);
  assert.equal(selector.history.length, 3);
  assert.equal(selector.history[0]?.selectedAtTick, 10);
});

test("strategic-policy: profile 只含纯数据——threats/优先级可被 Director 消费", () => {
  // StrategicPolicyProfile 结构满足 director-policy 的 ShadowPolicyProfileSurface
  const surface: { missionPriority: readonly string[]; thresholds?: object } = BALANCED_PROFILE;
  assert.ok(surface.missionPriority.length >= 5);
  assert.equal(AGGRESSIVE_PROFILE.thresholds?.minRaidMilitary, 4);
  assert.equal(DEFEND_PROFILE.thresholds?.minInterceptMilitary, 1);
});
