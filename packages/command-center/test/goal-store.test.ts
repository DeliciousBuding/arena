import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGoalMutation, type GoalEntry } from "../lib/goal-store.ts";

const T = 1_700_000_000_000;

function goal(overrides: Partial<GoalEntry> = {}): GoalEntry {
  return {
    id: "goal-1",
    unitId: "u1",
    kind: "goto",
    target: [10, 20],
    createdAt: new Date(T - 10_000).toISOString(), // 10s 前：默认 30s 窗口内
    ...overrides,
  };
}

test("同单位同目标窗口内重复 → deduped（不重写）", () => {
  const store = { goals: [goal()] };
  const result = applyGoalMutation(
    store,
    { unitId: "u1", kind: "goto", target: [10, 20] },
    T,
  );
  assert.equal(result.outcome.applied, false);
  assert.equal(result.outcome.reason, "deduped");
  assert.equal(result.goals, store.goals, "dedupe 必须原样返回，调用方跳过写盘");
});

test("同单位同目标窗口外重复 → applied（replaced=true，重写）", () => {
  const store = { goals: [goal()] };
  const result = applyGoalMutation(
    store,
    { unitId: "u1", kind: "goto", target: [10, 20] },
    T + 31_000,
  );
  assert.equal(result.outcome.applied, true);
  assert.equal(result.outcome.replaced, true);
  assert.equal(result.goals.length, 1);
  assert.equal(result.goals[0].id, result.outcome.goalId);
  assert.notEqual(result.goals[0].id, "goal-1");
});

test("同单位不同目标 → applied（覆盖旧 goal）", () => {
  const store = { goals: [goal()] };
  const result = applyGoalMutation(
    store,
    { unitId: "u1", kind: "goto", target: [-603, -161] },
    T,
  );
  assert.equal(result.outcome.applied, true);
  assert.equal(result.outcome.replaced, true);
  assert.deepEqual(result.goals[0].target, [-603, -161]);
});

test("同单位同目标但 kind 不同 → applied（mine vs goto 是不同意图）", () => {
  const store = { goals: [goal()] };
  const result = applyGoalMutation(
    store,
    { unitId: "u1", kind: "mine", target: [10, 20] },
    T,
  );
  assert.equal(result.outcome.applied, true);
  assert.equal(result.goals[0].kind, "mine");
});

test("新单位 → applied（replaced=false，追加）", () => {
  const store = { goals: [goal()] };
  const result = applyGoalMutation(
    store,
    { unitId: "u2", kind: "goto", target: [5, 5] },
    T,
  );
  assert.equal(result.outcome.applied, true);
  assert.equal(result.outcome.replaced, false);
  assert.equal(result.goals.length, 2);
});

test("自定义去重窗口（policy 注入）", () => {
  const store = { goals: [goal()] };
  const fresh = applyGoalMutation(
    store,
    { unitId: "u1", kind: "goto", target: [10, 20] },
    T,
    { dedupeWindowMs: 60_000 },
  );
  assert.equal(fresh.outcome.applied, false, "60s 窗口内仍应去重");
  const expired = applyGoalMutation(
    store,
    { unitId: "u1", kind: "goto", target: [10, 20] },
    T + 61_000,
    { dedupeWindowMs: 60_000 },
  );
  assert.equal(expired.outcome.applied, true);
});
