/** Slice 3B：DecisionLease 状态机 + LeaseRegistry runId 精确索引（有界清理）。
 *
 * 核心保证：旧 run 的迟到工具调用永远不能命中新 Tick 的 Lease。
 * 全部时钟经 FakeClock 注入，无真实 sleep。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { type CandidateEnvelope } from "../src/runtime/decision-types.ts";
import {
  DecisionLease,
  type LeaseSubmission,
} from "../src/runtime/decision-lease.ts";
import { LeaseRegistry } from "../src/runtime/lease-registry.ts";

/** 注入时钟：单调推进，可任意跳转，无真实等待。 */
class FakeClock {
  private current = 0;
  readonly now = (): number => this.current;
  advance(ms: number): void {
    this.current += ms;
  }
}

const TICK = 42;
const STATE_HASH = "hash-42";
const TENANT = "tenant-a";
const RUN = "run-1";

function plan(tick: number) {
  return { tick, unitActions: {}, coreAction: null, intents: {} };
}

function envelope(options: Partial<CandidateEnvelope> = {}): CandidateEnvelope {
  const tick = options.tick ?? TICK;
  return {
    protocolVersion: "1",
    runId: RUN,
    tenantId: TENANT,
    tick,
    stateHash: STATE_HASH,
    plan: plan(tick),
    reason: "arena_plan from test agent",
    confidence: 0.9,
    ...options,
  };
}

function makeLease(options: {
  tick?: number;
  stateHash?: string;
  runId?: string;
  tenantId?: string;
  deadlineAt?: number;
  clock?: { readonly now: () => number };
} = {}) {
  return new DecisionLease({
    tick: options.tick ?? TICK,
    stateHash: options.stateHash ?? STATE_HASH,
    deadlineAt: options.deadlineAt ?? 1_000_000,
    runId: options.runId ?? RUN,
    tenantId: options.tenantId ?? TENANT,
    clock: options.clock,
  });
}

function rejection(submission: LeaseSubmission, code: string): void {
  assert.equal(submission.accepted, false);
  if (!submission.accepted) assert.equal(submission.code, code);
}

// ---------- runId 精确索引：旧 run 永不命中新 Tick ----------

test("旧 runId 的迟到工具调用不能命中新 Tick 的 Lease（registry 精确索引）", () => {
  const clock = new FakeClock();
  const registry = new LeaseRegistry();

  // Tick 42 的旧 run（已注册、仍活跃——迟到调用仍可路由到它，但必须被校验拒绝）
  const oldRun = makeLease({ clock });
  assert.equal(registry.register(oldRun), true);

  // 新 Tick 43：新 runId 的新 Lease
  const newRun = makeLease({ tick: 43, stateHash: "hash-43", runId: "run-2", clock });
  assert.equal(registry.register(newRun), true);

  // 旧 runId 携带"为新 Tick 43 准备"的候选到达 → 精确路由到旧 Lease → tick 不匹配拒绝
  rejection(
    registry.submit("run-1", envelope({ runId: "run-1", tick: 43, stateHash: "hash-43" })),
    "tick_mismatch",
  );

  // 旧候选从未进入新 Lease（对照：新 runId 正常提交成功）
  assert.equal(newRun.candidate, null, "旧候选不得进入新 Lease");
  const ok = registry.submit("run-2", envelope({ runId: "run-2", tick: 43, stateHash: "hash-43" }));
  assert.equal(ok.accepted, true);
  assert.equal((newRun.candidate as CandidateEnvelope | null)?.runId, "run-2", "进入新 Lease 的是新 run 的候选");
  assert.equal(newRun.status, "accepted");
  assert.equal(oldRun.status, "active");

  // 未知/已清理 runId → lease_not_found
  rejection(registry.submit("run-ghost", envelope({ runId: "run-ghost" })), "lease_not_found");
});

test("同一 Lease 最多接受一个候选（重复提交拒绝）", () => {
  const clock = new FakeClock();
  const lease = makeLease({ clock });
  const first = lease.submit(envelope());
  assert.equal(first.accepted, true);
  const second = lease.submit(envelope({ reason: "second attempt" }));
  rejection(second, "lease_not_active");
  assert.equal(lease.status, "accepted");
  assert.equal(lease.candidate?.reason, "arena_plan from test agent");
});

