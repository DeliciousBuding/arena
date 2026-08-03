/**
 * S2 确定性原语与 SimWorld 测试：
 * UUID raw 序（Python bytes 对齐）、safe coordinate、seeded RNG、
 * scenario/raw snapshot 载入、world invariants、canonical hash。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { cellKey } from "../src/domain/model.ts";
import { compareUuidRaw, sortByUuidRaw } from "../src/sim/deterministic/uuid.ts";
import { assertSafeCoordinate, UnsupportedCoordinateError } from "../src/sim/deterministic/coordinate.ts";
import { createSeededRng } from "../src/sim/deterministic/rng.ts";
import { canonicalWorldJson, worldHash } from "../src/sim/world/canonical.ts";
import { loadRawStateFile, worldFromScenario } from "../src/sim/world/loaders.ts";
import { buildOccupancy, validateWorld, WorldInvariantError } from "../src/sim/world/world.ts";
import type { SimPlayer, SimWorld } from "../src/sim/world/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..");
const FIXTURE_STATE = join(REPO_ROOT, "fixtures", "differential", "burnin-20260802-a", "40437.json");

/* ---------------- UUID raw order ---------------- */

test("S2: compareUuidRaw 与 Python UUID.bytes 顺序一致（固定向量）", () => {
  // 按 Python sorted(uuid.UUID(x).bytes) 手工推演的期望顺序
  const samples = [
    "00000000-0000-0000-0000-000000000001",
    "00000000-0000-0000-0000-00000000000a",
    "00000000-0000-0000-0000-000000000010",
    "00000000-0000-0000-0000-0000000000ff",
    "00000000-0000-0000-0000-000000000100",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
  ];
  for (let i = 0; i < samples.length - 1; i += 1) {
    assert.equal(compareUuidRaw(samples[i], samples[i + 1]), -1, `${samples[i]} < ${samples[i + 1]}`);
    assert.equal(compareUuidRaw(samples[i + 1], samples[i]), 1);
  }
  assert.equal(compareUuidRaw(samples[0], samples[0]), 0);
});

test("S2: 非法 UUID 拒绝（fail closed）", () => {
  assert.throws(() => compareUuidRaw("not-a-uuid", "00000000-0000-0000-0000-000000000001"));
  assert.throws(() => compareUuidRaw("00000000-0000-0000-0000-000000000001", ""));
  // 大写不是 canonical——拒绝（防止 locale 折叠乱序）
  assert.throws(() => compareUuidRaw("00000000-0000-0000-0000-0000000000FF", "00000000-0000-0000-0000-000000000001"));
});

test("S2: sortByUuidRaw 稳定按 raw 序", () => {
  const a = { id: "00000000-0000-0000-0000-0000000000ff" };
  const b = { id: "00000000-0000-0000-0000-00000000000a" };
  const c = { id: "00000000-0000-0000-0000-000000000001" };
  const sorted = sortByUuidRaw([a, b, c]);
  assert.deepEqual(sorted.map((x) => x.id), [c.id, b.id, a.id]);
});

/* ---------------- safe coordinate ---------------- */

test("S2: 超出 JS safe integer 的坐标 fail closed", () => {
  assert.throws(() => assertSafeCoordinate([Number.MAX_SAFE_INTEGER + 1, 0]), UnsupportedCoordinateError);
  assert.throws(() => assertSafeCoordinate([0, -Number.MAX_SAFE_INTEGER - 2]), UnsupportedCoordinateError);
  assert.throws(() => assertSafeCoordinate([1.5, 0]), UnsupportedCoordinateError);
  assert.throws(() => assertSafeCoordinate([NaN, 0]), UnsupportedCoordinateError);
  assert.doesNotThrow(() => assertSafeCoordinate([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]));
  assert.doesNotThrow(() => assertSafeCoordinate([0, 0]));
});

/* ---------------- seeded RNG ---------------- */

test("S2: 同 seed 同序列、不同 seed 不同序列", () => {
  const a = createSeededRng(42);
  const b = createSeededRng(42);
  const c = createSeededRng(43);
  const seqA = Array.from({ length: 8 }, () => a.next());
  const seqB = Array.from({ length: 8 }, () => b.next());
  assert.deepEqual(seqA, seqB, "same seed must produce identical sequence");
  assert.notDeepEqual(seqA, Array.from({ length: 8 }, () => c.next()), "different seed must differ");
  // 值域 [0,1)
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
  assert.equal(a.consumed, 8);
});

/* ---------------- scenario loader + invariants ---------------- */

const BASE_SCENARIO = {
  rulesVersion: "v0.11",
  tick: 1,
  seed: 7,
  players: [
    {
      id: "p1",
      username: "p1",
      resources: 5,
      core: {
        id: "11111111-1111-1111-1111-111111111111",
        position: [0, 0],
        hp: 5,
        shield: 5,
        state: "NORMAL",
      },
      units: [
        {
          id: "22222222-2222-2222-2222-222222222222",
          owner: "p1",
          position: [1, 0],
          hp: 2,
          unitType: "WORKER",
          cargo: 0,
        },
      ],
    },
  ],
  terrain: { obstacles: [[2, 2]], resources: [[3, 0]] },
  beacon: { position: [0, 0] },
};

test("S2: scenario 构造合法 world 且 invariants 通过", () => {
  const world = worldFromScenario(BASE_SCENARIO);
  assert.equal(world.rulesVersion, "v0.11");
  assert.equal(world.players.size, 1);
  assert.equal(world.players.get("p1")!.units.length, 1);
  assert.equal(world.terrain.obstacles.has("2,2"), true);
  assert.equal(world.terrain.resources.has("3,0"), true);
  assert.deepEqual(validateWorld(world), []);
  const occupancy = buildOccupancy(world);
  assert.equal(occupancy.get("0,0"), 1);
  assert.equal(occupancy.get("1,0"), 1);
});

