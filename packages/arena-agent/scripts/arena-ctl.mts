/**
 * arena-ctl —— AI 指挥官接入层 CLI（command-plane v1，2026-08-08）。
 *
 * 让 Codex / Claude Code 用一条命令安全、可审计地操控 Arena 租户：
 *   arena-ctl status  <tenant>                     —— 实时状态快照（决策上下文）
 *   arena-ctl migrate <tenant> --target x,y [--phases x,y;x,y] [--force --reason ...]
 *                                                —— 核心分阶段迁移（护栏+审计）
 *   arena-ctl relocate <tenant> --target x,y [--units a,b]  —— worker 疏散
 *   arena-ctl mine     <tenant> --target x,y --units a,b    —— worker 部署矿带盯守（mine goals）
 *   arena-ctl cancel  <tenant> [--intent id]      —— 取消意图（仅该租户；--intent 精确移除单条；
 *                                                   杀 driver 按该租户 PID 白名单，不按命令行全机匹配）
 *   arena-ctl audit   <tenant> [--limit n]        —— 命令审计流水
 *   arena-ctl band    <tenant> [--center x,y] [--radius n]  —— 矿刷新频率矿带（迁核选点）
 *   arena-ctl mine-watch <tenant> [--max n]             —— 矿刷新预测（即将刷新格，部署 worker 用）
 *
 * 全部输出 JSON（AI 可解析）。护栏数据不可读 → fail-closed 拒绝。
 * 用法：cd packages/arena-agent && npx tsx scripts/arena-ctl.mts <cmd> ...
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, openSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGuardrails, type GuardrailContext } from "../src/command-plane/guardrails.ts";
import { appendAuditEvent, readAudit } from "../src/command-plane/audit.ts";
import { validateIntent, type Intent } from "../src/command-plane/protocol.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(HERE, "..");

/** 数据根解析（W31）：只接受显式 ARENA_DATA_ROOT，缺失/空白 → fail-fast 抛错，
 *  绝不静默回退到硬编码机器路径（换机器静默失效的根源）。 */
export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.ARENA_DATA_ROOT?.trim();
  if (!root) {
    throw new Error(
      "ARENA_DATA_ROOT 未设置：arena-ctl 拒绝隐式回退。请显式 export ARENA_DATA_ROOT=<data-root>（代码不得硬编码机器绝对路径）。",
    );
  }
  return root;
}
const DATA_ROOT = resolveDataRoot();

/* ---------- 数据读取 ---------- */

function surveyDb(tenant: string): DatabaseSync | null {
  const dbPath = join(DATA_ROOT, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(dbPath)) return null;
  try { return new DatabaseSync(dbPath, { readOnly: true }); } catch { return null; }
}

interface LiveSnapshot {
  readonly tick: number;
  readonly core: { id: string; position: [number, number]; state: string } | null;
  readonly units: readonly { id: string; type: string; position: [number, number]; hp: number; cargo: number | null }[];
  readonly obstacleCells: readonly string[];
}

function latestCasePath(tenant: string): string | null {
  const base = join(DATA_ROOT, "runtime", tenant, "calibration");
  if (!existsSync(base)) return null;
  let best: string | null = null;
  let bestTick = -1;
  for (const run of readdirSync(base, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    const casesDir = join(base, run.name, "cases");
    if (!existsSync(casesDir)) continue;
    for (const f of readdirSync(casesDir)) {
      const m = /^(\d+)\.json$/.exec(f);
      if (!m) continue;
      const t = Number(m[1]);
      if (t > bestTick) { bestTick = t; best = join(casesDir, f); }
    }
  }
  return best;
}

function readSnapshot(tenant: string): LiveSnapshot | null {
  const f = latestCasePath(tenant);
  if (f === null) return null;
  try {
    const j = JSON.parse(readFileSync(f, "utf-8")) as {
      after: { tick: number; state: { objects: Record<string, unknown>[] } };
    };
    const objs = j.after.state.objects ?? [];
    const coreObj = objs.find((o) => o.kind === "CORE" && o.controlled === true) as
      { id?: string; position?: [number, number]; state?: string } | undefined;
    const units = objs
      .filter((o) => o.kind === "UNIT")
      .map((o) => {
        const u = o as { id?: string; unit_type?: string; position?: [number, number]; hp?: number; cargo?: number | null };
        return {
          id: String(u.id ?? ""),
          type: String(u.unit_type ?? "?"),
          position: [u.position?.[0] ?? 0, u.position?.[1] ?? 0] as [number, number],
          hp: Number(u.hp ?? 0),
          cargo: u.cargo === null || u.cargo === undefined ? null : Number(u.cargo),
        };
      });
    const obstacleCells: string[] = [];
    for (const o of objs) {
      if (o.kind !== "OBSTACLE" || !Array.isArray(o.positions)) continue;
      for (const p of o.positions as [number, number][]) obstacleCells.push(`${p[0]},${p[1]}`);
    }
    return {
      tick: Number(j.after.tick),
      core: coreObj?.position
        ? { id: String(coreObj.id ?? ""), position: [coreObj.position[0], coreObj.position[1]], state: String(coreObj.state ?? "NORMAL") }
        : null,
      units,
      obstacleCells,
    };
  } catch {
    return null;
  }
}

function readEnemyCores(tenant: string): { x: number; y: number; lastSeenTick: number }[] {
  const db = surveyDb(tenant);
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT x, y, last_seen_tick AS lastSeenTick FROM core_hunts").all() as
      { x: number; y: number; lastSeenTick: number }[];
    db.close();
    return rows;
  } catch { try { db.close(); } catch {} return []; }
}

