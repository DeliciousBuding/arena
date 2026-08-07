import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNavState, planDirection, chebyshev, mergeObstacleSets,
  type Pos, type Dir,
} from "../src/app/core-migrate-nav.ts";

function ob(pts: [number, number][]): Set<string> {
  return new Set(pts.map((p) => p.join(",")));
}

test("t2 场景：核心在信标左下方、东侧被堵 → 选 DOWN 绕障（不选靠近信标的 UP）", () => {
  // 核心 (-42,38)，目标 (-14,51)。东 (-41,38) 是障碍，北/南/西自由。
  const core: Pos = [-42, 38];
  const target: Pos = [-14, 51];
  const obstacles = ob([[-41, 38]]);
  const nav = createNavState();
  const p = planDirection(core, target, obstacles, 60, nav, new Set());
  // 修复前：UP 被 beacon 劫持 → 振荡。修复后：UP 靠近信标被剔除，RIGHT 被障碍挡，应选 DOWN。
  assert.equal(p.dir, "DOWN", `候选: ${p.candidates.join(">")}`);
  assert.equal(p.detour, false); // Manhattan 增益直接推进（不再绕障振荡）
  // 核心南移一格后 (-42,39)，东 (-41,39) 自由 → 应开始东进 RIGHT
  const p2 = planDirection([-42, 39], target, obstacles, 60, nav, new Set());
  assert.equal(p2.dir, "RIGHT", `候选: ${p2.candidates.join(">")}`);
  assert.equal(p2.detour, false);
});

test("t2 修复前振荡回归：核心 (-42,38) 不再被 UP 劫持", () => {
  const core: Pos = [-42, 38];
  const target: Pos = [-14, 51];
  const obstacles = ob([[-41, 38]]);
  const nav = createNavState();
  const seen = new Set<string>();
  for (let i = 0; i < 6; i += 1) {
    const p = planDirection(core, target, obstacles, 60, nav, new Set());
    if (p.dir === null) break;
    seen.add(p.dir);
  }
  // 修复前会选 UP（信标劫持）。修复后 UP 被剔除，绝不出现。
  assert.ok(!seen.has("UP"), `不应选 UP（靠近信标），实际: ${[...seen].join(",")}`);
  assert.ok(seen.has("DOWN"), `应包含 DOWN，实际: ${[...seen].join(",")}`);
});

test("t4 场景：主方向 LEFT 被堵 → 绕障持续性（持续同一垂直方向，不振荡）", () => {
  const core: Pos = [400, -154];
  const target: Pos = [300, -150];
  // LEFT/RIGHT 被当前视野障碍挡住，UP/DOWN 自由
  const obstacles = ob([[399, -154], [401, -154]]);
  const nav = createNavState();
  const p1 = planDirection(core, target, obstacles, 60, nav, new Set());
  assert.equal(p1.dir, "DOWN", `Manhattan 增益应选减 dy 的 DOWN: ${p1.dir}`);
  assert.equal(p1.detour, false);
  // 第二次评估（位置未变，仍在口袋）→ 必须维持同一方向，不能 UP/DOWN 来回
  const p2 = planDirection(core, target, obstacles, 60, nav, new Set());
  assert.equal(p2.dir, p1.dir, "绕障应持续同一方向而非振荡");
  const p3 = planDirection(core, target, obstacles, 60, nav, new Set());
  assert.equal(p3.dir, p1.dir, "绕障应持续同一方向而非振荡");
});

test("t4 绕障后主方向恢复 → 回 LEFT 朝目标", () => {
  const core: Pos = [400, -160]; // 假设绕墙后 LEFT 已通
  const target: Pos = [300, -150];
  const obstacles = new Set<string>();
  const nav = createNavState();
  nav.detourDir = "UP";
  const p = planDirection(core, target, obstacles, 60, nav, new Set());
  // dx=-100 主导，LEFT gain 最大 → 应回 LEFT，且 detour 记忆被重置
  assert.equal(p.dir, "LEFT");
  assert.equal(p.detour, false);
  assert.equal(nav.detourDir, null);
});

test("信标圈外：正常朝目标走，不受信标影响", () => {
  // 核心 (300,-150) 距信标很远 → 无规避，直接朝目标
  const core: Pos = [300, -150];
  const target: Pos = [100, -150];
  const p = planDirection(core, target, new Set(), 60, createNavState(), new Set());
  assert.equal(p.dir, "LEFT");
  assert.equal(p.detour, false);
});

test("信标圈内但远离方向被堵：剔除靠近方向后仍能选次优", () => {
  // 核心 (-30,-20) 在信标 (-11,-1) 左下方圈内，假设 UP(靠近信标) 和 LEFT 被堵
  const core: Pos = [-30, -20];
  const target: Pos = [-5, 10];
  const obstacles = ob([[-30, -21], [-31, -20]]); // UP 和 LEFT 被堵
  const nav = createNavState();
  const p = planDirection(core, target, obstacles, 60, nav, new Set());
  // 可用方向：DOWN(y+1 远离信标, gain=0), RIGHT(x+1 靠近信标? 判定剔除)
  // DOWN 或 RIGHT 均可；只要不是 UP/LEFT（被堵）
  assert.ok(p.dir === "DOWN" || p.dir === "RIGHT", `实际: ${p.dir}`);
});

test("chebyshev 基础函数", () => {
  assert.equal(chebyshev([0, 0], [3, 4]), 4);
  assert.equal(chebyshev([-42, 38], [-14, 51]), 28);
});
test("mergeObstacleSets: survey global union calibration view", () => {
  const survey = new Set(["1,1", "2,2", "3,3"]);
  const cal = new Set(["3,3", "4,4"]);
  const merged = mergeObstacleSets(survey, cal);
  assert.deepEqual([...merged].sort(), ["1,1", "2,2", "3,3", "4,4"]);
});

test("mergeObstacleSets: empty survey keeps calibration", () => {
  const merged = mergeObstacleSets(new Set<string>(), new Set(["399,-155"]));
  assert.ok(merged.has("399,-155"));
});

test("mergeObstacleSets: survey-only obstacle kept", () => {
  const merged = mergeObstacleSets(new Set(["400,-152"]), new Set<string>());
  assert.ok(merged.has("400,-152"));
});

test("t4 竖井口袋回归：西侧被堵、目标在西 → 持续选 DOWN 减 dy 不再 DOWN/UP 拉锯（Manhattan 增益）", () => {
  const core: Pos = [400, -154];
  const target: Pos = [300, -150];
  // 西 (399,-154) 被堵；北 (400,-155)/南 (400,-153) 自由——竖井格局
  const obstacles = ob([[399, -154]]);
  const nav = createNavState();
  const seen: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const p = planDirection(core, target, obstacles, 60, nav, new Set());
    if (p.dir === null) break;
    seen.push(p.dir);
  }
  // 修复前（Chebyshev）：UP/DOWN gain 均 0 → 仲裁/记忆拉锯；修复后恒 DOWN
  assert.ok(seen.every((d) => d === "DOWN"), `竖井内应持续 DOWN 逼近 y=-150，实际: ${seen.join(",")}`);
});
