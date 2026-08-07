/**
 * 人类最高控制权：指挥指令存储。数据层（tenant 主循环提交前合并）：
 * 读/写/对账/卡死跳出。只允许本模块写
 * data/runtime/human-commands/<tenant>.json（原子替换）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, calibrationDir, latestRunDir, listCases, parseTick, readJsonlTail, telemetryDir } from "./fs-jsonl.ts";

export interface HumanCommand {
  id: string;
  unitId: string;
  action: Record<string, unknown>;
  note?: string;
  createdAt: string;
}
export interface HumanGoal {
  id: string;
  unitId: string;
  kind: "mine" | "goto";
  target: [number, number];
  note?: string;
  createdAt: string;
}
export interface HumanStore {
  version: number;
  mode: "override" | "disabled";
  commands: HumanCommand[];
  goals: HumanGoal[];
  updatedAt: string | null;
  tenant?: string;
}
interface StuckEntry { unitId: string; kind: string; target: number[]; reason: string; at: string }

const humanCommandsDir = (): string => join(DATA_ROOT, "runtime", "human-commands");
const EMPTY_STORE: Omit<HumanStore, "tenant"> = { version: 1, mode: "override", commands: [], goals: [], updatedAt: null };
export function readHumanStore(tenant: string): HumanStore {
  const file = join(humanCommandsDir(), `${tenant}.json`);
  if (!existsSync(file)) return { ...EMPTY_STORE, tenant };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      version: Number(raw.version ?? 1),
      mode: raw.mode === "disabled" ? "disabled" : "override",
      commands: Array.isArray(raw.commands) ? raw.commands as HumanCommand[] : [],
      goals: Array.isArray(raw.goals) ? raw.goals as HumanGoal[] : [],
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
      tenant,
    };
  } catch {
    return { ...EMPTY_STORE, tenant };
  }
}
export function writeHumanStore(tenant: string, store: HumanStore): Omit<HumanStore, "tenant"> {
  const dir = humanCommandsDir();
  mkdirSync(dir, { recursive: true });
  const out: Omit<HumanStore, "tenant"> = { version: 1, mode: store.mode, commands: store.commands, goals: store.goals, updatedAt: new Date().toISOString() };
  const file = join(dir, `${tenant}.json`);
  const tmp = join(dir, `${tenant}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(out, null, 2));
  renameSync(tmp, file); // 原子替换：中途崩溃不会留半截坏 JSON（readHumanStore 已有 try/catch 兜底）
  return out;
}
/** 从 outcome.jsonl 读取最新一条 humanOverride 遥测（applied/rejected/satisfied）。
 *  只取最后一行（最新 tick）：指令清空后新 outcome 无 humanOverride → null（避免 stale 拒绝状态常驻）。 */
export function latestHumanOverride(tenant: string): Record<string, unknown> | null {
  const file = join(telemetryDir(tenant), "outcome.jsonl");
  if (!existsSync(file)) return null;
  const rows = readJsonlTail(file, 4);
  const last = rows[rows.length - 1] ?? null;
  if (!last || !last.humanOverride) return null;
  const h = last.humanOverride as Record<string, unknown>;
  const applied = (h.applied as unknown[] | undefined) ?? [];
  const rejected = (h.rejected as unknown[] | undefined) ?? [];
  const satisfied = (h.satisfied as unknown[] | undefined) ?? [];
  if (!h.active && applied.length === 0 && rejected.length === 0 && satisfied.length === 0) return null;
  return { tick: last.tick ?? null, ...h };
}

/** 卡死跳出：活跃 goal 若单位连续 STUCK_TICKS tick 只 WAIT（路径被堵/目标不可达），
 *  自动取消并回报——防止"人类指令死锁"永远挂着。WAIT = 无推进；MOVE/HARVEST/DEPOSIT 都算在动。 */
