/** Reproducible coordinated-fire micro A/B.
 * Two Rangers can precision-shoot two stationary 1HP enemy Workers in the same tick.
 * Baseline focus-fire wastes one point; coordinated fire should split targets.
 */
import { runEpisode } from "../src/sim/harness/episode.ts";
import type { PlanProvider } from "../src/runtime/decision-types.ts";

const IDS = {
  r1:"11111111-1111-1111-1111-111111111101", r2:"11111111-1111-1111-1111-111111111102",
  e1:"22222222-2222-2222-2222-222222222201", e2:"22222222-2222-2222-2222-222222222202",
  c1:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", c2:"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
};
const idle: PlanProvider = {
  decide: ({ state }) => ({
    tick: state.tick,
    unitActions: Object.fromEntries(state.units.map((unit) => [unit.id, { type: "WAIT" }])),
    coreAction: null,
    intents: Object.fromEntries(state.units.map((unit) => [unit.id, "WAIT"])),
  }),
};
function scenario(seed:number) {
  return { rulesVersion:"v0.14" as const, tick:1, seed, players:[
    { id:"p1",username:"p1",resources:0,core:{id:IDS.c1,position:[0,5],hp:5,shield:5,state:"NORMAL"},units:[
      {id:IDS.r1,owner:"p1",position:[0,0],hp:2,unitType:"RANGER",cargo:0},
      {id:IDS.r2,owner:"p1",position:[0,0],hp:2,unitType:"RANGER",cargo:0},
    ]},
    { id:"p2",username:"p2",resources:0,core:{id:IDS.c2,position:[20,20],hp:5,shield:5,state:"NORMAL"},units:[
      {id:IDS.e1,owner:"p2",position:[2,0],hp:1,unitType:"WORKER",cargo:0},
      {id:IDS.e2,owner:"p2",position:[3,0],hp:1,unitType:"WORKER",cargo:0},
    ]},
  ], terrain:{obstacles:[],resources:[]}, beacon:{position:[100,100],status:"GROUND",carrierId:null} };
}
for (const coordinatedFire of [false, true]) {
  let kills=0, distinctTargets=0, hits=0;
  for (let seed=1; seed<=100; seed += 1) {
    const result = runEpisode({
      scenario: scenario(seed), rulesPath:"packages/arena-agent/src/sim/contracts/rules-v0.14.json", seed, ticks:1,
      tenants:[
        {id:"p1",planner:"safety",plannerConfig:{aggression:"aggressive",coordinatedFire}},
        {id:"p2",planner:"safety"},
      ],
      plannerFactory: (tenant) => tenant.id === "p2" ? idle : undefined as never,
    } as never);
    const remaining = result.finalWorld.players.get("p2")?.units
      .filter((unit) => unit.id === IDS.e1 || unit.id === IDS.e2).length ?? 2;
    kills += 2 - remaining;
    const actions = Object.values(result.records[0]!.plans.p1!.unitActions).filter((action) => action.type === "SHOOT");
    distinctTargets += new Set(actions.map((action) => action.type === "SHOOT" ? action.targetId : null)).size;
    hits += result.records[0]!.events.filter((event) => event.eventType === "SHOT_HIT" && String(event.actorId ?? "").startsWith("11111111")).length;
  }
  console.log(JSON.stringify({ coordinatedFire, seeds:100, avgKills:kills/100, avgDistinctTargets:distinctTargets/100, shotHits:hits }));
}
