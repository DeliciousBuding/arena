/**
 * 规则 manifest typed loader（S0：官方来源锁定）。
 *
 * 职责：
 * - 按 rulesVersion 加载并校验内置规则文件（required fields + 数值范围）；
 *   v0.11 为默认（历史语义锁定），v0.14 为动态价格基线（官方 changelog
 *   2026-08-06，docs commit 166ef86 / server commit b24cfcd）；
 * - 版本不匹配必须 fail closed（未核对的规则版本不能被静默加载）；
 * - 提供 mirror 聚合 SHA-256 验证（检测 reference SDK 镜像漂移；v0.11 与
 *   v0.14 统一生效——v0.14 的 SDK v0.2.9 镜像已核对，见 rules-v0.14.json
 *   evidence.sdk）；
 * - canonical 序列化，供 calibration 报告打 stale 标记。
 *
 * 隔离边界：本文件无网络、无 .env、无 Client import；只读文件系统。
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 已核对的规则版本（加载器只允许这些版本，其余 fail closed）。 */
export const SUPPORTED_RULES_VERSIONS = ["v0.11", "v0.14"] as const;
export type RulesVersion = (typeof SUPPORTED_RULES_VERSIONS)[number];

export interface EvidenceDocs {
  readonly repo: string;
  readonly commit: string;
  readonly rulesVersion: string;
  readonly apiVersion: string;
}

/** SDK 镜像证据（v0.11 自迁移起存在；v0.14 于 2026-08-07 补上——官方 SDK
 *  v0.2.9 发布后完成 unit_cost 钉定核对，verifyMirror 对两种版本统一生效）。 */
interface EvidenceSdk {
  readonly repo: string;
  readonly tag: string;
  readonly publicCommit: string;
  readonly documentedCommit: string;
  readonly documentedCommitStatus: string;
  readonly mirrorDir: string;
  readonly mirrorFileCount: number;
  readonly mirrorAggregateSha256: string;
}

export interface EvidenceServerSource {
  readonly status: string;
  readonly note: string;
}

export interface RulesCore {
  readonly minCapacity: number;
  readonly capacityPerUnit: number;
  readonly maxHp: number;
  readonly maxShield: number;
  readonly maxShieldWithBeacon: number;
  readonly visionRadius: number;
  readonly startingResources: number;
  readonly startingWorkerCount: number;
}

export interface RulesUnits {
  readonly workerHp: number;
  readonly vanguardHp: number;
  readonly rangerHp: number;
  readonly workerCargoCapacity: number;
  readonly workerVisionRadius: number;
  readonly vanguardVisionRadius: number;
  readonly rangerVisionRadius: number;
}

export interface RulesEconomy {
  readonly harvestAmount: number;
  readonly harvestAmountWithBeacon: number;
  readonly healCostPerHp: number;
  readonly repairShieldCost: number;
  readonly refillEveryTicks: number;
}

export interface RulesMovement {
  readonly cellEntityCapacity: number;
  readonly maxCellsPerTick: number;
  readonly samePlayerTieBreak: string;
  readonly crossPlayerContested: string;
}

/**
 * respawn resolver 配置（P13，可选；2026-08-09 P4g 配置化）。
 * server 未公开这些放置参数（respawn.ts 原为硬编码常量）；内置已发布
 * manifest（rules-v0.11/v0.14.json）不含本节点——缺省回退现有常量，不改
 * 已发布 manifest 的 hash。仅外部自定义 rules 文件可携带本节点覆盖。
 */
export interface RulesRespawn {
  /** 距最近活 Core 的最小 Manhattan 距离。 */
  readonly minDistance: number;
  /** 距最近活 Core 的最大 Manhattan 距离。 */
  readonly maxDistance: number;
  /** 候选格至少需要的可通行（非障碍）邻居数。 */
  readonly minPassableNeighbors: number;
  /** 附近实体密度统计半径（Manhattan）。 */
  readonly densityRadius: number;
}

export interface RulesSettlement {
  readonly officialPhaseCount: number;
  readonly localPhaseCount: number;
  readonly granularityNote: string;
}