function readResources(tenant: string): { x: number; y: number; lastSeenTick: number }[] {
  const db = surveyDb(tenant);
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT x, y, last_seen_tick AS lastSeenTick FROM resources").all() as
      { x: number; y: number; lastSeenTick: number }[];
    db.close();
    return rows;
  } catch { try { db.close(); } catch {} return []; }
}

/** 矿刷新频率分析（resource_seen_history）：找高刷新矿带（迁核目标决策）。
 *  矿生命周期短（2-6 tick 消失）但同一格会反复刷新——resource_seen_history
 *  记录每次目击。刷新频率 = 目击次数 / 时间跨度，是"该区域矿源活度"的更好
 *  度量（比 last_seen 新鲜度更准，2026-08-08 t1/t3 全 stale 实证）。 */
function analyzeResourceBands(
  tenant: string,
  center: [number, number],
  radius: number,
  minSeen: number,
): Record<string, unknown> {
  const db = surveyDb(tenant);
  if (!db) return { ok: false, error: "survey 库不可读" };
  try {
    const hist = db.prepare(
      "SELECT cell, tick FROM resource_seen_history ORDER BY tick",
    ).all() as { cell: string; tick: number }[];
    db.close();
    if (hist.length === 0) return { ok: false, error: "resource_seen_history 空" };
    const byCell = new Map<string, number[]>();
    for (const h of hist) {
      const arr = byCell.get(h.cell) ?? [];
      arr.push(Number(h.tick));
      byCell.set(h.cell, arr);
    }
    const minTick = Math.min(...hist.map((h) => h.tick));
    const maxTick = Math.max(...hist.map((h) => h.tick));
    const span = Math.max(1, maxTick - minTick);
    const bands = new Map<string, { x: number; y: number; seen: number; freq: number; lastTick: number }>();
    for (const [cell, ticks] of byCell) {
      const [x, y] = cell.split(",").map(Number);
      if (Math.max(Math.abs(x - center[0]), Math.abs(y - center[1])) > radius) continue;
      const seen = ticks.length;
      if (seen < minSeen) continue;
      bands.set(cell, {
        x, y, seen,
        freq: Number((seen / span).toFixed(4)),
        lastTick: ticks[ticks.length - 1],
      });
    }
    const sorted = [...bands.values()].sort((a, b) => b.freq - a.freq || b.seen - a.seen);
    return {
      ok: true,
      tenant,
      center,
      radius,
      spanTicks: span,
      totalCells: byCell.size,
      bandCells: sorted.length,
      top: sorted.slice(0, 25),
    };
  } catch (e) {
    try { db.close(); } catch {}
    return { ok: false, error: String(e) };
  }
}

/** 矿刷新预测（mine-watch）：resource_seen_history → 每格出现窗口 → gap →
 *  预计下次刷新 tick + dueInTicks。AI 据此部署 worker 提前就位（视野无矿时的
 *  资源获取优化，2026-08-08 t2/t3/t4 视野 0 矿 harvest=0 实证）。 */
