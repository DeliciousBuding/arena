/**
 * 迁移走廊审计测试（migration-system-v1 §8 验收，评审 P0-1 核心）。
 *
 * 必测场景：段中活跃敌核拒（首尾干净但中段有活跃敌核 → 整条拒）、
 * 资源达标通过、陈旧敌核不判活跃、freshResources 不足拒、
 * corridorWidth 边界、lookahead 窗口隔离、deviation 检测。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditCorridor,
  auditCorridorLookahead,
  pathDeviation,
  CORRIDOR_DEFAULT_WIDTH,
  CORRIDOR_DEFAULT_LOOKAHEAD,
} from "../src/migration/corridor.ts";
import type { CorridorSurvey } from "../src/migration/corridor.ts";
import type { KnownResource, EnemyCoreMemory } from "../src/domain/migration-audit.ts";
import type { MigrationPosition } from "../src/migration/plan.ts";

/** 生成 (fromX,0)→(toX,0) 水平直线路径（逐格，含端点）。 */
function linePath(fromX: number, toX: number): MigrationPosition[] {
  const cells: MigrationPosition[] = [];
  for (let x = fromX; x <= toX; x += 1) cells.push({ x, y: 0 });
  return cells;
}

const resource = (x: number, y: number, lastSeenTick: number): KnownResource => ({ x, y, lastSeenTick });
const enemy = (x: number, y: number, lastSeenTick: number): EnemyCoreMemory => ({ x, y, lastSeenTick });

function survey(
  resources: readonly KnownResource[] = [],
  enemyCores: readonly EnemyCoreMemory[] = [],
): CorridorSurvey {
  return { resources, enemyCores };
}

test("段中活跃敌核拒（P0-1 必测）：中段敌核而首尾干净 → 整条路径拒", () => {
  const path = linePath(0, 20); // 21 格，敌核在 (10,1)，距路径中段 1 格
  const currentTick = 10000;
  const audit = auditCorridor(path, survey([], [enemy(10, 1, 9950)]), currentTick, {
    minFreshResources: 0,
  });
  assert.equal(audit.ok, false, "中段活跃敌核必须拒");
  assert.equal(audit.activeEnemyCoreCount, 1);
  assert.ok(audit.reasons.some((r) => r.includes("敌核")), `reasons 应含"敌核": ${audit.reasons}`);
  assert.equal(audit.sampledCells, 21, "整条路径全部采样（swept corridor）");

  // 对照：只查前 2 格（首尾式终点审计的退化情形）→ 完全看不见中段敌核
  const headOnly = auditCorridorLookahead(path, 0, 2, survey([], [enemy(10, 1, 9950)]), currentTick, {
    minFreshResources: 0,
  });
  assert.equal(headOnly.ok, true, "首尾干净（前 2 格无敌核）");
  assert.equal(headOnly.activeEnemyCoreCount, 0);
  // 结论：终点/头部审计会漏判，swept corridor 才能抓住段中敌核
});

test("资源达标且无活跃敌核 → ok=true", () => {
  const path = linePath(0, 10);
  const currentTick = 10000;
  const freshResources = [
    resource(0, 0, 9900),
    resource(0, 1, 9900),
    resource(1, 1, 9900),
    resource(2, 1, 9900),
    resource(3, 1, 9900),
    resource(4, 1, 9900),
    resource(5, 1, 9900),
    resource(6, 1, 9900),
  ];
  const audit = auditCorridor(path, survey(freshResources), currentTick);
  assert.equal(audit.ok, true);
  assert.equal(audit.freshResourceCount, 8);
  assert.equal(audit.activeEnemyCoreCount, 0);
  assert.deepEqual(audit.reasons, []);
  assert.equal(audit.sampledCells, 11);
});

