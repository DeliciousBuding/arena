import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createArenaMapToolDefinition } from "./tools/arena-map.ts";
import { createArenaPlanToolDefinition } from "./tools/arena-plan.ts";

/**
 * pi-arena：Arena Hero 领域适配层（标准 Pi Extension）。
 *
 * 按 Pi 原生哲学：Pi 是 Agent runtime；Arena 是环境和执行器；
 * 本 extension 是两者之间的领域适配层——只注册 Arena 领域能力，
 * 不碰 Pi 内核。Arena 专用配置通过环境变量注入（ARENA_MAP_URL）。
 *
 * 用法（pi CLI）：
 *   node cli.js --mode rpc --extensions <本文件> --no-builtin-tools \
 *     --tools arena_map,arena_plan
 */
export default function (pi: ExtensionAPI): void {
	// arena_plan：终止型收尾工具（每 Tick 最终计划）
	pi.registerTool(createArenaPlanToolDefinition());

	// arena_map：只读地图查询代理（有后端地址才注册）
	const mapUrl = process.env.ARENA_MAP_URL;
	if (mapUrl) {
		pi.registerTool(createArenaMapToolDefinition(mapUrl));
	}
}
