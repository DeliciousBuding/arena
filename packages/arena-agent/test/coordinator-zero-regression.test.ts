/** W4 零回归门槛：Fake Agent 永不返回时，DecisionCoordinator 在 W3 fixture 上
 *  产生的最终计划必须与 SafetyPlanner 直接决策 100/100 一致。
 *
 *  证明引入 timeout/Lease/abort/arbitration 后不降低已验证的确定性资源获取能力。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseStreamMessage, Turn } from "@arena/arena-hero-ts";

import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import { SafetyPlanner, DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";
import { DecisionCoordinator } from "../src/runtime/decision-coordinator.ts";
import { LeaseRegistry } from "../src/runtime/lease-registry.ts";
import { FakeAgentRuntime, FakeClock } from "../src/runtime/testing/fake-agent-runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "..", "fixtures", "differential", "burnin-20260802-a");

const BUDGET = { agentSoftMs: 100, selectionMs: 200, submitMs: 300, hardMs: 400 };

test("零回归：100 tick fixture 上 coordinator（never-settles）计划 == SafetyPlanner 100/100", async () => {
  const manifest = JSON.parse(
    readFileSync(join(FIXTURES, "manifest.json"), "utf-8"),
  ) as {
    segments: Array<{ segment_id: string; ticks: number[] }>;
    dataset_id: string;
    tenant_id: string;
    config_hash: string;
    map_mode: string;
  };

  let compared = 0;
  for (const segment of manifest.segments) {
    // coordinator 侧：FakeClock + never-settles runtime + FakeClock 驱动 sleepUntil
    const clock = new FakeClock();
    const runtime = new FakeAgentRuntime({ sink: () => ({ accepted: false, code: "lease_not_found", message: "unused" }), mode: "never-settles", clock });
    const registry = new LeaseRegistry();
    const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
    const coordinator = new DecisionCoordinator({
      runtime,
      planner,
      registry,
      clock,
      budgetConfig: BUDGET,
      tenantId: manifest.tenant_id,
      rulesVersion: "v0.11",
      configHash: manifest.config_hash,
      sleepUntil: (d, c) =>
        new Promise<void>((resolve) => {
          (c as FakeClock).setTimeout(() => resolve(), Math.max(0, d - c.now()));
        }),
    });
    // 对比侧：独立 planner 贯穿 segment（同输入同演化）
    const referencePlanner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);

    for (const tick of segment.ticks) {
      const raw = JSON.parse(readFileSync(join(FIXTURES, `${tick}.json`), "utf-8")) as Record<
        string,
        unknown
      >;
      const state = parseStreamMessage(JSON.stringify({ type: "state", data: raw }));
      const turn = new Turn(tick, state as never, (() => {}) as never);
      const tickState = reduceTurn(turn as unknown as TurnLike);

      const pending = coordinator.decide(tickState);
      clock.advance(150); // 越过 soft deadline → safety
      const result = await pending;
      assert.equal(result.source, "safety", `tick ${tick}: 应全部 safety`);

      const reference = referencePlanner.decide({ state: tickState });
      assert.deepEqual(result.plan, reference, `tick ${tick}: coordinator 计划 != SafetyPlanner`);
      compared += 1;
    }
  }
  assert.ok(compared >= 100, `对比了 ${compared} tick（应 ≥100）`);
});
