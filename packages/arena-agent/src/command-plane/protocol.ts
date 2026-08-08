/**
 * AI 指挥接入层——意图协议（command-plane v1，2026-08-08）。
 *
 * 让 Codex / Claude Code 以"意图（Intent）"为单位下发高级命令，系统负责
 * 展开成多 tick 执行计划 + 安全护栏 + 冲突仲裁 + 审计。纯函数、无副作用，
 * 落盘统一走 human-commands（现有单 writer 路径）。
 */

/** 命令来源：人类手操 > AI（codex/claude） > deterministic agent。 */
export type Issuer = "human" | "codex" | "claude" | "agent";

/** v1 意图清单。 */
export type IntentKind =
  | "core_migrate"    // 核心分阶段迁移
  | "squad_attack"    // 编队攻击目标
  | "squad_patrol"    // 编队巡逻/侦察
  | "worker_mine"     // worker 采矿目标
  | "worker_relocate" // worker 疏散/待命
  | "core_guard";     // 核心防御布阵

/** 意图约束（护栏参数，AI 可显式收紧）。 */
export interface IntentConstraints {
  /** 敌核贴脸半径：目标/路径不得进入敌核该半径内（Chebyshev）。 */
  readonly avoidEnemyWithin?: number;
  /** 单阶段最大步数（长途拆段用）。 */
  readonly maxStepDistance?: number;
  /** 迁核是否要求军事护航（核心前方 VANGUARD 占位）。 */
  readonly requireMilitaryEscort?: boolean;
  /** 信标禁区半径（默认 60，-11,-1）。 */
  readonly beaconSafeRadius?: number;
  /** 是否强制放行护栏（须附 forceReason 留痕）。 */
  readonly force?: boolean;
  readonly forceReason?: string;
}

export interface CoreMigrateSpec {
  readonly kind: "core_migrate";
  /** 最终目标。 */
  readonly target: readonly [number, number];
  /** 分阶段目标（含最终），每段到站审计后推进。 */
  readonly phases: readonly (readonly [number, number])[];
}

export interface WorkerRelocateSpec {
  readonly kind: "worker_relocate";
  /** 疏散目标区（核心周边净空用）。 */
  readonly target: readonly [number, number];
  /** 疏散单位 ID 列表（空=核心 2 格内全部 worker）。 */
  readonly unitIds?: readonly string[];
}

export interface SquadAttackSpec {
  readonly kind: "squad_attack";
  /** 攻击目标（敌核或单位位置）。 */
  readonly target: readonly [number, number];
  /** 参与编队单位 ID（空=最近军事自动选）。 */
  readonly unitIds?: readonly string[];
}

export interface IntentSpec {
  readonly kind: IntentKind;
  readonly target: readonly [number, number];
  readonly phases?: readonly (readonly [number, number])[];
  readonly unitIds?: readonly string[];
}

/** 意图（command-plane 输入）。 */
export interface Intent {
  readonly schemaVersion: 1;
  readonly issuer: Exclude<Issuer, "agent">;
  readonly sessionId: string;
  readonly intentId: string;
  readonly spec: IntentSpec;
  readonly constraints?: IntentConstraints;
  /** TTL（tick）；超时自动取消。 */
  readonly ttlTicks?: number;
  readonly createdAt: string;
}

/** 意图展开后的执行计划（落盘到 human-commands 的形态）。 */
export interface ExecutionPlan {
  /** 单 tick 命令（commands）。 */
  readonly commands: readonly {
    readonly unitId: string;
    readonly action: Record<string, unknown>;
    readonly note: string;
  }[];
  /** 持续意图（goals：mine/goto）。 */
  readonly goals: readonly {
    readonly unitId: string;
    readonly kind: "mine" | "goto";
    readonly target: readonly [number, number];
    readonly note: string;
  }[];
}

/** 护栏拒绝原因。 */
export interface GuardrailReason {
  readonly code: string;
  readonly detail: string;
  readonly evidence?: Record<string, unknown>;
}

/** 意图下发结果。 */
export interface IntentDispatch {
  readonly accepted: boolean;
  readonly intentId: string;
  readonly reasons: readonly GuardrailReason[];
  /** 幂等命中（同 intentId 已存在）。 */
  readonly idempotentHit?: boolean;
}

/** 审计事件（append-only command-audit jsonl）。 */
export interface CommandAuditEvent {
  readonly ts: string;
  readonly tenant: string;
  readonly issuer: string;
  readonly sessionId: string;
  readonly intentId: string;
  readonly kind: string;
  readonly action: "accepted" | "rejected" | "expired" | "applied" | "cancelled";
  readonly reasons?: readonly GuardrailReason[];
  readonly evidence?: Record<string, unknown>;
}

/** schema 校验：返回错误列表（空=合法）。 */
export function validateIntent(intent: Intent): readonly string[] {
  const errs: string[] = [];
  if (intent.schemaVersion !== 1) errs.push("schemaVersion 必须为 1");
  if (!["codex", "claude", "human"].includes(intent.issuer)) errs.push("issuer 仅支持 codex/claude/human");
  if (!intent.sessionId || !intent.sessionId.trim()) errs.push("sessionId 不能为空");
  if (!intent.intentId || !intent.intentId.trim()) errs.push("intentId 不能为空");
  if (!intent.spec?.kind) errs.push("spec.kind 不能为空");
  const t = intent.spec.target;
  if (!Array.isArray(t) || t.length !== 2 || !t.every((n) => Number.isFinite(n))) {
    errs.push("spec.target 必须是 [x,y]");
  }
  if (intent.spec.kind === "core_migrate") {
    const phases = intent.spec.phases ?? [];
    if (phases.length === 0) errs.push("core_migrate 需要 phases");
    const last = phases[phases.length - 1];
    if (!last || last[0] !== t[0] || last[1] !== t[1]) {
      errs.push("core_migrate phases 末段必须等于 target");
    }
  }
  if (intent.constraints?.force && !intent.constraints.forceReason?.trim()) {
    errs.push("force=true 时必须提供 forceReason（审计留痕）");
  }
  return errs;
}
