/**
 * AllianceDirective 纯函数助手（Phase 0 contract freeze）。
 *
 * 核心语义（§15.5 / §24 fail-safe matrix）：
 * - 过期/无效/stale directive → 忽略联盟指令，回到现有 tenant planner（fail-open）。
 * - 合同层不含 Arena token、Plan、CandidateSink——不能成为 writer。
 * - 所有函数严格 deterministic、无 I/O、无副作用。
 *
 * 最后更新：2026-08-08
 */

import type { AllianceDirective } from "./control-types.ts";

// ── 常量 ─────────────────────────────────────────────────────

/** 默认 directive stale 阈值（tick）。directive 超过此 tick 未被 ack → stale。 */
export const DEFAULT_DIRECTIVE_STALE_TICKS = 4;

/** 允许的最大有效期（tick）——防止"永不过期"指令。 */
export const MAX_DIRECTIVE_DURATION_TICKS = 256;

// ── 验证结果 ─────────────────────────────────────────────────

/** 单条验证问题。 */
export interface DirectiveValidationIssue {
  readonly field: string;
  readonly message: string;
}

/** directive 验证结果。valid = false 时 issues 非空。 */
export interface DirectiveValidationResult {
  readonly valid: boolean;
  readonly issues: readonly DirectiveValidationIssue[];
}

// ── TTL / Stale ──────────────────────────────────────────────

/**
 * 判断 directive 是否已过期（当前 tick > expiresAtTick）。
 * 过期 directive 必须被忽略（fail-open）。
 */
export function isDirectiveExpired(directive: AllianceDirective, currentTick: number): boolean {
  return currentTick > directive.expiresAtTick;
}

/**
 * 判断 directive 是否尚未生效（当前 tick < issuedAtTick）。
 * 未到生效时间的指令暂不消费。
 */
export function isDirectivePending(directive: AllianceDirective, currentTick: number): boolean {
  return currentTick < directive.issuedAtTick;
}

/**
 * 判断 directive 是否在有效窗口内（issuedAtTick ≤ currentTick ≤ expiresAtTick）。
 */
export function isDirectiveActive(directive: AllianceDirective, currentTick: number): boolean {
  return !isDirectiveExpired(directive, currentTick) && !isDirectivePending(directive, currentTick);
}

/**
 * 判断 directive 是否 stale——仍有效但 issued 后超过 maxStaleTicks 无进展。
 * 注意：stale ≠ expired——stale 的 directive 仍"有效"但需要 human/Director 重新确认。
 * fail-open 语义：stale directive 在未显式要求 block-on-stale 时也应忽略。
 */
export function isDirectiveStale(
  directive: AllianceDirective,
  currentTick: number,
  maxStaleTicks: number = DEFAULT_DIRECTIVE_STALE_TICKS,
): boolean {
  if (isDirectiveExpired(directive, currentTick)) return true;
  return currentTick - directive.issuedAtTick > maxStaleTicks;
}

// ── Revision ─────────────────────────────────────────────────

/**
 * 判断 a 的 revision 是否比 b 更新（严格大于）。
 * 相同 revision → false（不覆盖重复指令）。
 */
export function isNewerRevision(
  a: { readonly revision: number },
  b: { readonly revision: number },
): boolean {
  return a.revision > b.revision;
}

/**
 * revision 比较器（-1/0/1），用于 sort。
 */
export function compareRevision(
  a: { readonly revision: number },
  b: { readonly revision: number },
): -1 | 0 | 1 {
  if (a.revision < b.revision) return -1;
  if (a.revision > b.revision) return 1;
  return 0;
}

// ── 验证 ─────────────────────────────────────────────────────

function issue(field: string, message: string): DirectiveValidationIssue {
  return { field, message };
}

function valid(): DirectiveValidationResult {
  return { valid: true, issues: [] };
}

function invalid(issues: DirectiveValidationIssue[]): DirectiveValidationResult {
  return { valid: false, issues };
}

