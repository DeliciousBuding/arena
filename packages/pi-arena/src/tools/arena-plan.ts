import { type Static, Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-tui";

/**
 * arena_plan：Arena Hero 游戏动作工具（pi-arena extension）。
 *
 * 给 LLM 的原生 tool calling 入口——模型通过 tool_use 输出下一 Tick 计划，
 * arena-bot 从 tool_execution_start 事件提取 input 并校验后提交游戏。
 * execute 只做"确认接收"并 terminate（回合立即结束，不烧多余 token）。
 * Schema SSOT：contracts/arena-plan.schema.json（协议版本 1.0）。
 */

// ToolRenderContext 未从 pi 包入口导出，从 ToolDefinition 提取（保持类型安全）
type ToolRenderCtx = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

const actionSchema = Type.Object(
	{
		unit: Type.String({ description: "单位完整 UUID（来自状态中的单位列表）" }),
		kind: Type.Union(
			[
				Type.Literal("MOVE"),
				Type.Literal("SWEEP"),
				Type.Literal("SHOOT"),
				Type.Literal("HARVEST"),
				Type.Literal("DEPOSIT"),
				Type.Literal("HEAL"),
				Type.Literal("PICKUP_BEACON"),
				Type.Literal("DROP_BEACON"),
				Type.Literal("SELF_DESTRUCT"),
				Type.Literal("WAIT"),
			],
			{ description: "动作类型（MOVE/SWEEP 需要 direction）" },
		),
		direction: Type.Optional(
			Type.Union(
				[
					Type.Literal("UP"),
					Type.Literal("DOWN"),
					Type.Literal("LEFT"),
					Type.Literal("RIGHT"),
				],
				{ description: "方向（MOVE/SWEEP 必需）" },
			),
		),
		target_id: Type.Optional(
			Type.String({ description: "射击目标 UUID（SHOOT 用）" }),
		),
		expected_cell: Type.Optional(
			Type.Array(Type.Number(), { minItems: 2, maxItems: 2 }),
		),
	},
	{ additionalProperties: false },
);

const arenaPlanSchema = Type.Object(
	{
		actions: Type.Array(actionSchema, {
			description: "每个单位的动作（每单位最多一条）",
		}),
		core: Type.Optional(
			Type.Union(
				[
					Type.Object(
						{
							kind: Type.Literal("SPAWN"),
							unit_type: Type.Union(
								[
									Type.Literal("WORKER"),
									Type.Literal("VANGUARD"),
									Type.Literal("RANGER"),
								],
							),
						},
						{ additionalProperties: false },
					),
					Type.Object({ kind: Type.Literal("HEAL") }, { additionalProperties: false }),
					Type.Object(
						{ kind: Type.Literal("REPAIR_SHIELD") },
						{ additionalProperties: false },
					),
					Type.Object({ kind: Type.Literal("WAIT") }, { additionalProperties: false }),
					Type.Null(),
				],
				{ description: "Core 动作（可选，null 表示不动）" },
			),
		),
		reason: Type.Optional(Type.String({ description: "一句话决策理由" })),
	},
	{ additionalProperties: false },
);

export type ArenaPlanParams = Static<typeof arenaPlanSchema>;

export interface ArenaPlanDetails {
	unitCount: number;
	coreAction: string;
	reason?: string;
}

/** 计划摘要行（renderCall 正文）。返回 null 表示参数非法。 */
function summarizeActions(params: ArenaPlanParams | undefined): string[] | null {
	if (!params) return null;
	const lines: string[] = [];
	for (const action of params.actions ?? []) {
		const unit = action.unit.slice(0, 8);
		let summary = `${unit} ${action.kind}`;
		if (action.direction) summary += ` ${action.direction}`;
		if (action.target_id) summary += ` →${action.target_id.slice(0, 8)}`;
		if (action.expected_cell) summary += ` @[${action.expected_cell.join(",")}]`;
		lines.push(`- ${summary}`);
	}
	if (params.core && typeof params.core === "object" && "kind" in params.core) {
		const core = params.core;
		const kind = core.kind === "SPAWN" ? `SPAWN ${core.unit_type}` : core.kind;
		lines.push(`core: ${kind}`);
	}
	if (params.reason) lines.push(`💡 ${params.reason}`);
	return lines;
}

export function createArenaPlanToolDefinition(): ToolDefinition<
	typeof arenaPlanSchema,
	ArenaPlanDetails | undefined
> {
	return {
		name: "arena_plan",
		label: "arena_plan",
		description:
			"提交本 Tick 的 Arena Hero 游戏行动计划（每个受控单位的动作 + 可选 Core 动作）。" +
			"动作必须引用状态中存在的单位 UUID。无法决定时提交空 actions。",
		promptSnippet: "提交 Arena Hero 行动计划的唯一收尾工具",
		promptGuidelines: [
			"最后且只能调用一次 arena_plan 提交完整计划，调用后立即结束本轮。",
			"不要调用任何其他工具（bash/read 等与本决策无关）。",
			"无法决定时就提交空 actions 而不是犹豫。",
		],
		parameters: arenaPlanSchema,
		async execute(
			_toolCallId: string,
			params: ArenaPlanParams,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<undefined> | undefined,
		): Promise<AgentToolResult<ArenaPlanDetails | undefined>> {
			// 计划已由调用方（arena-bot）从 tool_use 提取，这里只确认并结束回合。
			const core = params.core;
			const coreAction =
				core === null
					? "null"
					: core && typeof core === "object" && "kind" in core
						? core.kind === "SPAWN"
							? `SPAWN ${core.unit_type}`
							: core.kind
						: "WAIT";
			return {
				content: [
					{
						type: "text",
						text: "计划已接收。请直接结束本轮，不要输出其他内容或调用其他工具。",
					},
				],
				details: {
					unitCount: (params.actions ?? []).length,
					coreAction,
					reason: params.reason,
				},
				terminate: true,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const summary = summarizeActions(args);
			const title = theme.fg("toolTitle", theme.bold("🎯 arena_plan"));
			if (summary === null) {
				text.setText(`${title}\n${theme.fg("error", "[invalid arg]")}`);
			} else if (summary.length === 0) {
				text.setText(`${title}\n${theme.fg("muted", "(empty plan)")}`);
			} else {
				text.setText(`${title}\n${summary.join("\n")}`);
			}
			return text;
		},
		renderResult(
			result: AgentToolResult<ArenaPlanDetails | undefined>,
			_options: ToolRenderResultOptions,
			theme: Theme,
			context: ToolRenderCtx,
		) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = theme.fg(
				"toolOutput",
				(result.content.find((c) => c.type === "text")?.text ?? "").trim(),
			);
			const meta: string[] = [];
			const details = result.details;
			if (details) {
				meta.push(
					`${details.unitCount} unit${details.unitCount === 1 ? "" : "s"}` +
						(details.coreAction ? `, core ${details.coreAction}` : ""),
				);
			}
			text.setText(
				`${output || theme.fg("muted", "(accepted)")}\n${theme.fg("muted", meta.join(" · "))}`,
			);
			return text;
		},
	};
}
