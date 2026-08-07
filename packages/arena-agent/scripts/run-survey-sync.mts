/**
 * 测绘同步 CLI（2026-08-08）：把 calibration cases 增量写入测绘数据库。
 *
 * 用法：
 *   npm run survey:sync -- --tenants=t1,t2,t3,t4
 *   npm run survey:sync -- --tenants=t1 --latest-only
 *   npm run survey:sync -- --all
 *
 * 幂等：sync_meta 记每 run 已同步 tick，重复执行只补增量。
 */
import { resolve } from "node:path";
import { syncTenantSurvey } from "../src/intel/survey-sync.ts";

const DEFAULT_DATA_ROOT = resolve(import.meta.dirname, "..", "..", "..", "data");

function parseArgs(argv: readonly string[]): { dataRoot: string; tenants: string[]; latestOnly: boolean } {
  let dataRoot = DEFAULT_DATA_ROOT;
  let latestOnly = false;
  let tenants: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--data-root=")) dataRoot = resolve(arg.slice("--data-root=".length));
    else if (arg === "--latest-only") latestOnly = true;
    else if (arg.startsWith("--tenants=")) tenants = arg.slice("--tenants=".length).split(",").filter(Boolean);
    else if (arg === "--all") tenants = ["t1", "t2", "t3", "t4"];
  }
  return { dataRoot, tenants, latestOnly };
}

const { dataRoot, tenants, latestOnly } = parseArgs(process.argv.slice(2));
if (tenants.length === 0) {
  console.error("用法：npm run survey:sync -- --tenants=t1,t2,t3,t4 [--latest-only]");
  process.exit(2);
}

for (const tenant of tenants) {
  const summary = syncTenantSurvey(dataRoot, tenant, { latestRunOnly: latestOnly });
  console.log(
    `[survey] ${tenant}: runs=${summary.runs} cases=${summary.cases} ` +
      `resources=${summary.resources} obstacles=${summary.obstacles} coreHunts=${summary.coreHunts}`,
  );
}
console.log(`[survey] done (data-root=${dataRoot})`);
