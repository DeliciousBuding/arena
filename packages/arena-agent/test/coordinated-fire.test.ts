import test from "node:test";
import assert from "node:assert/strict";
import type { TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function enemy(id:string, x:number, hp:number, unitType:"WORKER"|"VANGUARD"|"RANGER"="WORKER"): VisibleEntity {
  return { id, kind:"UNIT", position:[x,0], hp, unitType };
}
function state(units: TickState["units"], enemies: VisibleEntity[]): TickState {
  return { tick:1,status:"ACTIVE",resources:10,resourceCapacity:50,resourceSpace:40,population:units.length,
    core:{id:"c",position:[0,2],hp:5,shield:5,state:"NORMAL",ownerUsername:"me"}, units, workers:[],
    vanguards:units.filter(u=>u.unitType==="VANGUARD"), rangers:units.filter(u=>u.unitType==="RANGER"),
    visibleEnemies:enemies,resourceCells:new Set(),obstacleCells:new Set(),
    beacon:{position:[100,100],status:"GROUND",carrierId:null},events:[] };
}
const policy={posture:"aggressive" as const,workerTarget:4,militaryRatio:.5,focusRegion:null,attackPriority:"workers" as const};

test("coordinated fire: two Rangers split fire when first 1HP target is already lethally covered",()=>{
  const units=[
    {id:"r1",position:[0,0] as const,hp:2,unitType:"RANGER" as const,cargo:0},
    {id:"r2",position:[0,0] as const,hp:2,unitType:"RANGER" as const,cargo:0},
  ];
  const p=new SafetyPlanner({...DEFAULT_SAFETY_CONFIG,aggression:"aggressive",coordinatedFire:true});
  const plan=p.decide({state:state(units,[enemy("e1",2,1,"WORKER"),enemy("e2",2,2,"RANGER")]),policy});
  assert.equal(plan.unitActions.r1?.type,"SHOOT");
  assert.equal(plan.unitActions.r2?.type,"SHOOT");
  const ids=units.map(u=>plan.unitActions[u.id]).map(a=>a?.type==="SHOOT"?a.targetId:null);
  assert.deepEqual(new Set(ids),new Set(["e1","e2"]));
});

test("coordinated fire default-off preserves old focus fire",()=>{
  const units=[
    {id:"r1",position:[0,0] as const,hp:2,unitType:"RANGER" as const,cargo:0},
    {id:"r2",position:[0,0] as const,hp:2,unitType:"RANGER" as const,cargo:0},
  ];
  const p=new SafetyPlanner({...DEFAULT_SAFETY_CONFIG,aggression:"aggressive"});
  const plan=p.decide({state:state(units,[enemy("e1",2,1,"WORKER"),enemy("e2",2,2,"RANGER")]),policy});
  assert.equal(plan.unitActions.r1?.type==="SHOOT"?plan.unitActions.r1.targetId:null,"e1");
  assert.equal(plan.unitActions.r2?.type==="SHOOT"?plan.unitActions.r2.targetId:null,"e1");
});

test("coordinated fire: Vanguard sweep reserves damage for later Ranger",()=>{
  // id ordering v1 before z-r1; sweep hits both enemies in [1,0], killing e1(hp1) but only scratching e2(hp2).
  const units=[
    {id:"v1",position:[0,0] as const,hp:4,unitType:"VANGUARD" as const,cargo:0},
    {id:"z-r1",position:[0,1] as const,hp:2,unitType:"RANGER" as const,cargo:0},
  ];
  const p=new SafetyPlanner({...DEFAULT_SAFETY_CONFIG,aggression:"aggressive",coordinatedFire:true});
  const plan=p.decide({state:state(units,[enemy("e1",1,1,"WORKER"),enemy("e2",1,2,"RANGER")]),policy});
  assert.equal(plan.unitActions.v1?.type,"SWEEP");
  assert.equal(plan.unitActions["z-r1"]?.type,"SHOOT");
  assert.equal(plan.unitActions["z-r1"]?.type==="SHOOT"?plan.unitActions["z-r1"].targetId:null,"e2");
});