test("陈旧敌核不判活跃；窗口内才判活跃", () => {
  const path = linePath(0, 10);
  const currentTick = 10000;
  // lastSeenTick 5000 → 距今 5000 > 3000（默认活跃窗口）→ 陈旧
  const stale = auditCorridor(path, survey([], [enemy(5, 1, 5000)]), currentTick, {
    minFreshResources: 0,
  });
  assert.equal(stale.ok, true, "陈旧敌核不判活跃");
  assert.equal(stale.activeEnemyCoreCount, 0);
  // lastSeenTick 7001 → 距今 2999 ≤ 3000 → 活跃
  const active = auditCorridor(path, survey([], [enemy(5, 1, 7001)]), currentTick, {
    minFreshResources: 0,
  });
  assert.equal(active.ok, false);
  assert.equal(active.activeEnemyCoreCount, 1);
});

test("freshResources 不足 → 拒（reasons 含“资源”）", () => {
  const path = linePath(0, 10);
  const currentTick = 10000;
  const audit = auditCorridor(
    path,
    survey([resource(0, 0, 9900), resource(1, 0, 9900), resource(2, 0, 9900), resource(9, 0, 5000)]),
    currentTick,
  );
  assert.equal(audit.ok, false);
  assert.equal(audit.freshResourceCount, 3, "陈旧资源不计入新鲜数（已知 4，新鲜 3）");
  assert.ok(audit.reasons.some((r) => r.includes("资源")), `reasons 应含"资源": ${audit.reasons}`);
});

test("corridorWidth 边界：半径外的敌核不算（含边界格）", () => {
  const path = linePath(0, 2); // (0,0),(1,0),(2,0)
  const currentTick = 10000;
  // 敌核 (2,3)：到最近路径格 (2,0) 的 Chebyshev = 3 > 2 → 走廊外
  const outside = auditCorridor(path, survey([], [enemy(2, 3, 9950)]), currentTick, {
    corridorWidth: 2,
    minFreshResources: 0,
  });
  assert.equal(outside.ok, true, "半径外敌核不算");
  assert.equal(outside.activeEnemyCoreCount, 0);
  // 敌核 (2,2)：距离恰好 = 2（含边界）→ 走廊内
  const onEdge = auditCorridor(path, survey([], [enemy(2, 2, 9950)]), currentTick, {
    corridorWidth: 2,
    minFreshResources: 0,
  });
  assert.equal(onEdge.ok, false, "边界格上的敌核算作走廊内");
  assert.equal(onEdge.activeEnemyCoreCount, 1);
});

test("lookahead 窗口外敌核不影响结果（滚动前瞻隔离）", () => {
  const path = linePath(0, 20);
  const currentTick = 10000;
  const hostileSurvey = survey([], [enemy(10, 1, 9950)]);
  const options = { corridorWidth: 2, minFreshResources: 0 };
  // 窗口 [0,5)：最近格 (4,0) 距敌核 6 > 2 → 看不到
  const headWindow = auditCorridorLookahead(path, 0, 5, hostileSurvey, currentTick, options);
  assert.equal(headWindow.ok, true);
  assert.equal(headWindow.activeEnemyCoreCount, 0);
  assert.equal(headWindow.sampledCells, 5);
  // 窗口 [8,13)：格 (9,0) 距敌核 1 ≤ 2 → 命中
  const middleWindow = auditCorridorLookahead(path, 8, 5, hostileSurvey, currentTick, options);
  assert.equal(middleWindow.ok, false);
  assert.equal(middleWindow.activeEnemyCoreCount, 1);
  assert.equal(middleWindow.sampledCells, 5);
  // 窗口 [15,45) 越界截断到路径终点：敌核已过窗 → 干净
  const tailWindow = auditCorridorLookahead(path, 15, 30, hostileSurvey, currentTick, options);
  assert.equal(tailWindow.ok, true);
  assert.equal(tailWindow.sampledCells, 6, "窗口 [15,21) 共 6 格（越界截断）");
});

test("默认参数：corridorWidth=8、lookahead=30（设计 §7）", () => {
  assert.equal(CORRIDOR_DEFAULT_WIDTH, 8);
  assert.equal(CORRIDOR_DEFAULT_LOOKAHEAD, 30);
  const path = linePath(0, 10);
  const currentTick = 10000;
  // 默认 corridorWidth=8：敌核 (5,8) 距路径格 (5,0) 恰好 8 → 算走廊内
  const onEdge = auditCorridor(path, survey([], [enemy(5, 8, 9950)]), currentTick, {
    minFreshResources: 0,
  });
  assert.equal(onEdge.activeEnemyCoreCount, 1);
  const outside = auditCorridor(path, survey([], [enemy(5, 9, 9950)]), currentTick, {
    minFreshResources: 0,
  });
  assert.equal(outside.activeEnemyCoreCount, 0);
  // 默认 lookahead=30：11 格路径窗口截断为 11
  const lookahead = auditCorridorLookahead(path, 0, undefined, survey(), currentTick);
  assert.equal(lookahead.sampledCells, 11);
});

