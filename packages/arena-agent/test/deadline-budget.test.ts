import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeClock, MonotonicClock, nowMs } from "../src/runtime/clock.ts";
import {
  createDeadlineBudget,
  deadlineOf,
  isExpired,
  timeUntil,
  validateBudget,
  type DeadlineConfig,
  type DeadlineStage,
} from "../src/runtime/deadline-budget.ts";

const CFG: DeadlineConfig = { agentSoftMs: 100, selectionMs: 200, submitMs: 300, hardMs: 400 };
const STAGES: readonly DeadlineStage[] = ["agentSoft", "selection", "submit", "hard"];

function budget(receivedAt = 5_000, cfg: DeadlineConfig = CFG) {
  return createDeadlineBudget(receivedAt, cfg);
}

// ---------- FakeClock ----------

test("FakeClock starts at injected initial value and advances exactly", () => {
  const clock = new FakeClock(1_000);
  assert.equal(clock.now(), 1_000);
  assert.equal(clock.advance(250), 1_250);
  assert.equal(clock.now(), 1_250);
  assert.equal(clock.advance(0), 1_250);
  assert.equal(clock.advance(0.5), 1_250.5);
  assert.equal(clock.now(), 1_250.5);
});

test("FakeClock defaults to zero", () => {
  const clock = new FakeClock();
  assert.equal(clock.now(), 0);
});

test("FakeClock rejects negative, NaN and Infinity advance", () => {
  const clock = new FakeClock();
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => clock.advance(bad), RangeError);
    assert.equal(clock.now(), 0, "failed advance must not move the clock");
  }
});

test("MonotonicClock and nowMs return finite, non-decreasing values", () => {
  const clock = new MonotonicClock();
  const first = clock.now();
  assert.equal(Number.isFinite(first), true);
  assert.equal(Number.isFinite(nowMs()), true);
  assert.equal(clock.now() >= first, true, "monotonic clock must not go backwards");
  assert.equal(nowMs() >= first, true);
});

// ---------- createDeadlineBudget ----------

test("createDeadlineBudget computes absolute deadlines from receivedAt", () => {
  const b = budget(5_000);
  assert.equal(b.receivedAtMonotonic, 5_000);
  assert.equal(b.agentSoftDeadline, 5_100);
  assert.equal(b.selectionDeadline, 5_200);
  assert.equal(b.submitDeadline, 5_300);
  assert.equal(b.hardDeadline, 5_400);
});

test("createDeadlineBudget allows a zero offset while keeping strict order", () => {
  const b = createDeadlineBudget(10, { agentSoftMs: 0, selectionMs: 1, submitMs: 2, hardMs: 3 });
  assert.equal(b.agentSoftDeadline, 10);
  assert.equal(b.hardDeadline, 13);
});

test("createDeadlineBudget rejects soft >= selection", () => {
  assert.throws(() => budget(0, { ...CFG, agentSoftMs: 200, selectionMs: 200 }), RangeError);
  assert.throws(() => budget(0, { ...CFG, agentSoftMs: 300, selectionMs: 200 }), RangeError);
});

test("createDeadlineBudget rejects selection >= submit", () => {
  assert.throws(() => budget(0, { ...CFG, selectionMs: 300, submitMs: 300 }), RangeError);
  assert.throws(() => budget(0, { ...CFG, selectionMs: 400, submitMs: 300 }), RangeError);
});

test("createDeadlineBudget rejects submit >= hard", () => {
  assert.throws(() => budget(0, { ...CFG, submitMs: 400, hardMs: 400 }), RangeError);
  assert.throws(() => budget(0, { ...CFG, submitMs: 500, hardMs: 400 }), RangeError);
});

test("createDeadlineBudget rejects negative offsets", () => {
  for (const key of ["agentSoftMs", "selectionMs", "submitMs", "hardMs"] as const) {
    assert.throws(() => budget(0, { ...CFG, [key]: -1 }), RangeError, `offset ${key} must be rejected`);
  }
});

test("createDeadlineBudget rejects NaN and Infinity offsets", () => {
  for (const key of ["agentSoftMs", "selectionMs", "submitMs", "hardMs"] as const) {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.throws(
        () => budget(0, { ...CFG, [key]: bad }),
        RangeError,
        `offset ${key}=${bad} must be rejected`,
      );
    }
  }
});

