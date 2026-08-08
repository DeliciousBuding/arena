/**
 * 迁移节奏决策测试（migration-system-v1 §3.2，评审 P2-1）：
 * MOVE burst 推进/达标/威胁暂停、SETTLE readiness 主导退出/硬上限、
 * 节奏指标 coreReceptiveRatio（≈65.2%@8/60）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decidePacing,
  coreReceptiveRatio,
  idealEtaTicks,
  observedEtaTicks,
  type PacingInput,
} from "../src/migration/pacing.ts";

function input(overrides: Partial<PacingInput>): PacingInput {
  return {
    phase: "LEG_MOVE",
    coreState: "NORMAL",
    cellsThisLeg: 2,
    burstCells: 8,
    cargoWorkerCount: 0,
    stragglersReady: true,
    nearMinesRemaining: 0,
    settleElapsed: 0,
    minSettle: 30,
    maxSettle: 120,
    settleTarget: 60,
    threatLevel: 0,
    ...overrides,
  };
}

test("pacing: MOVE 未达 burst 且核心 NORMAL → advance", () => {
  const result = decidePacing(input({}));
  assert.equal(result.decision, "advance");
});

test("pacing: 核心 MOVING → wait_moving（引擎 4 tick/格，等到达）", () => {
  const result = decidePacing(input({ coreState: "MOVING" }));
  assert.equal(result.decision, "wait_moving");
});

test("pacing: burst 达标 → burst_exhausted（应转休整）", () => {
  const result = decidePacing(input({ cellsThisLeg: 8 }));
  assert.equal(result.decision, "burst_exhausted");
});

test("pacing: 威胁档 ≥1 → hold（暂停推进）", () => {
  const result = decidePacing(input({ threatLevel: 1 }));
  assert.equal(result.decision, "hold");
});

test("pacing: DEFENSIVE_HOLD → hold", () => {
  const result = decidePacing(input({ phase: "DEFENSIVE_HOLD" }));
  assert.equal(result.decision, "hold");
});

test("pacing: SETTLE readiness 达成（≥minSettle + 货清 + 尾巴就绪）→ settle_done", () => {
  const result = decidePacing(
    input({ phase: "LEG_SETTLE", settleElapsed: 35, cargoWorkerCount: 0, stragglersReady: true }),
  );
  assert.equal(result.decision, "settle_done");
});

test("pacing: SETTLE 未满 minSettle → settle_continue（哪怕货清）", () => {
  const result = decidePacing(
    input({ phase: "LEG_SETTLE", settleElapsed: 20, cargoWorkerCount: 0, stragglersReady: true }),
  );
  assert.equal(result.decision, "settle_continue");
});

test("pacing: SETTLE 满 minSettle 但满载 worker 未清 → settle_continue", () => {
  const result = decidePacing(
    input({ phase: "LEG_SETTLE", settleElapsed: 40, cargoWorkerCount: 3, stragglersReady: true }),
  );
  assert.equal(result.decision, "settle_continue");
});

test("pacing: SETTLE 达硬上限 → settle_done（强制续迁）", () => {
  const result = decidePacing(
    input({ phase: "LEG_SETTLE", settleElapsed: 120, cargoWorkerCount: 2, stragglersReady: false }),
  );
  assert.equal(result.decision, "settle_done");
});

test("pacing: 非迁移窗口（PLAN/ABORT 等）→ hold", () => {
  for (const phase of ["PLAN", "ABORT", "ARRIVED", "RECOVERY_ABORT"] as const) {
    assert.equal(decidePacing(input({ phase })).decision, "hold", phase);
  }
});

test("pacing: coreReceptiveRatio 默认 8/60 ≈ 65.2%", () => {
  const ratio = coreReceptiveRatio(8, 60);
  assert.ok(Math.abs(ratio - 0.6521739) < 1e-6, `ratio=${ratio}`);
  assert.equal(coreReceptiveRatio(8, 0), 0); // 无休整 = 零可接收窗口
  assert.equal(coreReceptiveRatio(0, 60), 0); // 非法输入
});

test("pacing: ETA 模型与实测", () => {
  assert.equal(idealEtaTicks(555, 0, 60), 2220); // 555 格 × 4 tick/格
  assert.equal(idealEtaTicks(555, 3, 60), 2400); // + 3 腿 × 60 休整
  assert.equal(observedEtaTicks(555, 0.05), 11100); // 实测 0.05 格/tick 外推
  assert.equal(observedEtaTicks(555, 0), Number.POSITIVE_INFINITY); // 无速率
});
