/**
 * 决策 Prompt 构建器（切片 4C）：每 Tick 喂给 LLM 的上下文构建。
 *
 * - 纯函数/纯文本：只 import 冻结类型（src/domain/model.ts、src/runtime/decision-types.ts）
 *   与本切片 strategy-memory；不 import pi 运行时、无网络/IO。
 * - 输出 deterministic（同输入同输出），五段固定顺序，段间空行分隔。
 * - canonical 口径对齐 docs/differential-record-v1.md：单位按 id 稳定排序、
 *   cell 集合字典序、位置统一 [x,y] 数组、UUID 完整保留。
 */

import type { ResolutionEventSnapshot, TickState } from "../../domain/model.ts";
import type { DecisionContext } from "../../runtime/decision-types.ts";
import type { StrategyMemory } from "./strategy-memory.ts";

/** 五段标题（固定顺序；测试按标题定位，leader 集成也以此为锚点）。 */
export const PROMPT_SECTION_TITLES = [
  "【第 1 段 · 稳定游戏规则】",
  "【第 2 段 · 当前任务目标】",
  "【第 3 段 · 当前权威 TickState】",
  "【第 4 段 · 短期战略记忆】",
  "【第 5 段 · 工具调用规则】",
] as const;

export interface DecisionPromptInput {
  readonly state: TickState;
  readonly context: DecisionContext;
  readonly memory: StrategyMemory;
  /** 本次决策 runId（leader 集成时传入，格式 ${tenantId}-${tick}-${receivedAtMonotonic}）。 */
  readonly runId: string;
}

/**
 * 稳定游戏规则（常量文本，段 1）：来自 docs/game-rules.md v0.11 与
 * 原 Python LLM 规则 src/arena_bot/llm/llm_strategy.py RULES_VARIANTS["standard"]。
 * 规则数值改动必须对照 docs/game-rules.md；此处随两处来源同步变更。
 */
const STABLE_RULES = `你是指挥 Arena Hero 在线世界的战术指挥官，指挥自己的 Core 与单位。
世界规则要点（docs/game-rules.md v0.11）：
- 每 Tick 世界结算一次；你只控制自己的单位与 Core。
- Worker 采集资源后回家交付；cargo 满时优先回家；无可见资源时沿巡逻方向持续移动探索新区域，不要原地等待。
- 优先造 Worker 到 8 个，之后 Vanguard/Ranger 交替；人口上限 20（tier 0 免 upkeep）；spawn 后保留 3 资源应急。
- 受损单位在自家静止 Core 格自动 HEAL；Core 先补 HP 再修盾再生产。
- Vanguard 相邻 SWEEP、逼近敌人；Ranger 只射 8 方向 1-3 格无遮挡目标。
- 地面 Champion Beacon 同格自动拾取（采集 2 倍收益）。
- 结盟账号 @delicious233 @buding @delicious23333 @deliciousbuding 和它们的 Core 不是敌人，绝不攻击。`;

/** 当前任务目标（段 2）：docs/efficiency-trace-v1.md 的权威表述。 */
const CURRENT_OBJECTIVE = `最大化长期 Core 资源获取效率：
- 攒 Core 资源 → 兑换公益站注册码（30/50 资源；容量 = max(10, 人口×5)）。
- 主指标：ticks_to_redemption_target（越低越好）；次指标：core_resource_gain_per_100_ticks（越高越好）。
- 词典序裁决：先满足安全约束 → 再最小化 ticks_to_redemption_target → 再最大化 core_resource_gain_per_100_ticks → 再比较成本与稳定性。`;

/** 每 Tick 决策 Prompt：五段固定顺序。 */
export function buildDecisionPrompt(input: DecisionPromptInput): string {
  const { state, context, memory, runId } = input;
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw new RangeError("DecisionPromptInput.runId must be a non-empty string");
  }
  const sections: ReadonlyArray<readonly [string, string]> = [
    [PROMPT_SECTION_TITLES[0], STABLE_RULES],
    [PROMPT_SECTION_TITLES[1], CURRENT_OBJECTIVE],
    [PROMPT_SECTION_TITLES[2], renderState(state)],
    [PROMPT_SECTION_TITLES[3], memory.snapshot()],
    [PROMPT_SECTION_TITLES[4], renderRunRules(runId, state.tick, context.stateHash)],
  ];
  return sections.map(([title, body]) => `${title}\n${body}`).join("\n\n");
}

// ---------- 第 3 段：当前权威 TickState ----------

