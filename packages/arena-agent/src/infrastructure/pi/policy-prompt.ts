/**
 * MacroPolicy 决策 prompt（低频战略层）：只看宏观状态摘要，输出结构化策略 JSON。
 *
 * - 纯文本构建（确定性：同输入同输出）；
 * - 模型只输出 JSON（parsePolicyText 剥围栏解析）；
 * - 输入刻意精简（宏观指标），不携带单位级瞬时细节——策略层不做战术决策。
 */

import type { TickState } from "../../domain/model.ts";

/** 宏观状态摘要 → 策略 prompt（模型输出策略 JSON 后直接结束）。
 *  previousPolicy（当前生效策略）注入为基线：策略是低频调整不是每周期重掷——
 *  模型应对比基线做小幅演进（workerTarget 尤其要连续，防止 16→3 跳变）。 */
export function buildMacroPolicyPrompt(
  state: TickState,
  extras: {
    readonly recentResourceDeltas?: readonly number[];
    readonly previousPolicy?: string | null;
  } = {},
): string {
  const coreLine = state.core === null
    ? "core: null"
    : `core: [${state.core.position[0]},${state.core.position[1]}] hp=${state.core.hp} shield=${state.core.shield}`;
  const military = state.vanguards.length + state.rangers.length;
  const deltas = extras.recentResourceDeltas ?? [];
  const trendLine = deltas.length === 0
    ? "resource trend: (no recent data)"
    : `resource trend (last ${deltas.length} ticks, sum ${deltas.reduce((sum, d) => sum + d, 0)}): ${deltas.join(" ")}`;
  const baselineLine = extras.previousPolicy === undefined || extras.previousPolicy === null
    ? "previous policy: (none, first decision)"
    : `previous policy: ${extras.previousPolicy}`;
  return [
    "你是 Arena Hero 的战略指挥官，只做低频宏观决策，不做逐 Tick 战术。",
    "根据以下宏观状态，输出一个策略 JSON 对象（不要输出任何其他内容，不要 markdown 围栏）：",
    `{"posture":"harvest|balanced|aggressive","workerTarget":<1-16整数>,"militaryRatio":<0-1>,"focusRegion":<[x,y]或null>,"attackPriority":"core|workers|null"}`,
    "字段含义：posture=战略姿态（harvest 纯经济/balanced 均衡/aggressive 主动进攻）；",
    "workerTarget=目标 Worker 数量；militaryRatio=军事单位占比目标；",
    "focusRegion=探索/攻坚聚焦坐标（null 不聚焦）；attackPriority=攻击优先级（core 拆家掠夺资源/workers 断敌经济/null 不主动攻击）。",
    "策略是低频演进而非重掷：优先在 previous policy 基础上做小幅调整（workerTarget 变化幅度建议 ≤4/周期）。",
    "",
    "宏观状态：",
    `tick: ${state.tick}`,
    `resources: ${state.resources} / ${state.resourceCapacity}`,
    `population: ${state.population} (workers ${state.workers.length}, military ${military})`,
    coreLine,
    `visible enemies: ${state.visibleEnemies.length}`,
    `beacon: ${state.beacon.status}${state.beacon.carrierId !== null ? " (carried)" : ""}`,
    `visible resource cells: ${state.resourceCells.size}`,
    trendLine,
    baselineLine,
  ].join("\n");
}

/**
 * pi AgentSession.prompt 不返回文本（流式）：prompt resolve 后从 session.state.messages
 * 读取最后一条 assistant 消息的文本内容（content 数组的 text 片段拼接）。
 * 非 assistant / 无文本 / stopReason error → 抛错（orchestrator sticky 处理）。
 */
export function readLastAssistantText(session: unknown): string {
  const state = (session as { state?: { messages?: unknown[] } }).state;
  const messages = state?.messages ?? [];
  const last = messages[messages.length - 1] as
    | { role?: unknown; content?: unknown; stopReason?: unknown }
    | undefined;
  if (last === undefined || last.role !== "assistant") {
    throw new Error("policy session: last message is not assistant");
  }
  if (last.stopReason === "error") {
    throw new Error("policy session: assistant stopReason is error");
  }
  const parts = Array.isArray(last.content) ? last.content : [];
  const text = parts
    .filter((part): part is { type: string; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: string }).type === "text")
    .map((part) => part.text)
    .join("");
  if (text.trim().length === 0) {
    throw new Error("policy session: assistant message has no text content");
  }
  return text;
}
