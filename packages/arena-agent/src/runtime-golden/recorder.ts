/**
 * S8b Runtime-Golden recorder.
 *
 * 只消费已经完成 submit 的 TickOutcome；不参与决策、validator、wire plan、
 * idempotency key 或 single-writer lock。observe() 只入串行异步队列，I/O
 * 永远发生在 submit 返回之后。任何错误都记录并 fail-open。
 */

import type { Accepted, PlayerState } from "@arena/arena-hero-ts";
import {
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalizeIntegrity, sha256Canonical } from "../domain/integrity.ts";
import type { Plan } from "../domain/model.ts";
import type { TickOutcome } from "../runtime/loop.ts";
import type { CalibrationCaseV1 } from "../sim/calibration/schema.ts";
import { appendJsonlLine } from "../telemetry/jsonl-writer.ts";

export const RUNTIME_GOLDEN_DATASET_SCHEMA = "runtime-golden-dataset-v1" as const;

export interface RuntimeGoldenReceiptSummary {
  readonly accepted: true;
  readonly tick: number;
  readonly source: string;
  readonly receivedAt: string;
}

export interface RuntimeGoldenCaseEntry {
  readonly caseId: string;
  readonly tick: number;
  readonly file: string;
  readonly caseSha256: string;
  readonly beforeSha256: string;
  readonly planSha256: string;
  readonly afterSha256: string;
  readonly receipt: RuntimeGoldenReceiptSummary;
}

export interface RuntimeGoldenDatasetManifest {
  readonly schema: typeof RUNTIME_GOLDEN_DATASET_SCHEMA;
  readonly datasetId: string;
  readonly tenantId: string;
  readonly rulesVersion: string;
  readonly sourceCommit: string;
  readonly configHash: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly caseCount: number;
  readonly skippedRejected: number;
  readonly droppedPending: number;
  readonly errorCount: number;
  readonly cases: readonly RuntimeGoldenCaseEntry[];
  readonly errors: readonly string[];
}

export interface RuntimeGoldenRecorderOptions {
  readonly outputDir: string;
  readonly processRunId: string;
  readonly tenantId: string;
  readonly rulesVersion: string;
  readonly sourceCommit: string;
  readonly configHash: string;
  readonly onWarning?: (message: string) => void;
  /**
   * calibration-recorder.jsonl 路径（tenant-runtime 布局下默认为
   * outputDir 的兄弟 telemetry 目录）。用于服务器字段指纹变化告警。
   */
  readonly versionFingerprintLogPath?: string;
}

export interface RuntimeGoldenRecorderResult {
  readonly outputDir: string;
  readonly manifestPath: string;
  readonly caseCount: number;
  readonly skippedRejected: number;
  readonly droppedPending: number;
  readonly errorCount: number;
}

interface PendingCase {
  readonly tick: number;
  readonly state: PlayerState;
  readonly plan: Plan;
  readonly runId: string | null;
  readonly receipt: RuntimeGoldenReceiptSummary;
}

function atomicWriteJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(canonicalizeIntegrity(value), null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function receiptOf(receipt: Accepted): RuntimeGoldenReceiptSummary {
  return {
    accepted: true,
    tick: receipt.tick,
    source: String(receipt.source),
    receivedAt: receipt.received_at,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * 服务器字段指纹：rawState（domain 层 normalize 后）中
 * population_tier / upkeep_next_tick 的“存在性”。v0.14 服务器不下发时
 * 为 null → absent；旧协议下发值为 present。
 */
function serverFieldFingerprint(state: PlayerState): string {
  const populationTierPresent = (state.population_tier ?? null) !== null;
  const upkeepNextTickPresent = (state.upkeep_next_tick ?? null) !== null;
  return `population_tier=${populationTierPresent ? "present" : "absent"};` +
    `upkeep_next_tick=${upkeepNextTickPresent ? "present" : "absent"}`;
}

export class RuntimeGoldenRecorder {
  readonly outputDir: string;
  readonly manifestPath: string;

  private readonly options: RuntimeGoldenRecorderOptions;
  private readonly startedAt = new Date().toISOString();
  private readonly entries: RuntimeGoldenCaseEntry[] = [];
  private readonly errors: string[] = [];
  private pending: PendingCase | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private skippedRejected = 0;
  private droppedPending = 0;
  private lastServerFieldFingerprint: string | null = null;

  constructor(options: RuntimeGoldenRecorderOptions) {
    this.options = options;
    this.outputDir = options.outputDir;
    this.manifestPath = join(options.outputDir, "manifest.json");
    mkdirSync(join(options.outputDir, "cases"), { recursive: true });
  }

  /** Non-blocking from the live loop: preserves order through a private promise chain. */
  observe(outcome: TickOutcome): void {
    if (this.closed) return;
    this.queue = this.queue
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => this.processOutcome(outcome))
      .catch((error: unknown) => this.recordError("observe", error));
  }

  async close(): Promise<RuntimeGoldenRecorderResult> {
    if (!this.closed) {
      this.closed = true;
      await this.queue;
      if (this.pending !== null) {
        this.droppedPending += 1;
        this.warn(`pending tick ${this.pending.tick} has no next raw state; case dropped`);
        this.pending = null;
      }
      const manifest = this.buildManifest();
      try {
        atomicWriteJson(this.manifestPath, manifest);
      } catch (error) {
        this.recordError("manifest", error);
        // 最后一次 best-effort：append-only 错误证据，不再抛回 live runtime。
        try {
          appendJsonlLine(
            join(this.outputDir, "recorder-errors.jsonl"),
            JSON.stringify({ at: new Date().toISOString(), error: String(error) }),
          );
        } catch {}
      }
    }
    return {
      outputDir: this.outputDir,
      manifestPath: this.manifestPath,
      caseCount: this.entries.length,
      skippedRejected: this.skippedRejected,
      droppedPending: this.droppedPending,
      errorCount: this.errors.length,
    };
  }

  private async processOutcome(outcome: TickOutcome): Promise<void> {
    if (this.pending !== null) {
      // 先解除 pending 再做可能失败的 I/O/parser；单个坏 case 不得污染下一对状态。
      const pending = this.pending;
      this.pending = null;
      if (outcome.tick === pending.tick + 1) {
        try {
          await this.writeCase(pending, outcome.rawState);
        } catch (error) {
          this.recordError(`case:${pending.tick}`, error);
        }
      } else {
        this.droppedPending += 1;
        this.warn(
          `non-consecutive raw states: pending=${pending.tick}, next=${outcome.tick}; case dropped`,
        );
      }
    }

    if (!outcome.submitAttempted) return;
    if (!outcome.accepted || outcome.receipt === undefined) {
      this.skippedRejected += 1;
      return;
    }
    this.pending = {
      tick: outcome.tick,
      state: clone(outcome.rawState),
      plan: clone(outcome.plan),
      runId: outcome.decision?.runId ?? null,
      receipt: receiptOf(outcome.receipt),
    };
  }

  private async writeCase(pending: PendingCase, afterState: PlayerState): Promise<void> {
    const caseId = `${this.options.processRunId}:${pending.tick}`;
    const calibrationCase: CalibrationCaseV1 = {
      schema: "sim-calibration-case-v1",
      caseId,
      tenantId: this.options.tenantId,
      rulesVersion: this.options.rulesVersion,
      // 本地 replay seed；绝不冒充服务端隐藏 world seed。
      seed: 0,
      metadata: {
        source: "live-recorder",
        opponentPlans: "absent",
        recordedAt: pending.receipt.receivedAt,
        sourceCommit: this.options.sourceCommit,
        runId: pending.runId,
      },
      // v0.14（2026-08-06 上游 rules v0.14）起服务器不再下发 population_tier /
      // upkeep_next_tick，normalize 后为 null。case 契约（共享 schema）已放宽为
      // integer|null；原样落盘、不按旧协议公式推导，避免把 v0.14 数据伪装成
      // v0.11 语义。旧 case（服务器仍下发值）原样保留。
      before: { tick: pending.tick, state: pending.state },
      plan: pending.plan,
      after: { tick: pending.tick + 1, state: clone(afterState) },
    };

    // Dynamic import keeps the simulator parser off the default live startup path.
    const { parseCalibrationCase } = await import("../sim/calibration/schema.ts");
    parseCalibrationCase(calibrationCase);

    const file = join("cases", `${String(pending.tick).padStart(10, "0")}.json`);
    atomicWriteJson(join(this.outputDir, file), calibrationCase);
    this.entries.push({
      caseId,
      tick: pending.tick,
      file: file.replaceAll("\\", "/"),
      caseSha256: sha256Canonical(calibrationCase),
      beforeSha256: sha256Canonical(calibrationCase.before),
      planSha256: sha256Canonical(calibrationCase.plan),
      afterSha256: sha256Canonical(calibrationCase.after),
      receipt: pending.receipt,
    });

    // v0.14 起服务器不再下发 population_tier / upkeep_next_tick（normalize 后
    // 为 null）。指纹变化时写一条 warning 事件，不抛错、不影响落盘。
    const fingerprint = serverFieldFingerprint(pending.state);
    if (this.lastServerFieldFingerprint !== null && fingerprint !== this.lastServerFieldFingerprint) {
      this.writeVersionFingerprintWarning(fingerprint, this.lastServerFieldFingerprint);
    }
    this.lastServerFieldFingerprint = fingerprint;
  }

  private writeVersionFingerprintWarning(fingerprint: string, previousFingerprint: string): void {
    try {
      const logPath = this.options.versionFingerprintLogPath ??
        join(this.outputDir, "..", "..", "telemetry", "calibration-recorder.jsonl");
      mkdirSync(dirname(logPath), { recursive: true });
      appendJsonlLine(
        logPath,
        JSON.stringify({
          at: new Date().toISOString(),
          type: "version_fingerprint",
          fingerprint,
          previousFingerprint,
        }),
      );
    } catch {
      // fail-open：指纹告警丢失不得影响 case 落盘。
    }
  }

  private buildManifest(): RuntimeGoldenDatasetManifest {
    return {
      schema: RUNTIME_GOLDEN_DATASET_SCHEMA,
      datasetId: this.options.processRunId,
      tenantId: this.options.tenantId,
      rulesVersion: this.options.rulesVersion,
      sourceCommit: this.options.sourceCommit,
      configHash: this.options.configHash,
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      caseCount: this.entries.length,
      skippedRejected: this.skippedRejected,
      droppedPending: this.droppedPending,
      errorCount: this.errors.length,
      cases: [...this.entries],
      errors: [...this.errors],
    };
  }

  private recordError(stage: string, error: unknown): void {
    const message = `${stage}: ${error instanceof Error ? error.message : String(error)}`;
    this.errors.push(message);
    this.warn(message);
  }

  private warn(message: string): void {
    try {
      this.options.onWarning?.(message);
    } catch {}
  }
}
