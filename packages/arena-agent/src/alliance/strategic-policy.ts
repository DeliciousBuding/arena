/**
 * Alliance Strategic Policy — registry, profiles, and deterministic selector.
 *
 * StrategicPolicyProfile 是 Director replan 边界的"可热插策略卡"：
 * - 每个 profile 声明 missionPriority（优先顺序）、thresholds（参数覆盖）和 roleFor（角色映射）
 * - 所有 profile 编译时注册（StrategicPolicyRegistry），禁止运行时动态加载任意 TS
 * - Profile 内容 SHA-256 哈希保证跨 run 可审计（contentHash）
 * - Director 始终以 mode="ASSIST" 产出 directive（硬约束，profile 不可绕开）
 * - 回滚：selector 记录 lastGoodHash，operator/Director 显式调用 rollback()
 *
 * 最后更新：2026-08-08
 */

import { createHash } from "node:crypto";
import type { AllianceRole, MissionKind } from "./control-types.ts";
import type { ShadowDirectorPolicyConfig } from "./director-policy.ts";

// ── Strategy kinds ─────────────────────────────────────────────

/** 联盟战略分类。每个 profile 声明其覆盖的战略维度。 */
export type StrategyKind = "DEFEND" | "RAID" | "ESCORT" | "SCOUT" | "RESERVE";

/** 所有已知 StrategyKind（用于 exhaustive check 与测试）。 */
export const ALL_STRATEGY_KINDS: readonly StrategyKind[] = [
  "DEFEND", "RAID", "ESCORT", "SCOUT", "RESERVE",
];

// ── StrategicPolicyProfile ─────────────────────────────────────

/**
 * 战略策略配置文件。
 *
 * 设计约束：
 * - 纯数据 + 纯函数（roleFor），无 I/O、无副作用
 * - contentHash 是 profile 定义的 SHA-256（前 16 位 hex），编译时固定
 * - thresholds 是可选的部分覆盖——未指定的键回退到 DEFAULT_SHADOW_DIRECTOR_POLICY
 * - missionPriority 是 Director 的求值顺序：先列出的先检查，首次匹配即分配
 */
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
   * Mission 求值优先顺序（高优先在前）。
   * Director 按此顺序检查每个 member，首次匹配的 kind 即被分配。
   * 必须包含所有可能被本 profile 产出的 MissionKind。
   */
  readonly missionPriority: readonly MissionKind[];
  /**
   * ShadowDirectorPolicyConfig 的部分覆盖。
   * 未指定的键回退到 DEFAULT_SHADOW_DIRECTOR_POLICY。
   */
  readonly thresholds?: Partial<ShadowDirectorPolicyConfig>;
  /**
   * MissionKind → AllianceRole 映射。
   * treasuryTenant 参数允许 treasury 成员在 RESERVE/ASSEMBLE 场景下保持 TREASURY 角色。
   */
  roleFor(kind: MissionKind, treasuryTenant: string, memberTenant: string): AllianceRole;
}

// ── Content hash ───────────────────────────────────────────────

/**
 * 为 profile 定义计算稳定 contentHash。
 * 输入：name + version + strategies（排序）+ missionPriority（保持顺序）+ thresholds（canonical 序列化）。
 * 纯函数，同输入同输出——保证跨 run 可复现。
 */
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

/**
 * 静态策略注册表。
 *
 * 安全约束：
 * - 所有 profile 必须显式 register() 注册——不存在"自动发现"或动态 import
 * - 注册发生在模块加载时（import 副作用），运行时不新增/删除
 * - name 是唯一键：重复注册同名 profile 抛错（version 不同也抛——先 unregister）
 * - 注册后 profile 内容不可变（Object.freeze）
 */
export class StrategicPolicyRegistry {
  private readonly _profiles = new Map<string, StrategicPolicyProfile>();
  private _defaultName: string | null = null;

  /** 注册一个 profile。同名已存在则抛错。 */
  register(profile: StrategicPolicyProfile): void {
    if (this._profiles.has(profile.name)) {
      throw new Error(`StrategicPolicyRegistry: profile "${profile.name}" already registered`);
    }
    const frozen = Object.freeze({ ...profile });
    this._profiles.set(profile.name, frozen);
  }

