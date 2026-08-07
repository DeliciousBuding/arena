/**
 * Alliance Director — sim 层实现（Phase 2）。
 *
 * 提供 AllianceDirector 接口 + 两个测试实现：
 * - NoopAllianceDirector：不产出指令（baseline 对照用）
 * - FixedAllianceDirector：固定角色分配 + 影子 SCOUT mission
 *
 * 所有实现为纯函数、确定性、无 I/O。
 * 最后更新：2026-08-08
 */

import type { AllianceRole, AllianceDirective } from "../../alliance/control-types.ts";
import type { AllianceSnapshot } from "../../alliance/types.ts";
import { decideAllianceShadowPolicy, type ShadowDirectorPolicyConfig } from "../../alliance/director-policy.ts";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import type { AllianceDirector } from "./types.ts";

// ── NoopAllianceDirector ───────────────────────────────────────

/**
 * 空导演：永远不产出指令。
 * 用于 baseline 对照——证明联盟层注入不影响 episode 确定性。
 */
export class NoopAllianceDirector implements AllianceDirector {
  readonly kind = "noop";

  decide(_snapshot: AllianceSnapshot, _rng: () => number): { readonly directives: readonly AllianceDirective[] } {
    return { directives: [] };
  }
}

// ── FixedAllianceDirector ──────────────────────────────────────

export interface FixedDirectorConfig {
  /** tenantId → 固定角色。未指定的 tenant 默认为 DEFENDER。 */
  readonly roles: ReadonlyMap<string, AllianceRole>;
  /** Directive 有效期（tick）。缺省 = 8。 */
  readonly directiveDurationTicks?: number;
}

/**
 * 固定策略导演：按配置分配角色，每周期产出 per-tenant directive。
 *
 * 每条 directive 引用一个影子 SCOUT mission（满足合同层 missionRefs 至少一条的要求）。
 * v1 阶段 mission 本身不驱动 Fleet 动作——只作为 directive 消费的记录载体。
 */
export class FixedAllianceDirector implements AllianceDirector {
  readonly kind = "fixed-strategy";

  private readonly config: Required<Pick<FixedDirectorConfig, "directiveDurationTicks">> & {
    readonly roles: ReadonlyMap<string, AllianceRole>;
  };

  constructor(config: FixedDirectorConfig) {
    this.config = {
      roles: config.roles,
      directiveDurationTicks: config.directiveDurationTicks ?? 8,
    };
  }

  decide(
    snapshot: AllianceSnapshot,
    _rng: () => number,
  ): { readonly directives: readonly AllianceDirective[] } {
    const duration = this.config.directiveDurationTicks;
    const now = snapshot.tickWindow[1];
    const missionId = `shadow-scoop-${snapshot.revision}`;

    const directives: AllianceDirective[] = [];
    for (const tenantId of [...snapshot.members.keys()].sort(compareCodeUnit)) {
      const role = this.config.roles.get(tenantId) ?? "DEFENDER";
      directives.push({
        tenantId,
        revision: snapshot.revision,
        missionRefs: [missionId],
        issuedAtTick: now,
        expiresAtTick: now + duration,
        source: "auto",
        mode: "AUTO",
        explanation: `fixed-strategy: role=${role} tick=${now}`,
      });
    }
    return { directives };
  }
}



// ── ShadowPolicyAllianceDirector ───────────────────────────────

/** Real Director v1 policy adapter for simulator/shadow evaluation only. */
export class ShadowPolicyAllianceDirector implements AllianceDirector {
  readonly kind = "shadow-policy-v1";
  private readonly config: Partial<ShadowDirectorPolicyConfig>;

  constructor(config: Partial<ShadowDirectorPolicyConfig> = {}) {
    this.config = { ...config };
  }

  decide(snapshot: AllianceSnapshot, _rng: () => number) {
    return decideAllianceShadowPolicy(snapshot, this.config);
  }
}