/**
 * 对指定 tenant 验证 AllianceDirective 的基本结构。
 *
 * 检查项（fail-open：任何不通过 → 忽略指令，回退本地 planner）：
 * 1. tenantId 必须匹配；
 * 2. revision 必须 ≥ 0；
 * 3. expiresAtTick > issuedAtTick；
 * 4. 有效期不超过 MAX_DIRECTIVE_DURATION_TICKS（防永不过期）；
 * 5. 至少有一个 missionRef；
 * 6. mode 必须是有效的 ControlMode；
 * 7. source 必须是 "auto" 或 "human"。
 *
 * 注意：此函数不检查"是否已过期/已 stale"——时效由 isDirectiveExpired /
 * isDirectiveStale 单独判定，因为过期不一定是结构错误（可能是正常的 TTL 到期）。
 */
export function validateDirectiveForTenant(
  directive: AllianceDirective,
  tenantId: string,
): DirectiveValidationResult {
  const issues: DirectiveValidationIssue[] = [];

  // 1. tenant mismatch → 拒绝
  if (directive.tenantId !== tenantId) {
    issues.push(issue("tenantId", `directive is for tenant "${directive.tenantId}", not "${tenantId}"`));
  }

  // 2. revision < 0
  if (directive.revision < 0) {
    issues.push(issue("revision", "revision must be >= 0"));
  }

  // 3. 有效期
  if (directive.expiresAtTick <= directive.issuedAtTick) {
    issues.push(issue("expiresAtTick", "expiresAtTick must be > issuedAtTick"));
  }

  // 4. 最大有效期
  if (directive.expiresAtTick - directive.issuedAtTick > MAX_DIRECTIVE_DURATION_TICKS) {
    issues.push(issue("expiresAtTick", `directive duration exceeds max ${MAX_DIRECTIVE_DURATION_TICKS} ticks`));
  }

  // 5. 至少一个 missionRef
  if (directive.missionRefs.length === 0) {
    issues.push(issue("missionRefs", "directive must reference at least one mission"));
  }

  // 6. mode 有效性
  if (!["AUTO", "ASSIST", "DIRECT"].includes(directive.mode)) {
    issues.push(issue("mode", `invalid control mode: "${directive.mode}"`));
  }

  // 7. source 有效性
  if (directive.source !== "auto" && directive.source !== "human") {
    issues.push(issue("source", `invalid source: "${directive.source}"`));
  }

  return issues.length === 0 ? valid() : invalid(issues);
}

/**
 * 综合判定：directive 是否应在当前 tick 被 tenant 消费。
 * 返回 null = 有效可消费；返回字符串 = 忽略原因。
 *
 * 判定顺序（fail-open，先窗口外后窗口内）：
 * 1. 结构校验不通过 → 忽略（invalid）
 * 2. tenant 不匹配 → 忽略（invalid）
 * 3. 尚未生效 → 暂缓（pending）
 * 4. 已过期 → 忽略（expired）
 * 5. 有效窗口内但 issued 后超过 maxStaleTicks 无进展 → 忽略（stale）
 *
 * stale 与 expired 的区别：expired 是硬截止（tick > expiresAtTick）；
 * stale 是 director 停机/失联后指令停留在"仍有效"窗口内被静默搁置——
 * 同样必须 fail-open，不能构造动作。
 *
 * maxStaleTicks 可显式调整（如对 DIRECT 人工指令用更短窗口），
 * 默认 DEFAULT_DIRECTIVE_STALE_TICKS。
 *
 * 这是 per-tick consumer 的主入口：调用一次即可决定是否应用 directive。
 */
export function evaluateDirective(
  directive: AllianceDirective,
  tenantId: string,
  currentTick: number,
  maxStaleTicks: number = DEFAULT_DIRECTIVE_STALE_TICKS,
): { readonly consume: boolean; readonly reason: string | null } {
  // 结构先于时效
  const validation = validateDirectiveForTenant(directive, tenantId);
  if (!validation.valid) {
    const first = validation.issues[0];
    return { consume: false, reason: `invalid: ${first.field}: ${first.message}` };
  }

  if (isDirectivePending(directive, currentTick)) {
    return { consume: false, reason: "pending" };
  }

  if (isDirectiveExpired(directive, currentTick)) {
    return { consume: false, reason: "expired" };
  }

  if (isDirectiveStale(directive, currentTick, maxStaleTicks)) {
    return { consume: false, reason: "stale" };
  }

  return { consume: true, reason: null };
}

