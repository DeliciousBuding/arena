/**
 * tenant-runtime 集成测试（切片 4 阶段 6，leader 集成）。
 *
 * fake client（3 个 Turn 的 async generator）+ fake runtime（同步投递合法候选）
 * 注入 runTenant：验证锁/manifest/telemetry 三流/优雅关闭/红线（锁冲突、deterministic 拒绝）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Turn, type PlayerState } from "@arena/arena-hero-ts";

import { appendPiTelemetryEvent, runTenant, resolvePiModel } from "../src/app/tenant-runtime.ts";
import type { TenantRuntimeConfig } from "../src/app/runtime-config.ts";
import type {
  AgentDecisionRequest,
  AgentDecisionRuntime,
  CandidateEnvelope,
  CandidateSink,
} from "../src/runtime/decision-types.ts";
import type { Plan } from "../src/domain/model.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..");

const MIN_STATE: PlayerState = {
  status: "ACTIVE",
  respawn_at_tick: null,
  resources: 4,
  population: 1,
  population_tier: 0,
  upkeep_next_tick: 0,
  champion_beacon: { position: [0, 0], status: "GROUND", carrier_id: null },
  objects: [
    {
      kind: "CORE",
      id: "c1",
      controlled: true,
      owner_username: "fixture_user",
      position: [0, 0],
      hp: 5,
      shield: 5,
      state: "NORMAL",
      move_direction: null,
      move_progress: null,
      move_required_ticks: null,
      destination: null,
    },
    {
      kind: "UNIT",
      id: "u1",
      controlled: true,
      position: [0, 1],
      hp: 2,
      unit_type: "WORKER",
      cargo: 0,
    },
  ],
  events: [],
};

const TICK_COUNT = 3;

/** fake client：产 TICK_COUNT 个 Turn 后自然结束（loop 随之退出）。 */
interface FakeClient {
  submitted: Array<{ tick: number; plan: unknown }>;
  closed: boolean;
  turns(): AsyncGenerator<Turn>;
  close(): void;
}

function makeFakeClient(): FakeClient {
  const submitted: Array<{ tick: number; plan: unknown }> = [];
  let closed = false;
  return {
    submitted,
    get closed() {
      return closed;
    },
    async *turns() {
      for (let i = 0; i < TICK_COUNT; i++) {
        const turn = new Turn(1000 + i, MIN_STATE, (async (plan: unknown) => {
          submitted.push({ tick: 1000 + i, plan });
          return {
            accepted: true,
            tick: 1000 + i,
            source: "AGENT",
            received_at: `2026-08-03T00:00:${String(i).padStart(2, "0")}Z`,
          };
        }) as never);
        yield turn;
      }
    },
    close() {
      closed = true;
    },
  };
}

/** fake client：无限产 Turn（signal 关闭后终止）——signal 优雅关闭测试用。 */
function makeInfiniteClient(): FakeClient {
  const submitted: Array<{ tick: number; plan: unknown }> = [];
  let closed = false;
  return {
    submitted,
    get closed() {
      return closed;
    },
    async *turns() {
      let i = 0;
      while (!closed) {
        // 宏任务边界：模拟真实网络流（否则微任务链饿死 setTimeout/signal）
        await new Promise((r) => setTimeout(r, 0));
        const turn = new Turn(1000 + i, MIN_STATE, (async (plan: unknown) => {
          submitted.push({ tick: 1000 + i, plan });
          return {
            accepted: true,
            tick: 1000 + i,
            source: "AGENT",
            received_at: `2026-08-03T00:00:${String(i).padStart(2, "0")}Z`,
          };
        }) as never);
        yield turn;
        i += 1;
      }
    },
    close() {
      closed = true;
    },
  };
}

/** fake client：进入 turns 后立即抛错，用于验证异常 cleanup。 */
function makeThrowingClient(): FakeClient {
  let closed = false;
  return {
    submitted: [],
    get closed() { return closed; },
    async *turns() {
      throw new Error("synthetic loop failure");
      yield undefined as never;
    },
    close() { closed = true; },
  };
}

/** fake runtime：startDecision 同步投递合法候选（零 deadline 等待）。 */
class SyncCandidateRuntime implements AgentDecisionRuntime {
  private sink: CandidateSink | null = null;
  readonly startedRunIds: string[] = [];
  closed = false;

  bindCandidateSink(sink: CandidateSink): void {
    this.sink = sink;
  }