test("同格多次目击合并去重（取最新 lastSeenTick）", () => {
  const currentTick = 10000;
  // 同格两条资源目击 → 计数 1 而非 2
  const resourcesAudit = auditCorridor(
    linePath(0, 5),
    survey([resource(0, 0, 9900), resource(0, 0, 9000)]),
    currentTick,
    { minFreshResources: 1 },
  );
  assert.equal(resourcesAudit.freshResourceCount, 1, "同格资源目击应合并");
  assert.equal(resourcesAudit.ok, true);
  // 同格两条敌核目击 → 计数 1 而非 2
  const enemyAudit = auditCorridor(
    linePath(0, 5),
    survey([], [enemy(3, 1, 9950), enemy(3, 1, 9900)]),
    currentTick,
    { minFreshResources: 0 },
  );
  assert.equal(enemyAudit.activeEnemyCoreCount, 1, "同格敌核记忆应合并");
  assert.equal(enemyAudit.ok, false);
});

test("deviation：走廊内不偏离、出走廊偏离、返回距离与最近格下标", () => {
  const path = linePath(0, 10);
  const corridorWidth = 2;
  // (3,1)：距 (2,0)/(3,0)/(4,0) 均为 1（并列最近取先者 → 下标 2）≤ 2 → 走廊内
  const inside = pathDeviation(path, { x: 3, y: 1 }, corridorWidth);
  assert.equal(inside.deviated, false);
  assert.equal(inside.nearestPathIndex, 2);
  assert.equal(inside.distance, 1);
  // (3,3)：距 (0..6,0) 全部为 3（并列最近取先者 → 下标 0）> 2 → 偏离
  const outside = pathDeviation(path, { x: 3, y: 3 }, corridorWidth);
  assert.equal(outside.deviated, true);
  assert.equal(outside.nearestPathIndex, 0);
  assert.equal(outside.distance, 3);
  // (15,0)：已越过终点，最近格是末格 (10,0)
  const beyondEnd = pathDeviation(path, { x: 15, y: 0 }, corridorWidth);
  assert.equal(beyondEnd.deviated, true);
  assert.equal(beyondEnd.nearestPathIndex, 10);
  assert.equal(beyondEnd.distance, 5);
  // 并列最近时取先者：(2,1) 距 (1,0) 与 (2,0) 均为 1 → 取先者下标 1
  const tie = pathDeviation(path, { x: 2, y: 1 }, corridorWidth);
  assert.equal(tie.nearestPathIndex, 1);
  assert.equal(tie.distance, 1);
  assert.equal(tie.deviated, false);
  // 空路径：视为偏离（无走廊可依）
  const empty = pathDeviation([], { x: 0, y: 0 }, corridorWidth);
  assert.equal(empty.deviated, true);
  assert.equal(empty.nearestPathIndex, -1);
  assert.equal(empty.distance, Number.POSITIVE_INFINITY);
});

test("空路径审计拒绝；前瞻窗口越界为空 → 拒绝", () => {
  const currentTick = 10000;
  const emptyAudit = auditCorridor([], survey(), currentTick);
  assert.equal(emptyAudit.ok, false);
  assert.ok(emptyAudit.reasons.some((r) => r.includes("路径为空")));
  assert.equal(emptyAudit.sampledCells, 0);
  // progressCells 已到终点 → 窗口为空
  const done = auditCorridorLookahead(linePath(0, 10), 11, 5, survey(), currentTick);
  assert.equal(done.ok, false);
  assert.ok(done.reasons.some((r) => r.includes("窗口为空")));
  assert.equal(done.sampledCells, 0);
});