/**
 * 渲染当前权威 TickState（字段名以 src/domain/model.ts 的 TickState 为准）。
 * 确定性约定：单位按 id 稳定排序、cell 集合字典序、位置统一 [x,y]、
 * UUID 完整保留（docs/differential-record-v1.md canonical 口径）。
 */
function renderState(state: TickState): string {
  const lines: string[] = [];
  lines.push(`tick: ${state.tick}`);
  lines.push(`status: ${state.status}`);
  lines.push(
    `resources: ${state.resources} / ${state.resourceCapacity} (space ${state.resourceSpace})`,
  );
  lines.push(`population: ${state.population}`);
  lines.push(renderCore(state.core));
  lines.push(renderBeacon(state));
  const units = [...state.units].sort(byId);
  lines.push(`controlled units (${units.length}):`);
  for (const u of units) {
    lines.push(
      `- ${u.unitType} ${u.id} [${u.position[0]},${u.position[1]}] hp=${u.hp} cargo=${u.cargo}`,
    );
  }
  const enemies = [...state.visibleEnemies].sort(byId);
  lines.push(`visible enemies (${enemies.length}):`);
  for (const e of enemies) {
    const type = e.unitType ?? "UNKNOWN";
    const owner = e.ownerUsername === undefined ? "" : ` owner=${e.ownerUsername}`;
    lines.push(`- ${e.kind} ${type} ${e.id} [${e.position[0]},${e.position[1]}] hp=${e.hp}${owner}`);
  }
  lines.push(renderCellList("resource cells", [...state.resourceCells].sort()));
  lines.push(renderCellList("obstacle cells", [...state.obstacleCells].sort()));
  lines.push(`events (${state.events.length}): ${summarizeEvents(state.events)}`);
  return lines.join("\n");
}

function renderCore(core: TickState["core"]): string {
  if (core === null) {
    return "core: null";
  }
  return (
    `core: ${core.id} [${core.position[0]},${core.position[1]}] ` +
    `hp=${core.hp} shield=${core.shield} state=${core.state} owner=${core.ownerUsername}`
  );
}

function renderBeacon(state: TickState): string {
  const b = state.beacon;
  return (
    `champion beacon: [${b.position[0]},${b.position[1]}] ` +
    `status=${b.status} carrier=${b.carrierId ?? "null"}`
  );
}

function renderCellList(label: string, cells: readonly string[]): string {
  return cells.length === 0
    ? `${label} (0):`
    : `${label} (${cells.length}): ${cells.join(" ")}`;
}

/** 事件按 eventType 计数后字典序输出（确定性，行为 Python _events_summary 的简化版）。 */
function summarizeEvents(events: readonly ResolutionEventSnapshot[]): string {
  if (events.length === 0) {
    return "";
  }
  const counts = new Map<string, number>();
  for (const ev of events) {
    counts.set(ev.eventType, (counts.get(ev.eventType) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([type, n]) => `${type}×${n}`)
    .join(" ");
}

function byId<T extends { readonly id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------- 第 5 段：工具调用规则 ----------

/**
 * 工具调用规则（段 5，硬性约束）。首句携带本次 run 标识
 * （runId/tick/stateHash），LLM 必须在 arena_plan 参数中显式回传这三个值。
 */
function renderRunRules(runId: string, tick: number, stateHash: string): string {
  return (
    `本次决策的 runId = ${runId}，tick = ${tick}，stateHash = ${stateHash}；` +
    `调用 arena_plan 时参数必须携带这三个值，与本次完全一致。\n` +
    `硬性约束（违反即视为本轮无效）：\n` +
    `1. 本 Prompt 第 3 段的当前 Tick 状态覆盖会话里所有旧 Tick 的瞬时事实` +
    `（单位 UUID、位置、HP、cargo、资源、人口）。\n` +
    `2. 每 Tick 必须且只能调用一次 arena_plan 工具提交计划；调用后立即结束本轮。\n` +
    `3. 允许在 arena_plan 之前调用 arena_map 查询地图（0 到多次），但不得调用任何其他工具。\n` +
    `4. 禁止把计划写在普通文本中代替工具调用；普通文本中的计划内容一律不被采纳。\n` +
    `5. 禁止使用旧 Tick 的单位 UUID、位置、HP、cargo——一切以本 Prompt 第 3 段的当前数据为准。\n` +
    `6. 无把握时提交保守计划（空 actions 也可）；最终计划仍由 Safety/Arbiter 裁决，不要为不确定性冒险。`
  );
}
