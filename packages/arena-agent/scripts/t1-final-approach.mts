/**
 * t1 最后一程直迁（2026-08-08）：核心 (-605,-144) → 目标 (-600,-145)。
 * 背景：core-migrate-driver 绕障在障碍附近乱绕（RIGHT 被失败记忆排除 → LEFT 走偏）。
 * 本脚本不绕障：主轴直走（RIGHT 优先、y 差 DOWN 次之），目标格被 worker 占则让位，
 * 绝不选"远离目标"的方向；4 邻全被占则等待。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

const DATA_ROOT = process.env.ARENA_DATA_ROOT ?? resolve(import.meta.dirname, "../../../..");
const TARGET: [number, number] = [-600, -145];
const INTERVAL_MS = 3000;
const MAX_STEPS = 120;

function latestCasePath(): string | null {
  const base = join(DATA_ROOT, "runtime", "t1", "calibration");
  let best: string | null = null, bestTick = -1;
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

interface Live {
  tick: number;
  core: { id: string; position: [number, number]; state: string };
  obstacles: Set<string>;
  neighborUnits: Map<string, { id: string }[]>;
}

function readLive(): Live | null {
  const f = latestCasePath();
  if (!f) return null;
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    const objs = j.after.state.objects ?? [];
    const core = objs.find((o: any) => o.kind === "CORE" && o.controlled === true);
    if (!core?.id || !core.position) return null;
    const obstacles = new Set<string>();
    for (const o of objs) {
      if (o.kind === "OBSTACLE") for (const p of o.positions ?? []) obstacles.add(p.join(","));
    }
    const neighborUnits = new Map<string, { id: string }[]>();
    const [cx, cy] = core.position;
    for (const o of objs) {
      if (o.kind !== "UNIT" || !Array.isArray(o.position)) continue;
      const dx = o.position[0] - cx, dy = o.position[1] - cy;
      if (Math.abs(dx) + Math.abs(dy) !== 1) continue;
      const key = `${dx},${dy}`;
      const list = neighborUnits.get(key) ?? [];
      list.push({ id: String(o.id ?? "") });
      neighborUnits.set(key, list);
    }
    return { tick: Number(j.after.tick), core: { id: String(core.id), position: [core.position[0], core.position[1]], state: String(core.state ?? "NORMAL") }, obstacles, neighborUnits };
  } catch { return null; }
}

const log = (m: string): void => console.log(`${new Date().toISOString()} [t1-final] ${m}`);

for (let step = 0; step < MAX_STEPS; step += 1) {
  const live = readLive();
  if (!live) { log("calibration 不可读"); await new Promise((r) => setTimeout(r, INTERVAL_MS)); continue; }
  const [cx, cy] = live.core.position;
  const dx = TARGET[0] - cx, dy = TARGET[1] - cy;
  log(`step=${step} tick=${live.tick} core=(${cx},${cy}) dist=(${dx},${dy}) state=${live.core.state}`);
  if (Math.max(Math.abs(dx), Math.abs(dy)) <= 1) { log("到达目标区"); break; }
  if (live.core.state === "MOVING") { await new Promise((r) => setTimeout(r, INTERVAL_MS)); continue; }

  // 主轴：|dx| >= |dy| 先 RIGHT/LEFT，否则 DOWN/UP；只选"朝目标"方向
  const dirs: string[] = [];
  if (Math.abs(dx) >= Math.abs(dy)) { if (dx > 0) dirs.push("RIGHT"); if (dx < 0) dirs.push("LEFT"); if (dy > 0) dirs.push("DOWN"); if (dy < 0) dirs.push("UP"); }
  else { if (dy > 0) dirs.push("DOWN"); if (dy < 0) dirs.push("UP"); if (dx > 0) dirs.push("RIGHT"); if (dx < 0) dirs.push("LEFT"); }

  const delta: Record<string, [number, number]> = { RIGHT: [1, 0], LEFT: [-1, 0], DOWN: [0, 1], UP: [0, -1] };
  let chosen: string | null = null;
  let blockers: string[] = [];
  for (const d of dirs) {
    const [ddx, ddy] = delta[d];
    const nx = cx + ddx, ny = cy + ddy;
    if (live.obstacles.has(`${nx},${ny}`)) continue;
    blockers = (live.neighborUnits.get(`${ddx},${ddy}`) ?? []).map((u) => u.id);
    chosen = d;
    break;
  }
  if (chosen === null) { log("4 邻全堵/障碍，等待"); await new Promise((r) => setTimeout(r, INTERVAL_MS)); continue; }

  const now = new Date().toISOString();
  const path = join(DATA_ROOT, "runtime", "human-commands", "t1.json");
  const existing = existsSync(path) ? (() => { try { return JSON.parse(readFileSync(path, "utf8")) as { version?: number; mode?: string; goals?: unknown[] }; } catch { return {}; } })() : {};
  // 让位：动态选 worker 的"远离核心的空邻格"（1 格 MOVE；RIGHT/LEFT/DOWN/UP 相对
  // worker 位置）。2026-08-08 t1 RIGHT 格被 RANGER 占实证——硬编码让位方向可能撞障碍。
  const dirNames = ["RIGHT", "LEFT", "DOWN", "UP"];
  const dirD = { RIGHT: [1, 0], LEFT: [-1, 0], DOWN: [0, 1], UP: [0, -1] };
  const commands = blockers.map((uid, i) => {
    // 从 calibration 找 worker 位置
    const f2 = latestCasePath();
    let wpos: [number, number] | null = null;
    if (f2) {
      try {
        const j2 = JSON.parse(readFileSync(f2, "utf8"));
        const u = (j2.after.state.objects ?? []).find((o: any) => o.kind === "UNIT" && o.id === uid);
        if (u?.position) wpos = [u.position[0], u.position[1]];
      } catch {}
    }
    let mv = "RIGHT"; // 默认
    if (wpos) {
      // 4 邻按"远离核心"优先：优先 delta 同向（继续远离），再垂直
      const cands = [chosen, chosen === "RIGHT" || chosen === "LEFT" ? "DOWN" : "RIGHT", chosen === "RIGHT" || chosen === "LEFT" ? "UP" : "LEFT", chosen === "RIGHT" ? "LEFT" : "RIGHT"];
      for (const c of cands) {
        const [ddx, ddy] = dirD[c];
        const nx = wpos[0] + ddx, ny = wpos[1] + ddy;
        if (live.obstacles.has(`${nx},${ny}`)) continue;
        if (Math.abs(nx - cx) + Math.abs(ny - cy) <= 1) continue; // 不挪回核心邻格
        mv = c; break;
      }
    }
    return {
      id: `final-yield-${now}-${i}`,
      unitId: uid,
      action: { type: "MOVE", direction: mv },
      note: "t1-final 让位",
      createdAt: now,
    };
  });
  commands.push({ id: `final-core-${now}`, unitId: live.core.id, action: { type: "START_MOVE", direction: chosen }, note: "t1-final 直迁", createdAt: now });
  const store = { version: existing.version ?? 1, mode: existing.mode ?? "override", commands, goals: existing.goals ?? [], updatedAt: now };
  const tmp = path + `.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  renameSync(tmp, path);
  log(`START_MOVE ${chosen}${blockers.length ? ` +${blockers.length} 让位` : ""}`);
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}
log("t1-final 结束");
