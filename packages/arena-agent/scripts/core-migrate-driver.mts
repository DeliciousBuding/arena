/**
 * 核心自主西迁驱动 v2（2026-08-08，障碍感知重写）。
 *
 * v1 缺陷（生产实证）：t4 核心卡在 (434,-150) 口袋——四周仅 DOWN 通，但 v1 只试
 * dirToward(主轴向 LEFT/UP) + perpendicular(UP)，永远不会试 DOWN → 反复
 * CORE_DESTINATION_TERRAIN_BLOCKED 死循环。v2 改为：
 *   - 读最新 calibration case 的当前真值（核心位置/状态 + 障碍集合），不再猜方向；
 *   - 每次在 4 邻域里筛出"非障碍且核心可入"的自由方向，按"朝目标距离减少量"排序，
 *     主方向被堵自动降级到次优自由方向（绕障）；
 *   - 核心状态 MOVING 时等待（不打断移动，避免 "Core is already moving" 拒绝刷屏）；
 *   - 停滞检测（位置 N 轮不变）→ 强制换方向 + 记录失败方向短时回避；
 *   - 信标安全圈规避（不靠近 -11,-1 送死区）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/core-migrate-driver.mts \
 *   --tenant=t4 --target-x=300 --target-y=-150 [--interval-ms=15000] [--max-steps=400] [--beacon-safe=60]
 * 停止/清理：删 data/runtime/human-commands/<tenant>.json 里的 command，或等脚本自然结束。
 */
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createNavState, notePosition, planDirection, chebyshev, mergeObstacleSets, type Dir, type Pos } from "../src/app/core-migrate-nav.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.ARENA_DATA_ROOT ?? "D:/Code/Projects/arena/data";

interface Args {
  readonly tenant: string;
  readonly targetX: number;
  readonly targetY: number;
  readonly intervalMs: number;
  readonly maxSteps: number;
  readonly beaconSafe: number;
  readonly dataRoot: string;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (key: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${key}=`));
    return hit?.slice(`--${key}=`.length);
  };
  return {
    tenant: get("tenant") ?? "t4",
    targetX: Number(get("target-x") ?? 300),
    targetY: Number(get("target-y") ?? -150),
    intervalMs: Number(get("interval-ms") ?? 15000),
    maxSteps: Number(get("max-steps") ?? 400),
    beaconSafe: Number(get("beacon-safe") ?? 60),
    dataRoot: get("data-root") ?? DATA_ROOT,
  };
}

interface CalibCase {
  readonly tick: number;
  readonly core: { id: string; position: [number, number]; state: string };
  readonly obstacles: ReadonlySet<string>;
}

function calibrationDir(tenant: string): string {
  return join(args.dataRoot, "runtime", tenant, "calibration");
}

/** 找最新 calibration case 文件路径（按 tick 最大）。 */
function latestCasePath(tenant: string): string | null {
  const base = calibrationDir(tenant);
  if (!existsSync(base)) return null;
  let bestFile: string | null = null;
  let bestTick = -1;
  for (const run of readdirSync(base, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    const casesDir = join(base, run.name, "cases");
    if (!existsSync(casesDir)) continue;
    for (const f of readdirSync(casesDir)) {
      const m = /^(\d+)\.json$/.exec(f);
      if (!m) continue;
      const t = Number(m[1]);
      if (t > bestTick) { bestTick = t; bestFile = join(casesDir, f); }
    }
  }
  return bestFile;
}

/** 读最新 calibration case：核心位置/状态 + 当前 tick 障碍真值（唯一 writer 落盘，最可信）。 */
function readLatestCore(tenant: string): CalibCase | null {
  const file = latestCasePath(tenant);
  if (file === null) return null;
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as {
      after: { tick: number; state: { objects: { kind: string; controlled?: boolean; id?: string; position?: [number, number]; state?: string; positions?: [number, number][] }[] } };
    };
    const objs = j.after.state.objects ?? [];
    const core = objs.find((o) => o.kind === "CORE" && o.controlled === true);
    if (!core?.id || !core.position) return null;
    const obstacles = new Set<string>();
    for (const o of objs) {
      if (o.kind === "OBSTACLE") {
        for (const p of o.positions ?? []) obstacles.add(p.join(","));
      }
    }
    // 合并 survey 全局测绘障碍（2026-08-08 修复）：calibration 视野障碍只有十几个且
    // 不稳定（t4 x=400 峡谷实证——(399,-155) 实为可走格却被视野障碍困住），
    // survey 库是全量累积测绘，路径规划更准。返回完整 CalibCase（Set 会被
    // 消费方 live.core 解引用崩溃——2026-08-08 03:3x 三驱动启动即崩实证）。
    return {
      tick: j.after.tick,
      core: { id: core.id, position: [core.position[0], core.position[1]], state: core.state ?? 'NORMAL' },
      obstacles: mergeObstacleSets(loadSurveyObstacles(args.tenant), obstacles),
    };
  } catch {
    return null;
  }
}

/** 读 survey 全局测绘障碍表（<data-root>/runtime/survey/<tenant>.db，只读）。 */
function loadSurveyObstacles(tenant: string): ReadonlySet<string> {
  const dbPath = join(args.dataRoot, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(dbPath)) return new Set();
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT x, y FROM obstacles").all() as { x: number; y: number }[];
    db.close();
    return new Set(rows.map((r) => `${r.x},${r.y}`));
  } catch (e) {
    log(`survey 障碍读取失败: ${e instanceof Error ? e.message : String(e)}`);
    return new Set();
  }
}

function storePath(tenant: string): string {
  return join(args.dataRoot, "runtime", "human-commands", `${tenant}.json`);
}

function writeMoveCommand(tenant: string, coreId: string, direction: Dir): void {
  const path = storePath(tenant);
  const existing = existsSync(path)
    ? (() => { try { return JSON.parse(readFileSync(path, "utf8")) as { mode?: string; version?: number }; } catch { return {}; } })()
    : {};
  const now = new Date().toISOString();
  const store = {
    version: existing.version ?? 1,
    mode: existing.mode ?? "override",
    commands: [{
      id: `cmd-migrate-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      unitId: coreId,
      action: { type: "START_MOVE", direction },
      note: "core-migrate-driver v2 西迁",
      createdAt: now,
    }],
    goals: [],
    updatedAt: now,
  };
  writeFileSync(path, JSON.stringify(store, null, 2), "utf-8");
}

