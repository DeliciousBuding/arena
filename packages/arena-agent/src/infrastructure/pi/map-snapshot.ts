/**
 * MapSnapshot 构造（切片 4 阶段 6，leader 集成）。
 *
 * 本 Tick 冻结地图快照从决策时点 TickState 构造——不请求 Python /map/query、
 * 不读实时可变 World（切片 5 接入共享 MapStore 时替换此构造，不改工具接口）。
 */

import type { TickState } from "../../domain/model.ts";
import type { MapSnapshot } from "./tools/tool-context.ts";

/** 从 TickState 构造冻结地图快照（bounds 由已知格求最大界）。 */
export function mapSnapshotOf(state: TickState): MapSnapshot {
  const resourceCells = [...state.resourceCells].map(parseCell);
  const obstacleCells = [...state.obstacleCells].map(parseCell);
  let width = 0;
  let height = 0;
  for (const [x, y] of [...resourceCells, ...obstacleCells]) {
    width = Math.max(width, x + 1);
    height = Math.max(height, y + 1);
  }
  return {
    stats: {
      width,
      height,
      obstacleCount: obstacleCells.length,
      resourceCellCount: resourceCells.length,
    },
    resources: resourceCells.map(([x, y]) => ({ position: [x, y] })),
    obstacles: obstacleCells,
    allies: state.units.map((u) => ({ id: u.id, unitType: u.unitType, position: [...u.position] })),
    enemies: state.visibleEnemies.map((e) => ({
      id: e.id,
      unitType: (e.unitType ?? "UNKNOWN") as MapSnapshot["enemies"][number]["unitType"],
      position: [...e.position],
    })),
  };
}

/** "x,y" → [x, y]；非法格忽略（bounds 计算容忍）。 */
function parseCell(key: string): [number, number] {
  const parts = key.split(",");
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0];
}
