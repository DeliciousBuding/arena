/**
 * Command Center 数据访问工具层：路径/常量、JSONL 尾读、calibration
 * run-case 枚举、几何工具。所有 lib 模块从这里取共享基础。
 * 运行时 Node 24（type stripping 直接执行），类型检查走 tsc --noEmit。
 */
import { existsSync, readFileSync, readdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
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

/** 读 JSONL 文件尾部最多 maxLines 行（容错坏行）。
 *  性能：seek 只读尾部块（maxLines×1KB，下限 64KB、上限 2MB），不再全量读
 *  outcome.jsonl（4 租户合计 ~14MB/次 → 面板 overview/stream 由 20s+ 降至毫秒级）。
 *  截断起点落在行中间时丢弃首段残行；文件小于块大小时退化为全量读（等价旧行为）。 */
export function readJsonlTail(filePath: string, maxLines: number): Record<string, unknown>[] {
  if (!existsSync(filePath)) return [];
  const size = statSync(filePath).size;
  const want = Math.max(64 * 1024, Math.min(2 * 1024 * 1024, maxLines * 1024));
  const start = Math.max(0, size - want);
  let text: string;
  if (start === 0) {
    text = readFileSync(filePath, "utf8");
  } else {
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(size - start);
      let off = 0;
      while (off < buf.length) {
        const n = readSync(fd, buf, off, buf.length - off, start + off);
        if (n <= 0) break;
        off += n;
      }
      text = buf.toString("utf8");
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1); // 去掉截断产生的首段残行
    } finally {
      closeSync(fd);
    }
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows: Record<string, unknown>[] = [];
  for (const line of lines.slice(-maxLines)) {
    try { rows.push(JSON.parse(line) as Record<string, unknown>); } catch { /* 跳过坏行 */ }
  }
  return rows;
}

/** 最近一个有 calibration cases 的 run 目录名：按 run 内最高 case tick 选
 *  （UUID 字典序 ≠ 时间序——旧 bug：新 run 80d2d3d6 排在旧 run fffa09fa 前，
 *  面板恒显示旧 run 的 stale tick，即"界面卡住显示旧数据"根因）。
 *  1.5s TTL 记忆化（2026-08-08 结构性优化）：run 身份只在 agent 重启/新 run 时变，
 *  每次调用全量扫描所有 run 的 case 目录名（map cache 签名 ~100ms/次 × 多端点）
 *  是纯浪费；1.5s 内新 run 的探测延迟对 3s+ poll 无感，语义不变。 */
const latestRunCache = new Map<string, { at: number; dir: string | null }>();
const LATEST_RUN_TTL_MS = 1500;
export function latestRunDir(tenant: string): string | null {
  const now = Date.now();
  const hit = latestRunCache.get(tenant);
  if (hit && now - hit.at < LATEST_RUN_TTL_MS) return hit.dir;
  const dir = latestRunDirInner(tenant);
  latestRunCache.set(tenant, { at: now, dir });
  return dir;
}
function latestRunDirInner(tenant: string): string | null {
  const base = calibrationDir(tenant);
  if (!existsSync(base)) return null;
  // 2026-08-08 性能：原实现全扫所有 run 的 cases 目录找最高 tick（O(runs×files)，
  // /api/map 重建时 4 租户 × 每次 TTL 过期 ~200ms 同步阻塞）。改为 stat 各 run
  // 目录 mtime 选候选（case 写入会更新目录 mtime，agent 只写最新 run，mtime 最新
  // 即最新 run），从最新候选开始验证 cases 非空——O(runs stat + 1 readdir)。
  const runs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, mtime: statSync(join(base, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const r of runs) {
    const casesDir = join(base, r.name, "cases");
    if (existsSync(casesDir) && readdirSync(casesDir).length > 0) return r.name;
  }
  return null;
}

/** listCases 1.5s TTL 记忆化（2026-08-08 地图性能）：/api/map 重建时签名计算 +
 *  inner + trails 多次 readdir 同一目录（4 租户 × 数次 = 数十次 readdir，实测
 *  目录枚举 ~214ms）。case 文件只增不改，1.5s 内新 case 延迟对 3s poll 无感，
 *  语义不变（与 latestRunDir 同 TTL）。 */
const listCasesCache = new Map<string, { at: number; files: string[] }>();
const LIST_CASES_TTL_MS = 1500;
export function listCases(tenant: string, runDir: string): string[] {
  const key = `${tenant}/${runDir}`;
  const now = Date.now();
  const hit = listCasesCache.get(key);
  if (hit && now - hit.at < LIST_CASES_TTL_MS) return hit.files;
  const casesDir = join(calibrationDir(tenant), runDir, "cases");
  if (!existsSync(casesDir)) return [];
  const files = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
  listCasesCache.set(key, { at: now, files });
  return files;
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