test("createDeadlineBudget rejects non-finite receivedAtMonotonic", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => budget(bad), RangeError);
  }
});

// ---------- isExpired / timeUntil ----------

test("boundary: now === deadline is already expired", () => {
  const b = budget(5_000);
  for (const stage of STAGES) {
    const deadline = deadlineOf(b, stage);
    assert.equal(isExpired(b, deadline, stage), true, `${stage}: now === deadline must be expired`);
    assert.equal(timeUntil(b, deadline, stage), 0);
    assert.equal(isExpired(b, deadline - 1, stage), false, `${stage}: now < deadline must not be expired`);
  }
});

test("isExpired: at receivedAt nothing is expired; stages expire in order", () => {
  const b = budget(0);
  for (const stage of STAGES) {
    assert.equal(isExpired(b, 0, stage), false, `${stage} must not be expired at receivedAt`);
  }
  assert.equal(isExpired(b, 101, "agentSoft"), true);
  assert.equal(isExpired(b, 101, "selection"), false);
  assert.equal(isExpired(b, 101, "submit"), false);
  assert.equal(isExpired(b, 101, "hard"), false);
  // 精确压线：selection 过期时 agentSoft 必然已过期，submit/hard 未过期
  assert.equal(isExpired(b, 200, "agentSoft"), true);
  assert.equal(isExpired(b, 200, "selection"), true);
  assert.equal(isExpired(b, 200, "submit"), false);
  assert.equal(isExpired(b, 200, "hard"), false);
  // 全部过期
  assert.equal(isExpired(b, 401, "hard"), true);
});

test("timeUntil returns remaining ms and goes negative after deadline", () => {
  const b = budget(5_000);
  assert.equal(timeUntil(b, 5_000, "agentSoft"), 100);
  assert.equal(timeUntil(b, 5_000, "selection"), 200);
  assert.equal(timeUntil(b, 5_000, "submit"), 300);
  assert.equal(timeUntil(b, 5_000, "hard"), 400);
  assert.equal(timeUntil(b, 5_250, "selection"), -50);
  assert.equal(timeUntil(b, 5_400, "hard"), 0);
  assert.equal(timeUntil(b, 5_401, "hard"), -1);
});

test("isExpired/timeUntil agree with each other", () => {
  const b = budget(5_000);
  for (const now of [4_999, 5_000, 5_100, 5_150, 5_300, 5_400, 5_401, 10_000]) {
    for (const stage of STAGES) {
      assert.equal(isExpired(b, now, stage), timeUntil(b, now, stage) <= 0, `now=${now} ${stage}`);
    }
  }
});

// ---------- validateBudget ----------

test("validateBudget accepts a valid budget", () => {
  assert.deepEqual(validateBudget(budget()), { valid: true });
});

test("validateBudget rejects broken order", () => {
  const b = budget();
  const swap = { ...b, submitDeadline: b.hardDeadline, hardDeadline: b.submitDeadline };
  const v = validateBudget(swap);
  assert.equal(v.valid, false);
  assert.match(v.reason ?? "", /receivedAtMonotonic <= agentSoftDeadline < selectionDeadline/);
});

test("validateBudget rejects non-finite fields", () => {
  for (const key of [
    "receivedAtMonotonic",
    "agentSoftDeadline",
    "selectionDeadline",
    "submitDeadline",
    "hardDeadline",
  ] as const) {
    const v = validateBudget({ ...budget(), [key]: Number.NaN });
    assert.equal(v.valid, false, `${key}=NaN must be invalid`);
    assert.match(v.reason ?? "", /must be a finite number/);
    const inf = validateBudget({ ...budget(), [key]: Number.POSITIVE_INFINITY });
    assert.equal(inf.valid, false, `${key}=Infinity must be invalid`);
  }
});

test("validateBudget rejects receivedAt after agentSoftDeadline", () => {
  const b = budget();
  const v = validateBudget({ ...b, receivedAtMonotonic: b.selectionDeadline });
  assert.equal(v.valid, false);
});
