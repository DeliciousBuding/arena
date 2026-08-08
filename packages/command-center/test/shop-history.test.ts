/**
 * 商店价格历史记录层测试（2026-08-08）：
 * - normalizeProducts：官方行 → 紧凑条目；
 * - snapshotSignature / shouldAppend：同快照去重、变化才追加；
 * - aggregateShopHistory：每商品 current/delta（vs 上一快照）+ 首末见；
 * - 空数据兜底。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeProducts, snapshotSignature, shouldAppend,
  aggregateShopHistory, type ShopHistoryEntry,
} from "../lib/shop-history.ts";

test("shop-history: 归一 + 去重 + 变化追加", () => {
  const rows = [
    { id: "a1", name: "A", resource_cost: 95, available_stock: 10, purchase_limit: 1 },
    { id: "b2", name: "B", resource_cost: 50, available_stock: 0, purchase_limit: 5 },
  ];
  const p = normalizeProducts(rows);
  assert.equal(p.length, 2);
  assert.equal(p[0].resourceCost, 95);
  assert.equal(p[0].availableStock, 10);
  assert.equal(snapshotSignature(p).includes("a1:95:10"), true);
  assert.equal(snapshotSignature(p).includes("b2:50:0"), true);

  const same = normalizeProducts(rows);
  assert.equal(shouldAppend({ at: "2026-08-08T00:00:00.000Z", products: p }, same), false, "全同不追加");
  const changed = normalizeProducts([{ ...rows[0], available_stock: 9 }, rows[1]]);
  assert.equal(shouldAppend({ at: "2026-08-08T00:00:00.000Z", products: p }, changed), true, "库存变化要追加");
  assert.equal(shouldAppend(null, p), true, "首条追加");
});

test("shop-history: 趋势聚合 current/delta + 空兜底", () => {
  const entries: ShopHistoryEntry[] = [
    { at: "2026-08-08T00:00:00.000Z", products: normalizeProducts([{ id: "a1", name: "A", resource_cost: 95, available_stock: 10, purchase_limit: 1 }]) },
    { at: "2026-08-08T00:05:00.000Z", products: normalizeProducts([{ id: "a1", name: "A", resource_cost: 110, available_stock: 7, purchase_limit: 1 }]) },
    { at: "2026-08-08T00:10:00.000Z", products: normalizeProducts([{ id: "a1", name: "A", resource_cost: 110, available_stock: 7, purchase_limit: 1 }]) },
  ];
  const p = aggregateShopHistory(entries);
  assert.equal(p.snapshots, 3);
  assert.equal(p.productCount, 1);
  const t = p.trends[0];
  assert.equal(t.id, "a1");
  assert.equal(t.currentCost, 110);
  assert.equal(t.costDelta, 0, "最近两快照价格未变");
  assert.equal(t.stockDelta, 0);
  assert.equal(t.snapshots, 3);
  assert.equal(t.firstSeenAt, "2026-08-08T00:00:00.000Z");
  assert.equal(t.lastSeenAt, "2026-08-08T00:10:00.000Z");

  const e = aggregateShopHistory([]);
  assert.equal(e.snapshots, 0);
  assert.equal(e.trends.length, 0);
  assert.equal(e.lastSnapshotAt, null);
});
