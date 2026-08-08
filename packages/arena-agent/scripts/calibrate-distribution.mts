/**
 * calibrate-distribution — 生产 vs 模拟器事件分布校准（2026-08-08）
 *
 * 对照两边的结算事件分布：
 *  - 生产：data/runtime/t1/telemetry/outcome.jsonl（官方服务端真实结算流）
 *  - 模拟器：data/runs/sim/refill-sensitivity/*.jsonl（recorder 落盘对局）
 *
 * 输出：eventType 双向覆盖 + 归一化频率对照。覆盖 ≠ 频率一致——分布差异提示
 * 策略/地图/规则环境差异，覆盖缺失提示语义缺口。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/calibrate-distribution.mts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEpisodeRecord } from "../src/sim/opponent/recorder.ts";

const COORDINATION_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..", "..", "..");
const PROD_OUTCOME = join(COORDINATION_ROOT, "data", "runtime", "t1", "telemetry", "outcome.jsonl");
const SIM_RECORD_DIR = join(COORDINATION_ROOT, "data", "runs", "sim", "refill-sensitivity");

interface Dist {
  readonly counts: Map<string, number>;
  readonly total: number;
}

function addCount(dist: Dist, key: string): void {
  dist.counts.set(key, (dist.counts.get(key) ?? 0) + 1);
  dist.total += 1;
}

/** 生产 outcome.jsonl：events 数组（类型名）+ failedEvents（类型+reason）。 */
function readProduction(): { readonly eventTypes: Dist; readonly reasons: Dist } {
  const eventTypes: Dist = { counts: new Map(), total: 0 };
  const reasons: Dist = { counts: new Map(), total: 0 };
  for (const line of readFileSync(PROD_OUTCOME, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const record = JSON.parse(line) as {
      readonly events?: readonly string[];
      readonly failedEvents?: readonly { readonly eventType?: string; readonly reasonCode?: string | null }[];
    };
    for (const eventType of record.events ?? []) {
      addCount(eventTypes, eventType);
    }
    for (const failed of record.failedEvents ?? []) {
      if (failed.eventType !== undefined) addCount(eventTypes, failed.eventType);
      if (failed.reasonCode !== null && failed.reasonCode !== undefined) addCount(reasons, failed.reasonCode);
    }
  }
  return { eventTypes, reasons };
}

/** 模拟器落盘对局：合并所有档位记录。 */
function readSimRecords(): { readonly eventTypes: Dist; readonly reasons: Dist } {
  const eventTypes: Dist = { counts: new Map(), total: 0 };
  const reasons: Dist = { counts: new Map(), total: 0 };
  for (const file of readdirSync(SIM_RECORD_DIR)) {
    if (!file.endsWith(".jsonl")) continue;
    const { ticks } = readEpisodeRecord(join(SIM_RECORD_DIR, file));
    for (const tick of ticks) {
      for (const event of tick.events) {
        addCount(eventTypes, event.eventType);
        if (event.reasonCode !== null) addCount(reasons, event.reasonCode);
      }
    }
  }
  return { eventTypes, reasons };
}

const prod = readProduction();
const sim = readSimRecords();

const freq = (dist: Dist, key: string): string =>
  `${((dist.counts.get(key) ?? 0) / dist.total) * 100}`.slice(0, 4).padStart(4) + "%";

const allEventTypes = new Set([...prod.eventTypes.counts.keys(), ...sim.eventTypes.counts.keys()]);
console.log(`生产事件总数=${prod.eventTypes.total}（t1 outcome） 模拟器事件总数=${sim.eventTypes.total}（4 档 × 200 ticks）`);
console.log("=".repeat(84));
console.log("eventType 对照（生产 ↔ 模拟器，归一化频率）");
console.log("-".repeat(84));
for (const key of [...allEventTypes].sort()) {
  const p = prod.eventTypes.counts.has(key);
  const s = sim.eventTypes.counts.has(key);
  const mark = p && s ? " 双向" : p ? " 仅生产" : " 仅模拟器";
  console.log(
    `  ${key.padEnd(32)} 生产=${freq(prod.eventTypes, key)}  模拟器=${freq(sim.eventTypes, key)}${mark}`,
  );
}

const allReasons = new Set([...prod.reasons.counts.keys(), ...sim.reasons.counts.keys()]);
console.log("-".repeat(84));
console.log("reasonCode 对照（失败原因，归一化频率）");
console.log("-".repeat(84));
for (const key of [...allReasons].sort()) {
  const p = prod.reasons.counts.has(key);
  const s = sim.reasons.counts.has(key);
  const mark = p && s ? " 双向" : p ? " 仅生产" : " 仅模拟器";
  console.log(
    `  ${key.padEnd(32)} 生产=${freq(prod.reasons, key)}  模拟器=${freq(sim.reasons, key)}${mark}`,
  );
}
console.log("-".repeat(84));
console.log("说明：双向=两边都出现；仅生产=模拟器当前策略/场景未触发（语义应已实现）；仅模拟器=生产记录未覆盖（正常，生产 t1 行为有限）。");
