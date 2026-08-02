/**
 * Prompt Builder + StrategyMemory 测试（切片 4C，9 例，0 skip）。
 *
 * 验收口径（切片规格 + leader 契约补充）：
 * - 五段齐全且顺序正确（按标题定位）；
 * - 第 3 段含当前 tick 与全部受控单位 UUID；换 tick 后旧 tick 数字消失（当前 Tick 覆盖旧事实）；
 * - 旧 Tick 单位 UUID 不得出现在新 prompt；
 * - memory 段：空 → 无摘要行；3 条 → 恰好 3 行摘要 + 趋势行 + 失败统计行；30 条 → 只留最近 20；
 * - deterministic：同输入两次构建逐字节相等；
 * - 规则段含全部硬规则关键词；runId/tick/stateHash 透传，换 runId 后旧 runId 不残留；
 * - 长状态（30 单位）不炸。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDecisionPrompt,
  PROMPT_SECTION_TITLES,
  type DecisionPromptInput,
} from "../src/infrastructure/pi/prompt-builder.ts";
import {
  DEFAULT_MEMORY_CAPACITY,
  StrategyMemory,
} from "../src/infrastructure/pi/strategy-memory.ts";
import type { TickState, UnitSnapshot } from "../src/domain/model.ts";
import type { DecisionContext } from "../src/runtime/decision-types.ts";

const STATE_HASH = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

function makeUnit(id: string, overrides: Partial<UnitSnapshot> = {}): UnitSnapshot {
  return { id, unitType: "WORKER", position: [0, 0], hp: 2, cargo: 0, ...overrides };
}

function makeState(tick: number, units: readonly UnitSnapshot[] = []): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 6,
    resourceCapacity: 10,
    resourceSpace: 4,
    population: 0,
    core: { id: "core-1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "buding" },
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: units.filter((u) => u.unitType === "VANGUARD"),
    rangers: units.filter((u) => u.unitType === "RANGER"),
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

function makeInput(state: TickState, memory: StrategyMemory, runId: string): DecisionPromptInput {
  const context: DecisionContext = {
    tenantId: "t1",
    tick: state.tick,
    stateHash: STATE_HASH,
    mapRevision: null,
    rulesVersion: "v0.11",
    configHash: "cfg-test",
    receivedAtMonotonic: 0,
  };
  return { state, context, memory, runId };
}

/** 提取第 index 段正文（标题之后、下一标题之前；末段到文尾）。 */
function sectionText(prompt: string, index: number): string {
  const start = prompt.indexOf(PROMPT_SECTION_TITLES[index]);
  assert.ok(start >= 0, `section ${index} title missing`);
  const next =
    index + 1 < PROMPT_SECTION_TITLES.length
      ? prompt.indexOf(PROMPT_SECTION_TITLES[index + 1], start + 1)
      : -1;
  const end = next < 0 ? prompt.length : next;
  return prompt.slice(start + PROMPT_SECTION_TITLES[index].length, end);
}

const ENTRY_LINE = /^- T\d+ \[(?:agent|safety)\]/gm;

function countEntries(text: string): number {
  return (text.match(ENTRY_LINE) ?? []).length;
}

// ---------- 五段结构 ----------

test("五个段落齐全且顺序正确（按标题定位）", () => {
  const memory = new StrategyMemory();
  const prompt = buildDecisionPrompt(makeInput(makeState(100, [makeUnit("u-1")]), memory, "t1-100-0"));
  let previous = -1;
  for (const title of PROMPT_SECTION_TITLES) {
    const idx = prompt.indexOf(title);
    assert.ok(idx >= 0, `标题缺失: ${title}`);
    assert.ok(idx > previous, `标题顺序错误: ${title}`);
    previous = idx;
  }
  assert.equal(prompt.indexOf(PROMPT_SECTION_TITLES[0]), 0, "prompt 必须以第 1 段标题开头");
});

// ---------- 当前 Tick 覆盖旧事实 ----------

