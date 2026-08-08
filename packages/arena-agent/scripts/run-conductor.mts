/**
 * M5 conductor CLI 壳（migration-system-v1 §1/§6.2）。
 *
 * 薄壳：锁（acquire/refresh/release）→ 读最新 calibration case（尽力解析）→
 * 组 ConductorStepInput → conductorStep → 计划原子写/清理。真正的决策逻辑
 * 全部在 src/migration/conductor.ts（纯函数），本文件只做 IO 编排。
 *
 * ⚠️ live 阶梯待用户授权：本脚本只保证编译通过 + 逻辑可读，未在 live 环境
 * 实测（spec §8 live 阶梯 8 → 30 → 100-150 → 555 需逐级授权）。
 *
 * 用法：node scripts/run-conductor.mts --tenant t1 --data-root <path> [--config <json 文件>]
 * - data-root：ARENA_DATA_ROOT（runtime 目录在其下：<root>/runtime/<tenant>/...）
 * - config：可选，缺省用 migration/config.ts 默认值
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  acquireConductorLock,
  refreshConductorLock,
  releaseConductorLock,
} from "../src/migration/lock.ts";
import {
  clearMigrationPlan,
  migrationPlanPath,
  readMigrationPlan,
  writeMigrationPlanAtomic,
} from "../src/migration/io.ts";
import {
  conductorStep,
  type ConductorHeldState,
  type ConductorStepInput,
} from "../src/migration/conductor.ts";
import { DEFAULT_MIGRATION_RUNTIME_CONFIG } from "../src/migration/config.ts";
import type { MigrationRuntimeConfig } from "../src/migration/config.ts";
import type { ConductorCoreSnapshot } from "../src/migration/conductor.ts";

interface CliOptions {
  readonly tenant: string;
  readonly dataRoot: string;
  readonly configPath: string | null;
}

function parseArgs(argv: readonly string[]): CliOptions | null {
  let tenant: string | null = null;
  let dataRoot: string | null = null;
  let configPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (flag === "--tenant" && value !== undefined) tenant = value;
    else if (flag === "--data-root" && value !== undefined) dataRoot = value;
    else if (flag === "--config" && value !== undefined) configPath = value;
  }
  if (tenant === null || dataRoot === null) {
    console.error("用法：run-conductor.mts --tenant <t1|t2|t3|t4> --data-root <path> [--config <json>]");
    return null;
  }
  return { tenant, dataRoot, configPath };
}

function loadConfig(configPath: string | null): MigrationRuntimeConfig {
  if (configPath === null) return DEFAULT_MIGRATION_RUNTIME_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    // 只做浅合并（config 文件缺省字段回落默认值），迁移配置节字段名与
    // config.ts 对齐（pace/corridor/hold/overlay）。
    return {
      ...DEFAULT_MIGRATION_RUNTIME_CONFIG,
      ...raw,
      pace: { ...DEFAULT_MIGRATION_RUNTIME_CONFIG.pace, ...(raw.pace as object ?? {}) },
      corridor: { ...DEFAULT_MIGRATION_RUNTIME_CONFIG.corridor, ...(raw.corridor as object ?? {}) },
      hold: { ...DEFAULT_MIGRATION_RUNTIME_CONFIG.hold, ...(raw.hold as object ?? {}) },
      overlay: { ...DEFAULT_MIGRATION_RUNTIME_CONFIG.overlay, ...(raw.overlay as object ?? {}) },
    } as MigrationRuntimeConfig;
  } catch (error) {
    console.warn(`config 加载失败，回落默认值：${error instanceof Error ? error.message : String(error)}`);
    return DEFAULT_MIGRATION_RUNTIME_CONFIG;
  }
}

/**
 * 尽力解析 calibration case（sim-calibration-case-v1，见 src/sim/calibration/schema.ts
 * 与 src/runtime-golden/recorder.ts 写入格式）。字段名拿不准/解析失败 →
 * 返回 null（本 tick 跳过打日志，不阻塞循环）。
 */
interface BestEffortObservation {
  readonly tick: number;
  readonly core: ConductorCoreSnapshot | null;
  readonly events: readonly { readonly type?: string }[];
  readonly units: readonly { readonly id: string; readonly unitType: string; readonly cargo: number }[];
  readonly survey: ConductorStepInput["survey"];
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseObservation(raw: unknown): BestEffortObservation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const before = record.before as Record<string, unknown> | undefined;
  const state = before?.state as Record<string, unknown> | undefined;
  const tick = before?.tick;
  const objects = state?.objects;
  const events = state?.events;
  if (typeof tick !== "number" || !Array.isArray(objects) || !Array.isArray(events)) return null;

  const coreId = (id: unknown): id is string => typeof id === "string";

  let core: ConductorCoreSnapshot | null = null;
  const enemyCores: { readonly x: number; readonly y: number; readonly lastSeenTick: number }[] = [];
  const units: { readonly id: string; readonly unitType: string; readonly cargo: number }[] = [];
  const resources: { readonly x: number; readonly y: number; readonly lastSeenTick: number }[] = [];

