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
    /** 最近 stall 告警摘要（检测器事件；无则省略该行）。 */
    readonly recentStallEvents?: readonly string[];
    /** 决策指挥状态（执行层临时接管时策略层必须配合）：policy/stall_recovery/escalation。 */
    readonly commandState?: string;
    /** 上次自愈结局（recovered/failed/expired；agent 智能跳出闭环的结果反馈）。 */
    readonly lastRecoveryOutcome?: {
      readonly outcome: "recovered" | "failed" | "expired";
      readonly kind: string | null;
      readonly tick: number;
    } | null;
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
  const stallLine = (extras.recentStallEvents ?? []).length === 0
    ? null
    : `recent stall warnings: ${(extras.recentStallEvents ?? []).join(" | ")}`;
  const commandLine =
    extras.commandState === undefined || extras.commandState === "policy"
      ? null
      : extras.commandState === "stall_recovery"
        ? "command state: stall_recovery active（执行层自愈中——你必须 focusRegion=null，配合回仓恢复）"
        : "command state: escalation active（执行层 all-in 军事翻盘中——不要输出 focusRegion，维持 aggressive 姿态）";
  const recoveryOutcomeLine = (() => {
    const last = extras.lastRecoveryOutcome;
    if (last === undefined || last === null) return null;
    const label = last.outcome === "recovered"
      ? "上次自愈成功（经济恢复），僵局已解除"
      : last.outcome === "failed"
        ? "上次自愈失败（到期未恢复）——僵局根因未被 focusRegion=null 解决：不要再用远点 focus，应转军事压制或重置 workerTarget"
        : "上次 escalating 终局尝试到期——all-in 军事未翻盘：恢复经济为第一优先，停止无谓远征";
    return `last recovery outcome: ${label} (kind=${last.kind ?? "unknown"}@tick=${last.tick})`;
  })();
  return [
    "你是 Arena Hero 的战略指挥官，只做低频宏观决策，不做逐 Tick 战术。",
    "根据以下宏观状态，输出一个策略 JSON 对象（不要输出任何其他内容，不要 markdown 围栏）：",
    `{"posture":"harvest|balanced|aggressive","workerTarget":<1-16整数>,"militaryRatio":<0-1>,"focusRegion":<[x,y]或null>,"attackPriority":"core|workers|null"}`,
    "字段含义：posture=战略姿态（harvest 纯经济/balanced 均衡/aggressive 主动进攻）；",
    "workerTarget=目标 Worker 数量；militaryRatio=军事单位占比目标；",
    "focusRegion=探索/攻坚聚焦坐标（null 不聚焦）；attackPriority=攻击优先级（core 拆家掠夺资源/workers 断敌经济/null 不主动攻击）。",
    "focusRegion 约束：必须是非负整数坐标（地图原点 [0,0]），且必须在己方 Core 附近可探索范围内（建议距 Core ≤30 格）；",
    "严禁输出远离己方基地的坐标（如地图角落）——worker 会直线远征导致 0 采集、经济冻结（生产实测教训）；",
    "资源枯竭/视野 0 资源格时应提高 militaryRatio 转军事压制，而不是把 worker 支去远处找矿。",
    "recent stall warnings 出现 = 执行层疑似卡死：必须 focusRegion=null（聚焦区会支走 worker 加剧卡死），",
    "并优先恢复经济（harvest/balanced）或转军事压制（militaryRatio>0）打破僵局。",
    "策略是低频演进而非重掷：优先在 previous policy 基础上做小幅调整（workerTarget 变化幅度建议 ≤4/周期）。",
    "军事单位价值：敌方单位/Core 群会阻挡 Worker 回仓与采集（经济停滞的直接原因，生产实测）；",
    "适当 militaryRatio（>0）配前压清场能显著提升经济（生产 A/B 实测：清场方资源均值 20 满仓 vs 被压方 5）。",
    "militaryRatio 约束（模拟器 500 ticks 实证）：0.3-0.4 是军事性价比拐点（军队优势明显、经济代价可控）；",
    "0.5 以上不增加军队（产兵饱和）却持续烧资源（资源 4.3 vs 纯经济 29）——高比例是纯损耗，禁止输出 militaryRatio>0.5。",
    "attackPriority 约束（模拟器对打 300 ticks 实证，aggressive 姿态下）：core 拆家掠夺最优（edge +33，",
    "拆家掠夺资源直接终结对手经济、敌人 Core 拆掉后兵力归零）；workers 断经济最差（edge +19，只杀 Worker",
    "不拆家，敌人 Core 继续产兵）；null 居中（edge +32.5，追最近敌易被工人海消耗）——",
    "aggressive 姿态优先 attackPriority=core，balanced/harvest 用 null（前压不触发，字段不消费）。",
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
    ...(stallLine === null ? [] : [stallLine]),
    ...(commandLine === null ? [] : [commandLine]),
    ...(recoveryOutcomeLine === null ? [] : [recoveryOutcomeLine]),
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
