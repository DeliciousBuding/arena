/**
 * 决策停摆 run 识别测试（2026-08-07，t2 实证后新增）：
 * loadStallRuns——decision telemetry 中 agentActionCount==0 且
 * moveCount==0 占比 >=80% 的 processRunId 判定为停摆 run（builder
 * 对其实行 stall-run quarantine，防止 WAIT 决策污染训练数据）。
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadStallRuns } from "../src/sim/dataset/builder.ts";

const STALL_RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTIVE_RUN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHORT_RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NL = String.fromCharCode(10);

function decisionRow(runId: string, tick: number, actionCount: number, moveCount: number): string {
  return JSON.stringify({
    processRunId: runId,
    tenantId: "t9",
    tick,
    decisionSource: "deterministic",
    agentActionCount: actionCount,
    safetyReplacementCount: 0,
    invalidAgentActionCount: 0,
    moveCount,
    harvestCount: 0,
    depositCount: 0,
  });
}

function writeDecision(rows: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "stall-runs-"));
  const path = join(dir, "decision.jsonl");
  writeFileSync(path, rows.join(NL) + NL, "utf8");
  return path;
}

test("loadStallRuns：100% zero-action run 判定为停摆（t2 死锁特征）", () => {
  const rows = Array.from({ length: 50 }, (_, i) => decisionRow(STALL_RUN, 1000 + i, 0, 0));
  const stall = loadStallRuns(writeDecision(rows));
  assert.ok(stall.has(STALL_RUN), "全 0 动作 run 应判定停摆");
});

test("loadStallRuns：活跃 run（move>0）不判定", () => {
  const rows = Array.from({ length: 50 }, (_, i) => decisionRow(ACTIVE_RUN, 1000 + i, 3, 3));
  const stall = loadStallRuns(writeDecision(rows));
  assert.equal(stall.has(ACTIVE_RUN), false, "有动作 run 不判定");
});

test("loadStallRuns：92% zero-action（t2 实测比例）判定停摆", () => {
  const rows = Array.from({ length: 100 }, (_, i) => decisionRow(STALL_RUN, 1000 + i, 0, 0));
  for (let i = 92; i < 100; i += 1) {
    rows[i] = decisionRow(STALL_RUN, 1000 + i, 2, 2);
  }
  const stall = loadStallRuns(writeDecision(rows));
  assert.ok(stall.has(STALL_RUN), "92% zero-action 判定停摆");
});

test("loadStallRuns：短 run（<minRows）不判定（新 run 宽限）", () => {
  const rows = Array.from({ length: 5 }, (_, i) => decisionRow(SHORT_RUN, 1000 + i, 0, 0));
  const stall = loadStallRuns(writeDecision(rows));
  assert.equal(stall.has(SHORT_RUN), false, "5 行短 run 不判定（宽限）");
});

test("loadStallRuns：混合 run 只判定停摆者", () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => decisionRow(STALL_RUN, 1000 + i, 0, 0)),
    ...Array.from({ length: 30 }, (_, i) => decisionRow(ACTIVE_RUN, 2000 + i, 4, 4)),
  ];
  const stall = loadStallRuns(writeDecision(rows));
  assert.ok(stall.has(STALL_RUN));
  assert.equal(stall.has(ACTIVE_RUN), false);
});

test("loadStallRuns：文件不存在返回空集（新 run 无遥测宽限）", () => {
  const stall = loadStallRuns(join(tmpdir(), "definitely-missing-decision.jsonl"));
  assert.equal(stall.size, 0);
});