  startDecision(request: AgentDecisionRequest) {
    this.startedRunIds.push(request.runId);
    const envelope: CandidateEnvelope = {
      protocolVersion: "1",
      runId: request.runId,
      tenantId: request.tenantId,
      tick: request.tick,
      stateHash: request.stateHash,
      plan: { tick: request.tick, unitActions: {}, coreAction: null, intents: {} } as Plan,
      reason: "fake-sync",
      confidence: null,
    };
    // 同步投递 → coordinator raceCandidate 首轮即取回
    this.sink?.(envelope);
    return {
      runId: request.runId,
      settled: Promise.resolve({ outcome: "settled" as const }),
      abort: () => {},
    };
  }

  health() {
    return { ready: true, activeRunId: null };
  }

  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

function writeConfig(config: TenantRuntimeConfig): string {
  const dir = mkdtempSync(join(tmpdir(), "tenant-rt-"));
  const path = join(dir, "t1.json");
  writeFileSync(path, JSON.stringify(config), "utf-8");
  return path;
}

function makeConfig(baseDir: string, overrides: Partial<TenantRuntimeConfig> = {}): TenantRuntimeConfig {
  return {
    tenantId: "t1",
    rulesVersion: "v0.14",
    arenaTokenEnv: "ARENA_HERO_API_KEY_T_TEST",
    decisionMode: "safety",
    submitEnabled: false,
    model: { provider: "newapi", id: "deepseek-v4-flash", thinkingLevel: "low" },
    baseDir,
    ...overrides,
  };
}

test("runTenant：safety 模式全链路——锁/manifest/telemetry 三流/优雅关闭释放锁", async () => {
  const base = mkdtempSync(join(tmpdir(), "tenant-run-"));
  const configPath = writeConfig(makeConfig(base));
  const runtime = new SyncCandidateRuntime();
  const client = makeFakeClient();
  const old = process.env.ARENA_HERO_API_KEY_T_TEST;
  process.env.ARENA_HERO_API_KEY_T_TEST = "test-key-not-real";
  try {
    const result = await runTenant(configPath, REPO_ROOT, { runtime, client: client as never });

    assert.equal(result.tickCount, 1002, "3 个 Turn 全部处理");
    assert.equal(result.processedTickCount, 3);
    assert.equal(result.lastTick, 1002);
    assert.ok(existsSync(result.manifestPath), "manifest 必须写出");
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf-8")) as {
      processRunId: string;
      tenantId: string;
      piVersion: string;
      configHash: string;
    };
    assert.equal(manifest.processRunId, result.processRunId);
    assert.equal(manifest.tenantId, "t1");
    assert.ok(manifest.piVersion.length > 0);
    assert.match(manifest.configHash, /^sha256:[0-9a-f]{64}$/, "configHash 必须是真实 canonical SHA-256");

    // 三流 telemetry：runtime/decision 各 3 条；outcome 2 条（首 tick 无 t-1 基准）
    for (const path of [result.telemetryPaths.runtime, result.telemetryPaths.decision]) {
      const lines = readFileSync(path, "utf-8").trim().split("\n").filter((l) => l.length > 0);
      assert.equal(lines.length, 3, `${path} 应有 3 条记录`);
    }
    const outcomeLines = readFileSync(result.telemetryPaths.outcome, "utf-8").trim().split("\n").filter((l) => l.length > 0);
    assert.equal(outcomeLines.length, 2, "outcome 首 tick 无对比基准 → 2 条");
    // 锁已释放（可再 acquire）
    assert.equal(existsSync(join(base, "t1", "locks", "t1.lock")), false, "锁文件已删除");
    // safety 模式不启动 Agent runtime
    assert.equal(runtime.startedRunIds.length, 0, "safety 模式不得 startDecision");
    // 只观察不提交
    assert.equal(client.submitted.length, 0, "submissionMode=disabled 不得提交");
  } finally {
    if (old === undefined) {
      delete process.env.ARENA_HERO_API_KEY_T_TEST;
    } else {
      process.env.ARENA_HERO_API_KEY_T_TEST = old;
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test("runTenant：maxTicks 达标后 runtime 内部优雅关闭并精确计数", async () => {
  const base = mkdtempSync(join(tmpdir(), "tenant-run-"));
  const configPath = writeConfig(makeConfig(base));
  const runtime = new SyncCandidateRuntime();
  const client = makeInfiniteClient();
  const old = process.env.ARENA_HERO_API_KEY_T_TEST;
  process.env.ARENA_HERO_API_KEY_T_TEST = "test-key-not-real";
  try {
    const result = await runTenant(configPath, REPO_ROOT, {
      runtime,
      client: client as never,
      decisionMode: "deterministic",
      submissionMode: "live",
      maxTicks: 3,
      onSignal: () => {},
    });
    assert.equal(result.processedTickCount, 3);
    assert.equal(result.lastTick, 1002);
    assert.equal(result.tickCount, 1002, "兼容字段仍返回 lastTick");
    assert.equal(client.submitted.length, 3);
    assert.equal(client.closed, true);
    assert.equal(runtime.closed, true);
    assert.equal(existsSync(join(base, "t1", "locks", "t1.lock")), false, "锁已释放");
    const runtimeLines = readFileSync(result.telemetryPaths.runtime, "utf-8").trim().split("\n");
    assert.equal(runtimeLines.length, 3, "恰好落 3 Tick telemetry");
  } finally {
    if (old === undefined) {
      delete process.env.ARENA_HERO_API_KEY_T_TEST;
    } else {
      process.env.ARENA_HERO_API_KEY_T_TEST = old;
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test("runTenant：startupSyncTurns 首 Tick 只观察，后续 Tick 才 live 提交", async () => {
  const base = mkdtempSync(join(tmpdir(), "tenant-run-"));
  const configPath = writeConfig(makeConfig(base));
  const runtime = new SyncCandidateRuntime();
  const client = makeInfiniteClient();
  const old = process.env.ARENA_HERO_API_KEY_T_TEST;
  process.env.ARENA_HERO_API_KEY_T_TEST = "test-key-not-real";
  try {
    const result = await runTenant(configPath, REPO_ROOT, {
      runtime,
      client: client as never,
      decisionMode: "deterministic",
      submissionMode: "live",
      startupSyncTurns: 1,
      maxTicks: 3,
      onSignal: () => {},
    });
    assert.equal(result.processedTickCount, 3);
    assert.equal(client.submitted.length, 2, "首 Tick 只同步，后两 Tick 提交");
    const lines = readFileSync(result.telemetryPaths.runtime, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { submitResult: string; notSubmittedReason?: string });
    assert.deepEqual(
      lines.map((line) => [line.submitResult, line.notSubmittedReason ?? null]),
      [
        ["not_submitted", "startup_sync"],
        ["accepted", null],
        ["accepted", null],
      ],
    );
  } finally {
    if (old === undefined) delete process.env.ARENA_HERO_API_KEY_T_TEST;
    else process.env.ARENA_HERO_API_KEY_T_TEST = old;
    rmSync(base, { recursive: true, force: true });
  }
});

test("runTenant：maxLiveTicks 精确提交并额外 drain 最后一次结算", async () => {
  const base = mkdtempSync(join(tmpdir(), "tenant-run-"));
  const configPath = writeConfig(makeConfig(base));
  const runtime = new SyncCandidateRuntime();
  const client = makeInfiniteClient();
  const old = process.env.ARENA_HERO_API_KEY_T_TEST;
  process.env.ARENA_HERO_API_KEY_T_TEST = "test-key-not-real";
  try {
    const result = await runTenant(configPath, REPO_ROOT, {
      runtime,
      client: client as never,
      decisionMode: "deterministic",
      submissionMode: "live",
      startupSyncTurns: 1,
      maxLiveTicks: 3,
      outcomeDrainTurns: 1,
      onSignal: () => {},
    });
    assert.equal(result.processedTickCount, 5, "1 sync + 3 live + 1 drain");
    assert.equal(result.liveSubmitCount, 3);
    assert.equal(client.submitted.length, 3);
    assert.equal(client.closed, true);
    assert.equal(runtime.closed, true);
    assert.equal(existsSync(join(base, "t1", "locks", "t1.lock")), false, "锁已释放");
    const runtimeLines = readFileSync(result.telemetryPaths.runtime, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { submitResult: string; notSubmittedReason?: string });
    assert.deepEqual(
      runtimeLines.map((line) => [line.submitResult, line.notSubmittedReason ?? null]),
      [
        ["not_submitted", "startup_sync"],
        ["accepted", null],
        ["accepted", null],
        ["accepted", null],
        ["not_submitted", "outcome_drain"],
      ],
    );
    const outcomeLines = readFileSync(result.telemetryPaths.outcome, "utf-8").trim().split("\n");
    assert.equal(outcomeLines.length, 4, "sync 后的 3 次 live 结算全部被后续 Turn 覆盖");
  } finally {
    if (old === undefined) delete process.env.ARENA_HERO_API_KEY_T_TEST;
    else process.env.ARENA_HERO_API_KEY_T_TEST = old;
    rmSync(base, { recursive: true, force: true });
  }
});

test("S8b：启用 recorder 不改变提交 body，并由 drain 闭合全部 full-plan cases", async () => {
  const baseOff = mkdtempSync(join(tmpdir(), "tenant-run-off-"));
  const baseOn = mkdtempSync(join(tmpdir(), "tenant-run-on-"));
  const configOff = writeConfig(makeConfig(baseOff));
  const configOn = writeConfig(makeConfig(baseOn));
  const clientOff = makeInfiniteClient();
  const clientOn = makeInfiniteClient();
  const old = process.env.ARENA_HERO_API_KEY_T_TEST;
  process.env.ARENA_HERO_API_KEY_T_TEST = "test-key-not-real";
  try {
    const common = {
      decisionMode: "deterministic" as const,
      submissionMode: "live" as const,
      startupSyncTurns: 1,
      maxLiveTicks: 3,
      outcomeDrainTurns: 1,
      onSignal: () => {},
    };
    const off = await runTenant(configOff, REPO_ROOT, {
      ...common,
      client: clientOff as never,
    });
    const on = await runTenant(configOn, REPO_ROOT, {
      ...common,
      client: clientOn as never,
      recordCalibration: true,
    });

    assert.deepEqual(clientOn.submitted, clientOff.submitted, "recorder 不得改变任何提交 body/tick");
    assert.equal(on.liveSubmitCount, off.liveSubmitCount);
    assert.ok(on.calibration !== undefined);
    assert.equal(on.calibration.caseCount, 3, "3 live + 1 drain 必须闭合 3 个 case");
    assert.equal(on.calibration.errorCount, 0);
    assert.equal(on.calibration.droppedPending, 0);
    const manifest = JSON.parse(readFileSync(on.calibration.manifestPath, "utf8")) as {
      caseCount: number;
      cases: Array<{ file: string; beforeSha256: string; planSha256: string; afterSha256: string }>;
    };
    assert.equal(manifest.caseCount, 3);
    for (const entry of manifest.cases) {
      assert.match(entry.beforeSha256, /^[0-9a-f]{64}$/);
      assert.match(entry.planSha256, /^[0-9a-f]{64}$/);
      assert.match(entry.afterSha256, /^[0-9a-f]{64}$/);
      assert.ok(existsSync(join(on.calibration.outputDir, entry.file)));
    }
  } finally {
    if (old === undefined) delete process.env.ARENA_HERO_API_KEY_T_TEST;
    else process.env.ARENA_HERO_API_KEY_T_TEST = old;
    rmSync(baseOff, { recursive: true, force: true });
    rmSync(baseOn, { recursive: true, force: true });
  }
});

test("S8b：recordCalibration 在非 live 模式拿锁前拒绝", async () => {
  const base = mkdtempSync(join(tmpdir(), "tenant-run-"));
  const configPath = writeConfig(makeConfig(base));
  try {
    await assert.rejects(
      runTenant(configPath, REPO_ROOT, { recordCalibration: true }),
      /只能在 live 提交模式启用/,
    );
    assert.equal(existsSync(join(base, "t1", "locks", "t1.lock")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runTenant：非法 maxTicks 在拿锁前 fail-fast", async () => {
  await assert.rejects(
    runTenant("does-not-matter.json", REPO_ROOT, { maxTicks: 0 }),
    /maxTicks 必须是正整数/,
  );
});

test("runTenant：非法 maxLiveTicks / drain / 双重边界在拿锁前 fail-fast", async () => {
  await assert.rejects(
    runTenant("does-not-matter.json", REPO_ROOT, { maxLiveTicks: 0 }),
    /maxLiveTicks 必须是正整数/,
  );
  await assert.rejects(
    runTenant("does-not-matter.json", REPO_ROOT, { outcomeDrainTurns: 0 }),
    /outcomeDrainTurns 必须是正整数/,
  );
  await assert.rejects(
    runTenant("does-not-matter.json", REPO_ROOT, { maxTicks: 1, maxLiveTicks: 1 }),
    /不能同时设置/,
  );
});

test("runTenant：非法 startupSyncTurns 在拿锁前 fail-fast", async () => {
  await assert.rejects(
    runTenant("does-not-matter.json", REPO_ROOT, { startupSyncTurns: -1 }),
    /startupSyncTurns 必须是非负整数/,
  );
});

test("runTenant：agent-shadow + live——runtime 启动 + 候选评估 + 真提交", async () => {
  const base = mkdtempSync(join(tmpdir(), "tenant-run-"));
  const configPath = writeConfig(makeConfig(base));
  const runtime = new SyncCandidateRuntime();
  const client = makeFakeClient();
  const old = process.env.ARENA_HERO_API_KEY_T_TEST;
  process.env.ARENA_HERO_API_KEY_T_TEST = "test-key-not-real";
  try {
    const result = await runTenant(configPath, REPO_ROOT, {
      runtime,
      client: client as never,
      decisionMode: "agent-shadow",
      submissionMode: "live",
    });
    assert.equal(runtime.startedRunIds.length, TICK_COUNT, "agent-shadow 启动 Agent run");
    assert.equal(client.submitted.length, TICK_COUNT, "live 提交全部 Tick");
    // decision trace 记录 execution=safety（agent-shadow 执行权恒 Safety）
    const decisionLines = readFileSync(result.telemetryPaths.decision, "utf-8").trim().split("\n");
    for (const line of decisionLines) {
      const record = JSON.parse(line) as { decisionSource: string; runId: string };
      assert.equal(record.decisionSource, "safety", "agent-shadow 下执行来源恒 Safety");
      // runId = <uuid>:<tenant>:<tick>:<runSeq>（runSeq 每 tick 递增）
      assert.match(record.runId, /^[0-9a-f-]{36}:t1:10\d\d:\d+$/);
    }
  } finally {
    if (old === undefined) {
      delete process.env.ARENA_HERO_API_KEY_T_TEST;
    } else {
      process.env.ARENA_HERO_API_KEY_T_TEST = old;
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test("runTenant：锁冲突（他人活锁）→ 直接失败，不降级", async () => {
  const base = mkdtempSync(join(tmpdir(), "tenant-run-"));
  const configPath = writeConfig(makeConfig(base));
  const { SingleWriterLock } = await import("../src/app/single-writer-lock.ts");
  const other = new SingleWriterLock(join(base, "t1", "locks"), "t1", "run-other");
  await other.acquire();
  const runtime = new SyncCandidateRuntime();
  const old = process.env.ARENA_HERO_API_KEY_T_TEST;
  process.env.ARENA_HERO_API_KEY_T_TEST = "test-key-not-real";
  try {
    await assert.rejects(
      runTenant(configPath, REPO_ROOT, { runtime, client: makeFakeClient() as never }),
      /live process/,
    );
    assert.equal(runtime.closed, false, "锁失败不得创建 runtime");
  } finally {
    if (old === undefined) {
      delete process.env.ARENA_HERO_API_KEY_T_TEST;
    } else {
      process.env.ARENA_HERO_API_KEY_T_TEST = old;
    }
    await other.release();
    rmSync(base, { recursive: true, force: true });
  }
});

test("runTenant：deterministic+live → 允许开闸（DeterministicPlanner 注入，Submit）", async () => {
  const base = mkdtempSync(join(tmpdir(), "tenant-run-"));
  const configPath = writeConfig(makeConfig(base));
  const old = process.env.ARENA_HERO_API_KEY_T_TEST;
  process.env.ARENA_HERO_API_KEY_T_TEST = "test-key-not-real";
  try {
    const result = await runTenant(configPath, REPO_ROOT, {
      runtime: new SyncCandidateRuntime(),
      client: makeFakeClient() as never,
      decisionMode: "deterministic",
      submissionMode: "live",
    });
    assert.equal(result.decisionMode, "deterministic");
    assert.equal(result.submissionMode, "live");
    // 每 Tick 最多 submit 一次（3 Tick → 3 次提交）
    const decisionLines = readFileSync(result.telemetryPaths.decision, "utf-8").trim().split("\n").filter((l) => l.length > 0);
    assert.equal(decisionLines.length, 3);
    // decision trace source 记录真实执行来源（deterministic 不再伪装成 safety）
    for (const line of decisionLines) {
      const record = JSON.parse(line) as { decisionSource: string };
      assert.equal(record.decisionSource, "deterministic");
    }
  } finally {
    if (old === undefined) {
      delete process.env.ARENA_HERO_API_KEY_T_TEST;
    } else {
      process.env.ARENA_HERO_API_KEY_T_TEST = old;
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test("runTenant：deterministic+shadow → 允许（DeterministicPlanner 注入，离线决策）", async () => {
  const base = mkdtempSync(join(tmpdir(), "tenant-run-"));
  const configPath = writeConfig(makeConfig(base));
  const old = process.env.ARENA_HERO_API_KEY_T_TEST;
  process.env.ARENA_HERO_API_KEY_T_TEST = "test-key-not-real";
  try {
    const result = await runTenant(configPath, REPO_ROOT, {
      runtime: new SyncCandidateRuntime(),
      client: makeFakeClient() as never,
      decisionMode: "deterministic",
    });
    assert.equal(result.decisionMode, "deterministic");
    assert.equal(result.submissionMode, "disabled");
    // decision trace：source 仍 safety（deterministic 走 coordinator 短路语义）
    const decisionLines = readFileSync(result.telemetryPaths.decision, "utf-8").trim().split("\n").filter((l) => l.length > 0);
    assert.equal(decisionLines.length, 3);
  } finally {
    if (old === undefined) {
      delete process.env.ARENA_HERO_API_KEY_T_TEST;
    } else {
      process.env.ARENA_HERO_API_KEY_T_TEST = old;
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test("runTenant：signal 触发优雅关闭——停收 Turn、释放锁、runtime close", async () => {
  const base = mkdtempSync(join(tmpdir(), "tenant-run-"));
  const configPath = writeConfig(makeConfig(base));
  const runtime = new SyncCandidateRuntime();
  const client = makeInfiniteClient();
  const signal: { cb: (() => void) | null } = { cb: null };
  const old = process.env.ARENA_HERO_API_KEY_T_TEST;
  process.env.ARENA_HERO_API_KEY_T_TEST = "test-key-not-real";
  try {
    const resultPromise = runTenant(configPath, REPO_ROOT, {
      runtime,
      client: client as never,
      onSignal: (cb) => {
        signal.cb = cb;
      },
    });
    // 等第一个 tick 的 runtime trace 落地（轮询，避免组装耗时竞态）
    const runtimeTracePath = join(base, "t1", "telemetry", "runtime.jsonl");
    const deadline = Date.now() + 5000;
    while (!existsSync(runtimeTracePath)) {
      if (Date.now() > deadline) {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(existsSync(runtimeTracePath), "第一个 tick 必须已落地");
    assert.ok(signal.cb !== null, "signal 回调已注册");
    signal.cb!();
    const result = await resultPromise;
    // signal 后 runTenant 必须快速完成（signal 无效则此 await 永不返回 → 测试超时即失败）；
    // tickCount 是微任务竞态下的不稳定值，只验证下限
    assert.ok(result.tickCount >= 1000, "signal 前至少处理了一个 Tick");
    assert.equal(client.closed, true, "client 已关闭");
    assert.equal(runtime.closed, true, "runtime 已关闭");
    assert.equal(existsSync(join(base, "t1", "locks", "t1.lock")), false, "锁已释放");
  } finally {
    if (old === undefined) {
      delete process.env.ARENA_HERO_API_KEY_T_TEST;
    } else {
      process.env.ARENA_HERO_API_KEY_T_TEST = old;
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test("runTenant：deterministic+live SIGTERM 优雅关闭——停止提交、释放锁", async () => {
  const base = mkdtempSync(join(tmpdir(), "tenant-run-"));
  const configPath = writeConfig(makeConfig(base));
  const runtime = new SyncCandidateRuntime();
  const client = makeInfiniteClient();
  const signal: { cb: (() => void) | null } = { cb: null };
  const old = process.env.ARENA_HERO_API_KEY_T_TEST;
  process.env.ARENA_HERO_API_KEY_T_TEST = "test-key-not-real";
  try {
    const resultPromise = runTenant(configPath, REPO_ROOT, {
      runtime,
      client: client as never,
      decisionMode: "deterministic",
      submissionMode: "live",
      onSignal: (cb) => {
        signal.cb = cb;
      },
    });
    const runtimeTracePath = join(base, "t1", "telemetry", "runtime.jsonl");
    const deadline = Date.now() + 5000;
    while (!existsSync(runtimeTracePath)) {
      if (Date.now() > deadline) {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(signal.cb !== null, "signal 回调已注册");
    signal.cb!();
    const result = await resultPromise;
    assert.ok(result.tickCount >= 1000, "signal 前至少处理了一个 Tick");
    assert.equal(result.decisionMode, "deterministic");
    assert.equal(result.submissionMode, "live");
    assert.equal(client.closed, true, "client 已关闭");
    assert.equal(runtime.closed, true, "runtime 已关闭");
    assert.equal(existsSync(join(base, "t1", "locks", "t1.lock")), false, "锁已释放");
  } finally {
    if (old === undefined) {
      delete process.env.ARENA_HERO_API_KEY_T_TEST;
    } else {
      process.env.ARENA_HERO_API_KEY_T_TEST = old;
    }
    rmSync(base, { recursive: true, force: true });
  }
});



test("runTenant：loop 异常仍关闭 client/runtime/recorder、注销 listener 并释放锁", async () => {
  const base = mkdtempSync(join(tmpdir(), "tenant-run-error-"));
  const configPath = writeConfig(makeConfig(base));
  const runtime = new SyncCandidateRuntime();
  const client = makeThrowingClient();
  let recorderClosed = false;
  let disposerCalls = 0;
  const recorder = {
    observe() {},
    async close() {
      recorderClosed = true;
      return {
        outputDir: base,
        manifestPath: join(base, "manifest.json"),
        caseCount: 0,
        skippedRejected: 0,
        droppedPending: 0,
        errorCount: 0,
      };
    },
  };
  const old = process.env.ARENA_HERO_API_KEY_T_TEST;
  process.env.ARENA_HERO_API_KEY_T_TEST = "test-key-not-real";
  try {
    await assert.rejects(
      runTenant(configPath, REPO_ROOT, {
        runtime,
        client: client as never,
        calibrationRecorder: recorder as never,
        onSignal: () => () => { disposerCalls += 1; },
      }),
      /synthetic loop failure/,
    );
    assert.equal(client.closed, true);
    assert.equal(runtime.closed, true);
    assert.equal(recorderClosed, true);
    assert.equal(disposerCalls, 1);
    assert.equal(existsSync(join(base, "t1", "locks", "t1.lock")), false);
  } finally {
    if (old === undefined) delete process.env.ARENA_HERO_API_KEY_T_TEST;
    else process.env.ARENA_HERO_API_KEY_T_TEST = old;
    rmSync(base, { recursive: true, force: true });
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
});

test("Pi circuit telemetry is structurally persisted without raw-field duplication", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telemetry-"));
  const path = join(dir, "pi.jsonl");
  try {
    appendPiTelemetryEvent(path, {
      type: "circuit_opened",
      message: "provider failed",
      circuitState: "open",
      consecutiveFailures: 3,
      lastTripAt: 1234,
      fallbackReason: "provider_failure",
    }, "2026-08-04T00:00:00.000Z");
    const row = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.equal("message" in row, false);
    assert.deepEqual(row, {
      at: "2026-08-04T00:00:00.000Z",
      type: "circuit_opened",
      reason: "provider failed",
      circuitState: "open",
      consecutiveFailures: 3,
      lastTripAt: 1234,
      fallbackReason: "provider_failure",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runTenant：env token 缺失 → 抛错（密钥绝不落盘/降级）", async () => {
  const base = mkdtempSync(join(tmpdir(), "tenant-run-"));
  const configPath = writeConfig(makeConfig(base, { arenaTokenEnv: "ARENA_HERO_NO_SUCH_ENV_XYZ" }));
  // 不注入 client → 走真实 ArenaHeroClient 构造 → readEnvToken 缺失抛错
  await assert.rejects(
    runTenant(configPath, REPO_ROOT, {
      runtime: new SyncCandidateRuntime(),
    }),
    /缺失/,
  );
  rmSync(base, { recursive: true, force: true });
});

test("resolvePiModel：config.model → pi Model（OpenAI 兼容协议，无密钥字段）", () => {
  const model = resolvePiModel(makeConfig("runtime"));
  assert.equal(model.id, "deepseek-v4-flash");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.provider, "newapi");
  assert.equal((model as unknown as Record<string, unknown>).apiKey, undefined, "pi Model 不含 apiKey（密钥走 pi 自身认证）");
});
