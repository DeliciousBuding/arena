/**
 * 迁移计划文件 IO（migration-system-v1 §6.1）。
 *
 * 单 writer 纪律：conductor 是唯一 writer（原子替换 tmp+rename）；runtime
 * 只读。损坏/缺失一律 fail-closed（返回 malformed/missing，不部分采纳）。
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { parseMigrationPlan, type MigrationPlanV1 } from "./plan.ts";

export const MIGRATION_PLAN_FILENAME = "migration-plan.json";

/** 标准计划文件路径：<dataRoot>/runtime/migration/<tenant>.json */
export function migrationPlanPath(dataRoot: string, tenant: string): string {
  return join(dataRoot, "runtime", "migration", `${tenant}.json`);
}

export type MigrationPlanReadResult =
  | { readonly ok: true; readonly plan: MigrationPlanV1 }
  | { readonly ok: false; readonly reason: "missing" | "malformed" };

/** 读计划（runtime 侧）：不存在 = missing（模块关闭）；损坏 = malformed（fail-closed）。 */
export function readMigrationPlan(filePath: string): MigrationPlanReadResult {
  if (!existsSync(filePath)) return { ok: false, reason: "missing" };
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const result = parseMigrationPlan(parsed);
  if (!result.ok) return { ok: false, reason: "malformed" };
  return { ok: true, plan: result.plan };
}

/** 原子写（conductor 侧）：tmp 同目录 + rename 替换，避免撕裂读。 */
export function writeMigrationPlanAtomic(filePath: string, plan: MigrationPlanV1): void {
  const tmpPath = `${filePath}.tmp`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(plan, null, 2), "utf8");
  // Windows 上 rename 覆盖已存在文件可能失败：先尽力删除旧文件再 rename。
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath);
    } catch {
      // 删除失败仍尝试 rename（部分平台 rename 可覆盖）。
    }
  }
  renameSync(tmpPath, filePath);
}

/** 清理计划（ABORT/RECOVERY_ABORT 收尾；幂等）。 */
export function clearMigrationPlan(filePath: string): void {
  if (!existsSync(filePath)) return;
  try {
    unlinkSync(filePath);
  } catch {
    // 幂等：不存在即成功。
  }
}