function clearCommand(tenant: string): void {
  const path = storePath(tenant);
  if (!existsSync(path)) return;
  const existing = (() => { try { return JSON.parse(readFileSync(path, "utf8")) as { mode?: string; version?: number }; } catch { return {}; } })();
  const now = new Date().toISOString();
  writeFileSync(path, JSON.stringify({ version: existing.version ?? 1, mode: existing.mode ?? "override", commands: [], goals: [], updatedAt: now }, null, 2), "utf-8");
}

const args = parseArgs(process.argv.slice(2));
const log = (msg: string): void => console.log(`${new Date().toISOString()} [migrate-${args.tenant}] ${msg}`);

const nav = createNavState();
const recentlyFailed = new Set<string>(); // "dir:x,y" 短时回避

log(`start tenant=${args.tenant} target=(${args.targetX},${args.targetY}) interval=${args.intervalMs}ms maxSteps=${args.maxSteps} beaconSafe=${args.beaconSafe}`);

for (let step = 0; step < args.maxSteps; step += 1) {
  const live = readLatestCore(args.tenant);
  if (live === null) {
    log(`step=${step} calibration 不可读，重试`);
    await new Promise((r) => setTimeout(r, args.intervalMs));
    continue;
  }
  const core: Pos = live.core.position;
  const target: Pos = [args.targetX, args.targetY];
  log(`step=${step} tick=${live.tick} core=(${core.join(",")}) state=${live.core.state} dist=(${args.targetX - core[0]},${args.targetY - core[1]})`);

  if (chebyshev(core, target) <= 1) {
    log("到达目标，清命令，结束");
    clearCommand(args.tenant);
    break;
  }
  if (live.core.state === "MOVING") {
    log("核心 MOVING 中，等待完成（不打断）");
    await new Promise((r) => setTimeout(r, args.intervalMs));
    continue;
  }

  // 停滞检测：位置与上次相同且上次方向已尝试过 → 强制换方向
  if (notePosition(nav, core, 2) && nav.lastDir !== null) {
    recentlyFailed.add(`${nav.lastDir}:${core.join(",")}`);
    log(`停滞 ${nav.stuckStreak} 轮，记录 ${nav.lastDir}@(${core.join(",")}) 失败，换方向`);
    nav.detourDir = null; // 换向时重置绕障记忆
  } else if (nav.stuckStreak === 0) {
    recentlyFailed.clear();
  }

  const plan = planDirection(core, target, live.obstacles, args.beaconSafe, nav, recentlyFailed);

  if (plan.dir === null) {
    log("无可行方向（障碍全堵），等待地形/单位变化");
    await new Promise((r) => setTimeout(r, args.intervalMs));
    continue;
  }

  writeMoveCommand(args.tenant, live.core.id, plan.dir);
  log(`发出 START_MOVE ${plan.dir}（候选: ${plan.candidates.join(" > ")}${plan.detour ? " [绕障]" : ""}）`);
  nav.lastDir = plan.dir;
  await new Promise((r) => setTimeout(r, args.intervalMs));
}
log(`driver 结束（maxSteps=${args.maxSteps}）`);
clearCommand(args.tenant);
