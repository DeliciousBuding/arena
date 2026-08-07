/**
 * Alliance KPI 采集器（Phase 2）。
 *
 * 在 episode 运行期间增量收集联盟级 KPI，episode 结束后 finalize 输出。
 * 所有方法为纯数据操作，无 I/O、无 wall-clock。
 *
 * 最后更新：2026-08-08
 */

import type { SimWorld } from "../world/types.ts";
import type { AllianceKPI } from "./types.ts";

export class AllianceKpiCollector {
  // Treasury accumulator
  private treasuryResources: number[] = [];
  private treasuryHighWater = 0;
  private treasuryCoreAlive = true;

  // Directive stats（按 per-tenant evaluation 累加）
  private accepted = 0;
  private rejected = 0;
  private stale = 0;
  private expiredConsumed = 0;
  private forcedFallback = 0;
  private totalEvaluations = 0;
  private directorErrors = 0;
  private safetyRejects = 0;

  // Per-tenant tracking
  private tenantFinalResources: Record<string, number> = {};
  private tenantFinalPopulation: Record<string, number> = {};
  private tenantCoreSurvived: Record<string, boolean> = {};

  /**
   * 每 tick 结算后调用。
   * 所有计数都是本 tick 的增量（number，非 boolean——按 evaluation 计）。
   */
  recordTick(args: {
    readonly world: SimWorld;
    readonly treasuryTenant: string;
    readonly directiveAccepted: number;
    readonly directiveRejected: number;
    readonly directiveStale: number;
    readonly expiredDirectiveConsumed: number;
    readonly fallbackCount: number;
    readonly evaluationCount: number;
    readonly directorErrorCount: number;
    readonly safetyRejectCount: number;
  }): void {
    // Treasury
    const treasuryPlayer = args.world.players.get(args.treasuryTenant);
    if (treasuryPlayer !== undefined) {
      const res = treasuryPlayer.resources;
      this.treasuryResources.push(res);
      if (res > this.treasuryHighWater) this.treasuryHighWater = res;
      if (treasuryPlayer.core === null) this.treasuryCoreAlive = false;
    }

    // Directive stats
    this.accepted += args.directiveAccepted;
    this.rejected += args.directiveRejected;
    this.stale += args.directiveStale;
    this.expiredConsumed += args.expiredDirectiveConsumed;
    this.forcedFallback += args.fallbackCount;
    this.totalEvaluations += args.evaluationCount;
    this.directorErrors += args.directorErrorCount;
    this.safetyRejects += args.safetyRejectCount;

    // Per-tenant snapshot (last tick wins)
    for (const [id, player] of args.world.players) {
      this.tenantFinalResources[id] = player.resources;
      this.tenantFinalPopulation[id] = player.units.length;
      this.tenantCoreSurvived[id] = player.core !== null;
    }
  }

  /**
   * Episode 结束后调用，输出最终 KPI。
   */
  finalize(): AllianceKPI {
    const auc = this.treasuryResources.length > 0
      ? this.treasuryResources.reduce((sum, v) => sum + v, 0)
      : 0;

    const fallbackAvailability = this.totalEvaluations > 0
      ? 1 - this.forcedFallback / this.totalEvaluations
      : 1;

    return {
      treasuryResourcesFinal: this.treasuryResources.length > 0
        ? this.treasuryResources[this.treasuryResources.length - 1]
        : 0,
      treasuryResourceHighWater: this.treasuryHighWater,
      treasuryResourceAUC: auc,
      treasuryCoreSurvivalRate: this.treasuryCoreAlive ? 1 : 0,
      directiveAccepted: this.accepted,
      directiveRejected: this.rejected,
      directiveStale: this.stale,
      expiredDirectiveConsumed: this.expiredConsumed,
      baselineFallbackCount: this.forcedFallback,
      directorErrorCount: this.directorErrors,
      allianceSafetyRejectCount: this.safetyRejects,
      friendlyFireMetricSupported: true,
      fallbackAvailability: Math.round(fallbackAvailability * 1000) / 1000,
      perTenant: Object.fromEntries(
        Object.keys(this.tenantFinalResources).sort().map((id) => [
          id,
          {
            finalResources: this.tenantFinalResources[id] ?? 0,
            finalPopulation: this.tenantFinalPopulation[id] ?? 0,
            coreSurvived: this.tenantCoreSurvived[id] ?? false,
          },
        ]),
      ),
    };
  }
}