test("expire 后所有提交拒绝", () => {
  const clock = new FakeClock();
  const registry = new LeaseRegistry();
  const lease = makeLease({ deadlineAt: 500, clock });
  assert.equal(registry.register(lease), true);

  // 未到 deadline 不可过期（门禁保留："先让 Lease 过期，再清理 Agent"）
  assert.equal(registry.expire("run-1"), false);
  assert.equal(lease.status, "active");

  clock.advance(600); // now 600 >= deadline 500
  assert.equal(registry.expire("run-1"), true);
  assert.equal(lease.status, "expired");

  rejection(registry.submit("run-1", envelope()), "lease_not_active");

  // 已终结 lease 进入有界保留区：仍可查询，但不可再提交
  assert.equal(registry.get("run-1"), lease);
  assert.equal(lease.expire(), false, "已终结不可重复过期");
});

test("错误 tenant/tick/stateHash/plan-tick/runId 拒绝", () => {
  const clock = new FakeClock();
  const lease = makeLease({ clock });

  rejection(lease.submit(envelope({ tenantId: "tenant-b" })), "tenant_mismatch");
  rejection(lease.submit(envelope({ tick: 43 })), "tick_mismatch");
  rejection(lease.submit(envelope({ stateHash: "hash-wrong" })), "state_mismatch");
  rejection(lease.submit(envelope({ runId: "run-other" })), "run_id_mismatch");
  // tick/stateHash 都对齐但 plan.tick 错 → plan_tick_mismatch
  rejection(lease.submit(envelope({ plan: plan(43) })), "plan_tick_mismatch");
  // 全部拒绝后 lease 保持 active，仍可接受合法候选
  assert.equal(lease.status, "active");
  assert.equal(lease.submit(envelope()).accepted, true);
});

test("selected 后的迟到提交拒绝", () => {
  const clock = new FakeClock();
  const registry = new LeaseRegistry();
  const lease = makeLease({ clock });
  assert.equal(registry.register(lease), true);

  assert.equal(registry.submit("run-1", envelope()).accepted, true);
  assert.equal(lease.status, "accepted");
  assert.equal(registry.select("run-1"), true);
  assert.equal(lease.status, "selected");

  rejection(registry.submit("run-1", envelope({ reason: "too late" })), "lease_not_active");
  assert.equal(registry.select("run-1"), false, "已 selected 不可重复 select");
  assert.equal(registry.cancel("run-1"), false);
});

// ---------- 有界清理 ----------

test("10 万个已终结 Lease 后 registry 大小回到常数级（默认上限 1000）", () => {
  const registry = new LeaseRegistry();
  for (let i = 0; i < 100_000; i += 1) {
    const runId = `run-${i}`;
    const lease = new DecisionLease({
      tick: 1,
      stateHash: "hash",
      deadlineAt: 0,
      runId,
      tenantId: TENANT,
      clock: { now: () => 0 },
    });
    assert.equal(registry.register(lease), true);
    assert.equal(registry.expire(runId, 0), true);
  }
  const stats = registry.stats();
  assert.ok(stats.total <= 1000, `registry 有界：total=${stats.total}`);
  assert.equal(stats.expired, stats.total, "全部已终结");
  assert.equal(stats.active, 0);
  assert.equal(stats.accepted + stats.selected + stats.cancelled, 0);
  assert.equal(registry.get("run-0"), undefined, "最旧已丢弃");
  assert.ok(registry.get("run-99999"), "最新保留");
  rejection(registry.submit("run-0", envelope()), "lease_not_found");
});

test("有界清理上限可配置", () => {
  const registry = new LeaseRegistry({ maxTerminated: 3 });
  for (let i = 0; i < 10; i += 1) {
    const runId = `run-${i}`;
    const lease = new DecisionLease({ tick: 1, stateHash: "h", deadlineAt: 0, runId });
    assert.equal(registry.register(lease), true);
    assert.equal(registry.expire(runId, 0), true);
  }
  assert.equal(registry.stats().total, 3);
  assert.equal(registry.get("run-0"), undefined);
  assert.equal(registry.get("run-6"), undefined);
  assert.equal(registry.get("run-7")?.status, "expired");
  assert.equal(registry.get("run-9")?.status, "expired");
});