test("S2: 重复 unit id 拒绝", () => {
  const bad = structuredClone(BASE_SCENARIO);
  (bad.players[0].units as unknown[]).push({ ...bad.players[0].units[0] });
  assert.throws(() => worldFromScenario(bad), /duplicate unit id/);
});

test("S2: 坐标超界拒绝（scenario 层）", () => {
  const bad = structuredClone(BASE_SCENARIO);
  bad.players[0].core.position = [Number.MAX_SAFE_INTEGER + 1, 0];
  assert.throws(() => worldFromScenario(bad), /UNSUPPORTED_COORDINATE_RANGE/);
});

test("S2: 跨玩家共格触发 invariant", () => {
  // 构造层 fail fast：worldFromScenario 直接拒绝
  assert.throws(
    () =>
      worldFromScenario({
        rulesVersion: "v0.11",
        players: [
          {
            id: "p1",
            username: "p1",
            resources: 0,
            core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
            units: [{ id: "22222222-2222-2222-2222-222222222222", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
          },
          {
            id: "p2",
            username: "p2",
            resources: 0,
            core: null,
            units: [{ id: "33333333-3333-3333-3333-333333333333", owner: "p2", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
          },
        ],
        terrain: { obstacles: [], resources: [] },
      }),
    WorldInvariantError,
  );
  // validateWorld 层：绕过构造器也能分类检出
  const world = worldFromScenario(BASE_SCENARIO);
  const p1 = world.players.get("p1")!;
  const bad = {
    ...world,
    players: new Map<string, SimPlayer>([
      [
        "p1",
        {
          ...p1,
          units: [
            ...p1.units,
            {
              id: "33333333-3333-3333-3333-333333333333",
              owner: "p1",
              position: [1, 0],
              hp: 2,
              unitType: "WORKER",
              cargo: 0,
            },
          ],
        },
      ],
      [
        "p2",
        {
          id: "p2",
          username: "p2",
          status: "ACTIVE",
          resources: 0,
          core: null,
          units: [{ id: "55555555-5555-5555-5555-555555555555", owner: "p2", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
        },
      ],
    ]),
  } as unknown as SimWorld;
  const problems = validateWorld(bad);
  assert.ok(problems.some((p) => p.includes("shared by players")), problems.join("; "));
});

test("S2: 容量超限与负资源触发 invariant", () => {
  const world = worldFromScenario(BASE_SCENARIO);
  const bad = {
    ...world,
    players: new Map([
      [
        "p1",
        {
          ...world.players.get("p1")!,
          resources: -1,
          units: [
            ...world.players.get("p1")!.units,
            {
              id: "44444444-4444-4444-4444-444444444444",
              owner: "p1",
              position: [1, 0],
              hp: 2,
              unitType: "WORKER",
              cargo: 0,
            },
            {
              id: "66666666-6666-6666-6666-666666666666",
              owner: "p1",
              position: [1, 0],
              hp: 2,
              unitType: "WORKER",
              cargo: 0,
            },
          ],
        },
      ],
    ]),
  } as unknown as SimWorld;
  const problems = validateWorld(bad);
  assert.ok(problems.some((p) => p.includes("negative resources")), problems.join("; "));
  assert.ok(problems.some((p) => p.includes("occupancy")), problems.join("; "));
});

/* ---------------- canonical hash ---------------- */

test("S2: canonical hash 与插入顺序无关、两次一致", () => {
  const world = worldFromScenario(BASE_SCENARIO);
  assert.equal(worldHash(world), worldHash(world));
  assert.match(worldHash(world), /^[0-9a-f]{64}$/);
  // 换插入顺序重建（scenario 翻转 unit 数组顺序）→ hash 不变
  const reordered = structuredClone(BASE_SCENARIO);
  reordered.players[0].units.reverse();
  assert.equal(worldHash(worldFromScenario(reordered)), worldHash(world));
  // 不同内容 hash 不同
  const different = structuredClone(BASE_SCENARIO);
  different.seed = 99;
  assert.notEqual(worldHash(worldFromScenario(different)), worldHash(world));
});

/* ---------------- raw snapshot loader（真实 fixture） ---------------- */

test("S2: 真实 fixture raw state 载入成功且 invariants 通过", () => {
  const world = loadRawStateFile(FIXTURE_STATE, "t1", "v0.11");
  assert.equal(world.players.size, 1);
  const player = world.players.get("t1")!;
  assert.equal(player.username, "fixture_user");
  assert.ok(player.core !== null, "fixture has controlled core");
  assert.ok(player.units.length >= 1, "fixture has controlled units");
  assert.ok(world.terrain.obstacles.size > 0, "fixture has obstacles");
  assert.deepEqual(validateWorld(world), []);
  // tick 从 1 起（raw state 无模拟时钟；校准阶段再对齐真实 tick）
  assert.equal(world.tick, 1);
});

test("S2: loader 不修改输入文件（载入后 fixture hash 不变）", () => {
  const before = createHash("sha256").update(readFileSync(FIXTURE_STATE)).digest("hex");
  loadRawStateFile(FIXTURE_STATE, "t1", "v0.11");
  const after = createHash("sha256").update(readFileSync(FIXTURE_STATE)).digest("hex");
  assert.equal(after, before);
});
