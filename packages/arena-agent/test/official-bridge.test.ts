import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAndMirrorOfficialManual,
  extractManualActions,
  hashMirror,
  type OfficialManualMirror,
  type ReceiptLike,
} from "../src/command-plane/official-bridge.ts";

function manualReceipt(overrides: Partial<ReceiptLike> = {}): ReceiptLike {
  return {
    source: "MANUAL",
    received_at: "2026-08-08T08:00:00.000Z",
    plan: {
      tick: 100,
      unit_actions: { u1: { type: "MOVE", direction: "UP" } },
      core_action: null,
    },
    ...overrides,
  };
}

test("无 MANUAL 回执 → none（不写盘不审计）", () => {
  const writes: OfficialManualMirror[] = [];
  const result = checkAndMirrorOfficialManual({ AGENT: manualReceipt({ source: "AGENT" }) }, {
    tenant: "t1",
    dataRoot: "/tmp/arena",
    writeMirror: (m) => writes.push(m),
    previousHash: null,
  });
  assert.equal(result.status, "none");
  assert.equal(writes.length, 0);
});

test("MANUAL 回执含动作 → mirrored + 写盘一次", () => {
  const writes: OfficialManualMirror[] = [];
  const receipts = { MANUAL: manualReceipt() };
  const result = checkAndMirrorOfficialManual(receipts, {
    tenant: "t1",
    dataRoot: "/tmp/arena",
    writeMirror: (m) => writes.push(m),
    previousHash: null,
  });
  assert.equal(result.status, "mirrored");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].commands.length, 1);
  assert.equal(writes[0].commands[0].unitId, "u1");
  assert.equal(writes[0].commands[0].action.type, "MOVE");
});

test("同内容重复 → unchanged（不重复写盘/审计）", () => {
  const writes: OfficialManualMirror[] = [];
  const receipts = { MANUAL: manualReceipt() };
  const first = checkAndMirrorOfficialManual(receipts, {
    tenant: "t1",
    dataRoot: "/tmp/arena",
    writeMirror: (m) => writes.push(m),
    previousHash: null,
  });
  assert.equal(first.status, "mirrored");
  const hash = hashMirror(first.mirror!);
  const second = checkAndMirrorOfficialManual(receipts, {
    tenant: "t1",
    dataRoot: "/tmp/arena",
    writeMirror: (m) => writes.push(m),
    previousHash: hash,
  });
  assert.equal(second.status, "unchanged");
  assert.equal(writes.length, 1, "同内容不得重复写盘");
});

test("内容变化（新动作）→ mirrored（重新写盘）", () => {
  const writes: OfficialManualMirror[] = [];
  const receipts = { MANUAL: manualReceipt() };
  const first = checkAndMirrorOfficialManual(receipts, {
    tenant: "t1",
    dataRoot: "/tmp/arena",
    writeMirror: (m) => writes.push(m),
    previousHash: null,
  });
  const hash = hashMirror(first.mirror!);
  const changed = { MANUAL: manualReceipt({ plan: { tick: 101, unit_actions: { u2: { type: "WAIT" } }, core_action: null } }) };
  const second = checkAndMirrorOfficialManual(changed, {
    tenant: "t1",
    dataRoot: "/tmp/arena",
    writeMirror: (m) => writes.push(m),
    previousHash: hash,
  });
  assert.equal(second.status, "mirrored");
  assert.equal(writes.length, 2);
});

test("core_action 提取（手动核心动作）", () => {
  const receipts = { MANUAL: manualReceipt({ plan: { tick: 100, unit_actions: {}, core_action: { type: "START_MOVE", direction: "DOWN" } } }) };
  const extracted = extractManualActions(receipts);
  assert.equal(extracted.coreAction?.type, "START_MOVE");
  const writes: OfficialManualMirror[] = [];
  const result = checkAndMirrorOfficialManual(receipts, {
    tenant: "t1",
    dataRoot: "/tmp/arena",
    writeMirror: (m) => writes.push(m),
    previousHash: null,
  });
  assert.equal(result.status, "mirrored");
  assert.equal(writes[0].coreAction?.type, "START_MOVE");
});

test("extractManualActions：无 plan → 空", () => {
  const extracted = extractManualActions({ MANUAL: { source: "MANUAL", received_at: "x" } });
  assert.equal(extracted.commands.length, 0);
  assert.equal(extracted.coreAction, null);
});
