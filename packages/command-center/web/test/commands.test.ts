/**
 * 人类指令选择器/遥测差分测试（2026-08-08）：commands.ts 纯函数——
 * 遥测差分、goal/action 命中、单位指挥标记、状态摘要、单位遥测行。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandTelemetryDeltas, commandGoalOf, commandActionOf, unitHumanCommandOf,
  commandStatusText, unitTelemetryOf, unitCommandLabel, squadSummary,
} from "../src/engine/commands.ts";

const mkTac = (commands: any, commandsByTenant: any = {}) => ({ commands, commandsByTenant });

test("cmd-telemetry-deltas: 新增被拒/已完成/已生效", () => {
  const prev = { rejected: [{ unitId: "a", reason: "旧" }], satisfied: ["x"], applied: ["p"] };
  const tele = { rejected: [{ unitId: "a", reason: "旧" }, { unitId: "b", reason: "新" }], satisfied: ["x", "y"], applied: ["p", "q"] };
  const d = commandTelemetryDeltas(prev, tele);
  assert.deepEqual(d.rejected.map((r: any) => r.unitId), ["b"]);
  assert.deepEqual(d.satisfied, ["y"]);
  assert.deepEqual(d.applied, ["q"]);
  assert.deepEqual(commandTelemetryDeltas(null, tele).rejected.length, 2, "prev 缺失时全部为新");
});

test("cmd-selectors: goal/action 命中与单位指挥标记", () => {
  const tac = mkTac({ tenant: "t1", mode: "override", goals: [{ unitId: "g1", kind: "goto" }], actions: [{ unitId: "a1", type: "SHOOT" }] }, { t2: { goals: [{ unitId: "g2" }] } });
  assert.ok(commandGoalOf(tac, "t1", "g1"));
  assert.equal(commandGoalOf(tac, "t1", "nope"), null);
  assert.ok(commandActionOf(tac, "t1", "a1"));
  assert.equal(unitHumanCommandOf(tac, "t1", "g1"), "goal");
  assert.equal(unitHumanCommandOf(tac, "t1", "a1"), "cmd");
  assert.equal(unitHumanCommandOf(tac, "t2", "g2"), "goal", "全局 commandsByTenant 命中");
  assert.equal(unitHumanCommandOf(tac, "t1", "x"), null);
});

test("cmd-status-text: 指令数 + 遥测统计", () => {
  const tac = mkTac({ tenant: "t1", mode: "override", actions: [{ unitId: "a" }], goals: [{ unitId: "g" }], telemetry: { applied: ["a"], rejected: [], satisfied: ["g"] } });
  const s = commandStatusText(tac, "t1");
  assert.ok(s && s.includes("2 条指令") && s.includes("1 已生效") && s.includes("1 已完成"), "含指令数/生效/完成: " + s);
  assert.equal(commandStatusText(mkTac({ mode: "auto" }), "t1"), null, "非 override 返回 null");
});

test("cmd-unit-telemetry: 单位状态行（已生效/已完成/被拒原因）", () => {
  const tac = mkTac({ tenant: "t1", mode: "override", telemetry: { applied: ["u1"], satisfied: ["u2"], rejected: [{ unitId: "u3", reason: "核心移动中" }] } });
  assert.ok((unitTelemetryOf(tac, "u1") || "").includes("已生效"));
  assert.ok((unitTelemetryOf(tac, "u2") || "").includes("已完成"));
  const r = unitTelemetryOf(tac, "u3") || "";
  assert.ok(r.includes("被拒") && r.includes("核心移动中"));
  assert.equal(unitTelemetryOf(tac, "u9"), null);
});

test("cmd-unit-label: 人类 goal 优先，算法决策兜底，无指令 null", () => {
  const tac = mkTac({ tenant: "t1", mode: "override", goals: [{ unitId: "g1", kind: "mine", target: [10, 20] }] }, { t2: { goals: [{ unitId: "g2", kind: "goto", target: [-5, 7] }] } });
  assert.equal(unitCommandLabel(tac, "t1", "g1", null), "指挥 · 采矿 → [10, 20]");
  assert.equal(unitCommandLabel(tac, "t2", "g2", null), "指挥 · 移动 → [-5, 7]");
  const plan = { unitActions: { u1: { type: "HARVEST" }, u2: { type: "MOVE", direction: "DOWN" }, u3: { type: "SHOOT", targetId: "enemy-xyz" } } };
  assert.equal(unitCommandLabel(tac, "t1", "u1", plan), "决策 · 采集");
  assert.equal(unitCommandLabel(tac, "t1", "u2", plan), "决策 · 移动 DOWN");
  assert.ok((unitCommandLabel(tac, "t1", "u3", plan) || "").includes("enemy"));
  assert.equal(unitCommandLabel(tac, "t1", "nope", plan), null);
  // 人类指令优先于算法决策
  const tac2 = mkTac({ tenant: "t1", mode: "override", goals: [{ unitId: "u1", kind: "goto", target: [1, 1] }] });
  assert.equal(unitCommandLabel(tac2, "t1", "u1", plan), "指挥 · 移动 → [1, 1]");
});

test("squad-summary: 编队构成 + 平均/最低 HP，单个/无多选 null", () => {
  const world = { state: { objects: [
    { id: "a", kind: "UNIT", unit_type: "WORKER", hp: 4 },
    { id: "b", kind: "UNIT", unit_type: "VANGUARD", hp: 2 },
    { id: "c", kind: "UNIT", unit_type: "RANGER", hp: 1, health: 5 },
  ] } };
  const tac1 = { multi: new Set(["a", "b", "c"]) };
  const s = squadSummary(tac1, world);
  assert.ok(s);
  assert.equal(s.count, 3);
  assert.equal(s.parts, "1工/1锋/1射");
  assert.equal(s.hpAvg, 2);
  assert.equal(s.hpMin, 1);
  const tac2 = { multi: new Set(["a"]) };
  assert.equal(squadSummary(tac2, world), null, "单个不算编队");
  const tac3 = { multi: new Set(["x"]) };
  assert.equal(squadSummary(tac3, world), null, "无命中编队");
  assert.equal(squadSummary(null, world), null);
});
