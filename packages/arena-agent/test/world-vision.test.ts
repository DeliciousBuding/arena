/**
 * 视线感知资源失效测试（2026-08-08，ref arena-hero-agent v0.2.0
 * "Vision-aware resource invalidation ... integer supercover lines"）：
 * - 被任意我方观察者"确认可见"（Manhattan 半径 + supercover 无遮挡）却不在
 *   本轮 resourceCells → 资源已采空 → 立即记 harvested 负记忆（不进 hints）；
 * - 视野外 / 障碍遮挡（不算确认）→ 降级 stale（仍提示，避免误删）；
 * - harvested 后 refill 重新可见 → 恢复 visible；
 * - 不同单位类型视野半径（WORKER 3 / VANGUARD 4 / RANGER 5 / CORE 5）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TickState } from "../src/domain/model.ts";
import { World } from "../src/domain/world.ts";

function makeState(tick: number, overrides: Partial<TickState> = {}): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 0,
    population: 1,
    core: {
      id: "11111111-1111-1111-1111-111111111111",
      position: [0, 0] as const,
      hp: 5,
      shield: 5,
      state: "NORMAL",
      ownerUsername: "p1",
    },
    units: [],
    workers: [],
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100] as const, status: "GROUND", carrierId: null },
    events: [],
    ...overrides,
  };
}

const WORKER_AT_ORIGIN = {
  units: [{ id: "p1-w", position: [0, 0] as const, hp: 2, unitType: "WORKER" as const, cargo: 0 }],
  workers: [{ id: "p1-w", position: [0, 0] as const, hp: 2, unitType: "WORKER" as const, cargo: 0 }],
};

test("视野确认缺失（worker 未动、资源格仍在半径内）→ harvested 负记忆", () => {
  const world = new World();
  // tick1：worker [0,0] 看到资源 [2,0]（Manhattan 2 ≤ 3）
  world.observe(makeState(100, {
    ...WORKER_AT_ORIGIN,
    resourceCells: new Set(["2,0"]),
  }));
  // tick2：资源不在列表，但 worker 仍 [0,0] → 视野确认缺失 → harvested
  world.observe(makeState(101, { ...WORKER_AT_ORIGIN }));
  const snap = world.snapshot();
  const mem = snap.resources.find((r) => r.cell === "2,0");
  assert.ok(mem, "记忆仍在");
  assert.equal(mem!.state, "harvested", "视野确认缺失应记 harvested");
  assert.ok(
    !world.resourceHints().some((p) => p[0] === 2 && p[1] === 0),
    "harvested 负记忆不进 hints",
  );
});

test("视野外（worker 移远、Manhattan > 半径）→ stale 仍提示", () => {
  const world = new World();
  world.observe(makeState(100, {
    ...WORKER_AT_ORIGIN,
    resourceCells: new Set(["2,0"]),
  }));
  // worker 移到 [10,0]（距 [2,0] 为 8 > 3）→ 视野外 → stale
  // （core:null 排除 Core 半径 5 的干扰——Core 默认 [0,0] 会覆盖 [2,0]）
  world.observe(makeState(101, {
    core: null,
    units: [{ id: "p1-w", position: [10, 0] as const, hp: 2, unitType: "WORKER", cargo: 0 }],
    workers: [{ id: "p1-w", position: [10, 0] as const, hp: 2, unitType: "WORKER", cargo: 0 }],
  }));
  const snap = world.snapshot();
  const mem = snap.resources.find((r) => r.cell === "2,0");
  assert.equal(mem!.state, "stale", "视野外应降级 stale");
  assert.ok(
    world.resourceHints().some((p) => p[0] === 2 && p[1] === 0),
    "stale 新鲜记忆仍提示",
  );
});

test("Core 视野确认缺失（半径 5）→ harvested", () => {
  const world = new World();
  // Core [0,0]（半径 5），资源 [4,0] 在 Core 视野内
  world.observe(makeState(100, { resourceCells: new Set(["4,0"]) }));
  world.observe(makeState(101, {}));
  const snap = world.snapshot();
  const mem = snap.resources.find((r) => r.cell === "4,0");
  assert.equal(mem!.state, "harvested", "Core 视野确认缺失应记 harvested");
});

test("seeded 种子被视野确认无矿 → harvested（v2 死种子批量证伪）", () => {
  const world = new World();
  // seed 注入（lastSeenTick=0，跨 run 测绘种子）
  world.seedResourceMemory([[2, 0]], 0);
  assert.ok(
    world.resourceCandidates().some((c) => c.cell[0] === 2 && c.cell[1] === 0),
    "seed 在候选",
  );
  // worker 在 [0,0] 视野覆盖 [2,0]（Manhattan 2 ≤ 3），资源不在本轮 →
  // seed 被视野确认无矿 → harvested（旧行为：seed 永不过期、只降级可见态，
  // 视野确认后仍入池 = 死种子循环）
  world.observe(makeState(101, { ...WORKER_AT_ORIGIN }));
  const snap = world.snapshot();
  const mem = snap.resources.find((r) => r.cell === "2,0");
  assert.equal(mem!.state, "harvested", "seed 被视野确认应记 harvested");
  assert.ok(
    !world.resourceCandidates().some((c) => c.cell[0] === 2 && c.cell[1] === 0),
    "证伪后不再入池（乒乓断链）",
  );
});

test("seeded 种子视野外 → 保持候选（不误伤未确认格）", () => {
  const world = new World();
  world.seedResourceMemory([[10, 0]], 0);
  // worker [0,0] 距 [10,0] = 10 > 3，Core 置 null 排除半径 5 → 视野外
  world.observe(makeState(101, {
    core: null,
    units: [{ id: "p1-w", position: [0, 0] as const, hp: 2, unitType: "WORKER", cargo: 0 }],
    workers: [{ id: "p1-w", position: [0, 0] as const, hp: 2, unitType: "WORKER", cargo: 0 }],
  }));
  assert.ok(
    world.resourceCandidates().some((c) => c.cell[0] === 10 && c.cell[1] === 0),
    "视野外 seed 保持候选（等 worker 实地勘察证伪）",
  );
});

test("stale 新鲜记忆被视野确认无矿 → harvested（v2 扩展）", () => {
  const world = new World();
  // tick1：worker [0,0] 看到资源 [2,0]
  world.observe(makeState(100, { ...WORKER_AT_ORIGIN, resourceCells: new Set(["2,0"]) }));
  // 资源不在本轮但仍在视野 → 一次 observe 后已 harvested（可见态也走失效）；
  // 这里验证 stale 态（worker 移远后降级 stale）再被视野确认 → harvested
  world.observe(makeState(101, { core: null, units: [], workers: [] })); // 移远 → stale
  let mem = world.snapshot().resources.find((r) => r.cell === "2,0");
  assert.equal(mem!.state, "stale", "视野外降级 stale");
  // worker 回来再确认 → stale 记忆同样被视野确认 harvested
  world.observe(makeState(102, { ...WORKER_AT_ORIGIN }));
  mem = world.snapshot().resources.find((r) => r.cell === "2,0");
  assert.equal(mem!.state, "harvested", "stale 记忆被视野确认应 harvested");
  assert.ok(
    !world.resourceCandidates().some((c) => c.cell[0] === 2 && c.cell[1] === 0),
    "stale 确认无矿后不再入池",
  );
});

test("障碍遮挡不算确认（资源在障碍后）→ stale 不误删", () => {
  const world = new World();
  // tick1：无遮挡时看到资源 [0,3]（worker 半径 3）
  world.observe(makeState(100, {
    ...WORKER_AT_ORIGIN,
    resourceCells: new Set(["0,3"]),
  }));
  // tick2：资源消失，但 [0,1] 出现障碍 → 视线被挡 → 不算确认缺失 → stale
  world.observe(makeState(101, {
    ...WORKER_AT_ORIGIN,
    obstacleCells: new Set(["0,1"]),
  }));
  const snap = world.snapshot();
  const mem = snap.resources.find((r) => r.cell === "0,3");
  assert.equal(mem!.state, "stale", "障碍遮挡不算确认，应 stale 不误删");
});

test("supercover 对角角侧障碍同样遮挡 → stale", () => {
  const world = new World();
  // worker [0,0] → 资源 [2,1]：supercover 途经 [1,0] 与 [1,1]（对角过角）
  world.observe(makeState(100, {
    ...WORKER_AT_ORIGIN,
    resourceCells: new Set(["2,1"]),
  }));
  // 角侧 [1,1] 为障碍 → 视线遮挡 → 不算确认缺失
  world.observe(makeState(101, {
    ...WORKER_AT_ORIGIN,
    obstacleCells: new Set(["1,1"]),
  }));
  const snap = world.snapshot();
  const mem = snap.resources.find((r) => r.cell === "2,1");
  assert.equal(mem!.state, "stale", "supercover 角侧障碍遮挡应 stale");
});

test("VANGUARD 视野半径 4 确认缺失 → harvested", () => {
  const world = new World();
  const vanguard = {
    units: [{ id: "p1-v", position: [0, 0] as const, hp: 2, unitType: "VANGUARD" as const, cargo: 0 }],
    vanguards: [{ id: "p1-v", position: [0, 0] as const, hp: 2, unitType: "VANGUARD" as const, cargo: 0 }],
  };
  // [4,0]：Manhattan 4 ≤ VANGUARD 4，但 > WORKER 3 —— 覆盖 VANGUARD 半径分支
  // （Core 移到 [50,50]，不参与覆盖）
  world.observe(makeState(100, {
    core: { id: "11111111-1111-1111-1111-111111111111", position: [50, 50] as const, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    ...vanguard,
    resourceCells: new Set(["4,0"]),
  }));
  world.observe(makeState(101, {
    core: { id: "11111111-1111-1111-1111-111111111111", position: [50, 50] as const, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    ...vanguard,
  }));
  const snap = world.snapshot();
  const mem = snap.resources.find((r) => r.cell === "4,0");
  assert.equal(mem!.state, "harvested", "VANGUARD 视野确认缺失应 harvested");
});

test("harvested 后 refill 重新可见 → 恢复 visible 并提示", () => {
  const world = new World();
  world.observe(makeState(100, {
    ...WORKER_AT_ORIGIN,
    resourceCells: new Set(["2,0"]),
  }));
  world.observe(makeState(101, { ...WORKER_AT_ORIGIN })); // → harvested
  world.observe(makeState(102, {
    ...WORKER_AT_ORIGIN,
    resourceCells: new Set(["2,0"]), // refill
  }));
  const snap = world.snapshot();
  const mem = snap.resources.find((r) => r.cell === "2,0");
  assert.equal(mem!.state, "visible", "refill 后应恢复 visible");
  assert.ok(
    world.resourceHints().some((p) => p[0] === 2 && p[1] === 0),
    "恢复可见后应进入 hints",
  );
});
