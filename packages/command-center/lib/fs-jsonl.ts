/**
 * Command Center 数据访问工具层：路径/常量、JSONL 尾读、calibration
 * run-case 枚举、几何工具。所有 lib 模块从这里取共享基础。
 * 运行时 Node 24（type stripping 直接执行），类型检查走 tsc --noEmit。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 共享数据根：仅通过 ARENA_DATA_ROOT 解析；缺省 = 协调根 data/。
 *  注意：缺省路径按 main 工作树层级（command-center/lib 向上 4 级到仓库根）；
 *  start-cc.mjs 启动时会显式注入 ARENA_DATA_ROOT（worktree 下也正确）。 */
export const DATA_ROOT: string = resolve(process.env.ARENA_DATA_ROOT ?? join(HERE, "..", "..", "..", "..", "data"));

export const TENANTS = ["t1", "t2", "t3", "t4"] as const;
export type Tenant = (typeof TENANTS)[number];

export type Position = readonly [number, number];

export const runtimeDir = (tenant: string): string => join(DATA_ROOT, "runtime", tenant);
export const calibrationDir = (tenant: string): string => join(runtimeDir(tenant), "calibration");
export const telemetryDir = (tenant: string): string => join(runtimeDir(tenant), "telemetry");

/** 读 JSONL 文件尾部最多 maxLines 行（容错坏行）。 */
export function readJsonlTail(filePath: string, maxLines: number): Record<string, unknown>[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows: Record<string, unknown>[] = [];
  for (const line of lines.slice(-maxLines)) {
    try { rows.push(JSON.parse(line) as Record<string, unknown>); } catch { /* 跳过坏行 */ }
  }
  return rows;
}

/** 最近一个有 calibration cases 的 run 目录名：按 run 内最高 case tick 选
 *  （UUID 字典序 ≠ 时间序——旧 bug：新 run 80d2d3d6 排在旧 run fffa09fa 前，
 *  面板恒显示旧 run 的 stale tick，即"界面卡住显示旧数据"根因）。 */
export function latestRunDir(tenant: string): string | null {
  const base = calibrationDir(tenant);
  if (!existsSync(base)) return null;
  const runs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  let best: string | null = null;
  let bestTick = -1;
  for (const name of runs) {
    const casesDir = join(base, name, "cases");
    if (!existsSync(casesDir)) continue;
    let maxTick = -1;
    for (const f of readdirSync(casesDir)) {
      const tick = parseTick(f);
      if (tick > maxTick) maxTick = tick;
    }
    if (maxTick > bestTick) {
      bestTick = maxTick;
      best = name;
    }
  }
  return best;
}

export function listCases(tenant: string, runDir: string): string[] {
  const casesDir = join(calibrationDir(tenant), runDir, "cases");
  if (!existsSync(casesDir)) return [];
  return readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
}

export function parseTick(fileName: string): number {
  const match = fileName.match(/^(\d+)/);
  return match ? Number(match[1]) : 0;
}

export const cellKey = (x: number, y: number): string => `${x},${y}`;

/** 按 run 内最高 case tick 降序排列的 run 列表（跨 run 扫描用）。 */
export function runsByMaxTick(tenant: string): Array<{ run: string; maxTick: number }> {
  const base = calibrationDir(tenant);
  if (!existsSync(base)) return [];
  const names = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
  const out: Array<{ run: string; maxTick: number }> = [];
  for (const name of names) {
    const casesDir = join(base, name, "cases");
    if (!existsSync(casesDir)) continue;
    let maxTick = -1;
    for (const f of readdirSync(casesDir)) { const t = parseTick(f); if (t > maxTick) maxTick = t; }
    if (maxTick >= 0) out.push({ run: name, maxTick });
  }
  out.sort((a, b) => b.maxTick - a.maxTick);
  return out;
}

export const manhattan = (a: Position, b: Position): number => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
export const chebyshev = (a: Position, b: Position): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
