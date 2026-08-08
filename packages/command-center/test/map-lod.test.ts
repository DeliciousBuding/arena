/** 地图 LOD 聚合测试（2026-08-08）：aggregateMapLod——chunk 级聚合计数/最新 tick/
 *  租户独立/空兕底。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateMapLod, MAP_LOD_CHUNK } from "../lib/map-lod.ts";

test("map-lod: chunk 聚合计数 + 最新 tick + 排序", () => {
  const resources = [
    { x: 1, y: 1, tick: 100 },    // chunk (0,0)
    { x: 17, y: 3, tick: 200 },   // chunk (1,0)
    { x: 2, y: 2, tick: 300 },    // chunk (0,0)
  ];
  const obstacles = [
    { x: 0, y: 0, tick: 150 },    // chunk (0,0)
  ];
  const cores = [
    { x: 16, y: 16, tick: 400 },  // chunk (1,1)
  ];
  const out = aggregateMapLod("t1", resources, obstacles, cores);
  assert.equal(out.length, 3);
  const c00 = out.find((c) => c.cx === 0 && c.cy === 0);
  assert.ok(c00, "chunk (0,0) 存在");
  assert.equal(c00.resourceCount, 2);
  assert.equal(c00.obstacleCount, 1);
  assert.equal(c00.coreCount, 0);
  assert.equal(c00.lastTick, 300, "该 chunk 最新 tick");
  assert.equal(c00.tenant, "t1");
  const c11 = out.find((c) => c.cx === 1 && c.cy === 1);
  assert.equal(c11?.coreCount, 1);
  // 排序：lastTick 降序（1,1 @400 最先）
  assert.equal(out[0]?.cx, 1);
  assert.equal(out[0]?.cy, 1);
  assert.equal(MAP_LOD_CHUNK, 16);
});

test("map-lod: 空输入兕底 + 多租户独立", () => {
  assert.deepEqual(aggregateMapLod("t2", [], [], []), [], "空输入 → 空数组");
  const out = aggregateMapLod("t3", [{ x: 1, y: 1, tick: 50 }], [], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].tenant, "t3", "租户独立保留");
  assert.equal(out[0].resourceCount, 1);
});
