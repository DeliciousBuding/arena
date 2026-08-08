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
import { createNavState, notePosition, planDirection, chebyshev, mergeObstacleSets, DIRECTIONS, DELTA, type Dir, type Pos } from "../src/app/core-migrate-nav.ts";
import { auditMigrationTarget } from "../src/domain/migration-audit.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.ARENA_DATA_ROOT ?? "ARENA_REPO_ROOT/data";

interface Args {
  readonly tenant: string;
  readonly targetX: number;
  readonly targetY: number;
  readonly intervalMs: number;
  readonly maxSteps: number;
  readonly beaconSafe: number;
  readonly force: boolean;
  readonly dataRoot: string;
  /** 不用 survey 累积障碍（长距离开阔地误判绕障 2026-08-08 t1 实证）；只信实时视野障碍。 */
  readonly noSurveyObstacles: boolean;
  /** 军事护航（2026-08-08）：最近 VANGUARD goto 核心前方 2 格开路，防止被围+发现敌核。 */
  readonly escort: boolean;
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
    force: argv.includes("--force"),
    dataRoot: get("data-root") ?? DATA_ROOT,
    noSurveyObstacles: get("no-survey-obstacles") === "1" || get("no-survey-obstacles") === "true",
    escort: argv.includes("--escort"),
  };
}

