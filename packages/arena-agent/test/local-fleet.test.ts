import test from "node:test";
import assert from "node:assert/strict";
import { activeFleetIds, partitionLocalFleets } from "../src/alliance/local-fleet.ts";
import type { UnitSnapshot } from "../src/domain/model.ts";

function unit(id:string, unitType:"VANGUARD"|"RANGER"): UnitSnapshot {
  return { id, unitType, position:[0,0], hp:unitType==="VANGUARD"?4:2, cargo:0 };
}

test("local fleets: 4V2R => stable home 2V1R + strike 2V1R",()=>{
  const units=[unit("v4","VANGUARD"),unit("r2","RANGER"),unit("v1","VANGUARD"),unit("v2","VANGUARD"),unit("r1","RANGER"),unit("v3","VANGUARD")];
  const fleets=partitionLocalFleets(units,"t1");
  assert.deepEqual(fleets.map(f=>f.id),["t1:home:0","t1:strike:0"]);
  assert.deepEqual(fleets[0]!.vanguardIds,["v1","v2"]);
  assert.deepEqual(fleets[0]!.rangerIds,["r1"]);
  assert.deepEqual(fleets[1]!.vanguardIds,["v3","v4"]);
  assert.deepEqual(fleets[1]!.rangerIds,["r2"]);
  assert.equal(fleets[0]!.formation,"FORTRESS_RING");
  assert.equal(fleets[1]!.formation,"ASSAULT_WEDGE");
});

test("local fleets: input order does not change fleet identity/composition",()=>{
  const a=[unit("v2","VANGUARD"),unit("v1","VANGUARD"),unit("v3","VANGUARD"),unit("r1","RANGER")];
  const b=[...a].reverse();
  assert.deepEqual(partitionLocalFleets(a,"t2"),partitionLocalFleets(b,"t2"));
});

test("local fleets: home reserve is never labeled strike; remainder becomes mobile when <2",()=>{
  const fleets=partitionLocalFleets([unit("v1","VANGUARD"),unit("v2","VANGUARD"),unit("r1","RANGER"),unit("v3","VANGUARD")],"t3");
  assert.deepEqual(fleets.map(f=>f.id),["t3:home:0","t3:mobile:0"]);
  assert.equal(fleets[1]!.unitIds.length,1);
});

test("activeFleetIds: no military => none",()=>{
  assert.deepEqual(activeFleetIds([],"t4"),[]);
});
