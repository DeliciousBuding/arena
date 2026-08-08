/**
 * 生命周期审计聚合测试（2026-08-08）：单位/矿物/核心生命周期 + 消费汇总。
 * - worker 采集/交付/移动/丢弃 + 角色判定；
 * - combat 射击命中/未命中 + 角色判定；
 * - 核心受伤/治疗/被毁（凶手）+ CORE 分流；
 * - 矿物按格聚合 + 刷新间隔（refill gap）；
 * - 空事件兜底。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateLifecycle, type LifecycleEvent } from "../lib/lifecycle-audit.ts";

const ev = (tick: number, kind: string, actor: string | null, position: [number, number] | null, extra: Partial<LifecycleEvent> = {}): LifecycleEvent => ({
  tick, kind, actor, target: null, reason: null, position, amount: null, hp: null,
  source: null, capacity: null, destroyedBy: null, destination: null, ...extra,
});

test("lifecycle-audit: worker/combat/core/矿物生命周期 + 消费汇总", () => {
  const evs: LifecycleEvent[] = [
    ev(100, "CORE_MOVE_SUCCEEDED", "core-1", [0, 0]),
    ev(101, "CORE_DAMAGED", "core-1", [0, 0], { amount: 3 }),
    ev(101, "UNIT_MOVE_SUCCEEDED", "w1", [1, 1]),
    ev(102, "HARVEST_SUCCEEDED", "w1", [5, 5], { amount: 2 }),
    ev(103, "HARVEST_SUCCEEDED", "w1", [5, 5], { amount: 2 }),
    ev(104, "DEPOSIT_SUCCEEDED", "w1", [0, 0], { amount: 4 }),
    ev(105, "WORKER_CARGO_DROPPED", "w1", [3, 3]),
    ev(106, "SHOT_HIT", "r1", [9, 9], { amount: 1 }),
    ev(107, "SHOT_MISSED", "r1", [9, 9]),
    ev(108, "UNIT_DESTROYED", "w1", [4, 4], { destroyedBy: "enemy-9" }),
  ];
  const a = aggregateLifecycle("t1", "run-1", evs);
  assert.equal(a.window.fromTick, 100);
  assert.equal(a.window.toTick, 108);
  assert.equal(a.window.events, 10);

  // 核心分流
  assert.ok(a.core, "core 存在");
  assert.equal(a.core?.actor, "core-1");
  assert.equal(a.core?.damageTaken, 3);
  assert.equal(a.core?.moveOk, 1);
  assert.equal(a.core?.destroyed, false);

  // worker 角色 + 计数 + 销毁
  const w1 = a.units.find((u) => u.actor === "w1");
  assert.ok(w1);
  assert.equal(w1?.role, "worker");
  assert.equal(w1?.harvest.ok, 2);
  assert.equal(w1?.harvest.amount, 4);
  assert.equal(w1?.deposit.ok, 1);
  assert.equal(w1?.deposit.amount, 4);
  assert.equal(w1?.drops, 1);
  assert.equal(w1?.alive, false);
  assert.equal(w1?.destroyedAtTick, 108);
  assert.equal(w1?.destroyedBy, "enemy-9");

  // combat 角色
  const r1 = a.units.find((u) => u.actor === "r1");
  assert.ok(r1);
  assert.equal(r1?.role, "combat");
  assert.equal(r1?.combat.shotsHit, 1);
  assert.equal(r1?.combat.shotsMissed, 1);
  assert.equal(r1?.alive, true);

  // 矿物按格聚合 + 刷新间隔
  const mine = a.mines.find((m) => m.cell === "5,5");
  assert.ok(mine);
  assert.equal(mine?.harvestCount, 2);
  assert.equal(mine?.harvestAmount, 4);
  assert.equal(mine?.firstSeenTick, 102);
  assert.equal(mine?.lastSeenTick, 103);
  assert.equal(mine?.refillGapTicks, 1, "两连采同格 → gap=1");

  // 消费汇总
  assert.equal(a.consumption.harvestOk, 2);
  assert.equal(a.consumption.harvestAmount, 4);
  assert.equal(a.consumption.depositOk, 1);
  assert.equal(a.consumption.depositAmount, 4);
  assert.equal(a.consumption.cargoDropped, 1);
  assert.equal(a.consumption.coreDamageTaken, 3);
  assert.equal(a.consumption.unitDestroyed, 1);
  assert.equal(a.consumption.destroyedByEnemy, 1);
});

test("lifecycle-audit: 核心被毁（凶手）+ 自爆 + 空事件兜底", () => {
  const evs: LifecycleEvent[] = [
    ev(200, "CORE_DESTROYED", "core-1", [0, 0], { destroyedBy: "enemy-7" }),
    ev(201, "SELF_DESTRUCT", "s1", [1, 1]),
  ];
  const a = aggregateLifecycle("t1", "run-2", evs);
  assert.equal(a.core?.destroyed, true);
  assert.equal(a.core?.destroyedAtTick, 200);
  assert.equal(a.core?.destroyedBy, "enemy-7");
  const s1 = a.units.find((u) => u.actor === "s1");
  assert.equal(s1?.alive, false);
  assert.equal(s1?.destroyedBy, "self");
  assert.equal(a.consumption.selfDestructs, 1);
  assert.equal(a.consumption.destroyedByEnemy, 1, "CORE_DESTROYED 凶手不算 unitDestroyed");

  const empty = aggregateLifecycle("t2", null, []);
  assert.equal(empty.units.length, 0);
  assert.equal(empty.mines.length, 0);
  assert.equal(empty.core, null);
  assert.equal(empty.window.events, 0);
});