function analyzeMineWatch(tenant: string, maxCells: number): Record<string, unknown> {
  const db = surveyDb(tenant);
  if (!db) return { ok: false, error: "survey 库不可读" };
  try {
    const snap = readSnapshot(tenant);
    const currentTick = snap?.tick ?? 0;
    const corePos = snap?.core?.position ?? null;
    const hist = db.prepare(
      "SELECT cell, tick FROM resource_seen_history ORDER BY tick",
    ).all() as { cell: string; tick: number }[];
    if (hist.length === 0) return { ok: false, error: "resource_seen_history 空" };
    const GAP_TICKS = 5; // 同窗口容忍
    const byCell = new Map<string, number[]>();
    for (const h of hist) {
      const arr = byCell.get(h.cell) ?? [];
      arr.push(Number(h.tick));
      byCell.set(h.cell, arr);
    }
    const cells: Record<string, unknown>[] = [];
    for (const [cell, ticks] of byCell) {
      ticks.sort((a, b) => a - b);
      // 出现窗口：连续 tick 段
      const windows: [number, number][] = [];
      let start = ticks[0], end = ticks[0];
      for (const t of ticks.slice(1)) {
        if (t - end > GAP_TICKS) { windows.push([start, end]); start = t; }
        end = t;
      }
      windows.push([start, end]);
      if (windows.length < 2) continue; // 无刷新周期样本
      const gaps: number[] = [];
      for (let i = 1; i < windows.length; i += 1) gaps.push(windows[i][0] - windows[i - 1][0]);
      const avgGap = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
      const lastSeen = windows[windows.length - 1][1];
      const dueIn = avgGap - (currentTick - lastSeen);
      const [x, y] = cell.split(",").map(Number);
      const distCore = corePos ? Math.max(Math.abs(x - corePos[0]), Math.abs(y - corePos[1])) : null;
      cells.push({ cell, x, y, windows: windows.length, avgGapTicks: avgGap, lastSeenTick: lastSeen, dueInTicks: dueIn, distCore });
    }
    cells.sort((a, b) => (a.dueInTicks as number) - (b.dueInTicks as number));
    const upcoming = cells.filter((c) => (c.dueInTicks as number) > 0 && (c.dueInTicks as number) <= 300);
    const overdue = cells.filter((c) => (c.dueInTicks as number) <= 0);
    return {
      ok: true,
      tenant,
      currentTick,
      core: corePos,
      upcomingSoon: upcoming.slice(0, maxCells),
      overdueCandidates: overdue.slice(0, maxCells),
      totalCells: cells.length,
    };
  } catch (e) {
    try { db.close(); } catch {}
    return { ok: false, error: String(e) };
  }
}

function readActiveIntents(tenant: string): { activeCount: number; activeIntentIds: string[] } {
  const p = join(DATA_ROOT, "runtime", "human-commands", `${tenant}.json`);
  if (!existsSync(p)) return { activeCount: 0, activeIntentIds: [] };
  try {
    const j = JSON.parse(readFileSync(p, "utf-8")) as { commands?: unknown[]; goals?: unknown[] };
    const ids: string[] = [];
    for (const g of (j.goals ?? []) as { id?: string }[]) if (g?.id) ids.push(g.id);
    for (const c of (j.commands ?? []) as { id?: string }[]) if (c?.id) ids.push(c.id);
    return { activeCount: ids.length, activeIntentIds: ids };
  } catch { return { activeCount: 0, activeIntentIds: [] }; }
}

/* ---------- 子命令 ---------- */

function cmdStatus(tenant: string): void {
  const snap = readSnapshot(tenant);
  if (snap === null) {
    console.log(JSON.stringify({ ok: false, error: "calibration 不可读" }));
    return;
  }
  const enemies = readEnemyCores(tenant);
  const resources = readResources(tenant);
  const active = readActiveIntents(tenant);
  const byType: Record<string, number> = {};
  for (const u of snap.units) byType[u.type] = (byType[u.type] ?? 0) + 1;
  const coreNeighbors = snap.units.filter((u) => snap.core && Math.abs(u.position[0] - snap.core.position[0]) + Math.abs(u.position[1] - snap.core.position[1]) === 1);
  console.log(JSON.stringify({
    ok: true,
    tenant,
    tick: snap.tick,
    core: snap.core,
    units: { count: snap.units.length, byType },
    coreNeighborBlockers: coreNeighbors.map((u) => ({ id: u.id, type: u.type, position: u.position })),
    enemyCores: { total: enemies.length, recent: enemies.filter((e) => snap.tick - e.lastSeenTick <= 3000).length },
    resources: { total: resources.length },
    activeIntents: active,
  }, null, 2));
}