test("重复 runId 注册拒绝", () => {
  const registry = new LeaseRegistry();
  const lease = makeLease();
  assert.equal(registry.register(lease), true);
  assert.equal(registry.register(lease), false);
  assert.equal(registry.register(makeLease()), false, "同 runId 不同 lease 也拒绝");
  assert.equal(registry.get("run-1"), lease);
});

// ---------- 状态机全路径 ----------

test("状态机：active→accepted→selected", () => {
  const clock = new FakeClock();
  const registry = new LeaseRegistry();
  const lease = makeLease({ clock });
  assert.equal(registry.register(lease), true);
  assert.equal(lease.status, "active");

  assert.equal(registry.submit("run-1", envelope()).accepted, true);
  assert.equal(lease.status, "accepted");

  assert.equal(registry.select("run-1"), true);
  assert.equal(lease.status, "selected");
  assert.equal(lease.candidate?.plan.tick, TICK);
  assert.equal(registry.stats().selected, 1);
});

test("状态机：active→expired→selected（无候选时采纳 fallback 计划）", () => {
  const clock = new FakeClock();
  const registry = new LeaseRegistry();
  const lease = makeLease({ deadlineAt: 500, clock });
  assert.equal(registry.register(lease), true);

  clock.advance(501);
  assert.equal(registry.expire("run-1"), true);
  assert.equal(lease.status, "expired");
  assert.equal(lease.candidate, null, "expired 可无候选（fallback 路径）");

  // 过期后 coordinator 仍可 select（最终采纳 fallback 计划）→ 迟到提交同样被拒
  assert.equal(registry.select("run-1"), true);
  assert.equal(lease.status, "selected");
  rejection(registry.submit("run-1", envelope()), "lease_not_active");

  // 直接 active→select 不允许
  const fresh = makeLease({ runId: "run-2", clock });
  assert.equal(registry.register(fresh), true);
  assert.equal(registry.select("run-2"), false);
  assert.equal(fresh.status, "active");
});

test("状态机：active→cancelled", () => {
  const clock = new FakeClock();
  const registry = new LeaseRegistry();
  const lease = makeLease({ clock });
  assert.equal(registry.register(lease), true);

  assert.equal(registry.cancel("run-1"), true);
  assert.equal(lease.status, "cancelled");
  assert.equal(registry.cancel("run-1"), false, "不可重复 cancel");
  rejection(registry.submit("run-1", envelope()), "lease_not_active");
  assert.equal(registry.select("run-1"), false);
  assert.equal(registry.expire("run-1"), false);
});

// ---------- 注入时钟 ----------

test("注入时钟驱动 deadline 过期（无真实 sleep）", () => {
  const clock = new FakeClock();
  const ok = makeLease({ deadlineAt: 1_000, clock });
  assert.equal(ok.submit(envelope()).accepted, true);

  clock.advance(999); // t=999 < deadline，仍在边界内
  const edge = makeLease({ runId: "run-2", deadlineAt: 1_000, clock });
  assert.equal(edge.submit(envelope({ runId: "run-2" })).accepted, true);

  clock.advance(2); // t=1001 > deadline → 过期
  const late = makeLease({ runId: "run-3", deadlineAt: 1_000, clock });
  rejection(late.submit(envelope({ runId: "run-3" })), "deadline_exceeded");
  assert.equal(late.status, "expired");
});

test("registry stats 汇总各状态计数", () => {
  const clock = new FakeClock();
  const registry = new LeaseRegistry({ maxTerminated: 10 });
  const active = makeLease({ runId: "run-active", clock });
  const accepted = makeLease({ runId: "run-accepted", clock });
  const selected = makeLease({ runId: "run-selected", deadlineAt: 500, clock });
  const cancelled = makeLease({ runId: "run-cancelled", clock });
  registry.register(active);
  registry.register(accepted);
  registry.register(selected);
  registry.register(cancelled);

  assert.equal(registry.submit("run-accepted", envelope({ runId: "run-accepted" })).accepted, true);
  clock.advance(501);
  assert.equal(registry.expire("run-selected"), true);
  assert.equal(registry.select("run-selected"), true);
  assert.equal(registry.cancel("run-cancelled"), true);

  assert.deepEqual(registry.stats(), {
    active: 1,
    accepted: 1,
    selected: 1,
    expired: 0,
    cancelled: 1,
    total: 4,
  });
  assert.equal(registry.get("run-active")?.status, "active");
});
