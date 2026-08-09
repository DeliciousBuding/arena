/**
 * P4g-2 respawn 常量 manifest 化（agent-ecosystem P4g，2026-08-09）：
 * rules manifest 新增**可选** rules.respawn 节点
 * （minDistance/maxDistance/minPassableNeighbors/densityRadius）。
 *
 * 设计约束：
 * - rules-v0.11/v0.14.json 是已发布 manifest，**不改文件本体** → 解析结果
 *   与旧版逐字节一致 → manifestHash 不变（本文件钉定 hash 作回归护栏）；
 * - 缺省（内置 manifest 无该节点）→ resolveRespawnConfig 回退现值
 *   （DEFAULT_RESPAWN_CONFIG = 20/30/2/5），行为零变化；
 * - 仅外部自定义 rules 文件可携带该节点覆盖；非法值 fail closed。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position } from "../src/domain/model.ts";
import {
  loadRulesManifestForVersion,
  manifestHash,
  parseRulesManifest,
  RulesManifestError,
  type RulesManifest,
} from "../src/sim/contracts/rules-manifest.ts";
import {
  DEFAULT_RESPAWN_CONFIG,
  RESPAWN_DISTANCE_MAX,
  RESPAWN_DISTANCE_MIN,
  resolveRespawnConfig,
} from "../src/sim/engine/respawn.ts";
import { idlePlans, settleTick, type SettlementContext } from "../src/sim/engine/settlement.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = join(here, "..", "src", "sim", "contracts");
const V014_PATH = join(CONTRACT_DIR, "rules-v0.14.json");

/** 已发布 manifest hash（2026-08-09 P4g 改动前记录；缺省路径不得改变它们）。 */
const PINNED_V011_HASH = "b63e06374a1350920bad4a1a5bb83f8b9d0936882c2e42ad448a7ba460482337";
const PINNED_V014_HASH = "5bbfe863c296b0d48308ba26072b89c027dfc67c8208228bd98d166f1fa90770";

/** 从内置 v0.14 文件派生自定义 manifest（deep clone 后注入 rules.respawn）。 */
function customManifest(respawn: Record<string, unknown>) {
  const raw = JSON.parse(readFileSync(V014_PATH, "utf8")) as Record<string, unknown>;
  (raw.rules as Record<string, unknown>).respawn = respawn;
  return parseRulesManifest(raw);
}

const P2_CORE = "33333333-3333-3333-3333-333333333333";

/** p1 初始 RESPAWNING（首 tick 到期），p2 活 Core 作距离参照。 */
function makeWorld(
  p2Core: Position,
  terrain: { readonly obstacles: readonly Position[] } = { obstacles: [] },
) {
  return worldFromScenario({
    rulesVersion: "v0.14",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 0,
        status: "RESPAWNING",
        respawnAtTick: 1,
        core: null,
        units: [],
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: P2_CORE, position: p2Core, hp: 5, shield: 5, state: "NORMAL" },
        units: [],
      },
    ],
    terrain: { obstacles: terrain.obstacles, resources: [], piles: [] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  });
}

function settleWith(rules: RulesManifest) {
  const ctx: SettlementContext = { rules, rng: null };
  const world = makeWorld([50, 50]);
  const result = settleTick(world, idlePlans(world), ctx);
  return { result, p1: result.world.players.get("p1")! };
}

/* ---------------- 缺省路径：内置 manifest 行为零变化 ---------------- */

test("P4g-2: 内置 manifest 不含 rules.respawn → manifestHash 钉定不变", () => {
  for (const [version, pinned] of [
    ["v0.11", PINNED_V011_HASH],
    ["v0.14", PINNED_V014_HASH],
  ] as const) {
    const manifest = loadRulesManifestForVersion(version);
    assert.equal(manifest.rules.respawn, undefined, `${version} built-in must not carry rules.respawn`);
    assert.equal(manifestHash(manifest), pinned, `${version} published manifest hash must be stable`);
  }
});

