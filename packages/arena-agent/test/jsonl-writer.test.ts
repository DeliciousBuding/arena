/**
 * jsonl-writer 脱敏测试（W30 遥测脱敏修复）。
 *
 * 验收口径：
 * - hash 字段白名单：configHash/strategyHash/planHash 保留原文
 *   （不再恒为 sha256:[REDACTED]，配置漂移审计链保持区分度）；
 * - 文本级：sha256: 之后的 hex 是 hash 标识（前缀本身不得误脱敏），
 *   不被通用 ≥32 位长串规则吞掉；
 * - 真实 secret（sk- / ghp_ / ≥32 位随机 token / 无前缀裸 64 位 hex）仍脱敏；
 * - 反向验证：构造 secret 确认仍被 [REDACTED]（回归护栏，会红即修复失败）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runtimeTrace, type RuntimeTraceRecord } from "../src/telemetry/decision-trace.ts";
import { JsonlWriter, sanitizeText, sanitizeValue } from "../src/telemetry/jsonl-writer.ts";

/** sha256("") 的 64 位 hex——真实 sha256 形态（configHash/strategyHash 的实际值）。 */
const SHA256_64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** 32 位 hex——planHash 若升级为 sha256 摘要也需白名单保护。 */
const HEX_32 = "0123456789abcdef0123456789abcdef";

test("W30：configHash/strategyHash/planHash 保留原文（不再恒为 sha256:[REDACTED]）", () => {
  const record = {
    configHash: `sha256:${SHA256_64}`,
    strategyHash: `sha256:${SHA256_64}`,
    planHash: HEX_32,
  };
  const sanitized = sanitizeValue(record) as typeof record;
  assert.equal(sanitized.configHash, `sha256:${SHA256_64}`, "configHash 必须保留原文（审计链区分键）");
  assert.equal(sanitized.strategyHash, `sha256:${SHA256_64}`, "strategyHash 必须保留原文");
  assert.equal(sanitized.planHash, HEX_32, "planHash 必须保留原文");
  assert.ok(JSON.stringify(sanitized).includes(SHA256_64), "64 位 hash 值必须完整保留");
  assert.ok(!JSON.stringify(sanitized).includes("[REDACTED]"), "hash 字段不得出现 [REDACTED]");
});

test("W30：文本级 sha256: 前缀值不脱敏；无前缀裸 64 位 hex 仍脱敏", () => {
  const text = `config=sha256:${SHA256_64} note=${SHA256_64}`;
  const sanitized = sanitizeText(text);
  assert.ok(sanitized.includes(`sha256:${SHA256_64}`), "sha256: 前缀 + 值都是 hash 标识，必须原样保留");
  assert.ok(!sanitized.includes("note=" + SHA256_64), "无前缀裸 64 位串仍是疑似凭据，必须脱敏");
  assert.ok(sanitized.includes("note=[REDACTED]"), "裸 64 位串应替换为 [REDACTED]");
});

test("W30：真实 secret 仍脱敏——sk- / ghp_ / ≥32 位随机 token", () => {
  const sk = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const ghp = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const randomToken = "AbCdEf0123456789AbCdEf0123456789"; // 32 位无连字符
  assert.equal(sanitizeText(sk), "[REDACTED]", "sk- 前缀凭据必须整体替换");
  assert.ok(!sanitizeText(ghp).includes("abcdefghijklmnopqrstuvwxyz123456"), "ghp_ token 值必须脱敏");
  assert.equal(sanitizeText(randomToken), "[REDACTED]", "≥32 位随机 token 必须脱敏");
});

test("W30 反向验证：secret 形态不因白名单/前缀规则外溢而漏脱敏（回归护栏）", () => {
  // 若实现把"64 位串整体"或"任何长串"误判为 hash，此测试立即转红
  const sneaky = {
    runId: "abcdefghijklmnopqrstuvwxyzABCDEFG", // 33 位随机串（无 key 名提示）
    submitError: `upstream rejected sk-abcdefghijklmnopqrstuvwxyz123456 sha256:${SHA256_64}`,
    nested: { note: "ghp_abcdefghijklmnopqrstuvwxyz123456" },
  };
  const sanitized = sanitizeValue(sneaky) as typeof sneaky;
  assert.equal(sanitized.runId, "[REDACTED]", "非 hash 字段的 ≥32 位串必须脱敏");
  assert.ok(
    !sanitized.submitError.includes("sk-abcdefghijklmnopqrstuvwxyz123456"),
    "错误文本内嵌 sk- 凭据必须脱敏",
  );
  assert.ok(
    sanitized.submitError.includes(`sha256:${SHA256_64}`),
    "错误文本内嵌 sha256: 值仍保留（hash 标识）",
  );
  assert.ok(
    !JSON.stringify(sanitized.nested).includes("abcdefghijklmnopqrstuvwxyz123456"),
    "嵌套 ghp_ 值必须脱敏",
  );
});

test("W30：JsonlWriter 落盘——hash 保留原文、同记录 secret 仍脱敏", () => {
  const path = join(mkdtempSync(join(tmpdir(), "jsonl-writer-")), "runtime.jsonl");
  const writer = new JsonlWriter(path);
  writer.write(runtimeTrace({
    tick: 1000,
    runId: "sk-abcdefghijklmnop123456",
    deadlineOutcome: "candidate",
    agentLatencyMs: 100,
    selectionLatencyMs: 150,
    abortRequested: false,
    rotationGeneration: 0,
    configHash: `sha256:${SHA256_64}`,
    strategyHash: `sha256:${SHA256_64}`,
    submitResult: "accepted",
  }));
  writer.close();
  const line = readFileSync(path, "utf-8").trim();
  const parsed = JSON.parse(line) as RuntimeTraceRecord;
  assert.equal(parsed.configHash, `sha256:${SHA256_64}`, "落盘 configHash 保留原文");
  assert.equal(parsed.strategyHash, `sha256:${SHA256_64}`, "落盘 strategyHash 保留原文");
  assert.equal(parsed.runId, "[REDACTED]", "同记录 secret 形态仍脱敏");
  assert.ok(!line.includes("sk-abcdefghijklmnop123456"), "凭据不得落盘");
});
