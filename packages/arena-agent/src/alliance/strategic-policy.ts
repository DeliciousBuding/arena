/**
 * Alliance Strategic Policy — profiles, registry, deterministic selector（最小版）。
 *
 * StrategicPolicyProfile 是 Director replan 边界的"可热插策略卡"，纯数据：
 * - missionPriority 决定 Director 允许产出的战略任务及其求值优先级（先列出的先考虑）
 * - thresholds 是 ShadowDirectorPolicyConfig 的部分覆盖（未指定回退到 DEFAULT）
 * - contentHash SHA-256 保证跨 run 可审计；selector 记录 lastGood 支持 rollback
 *
 * 硬约束（profile 不可绕开）：Director 始终 mode="ASSIST"、无 Arena action/submit。
 * Profile hot-switch 只在 Director replan 边界发生（select/rollback），不中途换卡。
 *
 * 设计取舍：不做 generic strategy-hotplug registry——本注册表编译时静态注册，
 * 无动态 import、无运行时新增/删除。
 * 最后更新：2026-08-08
 */

import { createHash } from "node:crypto";
import type { MissionKind } from "./control-types.ts";
import type { ShadowDirectorPolicyConfig } from "./director-policy.ts";

// ── Strategy kinds ─────────────────────────────────────────────

export type StrategyKind = "DEFEND" | "RAID" | "ESCORT" | "SCOUT" | "RESERVE";

export const ALL_STRATEGY_KINDS: readonly StrategyKind[] = [
  "DEFEND", "RAID", "ESCORT", "SCOUT", "RESERVE",
];

// ── StrategicPolicyProfile ─────────────────────────────────────

export interface StrategicPolicyProfile {
  /** 唯一标识（registry key）。kebab-case，如 "defend-first"。 */
  readonly name: string;
  /** 语义版本号（正整数）。递增即 breaking change。 */
  readonly version: number;
  /** Profile 定义内容的 SHA-256（前 16 位 hex）。用于跨 run 审计与回滚校验。 */
  readonly contentHash: string;
  /** 人类可读描述。 */
  readonly description: string;
  /** 本 profile 覆盖的战略维度（可多选，如 ["DEFEND", "SCOUT"]）。 */
  readonly strategies: readonly StrategyKind[];
  /**
   * Mission 求值优先级（高优先在前）。Director 的 Phase A 生存分支固定优先，
   * 本字段决定柔性战略任务（RAID/ESCORT/SCOUT）的允许集与 Phase C 取舍顺序。
   */
  readonly missionPriority: readonly MissionKind[];
  /** ShadowDirectorPolicyConfig 的部分覆盖。未指定回退到 DEFAULT。 */
  readonly thresholds?: Partial<ShadowDirectorPolicyConfig>;
}

// ── Content hash ───────────────────────────────────────────────

