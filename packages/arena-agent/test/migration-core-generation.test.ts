/**
 * 核心代际检测测试（migration-system-v1 §2 RECOVERY_ABORT，评审 P0-4）：
 * id 变化检测、CORE_DESTROYED/RESPAWNED 事件识别、objects 提取。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectCoreGenerationChange,
  hasCoreDestroyedEvent,
  hasCoreRespawnedEvent,
  coreIdentityFromObjects,
} from "../src/migration/core-generation.ts";

test("core-generation: 核心 id 不同 → 代际变化（禁止续迁）", () => {
  assert.equal(
    detectCoreGenerationChange(
      { coreId: "uuid-A", generation: 1 },
      { coreId: "uuid-B", generation: 2 },
    ),
    true,
  );
});

test("core-generation: 核心 id 相同 → 无代际变化", () => {
  assert.equal(
    detectCoreGenerationChange(
      { coreId: "uuid-A", generation: 1 },
      { coreId: "uuid-A", generation: 1 },
    ),
    false,
  );
});

test("core-generation: 旧核消失（null）也算代际变化", () => {
  assert.equal(
    detectCoreGenerationChange({ coreId: "uuid-A", generation: 1 }, { coreId: null, generation: 1 }),
    true,
  );
});

test("core-generation: CORE_DESTROYED 事件识别", () => {
  assert.equal(hasCoreDestroyedEvent([{ type: "MOVE" }, { type: "CORE_DESTROYED" }]), true);
  assert.equal(hasCoreDestroyedEvent([{ type: "MOVE" }]), false);
  assert.equal(hasCoreDestroyedEvent([]), false);
});

test("core-generation: CORE_RESPAWNED 事件识别", () => {
  assert.equal(hasCoreRespawnedEvent([{ type: "CORE_RESPAWNED" }]), true);
  assert.equal(hasCoreRespawnedEvent([{ type: "CORE_DESTROYED" }]), false);
});

test("core-generation: 从 objects 提取我方核心 id（kind=CORE 且 controlled）", () => {
  const identity = coreIdentityFromObjects([
    { kind: "WORKER", controlled: true, id: "worker-1" },
    { kind: "CORE", controlled: true, id: "uuid-A" },
    { kind: "CORE", controlled: false, id: "enemy-core" },
  ]);
  assert.equal(identity.coreId, "uuid-A");
});

test("core-generation: 无我方核心 → null", () => {
  const identity = coreIdentityFromObjects([{ kind: "CORE", controlled: false, id: "enemy-core" }]);
  assert.equal(identity.coreId, null);
});
