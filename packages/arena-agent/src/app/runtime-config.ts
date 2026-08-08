/**
 * 运行配置（切片 4 阶段 5，Agent B 地界，leader 接管）。
 *
 * 安全约束（GPT 裁决）：配置只保存环境变量名（arenaTokenEnv），**绝不存密钥明文**。
 * TypeBox schema 单源（TypeBox 已有依赖，4B 工具在用）。
 */

import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";

// P0-1：模式类型单源在 runtime/decision-types.ts（GPT 裁决：决策类型只定义一次）
export type { DecisionModeName, SubmissionModeName } from "../runtime/decision-types.ts";

export const DEFAULT_DEADLINES = {
  agentSoftMs: 6000,
  selectionMs: 7000,
  submitMs: 8500,
  hardMs: 9500,
} as const;

export const RuntimeConfigSchema = Type.Object(
  {
    tenantId: Type.String({ minLength: 1 }),
    /** 环境变量名（不是密钥本身）；运行时从 process.env 读取。 */
    arenaTokenEnv: Type.String({ minLength: 1 }),
    decisionMode: Type.Union([
      Type.Literal("safety"),
      Type.Literal("deterministic"),
      Type.Literal("agent-shadow"),
      Type.Literal("hybrid"),
    ]),
    submitEnabled: Type.Boolean(),
    model: Type.Object(
      {
        provider: Type.String({ minLength: 1 }),
        id: Type.String({ minLength: 1 }),
        thinkingLevel: Type.Optional(
          Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
        ),
      },
      { additionalProperties: false },
    ),
    deadlines: Type.Optional(
      Type.Object(
        {
          agentSoftMs: Type.Number({ minimum: 100 }),
          selectionMs: Type.Number({ minimum: 100 }),
          submitMs: Type.Number({ minimum: 100 }),
          hardMs: Type.Number({ minimum: 100 }),
        },
        { additionalProperties: false },
      ),
    ),
    costLimitUsd: Type.Optional(Type.Number({ minimum: 0 })),
    /** 低频 MacroPolicy 策略决策周期（ticks，缺省 32；0/缺省 = 不启用策略层）。 */
    policyIntervalTicks: Type.Optional(Type.Integer({ minimum: 1 })),
    /**
     * 候选变体声明（2026-08-06 架构整理）：SafetyPlanner 变体 id 列表
     * （见 strategies/variant-registry.ts 注册映射，如 ["threat-recall-v1"]）。
     * 启用 = 改配置声明（不再改代码布尔）；未知 id 在运行时 fail-fast。
     * 缺省 = 无变体（历史行为零回归）。
     */
    variants: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    /**
     * mission 参数化覆盖（2026-08-08，worker-mission-v1 Phase 2）：逐项覆盖
     * 注册表默认（变体=类别、config=强度）——热加载即可在线调参（floor/cap/
     * 距离/预测阈值），无需重启。缺省 = 注册表默认（零回归）。
     */
    mission: Type.Optional(
      Type.Object(
        {
          collectionValueFloor: Type.Optional(Type.Number()),
          maxCollectionDistance: Type.Optional(Type.Number({ minimum: 1 })),
          surveyWorkerCap: Type.Optional(Type.Integer({ minimum: 0 })),
          surveyBurstTicks: Type.Optional(Type.Integer({ minimum: 0 })),
          surveyWorkerFloor: Type.Optional(Type.Integer({ minimum: 0 })),
          visibleBonus: Type.Optional(Type.Number()),
          seedAgeDecay: Type.Optional(Type.Number({ minimum: 0 })),
          refillLookahead: Type.Optional(Type.Integer({ minimum: 0 })),
          refillBonus: Type.Optional(Type.Number({ minimum: 0 })),
          deadMineOverdueTicks: Type.Optional(Type.Integer({ minimum: 0 })),
          migrationScout: Type.Optional(Type.Boolean()),
          alwaysSurvey: Type.Optional(Type.Boolean()),
          switchThreshold: Type.Optional(Type.Number({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
    /** 固定策略覆盖（实验框架）：非空时绕过 LLM 决策，恒用该策略
     *  （posture/workerTarget/militaryRatio/focusRegion/attackPriority 全量）。 */
    policyOverride: Type.Optional(
      Type.Object(
        {
          posture: Type.Union([Type.Literal("harvest"), Type.Literal("balanced"), Type.Literal("aggressive")]),
          workerTarget: Type.Integer({ minimum: 1, maximum: 16 }),
          militaryRatio: Type.Number({ minimum: 0, maximum: 1 }),
          focusRegion: Type.Union([Type.Null(), Type.Tuple([Type.Integer(), Type.Integer()])]),
          attackPriority: Type.Union([
            Type.Null(),
            Type.Literal("core"),
            Type.Literal("workers"),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
    /** Pi/Provider 熔断器（Track B）：连续失败阈值 + open 冷却时长。 */
    circuitBreaker: Type.Optional(
      Type.Object(
        {
          /** 连续失败次数（缺省 3），达到后电路 open（停止 Pi 请求）。 */
          failureThreshold: Type.Number({ minimum: 1 }),
          /** open 冷却时长 ms（缺省 30000），冷却后进入 half-open 单次试探。 */
          openMs: Type.Number({ minimum: 100 }),
        },
        { additionalProperties: false },
      ),
    ),
    /** 运行时根目录（锁/会话/遥测），缺省 "runtime"。 */
    baseDir: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type TenantRuntimeConfig = Static<typeof RuntimeConfigSchema>;

/** 加载并校验配置；非法抛错（含字段路径）。 */
export function loadRuntimeConfig(path: string): TenantRuntimeConfig {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  const validator = Compile(RuntimeConfigSchema);
  if (!validator.Check(raw)) {
    const detail = [...validator.Errors(raw)]
      .map((e) => `${(e as { path?: string }).path ?? "(root)"}: ${e.message}`)
      .join("; ");
    throw new Error(`invalid runtime config ${path}: ${detail}`);
  }
  return raw as TenantRuntimeConfig;
}

/** 缺省合并后的完整 deadlines。 */
export interface ResolvedDeadlines {
  readonly agentSoftMs: number;
  readonly selectionMs: number;
  readonly submitMs: number;
  readonly hardMs: number;
}

export function resolveDeadlines(config: TenantRuntimeConfig): ResolvedDeadlines {
  return { ...DEFAULT_DEADLINES, ...(config.deadlines ?? {}) };
}

/** 熔断器缺省（Track B）：连续 3 次失败 open，冷却 30s。 */
export const DEFAULT_CIRCUIT_BREAKER = {
  failureThreshold: 3,
  openMs: 30000,
} as const;

export interface ResolvedCircuitBreaker {
  readonly failureThreshold: number;
  readonly openMs: number;
}

export function resolveCircuitBreaker(config: TenantRuntimeConfig): ResolvedCircuitBreaker {
  return { ...DEFAULT_CIRCUIT_BREAKER, ...(config.circuitBreaker ?? {}) };
}
