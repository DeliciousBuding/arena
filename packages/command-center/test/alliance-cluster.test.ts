/**
 * 联盟集群态势测试（2026-08-08，抱团 Phase 1 观测层）：
 * 1) 近核（Chebyshev ≤ 120）同集群 + cohesion>0；
 * 2) 远核（>120）不同集群 → isolated；
 * 3) 核心缺失 → 自成一簇且 cohesion=0；
 * 4) 集群 centroid / radius / 兵力聚合。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAllianceClusterView, CLUSTER_LINK_DIST, type AllianceClusterMemberInput } from "../lib/alliance-cluster.ts";

function m(tenantId: string, core: [number, number] | null, military = 2, workers = 3): AllianceClusterMemberInput {
  return { tenantId, core, military, workers, status: "READY" };
}

test("近核同集群：Chebyshev ≤ 120 归一组，cohesion > 0", () => {
  const v = buildAllianceClusterView([
    m("t1", [-30, 38]),
    m("t2", [-30, 40]), // 与 t1 距离 2
    m("t3", [159, 516]),
  ], 1);
  assert.equal(v.summary.groupCount, 2);
  assert.equal(v.summary.isolatedCount, 1);
  const t1 = v.members.find((x) => x.tenantId === "t1")!;
  const t2 = v.members.find((x) => x.tenantId === "t2")!;
  assert.equal(t1.clusterId, t2.clusterId);
  assert.equal(t1.clusterSize, 2);
  assert.ok(t1.cohesion > 0.9, `t1 cohesion=${t1.cohesion}`);
  const group = v.groups.find((g) => g.tenantIds.includes("t1"))!;
  assert.deepEqual(group.centroid, [-30, 39]);
  assert.equal(group.military, 4);
  assert.equal(group.workers, 6);
});

test("远核不同集群：Chebyshev > 120 → isolated", () => {
  const v = buildAllianceClusterView([
    m("t1", [0, 0]),
    m("t2", [0, CLUSTER_LINK_DIST + 10]),
  ], 1);
  assert.equal(v.summary.groupCount, 2);
  assert.equal(v.summary.isolatedCount, 2);
  assert.equal(v.summary.maxCohesion, 0);
  assert.equal(v.summary.avgCohesion, 0);
});

test("单成员集群 cohesion=0（无同伴可抱团）", () => {
  const v = buildAllianceClusterView([m("t1", [10, 10])], 1);
  const t1 = v.members.find((x) => x.tenantId === "t1")!;
  assert.equal(t1.clusterSize, 1);
  assert.equal(t1.cohesion, 0);
});

test("核心缺失：自成一簇且 cohesion=0", () => {
  const v = buildAllianceClusterView([
    m("t1", null),
    m("t2", [10, 10]),
  ], 1);
  const t1 = v.members.find((x) => x.tenantId === "t1")!;
  assert.equal(t1.cohesion, 0);
  assert.equal(t1.clusterSize, 1);
});

test("多核同集群：centroid 取均值、radius 为最大核距", () => {
  const v = buildAllianceClusterView([
    m("t1", [0, 0]),
    m("t2", [10, 0]),
    m("t3", [0, 10]),
  ], 1);
  assert.equal(v.summary.groupCount, 1);
  const g = v.groups[0]!;
  assert.deepEqual(g.centroid, [3, 3]);
  assert.equal(g.radius, 7); // chebyshev([10,0],[3,3])=7
});
