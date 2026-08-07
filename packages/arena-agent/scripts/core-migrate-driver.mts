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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.ARENA_DATA_ROOT ?? "ARENA_REPO_ROOT/data";

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

const BEACON: readonly [number, number] = [-11, -1];
const DIRECTIONS = ["UP", "DOWN", "LEFT", "RIGHT"] as const;
type Dir = (typeof DIRECTIONS)[number];
const DELTA: Readonly<Record<Dir, [number, number]>> = { UP: [0, -1], DOWN: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0] };

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
    return { tick: j.after.tick, core: { id: core.id, position: [core.position[0], core.position[1]], state: core.state ?? "NORMAL" }, obstacles };
  } catch {
    return null;
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

function chebyshev(a: [number, number], b: [number, number]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

/** 信标安全圈规避：太近 → 返回远离信标的主方向；安全则 null。 */
function beaconAvoid(core: [number, number], safe: number): Dir | null {
  const dx = core[0] - BEACON[0];
  const dy = core[1] - BEACON[1];
  if (Math.abs(dx) > safe && Math.abs(dy) > safe) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "RIGHT" : "LEFT";
  return dy < 0 ? "DOWN" : "UP";
}

/** 候选方向排序：先避信标（若在圈内），再按 Chebyshev 距离减少量从大到小。 */
function scoreDirections(core: [number, number], target: [number, number], obstacles: ReadonlySet<string>, beaconSafe: number): Dir[] {
  const base = chebyshev(core, target);
  const avoid = beaconAvoid(core, beaconSafe);
  return DIRECTIONS
    .filter((d) => {
      const next: [number, number] = [core[0] + DELTA[d][0], core[1] + DELTA[d][1]];
      return !obstacles.has(next.join(","));
    })
    .map((d) => {
      const next: [number, number] = [core[0] + DELTA[d][0], core[1] + DELTA[d][1]];
      const gain = base - chebyshev(next, target);
      const antiBeacon = avoid === d ? 1_000_000 : 0;
      return { d, gain: gain + antiBeacon };
    })
    .sort((a, b) => b.gain - a.gain)
    .map((x) => x.d);
}

const args = parseArgs(process.argv.slice(2));
const log = (msg: string): void => console.log(`${new Date().toISOString()} [migrate-${args.tenant}] ${msg}`);

let lastPos: [number, number] | null = null;
let lastDir: Dir | null = null;
let stuckStreak = 0;
const recentlyFailed = new Set<string>(); // "dir:x,y" 短时回避

log(`start tenant=${args.tenant} target=(${args.targetX},${args.targetY}) interval=${args.intervalMs}ms maxSteps=${args.maxSteps} beaconSafe=${args.beaconSafe}`);

for (let step = 0; step < args.maxSteps; step += 1) {
  const live = readLatestCore(args.tenant);
  if (live === null) {
    log(`step=${step} calibration 不可读，重试`);
    await new Promise((r) => setTimeout(r, args.intervalMs));
    continue;
  }
  const core: [number, number] = live.core.position;
  const target: [number, number] = [args.targetX, args.targetY];
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
  if (lastPos !== null && lastPos[0] === core[0] && lastPos[1] === core[1]) {
    stuckStreak += 1;
    if (stuckStreak >= 2 && lastDir !== null) {
      recentlyFailed.add(`${lastDir}:${core.join(",")}`);
      log(`停滞 ${stuckStreak} 轮，记录 ${lastDir}@(${core.join(",")}) 失败，换方向`);
    }
  } else {
    stuckStreak = 0;
    recentlyFailed.clear();
  }

  const candidates = scoreDirections(core, target, live.obstacles, args.beaconSafe)
    .filter((d) => !recentlyFailed.has(`${d}:${core.join(",")}`));

  if (candidates.length === 0) {
    log("无可行方向（障碍全堵），等待地形/单位变化");
    await new Promise((r) => setTimeout(r, args.intervalMs));
    continue;
  }

  const dir = candidates[0];
  writeMoveCommand(args.tenant, live.core.id, dir);
  log(`发出 START_MOVE ${dir}（候选: ${candidates.join(" > ")}）`);
  lastDir = dir;
  lastPos = [core[0], core[1]];
  await new Promise((r) => setTimeout(r, args.intervalMs));
}
log(`driver 结束（maxSteps=${args.maxSteps}）`);
clearCommand(args.tenant);
