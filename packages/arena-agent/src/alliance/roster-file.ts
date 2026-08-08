/**
 * 联盟 no-fire 花名册文件契约（2026-08-08，alliance-no-fire-v1）。
 *
 * 执行面数据流闭环：
 *   supervisor 每收到租户 shadow frame（含受控实体 id 并集）→
 *   CentralAllianceShadowRuntime 聚合 allyEntityIds → 原子写
 *   <dataRoot>/runtime/alliance/roster.json；各租户进程周期性读取该文件 →
 *   注入 SafetyPlanner（AllianceRosterRef 可变引用）→ 敌方目标/威胁过滤
 *   （knownAllianceEntityId => never deliberate target，spec §5.5）。
 *
 * 设计约束：
 *   - 纯只读/降级：文件缺失/损坏 → 空集合（零回归，不阻断生产）；
 *   - 原子写（tmp + rename）：防租户读到半写 JSON（复用 f677406 模式）；
 *   - id-based：UNIT 视图不带 owner_username（真实 calibration 实证），
 *     因此 no-fire 以实体 id 为准（UNIT + CORE 都有 id），不依赖 username。
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AllianceSnapshot } from "./types.ts";

export const ALLIANCE_ROSTER_FILE = "roster.json";
export const ALLIANCE_ROSTER_SCHEMA = "alliance-roster-file-v1";

/** 联盟花名册文件 v1（磁盘契约）。 */
export interface AllianceRosterFileV1 {
  readonly schema: typeof ALLIANCE_ROSTER_SCHEMA;
  readonly revision: number;
  readonly updatedAtMs: number;
  readonly allyEntityIds: readonly string[];
}

/** SafetyPlanner 消费的联盟花名册可变引用（热刷新：supervisor 聚合帧更新后
 *  直接替换对象引用，World/巡逻/攻坚记忆不丢；decide 每 tick 读 current）。 */
export interface AllianceRosterRef {
  /** 联盟已知友军实体 id 全集（UNIT + CORE，跨租户并集）。 */
  allyEntityIds: ReadonlySet<string>;
}

export const EMPTY_ROSTER_REF: AllianceRosterRef = Object.freeze({ allyEntityIds: new Set<string>() });

/** 空友军 id 集合（SafetyPlanner 缺省引用：无 roster = 零回归）。 */
export const EMPTY_ROSTER_ID_SET: ReadonlySet<string> = new Set<string>();

/** 从聚合快照构建 roster 文件内容（纯函数；确定性排序）。 */
export function rosterFileOf(snapshot: AllianceSnapshot, nowMs: number): AllianceRosterFileV1 {
  return {
    schema: ALLIANCE_ROSTER_SCHEMA,
    revision: snapshot.revision,
    updatedAtMs: nowMs,
    allyEntityIds: [...snapshot.allyEntityIds].sort(),
  };
}

/** 解析 roster 文件内容；非法返回 null（降级为空集合）。 */
export function parseRosterFile(text: string): AllianceRosterFileV1 | null {
  try {
    const raw = JSON.parse(text) as Partial<AllianceRosterFileV1>;
    if (raw.schema !== ALLIANCE_ROSTER_SCHEMA) return null;
    if (!Array.isArray(raw.allyEntityIds)) return null;
    const ids = raw.allyEntityIds.filter((id): id is string => typeof id === "string" && id.length > 0);
    return {
      schema: ALLIANCE_ROSTER_SCHEMA,
      revision: Number.isSafeInteger(raw.revision) && (raw.revision as number) >= 0 ? (raw.revision as number) : 0,
      updatedAtMs: typeof raw.updatedAtMs === "number" && Number.isFinite(raw.updatedAtMs) ? raw.updatedAtMs : Date.now(),
      allyEntityIds: [...new Set(ids)].sort(),
    };
  } catch {
    return null;
  }
}

/** 联盟共享目录（<dataRoot>/runtime/alliance）。 */
export function allianceRuntimeDir(dataRoot: string): string {
  return join(dataRoot, "runtime", "alliance");
}

/** supervisor 侧：原子写 roster 文件（tmp + rename，防半写）。 */
export function writeAllianceRosterFile(dataRoot: string, file: AllianceRosterFileV1): void {
  const dir = allianceRuntimeDir(dataRoot);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, ALLIANCE_ROSTER_FILE);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file)}\n`, "utf8");
  renameSync(tmp, target);
}

/** 租户侧：读取最新 roster 文件；缺失/损坏返回 null（调用方降级空集合）。 */
export function loadAllianceRosterFile(dataRoot: string): AllianceRosterFileV1 | null {
  const target = join(allianceRuntimeDir(dataRoot), ALLIANCE_ROSTER_FILE);
  if (statSync(target, { throwIfNoEntry: false })?.isFile() !== true) return null;
  try {
    return parseRosterFile(readFileSync(target, "utf8"));
  } catch {
    return null;
  }
}
