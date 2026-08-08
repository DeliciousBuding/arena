/**
 * 离线学习数据契约——JSON Schema 定义（作为 TS const 导出，供运行时校验和文档生成）。
 *
 * 每条契约格式：{ schema: string, description: string, properties: ... }
 * 不依赖外部 schema 库（ajv/typebox），消费者可用任意 JSON Schema 校验器。
 */

export const TRAJECTORY_V1_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://arena.tokendancelab.com/schemas/offline-learning/trajectory-v1",
  title: "TrajectoryV1",
  description:
    "Episode-level trajectory for offline RL. Each trajectory is a complete episode " +
    "with sequential (state, action, label) steps. Suitable for BC, DAgger, " +
    "Decision Transformer, MAPPO, QMIX, and other sequence models.",
  type: "object",
  required: ["schema", "trajectoryId", "metadata", "steps"],
  properties: {
    schema: { type: "string", const: "trajectory-v1" },
    trajectoryId: {
      type: "string",
      description: "Deterministic SHA-256 hash of steps array content.",
      pattern: "^[0-9a-f]{64}$",
    },
    metadata: {
      type: "object",
      required: ["episodeId", "tenantId", "rulesVersion", "seed", "tickCount", "source"],
      properties: {
        episodeId: { type: "string" },
        tenantId: { type: "string" },
        rulesVersion: { type: "string", pattern: "^v\\d+\\.\\d+$" },
        rulesManifestHash: { type: "string" },
        seed: { type: "integer" },
        tickCount: { type: "integer", minimum: 1 },
        source: { type: "string", enum: ["sim", "live"] },
        sourceCommit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        engineVersion: { type: "string" },
        startedAt: { type: "string", format: "date-time" },
        completedAt: { type: "string", format: "date-time" },
      },
    },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["state", "action", "label"],
        properties: {
          state: { $ref: "#/$defs/stepState" },
          action: { $ref: "#/$defs/stepAction" },
          label: { $ref: "#/$defs/stepLabel" },
        },
      },
    },
  },
  $defs: {
    stepState: {
      type: "object",
      required: ["tick", "resources", "population", "corePosition", "threatLevel"],
      properties: {
        tick: { type: "integer", minimum: 1 },
        resources: { type: "integer", minimum: 0 },
        resourceCapacity: { type: "integer", minimum: 0 },
        population: { type: "integer", minimum: 0 },
        workers: { type: "integer", minimum: 0 },
        vanguards: { type: "integer", minimum: 0 },
        rangers: { type: "integer", minimum: 0 },
        coreHp: { type: "integer", minimum: 0 },
        coreShield: { type: "integer", minimum: 0 },
        corePosition: { type: "array", minItems: 2, maxItems: 2, items: { type: "integer" } },
        coreState: { type: "string" },
        visibleResourceCells: { type: "integer", minimum: 0 },
        carriedResources: { type: "integer", minimum: 0 },
        visibleEnemyUnits: { type: "integer", minimum: 0 },
        visibleEnemyCombat: { type: "integer", minimum: 0 },
        visibleEnemyCores: { type: "integer", minimum: 0 },
        nearestEnemyCoreDist: { type: ["integer", "null"], minimum: 0 },
        nearestEnemyCombatDist: { type: ["integer", "null"], minimum: 0 },
        threatLevel: { type: "string", enum: ["NORMAL", "ALERT", "ENGAGED", "BREAKOUT"] },
      },
    },
    stepAction: {
      type: "object",
      required: ["actionCounts", "coreAction", "planHash"],
      properties: {
        actionCounts: { type: "object", additionalProperties: { type: "integer" } },
        coreAction: { type: ["string", "null"] },
        spawnUnitType: { type: ["string", "null"] },
        intents: { type: "array", items: { type: "string" } },
        planHash: { type: "string", pattern: "^[0-9a-f]{8}$" },
      },
    },
    stepLabel: {
      type: "object",
      required: ["immediateResourceDelta", "deaths", "netResourceDelta20", "deathProb20", "coreRisk50", "windowComplete"],
      properties: {
        immediateResourceDelta: { type: "integer" },
        immediatePopulationDelta: { type: "integer" },
        deaths: { type: "integer", minimum: 0 },
        netResourceDelta20: { type: "integer" },
        deathProb20: { type: "number", minimum: 0, maximum: 1 },
        coreRisk50: { type: "integer", enum: [0, 1] },
        windowComplete: { type: "boolean" },
      },
    },
  },
} as const);

