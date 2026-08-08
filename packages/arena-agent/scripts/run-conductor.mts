/**
 * M5 conductor CLI 壳（migration-system-v1 §1/§6.2）。
 *
 * 薄壳：锁（acquire/refresh/release）→ 读最新 calibration case（尽力解析）→
 * 组 ConductorStepInput → conductorStep → 计划原子写/清理。真正的决策逻辑
 * 全部在 src/migration/conductor.ts（纯函数），本文件只做 IO 编排。
 *
 * 初始意图入口（2026-08-08 接线）：`--target x,y [--reason ...]`——无计划文件
 * 时以此构造初始计划（state=PLAN），路径/走廊审计由 conductor 自行生成。
 *
 * ⚠️ live 阶梯待用户授权：本脚本未在 live 环境实测（spec §8 live 阶梯
 * 8 → 30 → 100-150 → 555 需逐级授权）。
 *
 * 用法：node scripts/run-conductor.mts --tenant t1 --data-root <path>
 *   [--target x,y --reason "西撤避强敌"] [--config <json 文件>]
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
  CONDUCTOR_LEASE_HORIZON_TICKS,
  type ConductorHeldState,
  type ConductorStepInput,
} from "../src/migration/conductor.ts";
import {
  loadMigrationRuntimeConfig,
  type MigrationRuntimeConfig,
} from "../src/migration/config.ts";
import type { MigrationPlanV1 } from "../src/migration/plan.ts";
import type { ConductorCoreSnapshot } from "../src/migration/conductor.ts";

interface CliOptions {
  readonly tenant: string;
  readonly dataRoot: string;
  readonly configPath: string | null;
  readonly target: { readonly x: number; readonly y: number; readonly reason: string } | null;
}

function parseArgs(argv: readonly string[]): CliOptions | null {
  let tenant: string | null = null;
  let dataRoot: string | null = null;
  let configPath: string | null = null;
  let target: CliOptions["target"] = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (flag === "--tenant" && value !== undefined) tenant = value;
    else if (flag === "--data-root" && value !== undefined) dataRoot = value;
    else if (flag === "--config" && value !== undefined) configPath = value;
    else if (flag === "--target" && value !== undefined) {
      const match = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(value);
      if (match === null) {
        console.error(`--target 格式非法：${value}（应为 "x,y"，如 --target -65,33）`);
        return null;
      }
      target = { x: Number(match[1]), y: Number(match[2]), reason: "" };
    } else if (flag === "--reason" && value !== undefined) {
      target = target === null ? target : { ...target, reason: value };
    }
  }
  if (tenant === null || dataRoot === null) {
    console.error("用法：run-conductor.mts --tenant <t1|t2|t3|t4> --data-root <path> [--target x,y] [--reason <说明>] [--config <json>]");
    return null;
  }
  return { tenant, dataRoot, configPath, target };
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
 * 读 <data-root>/runtime/<tenant>/calibration 下最新的 case JSON（观测源）。
 *
 * 优先 `calibration/latest`（目录取 mtime 最新 *.json，或单文件）；不存在时
 * 回退扫描 `calibration/<runId>/cases/`（runtime-golden recorder 实写布局，
 * 2026-08-08 接线）——取 mtime 最新的 run 目录下最新的 case 文件。
 */
function readLatestObservation(dataRoot: string, tenant: string): BestEffortObservation | null {
  const calibrationRoot = join(dataRoot, "runtime", tenant, "calibration");
  const newestJsonFile = (directory: string): string | null => {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) return null;
    const candidates = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(directory, name))
      .sort((first, second) => statSync(second).mtimeMs - statSync(first).mtimeMs);
    return candidates[0] ?? null;
  };
  try {
    const latestPath = join(calibrationRoot, "latest");
    if (existsSync(latestPath)) {
      if (statSync(latestPath).isFile()) {
        return parseObservation(readJsonFile(latestPath));
      }
      const latestFile = newestJsonFile(latestPath);
      if (latestFile !== null) return parseObservation(readJsonFile(latestFile));
      console.warn(`[${tenant}] calibration/latest 目录为空（跳过本 tick）`);
      return null;
    }
    // 回退：最新 run 目录 → cases 目录 → 最新 case 文件
    const runs = readdirSync(calibrationRoot)
      .filter((name) => {
        try { return statSync(join(calibrationRoot, name)).isDirectory(); } catch { return false; }
      })
      .sort((first, second) => statSync(join(calibrationRoot, second)).mtimeMs - statSync(join(calibrationRoot, first)).mtimeMs);
    for (const run of runs) {
      const caseFile = newestJsonFile(join(calibrationRoot, run, "cases"));
      if (caseFile !== null) return parseObservation(readJsonFile(caseFile));
    }
    console.warn(`[${tenant}] calibration 无可用 case（跳过本 tick）`);
    return null;
  } catch (error) {
    console.warn(`[${tenant}] calibration 解析失败（跳过本 tick）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * 初始意图 → 初始计划（state=PLAN）。路径/legs/走廊审计留待 conductorStep
 * 的 PLAN 阶段从 survey 生成（planPhaseStep），这里只带 target + 核心身份。
 */
function buildInitialPlan(
  tenant: string,
  observation: BestEffortObservation,
  target: { readonly x: number; readonly y: number; readonly reason: string },
  config: MigrationRuntimeConfig,
): MigrationPlanV1 {
  const now = new Date().toISOString();
  const coreId = observation.core?.id ?? null;
  return {
    schema: "migration-plan-v1",
    operationId: `op-${Date.now()}-${tenant}-intent`,
    revision: 1,
    conductorEpoch: 1,
    tenant,
    mode: "migrate",
    state: "PLAN",
    core: {
      originCoreId: coreId,
      currentCoreId: coreId,
      generation: 1,
    },
    lease: {
      untilTick: observation.tick + CONDUCTOR_LEASE_HORIZON_TICKS,
      heartbeatAt: now,
    },
    target: { x: target.x, y: target.y, reason: target.reason },
    path: { cells: [], corridorWidth: config.corridor.width, lookahead: config.corridor.lookahead },
    legs: [],
    legProgress: { legIndex: 0, cellsThisLeg: 0 },
    pace: { ...config.pace },
    roles: { quotas: { escort: 40, sweep: 30, scout: 15, rear: 15 }, seed: 12345 },
    conductor: { pid: process.pid },
    updatedAt: now,
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) process.exit(1);

  const { tenant, dataRoot } = options;
  const config = loadMigrationRuntimeConfig(options.configPath);
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
      let plan = planResult.ok ? planResult.plan : null;
      if (!planResult.ok && planResult.reason === "malformed") {
        console.warn(`[${tenant}] 计划文件损坏（fail-closed，本 tick 不写盘）`);
      }

      // 初始意图接线：无计划 + 给了 --target → 构造初始计划（PLAN）并立即推进
      if (plan === null && options.target !== null) {
        if (observation.core?.position === null || observation.core === null) {
          console.error(`[${tenant}] 无法发起迁移：核心位置未知（等待校准）`);
          return;
        }
        plan = buildInitialPlan(tenant, observation, options.target, config);
        writeMigrationPlanAtomic(planPath, plan);
        console.log(`[${tenant}] 初始意图 → 计划写入（PLAN，目标 [${options.target.x},${options.target.y}]${options.target.reason !== "" ? `，理由：${options.target.reason}` : ""}）`);
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
