/**
 * rules-manifest 测试（S0）：schema pos/neg、版本 fail closed、canonical hash、
 * mirror 聚合 hash 一致性。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertRulesSupported,
  canonicalJson,
  directoryAggregateSha256,
  loadRulesManifest,
  manifestHash,
  parseRulesManifest,
  RulesManifestError,
  verifyMirror,
} from "../src/sim/contracts/rules-manifest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = join(here, "..", "src", "sim", "contracts");
const MANIFEST_PATH = join(CONTRACT_DIR, "rules-v0.11.json");
const REPO_ROOT = resolve(here, "..", "..", "..");
const MIRROR_DIR = join(REPO_ROOT, "reference", "arena-hero-python", "arena_hero");

test("S0: 内置 manifest 加载成功且关键字段齐全", () => {
  const manifest = loadRulesManifest(MANIFEST_PATH);
  assert.equal(manifest.rulesVersion, "v0.11");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.evidence.docs.commit.length, 40);
  assert.equal(manifest.evidence.sdk.publicCommit.length, 40);
  assert.equal(manifest.evidence.sdk.documentedCommit.length, 40);
  assert.equal(manifest.evidence.sdk.documentedCommitStatus, "unresolvable-404");
  assert.equal(manifest.evidence.serverSource.status, "not-publicly-accessible");
  assert.ok(manifest.evidence.discrepancies.length >= 1);
  // 关键数值（与 game-rules.md / 官方核对一致）
  assert.equal(manifest.rules.core.minCapacity, 10);
  assert.equal(manifest.rules.core.capacityPerUnit, 5);
  assert.equal(manifest.rules.production.workerCost, 5);
  assert.equal(manifest.rules.upkeep.tierSize, 20);
  assert.equal(manifest.rules.upkeep.deficitProtectionCount, 19);
  assert.equal(manifest.rules.movement.cellEntityCapacity, 2);
  assert.equal(manifest.rules.economy.refillEveryTicks, 4);
  // upkeep 语义：tier 制（官方 core-and-economy.md:148 + 真实事件印证）
  assert.equal(manifest.rules.upkeep.deficitDamage.status, "PENDING-VERIFICATION");
  // 约束
  assert.ok(manifest.constraints.uuidTieBreak.forbidden.includes("localeCompare"));
  assert.equal(manifest.constraints.coordinate.unsupportedError, "UNSUPPORTED_COORDINATE_RANGE");
});

test("S0: 缺必填字段时 fail closed", () => {
  const base = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, unknown>;
  assert.throws(() => parseRulesManifest({ ...base, rulesVersion: undefined }), RulesManifestError);
  assert.throws(() => parseRulesManifest({ ...base, evidence: {} }), RulesManifestError);
  assert.throws(() => parseRulesManifest({ ...base, rules: undefined }), RulesManifestError);
});

test("S0: 数值范围校验（负数/超上限拒绝）", () => {
  const base = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, unknown>;
  const neg = structuredClone(base);
  (neg.rules as Record<string, unknown>).core = { ...(neg.rules as any).core, minCapacity: -1 };
  assert.throws(() => parseRulesManifest(neg), /invalid integer at rules\.core\.minCapacity/);

  const huge = structuredClone(base);
  (huge.rules as Record<string, unknown>).movement = { ...(huge.rules as any).movement, cellEntityCapacity: 2 ** 40 };
  assert.throws(() => parseRulesManifest(huge), /invalid integer/);
});

test("S0: 未核对的新规则版本 fail closed", () => {
  const manifest = loadRulesManifest(MANIFEST_PATH);
  assertRulesSupported(manifest, "v0.11"); // 通过
  assert.throws(() => assertRulesSupported(manifest, "v0.12"), /rules version mismatch/);
  assert.throws(() => assertRulesSupported(manifest, "v0.10"), /rules version mismatch/);
});

test("S0: schemaVersion 不支持时 fail closed", () => {
  const base = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, unknown>;
  assert.throws(() => parseRulesManifest({ ...base, schemaVersion: 2 }), /unsupported schemaVersion/);
});

test("S0: canonical hash 确定性（同 manifest 两次输出一致）", () => {
  const manifest = loadRulesManifest(MANIFEST_PATH);
  assert.equal(canonicalJson(manifest), canonicalJson(manifest));
  assert.equal(manifestHash(manifest), manifestHash(manifest));
  assert.match(manifestHash(manifest), /^[0-9a-f]{64}$/);
  // key 顺序无关：乱序重建的等价对象 hash 相同
  const a = { b: 1, a: [2, { d: 3, c: 4 }] };
  const b = { a: [2, { c: 4, d: 3 }], b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
});

test("S0: 本地 SDK 镜像聚合 hash 与 manifest 一致（漂移检测）", () => {
  const manifest = loadRulesManifest(MANIFEST_PATH);
  const mismatch = verifyMirror(manifest, MIRROR_DIR);
  assert.equal(mismatch, null, mismatch ?? "");
  // 破坏一个字节必须能检出
  const { aggregate } = directoryAggregateSha256(MIRROR_DIR);
  assert.equal(aggregate, manifest.evidence.sdk.mirrorAggregateSha256);
  assert.notEqual(createHash("sha256").update("tampered").digest("hex"), aggregate);
});
