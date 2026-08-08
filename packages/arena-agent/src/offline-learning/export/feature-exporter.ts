/**
 * 特征导出器：TrajectoryV1 → feature-vector-v1 JSONL。
 *
 * 输出一行 = 一个 tick 的特征向量（31 维），附 tick/tenantId/episodeId 元数据。
 * 消费者可以按 episode 分组重建序列，也可以用单 tick 样本训练 BC/DAgger。
 *
 * 支持 Arrow IPC 格式的契约声明（不强绑 Arrow 库——导出为规范 JSON，消费者
 * 自行用 pyarrow/fastparquet 转换）。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TrajectoryV1 } from "../schema/trajectory.ts";
import {
  extractFeatureVector,
  FEATURE_NAMES,
  FEATURE_VECTOR_SCHEMA_VERSION,
  featureVectorToRecord,
  validateFeatureVector,
} from "../schema/feature-vector.ts";

export interface FeatureExportOptions {
  readonly outputDir: string;
  readonly maxTicks?: number;
  readonly overwrite?: boolean;
}

export interface FeatureExportStats {
  readonly rowsWritten: number;
  readonly bytesWritten: number;
  readonly outputPath: string;
}

export class FeatureExporter {
  private readonly outputDir: string;
  private readonly outputPath: string;
  private readonly maxTicks: number;
  private rowsWritten = 0;
  private bytesWritten = 0;

  constructor(options: FeatureExportOptions) {
    this.outputDir = options.outputDir;
    this.outputPath = join(options.outputDir, "features.jsonl");
    this.maxTicks = options.maxTicks ?? 6000;

    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }
    if (options.overwrite && existsSync(this.outputPath)) {
      writeFileSync(this.outputPath, "", "utf-8");
    }
  }

  /**
   * 从一条轨迹提取所有 tick 的特征向量并写入 JSONL。
   */
  exportTrajectory(trajectory: TrajectoryV1): void {
    for (const step of trajectory.steps) {
      const vec = extractFeatureVector(step.state, this.maxTicks);

      // 填充 nearest enemy core dx/dy（从 state 的 optional 字段或计算）
      // 这些值在 extractFeatureVector 中已填 0，如果调用方可提供更多信息则覆盖
      // （当前 SimWorld 投影暂不包含相对方向）；

      const problems = validateFeatureVector(vec);
      if (problems.length > 0) {
        throw new Error(
          `Feature vector validation failed for episode ${trajectory.metadata.episodeId} tick ${step.state.tick}: ${problems.join("; ")}`,
        );
      }

      const record = {
        schema: FEATURE_VECTOR_SCHEMA_VERSION,
        episodeId: trajectory.metadata.episodeId,
        tenantId: trajectory.metadata.tenantId,
        tick: step.state.tick,
        label: {
          immediateResourceDelta: step.label.immediateResourceDelta,
          netResourceDelta20: step.label.netResourceDelta20,
          deathProb20: step.label.deathProb20,
          coreRisk50: step.label.coreRisk50,
          windowComplete: step.label.windowComplete,
        },
        features: featureVectorToRecord(vec),
      };

      const line = JSON.stringify(record) + "\n";
      writeFileSync(this.outputPath, line, { flag: "a" });
      this.rowsWritten += 1;
      this.bytesWritten += Buffer.byteLength(line, "utf-8");
    }
  }

  /** 批量导出多条轨迹。 */
  exportTrajectories(trajectories: readonly TrajectoryV1[]): void {
    for (const t of trajectories) {
      this.exportTrajectory(t);
    }
  }

  getStats(): FeatureExportStats {
    return {
      rowsWritten: this.rowsWritten,
      bytesWritten: this.bytesWritten,
      outputPath: this.outputPath,
    };
  }

  /**
   * 生成 Arrow schema 声明（JSON 格式），供 Python 端 `pyarrow.schema()` 消费。
   * 不依赖 Arrow 库——纯文本契约。
   */
  static arrowSchemaDeclaration(): Record<string, unknown> {
    const fields: Record<string, unknown>[] = [
      { name: "schema", type: "utf8" },
      { name: "episodeId", type: "utf8" },
      { name: "tenantId", type: "utf8" },
      { name: "tick", type: "int32" },
      { name: "label_immediateResourceDelta", type: "int32" },
      { name: "label_netResourceDelta20", type: "int32" },
      { name: "label_deathProb20", type: "float64" },
      { name: "label_coreRisk50", type: "int8" },
      { name: "label_windowComplete", type: "bool" },
    ];
    for (const name of FEATURE_NAMES) {
      fields.push({ name: `feat_${name}`, type: "float64" });
    }
    return {
      schema: "arrow-schema-declaration-v1",
      format: "ipc",
      fields,
      metadata: {
        feature_dim: FEATURE_NAMES.length,
        feature_names: [...FEATURE_NAMES],
      },
    };
  }
}
