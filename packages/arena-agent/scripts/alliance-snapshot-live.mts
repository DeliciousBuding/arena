/**
 * AllianceSnapshot 真实数据端到端验证（2026-08-08，spec §5.4 落地证据）：
 * 从 t2 calibration 最近 N 个 case 构建真实 AllianceSnapshot——
 *  - roster：本租户 controlled 实体 id（Core+Units）
 *  - observations：全部对象 → 敌方目击（controlled=false）归一化去重
 *  - 输出 naive 条数 vs unique 实体 vs estimatedForce（修正后展示口径）
 *
 * 用法：node scripts/alliance-snapshot-live.mts [tenant=t2] [runs=14]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_ROSTER,
  registerAlliedEntities,
  buildAllianceSnapshot,
  type AllianceObservation,
} from "../src/alliance/index.ts";

const tenant = process.argv[2] ?? "t2";
const runLimit = Number(process.argv[3] ?? 14);
const root = `../../../data/runtime/${tenant}/calibration`;

const runDirs = readdirSync(root)
  .map((name) => join(root, name))
  .filter((p) => statSync(p, { throwIfNoEntry: false })?.isDirectory())
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  .slice(0, runLimit);

const observations: AllianceObservation[] = [];
const alliedIds = new Set<string>();
let latestTick = 0;

for (const runDir of runDirs) {
  const casesDir = join(runDir, "cases");
  if (!statSync(casesDir, { throwIfNoEntry: false })?.isDirectory()) continue;
  for (const name of readdirSync(casesDir)) {
    if (!name.endsWith(".json")) continue;
    const tick = Number(name.replace(/\D/g, "")) || 0;
    if (tick > latestTick) latestTick = tick;
    let j: { before?: { state?: { objects?: Array<Record<string, unknown>> } } };
    try {
      j = JSON.parse(readFileSync(join(casesDir, name), "utf8"));
    } catch {
      continue;
    }
    const objs = j.before?.state?.objects ?? [];
    for (const o of objs) {
      const kind = o.kind as string;
      if (kind !== "CORE" && kind !== "UNIT" && kind !== "RESOURCE") continue;
      const controlled = o.controlled === true;
      const id = typeof o.id === "string" ? o.id : undefined;
      if (controlled && id) alliedIds.add(id);
      const pos = o.position;
      if (!Array.isArray(pos) || pos.length !== 2) continue;
      observations.push({
        tenantId: tenant,
        tick,
        kind: kind as "CORE" | "UNIT" | "RESOURCE",
        entityId: id,
        ownerUsername: typeof o.owner_username === "string" && o.owner_username ? o.owner_username : undefined,
        unitType: (typeof o.unit_type === "string" ? o.unit_type : undefined) as "WORKER" | "VANGUARD" | "RANGER" | undefined,
        controlled,
        position: [pos[0], pos[1]],
        evidence: "CALIBRATION",
      });
    }
  }
}

let roster = EMPTY_ROSTER;
roster = registerAlliedEntities(roster, {
  tenantId: tenant,
  ownerUsername: null,
  entityIds: [...alliedIds],
  tick: latestTick,
});

const snap = buildAllianceSnapshot({
  revision: 1,
  members: [],
  observations,
  roster,
  nowTick: latestTick,
});

const combat = snap.sightings.filter((s) => s.kind === "UNIT" && (s.unitType === "VANGUARD" || s.unitType === "RANGER"));
console.log("=== AllianceSnapshot 真实数据端到端 ===");
console.log(`tenant: ${tenant}, runs: ${runDirs.length}, observations: ${observations.length}, tick: ${latestTick}`);
console.log(`roster allied entities: ${roster.allyEntityIds.size}`);
console.log("");
console.log("口径                          | 值");
console.log("------------------------------|------");
console.log(`naive 战斗目击条数（审计）       | ${snap.counts.historicalSightingCount}`);
console.log(`unique 战斗实体（去重后）       | ${snap.counts.recentUniqueCombat}`);
console.log(`本 tick 可见战斗单位           | ${snap.counts.currentVisibleCombat}`);
console.log(`estimatedForce（confidence 加权）| ${snap.counts.estimatedForce.toFixed(2)}`);
console.log(`敌 CORE unique owner          | ${snap.sightings.filter((s) => s.kind === "CORE").length}`);
console.log(`威胁场 cells                  | ${snap.threat.cells.size}`);
console.log(`maxDirect                      | ${snap.threat.maxDirect ? JSON.stringify(snap.threat.maxDirect.position) : "none"}`);
console.log("");
if (snap.counts.recentUniqueCombat > 0) {
  console.log(`放大倍数（naive/unique）: ${(snap.counts.historicalSightingCount / snap.counts.recentUniqueCombat).toFixed(2)}x`);
}
console.log("展示当前兵力应使用 currentVisibleCombat / recentUniqueCombat / estimatedForce，");
console.log("historicalSightingCount 仅审计（spec §1.1 修正重复累加假象）。");
