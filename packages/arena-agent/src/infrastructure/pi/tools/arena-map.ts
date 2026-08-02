/**
 * arena_map 工具（切片 4-4B，总任务书 2.3）：只查本 Tick 冻结快照。
 *
 * 第一版不请求 Python /map/query、不读实时可变 World；mapSnapshot 由
 * PiAgentRuntime 每 run 冻结（缺失 = 地图不可用）。真正共享 SQLite
 * MapStore 在切片 5 接入，届时替换 Provider 不改本工具接口。
 * 不 terminate：查询后模型继续思考/再查/提交 arena_plan。
 */

import { Type, type Static } from "typebox";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { MapSnapshot, ToolContext } from "./tool-context.ts";

const arenaMapSchema = Type.Object(
  {
    query: Type.Union(
      [
        Type.Literal("stats"),
        Type.Literal("resources"),
        Type.Literal("obstacles"),
        Type.Literal("allies"),
        Type.Literal("enemies"),
      ],
      { description: "stats=统计；resources=资源格；obstacles=障碍格；allies=盟友；enemies=敌方" },
    ),
    bounds: Type.Optional(
      Type.Array(Type.Number(), {
        minItems: 4,
        maxItems: 4,
        description: "[x1,y1,x2,y2] 可选范围过滤，省略返回全部",
      }),
    ),
  },
  { additionalProperties: false },
);

export type ArenaMapParams = Static<typeof arenaMapSchema>;

/** 坐标是否落在 bounds [x1,y1,x2,y2] 内（含边界；省略 = 全部通过）。 */
function inBounds(position: readonly [number, number], bounds?: readonly number[]): boolean {
  if (bounds === undefined) {
    return true;
  }
  const [x, y] = position;
  return x >= bounds[0] && x <= bounds[2] && y >= bounds[1] && y <= bounds[3];
}

export function createArenaMapToolDefinition(ctx: ToolContext): ToolDefinition<typeof arenaMapSchema> {
  return {
    name: "arena_map",
    label: "arena_map",
    description:
      "查询本 Tick 冻结的共享地图快照（stats/resources/obstacles/allies/enemies，可选 bounds 范围过滤）。" +
      "只读，可多次调用。",
    promptSnippet: "查询本 Tick 地图快照",
    promptGuidelines: ["在 arena_plan 之前可多次调用 arena_map 获取地图信息。"],
    parameters: arenaMapSchema,
    async execute(_toolCallId, params) {
      const snapshot = ctx.mapSnapshot;
      if (snapshot === null) {
        return {
          content: [{ type: "text", text: "地图不可用（map_mode=disabled，本 Tick 无快照）" }],
          details: undefined,
        };
      }
      let text: string;
      switch (params.query) {
        case "stats": {
          const s = snapshot.stats;
          text = `地图 ${s.width}x${s.height}，障碍 ${s.obstacleCount} 格，资源 ${s.resourceCellCount} 格`;
          break;
        }
        case "resources": {
          const rows = snapshot.resources.filter((r) => inBounds(r.position, params.bounds));
          text =
            rows.length === 0
              ? "（无资源格）"
              : rows.map((r) => `[${r.position.join(",")}]${r.kind ? ` ${r.kind}` : ""}`).join("\n");
          break;
        }
        case "obstacles": {
          const rows = snapshot.obstacles.filter((p) => inBounds(p, params.bounds));
          text = rows.length === 0 ? "（无障碍格）" : rows.map((p) => `[${p.join(",")}]`).join("\n");
          break;
        }
        case "allies": {
          const rows = snapshot.allies.filter((a) => inBounds(a.position, params.bounds));
          text =
            rows.length === 0
              ? "（无盟友）"
              : rows.map((a) => `${a.id} ${a.unitType} @[${a.position.join(",")}]`).join("\n");
          break;
        }
        case "enemies": {
          const rows = snapshot.enemies.filter((e) => inBounds(e.position, params.bounds));
          text =
            rows.length === 0
              ? "（无敌人）"
              : rows.map((e) => `${e.id} ${e.unitType} @[${e.position.join(",")}]`).join("\n");
          break;
        }
      }
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}
