import test from "node:test";
import assert from "node:assert/strict";
import { allocateAllianceTaskMarket } from "../src/alliance/task-market.ts";
import type { AllianceMemberState } from "../src/alliance/types.ts";

function member(id: string, x: number, military: number, resources = 10): AllianceMemberState {
  return { tenantId:id, tick:80, observedAtMs:80000, core:{id:`${id}-c`,position:[x,0],hp:5,shield:5,moving:false},
    resources, resourceCapacity:50, population:military+4, workers:4, vanguards:military, rangers:0, carriedResources:0,
    activeFleetIds:[], localThreat:0, localHarvestRate:0, status:"READY" };
}

test("task market: closer capable tenant wins RAID over slightly stronger distant tenant", () => {
  const a=member("t1",0,8,30); const b=member("t2",20,6,10);
  const result=allocateAllianceTaskMarket([a,b],[{id:"raid",kind:"RAID",priority:78,target:[22,0],minMilitary:6,maxDistance:64}],new Map(),"t1");
  assert.equal(result.assignments.length,1); assert.equal(result.assignments[0]!.tenantId,"t2");
});

test("task market: treasury penalty preserves banker when another executor is comparable", () => {
  const a=member("t1",0,6,30); const b=member("t2",1,6,10);
  const result=allocateAllianceTaskMarket([a,b],[{id:"raid",kind:"RAID",priority:78,target:[10,0],minMilitary:6,maxDistance:64}],new Map(),"t1");
  assert.equal(result.assignments[0]!.tenantId,"t2");
  assert.ok(result.bids.find(x=>x.tenantId==="t1")!.treasuryPenalty>0);
});

test("task market: below-force and over-distance bids are ineligible", () => {
  const result=allocateAllianceTaskMarket([member("t1",0,1)],[{id:"raid",kind:"RAID",priority:78,target:[100,0],minMilitary:6,maxDistance:64}],new Map(),"");
  assert.equal(result.assignments.length,0); assert.equal(result.bids[0]!.eligible,false);
});


test("task market: multi-slot RAID selects two distinct tenants for same base task", () => {
  const members = [member("t1", 0, 8, 20), member("t2", 4, 6, 15), member("t3", 40, 6, 10)];
  const result = allocateAllianceTaskMarket(
    members,
    [{ id:"raid-joint", kind:"RAID", priority:80, target:[10,0], minMilitary:4, maxDistance:64, slotCount:2 }],
    new Map(),
    "t3",
  );
  assert.equal(result.assignments.length, 2);
  assert.deepEqual(new Set(result.assignments.map((a) => a.task.baseTaskId)), new Set(["raid-joint"]));
  assert.equal(new Set(result.assignments.map((a) => a.tenantId)).size, 2);
  assert.deepEqual(result.assignments.map((a) => a.task.slotIndex).sort(), [0,1]);
});
