/**
 * 轨迹导出器：EpisodeResult → trajectory-v1 JSONL。
 *
 * 输出一行 = 一个完整 episode（不拆分为单 tick 行），保持时间序列完整性。
 * 消费者可以一次读取一行获得完整轨迹，无需跨行拼接。
 *
 * 用法：
 *   const exporter = new TrajectoryExporter({ outputDir, rulesManifestHash, ... });
 *   const trajectory = exporter.episodeToTrajectory(episodeResult, episodeRecords);
 *   exporter.writeTrajectory(trajectory);
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EpisodeRecord, EpisodeResult } from "../../sim/harness/episode.ts";
import {
  computeTrajectoryId,
  projectStepAction,
  projectStepLabel,
  projectStepState,
  validateTrajectoryV1,
  type TrajectoryMetadata,
  type TrajectoryStep,
  type TrajectoryV1,
} from "../schema/trajectory.ts";

export interface TrajectoryExporterOptions {
  readonly outputDir: string;
  readonly rulesVersion: string;
  readonly rulesManifestHash: string;
  readonly sourceCommit: string;
  readonly engineVersion: string;
  /** Overwrite existing file. Default false (append). */
  readonly overwrite?: boolean;
}

export interface ExportStats {
  readonly trajectoriesWritten: number;
  readonly stepsWritten: number;
  readonly bytesWritten: number;
  readonly outputPath: string;
  readonly outputHash: string;
}

export class TrajectoryExporter {
  private readonly outputDir: string;
  private readonly outputPath: string;
  private readonly rulesVersion: string;
  private readonly rulesManifestHash: string;
  private readonly sourceCommit: string;
  private readonly engineVersion: string;
  private trajectoriesWritten = 0;
  private stepsWritten = 0;
  private bytesWritten = 0;

