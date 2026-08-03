/**
 * 规则 manifest typed loader（S0：官方来源锁定）。
 *
 * 职责：
 * - 加载并校验 `rules-v0.11.json`（required fields + 数值范围）；
 * - 版本不匹配必须 fail closed（未核对的规则版本不能被静默加载）；
 * - 提供 mirror 聚合 SHA-256 验证（检测 reference SDK 镜像漂移）；
 * - canonical 序列化，供 calibration 报告打 stale 标记。
 *
 * 隔离边界：本文件无网络、无 .env、无 Client import；只读文件系统。
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface RulesManifest {
  readonly schemaVersion: number;
  readonly rulesVersion: string;
  readonly verifiedAt: string;
  readonly evidence: {
    readonly docs: {
      readonly repo: string;
      readonly commit: string;
      readonly rulesVersion: string;
      readonly apiVersion: string;
    };
    readonly sdk: {
      readonly repo: string;
      readonly tag: string;
      readonly publicCommit: string;
      readonly documentedCommit: string;
      readonly documentedCommitStatus: string;
      readonly mirrorDir: string;
      readonly mirrorFileCount: number;
      readonly mirrorAggregateSha256: string;
    };
    readonly serverSource: {
      readonly status: string;
      readonly note: string;
    };
    readonly discrepancies: readonly string[];
  };
  readonly rules: {
    readonly core: {
      readonly minCapacity: number;
      readonly capacityPerUnit: number;
      readonly maxHp: number;
      readonly maxShield: number;
      readonly maxShieldWithBeacon: number;
      readonly visionRadius: number;
      readonly startingResources: number;
      readonly startingWorkerCount: number;
    };
    readonly production: {
      readonly workerCost: number;
      readonly vanguardCost: number;
      readonly rangerCost: number;
      readonly maxSpawnPerTick: number;
    };
    readonly upkeep: {
      readonly tierSize: number;
      readonly deficitProtectionCount: number;
      readonly deficitDamage: {
        readonly semantics: string;
        readonly status: string;
        readonly note: string;
      };
    };
    readonly units: {
      readonly workerHp: number;
      readonly vanguardHp: number;
      readonly rangerHp: number;
      readonly workerCargoCapacity: number;
      readonly workerVisionRadius: number;
      readonly vanguardVisionRadius: number;
      readonly rangerVisionRadius: number;
    };
    readonly economy: {
      readonly harvestAmount: number;
      readonly harvestAmountWithBeacon: number;
      readonly healCostPerHp: number;
      readonly repairShieldCost: number;
      readonly refillEveryTicks: number;
    };
    readonly movement: {
      readonly cellEntityCapacity: number;
      readonly maxCellsPerTick: number;
      readonly samePlayerTieBreak: string;
      readonly crossPlayerContested: string;
    };
    readonly settlement: {
      readonly officialPhaseCount: number;
      readonly localPhaseCount: number;
      readonly granularityNote: string;
    };
  };
  readonly constraints: {
    readonly coordinate: {
      readonly type: string;
      readonly jsRequirement: string;
      readonly unsupportedError: string;
      readonly note: string;
    };
    readonly uuidTieBreak: {
      readonly rule: string;
      readonly comparator: string;
      readonly forbidden: readonly string[];
    };
    readonly refill: {
      readonly status: string;
      readonly simulation: string;
      readonly note: string;
    };
    readonly settlementOrder: string;
  };
}

export class RulesManifestError extends Error {
  constructor(message: string) {
    super(`rules manifest: ${message}`);
    this.name = "RulesManifestError";
  }
}

/** 数值范围校验：非负整数 + 不超过 1e6 的合理性上限（防御错值）。 */
const INT_RANGE = { min: 0, max: 1_000_000 };

function assertIntField(value: unknown, path: string, max = INT_RANGE.max): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < INT_RANGE.min || value > max) {
    throw new RulesManifestError(`invalid integer at ${path}: ${String(value)}`);
  }
  return value;
}