test("P4g-2: 缺省配置回退现值（resolveRespawnConfig + 默认结算行为不变）", () => {
  const manifest = loadRulesManifestForVersion("v0.14");
  assert.deepEqual(resolveRespawnConfig(manifest), DEFAULT_RESPAWN_CONFIG);
  assert.deepEqual(DEFAULT_RESPAWN_CONFIG, {
    minDistance: RESPAWN_DISTANCE_MIN,
    maxDistance: RESPAWN_DISTANCE_MAX,
    minPassableNeighbors: 2,
    densityRadius: 5,
  });

  // 缺省 manifest 结算：仍走 20-30 环带（与 P4g 改动前一致）
  const { result, p1 } = settleWith(loadRulesManifestForVersion("v0.14"));
  assert.equal(p1.status, "ACTIVE");
  assert.deepEqual(p1.core!.position, [20, 50], "default ring still picks [20,50]");
  assert.ok(result.events.some((event) => event.eventType === "CORE_RESPAWNED"));
});

/* ---------------- 自定义 rules.respawn：参数生效 ---------------- */

test("P4g-2: 自定义 rules.respawn 距离区间生效（1..2 环带 → 确定性格 [48,50]）", () => {
  const rules = customManifest({ minDistance: 1, maxDistance: 2, minPassableNeighbors: 0, densityRadius: 5 });
  const { result, p1 } = settleWith(rules);
  assert.equal(p1.status, "ACTIVE");
  assert.deepEqual(p1.core!.position, [48, 50], "min x among d=1..2 ring around [50,50]");
  const [cx, cy] = p1.core!.position;
  const distance = Math.abs(cx - 50) + Math.abs(cy - 50);
  assert.ok(distance >= 1 && distance <= 2, `distance ${distance}`);
  assert.ok(result.events.some((event) => event.eventType === "CORE_RESPAWNED"));
});

test("P4g-2: minPassableNeighbors 参数生效（1 个可通行邻居的格被选中/被拒绝）", () => {
  // 把 [1,0] 四邻中的三个围死（仅剩 [0,0] 可通行）；d=1 其余格全障碍。
  // p2 Core 在 [0,0]；[1,0] 是唯一 d=1 候选格。
  const world = makeWorld([0, 0], {
    obstacles: [[2, 0], [1, 1], [1, -1], [0, 1], [-1, 0], [0, -1]],
  });

  // 邻居要求放宽到 0 → [1,0] 合法，确定性选中
  const relaxed = customManifest({ minDistance: 1, maxDistance: 1, minPassableNeighbors: 0, densityRadius: 5 });
  const relaxedResult = settleTick(world, idlePlans(world), { rules: relaxed, rng: null });
  assert.equal(relaxedResult.world.players.get("p1")!.status, "ACTIVE");
  assert.deepEqual(relaxedResult.world.players.get("p1")!.core!.position, [1, 0]);

  // 邻居要求 2 → [1,0] 非法且无其他候选 → RESPAWN_DELAYED
  const strict = customManifest({ minDistance: 1, maxDistance: 1, minPassableNeighbors: 2, densityRadius: 5 });
  const strictResult = settleTick(world, idlePlans(world), { rules: strict, rng: null });
  const p1 = strictResult.world.players.get("p1")!;
  assert.equal(p1.status, "RESPAWNING");
  assert.equal(p1.respawnAtTick, 2, "retry scheduled for next tick");
  assert.ok(strictResult.events.some((event) => event.eventType === "RESPAWN_DELAYED"));
  assert.ok(!strictResult.events.some((event) => event.eventType === "CORE_RESPAWNED"));
});

/* ---------------- rules.respawn 校验 fail closed ---------------- */

test("P4g-2: rules.respawn 非法值 fail closed", () => {
  const base = { minDistance: 1, maxDistance: 2, minPassableNeighbors: 0, densityRadius: 5 };
  assert.throws(() => customManifest({ ...base, maxDistance: 0 }), RulesManifestError);
  assert.throws(() => customManifest({ ...base, maxDistance: 1, minDistance: 2 }), RulesManifestError);
  assert.throws(() => customManifest({ ...base, minDistance: 0 }), RulesManifestError);
  assert.throws(() => customManifest({ ...base, minPassableNeighbors: 5 }), RulesManifestError);
  assert.throws(() => customManifest({ ...base, minPassableNeighbors: -1 }), RulesManifestError);
  assert.throws(() => customManifest({ ...base, densityRadius: 0 }), RulesManifestError);
  assert.throws(() => customManifest({ ...base, densityRadius: 1.5 }), RulesManifestError);
  assert.throws(() => customManifest({ minDistance: 1 }), RulesManifestError, "partial section rejected");
});
