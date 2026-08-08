/**
 * 战术规则层测试（2026-08-08）：tactical.ts 纯常量 + 纯函数——
 * 单位成本/核心容量/意图标签/近邻命中/障碍地形/移动可达方向。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  tactUnitCost, tactCoreCapacity, intentLabelCn,
  tactObjectNear, tactObjectAt, tactTerrain, tactHostileAt, tactMoveTargets,
  tactRangerRange, tactRangerTargets, tactVisibility, tactAvailability,
  TACT_ACTION_CN, TACT_ACTION_ICON, EVENT_KIND_CN, EVENT_ICON, DEED_ICON,
} from "../src/engine/tactical.ts";

const mkWorld = (objects: any[]): any => ({ state: { objects } });

test("tact-unit-cost: 人口阶梯 1.3 指数（pop<20 基准价）", () => {
  assert.equal(tactUnitCost("WORKER", 5), 5);
  assert.equal(tactUnitCost("VANGUARD", 0), 10);
  assert.equal(tactUnitCost("WORKER", 20), Math.round(5 * 1.3));       // 6.5 → 7
  assert.equal(tactUnitCost("WORKER", 24), Math.round(5 * 1.3));       // 6.5 → 7（未跨档）
  assert.equal(tactUnitCost("WORKER", 25), Math.round(5 * Math.pow(1.3, 2))); // 8.45 → 8
});

test("tact-core-capacity: 下限 10，人口×5", () => {
  assert.equal(tactCoreCapacity(0), 10);
  assert.equal(tactCoreCapacity(10), 50);
  assert.equal(tactCoreCapacity(-5), 10);
});

test("intent-label: 意图短中文标签映射", () => {
  assert.equal(intentLabelCn("vanguard_hunt"), "猎敌");
  assert.equal(intentLabelCn("capacity_wait:ranger_move"), "等容");
  assert.equal(intentLabelCn("DEPOSIT"), "交付");
  assert.equal(intentLabelCn("WAIT"), null);
  assert.equal(intentLabelCn("NOTHING_TO_DO"), null);
  assert.equal(intentLabelCn(null), null);
  assert.equal(intentLabelCn("go_harvest_mem"), "采忆");
});

test("tact-object-near: 切比雪夫半径内最近单位", () => {
  const w = mkWorld([
    { kind: "UNIT", id: "a", position: [0, 0] },
    { kind: "UNIT", id: "b", position: [3, 3] },
  ]);
  assert.equal(tactObjectNear(w, 1, 0, 2)?.id, "a");
  assert.equal(tactObjectNear(w, 2, 0, 1), null); // a 距 (2,0)=2 超半径
  assert.equal(tactObjectNear(w, 2, 2, 1)?.id, "b");
});

test("tact-object-at: 精确格命中，跳过地形", () => {
  const w = mkWorld([
    { kind: "OBSTACLE", positions: [[1, 1]] },
    { kind: "RESOURCE", positions: [[2, 2]] },
    { kind: "UNIT", id: "u", position: [3, 3] },
  ]);
  assert.equal(tactObjectAt(w, 1, 1), null);
  assert.equal(tactObjectAt(w, 2, 2), null);
  assert.equal(tactObjectAt(w, 3, 3)?.id, "u");
  assert.equal(tactObjectAt(null, 3, 3), null);
});

test("tact-terrain/hostile: 障碍格键集 + 敌情判定", () => {
  const w = mkWorld([
    { kind: "OBSTACLE", positions: [[0, 0], [1, 1]] },
    { kind: "UNIT", id: "enemy", position: [5, 5], controlled: false },
    { kind: "CORE", id: "mycore", position: [6, 6], controlled: true },
  ]);
  const obs = tactTerrain(w, "OBSTACLE");
  assert.ok(obs.has("0,0") && obs.has("1,1") && !obs.has("2,2"));
  assert.equal(tactHostileAt(w, [5, 5], false), true);
  assert.equal(tactHostileAt(w, [6, 6], false), false);
  assert.equal(tactHostileAt(w, [6, 6], true), true); // includeOwnCore
  assert.equal(tactHostileAt(w, [9, 9], false), false);
});

test("tact-move-targets: 障碍/敌格排除 + 四方向可达", () => {
  const w = mkWorld([
    { kind: "OBSTACLE", positions: [[6, 5]] },     // 挡住 RIGHT
    { kind: "UNIT", id: "enemy", position: [5, 4], controlled: false }, // 挡住 UP
    { kind: "UNIT", id: "me", position: [5, 5], controlled: true },
  ]);
  const me = w.state.objects[2];
  const targets = tactMoveTargets(w, me).map((t: any) => t.join(",")).sort();
  assert.deepEqual(targets, ["4,5", "5,6"]); // LEFT + DOWN
  // 非受控单位/无位置 → 空
  assert.deepEqual(tactMoveTargets(w, w.state.objects[1]), []);
});

test("tact-ranger-range: 八向射线 3 格，障碍截断", () => {
  const w = mkWorld([{ kind: "OBSTACLE", positions: [[2, 0]] }]);
  const ranger = { kind: "UNIT", unit_type: "RANGER", position: [0, 0], controlled: true };
  const range = tactRangerRange(w, ranger).map((p: any) => p.join(",")).sort();
  // 右向 (1,0) 有，(2,0) 被障碍截断
  assert.ok(range.includes("1,0"));
  assert.ok(!range.includes("2,0"));
  // 上向应有 (0,-1),(0,-2),(0,-3)
  assert.ok(range.includes("0,-1") && range.includes("0,-2") && range.includes("0,-3"));
});

test("tact-ranger-targets: 切比雪夫 1-3 格敌方（正交/对角），排除友方与超距", () => {
  const w = mkWorld([
    { kind: "UNIT", id: "e1", position: [1, 0], controlled: false },
    { kind: "UNIT", id: "e2", position: [3, 3], controlled: false },
    { kind: "UNIT", id: "e3", position: [4, 0], controlled: false }, // dist 4
    { kind: "UNIT", id: "f", position: [1, 1], controlled: true },
  ]);
  const ranger = { kind: "UNIT", position: [0, 0] };
  const ids = tactRangerTargets(w, ranger).map((o: any) => o.id).sort();
  assert.deepEqual(ids, ["e1", "e2"]);
});

test("tact-visibility: 受控单位视野半径（CORE 5 / WORKER 3 / VANGUARD 4 / RANGER 5）", () => {
  const w = mkWorld([
    { kind: "CORE", position: [0, 0], controlled: true },
    { kind: "UNIT", unit_type: "WORKER", position: [1, 0], controlled: true },
    { kind: "UNIT", unit_type: "VANGUARD", position: [2, 0], controlled: true },
    { kind: "UNIT", unit_type: "RANGER", position: [3, 0], controlled: true },
    { kind: "UNIT", unit_type: "WORKER", position: [4, 0], controlled: false }, // 敌方不计
  ]);
  const vis = tactVisibility(w);
  assert.equal(vis.length, 4);
  assert.deepEqual(vis.map((v: any) => v.r).sort(), [3, 4, 5, 5]);
});

test("tact-availability: 工人采集/回仓 + 先锋清扫 + 游侠射击 + 敌方受限", () => {
  const core = { kind: "CORE", position: [5, 5], controlled: true };
  const w = mkWorld([
    core,
    { kind: "RESOURCE", positions: [[1, 1]] },
    { kind: "UNIT", id: "worker", unit_type: "WORKER", position: [1, 1], controlled: true, cargo: 0 },
    { kind: "UNIT", id: "worker2", unit_type: "WORKER", position: [5, 5], controlled: true, cargo: 3 },
    { kind: "UNIT", id: "v", unit_type: "VANGUARD", position: [0, 0], controlled: true },
    { kind: "UNIT", id: "r", unit_type: "RANGER", position: [0, 1], controlled: true },
    { kind: "UNIT", id: "enemy", unit_type: "WORKER", position: [9, 9], controlled: false },
  ]);
  const onMine = w.state.objects[2];
  const atCore = w.state.objects[3];
  const av = tactAvailability(w, onMine);
  assert.equal(av.actions.HARVEST, true);
  assert.equal(av.actions.DEPOSIT, false);
  assert.ok(av.reasons.DEPOSIT);
  const av2 = tactAvailability(w, atCore);
  assert.equal(av2.actions.DEPOSIT, true);
  assert.equal(av2.actions.HARVEST, false);
  assert.ok(av2.reasons.HARVEST);
  assert.equal(tactAvailability(w, w.state.objects[4]).actions.SWEEP, true); // 先锋
  assert.equal(tactAvailability(w, w.state.objects[5]).actions.SHOOT, true); // 游侠
  const enemy = tactAvailability(w, w.state.objects[6]);
  assert.deepEqual(Object.keys(enemy.actions).sort(), ["SELF_DESTRUCT", "WAIT"]);
});

test("tact-availability: 核心信标拾取/放置 + 移动中受限", () => {
  const wGround = mkWorld([
    { kind: "CORE", id: "c", position: [0, 0], controlled: true },
    { kind: "OBSTACLE", positions: [] },
  ]);
  wGround.state.champion_beacon = { status: "GROUND", position: [0, 0] };
  const core = wGround.state.objects[0];
  const av = tactAvailability(wGround, core);
  assert.equal(av.actions.PICKUP_BEACON, true);
  assert.equal(av.actions.START_MOVE, true);
  // 正常核心携带信标：可放置、不可拾取
  const wCarry = mkWorld([{ ...core }]);
  wCarry.state.champion_beacon = { status: "CARRIED", carrier_id: "c" };
  const av2 = tactAvailability(wCarry, wCarry.state.objects[0]);
  assert.equal(av2.actions.PICKUP_BEACON, false);
  assert.equal(av2.actions.DROP_BEACON, true);
  // 移动中的核心：可取消移动，生产/维修/信标动作全部受限
  const wMoving = mkWorld([{ ...core, state: "MOVING" }]);
  wMoving.state.champion_beacon = { status: "CARRIED", carrier_id: "c" };
  const av3 = tactAvailability(wMoving, wMoving.state.objects[0]);
  assert.equal(av3.actions.CANCEL_MOVE, true);
  assert.equal(av3.actions.START_MOVE, false);
  assert.equal(av3.actions.PICKUP_BEACON, false);
  assert.equal(av3.actions.DROP_BEACON, false);
  assert.equal(av3.spawns.WORKER, false);
});

test("action-icon: 图标密集覆盖所有动作且非空（与右键/批量/动作卡共用）", () => {
  for (const [k, cn] of Object.entries(TACT_ACTION_CN)) {
    assert.ok(TACT_ACTION_ICON[k] !== undefined && TACT_ACTION_ICON[k] !== "", `${k}(${cn}) 缺图标`);
  }
  // 反向：图标表不应含未知动作（防乱定义）
  for (const k of Object.keys(TACT_ACTION_ICON)) {
    assert.ok(TACT_ACTION_CN[k] !== undefined, `图标表含未知动作 ${k}`);
  }
});

test("event-icon: 图标密集覆盖所有事件 kind 且非空（事件标签页行首图标）", () => {
  for (const [k, cn] of Object.entries(EVENT_KIND_CN)) {
    assert.ok(EVENT_ICON[k] !== undefined && EVENT_ICON[k] !== "", `${k}(${cn}) 缺图标`);
  }
  for (const k of Object.keys(EVENT_ICON)) {
    assert.ok(EVENT_KIND_CN[k] !== undefined, `图标表含未知事件 kind ${k}`);
  }
});

test("deed-icon: 事迹类别图标齐全（里程碑/采集/交付/产兵/阵亡/冲突/经济/其他）", () => {
  const cats = ["milestone", "harvest", "deposit", "spawn", "death", "conflict", "economy", "other"];
  for (const c of cats) {
    assert.ok(DEED_ICON[c] !== undefined && DEED_ICON[c] !== "", `${c} 缺图标`);
  }
  for (const k of Object.keys(DEED_ICON)) {
    assert.ok(cats.includes(k), `DEED_ICON 含未知类别 ${k}`);
  }
});
