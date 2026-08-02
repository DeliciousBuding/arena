/**
 * 运行配置（切片 4 阶段 5，Agent B 地界，leader 接管）。
 *
 * 安全约束（GPT 裁决）：配置只保存环境变量名（arenaTokenEnv），**绝不存密钥明文**。
 * TypeBox schema 单源（TypeBox 已有依赖，4B 工具在用）。
 */

import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";

export type DecisionModeName = "safety" | "deterministic" | "agent-shadow" | "hybrid";
export type SubmissionModeName = "disabled" | "live";

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
