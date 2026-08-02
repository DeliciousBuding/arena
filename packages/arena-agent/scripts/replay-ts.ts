/** TS sequence runner：消费 fixture manifest，输出 Differential Record v1 JSONL。
 *
 * W3 差分（TS 侧）：与 Python 侧（scripts/replay_py.py）共用同一 fixture manifest，
 * 逐 Tick 走真实决策链：reduceTurn → SafetyPlanner.decide（world/phase 跨 Tick 累积）。
 * 每 segment 重建 planner（跨 gap 不延续记忆，契约 v1.0.1）。
 *
 * 契约：docs/differential-record-v1.md + contracts/differential/record-v1.schema.json。
 *
 * 用法（仓库根或包内）：
 *   npx tsx packages/arena-agent/scripts/replay-ts.ts \
 *     --manifest fixtures/differential/burnin-20260802-a/manifest.json \
 *     --fixture-dir fixtures/differential/burnin-20260802-a --out /tmp/replay-ts.jsonl
 */

import { parseStreamMessage, Turn } from "@arena/arena-hero-ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import {
  DEFAULT_SAFETY_CONFIG,
  SafetyPlanner,
  type SafetyPlannerConfig,
} from "../src/strategies/safety-planner.ts";
import { planToCommandPlan } from "../src/runtime/loop.ts";
import { cellKey, type Position, type TickState } from "../src/domain/model.ts";

// ---------- CLI ----------

function flag(name: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  const value = process.argv[idx + 1];
  if (idx === -1 || value === undefined) {
    throw new Error(`缺少 --${name} 参数`);
  }
  return value;
}

const manifestPath = flag("manifest");
const fixtureDir = flag("fixture-dir");
const outPath = flag("out");

// ---------- config 单源（decision_config 中立字段 → SafetyPlannerConfig） ----------

const CONFIG_MAP: Record<string, keyof SafetyPlannerConfig> = {
  worker_target: "workerTarget",
  population_ceiling: "populationCeiling",
  explore_radius: "exploreRadius",
  guard_resources: "guardResources",
  guard_force: "guardForce",
};

function buildConfig(decisionConfig: Record<string, unknown>): SafetyPlannerConfig {
  const config: SafetyPlannerConfig = { ...DEFAULT_SAFETY_CONFIG };
  for (const [neutral, local] of Object.entries(CONFIG_MAP)) {
    if (neutral in decisionConfig) {
      (config as Record<string, unknown>)[local] = decisionConfig[neutral];
    }
  }
  return config;
}

// ---------- canonical 投影 ----------

function pos2list(p: Position): [number, number] {
  return [p[0], p[1]];
}

function canonicalState(state: TickState): Record<string, unknown> {
  const units = [...state.units]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((u) => ({
      id: u.id,
      position: pos2list(u.position),
      hp: u.hp,
      cargo: u.cargo,
      unit_type: u.unitType,
    }));
  const enemies = [...state.visibleEnemies]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({
      id: e.id,
      position: pos2list(e.position),
      unit_type: "unitType" in e ? (e as { unitType: string }).unitType : "CORE",
    }));
  const beacon = state.beacon;
  return {
    resources: state.resources,
    population: state.population,
    resource_capacity: state.resourceCapacity,
    resource_space: state.resourceSpace,
    core:
      state.core === null
        ? null
        : {
            id: state.core.id,
            position: pos2list(state.core.position),
            hp: state.core.hp,
            shield: state.core.shield,
            state: state.core.state,
          },
    units,
    enemies,
    resource_cells: [...state.resourceCells]
      .map((c) => c.split(",").map(Number))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    obstacle_cells: [...state.obstacleCells]
      .map((c) => c.split(",").map(Number))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    beacon:
      beacon === null
        ? null
        : {
            position: pos2list(beacon.position),
            status: beacon.status,
            carrier_id: beacon.carrierId,
          },
  };
}

function canonicalMemory(planner: SafetyPlanner): Record<string, unknown> {
  const snapshot = planner.world.snapshot();
  const resources: Record<string, { state: string; first_seen_tick: number }> = {};
  for (const r of snapshot.resources) {
    resources[r.cell] = { state: r.state, first_seen_tick: r.firstSeenTick };
  }
  const enemies: Record<string, { last_seen_tick: number; position: [number, number] }> = {};
  for (const e of snapshot.enemies) {
    enemies[e.id] = {
      last_seen_tick: e.lastSeenTick,
      position: e.cell.split(",").map(Number) as [number, number],
    };
  }
  const units: Record<string, { mode: string }> = {};
  for (const [id, mode] of Object.entries(snapshot.unitModes)) {
    units[id] = { mode };
  }
  return { resources, enemies, units };
}

// ---------- 主流程 ----------

interface Manifest {
  dataset_id: string;
  tenant_id: string;
  config_hash: string;
  map_mode: "disabled" | "frozen" | "controlled";
  decision_config: Record<string, unknown>;
  segments: Array<{ segment_id: string; ticks: number[] }>;
  inputs: Record<string, { sha256: string }>;
}

const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const config = buildConfig(manifest.decision_config);

function noopSubmitter(): never {
  throw new Error("replay: 不应提交");
}

const records: string[] = [];
for (const segment of manifest.segments) {
  // 每 segment 重建决策链（跨 gap 不延续记忆）
  const planner = new SafetyPlanner(config);
  for (const tick of segment.ticks) {
    const raw = JSON.parse(
      readFileSync(join(fixtureDir, `${tick}.json`), "utf-8"),
    ) as Record<string, unknown>;
    const state = parseStreamMessage(JSON.stringify({ type: "state", data: raw }));
    const turn = new Turn(tick, state as never, noopSubmitter);
    const tickState = reduceTurn(turn as unknown as TurnLike);
    const plan = planner.decide({ state: tickState });
    const wire = planToCommandPlan(plan);

    const record = {
      protocol_version: 1,
      dataset_id: manifest.dataset_id,
      tenant_id: manifest.tenant_id,
      segment_id: segment.segment_id,
      tick,
      input_sha256: manifest.inputs[String(tick)].sha256,
      config_hash: manifest.config_hash,
      map_snapshot_hash: null,
      state: canonicalState(tickState),
      phase: planner.phase.phase,
      memory: canonicalMemory(planner),
      intents: plan.intents,
      plan: { unit_actions: wire.unit_actions, core_action: wire.core_action },
      map_mode: manifest.map_mode,
    };
    records.push(JSON.stringify(record));
  }
}

const { writeFileSync } = await import("node:fs");
writeFileSync(outPath, records.join("\n") + "\n", "utf-8");
console.log(`replay-ts: ${records.length} records → ${outPath}`);
