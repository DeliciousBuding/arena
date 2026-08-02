/**
 * 短期战略记忆（切片 4C）：长驻 session 只保留这个，绝不塞完整历史 raw-state。
 *
 * - 有界环形缓冲（容量可配置，默认 20 条，插入自动去旧）；
 * - 纯数据结构 + 确定性序列化：同输入同输出；
 * - 不 import pi 运行时、不连网、无 IO —— 存取由 leader 集成时接入。
 *
 * 口径来源：
 * - 策略目标/主指标：docs/efficiency-trace-v1.md（ticks_to_redemption_target 主指标，
 *   词典序裁决：先满足安全约束 → 再最小化 ticks_to_target → 再最大化资源效率）；
 * - canonical 口径：docs/differential-record-v1.md（稳定排序、UUID 保留完整、固定行序）。
 */

/** 默认容量：只保留最近 20 条计划结果摘要（切片规格硬值）。 */
export const DEFAULT_MEMORY_CAPACITY = 20;

/** 默认策略目标句（efficiency-trace-v1 口径，可经构造参数覆盖）。 */
export const DEFAULT_STRATEGY_GOAL =
  "最大化长期 Core 资源获取效率：先满足安全约束，再最小化 ticks_to_redemption_target，再最大化 core_resource_gain_per_100_ticks";

/** 决策来源（对齐 decision-types 的 DecisionSource；GPT 审核：含 hybrid/emergency）。 */
export type StrategyMemorySource = "agent" | "hybrid" | "safety" | "emergency";

/** 计划结果摘要（每次决策后由 agent/safety 记录；tick 严格单调递增，不允许倒序/重复）。
 *  coreResourceDelta 语义（GPT 审核）：Core 余额变化，包含 spawn/heal 等主动消费——
 *  负值可能是"投资造 Worker"而非效率恶化，模型不得据此误判。 */
export interface StrategyMemoryEntry {
  readonly tick: number;
  readonly source: StrategyMemorySource;
  readonly planSummary: string;
  readonly outcome?: string;
  readonly coreResourceDelta?: number;
}

export interface StrategyMemoryOptions {
  readonly capacity?: number;
  readonly goal?: string;
}

/** 短期战略记忆：有界环形缓冲 + 确定性序列化。 */
export class StrategyMemory {
  readonly capacity: number;
  readonly goal: string;

  private readonly buffer: Array<StrategyMemoryEntry | null>;
  private head = 0; // 下一个写入位置（环形）
  private count = 0; // 有效条数（<= capacity）
  private lastTick: number | null = null; // 单调约束：tick 必须严格递增（GPT 审核）

  constructor(options: StrategyMemoryOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_MEMORY_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`StrategyMemory capacity must be a positive integer, got ${capacity}`);
    }
    const goal = options.goal ?? DEFAULT_STRATEGY_GOAL;
    if (typeof goal !== "string" || goal.trim().length === 0) {
      throw new RangeError("StrategyMemory goal must be a non-empty string");
    }
    this.capacity = capacity;
    this.goal = goal;
    this.buffer = new Array<StrategyMemoryEntry | null>(capacity).fill(null);
  }

  /** 记录一条计划结果摘要；tick 必须严格大于上一条（倒序/重复拒绝）；超出容量时自动淘汰最旧一条。 */
  record(entry: StrategyMemoryEntry): void {
    validateEntry(entry);
    if (this.lastTick !== null && entry.tick <= this.lastTick) {
      throw new RangeError(
        `StrategyMemory tick 必须严格递增：已有 T${this.lastTick}，收到 T${entry.tick}（倒序/重复拒绝）`,
      );
    }
    this.lastTick = entry.tick;
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count += 1;
    }
  }

  clear(): void {
    this.buffer.fill(null);
    this.head = 0;
    this.count = 0;
    this.lastTick = null;
  }

  /** 按插入顺序返回全部条目（最多 capacity 条；快照给 snapshot 使用）。 */
  readAll(): readonly StrategyMemoryEntry[] {
    const out: StrategyMemoryEntry[] = [];
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i += 1) {
      const entry = this.buffer[(start + i) % this.capacity];
      if (entry !== null) {
        out.push(entry);
      }
    }
    return out;
  }

  /** 序列化为 prompt 片段：目标句 + 最近 N 条摘要 + 效率趋势一行 + 失败模式统计。确定性：同输入同输出。 */
  snapshot(): string {
    const entries = this.readAll();
    const lines: string[] = [];
    lines.push(`目标: ${this.goal}`);
    lines.push(`计划摘要 (最近 ${entries.length} 条):`);
    for (const entry of entries) {
      lines.push(formatEntryLine(entry));
    }
    const gainSum = entries.reduce(
      (sum, e) => (e.coreResourceDelta === undefined ? sum : sum + e.coreResourceDelta),
      0,
    );
    lines.push(`效率趋势: 累计 Core 余额变化 ${formatSigned(gainSum)} (最近 ${entries.length} 条)`);
    const safetyCount = entries.filter((e) => e.source === "safety").length;
    const pct = entries.length === 0 ? 0 : Math.round((safetyCount / entries.length) * 100);
    lines.push(`失败模式: safety 兜底 ${safetyCount}/${entries.length} (${pct}%)`);
    return lines.join("\n");
  }
}

// ---------- 内部辅助（全部确定性） ----------

function validateEntry(entry: StrategyMemoryEntry): void {
  if (!Number.isInteger(entry.tick) || entry.tick < 0) {
    throw new RangeError(
      `StrategyMemoryEntry.tick must be a non-negative integer, got ${entry.tick}`,
    );
  }
  if (entry.source !== "agent" && entry.source !== "hybrid" && entry.source !== "safety" && entry.source !== "emergency") {
    throw new TypeError(
      `StrategyMemoryEntry.source 必须为 agent/hybrid/safety/emergency 之一，got ${String(entry.source)}`,
    );
  }
  if (typeof entry.planSummary !== "string" || entry.planSummary.trim().length === 0) {
    throw new TypeError("StrategyMemoryEntry.planSummary must be a non-empty string");
  }
  if (entry.outcome !== undefined && (typeof entry.outcome !== "string" || entry.outcome.trim().length === 0)) {
    throw new TypeError("StrategyMemoryEntry.outcome must be a non-empty string when present");
  }
  if (entry.coreResourceDelta !== undefined && !Number.isFinite(entry.coreResourceDelta)) {
    throw new RangeError(
      `StrategyMemoryEntry.coreResourceDelta must be finite when present, got ${entry.coreResourceDelta}`,
    );
  }
}

/** 单行确定性序列化（planSummary/outcome 内空白压平，保证一行一条）。 */
function formatEntryLine(entry: StrategyMemoryEntry): string {
  const parts = [`- T${entry.tick} [${entry.source}] ${flatten(entry.planSummary)}`];
  if (entry.outcome !== undefined) {
    parts.push(`结果: ${flatten(entry.outcome)}`);
  }
  if (entry.coreResourceDelta !== undefined) {
    parts.push(`Core余额变化: ${formatSigned(entry.coreResourceDelta)}`);
  }
  return parts.join(" | ");
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

function formatSigned(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}