export function computeProfileHash(profile: {
  readonly name: string;
  readonly version: number;
  readonly strategies: readonly StrategyKind[];
  readonly missionPriority: readonly MissionKind[];
  readonly thresholds?: Partial<ShadowDirectorPolicyConfig>;
}): string {
  const canonical = JSON.stringify({
    name: profile.name,
    version: profile.version,
    strategies: [...profile.strategies].sort(),
    missionPriority: [...profile.missionPriority],
    thresholds: profile.thresholds ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// ── Registry ───────────────────────────────────────────────────

export class StrategicPolicyRegistry {
  private readonly _profiles = new Map<string, StrategicPolicyProfile>();
  private _defaultName: string | null = null;

  register(profile: StrategicPolicyProfile): void {
    if (this._profiles.has(profile.name)) {
      throw new Error(`StrategicPolicyRegistry: profile "${profile.name}" already registered`);
    }
    this._profiles.set(profile.name, Object.freeze({ ...profile }));
  }

  unregister(name: string): boolean {
    if (this._defaultName === name) this._defaultName = null;
    return this._profiles.delete(name);
  }

  setDefault(name: string): void {
    if (!this._profiles.has(name)) {
      throw new Error(`StrategicPolicyRegistry: default profile "${name}" not registered`);
    }
    this._defaultName = name;
  }

  get defaultName(): string {
    if (this._defaultName !== null) return this._defaultName;
    const first = this._profiles.keys().next().value;
    if (first === undefined) throw new Error("StrategicPolicyRegistry: no profiles registered");
    return first as string;
  }

  get(name: string): StrategicPolicyProfile | undefined {
    return this._profiles.get(name);
  }

  list(): readonly StrategicPolicyProfile[] {
    return [...this._profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get size(): number {
    return this._profiles.size;
  }
}

// ── Selection ──────────────────────────────────────────────────

export interface StrategicPolicySelection {
  readonly profile: StrategicPolicyProfile;
  readonly revision: number;
  readonly selectedAtTick: number;
  /** 选择原因：default / explicit-override:<name> / rollback / sticky */
  readonly reason: string;
  readonly previousHash: string | null;
  readonly lastGoodHash: string | null;
}

export class StrategicPolicySelector {
  readonly registry: StrategicPolicyRegistry;
  private _history: StrategicPolicySelection[] = [];
  private _lastGood: StrategicPolicyProfile | null = null;
  private _revision = 0;
  private readonly _maxHistory: number;

  constructor(registry: StrategicPolicyRegistry, opts: { maxHistory?: number } = {}) {
    this.registry = registry;
    this._maxHistory = opts.maxHistory ?? 64;
  }

  get history(): readonly StrategicPolicySelection[] {
    return this._history;
  }

  get latest(): StrategicPolicySelection | null {
    return this._history[0] ?? null;
  }

  get current(): StrategicPolicyProfile {
    return this.latest?.profile ?? this.registry.get(this.registry.defaultName)!;
  }

  get lastGoodProfile(): StrategicPolicyProfile | null {
    return this._lastGood;
  }

  /** 为当前 tick 选择策略 profile：explicitOverride > sticky（上次选择） > registry default。
   * 确定性：同 override + 同初始 registry → 同序列（无 wall-clock / Math.random）。 */
  select(tick: number, explicitOverride?: string): StrategicPolicySelection {
    const previous = this.latest;
    const previousHash = previous?.profile.contentHash ?? null;

    let profile: StrategicPolicyProfile;
    let reason: string;

    if (explicitOverride !== undefined) {
      const found = this.registry.get(explicitOverride);
      if (found === undefined) {
        // 显式覆盖名称无效 → sticky（不抛错，Director 不因配置错误停机）
        profile = this.current;
        reason = `explicit-override-not-found:${explicitOverride}→sticky`;
      } else {
        profile = found;
        reason = `explicit-override:${explicitOverride}`;
      }
    } else if (previous !== null) {
      profile = previous.profile;
      reason = "sticky";
    } else {
      profile = this.registry.get(this.registry.defaultName)!;
      reason = "default";
    }

    this._revision += 1;
    const selection: StrategicPolicySelection = Object.freeze({
      profile,
      revision: this._revision,
      selectedAtTick: tick,
      reason,
      previousHash,
      lastGoodHash: this._lastGood?.contentHash ?? null,
    });

    this._history.unshift(selection);
    if (this._history.length > this._maxHistory) this._history.length = this._maxHistory;
    return selection;
  }

  /** 将当前生效的 profile 标记为 lastGood（Director 在 KPI 正常时确认）。 */
  markLastGood(): void {
    this._lastGood = this.current;
  }

  /** 回滚到 lastGood profile；无 lastGood 时回 registry default。 */
  rollback(tick: number): StrategicPolicySelection {
    let profile: StrategicPolicyProfile;
    let reason: string;

    if (this._lastGood !== null) {
      profile = this._lastGood;
      reason = "rollback-to-last-good";
    } else {
      profile = this.registry.get(this.registry.defaultName)!;
      reason = "rollback-to-default";
    }

    this._revision += 1;
    const previous = this.latest;
    const selection: StrategicPolicySelection = Object.freeze({
      profile,
      revision: this._revision,
      selectedAtTick: tick,
      reason,
      previousHash: previous?.profile.contentHash ?? null,
      lastGoodHash: this._lastGood?.contentHash ?? null,
    });

    this._history.unshift(selection);
    if (this._history.length > this._maxHistory) this._history.length = this._maxHistory;
    return selection;
  }
}

// ── Built-in profiles ──────────────────────────────────────────

/** 默认保守 profile：防御优先，柔性任务按"侦察 → 远征"取舍，阈值全默认。 */
export const BALANCED_PROFILE: StrategicPolicyProfile = Object.freeze({
  name: "balanced",
  version: 1,
  get contentHash(): string {
    return computeProfileHash(this);
  },
  description: "保守均衡：防御优先 → 低风险侦察 → 安全窗口远征（默认阈值）",
  strategies: ["DEFEND", "SCOUT"] as const,
  missionPriority: ["RETREAT", "INTERCEPT", "DEFEND", "ASSEMBLE", "SCOUT", "RAID"] as const,
  thresholds: undefined,
});

/** 激进攻击 profile：远征优先，低阈值触发 RAID。 */
export const AGGRESSIVE_PROFILE: StrategicPolicyProfile = Object.freeze({
  name: "aggressive",
  version: 1,
  get contentHash(): string {
    return computeProfileHash(this);
  },
  description: "激进攻击：远征优先 → 拦截 → 防御（降低 raid 门槛与兵力要求）",
  strategies: ["RAID", "DEFEND"] as const,
  missionPriority: ["RETREAT", "INTERCEPT", "DEFEND", "ASSEMBLE", "RAID", "SCOUT"] as const,
  thresholds: {
    minRaidMilitary: 4,        // 降低远征兵力门槛（默认 6 → 4）
    raidMinConfidence: 0.5,    // 降低目标置信度要求（默认 0.65 → 0.5）
    raidMaxDistance: 96,       // 扩大远征半径（默认 64 → 96）
    raidMaxAgeTicks: 36,       // 放宽目标时效（默认 24 → 36）
  },
});

/** 纯防御 profile：只守家与撤退，禁止远征与侦察。 */
export const DEFEND_PROFILE: StrategicPolicyProfile = Object.freeze({
  name: "defend-only",
  version: 1,
  get contentHash(): string {
    return computeProfileHash(this);
  },
  description: "纯防御：撤退 → 拦截 → 方向压力守家 → 兵力不足集结。禁止远征与侦察。",
  strategies: ["DEFEND"] as const,
  missionPriority: ["RETREAT", "INTERCEPT", "DEFEND", "ASSEMBLE"] as const,
  thresholds: {
    minInterceptMilitary: 1,  // 降低拦截门槛（默认 2 → 1）
    assembleMilitaryBelow: 4, // 提高集结阈值（默认 2 → 4）
  },
});

// ── Global singletons ──────────────────────────────────────────

export const STRATEGIC_REGISTRY = new StrategicPolicyRegistry();

STRATEGIC_REGISTRY.register(BALANCED_PROFILE);
STRATEGIC_REGISTRY.register(AGGRESSIVE_PROFILE);
STRATEGIC_REGISTRY.register(DEFEND_PROFILE);
STRATEGIC_REGISTRY.setDefault("balanced");

export const STRATEGIC_SELECTOR = new StrategicPolicySelector(STRATEGIC_REGISTRY);