function assertStringField(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RulesManifestError(`invalid string at ${path}`);
  }
  return value;
}

function assertStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new RulesManifestError(`invalid string array at ${path}`);
  }
  return value;
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RulesManifestError(`expected object at ${path}`);
  }
  return value as Record<string, unknown>;
}

/** 深度校验并归一化为 RulesManifest（不可变）。任何必填缺失/类型错误都抛错。 */
export function parseRulesManifest(raw: unknown): RulesManifest {
  const root = assertRecord(raw, "root");
  const schemaVersion = assertIntField(root.schemaVersion, "schemaVersion");
  const rulesVersion = assertStringField(root.rulesVersion, "rulesVersion");
  const verifiedAt = assertStringField(root.verifiedAt, "verifiedAt");

  const evidence = assertRecord(root.evidence, "evidence");
  const docs = assertRecord(evidence.docs, "evidence.docs");
  const sdk = assertRecord(evidence.sdk, "evidence.sdk");
  const serverSource = assertRecord(evidence.serverSource, "evidence.serverSource");
  const discrepancies = assertStringArray(evidence.discrepancies, "evidence.discrepancies");

  const rules = assertRecord(root.rules, "rules");
  const core = assertRecord(rules.core, "rules.core");
  const production = assertRecord(rules.production, "rules.production");
  const upkeep = assertRecord(rules.upkeep, "rules.upkeep");
  const deficitDamage = assertRecord(upkeep.deficitDamage, "rules.upkeep.deficitDamage");
  const units = assertRecord(rules.units, "rules.units");
  const economy = assertRecord(rules.economy, "rules.economy");
  const movement = assertRecord(rules.movement, "rules.movement");
  const settlement = assertRecord(rules.settlement, "rules.settlement");

  const constraints = assertRecord(root.constraints, "constraints");
  const coordinate = assertRecord(constraints.coordinate, "constraints.coordinate");
  const uuidTieBreak = assertRecord(constraints.uuidTieBreak, "constraints.uuidTieBreak");
  const refill = assertRecord(constraints.refill, "constraints.refill");

  const manifest: RulesManifest = Object.freeze({
    schemaVersion,
    rulesVersion,
    verifiedAt,
    evidence: Object.freeze({
      docs: Object.freeze({
        repo: assertStringField(docs.repo, "evidence.docs.repo"),
        commit: assertStringField(docs.commit, "evidence.docs.commit"),
        rulesVersion: assertStringField(docs.rulesVersion, "evidence.docs.rulesVersion"),
        apiVersion: assertStringField(docs.apiVersion, "evidence.docs.apiVersion"),
      }),
      sdk: Object.freeze({
        repo: assertStringField(sdk.repo, "evidence.sdk.repo"),
        tag: assertStringField(sdk.tag, "evidence.sdk.tag"),
        publicCommit: assertStringField(sdk.publicCommit, "evidence.sdk.publicCommit"),
        documentedCommit: assertStringField(sdk.documentedCommit, "evidence.sdk.documentedCommit"),
        documentedCommitStatus: assertStringField(
          sdk.documentedCommitStatus,
          "evidence.sdk.documentedCommitStatus",
        ),
        mirrorDir: assertStringField(sdk.mirrorDir, "evidence.sdk.mirrorDir"),
        mirrorFileCount: assertIntField(sdk.mirrorFileCount, "evidence.sdk.mirrorFileCount"),
        mirrorAggregateSha256: assertStringField(sdk.mirrorAggregateSha256, "evidence.sdk.mirrorAggregateSha256"),
      }),
      serverSource: Object.freeze({
        status: assertStringField(serverSource.status, "evidence.serverSource.status"),
        note: assertStringField(serverSource.note, "evidence.serverSource.note"),
      }),
      discrepancies: discrepancies,
    }),
    rules: Object.freeze({
      core: Object.freeze({
        minCapacity: assertIntField(core.minCapacity, "rules.core.minCapacity"),
        capacityPerUnit: assertIntField(core.capacityPerUnit, "rules.core.capacityPerUnit"),
        maxHp: assertIntField(core.maxHp, "rules.core.maxHp"),
        maxShield: assertIntField(core.maxShield, "rules.core.maxShield"),
        maxShieldWithBeacon: assertIntField(core.maxShieldWithBeacon, "rules.core.maxShieldWithBeacon"),
        visionRadius: assertIntField(core.visionRadius, "rules.core.visionRadius"),
        startingResources: assertIntField(core.startingResources, "rules.core.startingResources"),
        startingWorkerCount: assertIntField(core.startingWorkerCount, "rules.core.startingWorkerCount"),
      }),
      production: Object.freeze({
        workerCost: assertIntField(production.workerCost, "rules.production.workerCost"),
        vanguardCost: assertIntField(production.vanguardCost, "rules.production.vanguardCost"),
        rangerCost: assertIntField(production.rangerCost, "rules.production.rangerCost"),
        maxSpawnPerTick: assertIntField(production.maxSpawnPerTick, "rules.production.maxSpawnPerTick"),
      }),
      upkeep: Object.freeze({
        tierSize: assertIntField(upkeep.tierSize, "rules.upkeep.tierSize", 1_000),
        deficitProtectionCount: assertIntField(
          upkeep.deficitProtectionCount,
          "rules.upkeep.deficitProtectionCount",
          1_000,
        ),
        deficitDamage: Object.freeze({
          semantics: assertStringField(deficitDamage.semantics, "rules.upkeep.deficitDamage.semantics"),
          status: assertStringField(deficitDamage.status, "rules.upkeep.deficitDamage.status"),
          note: assertStringField(deficitDamage.note, "rules.upkeep.deficitDamage.note"),
        }),
      }),
      units: Object.freeze({
        workerHp: assertIntField(units.workerHp, "rules.units.workerHp"),
        vanguardHp: assertIntField(units.vanguardHp, "rules.units.vanguardHp"),
        rangerHp: assertIntField(units.rangerHp, "rules.units.rangerHp"),
        workerCargoCapacity: assertIntField(units.workerCargoCapacity, "rules.units.workerCargoCapacity"),
        workerVisionRadius: assertIntField(units.workerVisionRadius, "rules.units.workerVisionRadius"),
        vanguardVisionRadius: assertIntField(units.vanguardVisionRadius, "rules.units.vanguardVisionRadius"),
        rangerVisionRadius: assertIntField(units.rangerVisionRadius, "rules.units.rangerVisionRadius"),
      }),
      economy: Object.freeze({
        harvestAmount: assertIntField(economy.harvestAmount, "rules.economy.harvestAmount"),
        harvestAmountWithBeacon: assertIntField(economy.harvestAmountWithBeacon, "rules.economy.harvestAmountWithBeacon"),
        healCostPerHp: assertIntField(economy.healCostPerHp, "rules.economy.healCostPerHp"),
        repairShieldCost: assertIntField(economy.repairShieldCost, "rules.economy.repairShieldCost"),
        refillEveryTicks: assertIntField(economy.refillEveryTicks, "rules.economy.refillEveryTicks"),
      }),
      movement: Object.freeze({
        cellEntityCapacity: assertIntField(movement.cellEntityCapacity, "rules.movement.cellEntityCapacity"),
        maxCellsPerTick: assertIntField(movement.maxCellsPerTick, "rules.movement.maxCellsPerTick"),
        samePlayerTieBreak: assertStringField(movement.samePlayerTieBreak, "rules.movement.samePlayerTieBreak"),
        crossPlayerContested: assertStringField(movement.crossPlayerContested, "rules.movement.crossPlayerContested"),
      }),
      settlement: Object.freeze({
        officialPhaseCount: assertIntField(settlement.officialPhaseCount, "rules.settlement.officialPhaseCount"),
        localPhaseCount: assertIntField(settlement.localPhaseCount, "rules.settlement.localPhaseCount"),
        granularityNote: assertStringField(settlement.granularityNote, "rules.settlement.granularityNote"),
      }),
    }),
    constraints: Object.freeze({
      coordinate: Object.freeze({
        type: assertStringField(coordinate.type, "constraints.coordinate.type"),
        jsRequirement: assertStringField(coordinate.jsRequirement, "constraints.coordinate.jsRequirement"),
        unsupportedError: assertStringField(coordinate.unsupportedError, "constraints.coordinate.unsupportedError"),
        note: assertStringField(coordinate.note, "constraints.coordinate.note"),
      }),
      uuidTieBreak: Object.freeze({
        rule: assertStringField(uuidTieBreak.rule, "constraints.uuidTieBreak.rule"),
        comparator: assertStringField(uuidTieBreak.comparator, "constraints.uuidTieBreak.comparator"),
        forbidden: assertStringArray(uuidTieBreak.forbidden, "constraints.uuidTieBreak.forbidden"),
      }),
      refill: Object.freeze({
        status: assertStringField(refill.status, "constraints.refill.status"),
        simulation: assertStringField(refill.simulation, "constraints.refill.simulation"),
        note: assertStringField(refill.note, "constraints.refill.note"),
      }),
      settlementOrder: assertStringField(constraints.settlementOrder, "constraints.settlementOrder"),
    }),
  });

  if (schemaVersion !== 1) {
    throw new RulesManifestError(`unsupported schemaVersion: ${schemaVersion}`);
  }
  return manifest;
}