export interface RulesConstraints {
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
}

/** 两版本共享的规则段（v0.14 沿用 v0.11 数值；v0.14 只替换价格/维护两段）。 */
export interface RulesCommon {
  readonly core: RulesCore;
  readonly units: RulesUnits;
  readonly economy: RulesEconomy;
  readonly movement: RulesMovement;
  readonly settlement: RulesSettlement;
  /** 可选：respawn resolver 放置参数覆盖（仅外部自定义 rules 文件携带）。 */
  readonly respawn?: RulesRespawn;
}

/** v0.11 专属：静态 spawn 价格。 */
export interface RulesProduction {
  readonly workerCost: number;
  readonly vanguardCost: number;
  readonly rangerCost: number;
  readonly maxSpawnPerTick: number;
}

/** v0.11 专属：per-Tick 维护机制。 */
export interface RulesUpkeep {
  readonly tierSize: number;
  readonly deficitProtectionCount: number;
  readonly deficitDamage: {
    readonly semantics: string;
    readonly status: string;
    readonly note: string;
  };
}

/** v0.14 专属：动态价格公式参数（官方 changelog 2026-08-06）。 */
export interface DynamicPricingParams {
  /** 前 N 个单位保持 base 价（官方公式中的常量 20）。 */
  readonly tierSize: number;
  /** 官方公式 (13/10)；解析器只接受 13/10，其余 fail closed。 */
  readonly growthFactor: number;
  /** k 的步长（官方公式中的常量 5）。 */
  readonly tierStep: number;
  /** 官方公式 round_half_up；解析器只接受该值，其余 fail closed。 */
  readonly rounding: "round_half_up";
}

/** v0.14 专属：动态单位价格（base 价 WORKER=5 / VANGUARD=10 / RANGER=12）。 */
export interface UnitCostsV014 {
  readonly base: {
    readonly WORKER: number;
    readonly VANGUARD: number;
    readonly RANGER: number;
  };
  readonly dynamicPricing: DynamicPricingParams;
}

/** v0.11 manifest（schemaVersion 1；含静态价格 + 维护机制）。 */
export interface RulesManifestV011 {
  readonly schemaVersion: number;
  readonly rulesVersion: "v0.11";
  readonly verifiedAt: string;
  readonly evidence: {
    readonly docs: EvidenceDocs;
    readonly sdk: EvidenceSdk;
    readonly serverSource: EvidenceServerSource;
    readonly discrepancies: readonly string[];
  };
  readonly rules: RulesV011;
  readonly constraints: RulesConstraints;
}

/** v0.14 manifest（schemaVersion 1；动态价格替换维护，maintenance: removed）。 */
export interface RulesManifestV014 {
  readonly schemaVersion: number;
  readonly rulesVersion: "v0.14";
  readonly verifiedAt: string;
  readonly evidence: {
    readonly docs: EvidenceDocs;
    readonly sdk: EvidenceSdk;
    readonly serverSource: EvidenceServerSource;
    readonly discrepancies: readonly string[];
  };
  readonly rules: RulesV014;
  readonly constraints: RulesConstraints;
}

/** v0.11 专属规则段（共享段 + 静态价格 + 维护机制）。 */
export interface RulesV011 extends RulesCommon {
  readonly production: RulesProduction;
  readonly upkeep: RulesUpkeep;
}

/** v0.14 专属规则段（共享段 + 动态价格；维护机制移除）。 */
export interface RulesV014 extends RulesCommon {
  readonly unitCosts: UnitCostsV014;
  readonly maintenance: {
    readonly status: "removed";
    readonly note: string;
  };
}

/** 版本判别联合：未知版本在 parse 层即拒绝，消费方按 rulesVersion 收窄。 */
export type RulesManifest = RulesManifestV011 | RulesManifestV014;

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