export const FEATURE_VECTOR_V1_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://arena.tokendancelab.com/schemas/offline-learning/feature-vector-v1",
  title: "FeatureVectorV1",
  description:
    "Standardized 31-dimensional feature vector extracted from a single tick state. " +
    "Designed for JSONL row or Arrow column serialization. Grouped into spatial (6), " +
    "economic (6), military (8), threat (8), and global (3) dimensions.",
  type: "object",
  required: ["schema", "features", "tick", "tenantId"],
  properties: {
    schema: { type: "string", const: "feature-vector-v1" },
    features: {
      type: "object",
      description: "Named feature values, keyed by FEATURE_NAMES.",
      additionalProperties: { type: "number" },
      minProperties: 31,
      maxProperties: 31,
    },
    tick: { type: "integer", minimum: 1 },
    tenantId: { type: "string" },
    episodeId: { type: "string" },
  },
} as const);

export const BENCHMARK_RESULT_V1_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://arena.tokendancelab.com/schemas/offline-learning/benchmark-result-v1",
  title: "BenchmarkResultV1",
  description:
    "Result of a policy evaluation benchmark run. Contains per-episode metrics, " +
    "aggregate statistics, and reproducibility info (seed, commit, rules version).",
  type: "object",
  required: ["schema", "benchmarkId", "policyId", "createdAt", "config", "episodes", "aggregate"],
  properties: {
    schema: { type: "string", const: "benchmark-result-v1" },
    benchmarkId: { type: "string" },
    policyId: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    config: {
      type: "object",
      required: ["seeds", "ticksPerEpisode", "rulesVersion"],
      properties: {
        seeds: { type: "array", items: { type: "integer" } },
        ticksPerEpisode: { type: "integer", minimum: 1 },
        rulesVersion: { type: "string" },
        rulesManifestHash: { type: "string" },
        sourceCommit: { type: "string" },
        engineVersion: { type: "string" },
      },
    },
    episodes: {
      type: "array",
      items: {
        type: "object",
        required: ["episodeId", "seed", "metrics"],
        properties: {
          episodeId: { type: "string" },
          seed: { type: "integer" },
          metrics: { $ref: "#/$defs/episodeMetrics" },
        },
      },
    },
    aggregate: { $ref: "#/$defs/episodeMetrics" },
  },
  $defs: {
    episodeMetrics: {
      type: "object",
      required: ["survivalTicks", "finalResources", "finalPopulation", "totalResourcesCollected",
        "totalDeaths", "totalSpawns", "combatKills", "coreDestroyed", "meanThreatLevel"],
      properties: {
        survivalTicks: { type: "integer", minimum: 0 },
        finalResources: { type: "integer", minimum: 0 },
        finalPopulation: { type: "integer", minimum: 0 },
        totalResourcesCollected: { type: "integer", minimum: 0 },
        totalDeaths: { type: "integer", minimum: 0 },
        totalSpawns: { type: "integer", minimum: 0 },
        combatKills: { type: "integer", minimum: 0 },
        coreDestroyed: { type: "boolean" },
        meanThreatLevel: { type: "number", minimum: 0, maximum: 3 },
        peakPopulation: { type: "integer", minimum: 0 },
        peakResources: { type: "integer", minimum: 0 },
        efficiencyRatio: { type: "number", minimum: 0 },
        illegalPlans: { type: "integer", minimum: 0 },
        repairedPlans: { type: "integer", minimum: 0 },
      },
    },
  },
} as const);

/** 所有契约的索引。 */
export const ALL_CONTRACTS = Object.freeze({
  "trajectory-v1": TRAJECTORY_V1_SCHEMA,
  "feature-vector-v1": FEATURE_VECTOR_V1_SCHEMA,
  "benchmark-result-v1": BENCHMARK_RESULT_V1_SCHEMA,
} as const);