/** 从文件加载 manifest。文件不存在/解析失败/校验失败一律抛错。 */
export function loadRulesManifest(path: string): RulesManifest {
  const text = readFileSync(path, "utf8");
  return parseRulesManifest(JSON.parse(text));
}

/**
 * 版本闸门：期望规则版本与 manifest 不一致必须 fail closed。
 * 未核对的新规则版本不能被模拟器静默加载。
 */
export function assertRulesSupported(manifest: RulesManifest, expectedVersion: string): void {
  if (manifest.rulesVersion !== expectedVersion) {
    throw new RulesManifestError(
      `rules version mismatch: manifest=${manifest.rulesVersion}, required=${expectedVersion} (re-verify against upstream before loading)`,
    );
  }
}

/** 确定性序列化（key 排序 + 缩进固定），用于 hash 与 stale 标记。 */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(sort);
    }
    if (typeof v === "object" && v !== null) {
      const record = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        out[key] = sort(record[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + "\n";
}

/** manifest 内容 hash（SHA-256，canonical）。 */
export function manifestHash(manifest: RulesManifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

/** 目录聚合 SHA-256：文件名排序 → 每文件 "hash  name" 行 → 整体 sha256（与 bash 工具一致）。 */
export function directoryAggregateSha256(dirPath: string): { aggregate: string; fileCount: number } {
  const files = readdirSync(dirPath).sort();
  const lines: string[] = [];
  for (const name of files) {
    const content = readFileSync(join(dirPath, name));
    const digest = createHash("sha256").update(content).digest("hex");
    lines.push(`${digest}  ${name}`);
  }
  const aggregate = createHash("sha256").update(lines.join("\n") + "\n").digest("hex");
  return { aggregate, fileCount: files.length };
}

/** 验证本地 SDK 镜像与 manifest 锁定值一致（检测镜像漂移）。返回 null 表示一致。 */
export function verifyMirror(manifest: RulesManifest, mirrorDir: string): string | null {
  const { aggregate, fileCount } = directoryAggregateSha256(mirrorDir);
  if (fileCount !== manifest.evidence.sdk.mirrorFileCount) {
    return `mirror file count mismatch: expected ${manifest.evidence.sdk.mirrorFileCount}, got ${fileCount}`;
  }
  if (aggregate !== manifest.evidence.sdk.mirrorAggregateSha256) {
    return `mirror aggregate sha256 mismatch: expected ${manifest.evidence.sdk.mirrorAggregateSha256}, got ${aggregate}`;
  }
  return null;
}
