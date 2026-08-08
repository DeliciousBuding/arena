/** 格级负观测回填工具（2026-08-08，A15）：对 calibration case 跑
 *  collectResourceAbsences 写 resource_absences（不重写其他表，幂等 upsert）。
 *  用于历史 case 补录负观测（survey:sync 只处理水位后新 case）。用法：
 *    npx tsx scripts/backfill-absences.mts --data-root=ARENA_REPO_ROOT/data \
 *      --tenants=t1,t2,t3,t4 [--runs=30]
 *  --runs=N 只处理最近 N 个 run（默认全部）；无计划任务，手动/CI 用。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openSurveyDb, upsertResourceAbsences } from "../src/intel/survey-db.ts";
import { parseCaseObjects, collectResourceAbsences } from "../src/intel/survey-sync.ts";

function parseArgs(argv: readonly string[]): { dataRoot: string; tenants: string[]; runs: number } {
  let dataRoot = ".";
  let tenants: string[] = [];
  let runs = 0;
  for (const a of argv) {
    if (a.startsWith("--data-root=")) dataRoot = a.slice("--data-root=".length);
    else if (a.startsWith("--tenants=")) tenants = a.slice("--tenants=".length).split(",").filter(Boolean);
    else if (a.startsWith("--runs=")) runs = Number(a.slice("--runs=".length));
  }
  if (tenants.length === 0) tenants = ["t1", "t2", "t3", "t4"];
  return { dataRoot, tenants, runs };
}

const { dataRoot, tenants, runs } = parseArgs(process.argv.slice(2));
for (const tenant of tenants) {
  const db = openSurveyDb(dataRoot, tenant, true);
  const calDir = join(dataRoot, "runtime", tenant, "calibration");
  if (!existsSync(calDir)) { console.log(`[${tenant}] no calibration`); db.close(); continue; }
  const runDirs = readdirSync(calDir, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const targets = runs > 0 ? runDirs.slice(-runs) : runDirs;
  let cases = 0, absences = 0;
  // 已知矿格集合缓存：全量回填 1.3 万 case/租户，每 case 查 resources 表极慢——
  // 改为每租户查一次（collectResourceAbsences 支持外部传入）。
  const knownCells = new Set(
    (db.prepare("SELECT x, y FROM resources").all() as Array<{ x: number; y: number }>)
      .map((r) => `${r.x},${r.y}`),
  );
  for (const runDir of targets) {
    const casesDir = join(calDir, runDir, "cases");
    if (!existsSync(casesDir)) continue;
    const files = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
    for (const file of files) {
      const tick = Number(file.replace(/^0+/, "").replace(/\.json$/, ""));
      if (!Number.isFinite(tick)) continue;
      try {
        const raw = JSON.parse(readFileSync(join(casesDir, file), "utf8"));
        const objects = parseCaseObjects(raw);
        if (objects === null) continue;
        cases += 1;
        const rows = collectResourceAbsences(db, objects, tick, knownCells);
        if (rows.length > 0) absences += upsertResourceAbsences(db, rows);
      } catch { /* 坏 case 跳过 */ }
    }
  }
  console.log(`[${tenant}] runs=${targets.length} cases=${cases} absences=${absences}`);
  db.close();
}