test("第 3 段含当前 tick 与全部受控单位 UUID；换 tick 后旧 tick 数字消失", () => {
  const memory = new StrategyMemory();
  const unitsA = [makeUnit("u-a-1", { position: [1, 2] }), makeUnit("u-a-2", { unitType: "VANGUARD", position: [3, 4] })];
  const promptA = buildDecisionPrompt(makeInput(makeState(100, unitsA), memory, "t1-100-0"));
  const section3A = sectionText(promptA, 2);
  assert.ok(section3A.includes("tick: 100"), "第 3 段必须含当前 tick");
  for (const u of unitsA) {
    assert.ok(section3A.includes(u.id), `第 3 段必须含当前受控单位 ${u.id}`);
  }

  const promptB = buildDecisionPrompt(makeInput(makeState(101, unitsA), memory, "t1-101-1"));
  assert.ok(sectionText(promptB, 2).includes("tick: 101"), "新 tick 必须出现");
  assert.ok(!promptB.includes("tick: 100"), "旧 tick 数字必须从输出中消失");
  assert.ok(!promptB.includes("t1-100-0"), "旧 runId 也不得残留");
});

test("第 3 段不出现旧 Tick 的单位 UUID", () => {
  const memory = new StrategyMemory();
  const oldUnits = [makeUnit("u-stale-1"), makeUnit("u-stale-2")];
  // 先构建旧 tick 的 prompt（模拟会话里出现过旧单位），再换新状态
  buildDecisionPrompt(makeInput(makeState(100, oldUnits), memory, "t1-100-0"));
  const freshUnits = [makeUnit("u-fresh-1", { position: [5, 6] }), makeUnit("u-fresh-2")];
  const prompt = buildDecisionPrompt(makeInput(makeState(101, freshUnits), memory, "t1-101-0"));
  for (const u of freshUnits) {
    assert.ok(prompt.includes(u.id), `当前单位必须出现: ${u.id}`);
  }
  for (const u of oldUnits) {
    assert.ok(!prompt.includes(u.id), `旧 Tick 单位 UUID 不得出现: ${u.id}`);
  }
});

// ---------- 短期战略记忆 ----------

test("memory 段：空 memory 无摘要行；3 条 entry 恰好 3 行摘要 + 趋势行 + 失败统计行", () => {
  const memory = new StrategyMemory();
  const emptySnapshot = memory.snapshot();
  assert.equal(countEntries(emptySnapshot), 0, "空 memory 不得有摘要行");
  assert.match(emptySnapshot, /效率趋势: 累计资源收益 \+0 \(最近 0 条\)/);
  assert.match(emptySnapshot, /失败模式: safety 兜底 0\/0 \(0%\)/);

  memory.record({ tick: 1, source: "agent", planSummary: "派遣 worker 采集", outcome: "采集成功", resourcesGain: 2 });
  memory.record({ tick: 2, source: "agent", planSummary: "继续采集" });
  memory.record({ tick: 3, source: "safety", planSummary: "空计划兜底", outcome: "safety 接管", resourcesGain: 3 });

  const prompt = buildDecisionPrompt(makeInput(makeState(100), memory, "t1-100-0"));
  const section4 = sectionText(prompt, 3);
  assert.equal(countEntries(section4), 3, "恰好 3 行摘要");
  assert.match(section4, /^- T1 \[agent\] 派遣 worker 采集 \| 结果: 采集成功 \| 收益: \+2$/m);
  assert.match(section4, /^- T2 \[agent\] 继续采集$/m);
  assert.match(section4, /^- T3 \[safety\] 空计划兜底 \| 结果: safety 接管 \| 收益: \+3$/m);
  assert.match(section4, /效率趋势: 累计资源收益 \+5 \(最近 3 条\)/);
  assert.match(section4, /失败模式: safety 兜底 1\/3 \(33%\)/);
});

