/**
 * 事件类型中央注册表测试（agent-ecosystem P4h）：
 * - 完整性：源码中所有 eventOf(...) 调用的事件类型字面量都在 EVENT_TYPES 中
 *   （源码扫描，防新事件类型漏注册）；
 * - 类别覆盖：EVENT_TYPES 每个条目恰好属于一个类别（EVENT_CATEGORY_TYPES）；
 * - assertKnownEventType：已知类型通过、未知类型抛错；
 * - ledger：真实 episode 跑完后所有玩家 unrecognizedEventCount === 0，且
 *   类别计数（eventCounts）按注册表聚合（movement/economy 等 > 0）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { runEpisode } from "../src/sim/harness/episode.ts";
import {
  EVENT_CATEGORY_TYPES,
  EVENT_TYPES,
  assertKnownEventType,
} from "../src/sim/engine/phase.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.14.json");
const SCENARIO_PATH = join(here, "..", "scripts", "scenarios", "three-way.json");
const ENGINE_DIR = join(here, "..", "src", "sim", "engine");

/** 匹配 eventOf(<first-arg>, "<EVENT_TYPE>", ...) 的第二个字符串参数。 */
const EVENT_OF_LITERAL = /eventOf\(\s*[^,]+,\s*"([A-Z][A-Z0-9_]+)"/g;

const RESOLVER_FILES = [
  "beacon.ts",
  "combat.ts",
  "core-migration.ts",
  "economy.ts",
  "movement.ts",
  "respawn.ts",
];

test("注册表完整性：源码中所有 eventOf 事件类型字面量都在 EVENT_TYPES 中", () => {
  const known = new Set<string>(EVENT_TYPES);
  const usedInCode = new Set<string>();
  for (const file of RESOLVER_FILES) {
    const source = readFileSync(join(ENGINE_DIR, file), "utf-8");
    for (const match of source.matchAll(EVENT_OF_LITERAL)) {
      usedInCode.add(match[1]!);
    }
  }
  assert.ok(usedInCode.size > 0, "must find eventOf literals in resolver sources");
  const missing = [...usedInCode].filter((type) => !known.has(type));
  assert.deepEqual(missing, [], `eventOf types missing from EVENT_TYPES: ${missing.join(", ")}`);
});

test("注册表完整性：EVENT_TYPES 无重复", () => {
  assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length, "EVENT_TYPES must not contain duplicates");
});

test("类别覆盖：EVENT_TYPES 每个条目恰好属于一个类别", () => {
  const seen = new Map<string, string>();
  for (const [category, types] of Object.entries(EVENT_CATEGORY_TYPES)) {
    for (const type of types) {
      const prior = seen.get(type);
      assert.equal(
        prior,
        undefined,
        `"${type}" duplicated in categories "${prior}" and "${category}"`,
      );
      seen.set(type, category);
    }
  }
  assert.equal(seen.size, EVENT_TYPES.length, "category union must cover EVENT_TYPES exactly");
  for (const type of EVENT_TYPES) {
    assert.ok(seen.has(type), `"${type}" in EVENT_TYPES but missing from categories`);
  }
});

test("assertKnownEventType：未知类型抛错", () => {
  assert.throws(() => assertKnownEventType("NOT_A_REAL_EVENT"), /unknown resolution event type/);
  assert.throws(() => assertKnownEventType(""), /unknown resolution event type/);
  assert.throws(() => assertKnownEventType("unit_move_succeeded"), /unknown resolution event type/);
});

test("assertKnownEventType：全部已知类型通过且原样返回", () => {
  for (const type of EVENT_TYPES) {
    assert.equal(assertKnownEventType(type), type);
  }
});

test("ledger：episode 后 unrecognizedEventCount === 0 且类别计数按注册表聚合", () => {
  const scenario = JSON.parse(readFileSync(SCENARIO_PATH, "utf-8")) as unknown;
  const result = runEpisode({
    scenario,
    rulesPath: MANIFEST_PATH,
    seed: 42,
    ticks: 100,
    tenants: [
      { id: "p1", planner: "deterministic" },
      { id: "p2", planner: "deterministic" },
      { id: "p3", planner: "deterministic" },
    ],
  });
  assert.ok(result.metrics.totalEvents > 0, "episode must produce events");

  // episode 中实际出现的事件类型都必须已在注册表内（eventOf 创建入口校验的
  // 端到端证据；任何绕过 eventOf 的新事件路径在此拦截）。
  const eventTypesSeen = new Set(
    result.records.flatMap((record) => record.events.map((event) => event.eventType)),
  );
  const known = new Set<string>(EVENT_TYPES);
  const unknownSeen = [...eventTypesSeen].filter((type) => !known.has(type));
  assert.deepEqual(unknownSeen, [], `events produced with unknown types: ${unknownSeen.join(", ")}`);

  for (const playerId of ["p1", "p2", "p3"]) {
    const ledger = result.metrics.perPlayer[playerId];
    assert.ok(ledger !== undefined, `${playerId} ledger must exist`);
    assert.equal(
      ledger.unrecognizedEventCount,
      0,
      `${playerId} must not observe unrecognized events (got ${ledger.unrecognizedEventCount})`,
    );
    const categoryTotal = Object.values(ledger.eventCounts).reduce((sum, count) => sum + count, 0);
    assert.ok(categoryTotal > 0, `${playerId} category counts must accumulate`);
  }

  // 类别聚合真实工作：三路对打必然产生移动与经济活动（战斗/采集/重生类别
  // 至少其一在部分玩家上 > 0；movement 与 economy 应普遍 > 0）。
  const p1 = result.metrics.perPlayer["p1"]!;
  assert.ok(p1.eventCounts.movement > 0, "movement category must count");
  assert.ok(p1.eventCounts.economy > 0, "economy category must count");
  assert.equal(p1.unrecognizedEventCount, 0);
});
