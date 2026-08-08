/**
 * arena-ctl —— AI 指挥官接入层 CLI（command-plane v1，2026-08-08）。
 *
 * 让 Codex / Claude Code 用一条命令安全、可审计地操控 Arena 租户：
 *   arena-ctl status  <tenant>                     —— 实时状态快照（决策上下文）
 *   arena-ctl migrate <tenant> --target x,y [--phases x,y;x,y] [--force --reason ...]
 *                                                —— 核心分阶段迁移（护栏+审计）
 *   arena-ctl relocate <tenant> --target x,y [--units a,b]  —— worker 疏散
 *   arena-ctl cancel  <tenant> [--intent id]      —— 取消意图，交还 agent
 *   arena-ctl audit   <tenant> [--limit n]        —— 命令审计流水
 *
 * 全部输出 JSON（AI 可解析）。护栏数据不可读 → fail-closed 拒绝。
 * 用法：cd packages/arena-agent && npx tsx scripts/arena-ctl.mts <cmd> ...
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runGuardrails, type GuardrailContext } from "../src/command-plane/guardrails.ts";
import { appendAuditEvent, readAudit } from "../src/command-plane/audit.ts";
import { validateIntent, type Intent } from "../src/command-plane/protocol.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(HERE, "..");
const DATA_ROOT = process.env.ARENA_DATA_ROOT ?? "D:/Code/Projects/arena/data";

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
    const rows = db.prepare("SELECT x, y, last_seen_tick FROM core_hunts").all() as
      { x: number; y: number; last_seen_tick: number }[];
    db.close();
    return rows;
  } catch { try { db.close(); } catch {} return []; }
}

function readResources(tenant: string): { x: number; y: number; lastSeenTick: number }[] {
  const db = surveyDb(tenant);
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT x, y, last_seen_tick FROM resources").all() as
      { x: number; y: number; last_seen_tick: number }[];
    db.close();
    return rows;
  } catch { try { db.close(); } catch {} return []; }
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
  writeFileSync(join(dir, `${tenant}.json`), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function clearHumanStore(tenant: string): void {
  writeHumanStore(tenant, {
    version: 1,
    mode: "override",
    commands: [],
    goals: [],
    updatedAt: new Date().toISOString(),
  });
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
    ? (() => { try { return JSON.parse(readFileSync(join(DATA_ROOT, "runtime", "human-commands", `${tenant}.json`), "utf-8")) as { version?: number; mode?: string; goals?: unknown[] }; } catch { return {}; } })()
    : {};
  writeHumanStore(tenant, {
    version: existing.version ?? 1,
    mode: existing.mode ?? "override",
    commands: [],
    goals: [...(existing.goals ?? []), ...goals],
    updatedAt: new Date().toISOString(),
  });
  appendAuditEvent(DATA_ROOT, tenant, { tenant, issuer: "codex", sessionId: "arena-ctl", intentId: `intent-${Date.now()}-relocate`, kind: "worker_relocate", action: "accepted", evidence: { unitIds: units.map((u) => u.id), target } });
  console.log(JSON.stringify({ ok: true, accepted: true, relocated: units.map((u) => u.id), target }, null, 2));
}

function cmdCancel(tenant: string, intentId: string | undefined): void {
  clearHumanStore(tenant);
  // 杀残留 migrate driver
  try {
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*core-migrate-driver*' } | ForEach-Object { Stop-Process -Id $($_.ProcessId) -Force -ErrorAction SilentlyContinue }"`, { encoding: "utf-8", windowsHide: true });
  } catch { /* 无残留 */ }
  appendAuditEvent(DATA_ROOT, tenant, { tenant, issuer: "codex", sessionId: "arena-ctl", intentId: intentId ?? "unknown", kind: "cancel", action: "cancelled" });
  console.log(JSON.stringify({ ok: true, cancelled: true, tenant, intentId: intentId ?? "all" }, null, 2));
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
    case "cancel": cmdCancel(tenant, getArg(rest, "--intent")); break;
    case "audit": cmdAudit(tenant, Number(getArg(rest, "--limit") ?? 50)); break;
    default: console.log(JSON.stringify({ ok: false, error: `未知命令 ${cmd}` }));
  }
}

function getArg(args: string[], key: string): string | undefined {
  const i = args.indexOf(key);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

void main();