interface CalibCase {
  readonly tick: number;
  readonly core: { id: string; position: [number, number]; state: string };
  readonly obstacles: ReadonlySet<string>;
  /** 核心 4 邻单位占用：key="dx,dy" -> unit 列表。核心被自己 worker 围死是
   *  START_MOVE CELL_UNIT_LIMIT 根因（2026-08-08 t1 实证：RIGHT 2 worker、UP 1、
   *  DOWN 2，核心无法移动）。driver 需先让位目标格 worker 再启动核心移动。 */
  readonly coreNeighborUnits: ReadonlyMap<string, { readonly id: string; readonly type: string }[]>;
  /** 全部我方单位（护航找最近 VANGUARD 用）。 */
  readonly units: readonly { id: string; type: string; position: [number, number]; hp: number }[];
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
    // 核心 4 邻单位占用（含敌我；核心迁移只让位自己单位，敌方占据格本身在
    // planDirection 障碍判定外——若目标格有敌核/敌单位，START_MOVE 会被服务端
    // CORE_DESTINATION_OCCUPIED 拒绝，停滞检测换向兜底）。
    const neighborUnits = new Map<string, { readonly id: string; readonly type: string }[]>();
    const [cx, cy] = core.position;
    for (const o of objs) {
      if (o.kind !== "UNIT" || !Array.isArray(o.position)) continue;
      const dx = o.position[0] - cx;
      const dy = o.position[1] - cy;
      if (Math.abs(dx) + Math.abs(dy) !== 1) continue;
      const key = `${dx},${dy}`;
      const list = neighborUnits.get(key) ?? [];
      list.push({ id: o.id, type: String(o.unit_type ?? "?") });
      neighborUnits.set(key, list);
    }
    const units = objs
      .filter((o) => o.kind === "UNIT")
      .map((o) => {
        const u = o as { id?: string; unit_type?: string; position?: [number, number]; hp?: number };
        return {
          id: String(u.id ?? ""),
          type: String(u.unit_type ?? "?"),
          position: [u.position?.[0] ?? 0, u.position?.[1] ?? 0] as [number, number],
          hp: Number(u.hp ?? 0),
        };
      });
    // 合并 survey 全局测绘障碍（2026-08-08 修复）：calibration 视野障碍只有十几个且
    // 不稳定（t4 x=400 峡谷实证——(399,-155) 实为可走格却被视野障碍困住），
    // survey 库是全量累积测绘，路径规划更准。返回完整 CalibCase（Set 会被
    // 消费方 live.core 解引用崩溃——2026-08-08 03:3x 三驱动启动即崩实证）。
    return {
      tick: j.after.tick,
      core: { id: core.id, position: [core.position[0], core.position[1]], state: core.state ?? 'NORMAL' },
      obstacles: args.noSurveyObstacles
        ? obstacles
        : mergeObstacleSets(loadSurveyObstacles(args.tenant), obstacles),
      coreNeighborUnits: neighborUnits,
      units,
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

/** 读 survey 已知资源（<data-root>/runtime/survey/<tenant>.db，只读，军事审计用）。 */
function loadSurveyResources(tenant: string): { x: number; y: number; lastSeenTick: number }[] {
  const dbPath = join(args.dataRoot, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(dbPath)) return [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT x, y, last_seen_tick AS lastSeenTick FROM resources").all() as { x: number; y: number; lastSeenTick: number }[];
    db.close();
    return rows;
  } catch (e) {
    log(`survey 资源读取失败: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** 读 survey 敌核记忆（<data-root>/runtime/survey/<tenant>.db，只读，军事审计用）。 */
function loadSurveyEnemyCores(tenant: string): { x: number; y: number; lastSeenTick: number }[] {
  const dbPath = join(args.dataRoot, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(dbPath)) return [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT x, y, last_seen_tick AS lastSeenTick FROM core_hunts").all() as { x: number; y: number; lastSeenTick: number }[];
    db.close();
    return rows;
  } catch (e) {
    log(`survey 敌核读取失败: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** 军事审计预检（2026-08-08，migration-audit-v1）：资源贫瘠/活跃敌核贴脸目标
 *  默认拒绝——t1 生产实证 [-619,-154]→[-565,-95]（227 资源→1 资源 + 21 敌核）。
 *  --force 显式绕过（有意识的战略迁移）。数据不可读时 fail-open 放行。 */
function auditPreflight(tenant: string): void {
  const live = readLatestCore(tenant);
  if (live === null) {
    log("军事审计：calibration 不可读，跳过预检（fail-open）");
    return;
  }
  const resources = loadSurveyResources(tenant);
  const enemyCores = loadSurveyEnemyCores(tenant);
  if (resources.length === 0 && enemyCores.length === 0) {
    log("军事审计：survey 无数据，跳过预检（fail-open）");
    return;
  }
  const audit = auditMigrationTarget(
    live.core.position,
    [args.targetX, args.targetY],
    resources,
    enemyCores,
    live.tick,
  );
  if (audit.ok) {
    log(`军事审计通过：目标区新鲜资源 ${audit.freshResourceCount}/${audit.resourceCount}，敌核 ${audit.activeEnemyCoreCount}/${audit.enemyCoreCount} 活跃，迁移距离 ${audit.distance} 格`);
    return;
  }
  if (args.force) {
    log(`军事审计【--force 强制放行】：${audit.reasons.join("；")}`);
    return;
  }
  log(`军事审计【拒绝迁移】：${audit.reasons.join("；")}。若确认有意迁移请加 --force`);
  process.exit(2);
}

function storePath(tenant: string): string {
  return join(args.dataRoot, "runtime", "human-commands", `${tenant}.json`);
}

interface WireCommand {
  readonly unitId: string;
  readonly action: Record<string, unknown>;
  readonly note?: string;
}

function writeCommands(
  tenant: string,
  commands: readonly WireCommand[],
  escortGoal?: { unitId: string; kind: "goto"; target: [number, number]; note: string; createdAt: string } | null,
): void {
  const path = storePath(tenant);
  const existing = existsSync(path)
    ? (() => { try { return JSON.parse(readFileSync(path, "utf8")) as { mode?: string; version?: number }; } catch { return {}; } })()
    : {};
  const now = new Date().toISOString();
  const store = {
    version: existing.version ?? 1,
    mode: existing.mode ?? "override",
    commands: commands.map((c, i) => ({
      id: `cmd-migrate-${now}-${i}-${Math.floor(Math.random() * 1e6)}`,
      unitId: c.unitId,
      action: c.action,
      note: c.note ?? "core-migrate-driver 直迁",
      createdAt: now,
    })),
    // 保留已有持续意图（goals：worker 疏散）+ 可选护航 goal
    goals: [...(existing.goals ?? []), ...(escortGoal ? [escortGoal] : [])],
    updatedAt: now,
  };
  writeFileSync(path, JSON.stringify(store, null, 2), "utf-8");
}

function writeMoveCommand(tenant: string, coreId: string, direction: Dir): void {
  writeCommands(tenant, [{ unitId: coreId, action: { type: "START_MOVE", direction } }]);
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

auditPreflight(args.tenant);

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

  const plan = planDirection(core, target, live.obstacles, args.beaconSafe, nav, recentlyFailed);

  if (plan.dir === null) {
    log("无可行方向（障碍全堵），等待地形/单位变化");
    await new Promise((r) => setTimeout(r, args.intervalMs));
    continue;
  }

  // 目标格被自己单位占 → 持续让位（不算停滞）：P05 单位先 MOVE 空出目标格，
  // P06 核心 START_MOVE 才通过 CELL_UNIT_LIMIT 校验（t1 实证核心被 worker+军事
  // 围死）。让位目标 = 核心沿 dir 前进 2 格（core+3*dir，走更远不立刻回堵）；
  // 该格被占/障碍则选垂直方向/后退方向。
  const delta = DELTA[plan.dir];
  const targetKey = `${core[0] + delta[0]},${core[1] + delta[1]}`;
  const blockers = live.coreNeighborUnits.get(`${delta[0]},${delta[1]}`) ?? [];
  const ownBlockers = blockers.filter((u) => u.type !== "?" && u.type !== "CORE");
  const cmds: WireCommand[] = [];
  if (ownBlockers.length > 0) {
    // freeExit(ox, oy)：让位 worker（在 core+delta）的 1 格偏移目标。MOVE 只走
    // 1 格——2026-08-08 t1 卡 (-602,-146) 实证：旧版用 2 格偏移导致方向分量
    // 变 2、dirName 映射错乱（dy=2 → UP），worker 往核心方向挪，让位永不生效。
    const freeExit = (ox: number, oy: number): string | null => {
      const nx = core[0] + delta[0] + ox;
      const ny = core[1] + delta[1] + oy;
      const key = `${nx},${ny}`;
      if (live.obstacles.has(key)) return null;
      // 不让位单位挪回核心邻格（避免原地打转）
      if (Math.abs(nx - core[0]) + Math.abs(ny - core[1]) <= 1) return null;
      return key;
    };
    for (const b of ownBlockers) {
      // 沿 delta 继续 1 格优先（远离核心），其次垂直/反方向 1 格
      const ex = freeExit(delta[0], delta[1])
        ?? freeExit(0, 1)
        ?? freeExit(0, -1)
        ?? freeExit(-delta[0], -delta[1]);
      if (ex === null) continue;
      const [exx, exy] = ex.split(",").map(Number);
      const dx = exx - core[0] - delta[0];
      const dy = exy - core[1] - delta[1];
      const dirName = dx === 1 ? "RIGHT" : dx === -1 ? "LEFT" : dy === 1 ? "DOWN" : "UP";
      cmds.push({ unitId: b.id, action: { type: "MOVE", direction: dirName }, note: "core-migrate 让位" });
    }
    if (cmds.length > 0) {
      log(`目标格 ${targetKey} 被 ${ownBlockers.length} 单位占，持续让位（${cmds.map((c) => c.unitId.slice(0, 8)).join(",")}）`);
    }
    // 让位期间不判停滞（让位需时间），重置停滞计数
    nav.lastPos = null;
    nav.stuckStreak = 0;
  } else {
    // 目标格空才做停滞检测：位置与上次相同且上次方向已尝试过 → 强制换向。
    // 阈值 6 轮（18s）：核心移动 1 格需 4 tick（~60s@15s/tick），2 轮太敏感
    // 会在 MOVING 完成前误判（t1 实证核心被带偏 NW）。
    if (notePosition(nav, core, 6) && nav.lastDir !== null) {
      recentlyFailed.add(`${nav.lastDir}:${core.join(",")}`);
      log(`停滞 ${nav.stuckStreak} 轮，记录 ${nav.lastDir}@(${core.join(",")}) 失败，换方向`);
      nav.detourDir = null;
      const cellFailures = DIRECTIONS.filter((d) => recentlyFailed.has(`${d}:${core.join(",")}`)).length;
      if (cellFailures >= 4 || recentlyFailed.size >= 16) {
        recentlyFailed.clear();
        log(`失败记忆超限（${cellFailures}/4），清空重评`);
      }
    } else if (nav.stuckStreak === 0) {
      recentlyFailed.clear();
    }
  }

  cmds.push({ unitId: live.core.id, action: { type: "START_MOVE", direction: plan.dir }, note: "core-migrate-driver 直迁" });
  // 军事护航：最近 VANGUARD goto 核心前方 2 格（占位开路、发现敌核；不挡核心 4 邻）
  let escortGoal: { unitId: string; kind: "goto"; target: [number, number]; note: string; createdAt: string } | null = null;
  if (args.escort) {
    const vanguards = live.units.filter((u) => u.type === "VANGUARD");
    if (vanguards.length > 0) {
      vanguards.sort((a, b) => chebyshev(a.position, core) - chebyshev(b.position, core));
      const v = vanguards[0];
      const fx = core[0] + delta[0] * 2;
      const fy = core[1] + delta[1] * 2;
      escortGoal = { unitId: v.id, kind: "goto", target: [fx, fy], note: "core-migrate 护航", createdAt: new Date().toISOString() };
    }
  }
  writeCommands(args.tenant, cmds, escortGoal);
  log(`发出 START_MOVE ${plan.dir}（候选: ${plan.candidates.join(" > ")}${plan.detour ? " [绕障]" : ""}${ownBlockers.length > 0 ? ` +${ownBlockers.length} 让位` : ""}）`);
  nav.lastDir = plan.dir;
  await new Promise((r) => setTimeout(r, args.intervalMs));
}
log(`driver 结束（maxSteps=${args.maxSteps}）`);
clearCommand(args.tenant);