  for (const objectValue of objects) {
    if (typeof objectValue !== "object" || objectValue === null) continue;
    const object = objectValue as Record<string, unknown>;
    const kind = object.kind;
    const position = Array.isArray(object.position)
      ? [Number(object.position[0]), Number(object.position[1])] as const
      : null;
    const isControlled = object.controlled === true;
    if (kind === "CORE" && isControlled) {
      const id = typeof object.id === "string" ? object.id : null;
      core = {
        id,
        position: position !== null && Number.isFinite(position[0]) && Number.isFinite(position[1])
          ? position
          : null,
        state: object.state === "MOVING" ? "MOVING" : object.state === "NORMAL" ? "NORMAL" : null,
        hp: typeof object.hp === "number" ? object.hp : null,
      };
    } else if (kind === "CORE" && !isControlled) {
      // 敌方核心投影（controlled=false）→ 敌核记忆（本 tick 目击）
      if (position !== null && Number.isFinite(position[0]) && Number.isFinite(position[1])) {
        enemyCores.push({ x: position[0], y: position[1], lastSeenTick: tick });
      }
    } else if (kind === "UNIT" && isControlled) {
      if (coreId(object.id) && typeof object.unit_type === "string") {
        const cargo = typeof object.cargo === "number" && Number.isFinite(object.cargo) ? object.cargo : 0;
        units.push({ id: object.id, unitType: object.unit_type, cargo });
      }
    } else if (kind === "RESOURCE" && Array.isArray(object.positions)) {
      // 资源对象携带 positions 数组（可能多格）
      for (const entry of object.positions) {
        if (Array.isArray(entry) && Number.isFinite(Number(entry[0])) && Number.isFinite(Number(entry[1]))) {
          resources.push({ x: Number(entry[0]), y: Number(entry[1]), lastSeenTick: tick });
        }
      }
    }
  }

  return {
    tick,
    core,
    events: events.filter((event): event is { readonly type?: string } =>
      typeof event === "object" && event !== null),
    units,
    survey: { resources, enemyCores },
  };
}

/**
 * 读 <data-root>/runtime/<tenant>/calibration/latest 下最新的 case JSON。
 * latest 可能是目录（取 mtime 最新的 *.json）或单文件。
 */
function readLatestObservation(dataRoot: string, tenant: string): BestEffortObservation | null {
  const latestPath = join(dataRoot, "runtime", tenant, "calibration", "latest");
  try {
    if (!existsSync(latestPath)) {
      console.warn(`[${tenant}] 无 calibration 目录：${latestPath}（跳过本 tick）`);
      return null;
    }
    if (statSync(latestPath).isFile()) {
      return parseObservation(readJsonFile(latestPath));
    }
    const candidates = readdirSync(latestPath)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(latestPath, name))
      .sort((first, second) => statSync(second).mtimeMs - statSync(first).mtimeMs);
    if (candidates.length === 0) {
      console.warn(`[${tenant}] calibration/latest 目录为空（跳过本 tick）`);
      return null;
    }
    return parseObservation(readJsonFile(candidates[0]!));
  } catch (error) {
    console.warn(`[${tenant}] calibration 解析失败（跳过本 tick）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) process.exit(1);

  const { tenant, dataRoot } = options;
  const config = loadConfig(options.configPath);
  const planPath = migrationPlanPath(dataRoot, tenant);
  const lockPath = join(dataRoot, "runtime", "migration", `${tenant}.lock`);
  const pid = process.pid;
  const pollIntervalMs = 5_000;

  // conductor 内存持久状态：HOLD 窗口计数等（进程重启 = null，从磁盘计划续传）
  let heldState: ConductorHeldState | null = null;

  const runOnce = (): void => {
    const lock = acquireConductorLock(lockPath, tenant, pid);
    if (!lock.ok) {
      const holder = lock.holder !== undefined
        ? `（持有者 pid=${lock.holder.pid} epoch=${lock.holder.epoch}）`
        : "";
      console.error(`[${tenant}] 拿不到 conductor 锁（${lock.reason}）${holder}，本 tick 退出`);
      process.exit(1);
    }
    try {
      refreshConductorLock(lockPath, tenant, pid, lock.epoch);

      const observation = readLatestObservation(dataRoot, tenant);
      if (observation === null) return; // 解析失败跳过本 tick（计划留在磁盘，lease 过期后 runtime fail-closed）

      const planResult = readMigrationPlan(planPath);
      const plan = planResult.ok ? planResult.plan : null;
      if (!planResult.ok && planResult.reason === "malformed") {
        console.warn(`[${tenant}] 计划文件损坏（fail-closed，本 tick 不写盘）`);
      }

      const input: ConductorStepInput = {
        tick: observation.tick,
        nowMs: Date.now(),
        core: observation.core,
        events: observation.events,
        units: observation.units,
        survey: observation.survey,
        config,
        held: heldState,
        plan,
        // cancelRequested：human 取消意图经 command-plane 接线（M5 范围外，不接）
      };

      const result = conductorStep(input);
      heldState = result.held;
      if (result.plan === null) {
        if (plan !== null) {
          clearMigrationPlan(planPath);
          console.log(`[${tenant}] tick ${observation.tick}：计划清理完成`);
        }
      } else {
        writeMigrationPlanAtomic(planPath, result.plan);
        console.log(`[${tenant}] tick ${observation.tick} state=${result.plan.state}：${result.reasons.join(" | ")}`);
      }
      for (const transition of result.transitions) {
        console.log(`[${tenant}] tick ${transition.tick} 转移：${transition.from} --${transition.event}--> ${transition.to}`);
      }
    } finally {
      releaseConductorLock(lockPath, tenant, pid, lock.epoch);
    }
  };

  runOnce();
  const timer = setInterval(runOnce, pollIntervalMs);
  const shutdown = (): void => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