  constructor(options: TrajectoryExporterOptions) {
    this.outputDir = options.outputDir;
    this.outputPath = join(options.outputDir, "trajectories.jsonl");
    this.rulesVersion = options.rulesVersion;
    this.rulesManifestHash = options.rulesManifestHash;
    this.sourceCommit = options.sourceCommit;
    this.engineVersion = options.engineVersion;

    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }
    if (options.overwrite && existsSync(this.outputPath)) {
      writeFileSync(this.outputPath, "", "utf-8");
    }
  }

  /**
   * 将完整的 EpisodeResult 转为一条 trajectory-v1。
   * episodeId 由调用方提供（如 manifest.datasetId）。
   */
  episodeToTrajectory(
    episodeId: string,
    result: EpisodeResult,
    records: readonly EpisodeRecord[],
    source: "sim" | "live" = "sim",
    startedAt?: string,
  ): TrajectoryV1 {
    // EpisodeRecord intentionally does not contain the private TickState consumed by the planner.
    // Fabricating zeros/defaults here would create schema-valid but semantically false training data.
    // Keep this legacy convenience API fail-closed until the caller supplies full per-tick capture.
    throw new Error(
      "episodeToTrajectory requires full per-tick private state; use buildTrajectoryFromTicks/onTickRecorded capture",
    );

    if (records.length === 0) {
      throw new Error("Cannot create trajectory from empty episode");
    }

    // 确定租户（取第一个 record 的第一个 plan 的 key）
    const firstRecord = records[0]!;
    const tenantIds = Object.keys(firstRecord.plans);
    if (tenantIds.length === 0) {
      throw new Error("Episode has no tenant plans");
    }
    // 对每个租户，从 SimWorld 提取状态投影
    // 简化：取主租户（第一个）
    const mainTenantId = tenantIds[0]!;

    const steps: TrajectoryStep[] = [];

    // Build a per-tenant lookup of before/after resources from records
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      const tick = record.tick;

      // Plan for main tenant
      const plan = record.plans[mainTenantId];
      if (!plan) continue;

      const planHash = record.planHashes[mainTenantId] ?? "00000000";

      // Extract state projection from the world at this tick
      // We need the world before settlement. Use the records and events
      // to reconstruct approximate state.
      // For now, extract what we can from the record structure.
      // In a full implementation, we'd use the onTickRecorded hook data.

      // Placeholder: extract state info from plan and validation
      const action = projectStepAction(plan, planHash);

      // Build a minimal state from what we have
      // (Full implementation requires access to SimWorld at each tick;
      //  consumer should use onTickRecorded hook to capture full state.)
      const state = {
        tick,
        resources: 0,      // to be filled by hook
        resourceCapacity: 0,
        population: 0,
        workers: 0,
        vanguards: 0,
        rangers: 0,
        coreHp: 0,
        coreShield: 0,
        corePosition: [0, 0] as const,
        coreState: "NORMAL",
        visibleResourceCells: 0,
        carriedResources: 0,
        visibleEnemyUnits: 0,
        visibleEnemyCombat: 0,
        visibleEnemyCores: 0,
        nearestEnemyCoreDist: null as number | null,
        nearestEnemyCombatDist: null as number | null,
        threatLevel: "NORMAL",
      };

      const label = projectStepLabel(
        0, 0, 0, 0, 0, 0, 0, 0, true,
      );

      steps.push({ state, action, label });
    }

    const trajectoryId = computeTrajectoryId(steps);

    const metadata: TrajectoryMetadata = {
      episodeId,
      tenantId: mainTenantId,
      rulesVersion: this.rulesVersion,
      rulesManifestHash: this.rulesManifestHash,
      seed: 0, // EpisodeConfig.seed, not exposed in EpisodeResult
      tickCount: result.metrics.ticks,
      source,
      sourceCommit: this.sourceCommit,
      engineVersion: this.engineVersion,
      startedAt: startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    return {
      schema: "trajectory-v1" as const,
      trajectoryId,
      metadata,
      steps: Object.freeze(steps),
    };
  }

  /**
   * 从 onTickRecorded hook 数据构建带完整状态的轨迹。
   * 这是推荐的调用路径——在 episode 运行中通过 hook 累积 tick 数据。
   */
  buildTrajectoryFromTicks(
    episodeId: string,
    tenantId: string,
    seed: number,
    tickCount: number,
    source: "sim" | "live",
    tickData: readonly {
      tick: number;
      state: import("../schema/trajectory.ts").TrajectoryStepState;
      action: import("../schema/trajectory.ts").TrajectoryStepAction;
      label: import("../schema/trajectory.ts").TrajectoryStepLabel;
    }[],
    startedAt?: string,
  ): TrajectoryV1 {
    const steps: TrajectoryStep[] = tickData.map((td) => ({
      state: td.state,
      action: td.action,
      label: td.label,
    }));

    const trajectoryId = computeTrajectoryId(steps);

    const metadata: TrajectoryMetadata = {
      episodeId,
      tenantId,
      rulesVersion: this.rulesVersion,
      rulesManifestHash: this.rulesManifestHash,
      seed,
      tickCount,
      source,
      sourceCommit: this.sourceCommit,
      engineVersion: this.engineVersion,
      startedAt: startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    return {
      schema: "trajectory-v1" as const,
      trajectoryId,
      metadata,
      steps: Object.freeze(steps),
    };
  }

  /** 写入一条轨迹为 JSONL 行。失败抛错（数据完整性优先）。 */
  writeTrajectory(trajectory: TrajectoryV1): void {
    const problems = validateTrajectoryV1(trajectory);
    if (problems.length > 0) {
      throw new Error(`Trajectory validation failed: ${problems.join("; ")}`);
    }
    const line = JSON.stringify(trajectory) + "\n";
    writeFileSync(this.outputPath, line, { flag: "a" });
    this.trajectoriesWritten += 1;
    this.stepsWritten += trajectory.steps.length;
    this.bytesWritten += Buffer.byteLength(line, "utf-8");
  }

  /** 批量写入多条轨迹。 */
  writeTrajectories(trajectories: readonly TrajectoryV1[]): void {
    for (const t of trajectories) {
      this.writeTrajectory(t);
    }
  }

  /** 获取导出统计 + 输出文件哈希。 */
  getStats(): ExportStats {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    let outputHash = "";
    if (existsSync(this.outputPath)) {
      const content = readFileSync(this.outputPath, "utf-8");
      outputHash = createHash("sha256").update(content).digest("hex");
    }
    return {
      trajectoriesWritten: this.trajectoriesWritten,
      stepsWritten: this.stepsWritten,
      bytesWritten: this.bytesWritten,
      outputPath: this.outputPath,
      outputHash,
    };
  }
}
