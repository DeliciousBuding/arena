/**
 * 参赛条目注册表测试（arena-bench-v2 §3）：
 *  - 默认阵容 10 条目、id 唯一、kind 分类（8 python + 2 builtin）；
 *  - python 条目 entry(seed) 可构造（懒构建：不 spawn 子进程、不跑对局）；
 *  - 3 个变体按实际支持性降级为默认构造（configNote 注明）；
 *  - 内置条目 entry(seed).build() 返回实例不抛错（纯 TS 构造）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultContestants } from "../src/sim/opponent/contestants.ts";
import { DeterministicPlanner } from "../src/planning/deterministic-planner.ts";
import { SafetyPlanner } from "../src/strategies/safety-planner.ts";

const DEFAULT_CONTESTANT_IDS = [
  "farmer",
  "core",
  "waaiging",
  "tactic",
  "arena-evolve",
] as const;

const VARIANT_IDS = ["waaiging-agg", "core-mil", "farmer-eco"] as const;

const BUILTIN_IDS = ["ts-aggressive", "ts-safety"] as const;

test("contestants: 默认阵容 10 条目且 id 唯一", () => {
  const contestants = defaultContestants();
  assert.equal(contestants.length, 10);
  const ids = contestants.map((contestant) => contestant.id);
  assert.equal(new Set(ids).size, ids.length, "条目 id 必须唯一");
  for (const contestant of contestants) {
    assert.ok(contestant.label.length > 0, `${contestant.id} 必须有展示名`);
    assert.ok(contestant.configNote.length > 0, `${contestant.id} 必须有配置说明`);
  }
});

test("contestants: kind 分类——5 社区默认 + 3 变体为 python，2 内置为 builtin", () => {
  const contestants = defaultContestants();
  const byId = new Map(contestants.map((contestant) => [contestant.id, contestant]));
  for (const id of [...DEFAULT_CONTESTANT_IDS, ...VARIANT_IDS]) {
    assert.equal(byId.get(id)?.kind, "python", `${id} 应走 python 桥`);
  }
  for (const id of BUILTIN_IDS) {
    assert.equal(byId.get(id)?.kind, "builtin", `${id} 应为内置对照`);
  }
});

test("contestants: python 条目 entry(seed) 可构造（id 约定 <name>-s<seed>，不 spawn）", () => {
  const contestants = defaultContestants();
  for (const contestant of contestants.filter((entry) => entry.kind === "python")) {
    const tournEntry = contestant.entry(1);
    assert.equal(tournEntry.id, `${contestant.id}-s1`);
    assert.ok(tournEntry.desc.length > 0);
    // build 是懒构造：entry() 本身不启动 Python 子进程（只做注册表解析）。
    assert.equal(typeof tournEntry.build, "function");
  }
});

test("contestants: 三个变体按实际支持性降级为默认构造并注明", () => {
  const contestants = defaultContestants();
  for (const id of VARIANT_IDS) {
    const contestant = contestants.find((entry) => entry.id === id);
    assert.ok(contestant !== undefined, `缺 ${id}`);
    assert.ok(
      contestant!.configNote.startsWith("降级"),
      `${id} 应标注降级（实际: ${contestant!.configNote}）`,
    );
    // 降级 = entry 与默认条目同构造路径（registry 默认，无参数注入）
    const tournEntry = contestant!.entry(1);
    assert.equal(tournEntry.id, `${id}-s1`);
  }
});

test("contestants: ts-aggressive entry(1).build() 返回 DeterministicPlanner 实例", () => {
  const contestants = defaultContestants();
  const aggressive = contestants.find((entry) => entry.id === "ts-aggressive");
  assert.ok(aggressive !== undefined);
  const tournEntry = aggressive!.entry(1);
  assert.equal(tournEntry.id, "ts-aggressive");
  const planner = tournEntry.build();
  assert.ok(planner instanceof DeterministicPlanner, "ts-aggressive 应为 DeterministicPlanner");
  assert.equal(typeof planner.decide, "function");
});

test("contestants: ts-safety entry(1).build() 返回保守 SafetyPlanner 实例", () => {
  const contestants = defaultContestants();
  const safety = contestants.find((entry) => entry.id === "ts-safety");
  assert.ok(safety !== undefined);
  const tournEntry = safety!.entry(1);
  assert.equal(tournEntry.id, "ts-safety");
  const planner = tournEntry.build();
  assert.ok(planner instanceof SafetyPlanner, "ts-safety 应为 SafetyPlanner");
  // 保守默认：无 aggressive 覆盖，workerTarget=8（DEFAULT_SAFETY_CONFIG）
  assert.equal(planner.config.aggression, undefined);
  assert.equal(planner.config.workerTarget, 8);
});

test("contestants: 内置条目多 seed 构造互不影响（纯构造无状态泄漏）", () => {
  const contestants = defaultContestants();
  for (const id of BUILTIN_IDS) {
    const contestant = contestants.find((entry) => entry.id === id)!;
    const first = contestant.entry(1).build();
    const second = contestant.entry(2).build();
    assert.notEqual(first, second, "每 seed 应构造独立实例");
  }
});
