import { test } from "node:test";
import assert from "node:assert/strict";
import { activeFleetIds, partitionLocalFleets, type LocalUnit } from "../src/alliance/local-fleet.ts";

function unit(id: string, unitType: "VANGUARD" | "RANGER"): LocalUnit {
  return { id, unitType };
}

test("local-fleet: 无战斗单位 → 无 fleet", () => {
  assert.deepEqual(partitionLocalFleets([], "t1"), []);
  assert.deepEqual(activeFleetIds([], "t1"), []);
});

test("local-fleet: 单兵 → 只 home reserve（tiny force 全部守家）", () => {
  const fleets = partitionLocalFleets([unit("u1", "VANGUARD")], "t1");
  assert.equal(fleets.length, 1);
  assert.equal(fleets[0]?.role, "HOME_DEFENSE");
  assert.deepEqual(fleets[0]?.unitIds, ["u1"]);
  assert.deepEqual(activeFleetIds([unit("u1", "VANGUARD")], "t1"), ["t1:home:0"]);
});

test("local-fleet: 2V1R → home reserve 全拿（tiny force 守家，无 strike）", () => {
  const units = [unit("v1", "VANGUARD"), unit("v2", "VANGUARD"), unit("r1", "RANGER")];
  const fleets = partitionLocalFleets(units, "t1");
  assert.equal(fleets.length, 1);
  assert.deepEqual(fleets.map((f) => f.role), ["HOME_DEFENSE"]);
  assert.deepEqual(fleets[0]?.unitIds, ["r1", "v1", "v2"]);
  assert.equal(fleets[0]?.formation, "FORTRESS_RING");
  assert.equal(fleets[0]?.state, "HOLD");
});

test("local-fleet: 4V2R → home + 1 strike（strike 编满 2V1R）", () => {
  const units = [
    unit("v1", "VANGUARD"), unit("v2", "VANGUARD"), unit("v3", "VANGUARD"), unit("v4", "VANGUARD"),
    unit("r1", "RANGER"), unit("r2", "RANGER"),
  ];
  const fleets = partitionLocalFleets(units, "t1");
  assert.deepEqual(fleets.map((f) => f.role), ["HOME_DEFENSE", "STRIKE"]);
  const strike = fleets.find((f) => f.role === "STRIKE")!;
  assert.deepEqual(strike.unitIds, ["r2", "v3", "v4"]); // home 已拿 r1
  assert.equal(strike.formation, "ASSAULT_WEDGE");
  assert.equal(strike.state, "ASSEMBLE");
});

test("local-fleet: 大编队 → home + 多个 strike + mobile 余量", () => {
  const units = [
    unit("v1", "VANGUARD"), unit("v2", "VANGUARD"), unit("v3", "VANGUARD"), unit("v4", "VANGUARD"),
    unit("r1", "RANGER"), unit("r2", "RANGER"), unit("r3", "RANGER"),
  ];
  const fleets = partitionLocalFleets(units, "t1");
  const roles = fleets.map((f) => f.role);
  // 7 战斗单位 = home(2V1R) + strike(2V1R) + mobile(余量 1R)
  assert.deepEqual(roles, ["HOME_DEFENSE", "STRIKE", "MOBILE"]);
  // 所有单位恰好分配一次、无重复
  const allUnitIds = fleets.flatMap((f) => f.unitIds);
  assert.equal(new Set(allUnitIds).size, units.length);
  // mobile 永不为空
  const mobile = fleets.find((f) => f.role === "MOBILE")!;
  assert.ok(mobile.unitIds.length >= 1);
  // strike fleet 命名含 :strike:（TaskForce 只引用 strike）
  const strikeIds = fleets.filter((f) => f.role === "STRIKE").map((f) => f.id);
  assert.ok(strikeIds.every((id) => id.includes(":strike:")));
});

test("local-fleet: 12 单位 → 3 strike（每次 2V1R 消耗殆尽）", () => {
  const units = [
    unit("v1", "VANGUARD"), unit("v2", "VANGUARD"), unit("v3", "VANGUARD"), unit("v4", "VANGUARD"),
    unit("v5", "VANGUARD"), unit("v6", "VANGUARD"), unit("v7", "VANGUARD"), unit("v8", "VANGUARD"),
    unit("r1", "RANGER"), unit("r2", "RANGER"), unit("r3", "RANGER"), unit("r4", "RANGER"),
  ];
  const fleets = partitionLocalFleets(units, "t1");
  assert.deepEqual(
    fleets.map((f) => f.role),
    ["HOME_DEFENSE", "STRIKE", "STRIKE", "STRIKE"],
  );
  assert.equal(fleets.filter((f) => f.role === "STRIKE").length, 3);
});

test("local-fleet: 确定性——输入顺序无关", () => {
  const a = [unit("v1", "VANGUARD"), unit("v2", "VANGUARD"), unit("r1", "RANGER")];
  const b = [unit("r1", "RANGER"), unit("v2", "VANGUARD"), unit("v1", "VANGUARD")];
  assert.deepEqual(partitionLocalFleets(a, "t1"), partitionLocalFleets(b, "t1"));
});

test("local-fleet: WORKER 不参与分区（只 id/unitType 两个字段，domain 兼容）", () => {
  const workers = [{ id: "w1", unitType: "WORKER" as const }];
  assert.deepEqual(partitionLocalFleets(workers, "t1"), []);
});
