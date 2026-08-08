/** 敌核威胁提炼（2026-08-08，算法适配·raid-defense 输入）：
 *  从敌核轨迹提炼“逼近 / 近距目击”结构化威胁列表。
 *  纯函数（入参即测），双消费者共用：
 *  - 参谋建议第 11 层（alliance-advice）：转建议时每租户 cap 3 防刷屏；
 *  - 决策输入（decision-input）：全量暴露，mission 层自行决策防御部署方向。
 *
 *  规则：
 *  - approaching：轨迹≥2点且 computeCoreMovement 判逼近，且距友核 ≤ approachRadius；
 *  - proximity：方向未知（单点目击为主）但最近目击 ≤ proximityRadius；
 *  - stale：目击时间超过 staleAfterTicks（可能已离开，信心度降级）。 */
import type { TrailPoint } from "./trails.ts";
import { computeCoreMovement } from "./trails.ts";

export interface CoreThreatInput {
  username: string;
  /** approaching=确认逼近 / proximity=方向未知但近距目击。 */
  kind: "approaching" | "proximity";
  distCells: number;
  speedCellsPerTick: number | null;
  lastSeenTick: number;
  x: number;
  y: number;
  stale: boolean;
}

const cheb = (a: readonly number[], b: readonly number[]): number =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

export interface CoreThreatOptions {
  approachRadius?: number;
  proximityRadius?: number;
  staleAfterTicks?: number;
}

export const DEFAULT_CORE_THREAT_OPTS: Required<CoreThreatOptions> = {
  approachRadius: 60,
  proximityRadius: 40,
  staleAfterTicks: 5000,
};

/** 提炼敌核威胁（纯函数）：轨迹列表 + 友核 + 当前 tick → 威胁列表。 */
export function collectCoreThreats(
  trails: ReadonlyArray<{ username: string; trail: readonly TrailPoint[] }>,
  friendlyCore: readonly number[] | null,
  currentTick: number,
  opts: CoreThreatOptions = {},
): CoreThreatInput[] {
  const { approachRadius, proximityRadius, staleAfterTicks } = { ...DEFAULT_CORE_THREAT_OPTS, ...opts };
  const out: CoreThreatInput[] = [];
  if (!friendlyCore || friendlyCore.length < 2) return out;
  for (const tr of trails ?? []) {
    if (!tr?.trail?.length) continue;
    const mv = computeCoreMovement(tr.trail, friendlyCore);
    const last = tr.trail[tr.trail.length - 1];
    const dist = mv.distToCoreCells ?? cheb([last.x, last.y], friendlyCore);
    if (!Number.isFinite(dist)) continue;
    const age = currentTick > 0 ? Math.max(0, currentTick - last.tick) : 0;
    const stale = age > staleAfterTicks;
    if (mv.direction === "approaching") {
      if (dist > approachRadius) continue;
      out.push({
        username: tr.username,
        kind: "approaching",
        distCells: dist,
        speedCellsPerTick: mv.speedCellsPerTick,
        lastSeenTick: last.tick,
        x: last.x,
        y: last.y,
        stale,
      });
    } else {
      if (dist > proximityRadius) continue;
      out.push({
        username: tr.username,
        kind: "proximity",
        distCells: dist,
        speedCellsPerTick: null,
        lastSeenTick: last.tick,
        x: last.x,
        y: last.y,
        stale,
      });
    }
  }
  return out.sort((a, b) => a.distCells - b.distCells || Number(b.stale) - Number(a.stale));
}
