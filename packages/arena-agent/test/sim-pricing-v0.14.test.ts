/**
 * v0.14 动态价格测试（S0）：官方公式 + 版本隔离。
 *
 * 官方公式（changelog 2026-08-06，docs commit 166ef86 / server commit
 * b24cfcd）：k = max(0, floor((population − 20) / 5) + 1)，
 * price = round_half_up(base × (13/10)^k)，population = spawn 前存活人口
 * （同 tick 自毁/战死结算后）；base 价 5/10/12 保留给 Units 1-20
 * （population ≤ 19 时 k=0）。
 *
 * 注意：任务书草稿示例（pop=20→base 价、pop=25→k=1）与官方公式不符——
 * 公式在 pop=20（spawn 第 21 单位）即 k=1（6.5→7）、pop=25 即 k=2
 * （8.45→8）。以官方 changelog 为准（让步顺序：价格语义正确优先），
 * 此处测试按官方公式取值。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeUnitCost, spawnUnitCost } from "../src/sim/contracts/pricing.ts";
import {
  loadRulesManifestForVersion,
  type RulesManifestV014,
} from "../src/sim/contracts/rules-manifest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = join(here, "..", "src", "sim", "contracts");

const v011 = loadRulesManifestForVersion("v0.11");
// loadRulesManifestForVersion 返回 union；"v0.14" 文件固定解析为 V014
const v014 = loadRulesManifestForVersion("v0.14") as RulesManifestV014;

test("v0.14: base 价保留给 Units 1-20（population <= 19 → k=0）", () => {
  assert.equal(computeUnitCost("WORKER", 0, v014), 5);
  assert.equal(computeUnitCost("WORKER", 19, v014), 5);
  assert.equal(computeUnitCost("VANGUARD", 19, v014), 10);
  assert.equal(computeUnitCost("RANGER", 19, v014), 12);
});

test("v0.14: 第 21 单位起 k=max(0,floor((pop-20)/5)+1) 阶梯", () => {
  // pop=20（第 21 单位）→ k=1：round_half_up(5×13/10)=6.5→7
  assert.equal(computeUnitCost("WORKER", 20, v014), 7);
  // pop=21..24 → k=1（floor(1/5..4/5)+1 = 1）
  assert.equal(computeUnitCost("WORKER", 21, v014), 7);
  assert.equal(computeUnitCost("WORKER", 24, v014), 7);
  // pop=25（第 26 单位）→ k=2：round_half_up(5×169/100)=8.45→8
  assert.equal(computeUnitCost("WORKER", 25, v014), 8);
  // pop=26 → k=2
  assert.equal(computeUnitCost("WORKER", 26, v014), 8);
  // pop=30 → k=3：round_half_up(5×2197/1000)=10.985→11
  assert.equal(computeUnitCost("WORKER", 30, v014), 11);
  // pop=35 → k=4：round_half_up(5×13^4/10^4)=14.2805→14
  assert.equal(computeUnitCost("WORKER", 35, v014), 14);
});

test("v0.14: VANGUARD/RANGER 同式（base 10/12）", () => {
  assert.equal(computeUnitCost("VANGUARD", 20, v014), 13); // 10×1.3 整
  assert.equal(computeUnitCost("VANGUARD", 25, v014), 17); // 16.9→17
  assert.equal(computeUnitCost("RANGER", 20, v014), 16); // 15.6→16
  assert.equal(computeUnitCost("RANGER", 25, v014), 20); // 20.28→20
  assert.equal(computeUnitCost("RANGER", 30, v014), 26); // 26.364→26
});

test("v0.14: round_half_up .5 边界（6.5→7，唯一 .5 边界）", () => {
  // 全域唯一 .5 边界：base=5、k=1（6.5）；IEEE-754 精确可表示，
  // Math.round 对正数即 round half up。
  assert.equal(computeUnitCost("WORKER", 20, v014), 7);
  // 边界两侧各一档不受浮点噪声影响
  assert.equal(computeUnitCost("WORKER", 19, v014), 5);
  assert.equal(computeUnitCost("WORKER", 24, v014), 7);
});

test("v0.14: spawn 结算入口按版本分派（v0.11 静态 / v0.14 动态）", () => {
  assert.equal(spawnUnitCost("WORKER", 20, v011), 5);
  assert.equal(spawnUnitCost("WORKER", 20, v014), 7);
  assert.equal(spawnUnitCost("VANGUARD", 25, v011), 10);
  assert.equal(spawnUnitCost("VANGUARD", 25, v014), 17);
  assert.equal(spawnUnitCost("RANGER", 25, v011), 12);
  assert.equal(spawnUnitCost("RANGER", 25, v014), 20);
});

test("v0.14 反向验证：v0.11 价格函数忽略 population（版本隔离生效）", () => {
  // 若有人把动态公式无条件接到 v0.11 路径，pop=21 会返回 7（红）；
  // 版本隔离正确时 v0.11 恒返回 base 价 5（绿）。
  assert.equal(spawnUnitCost("WORKER", 21, v011), 5);
  assert.equal(spawnUnitCost("WORKER", 100, v011), 5);
  assert.notEqual(spawnUnitCost("WORKER", 21, v011), spawnUnitCost("WORKER", 21, v014));
});

test("v0.14: computeUnitCost 只接受 v0.14 manifest（编译期版本隔离）", () => {
  // 编译期：v0.11 manifest 传给 v0.14-only 函数必须是类型错误（union 拒绝）。
  // 闭包只做类型检查，运行时不调用（@ts-expect-error 行在 type-strip 后仍会执行）。
  // @ts-expect-error v0.11 manifest 不能传给 v0.14-only 函数
  const compileTimeCheck = (): number => computeUnitCost("WORKER", 21, v011);
  assert.equal(compileTimeCheck, compileTimeCheck); // 仅引用，不执行
  assert.equal(v014.rulesVersion, "v0.14");
});