test("memory 有界：灌 30 条 → snapshot 只含最近 20 条", () => {
  const memory = new StrategyMemory();
  assert.equal(memory.capacity, DEFAULT_MEMORY_CAPACITY, "默认容量必须为 20");
  for (let tick = 1; tick <= 30; tick += 1) {
    memory.record({ tick, source: tick % 2 === 0 ? "agent" : "safety", planSummary: `计划 #${tick}` });
  }
  const snapshot = memory.snapshot();
  assert.equal(countEntries(snapshot), 20, "只保留最近 20 条");
  assert.ok(snapshot.includes("- T11 "), "最早保留的第 11 条必须存在");
  assert.ok(snapshot.includes("- T30 "), "最新的第 30 条必须存在");
  assert.ok(!snapshot.includes("- T1 "), "最早淘汰的第 1 条必须消失");
  assert.ok(!snapshot.includes("- T10 "), "第 10 条必须消失");
  assert.ok(snapshot.indexOf("- T11 ") < snapshot.indexOf("- T30 "), "摘要必须按时间序排列");
});

// ---------- 确定性 ----------

test("deterministic：同输入两次构建，字符串逐字节相等", () => {
  const memory = new StrategyMemory();
  memory.record({ tick: 1, source: "agent", planSummary: "采集", resourcesGain: 2 });
  const units = [makeUnit("u-1", { position: [1, 2] }), makeUnit("u-2", { unitType: "RANGER", position: [3, 4] })];
  const input = makeInput(makeState(42, units), memory, "t1-42-7");
  assert.equal(buildDecisionPrompt(input), buildDecisionPrompt(input));
  assert.equal(memory.snapshot(), memory.snapshot());
});

// ---------- 规则段 ----------

test("规则段含全部硬规则关键词", () => {
  const memory = new StrategyMemory();
  const prompt = buildDecisionPrompt(makeInput(makeState(100), memory, "t1-100-0"));
  const section5 = sectionText(prompt, 4);
  for (const keyword of [
    "arena_plan",
    "Safety",
    "保守",
    "第 3 段",
    "旧 Tick",
    "空 actions",
    "立即结束本轮",
    "runId",
    "stateHash",
  ]) {
    assert.ok(section5.includes(keyword), `规则段必须含关键词: ${keyword}`);
  }
});

test("规则段透传 runId/tick/stateHash；换 runId 后旧 runId 不在输出中", () => {
  const memory = new StrategyMemory();
  const runIdA = "t1-100-0";
  const promptA = buildDecisionPrompt(makeInput(makeState(100), memory, runIdA));
  const section5A = sectionText(promptA, 4);
  assert.ok(section5A.includes(`runId = ${runIdA}`), "规则段必须含本次 runId");
  assert.ok(section5A.includes("tick = 100"), "规则段必须含本次 tick");
  assert.ok(section5A.includes(`stateHash = ${STATE_HASH}`), "规则段必须含本次 stateHash");
  assert.ok(
    section5A.includes("调用 arena_plan 时参数必须携带这三个值"),
    "规则段必须要求 arena_plan 参数回传三个值",
  );

  const runIdB = "t1-101-1";
  const promptB = buildDecisionPrompt(makeInput(makeState(101), memory, runIdB));
  assert.ok(sectionText(promptB, 4).includes(`runId = ${runIdB}`), "新 runId 必须出现");
  assert.ok(!promptB.includes(runIdA), "旧 runId 不得残留");
});

// ---------- 长状态 ----------

test("长状态不炸：30 个单位 → prompt 可构建且含全部 30 个 UUID", () => {
  const memory = new StrategyMemory();
  const units: UnitSnapshot[] = [];
  for (let i = 0; i < 30; i += 1) {
    units.push(makeUnit(`u-30-${String(i).padStart(2, "0")}`, { position: [i, i % 5] }));
  }
  const prompt = buildDecisionPrompt(makeInput(makeState(500, units), memory, "t1-500-0"));
  for (const u of units) {
    assert.ok(prompt.includes(u.id), `长状态必须含 ${u.id}`);
  }
  assert.match(sectionText(prompt, 2), /controlled units \(30\):/);
});
