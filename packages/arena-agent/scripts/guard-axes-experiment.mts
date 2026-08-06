/**
 * guardAxes A/B 实验（2026-08-07，B4 候选变体验证）：
 * 场景 = p1（2 Vanguard 守家 + 2 worker）vs p2 aggressive 双轴夹击
 * （p1 守卫远位开局强制回防 [0,0]）。
 * 对照 guardAxes=false（守卫四邻轮转/挤向最近敌）vs true（轴分桶：
 * Vanguard 3 格外层 E/W 分守）。KPI：p1 Core 命中数、p1 worker 损失、
 * p1 deposits、p1 存活。
 */
import { runEpisode } from '../../../../arena-ts/packages/arena-agent/src/sim/harness/episode.ts';

function threatScenario(seed: number) {
  return {
    rulesVersion: 'v0.14' as const,
    tick: 1,
    seed,
    players: [
      {
        id: 'p1', username: 'p1', resources: 30,
        core: { id: '11111111-1111-1111-1111-111111111111', position: [0, 0], hp: 5, shield: 5, state: 'NORMAL' },
        units: [
          { id: '22222222-2222-2222-2222-222222222201', owner: 'p1', position: [8, 0], hp: 4, unitType: 'VANGUARD', cargo: 0 },
          { id: '22222222-2222-2222-2222-222222222202', owner: 'p1', position: [-8, 0], hp: 4, unitType: 'VANGUARD', cargo: 0 },
          { id: '22222222-2222-2222-2222-222222222203', owner: 'p1', position: [1, 0], hp: 2, unitType: 'WORKER', cargo: 0 },
          { id: '22222222-2222-2222-2222-222222222204', owner: 'p1', position: [0, 1], hp: 2, unitType: 'WORKER', cargo: 0 },
        ],
      },
      {
        id: 'p2', username: 'p2', resources: 50,
        core: { id: '44444444-4444-4444-4444-444444444444', position: [30, 0], hp: 5, shield: 5, state: 'NORMAL' },
        units: [
          { id: '55555555-5555-5555-5555-555555555501', owner: 'p2', position: [20, 0], hp: 4, unitType: 'VANGUARD', cargo: 0 },
          { id: '55555555-5555-5555-5555-555555555502', owner: 'p2', position: [20, 1], hp: 4, unitType: 'VANGUARD', cargo: 0 },
          { id: '55555555-5555-5555-5555-555555555503', owner: 'p2', position: [-20, 0], hp: 4, unitType: 'VANGUARD', cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[2, 0], [3, 1], [0, 2], [12, 0], [-12, 0]] },
    beacon: { position: [100, 100], status: 'GROUND', carrierId: null },
  };
}

const SEEDS = [1, 2, 3];
const TICKS = 300;

function runVariant(guardAxes: boolean, seed: number) {
  const result = runEpisode({
    scenario: threatScenario(seed),
    rulesPath: 'D:/Code/Projects/arena/arena-ts/packages/arena-agent/src/sim/contracts/rules-v0.14.json',
    seed,
    ticks: TICKS,
    tenants: [
      { id: 'p1', planner: 'safety', plannerConfig: { guardAxes } },
      { id: 'p2', planner: 'safety', plannerConfig: { aggression: 'aggressive' } },
    ],
  } as never);
  let coreHits = 0;
  let workerLosses = 0;
  let deposits = 0;
  let p1CoreAlive = true;
  const p1Workers = new Set(['22222222-2222-2222-2222-222222222203', '22222222-2222-2222-2222-222222222204']);
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === 'CORE_DAMAGED' && String(event.targetId ?? '').startsWith('1111')) coreHits += 1;
      if (event.eventType === 'CORE_DESTROYED' && String(event.targetId ?? '').startsWith('1111')) p1CoreAlive = false;
      if (event.eventType === 'UNIT_DAMAGED' && p1Workers.has(String(event.targetId ?? '')) && (event.values?.hp ?? 1) <= 0) workerLosses += 1;
      if (event.eventType === 'DEPOSIT_SUCCEEDED' && String(event.actorId ?? '').startsWith('2222')) deposits += 1;
    }
  }
  return { coreHits, workerLosses, deposits, p1CoreAlive };
}

console.log('guardAxes A/B v0.14（' + TICKS + ' ticks x ' + SEEDS.length + ' seeds，p2 双轴 3 Vanguard 夹击 p1 Core）');
console.log('='.repeat(76));
for (const [label, guardAxes] of [['guardAxes=false（现状）', false], ['guardAxes=true（轴分桶）', true]] as const) {
  const outcomes = SEEDS.map((seed) => runVariant(guardAxes, seed));
  const avg = (k: string) => (outcomes.reduce((s, o) => s + (o as any)[k], 0) / outcomes.length).toFixed(1);
  const alive = outcomes.filter((o) => o.p1CoreAlive).length;
  console.log(label.padEnd(26) + ' | Core命中(avg)=' + avg('coreHits') + ' | worker损失(avg)=' + avg('workerLosses') + ' | deposits(avg)=' + avg('deposits') + ' | p1存活=' + alive + '/' + SEEDS.length);
  for (const [i, o] of outcomes.entries()) {
    console.log('  seed ' + (i + 1) + ': hits=' + o.coreHits + ' wl=' + o.workerLosses + ' dep=' + o.deposits + ' alive=' + o.p1CoreAlive);
  }
}
