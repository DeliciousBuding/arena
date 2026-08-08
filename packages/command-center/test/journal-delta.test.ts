/**
 * 日记窗口对比测试（2026-08-08）：
 * - buildWindowDelta：类别计数 cur/prev/delta + 叙事（新增/归零/±N）；
 * - 无显著变化 / 空输入兜底。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWindowDelta } from "../lib/deeds-journal.ts";
import type { Deed } from "../lib/deeds.ts";

const deed = (kind: string, tick: number, star: 1 | 2 | 3 | 4 = 1, tenant = "t1"): Deed => ({
  id: `${kind}-${tick}`, tick, tenant, star, kind,
  title: kind, detail: "", position: null, actor: null, target: null,
});

test("journal-delta: 类别变化 + 叙事", () => {
  // 本窗口：采集 3 交付 1 阵亡 2；上一窗口：采集 1 交付 2 阵亡 0
  const cur = [deed("HARVEST_SUCCEEDED", 9000), deed("HARVEST_SUCCEEDED", 9100), deed("HARVEST_SUCCEEDED", 9200), deed("DEPOSIT_SUCCEEDED", 9300), deed("UNIT_DESTROYED", 9400), deed("UNIT_DESTROYED", 9500)];
  const prev = [deed("HARVEST_SUCCEEDED", 5000), deed("DEPOSIT_SUCCEEDED", 5100), deed("DEPOSIT_SUCCEEDED", 5200)];
  const d = buildWindowDelta(cur, prev);
  assert.equal(d.counts.harvest.cur, 3);
  assert.equal(d.counts.harvest.prev, 1);
  assert.equal(d.counts.harvest.delta, 2);
  assert.equal(d.counts.deposit.delta, -1);
  assert.equal(d.counts.death.cur, 2);
  assert.equal(d.counts.death.prev, 0);
  assert.ok(d.narrative.includes("采集 +2"), d.narrative);
  assert.ok(!d.narrative.includes("交付"), "|delta|=1 低于显著阈值不进叙事");
  assert.ok(d.narrative.includes("阵亡 新增 2"), d.narrative);
});

test("journal-delta: 无显著变化 + 空输入", () => {
  const a = buildWindowDelta([], []);
  assert.equal(Object.keys(a.counts).length, 0);
  assert.equal(a.narrative, "较上一窗口无显著变化。");
  // 0→N 算新增（无论幅度）；数量相同才算无显著变化
  const b = buildWindowDelta([deed("HARVEST_SUCCEEDED", 9000)], []);
  assert.equal(b.counts.harvest.delta, 1);
  assert.ok(b.narrative.includes("采集 新增 1"), b.narrative);
  const c = buildWindowDelta([deed("HARVEST_SUCCEEDED", 9000)], [deed("HARVEST_SUCCEEDED", 5000)]);
  assert.equal(c.counts.harvest.delta, 0);
  assert.ok(c.narrative.includes("较上一窗口无显著变化"), c.narrative);
});