function parseTarget(s: string | undefined): [number, number] | null {
  if (!s) return null;
  const m = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(s);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

function parsePhases(s: string | undefined): [number, number][] | null {
  if (!s) return [];
  const out: [number, number][] = [];
  for (const part of s.split(";")) {
    const t = parseTarget(part);
    if (!t) return null;
    out.push(t);
  }
  return out;
}

function writeHumanStore(tenant: string, data: Record<string, unknown>): void {
  const dir = join(DATA_ROOT, "runtime", "human-commands");
  const finalPath = join(dir, `${tenant}.json`);
  // 原子写：临时文件 + rename——tenant 每 tick 读该文件，避免读到半写 JSON
  // （2026-08-08 t3 goals 偶发丢失：并发读写竞态）。
  const tmpPath = join(dir, `${tenant}.json.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, finalPath);
}

/** cancel 纯逻辑（W32）：intentId 缺省 → 全清；给定 → 精确移除该 command/goal（其余保留）。
 *  返回过滤后的新 store 与移除的 id 清单。 */
export function filterHumanStore(
  store: { version?: number; mode?: string; commands?: { id?: string }[]; goals?: { id?: string }[] },
  intentId: string | undefined,
): {
  next: { version: number; mode: string; commands: { id?: string }[]; goals: { id?: string }[]; updatedAt: string };
  removed: string[];
} {
  const removed: string[] = [];
  const commands = (store.commands ?? []).filter((c) => {
    if (intentId === undefined || c.id === intentId) { removed.push(c.id ?? "<no-id>"); return false; }
    return true;
  });
  const goals = (store.goals ?? []).filter((g) => {
    if (intentId === undefined || g.id === intentId) { removed.push(g.id ?? "<no-id>"); return false; }
    return true;
  });
  return {
    next: {
      version: store.version ?? 1,
      mode: store.mode ?? "override",
      commands,
      goals,
      updatedAt: new Date().toISOString(),
    },
    removed,
  };
}

/** cancel 文件清理（租户隔离）：只写 <data-root>/runtime/human-commands/<tenant>.json。
 *  intentId 缺省 → 清空该租户 store；给定 → 精确移除该 intent（其余保留）。 */
export function clearHumanStore(tenant: string, intentId?: string): { removed: string[] } {
  const dir = join(DATA_ROOT, "runtime", "human-commands");
  const finalPath = join(dir, `${tenant}.json`);
  const existing = existsSync(finalPath)
    ? (() => { try { return JSON.parse(readFileSync(finalPath, "utf-8")) as { version?: number; mode?: string; commands?: { id?: string }[]; goals?: { id?: string }[] }; } catch { return {}; } })()
    : {};
  const { next, removed } = filterHumanStore(existing, intentId);
  // 原子写：临时文件 + rename（与 writeHumanStore 同规约，避免租户读到半写 JSON）
  const tmpPath = join(dir, `${tenant}.json.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmpPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, finalPath);
  return { removed };
}

function cmdMigrate(tenant: string, target: [number, number], phases: [number, number][], force: boolean, reason: string | undefined, escort: boolean): void {
  const snap = readSnapshot(tenant);
  if (snap === null) {
    console.log(JSON.stringify({ ok: false, error: "calibration 不可读，fail-closed 拒绝" }));
    return;
  }
  const intent: Intent = {
    schemaVersion: 1,
    issuer: "codex",
    sessionId: process.env.ARENA_CTL_SESSION ?? "arena-ctl",
    intentId: `intent-${Date.now()}-${tenant}`,
    spec: {
      kind: "core_migrate",
      target,
      phases: phases.length > 0 ? [...phases, target] : [target],
    },
    constraints: {
      force,
      forceReason: reason,
      requireMilitaryEscort: escort,
      avoidEnemyWithin: 60,
    },
    ttlTicks: 1200,
    createdAt: new Date().toISOString(),
  };
  const errs = validateIntent(intent);
  if (errs.length > 0) {
    console.log(JSON.stringify({ ok: false, errors: errs }));
    return;
  }
  const ctx: GuardrailContext = {
    tenant,
    currentTick: snap.tick,
    enemyCores: readEnemyCores(tenant),
    resources: readResources(tenant),
    active: readActiveIntents(tenant),
  };
  const reasons = runGuardrails(intent, ctx);
  if (reasons.length > 0) {
    appendAuditEvent(DATA_ROOT, tenant, { tenant, issuer: intent.issuer, sessionId: intent.sessionId, intentId: intent.intentId, kind: intent.spec.kind, action: "rejected", reasons });
    console.log(JSON.stringify({ ok: false, accepted: false, intentId: intent.intentId, reasons }, null, 2));
    return;
  }

  // 护栏通过：启动 core-migrate-driver（直迁 + 让位 + 分阶段）
  const driver = join(AGENT_ROOT, "scripts", "core-migrate-driver.mts");
  const args = [
    "--import", "tsx", driver,
    `--tenant=${tenant}`,
    `--target-x=${target[0]}`, `--target-y=${target[1]}`,
    "--interval-ms=3000", "--max-steps=600", "--beacon-safe=60",
    "--force", "--no-survey-obstacles",
  ];
  if (escort) args.push("--escort");
  const logPath = join(DATA_ROOT, "runtime", tenant, `arena-ctl-migrate-${intent.intentId.slice(-8)}.log`);
  const log = openSync(logPath, "a");
  const child = spawn(process.execPath, args, { cwd: AGENT_ROOT, detached: true, stdio: ["ignore", log, log], windowsHide: true });
  child.unref();
  appendAuditEvent(DATA_ROOT, tenant, { tenant, issuer: intent.issuer, sessionId: intent.sessionId, intentId: intent.intentId, kind: intent.spec.kind, action: "accepted", evidence: { target, phases: intent.spec.phases, driverPid: child.pid } });
  console.log(JSON.stringify({ ok: true, accepted: true, intentId: intent.intentId, target, driverPid: child.pid, logPath }, null, 2));
}

function cmdRelocate(tenant: string, target: [number, number], unitIds: string[]): void {
  const snap = readSnapshot(tenant);
  if (snap === null) {
    console.log(JSON.stringify({ ok: false, error: "calibration 不可读" }));
    return;
  }
  const units = unitIds.length > 0
    ? snap.units.filter((u) => unitIds.includes(u.id))
    : snap.units.filter((u) => u.type === "WORKER" && snap.core && Math.abs(u.position[0] - snap.core.position[0]) + Math.abs(u.position[1] - snap.core.position[1]) <= 2);
  if (units.length === 0) {
    console.log(JSON.stringify({ ok: false, error: "没有可疏散单位" }));
    return;
  }
  const goals = units.map((u) => ({
    id: `goal-${Date.now()}-${u.id.slice(0, 8)}`,
    unitId: u.id,
    kind: "goto" as const,
    target: [target[0] + Math.floor(Math.random() * 3) - 1, target[1] + Math.floor(Math.random() * 3) - 1] as [number, number],
    note: "arena-ctl relocate（AI 指挥疏散）",
    createdAt: new Date().toISOString(),
  }));
  const existing = existsSync(join(DATA_ROOT, "runtime", "human-commands", `${tenant}.json`))
    ? (() => { try { return JSON.parse(readFileSync(join(DATA_ROOT, "runtime", "human-commands", `${tenant}.json`), "utf-8")) as { version?: number; mode?: string; goals?: { unitId?: string; kind?: string; target?: [number, number] }[] }; } catch { return {}; } })()
    : {};
  // 幂等：目标 worker 的旧 goals 先移除（同 worker 重复部署 = 刷新盯守，不堆积）
  const oldGoals = (existing.goals ?? []).filter(
    (g) => !(g.unitId && goals.some((ng) => ng.unitId === g.unitId)),
  );
  writeHumanStore(tenant, {
    version: existing.version ?? 1,
    mode: existing.mode ?? "override",
    commands: [],
    goals: [...oldGoals, ...goals],
    updatedAt: new Date().toISOString(),
  });
  appendAuditEvent(DATA_ROOT, tenant, { tenant, issuer: "codex", sessionId: "arena-ctl", intentId: `intent-${Date.now()}-relocate`, kind: "worker_relocate", action: "accepted", evidence: { unitIds: units.map((u) => u.id), target } });
  console.log(JSON.stringify({ ok: true, accepted: true, relocated: units.map((u) => u.id), target }, null, 2));
}

function cmdMine(tenant: string, target: [number, number], unitIds: string[], hold: boolean): void {
  const snap = readSnapshot(tenant);
  if (snap === null) {
    console.log(JSON.stringify({ ok: false, error: "calibration 不可读" }));
    return;
  }
  const units = snap.units.filter((u) => u.type === "WORKER" && unitIds.includes(u.id));
  if (units.length === 0) {
    console.log(JSON.stringify({ ok: false, error: "指定 worker 不存在（需 WORKER 类型）" }));
    return;
  }
  const goals = units.map((u) => ({
    id: `goal-${Date.now()}-${u.id.slice(0, 8)}`,
    unitId: u.id,
    kind: (hold ? "mine_hold" : "mine") as "mine" | "mine_hold",
    target: [target[0], target[1]] as [number, number],
    note: hold ? "arena-ctl mine-hold（AI 矿带盯守）" : "arena-ctl mine（AI 部署矿带盯守）",
    createdAt: new Date().toISOString(),
  }));
  const existing = existsSync(join(DATA_ROOT, "runtime", "human-commands", `${tenant}.json`))
    ? (() => { try { return JSON.parse(readFileSync(join(DATA_ROOT, "runtime", "human-commands", `${tenant}.json`), "utf-8")) as { version?: number; mode?: string; goals?: { unitId?: string; kind?: string; target?: [number, number] }[] }; } catch { return {}; } })()
    : {};
  // 幂等：目标 worker 的旧 goals 先移除（同 worker 重复部署 = 刷新盯守，不堆积）
  const oldGoals = (existing.goals ?? []).filter(
    (g) => !(g.unitId && goals.some((ng) => ng.unitId === g.unitId)),
  );
  writeHumanStore(tenant, {
    version: existing.version ?? 1,
    mode: existing.mode ?? "override",
    commands: [],
    goals: [...oldGoals, ...goals],
    updatedAt: new Date().toISOString(),
  });
  appendAuditEvent(DATA_ROOT, tenant, { tenant, issuer: "codex", sessionId: "arena-ctl", intentId: `intent-${Date.now()}-mine`, kind: "worker_mine", action: "accepted", evidence: { unitIds: units.map((u) => u.id), target } });
  console.log(JSON.stringify({ ok: true, accepted: true, deployed: units.map((u) => u.id), target }, null, 2));
}

interface DriverPidRecord {
  readonly pid: number;
  readonly startedAt: string;
  readonly file: string;
}

/** driver 进程登记目录（core-migrate-driver 启动时写 runtime/drivers/<tenant>.<pid>.json）。 */
function driverPidDir(dataRoot: string): string {
  return join(dataRoot, "runtime", "drivers");
}

/** 枚举某租户的 driver PID 白名单：只认 <tenant>.<数字>.json 登记文件（跨租户/非法文件一律排除）。 */
export function listTenantDriverPids(dataRoot: string, tenant: string): DriverPidRecord[] {
  const dir = driverPidDir(dataRoot);
  if (!existsSync(dir)) return [];
  const out: DriverPidRecord[] = [];
  for (const f of readdirSync(dir)) {
    const m = /^([^.]+)\.(\d+)\.json$/.exec(f);
    if (!m || m[1] !== tenant) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf-8")) as { pid?: unknown; startedAt?: unknown };
      if (typeof j.pid === "number" && Number.isInteger(j.pid) && j.pid > 0) {
        out.push({ pid: j.pid, startedAt: typeof j.startedAt === "string" ? j.startedAt : "", file: join(dir, f) });
      }
    } catch { /* 坏登记文件跳过 */ }
  }
  return out;
}

