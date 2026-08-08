/**
 * rules-manifest 测试（S0）：schema pos/neg、版本 fail closed、canonical hash、
 * mirror 聚合 hash 一致性。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertRulesSupported,
  canonicalJson,
  directoryAggregateSha256,
  loadRulesManifest,
  loadRulesManifestForVersion,
  manifestHash,
  parseRulesManifest,
  RulesManifestError,
  verifyMirror,
  type RulesManifest,
  type RulesManifestV011,
  type RulesManifestV014,
  type RulesVersion,
} from "../src/sim/contracts/rules-manifest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = join(here, "..", "src", "sim", "contracts");
const MANIFEST_PATH = join(CONTRACT_DIR, "rules-v0.14.json");
const V011_MANIFEST_PATH = join(CONTRACT_DIR, "rules-v0.11.json");
const REPO_ROOT = resolve(here, "..", "..", "..");
function findCoordinationRoot(start: string): string {
  let current = start;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, "reference", "arena-hero-python", "src", "arena_hero"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(REPO_ROOT, "..");
}
const COORDINATION_ROOT = findCoordinationRoot(REPO_ROOT);
const localMirrorCandidates = [
  // arena-hero-python is a standard src-layout package.
  join(COORDINATION_ROOT, "reference", "arena-hero-python", "src", "arena_hero"),
  // Legacy layout kept as a compatibility fallback for older mirrors.
  join(COORDINATION_ROOT, "reference", "arena-hero-python", "arena_hero"),
];
const MIRROR_DIR = process.env.ARENA_SDK_MIRROR_DIR
  ? resolve(process.env.ARENA_SDK_MIRROR_DIR)
  : localMirrorCandidates.find((candidate) => existsSync(candidate)) ?? localMirrorCandidates[0]!;

test("S0 v0.11 显式回退: v0.11 manifest 加载成功且关键字段齐全", () => {
  const manifest = loadRulesManifest(V011_MANIFEST_PATH) as RulesManifestV011;
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
  assertRulesSupported(manifest, "v0.14"); // 通过
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
  const manifest = loadRulesManifest(V011_MANIFEST_PATH) as RulesManifestV011;
  const mismatch = verifyMirror(manifest, MIRROR_DIR);
  assert.equal(mismatch, null, mismatch ?? "");
  // 破坏一个字节必须能检出
  const { aggregate } = directoryAggregateSha256(MIRROR_DIR);
  assert.equal(aggregate, manifest.evidence.sdk.mirrorAggregateSha256);
  assert.notEqual(createHash("sha256").update("tampered").digest("hex"), aggregate);
});
test("S0 v0.14: SDK 镜像聚合 hash 与 v0.14 manifest 一致（v0.2.9 已核对）", () => {
  // 2026-08-07 官方 SDK v0.2.9 发布后完成 unit_cost 钉定核对（183/183），
  // v0.14 manifest 补上 evidence.sdk；verifyMirror 对两版本统一生效。
  const manifest = loadRulesManifest(MANIFEST_PATH) as RulesManifestV014;
  const mismatch = verifyMirror(manifest, MIRROR_DIR);
  assert.equal(mismatch, null, mismatch ?? "");
  assert.equal(manifest.evidence.sdk.tag, "v0.2.9");
  assert.equal(manifest.evidence.sdk.publicCommit, "423d252adcca439669adb3e7b04252e53b4430bd");
});
test("S0 v0.14: 内置 v0.14 manifest 加载成功且动态价格字段齐全", () => {
  const manifest = loadRulesManifest(MANIFEST_PATH);
  assert.equal(manifest.rulesVersion, "v0.14");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.evidence.docs.commit.length, 40);
  assert.equal(manifest.evidence.serverSource.status, "not-publicly-accessible");
  assert.equal(manifest.rules.unitCosts.base.WORKER, 5);
  assert.equal(manifest.rules.unitCosts.base.VANGUARD, 10);
  assert.equal(manifest.rules.unitCosts.base.RANGER, 12);
  assert.equal(manifest.rules.unitCosts.dynamicPricing.tierSize, 20);
  assert.equal(manifest.rules.unitCosts.dynamicPricing.growthFactor, 13 / 10);
  assert.equal(manifest.rules.unitCosts.dynamicPricing.tierStep, 5);
  assert.equal(manifest.rules.unitCosts.dynamicPricing.rounding, "round_half_up");
  assert.equal(manifest.rules.maintenance.status, "removed");
  // 共享规则段沿用 v0.11 数值
  assert.equal(manifest.rules.core.startingWorkerCount, 1);
  assert.equal(manifest.rules.core.minCapacity, 10);
  assert.equal(manifest.rules.economy.refillEveryTicks, 4);
  assert.equal(manifest.rules.movement.cellEntityCapacity, 2);
  assert.equal(manifest.constraints.coordinate.unsupportedError, "UNSUPPORTED_COORDINATE_RANGE");
});

test("S0 v0.14: 按版本加载器（loadRulesManifestForVersion）按版本取文件", () => {
  const v011 = loadRulesManifestForVersion("v0.11");
  assert.equal(v011.rulesVersion, "v0.11");
  const v014 = loadRulesManifestForVersion("v0.14");
  assert.equal(v014.rulesVersion, "v0.14");
  assert.equal(v014.evidence.docs.rulesVersion, "v0.14");
});

test("S0 v0.14: 未知规则版本 fail closed（编译期 RulesVersion + parse 层）", () => {
  // @ts-expect-error 未知版本在编译期即被 RulesVersion 联合类型拒绝
  const unsupportedVersion: RulesVersion = "v0.15";
  assert.throws(
    () => (loadRulesManifestForVersion as (version: string) => RulesManifest)(unsupportedVersion),
    /unsupported rules version/,
  );
  const base = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, unknown>;
  assert.throws(() => parseRulesManifest({ ...base, rulesVersion: "v0.15" }), /unsupported rules version/);
  assert.throws(() => parseRulesManifest({ ...base, rulesVersion: "v0.13" }), /unsupported rules version/);
});

test("S0 v0.14: 动态价格参数只接受已核对组合（fail closed）", () => {
  const readBase = (): Record<string, unknown> =>
    JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, unknown>;

  const badGrowth = structuredClone(readBase());
  (badGrowth.rules as Record<string, any>).unitCosts.dynamicPricing.growthFactor = 1.5;
  assert.throws(() => parseRulesManifest(badGrowth), /unsupported growthFactor/);

  const badRounding = structuredClone(readBase());
  (badRounding.rules as Record<string, any>).unitCosts.dynamicPricing.rounding = "round_down";
  assert.throws(() => parseRulesManifest(badRounding), /unsupported rounding/);

  const badMaintenance = structuredClone(readBase());
  (badMaintenance.rules as Record<string, any>).maintenance.status = "active";
  assert.throws(() => parseRulesManifest(badMaintenance), /unsupported maintenance status/);

  const missingBase = structuredClone(readBase());
  delete (missingBase.rules as Record<string, any>).unitCosts;
  assert.throws(() => parseRulesManifest(missingBase), RulesManifestError);
});