function assertNumberField(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RulesManifestError(`invalid number at ${path}: ${String(value)}`);
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

/* ---------------- 共享规则段校验（两版本共用，错误路径不变） ---------------- */

function parseRulesCore(raw: Record<string, unknown>): RulesCore {
  return Object.freeze({
    minCapacity: assertIntField(raw.minCapacity, "rules.core.minCapacity"),
    capacityPerUnit: assertIntField(raw.capacityPerUnit, "rules.core.capacityPerUnit"),
    maxHp: assertIntField(raw.maxHp, "rules.core.maxHp"),
    maxShield: assertIntField(raw.maxShield, "rules.core.maxShield"),
    maxShieldWithBeacon: assertIntField(raw.maxShieldWithBeacon, "rules.core.maxShieldWithBeacon"),
    visionRadius: assertIntField(raw.visionRadius, "rules.core.visionRadius"),
    startingResources: assertIntField(raw.startingResources, "rules.core.startingResources"),
    startingWorkerCount: assertIntField(raw.startingWorkerCount, "rules.core.startingWorkerCount"),
  });
}

function parseRulesUnits(raw: Record<string, unknown>): RulesUnits {
  return Object.freeze({
    workerHp: assertIntField(raw.workerHp, "rules.units.workerHp"),
    vanguardHp: assertIntField(raw.vanguardHp, "rules.units.vanguardHp"),
    rangerHp: assertIntField(raw.rangerHp, "rules.units.rangerHp"),
    workerCargoCapacity: assertIntField(raw.workerCargoCapacity, "rules.units.workerCargoCapacity"),
    workerVisionRadius: assertIntField(raw.workerVisionRadius, "rules.units.workerVisionRadius"),
    vanguardVisionRadius: assertIntField(raw.vanguardVisionRadius, "rules.units.vanguardVisionRadius"),
    rangerVisionRadius: assertIntField(raw.rangerVisionRadius, "rules.units.rangerVisionRadius"),
  });
}

function parseRulesEconomy(raw: Record<string, unknown>): RulesEconomy {
  return Object.freeze({
    harvestAmount: assertIntField(raw.harvestAmount, "rules.economy.harvestAmount"),
    harvestAmountWithBeacon: assertIntField(raw.harvestAmountWithBeacon, "rules.economy.harvestAmountWithBeacon"),
    healCostPerHp: assertIntField(raw.healCostPerHp, "rules.economy.healCostPerHp"),
    repairShieldCost: assertIntField(raw.repairShieldCost, "rules.economy.repairShieldCost"),
    refillEveryTicks: assertIntField(raw.refillEveryTicks, "rules.economy.refillEveryTicks"),
  });
}

function parseRulesMovement(raw: Record<string, unknown>): RulesMovement {
  return Object.freeze({
    cellEntityCapacity: assertIntField(raw.cellEntityCapacity, "rules.movement.cellEntityCapacity"),
    maxCellsPerTick: assertIntField(raw.maxCellsPerTick, "rules.movement.maxCellsPerTick"),
    samePlayerTieBreak: assertStringField(raw.samePlayerTieBreak, "rules.movement.samePlayerTieBreak"),
    crossPlayerContested: assertStringField(raw.crossPlayerContested, "rules.movement.crossPlayerContested"),
  });
}

function parseRulesSettlement(raw: Record<string, unknown>): RulesSettlement {
  return Object.freeze({
    officialPhaseCount: assertIntField(raw.officialPhaseCount, "rules.settlement.officialPhaseCount"),
    localPhaseCount: assertIntField(raw.localPhaseCount, "rules.settlement.localPhaseCount"),
    granularityNote: assertStringField(raw.granularityNote, "rules.settlement.granularityNote"),
  });
}

/**
 * 可选 respawn 配置节（P4g，2026-08-09）。缺省不出现（内置已发布 manifest
 * 不含本节点，解析结果与旧版逐字节一致 → manifestHash 不变）；出现时
 * fail closed 校验数值范围与区间自洽。
 */
function parseRulesRespawn(raw: Record<string, unknown>): RulesRespawn {
  const minDistance = assertIntField(raw.minDistance, "rules.respawn.minDistance");
  const maxDistance = assertIntField(raw.maxDistance, "rules.respawn.maxDistance");
  if (minDistance < 1) {
    throw new RulesManifestError(`rules.respawn.minDistance must be a positive integer, got ${minDistance}`);
  }
  if (maxDistance < minDistance) {
    throw new RulesManifestError(
      `rules.respawn.maxDistance (${maxDistance}) must be >= minDistance (${minDistance})`,
    );
  }
  // 邻居数上限 4（四方向），0 = 不要求可通行邻居。
  const minPassableNeighbors = assertIntField(
    raw.minPassableNeighbors,
    "rules.respawn.minPassableNeighbors",
    4,
  );
  if (raw.densityRadius === undefined) {
    throw new RulesManifestError("rules.respawn.densityRadius is required");
  }
  const densityRadius = assertIntField(raw.densityRadius, "rules.respawn.densityRadius", 1_000);
  if (densityRadius < 1) {
    throw new RulesManifestError(`rules.respawn.densityRadius must be a positive integer, got ${densityRadius}`);
  }
  return Object.freeze({ minDistance, maxDistance, minPassableNeighbors, densityRadius });
}

function parseRulesCommon(raw: Record<string, unknown>): RulesCommon {
  return Object.freeze({
    core: parseRulesCore(assertRecord(raw.core, "rules.core")),
    units: parseRulesUnits(assertRecord(raw.units, "rules.units")),
    economy: parseRulesEconomy(assertRecord(raw.economy, "rules.economy")),
    movement: parseRulesMovement(assertRecord(raw.movement, "rules.movement")),
    settlement: parseRulesSettlement(assertRecord(raw.settlement, "rules.settlement")),
    ...(raw.respawn === undefined
      ? {}
      : { respawn: parseRulesRespawn(assertRecord(raw.respawn, "rules.respawn")) }),
  });
}

function parseConstraints(raw: Record<string, unknown>): RulesConstraints {
  const coordinate = assertRecord(raw.coordinate, "constraints.coordinate");
  const uuidTieBreak = assertRecord(raw.uuidTieBreak, "constraints.uuidTieBreak");
  const refill = assertRecord(raw.refill, "constraints.refill");
  return Object.freeze({
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
    settlementOrder: assertStringField(raw.settlementOrder, "constraints.settlementOrder"),
  });
}

function parseSdkEvidence(sdk: Record<string, unknown>): EvidenceSdk {
  return Object.freeze({
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
  });
}

function parseRulesManifestV011(root: Record<string, unknown>): RulesManifestV011 {
  const rulesVersion = assertStringField(root.rulesVersion, "rulesVersion");
  if (rulesVersion !== "v0.11") {
    throw new RulesManifestError(`rules version mismatch: manifest=${rulesVersion}, required=v0.11`);
  }
  const verifiedAt = assertStringField(root.verifiedAt, "verifiedAt");

  const evidence = assertRecord(root.evidence, "evidence");
  const docs = assertRecord(evidence.docs, "evidence.docs");
  const sdk = assertRecord(evidence.sdk, "evidence.sdk");
  const serverSource = assertRecord(evidence.serverSource, "evidence.serverSource");
  const discrepancies = assertStringArray(evidence.discrepancies, "evidence.discrepancies");

  const rules = assertRecord(root.rules, "rules");
  const production = assertRecord(rules.production, "rules.production");
  const upkeep = assertRecord(rules.upkeep, "rules.upkeep");
  const deficitDamage = assertRecord(upkeep.deficitDamage, "rules.upkeep.deficitDamage");

  return Object.freeze({
    schemaVersion: 1,
    rulesVersion,
    verifiedAt,
    evidence: Object.freeze({
      docs: Object.freeze({
        repo: assertStringField(docs.repo, "evidence.docs.repo"),
        commit: assertStringField(docs.commit, "evidence.docs.commit"),
        rulesVersion: assertStringField(docs.rulesVersion, "evidence.docs.rulesVersion"),
        apiVersion: assertStringField(docs.apiVersion, "evidence.docs.apiVersion"),
      }),
      sdk: parseSdkEvidence(sdk),
      serverSource: Object.freeze({
        status: assertStringField(serverSource.status, "evidence.serverSource.status"),
        note: assertStringField(serverSource.note, "evidence.serverSource.note"),
      }),
      discrepancies: discrepancies,
    }),
    rules: {
      ...parseRulesCommon(rules),
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
    },
    constraints: parseConstraints(assertRecord(root.constraints, "constraints")),
  });
}
function parseRulesManifestV014(root: Record<string, unknown>): RulesManifestV014 {
  const rulesVersion = assertStringField(root.rulesVersion, "rulesVersion");
  if (rulesVersion !== "v0.14") {
    throw new RulesManifestError(`rules version mismatch: manifest=${rulesVersion}, required=v0.14`);
  }
  const verifiedAt = assertStringField(root.verifiedAt, "verifiedAt");

  const evidence = assertRecord(root.evidence, "evidence");
  const docs = assertRecord(evidence.docs, "evidence.docs");
  const sdk = assertRecord(evidence.sdk, "evidence.sdk");
  const serverSource = assertRecord(evidence.serverSource, "evidence.serverSource");
  const discrepancies = assertStringArray(evidence.discrepancies, "evidence.discrepancies");

  const rules = assertRecord(root.rules, "rules");
  const unitCosts = assertRecord(rules.unitCosts, "rules.unitCosts");
  const base = assertRecord(unitCosts.base, "rules.unitCosts.base");
  const dynamicPricing = assertRecord(unitCosts.dynamicPricing, "rules.unitCosts.dynamicPricing");
  const maintenance = assertRecord(rules.maintenance, "rules.maintenance");

  // 动态价格只核对过官方 changelog 给出的唯一参数组合，其余 fail closed。
  const growthFactor = assertNumberField(
    dynamicPricing.growthFactor,
    "rules.unitCosts.dynamicPricing.growthFactor",
  );
  if (growthFactor !== 13 / 10) {
    throw new RulesManifestError(
      `unsupported growthFactor: ${growthFactor} (only 13/10 is verified against the official formula)`,
    );
  }
  const rounding = assertStringField(dynamicPricing.rounding, "rules.unitCosts.dynamicPricing.rounding");
  if (rounding !== "round_half_up") {
    throw new RulesManifestError(`unsupported rounding: ${rounding} (only round_half_up is verified)`);
  }
  const maintenanceStatus = assertStringField(maintenance.status, "rules.maintenance.status");
  if (maintenanceStatus !== "removed") {
    throw new RulesManifestError(
      `unsupported maintenance status: ${maintenanceStatus} (v0.14 removes maintenance)`,
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    rulesVersion,
    verifiedAt,
    evidence: Object.freeze({
      docs: Object.freeze({
        repo: assertStringField(docs.repo, "evidence.docs.repo"),
        commit: assertStringField(docs.commit, "evidence.docs.commit"),
        rulesVersion: assertStringField(docs.rulesVersion, "evidence.docs.rulesVersion"),
        apiVersion: assertStringField(docs.apiVersion, "evidence.docs.apiVersion"),
      }),
      sdk: parseSdkEvidence(sdk),
      serverSource: Object.freeze({
        status: assertStringField(serverSource.status, "evidence.serverSource.status"),
        note: assertStringField(serverSource.note, "evidence.serverSource.note"),
      }),
      discrepancies: discrepancies,
    }),
    rules: {
      ...parseRulesCommon(rules),
      unitCosts: Object.freeze({
        base: Object.freeze({
          WORKER: assertIntField(base.WORKER, "rules.unitCosts.base.WORKER"),
          VANGUARD: assertIntField(base.VANGUARD, "rules.unitCosts.base.VANGUARD"),
          RANGER: assertIntField(base.RANGER, "rules.unitCosts.base.RANGER"),
        }),
        dynamicPricing: Object.freeze({
          tierSize: assertIntField(dynamicPricing.tierSize, "rules.unitCosts.dynamicPricing.tierSize", 1_000),
          growthFactor,
          tierStep: assertIntField(dynamicPricing.tierStep, "rules.unitCosts.dynamicPricing.tierStep", 1_000),
          rounding,
        }),
      }),
      maintenance: Object.freeze({
        status: maintenanceStatus,
        note: assertStringField(maintenance.note, "rules.maintenance.note"),
      }),
    },
    constraints: parseConstraints(assertRecord(root.constraints, "constraints")),
  });
}
/** 深度校验并归一化（不可变）。按 rulesVersion 分派解析器；任何必填缺失/
 *  类型错误/未核对版本都抛错。 */
export function parseRulesManifest(raw: unknown): RulesManifest {
  const root = assertRecord(raw, "root");
  const schemaVersion = assertIntField(root.schemaVersion, "schemaVersion");
  if (schemaVersion !== 1) {
    throw new RulesManifestError(`unsupported schemaVersion: ${schemaVersion}`);
  }
  const rulesVersion = assertStringField(root.rulesVersion, "rulesVersion");
  switch (rulesVersion) {
    case "v0.11":
      return parseRulesManifestV011(root);
    case "v0.14":
      return parseRulesManifestV014(root);
    default:
      throw new RulesManifestError(
        `unsupported rules version: ${rulesVersion} (supported: ${SUPPORTED_RULES_VERSIONS.join(", ")})`,
      );
  }
}

/** 从文件加载 manifest。文件不存在/解析失败/校验失败一律抛错。 */
export function loadRulesManifest(path: string): RulesManifest {
  const text = readFileSync(path, "utf8");
  return parseRulesManifest(JSON.parse(text));
}

/** 内置 contracts 目录（rules-<version>.json 所在）。 */
const CONTRACTS_DIR = dirname(fileURLToPath(import.meta.url));

/** 按版本选择内置规则文件加载；未知版本先 fail closed，不触碰文件系统。 */
export function loadRulesManifestForVersion(version: RulesVersion): RulesManifest {
  if (!SUPPORTED_RULES_VERSIONS.includes(version)) {
    throw new RulesManifestError(`unsupported rules version: ${version}`);
  }
  const manifest = loadRulesManifest(join(CONTRACTS_DIR, `rules-${version}.json`));
  assertRulesSupported(manifest, version);
  return manifest;
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

/** manifest 内容 hash（SHA-256，canonical；两版本通用）。 */
export function manifestHash(manifest: RulesManifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

/** 目录聚合 SHA-256：文件名排序 → 每文件 "hash  name" 行 → 整体 sha256（与 bash 工具一致）。
 *  只聚合文件（跳过子目录，如 __pycache__ 等运行产物——防止运行时生成物造成漂移误报）。 */
export function directoryAggregateSha256(dirPath: string): { aggregate: string; fileCount: number } {
  const entries = readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const lines: string[] = [];
  for (const name of entries) {
    const content = readFileSync(join(dirPath, name));
    const digest = createHash("sha256").update(content).digest("hex");
    lines.push(`${digest}  ${name}`);
  }
  const aggregate = createHash("sha256").update(lines.join("\n") + "\n").digest("hex");
  return { aggregate, fileCount: entries.length };
}

/** 验证本地 SDK 镜像与 manifest 锁定值一致（检测镜像漂移）。返回 null 表示一致。
 *  v0.11 与 v0.14 统一生效（两版本 evidence.sdk 均已核对；v0.14 于 2026-08-07
 *  在官方 SDK v0.2.9 发布后完成 183/183 unit_cost 钉定核对）。 */
export function verifyMirror(
  manifest: RulesManifestV011 | RulesManifestV014,
  mirrorDir: string,
): string | null {
  const { aggregate, fileCount } = directoryAggregateSha256(mirrorDir);
  if (fileCount !== manifest.evidence.sdk.mirrorFileCount) {
    return `mirror file count mismatch: expected ${manifest.evidence.sdk.mirrorFileCount}, got ${fileCount}`;
  }
  if (aggregate !== manifest.evidence.sdk.mirrorAggregateSha256) {
    return `mirror aggregate sha256 mismatch: expected ${manifest.evidence.sdk.mirrorAggregateSha256}, got ${aggregate}`;
  }
  return null;
}