const STUCK_TICKS = 8;
const stuckRing = new Map<string, StuckEntry[]>(); // tenant -> 最近卡死记录
function cancelStuckGoals(tenant: string, store: HumanStore, h: Record<string, unknown>): { store: HumanStore; stuck: StuckEntry[] } {
  const applied = new Set((h.applied as string[] | undefined) ?? []);
  const activeGoals = store.goals.filter((g) => applied.has(g.unitId));
  if (activeGoals.length === 0) return { store, stuck: [] };
  const runDir = latestRunDir(tenant);
  if (runDir === null) return { store, stuck: [] };
  const cases = listCases(tenant, runDir);
  if (cases.length < STUCK_TICKS) return { store, stuck: [] };
  const stuck: StuckEntry[] = [];
  for (const g of activeGoals) {
    let waitCount = 0;
    for (let i = 0; i < STUCK_TICKS; i++) {
      const f2 = cases[cases.length - 1 - i];
      const p2 = join(calibrationDir(tenant), runDir, "cases", f2);
      try {
        const raw = JSON.parse(readFileSync(p2, "utf8")) as { plan?: { unitActions?: Record<string, { type?: string }> } };
        const act = raw?.plan?.unitActions?.[g.unitId];
        if (!act) continue;
        if (act.type === "WAIT") waitCount++;
        else if (act.type === "MOVE" || act.type === "HARVEST" || act.type === "DEPOSIT") { waitCount = 0; break; }
      } catch { /* 跳过坏文件 */ }
    }
    if (waitCount >= STUCK_TICKS - 1) {
      const reason = `连续 ${waitCount} tick 无推进（路径被堵/目标不可达），已自动取消`;
      stuck.push({ unitId: g.unitId, kind: g.kind, target: [...g.target], reason, at: new Date().toISOString() });
      store.goals = store.goals.filter((x) => x.id !== g.id);
      console.log(`[human-goal] ${tenant} 卡死跳出 ${g.unitId} ${g.kind} [${g.target[0]}, ${g.target[1]}] → ${reason}`);
    }
  }
  return { store, stuck };
}

/** 人类指令闭环自愈：agent 只消费 store 不写回——satisfied 的 goal、
 *  applied 的一键 command、unknown_unit（单位已销毁）的指令会永久残留（实测 t4 陈旧 goal
 *  挂了 8 小时）。本函数在 /api/commands 读取时按最新遥测行对账清理（server 是 store 唯一写者）。
 *  语义：satisfied → goal 完成交还 agent；applied → 一键动作已生效（单 tick 覆盖）；
 *       rejected(unknown_unit) → 单位已不存在，指令作废。
 *  时序守卫：仅清理 createdAt ≤ 遥测 updatedAt 的指令（避免误删刚下发、尚未执行的同单位新指令）。 */
export function reconcileHumanStore(tenant: string): HumanStore {
  const store = readHumanStore(tenant);
  if (store.commands.length === 0 && store.goals.length === 0) return store;
  const h = latestHumanOverride(tenant);
  if (!h) return store;
  const processedAt = typeof h.updatedAt === "string" ? h.updatedAt : null; // agent 处理 store 时回显的 updatedAt
  const within = (createdAt: unknown): boolean => processedAt === null || (typeof createdAt === "string" && createdAt <= processedAt);
  const satisfied = new Set((h.satisfied as string[] | undefined) ?? []);
  const applied = new Set((h.applied as string[] | undefined) ?? []);
  const unknown = new Set(((h.rejected as Array<{ unitId: string; reason?: string }> | undefined) ?? [])
    .filter((r) => r && r.reason === "unknown_unit").map((r) => r.unitId));
  if (satisfied.size === 0 && applied.size === 0 && unknown.size === 0) return store;
  const g0 = store.goals.length, c0 = store.commands.length;
  if (satisfied.size) store.goals = store.goals.filter((g) => !(satisfied.has(g.unitId) && within(g.createdAt)));
  if (applied.size) store.commands = store.commands.filter((c) => !(applied.has(c.unitId) && within(c.createdAt)));
  if (unknown.size) {
    store.goals = store.goals.filter((g) => !(unknown.has(g.unitId) && within(g.createdAt)));
    store.commands = store.commands.filter((c) => !(unknown.has(c.unitId) && within(c.createdAt)));
  }
  const { store: s2, stuck } = cancelStuckGoals(tenant, store, h);
  if (s2.goals.length !== g0 || s2.commands.length !== c0) writeHumanStore(tenant, s2);
  if (stuck.length) {
    const ring = stuckRing.get(tenant) ?? [];
    stuckRing.set(tenant, [...ring, ...stuck].slice(-6));
  }
  return s2;
}

/** 卡死跳出记录（供 /api/commands 透出给前端展示）。 */
export function stuckRecord(tenant: string): StuckEntry[] {
  return stuckRing.get(tenant) ?? [];
}