/** 杀单个白名单 PID：先核对"该 PID 的进程仍是 core-migrate-driver"再杀（pid 复用保护），
 *  进程不存在/不匹配 → 跳过。绝不自杀。 */
function killOneDriverPid(pid: number): boolean {
  if (pid === process.pid) return false;
  if (process.platform === "win32") {
    const ps = [
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
      `if ($p -and $p.CommandLine -like '*core-migrate-driver*') { Stop-Process -Id ${pid} -Force -ErrorAction Stop; exit 0 }`,
      "exit 2",
    ].join("; ");
    try {
      execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: "utf-8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      return true;
    } catch {
      return false;
    }
  }
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    if (!cmdline.includes("core-migrate-driver")) return false;
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** 按租户 PID 白名单杀 driver（W32）：只处理本租户登记的 PID，逐个核对后杀；
 *  不做全机命令行匹配——绝不碰其他租户/无关进程。处理完删除登记文件（防陈旧堆积）。 */
export function killTenantDrivers(dataRoot: string, tenant: string): { killed: number[]; skipped: number[] } {
  const killed: number[] = [];
  const skipped: number[] = [];
  for (const rec of listTenantDriverPids(dataRoot, tenant)) {
    if (killOneDriverPid(rec.pid)) killed.push(rec.pid);
    else skipped.push(rec.pid);
    try { rmSync(rec.file, { force: true }); } catch { /* 清理失败不阻塞 */ }
  }
  return { killed, skipped };
}

/** cancel：租户隔离取消——只清该租户 human-commands（--intent 精确移除单条，其余保留），
 *  并按该租户 PID 白名单杀残留 driver。 */
export function cmdCancel(tenant: string, intentId: string | undefined): void {
  const { removed } = clearHumanStore(tenant, intentId);
  const kill = killTenantDrivers(DATA_ROOT, tenant);
  appendAuditEvent(DATA_ROOT, tenant, { tenant, issuer: "codex", sessionId: "arena-ctl", intentId: intentId ?? "all", kind: "cancel", action: "cancelled", evidence: { removed, killed: kill.killed, skipped: kill.skipped } });
  console.log(JSON.stringify({ ok: true, cancelled: true, tenant, intentId: intentId ?? "all", removed, ...kill }, null, 2));
}

function cmdAudit(tenant: string, limit: number): void {
  console.log(JSON.stringify(readAudit(DATA_ROOT, tenant, limit), null, 2));
}

/* ---------- 入口 ---------- */

async function main(): Promise<void> {
  const [cmd, tenant, ...rest] = process.argv.slice(2);
  if (!cmd || !tenant) {
    console.log(JSON.stringify({ ok: false, usage: "arena-ctl <status|migrate|relocate|cancel|audit> <tenant> [args]" }));
    return;
  }
  switch (cmd) {
    case "status": cmdStatus(tenant); break;
    case "migrate": {
      const t = parseTarget(getArg(rest, "--target"));
      if (!t) { console.log(JSON.stringify({ ok: false, error: "--target x,y 必填" })); break; }
      const phases = parsePhases(getArg(rest, "--phases"));
      if (phases === null) { console.log(JSON.stringify({ ok: false, error: "--phases 格式 x,y;x,y" })); break; }
      const force = rest.includes("--force");
      const reason = getArg(rest, "--reason");
      const escort = rest.includes("--escort");
      cmdMigrate(tenant, t, phases, force, reason, escort);
      break;
    }
    case "relocate": {
      const t = parseTarget(getArg(rest, "--target"));
      if (!t) { console.log(JSON.stringify({ ok: false, error: "--target x,y 必填" })); break; }
      const units = (getArg(rest, "--units") ?? "").split(",").filter(Boolean);
      cmdRelocate(tenant, t, units);
      break;
    }
    case "mine": {
      const t = parseTarget(getArg(rest, "--target"));
      if (!t) { console.log(JSON.stringify({ ok: false, error: "--target x,y 必填" })); break; }
      const units = (getArg(rest, "--units") ?? "").split(",").filter(Boolean);
      if (units.length === 0) { console.log(JSON.stringify({ ok: false, error: "--units 单位ID必填" })); break; }
      cmdMine(tenant, t, units, rest.includes("--hold"));
      break;
    }
    case "cancel": cmdCancel(tenant, getArg(rest, "--intent")); break;
    case "mine-watch": {
      const maxCells = Number(getArg(rest, "--max") ?? 15);
      console.log(JSON.stringify(analyzeMineWatch(tenant, maxCells), null, 2));
      break;
    }
    case "band": {
      const center = parseTarget(getArg(rest, "--center")) ?? [0, 0];
      const radius = Number(getArg(rest, "--radius") ?? 150);
      const minSeen = Number(getArg(rest, "--min-seen") ?? 5);
      console.log(JSON.stringify(analyzeResourceBands(tenant, center, radius, minSeen), null, 2));
      break;
    }
    case "audit": cmdAudit(tenant, Number(getArg(rest, "--limit") ?? 50)); break;
    default: console.log(JSON.stringify({ ok: false, error: `未知命令 ${cmd}` }));
  }
}

function getArg(args: string[], key: string): string | undefined {
  const i = args.indexOf(key);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

// 仅作为脚本直接执行时跑 CLI；被测试 import 时不触发（W31/W32 纯函数可测性）。
const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) void main();
