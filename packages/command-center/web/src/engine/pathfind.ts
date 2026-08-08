/* Arena 指挥面板前端 — BFS 寻路（纯函数，无 DOM/state 依赖；测绘记忆由调用方注入） */

import { pKey } from "./utils.ts";
import { TACT_STEPS, tactTerrain } from "./tactical.ts";

/** BFS 寻路：world 实时障碍 + 可选额外障碍（测绘记忆/雾区）→ 起点到终点路径或 null。
 *  单位/核心为动态障碍（非目标格不可穿过）；LIMIT 防雾区大图死循环。 */
export function findPath(world: any, from: any, to: any, extraObstacles?: Set<string>) {
  const obstacles = tactTerrain(world, "OBSTACLE");
  if (extraObstacles) for (const k of extraObstacles) obstacles.add(k);
  if (obstacles.has(pKey(to))) return null;
  const entities = new Set();
  for (const o of world.state.objects) {
    if (o.kind !== "UNIT" && o.kind !== "CORE") continue;
    const p = o.position; if (p) entities.add(pKey(p));
  }
  entities.delete(pKey(from));
  const goalK = pKey(to);
  const queue = [[from]], visited = new Set([pKey(from)]);
  const LIMIT = 20000;
  while (queue.length) {
    const path = queue.shift();
    if (!path) continue;
    const cur = path[path.length - 1];
    if (pKey(cur) === goalK) return path;
    if (path.length >= LIMIT) return null;
    for (const { dx, dy } of TACT_STEPS) {
      const n = [cur[0] + dx, cur[1] + dy] as [number, number], k = pKey(n);
      if (visited.has(k) || obstacles.has(k)) continue;
      if (k !== goalK && entities.has(k)) continue;
      visited.add(k);
      queue.push([...path, n]);
    }
  }
  return null;
}
