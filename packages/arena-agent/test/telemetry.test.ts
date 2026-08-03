/**
 * 遥测层测试（切片 4 阶段 5，Agent C 地界 + leader 补齐）。
 *
 * 验收口径：三流工厂字段齐全、JSONL 落盘完整可解析、递归脱敏、
 * 校验失败抛错不落盘、close 后拒绝、非阻塞写入 errorCount 计数。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decisionTrace,
  outcomeTrace,
  runtimeTrace,
  type DecisionTraceRecord,
  type OutcomeTraceRecord,
  type RuntimeTraceRecord,
} from "../src/telemetry/decision-trace.ts";
import { JsonlWriter, sanitizeText, sanitizeValue } from "../src/telemetry/jsonl-writer.ts";

const RT: Omit<RuntimeTraceRecord, "processRunId" | "tenantId"> = {
  tick: 1000,
  runId: "run-1",
  deadlineOutcome: "candidate",
  agentLatencyMs: 100,
  selectionLatencyMs: 150,
  abortRequested: false,
  rotationGeneration: 0,
  submitResult: "accepted",
};

const DT: Omit<DecisionTraceRecord, "processRunId" | "tenantId"> = {
  tick: 1000,
  runId: "run-1",
  decisionSource: "hybrid",
  agentActionCount: 2,
  safetyReplacementCount: 1,
  invalidAgentActionCount: 0,
  repairCount: 0,
  planHash: "sha256:abc",
};

const OT: Omit<OutcomeTraceRecord, "processRunId" | "tenantId"> = {
  tick: 1000,
  coreResourcesBefore: 5,
  coreResourcesAfter: 7,
  coreResourceDelta: 2,
  failedEvents: [{
    eventType: "UNIT_MOVE_FAILED",
    reasonCode: "blocked",
    actorId: "w1",
    targetId: null,
    position: [2, 3],
    priorAction: '{"type":"MOVE","direction":"RIGHT"}',
    priorIntent: "return_home",
  }],
  events: ["DEPOSIT 2"],
};

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "telemetry-")), "traces.jsonl");
}

test("runtimeTrace 字段齐全且默认值生效", () => {
  const record = runtimeTrace(RT);
  assert.equal(record.processRunId, "unknown");
  assert.equal(record.tenantId, "unknown");
  assert.equal(record.tick, 1000);
  assert.equal(record.deadlineOutcome, "candidate");
  assert.equal(record.submitResult, "accepted");
});

test("decisionTrace 字段齐全", () => {
  const record = decisionTrace(DT);
  assert.equal(record.decisionSource, "hybrid");
  assert.equal(record.planHash, "sha256:abc");
});

test("outcomeTrace 字段齐全", () => {
  const record = outcomeTrace(OT);
  assert.equal(record.coreResourceDelta, 2);
  assert.deepEqual(record.events, ["DEPOSIT 2"]);
  assert.equal(record.failedEvents?.[0]?.reasonCode, "blocked");
  assert.equal(record.failedEvents?.[0]?.priorIntent, "return_home");
});

test("工厂缺必填字段 → 抛错（fail-fast 不静默）", () => {
  assert.throws(() => runtimeTrace({ ...RT, runId: undefined as never }));
  assert.throws(() => decisionTrace({ ...DT, planHash: undefined as never }));
});

test("JsonlWriter 写 3 条 → 逐行 JSON 完整可解析且顺序一致", () => {
  const path = tempFile();
  const writer = new JsonlWriter(path);
  writer.write(runtimeTrace(RT));
  writer.write(decisionTrace(DT));
  writer.write(outcomeTrace(OT));
  writer.close();
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  assert.equal(lines.length, 3);
  const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(parsed[0].runId, "run-1");
  assert.equal(parsed[1].decisionSource, "hybrid");
  assert.equal(parsed[2].coreResourceDelta, 2);
});

test("脱敏：API key/Authorization/token/长随机串全部替换为 [REDACTED]", () => {
  const dirty: RuntimeTraceRecord = runtimeTrace({
    ...RT,
    runId: "sk-abcdefghijklmnop123456",
  });
  const text = sanitizeText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456, key="sk-1234567890abcdef", ARENA_HERO_API_KEY_1=supersecrettoken1234567890123456');
  assert.ok(!text.includes("Bearer"), "Bearer token 必须脱敏");
  assert.ok(!text.includes("sk-1234567890"), "API key 必须脱敏");
  assert.ok(!text.includes("supersecrettoken"), "env token 必须脱敏");
  const sanitized = sanitizeValue(dirty) as { runId: string };
  assert.equal(sanitized.runId, "[REDACTED]");
});

test("脱敏只动疑似凭据：正常文本原样保留", () => {
  const text = sanitizeText('tick=100 resources=6 population=3 plan=deposit');
  assert.equal(text, 'tick=100 resources=6 population=3 plan=deposit');
});

test("非法记录 → write 抛错且不落盘", () => {
  const path = tempFile();
  const writer = new JsonlWriter(path);
  assert.throws(() => writer.write({ bad: true } as never));
  assert.equal(existsSync(path), false, "非法记录不得创建文件（校验失败不落盘）");
  writer.close();
});

test("close 后 write 抛错；droppedCount 在 IO 失败时递增", () => {
  const writer = new JsonlWriter(tempFile());
  writer.close();
  assert.throws(() => writer.write(runtimeTrace(RT)), /closed/);
  // IO 失败路径：写到一个不存在目录的文件（父目录不存在）→ appendFileSync 抛错 → 计数
  const badWriter = new JsonlWriter(join(tmpdir(), "no-such-dir-xyz", "t.jsonl"));
  badWriter.write(runtimeTrace(RT));
  assert.equal(badWriter.droppedCount, 1, "IO 失败计入 droppedCount，不抛给决策路径");
});

test("递归脱敏：嵌套对象与数组内的凭据也被替换", () => {
  const nested = {
    meta: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456" },
    list: ["token-abcdefghijklmnop12345678901234567890"],
    ok: "tick=5",
  };
  const sanitized = sanitizeValue(nested) as typeof nested;
  assert.ok(!JSON.stringify(sanitized).includes("abcdefghijklmnop"), "嵌套凭据必须脱敏");
  assert.equal(sanitized.ok, "tick=5");
});

test("脱敏不误伤 UUID runId（遥测关联键）", () => {
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(sanitizeText(uuid), uuid, "UUID 含连字符，不是疑似凭据");
  const runId = "123e4567-e89b-42d3-a456-426614174000:t1:1000:0";
  assert.equal(sanitizeText(runId), runId, "runId（UUID:租户:tick:seq）必须原样保留");
});

test("≥32 位纯字母数字串仍脱敏（密钥形如无连字符长串）", () => {
  const secret = "abcdefghijklmnopqrstuvwxyzABCDEFG"; // 33 位无连字符
  assert.equal(sanitizeText(secret), "[REDACTED]");
});
