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
 * arena_map：Arena Hero 共享地图只读查询工具（pi-arena extension）。
 *
 * 地图数据在 arena-bot 侧（SQLite map_store），本工具是查询代理：
 * execute 发 HTTP 到 arena-bot 调试端点 /map/query，把结果 JSON 返回给 LLM。
 * 后端地址从环境变量 ARENA_MAP_URL 注入（Python 侧 spawn 时设置）。
 * 不 terminate——查询后模型继续思考/再查/提交 arena_plan。
 * Schema SSOT：contracts/world-query.schema.json（协议版本 1.0）。
 */

type ToolRenderCtx = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

const arenaMapSchema = Type.Object(
	{
		query: Type.Union(
			[
				Type.Literal("stats"),
				Type.Literal("obstacles"),
				Type.Literal("resources"),
				Type.Literal("allies"),
			],
			{
				description:
					"stats=地图统计；obstacles=已知障碍格；resources=已知资源格；allies=盟友名单",
			},
		),
		bounds: Type.Optional(
			Type.Array(Type.Number(), {
				minItems: 4,
				maxItems: 4,
				description: "[x1,y1,x2,y2] 可选范围过滤，省略返回全部（最多 200 格）",
			}),
		),
	},
	{ additionalProperties: false },
);

export type ArenaMapParams = Static<typeof arenaMapSchema>;

export interface ArenaMapDetails {
	kind: string;
	count: number;
	elapsedMs: number;
}

const QUERY_TIMEOUT_MS = 5000; // 查询超时：15s 游戏窗口内必须留决策余量

export function createArenaMapToolDefinition(
	mapUrl: string | undefined,
): ToolDefinition<typeof arenaMapSchema, ArenaMapDetails | undefined> {
	return {
		name: "arena_map",
		label: "arena_map",
		description:
			"查询 Arena Hero 共享地图（各账号共同测绘的已知障碍/盟友，以及资源格）。" +
			"返回 JSON：stats 给统计；obstacles 给已知障碍格坐标列表；allies 给我们账号名单。",
		promptSnippet: "查询共享地图（障碍/盟友/统计）",
		promptGuidelines: [
			"仅在需要回忆已探索区域、障碍分布或盟友名单时查询，不要每 Tick 都查。",
			"查询后必须调用 arena_plan 提交计划，不要调用其他工具。",
		],
		parameters: arenaMapSchema,
		async execute(
			_toolCallId: string,
			params: ArenaMapParams,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<undefined> | undefined,
		): Promise<AgentToolResult<ArenaMapDetails | undefined>> {
			if (!mapUrl) {
				throw new Error("arena_map 未配置地图后端（缺 ARENA_MAP_URL）");
			}
			const t0 = Date.now();
			const url = new URL(`${mapUrl}/map/query`);
			url.searchParams.set("query", params.query);
			if (params.bounds) {
				url.searchParams.set("bounds", params.bounds.join(","));
			}
			const timeoutSignal = AbortSignal.timeout(QUERY_TIMEOUT_MS);
			const res = await fetch(url, {
				signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
			});
			if (!res.ok) {
				throw new Error(`地图查询失败 HTTP ${res.status}`);
			}
			const data = (await res.json()) as Record<string, unknown>;
			const count =
				typeof data.count === "number" ? data.count
					: typeof data.obstacles_known === "number" ? data.obstacles_known
						: Array.isArray(data.usernames) ? data.usernames.length
							: 0;
			return {
				content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
				details: { kind: params.query, count, elapsedMs: Date.now() - t0 },
				terminate: false,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const title = theme.fg("toolTitle", theme.bold("🗺 arena_map"));
			let summary = args ? `${args.query}` : "(invalid)";
			if (args?.bounds) summary += ` @[${args.bounds.join(",")}]`;
			text.setText(`${title}\n${theme.fg("toolOutput", summary)}`);
			return text;
		},
		renderResult(
			result: AgentToolResult<ArenaMapDetails | undefined>,
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
				meta.push(`${details.kind}: ${details.count}`);
				meta.push(`Took ${(details.elapsedMs / 1000).toFixed(1)}s`);
			}
			text.setText(
				`${output || theme.fg("muted", "(no data)")}\n${theme.fg("muted", meta.join(" · "))}`,
			);
			return text;
		},
	};
}
