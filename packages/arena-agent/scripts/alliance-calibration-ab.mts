/**
 * Alliance 目击口径离线验证（2026-08-08，alliance-model 落地证据）：
 * 扫描 t2 calibration cases，把 enemy UNIT 目击按两种口径统计：
 *  - naive：每 case 每条目击 +1（旧 intel.ts `enemyUnits += 1` 行为）
 *  - unique：按 entity id 去重（新联盟语义，spec §5.2 规则 1）
 * 输出对比，量化"重复放大假象"。
 *
 * 用法：node scripts/alliance-calibration-ab.mts [calibrationRoot] [windowTicks]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "../../../data/runtime/t2/calibration";
const windowTicks = Number(process.argv[3] ?? 0); // 0 = 全历史

function isCombat(unitType: string | null | undefined): boolean {
  return unitType === "VANGUARD" || unitType === "RANGER";
}

const cases: { tick: number; file: string }[] = [];
for (const run of readdirSync(root)) {
  const runDir = join(root, run);
  if (!statSync(runDir, { throwIfNoEntry: false })?.isDirectory()) continue;
  const casesDir = join(runDir, "cases");
  if (!statSync(casesDir, { throwIfNoEntry: false })?.isDirectory()) continue;
  for (const name of readdirSync(casesDir)) {
    if (!name.endsWith(".json")) continue;
    cases.push({ tick: Number(name.replace(/\D/g, "")) || 0, file: join(casesDir, name) });
  }
}
cases.sort((a, b) => a.tick - b.tick);
if (windowTicks > 0 && cases.length > 0) {
  const maxTick = cases[cases.length - 1].tick;
  const cutoff = maxTick - windowTicks;
  while (cases.length > 0 && cases[0].tick < cutoff) cases.shift();
}

let naiveUnits = 0;
let naiveCombat = 0;
const seen = new Map<string, number>(); // id -> firstSeenTick
const seenCombat = new Map<string, number>();
const byOwner = new Map<string, { x: number; y: number; tick: number }>();
let coreSightings = 0;
const uniqueCores = new Set<string>();

for (const c of cases) {
  let j: { before?: { state?: { objects?: unknown[] } } };
  try {
    j = JSON.parse(readFileSync(c.file, "utf8"));
  } catch {
    continue;
  }
  const objs = j.before?.state?.objects ?? [];
  for (const o of objs) {
    const obj = o as { kind?: string; controlled?: boolean; id?: string; unit_type?: string | null; owner_username?: string | null; position?: [number, number] };
    if (obj.kind === "UNIT" && obj.controlled === false) {
      naiveUnits += 1;
      if (isCombat(obj.unit_type)) naiveCombat += 1;
      if (obj.id && !seen.has(obj.id)) seen.set(obj.id, c.tick);
      if (obj.id && isCombat(obj.unit_type) && !seenCombat.has(obj.id)) seenCombat.set(obj.id, c.tick);
    }
    if (obj.kind === "CORE" && obj.controlled === false) {
      coreSightings += 1;
      if (obj.owner_username) uniqueCores.add(obj.owner_username);
    }
  }
}

console.log("=== Alliance 目击口径对比（真实 calibration） ===");
console.log(`root: ${root}`);
console.log(`cases scanned: ${cases.length}`);
console.log(`tick range: ${cases.length > 0 ? cases[0].tick + ".." + cases[cases.length - 1].tick : "n/a"}`);
console.log("");
console.log("口径                          | 数量");
console.log("------------------------------|------");
console.log(`naive UNIT 目击条数（旧 intel）  | ${naiveUnits}`);
console.log(`naive 战斗 UNIT 目击条数        | ${naiveCombat}`);
console.log(`unique UNIT（按 id 去重）       | ${seen.size}`);
console.log(`unique 战斗 UNIT（按 id 去重）  | ${seenCombat.size}`);
console.log(`放大倍数（naive战斗/unique战斗）  | ${seenCombat.size > 0 ? (naiveCombat / seenCombat.size).toFixed(2) : "n/a"}`);
console.log(`敌 CORE 目击条数                | ${coreSightings}`);
console.log(`敌 CORE unique owner            | ${uniqueCores.size}`);
console.log("");
console.log('结论：展示当前兵力必须用 unique 口径（spec §5.2 去重 + §5.3 衰减），');
console.log("naive 条数只作审计/回放对比（historicalSightingCount），不作兵力展示。");