  /** 取消注册（仅测试用；生产不应调用）。 */
  unregister(name: string): boolean {
    if (this._defaultName === name) this._defaultName = null;
    return this._profiles.delete(name);
  }

  /** 设置默认 profile。未设置时 selector 使用第一个注册的 profile。 */
  setDefault(name: string): void {
    if (!this._profiles.has(name)) {
      throw new Error(`StrategicPolicyRegistry: default profile "${name}" not registered`);
    }
    this._defaultName = name;
  }

  /** 获取默认 profile name。 */
  get defaultName(): string {
    if (this._defaultName !== null) return this._defaultName;
    const first = this._profiles.keys().next().value;
    if (first === undefined) throw new Error("StrategicPolicyRegistry: no profiles registered");
    return first as string;
  }

  /** 按 name 获取 profile。不存在返回 undefined。 */
  get(name: string): StrategicPolicyProfile | undefined {
    return this._profiles.get(name);
  }

  /** 列出所有已注册 profile（按 name 排序）。 */
  list(): readonly StrategicPolicyProfile[] {
    return [...this._profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 已注册 profile 数量。 */
  get size(): number {
    return this._profiles.size;
  }
}

// ── Selection ──────────────────────────────────────────────────

/**
 * 单次策略选择记录（审计 trail）。
 */
export interface StrategicPolicySelection {
  readonly profile: StrategicPolicyProfile;
  readonly revision: number;
  readonly selectedAtTick: number;
  /** 选择原因：default / explicit-override:<name> / rollback / sticky */
  readonly reason: string;
  /** 上一轮 profile 的 contentHash（首轮为 null）。 */
  readonly previousHash: string | null;
  /** 最近一次确认良好的 profile contentHash（无 lastGood 时为 null）。 */
  readonly lastGoodHash: string | null;
}

/**
 * 确定性策略选择器。
 *
 * 行为：
 * - select() 按 explicitOverride > sticky（上次选择） > registry default 优先级
 * - 每次选择产生递增 revision + 审计 trace
 * - markLastGood() 将当前 profile 标记为 lastGood
 * - rollback() 回到 lastGood（无 lastGood 时回到 registry default）
 * - 所有选择可重放：相同 snapshot 时戳 + 相同 explicitOverride → 相同结果
 *
 * 设计约束：
 * - 不含 wall-clock、Math.random 或外部 I/O
 * - history 有界（默认保留最近 64 条）
 */
export class StrategicPolicySelector {
  readonly registry: StrategicPolicyRegistry;
  private _history: StrategicPolicySelection[] = [];
  private _lastGood: StrategicPolicyProfile | null = null;
  private _revision = 0;
  private readonly _maxHistory: number;

  constructor(
    registry: StrategicPolicyRegistry,
    opts: { maxHistory?: number } = {},
  ) {
    this.registry = registry;
    this._maxHistory = opts.maxHistory ?? 64;
  }

  /** 选择历史（最近在前）。 */
  get history(): readonly StrategicPolicySelection[] {
    return this._history;
  }

  /** 最近一次选择。 */
  get latest(): StrategicPolicySelection | null {
    return this._history[0] ?? null;
  }

  /** 当前生效的 profile（= latest 选择的 profile，无选择时为 registry default）。 */
  get current(): StrategicPolicyProfile {
    return this.latest?.profile ?? this.registry.get(this.registry.defaultName)!;
  }

  /** 最近一次标记为 good 的 profile。 */
  get lastGoodProfile(): StrategicPolicyProfile | null {
    return this._lastGood;
  }

  /**
   * 为当前 tick 选择策略 profile。
   *
   * @param tick 当前 tick（用于审计 trail）
   * @param explicitOverride 显式覆盖策略名（operator 指令）。不存在时 sticky 上次选择。
   */
  select(tick: number, explicitOverride?: string): StrategicPolicySelection {
    const previous = this.latest;
    const previousHash = previous?.profile.contentHash ?? null;

    let profile: StrategicPolicyProfile;
    let reason: string;

    if (explicitOverride !== undefined) {
      const found = this.registry.get(explicitOverride);
      if (found === undefined) {
        // 显式覆盖名称无效 → sticky（不抛错，保证 Director 不因配置错误停机）
        profile = this.current;
        reason = `explicit-override-not-found:${explicitOverride}→sticky`;
      } else {
        profile = found;
        reason = `explicit-override:${explicitOverride}`;
      }
    } else if (previous !== null) {
      // sticky：保持上次选择
      profile = previous.profile;
      reason = "sticky";
    } else {
      // 首轮：使用 registry default
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
    if (this._history.length > this._maxHistory) {
      this._history.length = this._maxHistory;
    }

    return selection;
  }

  /**
   * 将当前生效的 profile 标记为 lastGood。
   * 用于 Director 在 KPI 正常时确认当前策略有效。
   */
  markLastGood(): void {
    this._lastGood = this.current;
  }

  /**
   * 回滚到 lastGood profile。
   * 无 lastGood 时回到 registry default。
   * 返回新的 selection（可被 Director 立即消费）。
   */
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
    if (this._history.length > this._maxHistory) {
      this._history.length = this._maxHistory;
    }

    return selection;
  }
}

// ── Built-in profiles ──────────────────────────────────────────

/**
 * 默认保守 profile：防御优先，经济重建，不主动远征。
 *
 * 等价于 v1 shadow policy 的硬编码优先级链：
 * RETREAT → INTERCEPT/DEFEND → DEFEND(directional) → ASSEMBLE → SCOUT → RAID(if safe)
 */
export const BALANCED_PROFILE: StrategicPolicyProfile = Object.freeze({
  name: "balanced" as const,
  version: 1,
  get contentHash(): string {
    return computeProfileHash(this);
  },
  description:
    "保守均衡：防御优先 → 拦截近距威胁 → 方向压力守家 → 兵力不足集结 → 低风险侦察 → 安全窗口远征",
  strategies: ["DEFEND", "SCOUT"] as const,
  missionPriority: ["RETREAT", "INTERCEPT", "DEFEND", "ASSEMBLE", "SCOUT", "RAID"] as const,
  thresholds: undefined, // 全部使用 DEFAULT_SHADOW_DIRECTOR_POLICY
  roleFor(kind: MissionKind, treasuryTenant: string, memberTenant: string): AllianceRole {
    if (kind === "RAID") return "RAIDER";
    if (kind === "SCOUT") return "SCOUT";
    if (kind === "ESCORT") return "DEFENDER";
    // ASSEMBLE: treasury stays TREASURY; others are DEFENDER
    if (kind === "ASSEMBLE") {
      return memberTenant === treasuryTenant ? "TREASURY" : "DEFENDER";
    }
    return "DEFENDER";
  },
});

/**
 * 激进攻击 profile：远征优先，低阈值触发 RAID，兵力集中打击。
 */
export const AGGRESSIVE_PROFILE: StrategicPolicyProfile = Object.freeze({
  name: "aggressive" as const,
  version: 1,
  get contentHash(): string {
    return computeProfileHash(this);
  },
  description: "激进攻击：远征优先 → 拦截 → 防御 → 侦察 → 集结（降低 raid 门槛与兵力要求）",
  strategies: ["RAID", "DEFEND"] as const,
  missionPriority: ["RAID", "INTERCEPT", "RETREAT", "DEFEND", "SCOUT", "ASSEMBLE"] as const,
  thresholds: {
    minRaidMilitary: 4,        // 降低远征兵力门槛（默认 6 → 4）
    raidMinConfidence: 0.5,    // 降低目标置信度要求（默认 0.65 → 0.5）
    raidMaxDistance: 96,       // 扩大远征半径（默认 64 → 96）
    raidMaxAgeTicks: 36,       // 放宽目标时效（默认 24 → 36）
  },
  roleFor(kind: MissionKind, _treasuryTenant: string, _memberTenant: string): AllianceRole {
    if (kind === "RAID") return "RAIDER";
    if (kind === "SCOUT") return "SCOUT";
    return "DEFENDER";
  },
});

/**
 * 侦察优先 profile：扩大侦察半径，减少防御触发，优先地图探索。
 */
export const SCOUT_PROFILE: StrategicPolicyProfile = Object.freeze({
  name: "scout-first" as const,
  version: 1,
  get contentHash(): string {
    return computeProfileHash(this);
  },
  description: "侦察优先：扩大侦察半径 → 低威胁时优先探索 → 防御兜底",
  strategies: ["SCOUT", "DEFEND"] as const,
  missionPriority: ["SCOUT", "RETREAT", "INTERCEPT", "DEFEND", "RAID", "ASSEMBLE"] as const,
  thresholds: {
    scoutDistance: 20,              // 扩大侦察半径（默认 12 → 20）
    retreatTotalScoreThreshold: 1.5, // 提高撤退阈值（默认 1.2 → 1.5，减少误撤退）
  },
  roleFor(kind: MissionKind, treasuryTenant: string, memberTenant: string): AllianceRole {
    if (kind === "SCOUT") return "SCOUT";
    if (kind === "RAID") return "RAIDER";
    if (kind === "ASSEMBLE") {
      return memberTenant === treasuryTenant ? "TREASURY" : "DEFENDER";
    }
    return "DEFENDER";
  },
});

/**
 * 纯防御 profile：只守家与撤退，禁止远征与侦察。
 */
export const DEFEND_PROFILE: StrategicPolicyProfile = Object.freeze({
  name: "defend-only" as const,
  version: 1,
  get contentHash(): string {
    return computeProfileHash(this);
  },
  description: "纯防御：撤退 → 拦截近距威胁 → 方向压力守家 → 兵力不足集结。禁止远征与侦察。",
  strategies: ["DEFEND"] as const,
  missionPriority: ["RETREAT", "INTERCEPT", "DEFEND", "ASSEMBLE"] as const,
  // 注意：missionPriority 不含 SCOUT 与 RAID → 即使低威胁也不会分配
  thresholds: {
    minInterceptMilitary: 1,  // 降低拦截门槛（默认 2 → 1，全员可拦截）
    assembleMilitaryBelow: 4, // 提高集结阈值（默认 2 → 4，更快触发补充）
  },
  roleFor(_kind: MissionKind, treasuryTenant: string, memberTenant: string): AllianceRole {
    return memberTenant === treasuryTenant ? "TREASURY" : "DEFENDER";
  },
});

/**
 * 护航/储备 profile：保护 treasury + 集结优先，极少远征。
 */
export const RESERVE_PROFILE: StrategicPolicyProfile = Object.freeze({
  name: "reserve" as const,
  version: 1,
  get contentHash(): string {
    return computeProfileHash(this);
  },
  description: "护航储备：守家 → 集结补充 → 保护 treasury → 极少远征（高门槛）",
  strategies: ["ESCORT", "RESERVE", "DEFEND"] as const,
  missionPriority: ["RETREAT", "DEFEND", "INTERCEPT", "ASSEMBLE", "SCOUT", "RAID"] as const,
  thresholds: {
    minRaidMilitary: 10,       // 极高远征门槛（默认 6 → 10，极少触发）
    raidMinConfidence: 0.85,   // 极高置信度要求
    assembleMilitaryBelow: 4,  // 提高集结阈值
  },
  roleFor(kind: MissionKind, treasuryTenant: string, memberTenant: string): AllianceRole {
    // ASSEMBLE-heavy profile: treasury stays TREASURY during buildup
    if (kind === "ASSEMBLE") {
      return memberTenant === treasuryTenant ? "TREASURY" : "DEFENDER";
    }
    if (kind === "RAID") return "RAIDER";
    if (kind === "SCOUT") return "SCOUT";
    return "DEFENDER";
  },
});

// ── Global singleton registry ──────────────────────────────────

/** 全局策略注册表（模块级单例）。模块加载时完成内置 profile 注册。 */
export const STRATEGIC_REGISTRY = new StrategicPolicyRegistry();

// 注册内置 profile（import 副作用——模块加载即完成）
STRATEGIC_REGISTRY.register(BALANCED_PROFILE);
STRATEGIC_REGISTRY.register(AGGRESSIVE_PROFILE);
STRATEGIC_REGISTRY.register(SCOUT_PROFILE);
STRATEGIC_REGISTRY.register(DEFEND_PROFILE);
STRATEGIC_REGISTRY.register(RESERVE_PROFILE);
STRATEGIC_REGISTRY.setDefault("balanced");

/** 全局策略选择器（模块级单例，绑定 STRATEGIC_REGISTRY）。 */
export const STRATEGIC_SELECTOR = new StrategicPolicySelector(STRATEGIC_REGISTRY);
