/**
 * 运行入口测试（切片 4 阶段 5，Agent B 地界，leader 接管）。
 *
 * 验收口径：config schema 校验、单写者锁（原子/PID 存活/陈旧回收/只删自己）、
 * manifest 写读、doctor 只读正反验证。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRuntimeConfig, resolveDeadlines, type TenantRuntimeConfig } from "../src/app/runtime-config.ts";
import { SingleWriterLock } from "../src/app/single-writer-lock.ts";
import {
  newProcessRunId,
  readGitSha,
  readSdkVersion,
  writeRunManifest,
  readRunManifest,
} from "../src/app/run-manifest.ts";
import { runDoctor } from "../src/cli/doctor.ts";

const VALID_CONFIG: TenantRuntimeConfig = {
  tenantId: "t1",
  arenaTokenEnv: "ARENA_HERO_API_KEY_1",
  decisionMode: "safety",
  submitEnabled: false,
  model: { provider: "newapi", id: "deepseek-v4-flash", thinkingLevel: "low" },
  baseDir: "runtime",
};

function writeConfig(config: TenantRuntimeConfig): string {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const path = join(dir, "tenant.json");
  writeFileSync(path, JSON.stringify(config), "utf-8");
  return path;
}

test("config：合法配置加载 + 默认 deadlines 生效", () => {
  const config = loadRuntimeConfig(writeConfig(VALID_CONFIG));
  assert.equal(config.tenantId, "t1");
  assert.deepEqual(resolveDeadlines(config), {
    agentSoftMs: 6000,
    selectionMs: 7000,
    submitMs: 8500,
    hardMs: 9500,
  });
  const withDeadlines = loadRuntimeConfig(
    writeConfig({ ...VALID_CONFIG, deadlines: { agentSoftMs: 1000, selectionMs: 2000, submitMs: 3000, hardMs: 4000 } }),
  );
  assert.equal(resolveDeadlines(withDeadlines).agentSoftMs, 1000);
});

test("config：非法配置（缺字段/错类型/额外字段）抛错", () => {
  assert.throws(() => loadRuntimeConfig(writeConfig({ ...VALID_CONFIG, tenantId: undefined } as never)), /invalid runtime config/);
  assert.throws(() => loadRuntimeConfig(writeConfig({ ...VALID_CONFIG, decisionMode: "evil" } as never)), /invalid runtime config/);
  assert.throws(() => loadRuntimeConfig(writeConfig({ ...VALID_CONFIG, extra: true } as never)), /additional propertie?s?/);
});

test("锁：acquire 成功、二次幂等、release 后可再 acquire", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const lock = new SingleWriterLock(dir, "t1", "run-1");
  await lock.acquire();
  assert.equal(lock.isHeld, true);
  await lock.acquire(); // 幂等
  assert.equal(lock.isHeld, true);
  await lock.release();
  assert.equal(lock.isHeld, false);
  await lock.acquire();
  await lock.release();
});

test("锁：他人活锁（本进程 PID）→ acquire 抛错，活锁绝不自动抢占", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const other = new SingleWriterLock(dir, "t1", "run-other");
  await other.acquire();
  const mine = new SingleWriterLock(dir, "t1", "run-mine");
  await assert.rejects(mine.acquire(), /live process/);
  assert.equal(mine.isHeld, false);
  await other.release();
});

test("锁：陈旧锁（PID 已死）→ 可回收重试", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  // 写入一个不存在的 PID（如 99999999）模拟崩溃遗留
  writeFileSync(
    join(dir, "t1.lock"),
    JSON.stringify({ pid: 99999999, processRunId: "run-dead", startedAt: new Date().toISOString() }),
    "utf-8",
  );
  const mine = new SingleWriterLock(dir, "t1", "run-mine");
  await mine.acquire(); // 陈旧锁回收成功
  assert.equal(mine.isHeld, true);
  await mine.release();
});

test("锁：release 只删自己的锁（他人锁不动）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const other = new SingleWriterLock(dir, "t1", "run-other");
  await other.acquire();
  // 用错误的 processRunId 尝试释放 → 不应删除他人锁
  const impostor = new SingleWriterLock(dir, "t1", "run-impostor");
  impostor.acquire().catch(() => {});
  await impostor.release(); // 未持有 → no-op
  assert.equal(impostor.isHeld, false);
  // 他人锁仍在
  const content = readFileSync(join(dir, "t1.lock"), "utf-8");
  assert.ok(content.includes("run-other"), "他人锁不得被误删");
  await other.release();
});

test("manifest：写读回字段齐全 + 目录自动创建", () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  const runDir = join(dir, "runs", "run-abc");
  const manifest = {
    processRunId: "run-abc",
    gitSha: "abc123",
    piVersion: "0.83.0",
    sdkVersion: "0.1.0",
    tenantId: "t1",
    decisionMode: "safety",
    submitEnabled: false,
    modelId: "deepseek-v4-flash",
    provider: "newapi",
    rulesVersion: "v0.11",
    configHash: "sha256:cfg",
    startedAt: "2026-08-03T00:00:00.000Z",
  };
  const path = writeRunManifest(runDir, manifest);
  assert.ok(path.endsWith("manifest.json"));
  const readBack = readRunManifest(runDir);
  assert.deepEqual(readBack, manifest);
});

test("manifest：newProcessRunId 唯一、readGitSha 40 位 hex", () => {
  assert.notEqual(newProcessRunId(), newProcessRunId());
  const sha = readGitSha("PROJECT_ROOT/arena");
  assert.match(sha, /^[0-9a-f]{40}$/);
});

test("doctor：合法配置（env 存在）→ 全 PASS", () => {
  const configPath = writeConfig({ ...VALID_CONFIG, baseDir: "runtime" });
  const old = process.env.ARENA_HERO_API_KEY_1;
  process.env.ARENA_HERO_API_KEY_1 = "dummy-not-a-real-key";
  try {
    const result = runDoctor(configPath, "PROJECT_ROOT/arena", join(mkdtempSync(join(tmpdir(), "doctor-")), "runtime"));
    assert.equal(result.allPass, true, JSON.stringify(result.checks, null, 2));
  } finally {
    if (old === undefined) {
      delete process.env.ARENA_HERO_API_KEY_1;
    } else {
      process.env.ARENA_HERO_API_KEY_1 = old;
    }
  }
});

test("doctor：env 缺失 → 该项 FAIL（反向验证：检查真在跑）", () => {
  const configPath = writeConfig({ ...VALID_CONFIG, arenaTokenEnv: "ARENA_DOES_NOT_EXIST_XYZ" });
  const result = runDoctor(configPath, "PROJECT_ROOT/arena", join(mkdtempSync(join(tmpdir(), "doctor-")), "runtime"));
  const tokenCheck = result.checks.find((c) => c.name === "arena_token_env");
  assert.equal(tokenCheck?.pass, false, "缺失 env 必须 FAIL");
  assert.equal(result.allPass, false);
});

test("doctor：非法配置 → config_schema FAIL 且不继续", () => {
  const bad = mkdtempSync(join(tmpdir(), "cfg-bad-"));
  const path = join(bad, "bad.json");
  writeFileSync(path, JSON.stringify({ tenantId: 42 }), "utf-8");
  const result = runDoctor(path, "PROJECT_ROOT/arena", join(mkdtempSync(join(tmpdir(), "doctor-")), "runtime"));
  assert.equal(result.checks[0].pass, false);
  assert.equal(result.allPass, false);
});
