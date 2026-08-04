/** PlanningSnapshot：把 domain TickState 降采样为规划所需的不可变快照。
 *
 * - 只保留规划关心的字段，planner 不直接依赖 domain 全量状态
 * - 提取时复制并冻结集合/映射，保证不可变
 * - 格子键统一 "x,y"（与 domain model.ts 的 cellKey 同格式）
 */

import { cellKey, parseCellKey, type Position, type TickState, type UnitType } from "../domain/model.ts";

/** 受控单位快照（planner 只读所需字段）。 */
export interface PlanningUnit {
  readonly id: string;
  readonly unitType: UnitType;
  readonly position: Position;
  readonly hp: number;
  readonly cargo: number;
}

/** 可见敌方单位（planner 只关心位置与类型）。 */
export interface EnemyUnit {
  readonly id: string;
  readonly position: Position;
  readonly unitType?: UnitType;
}

/** 已知资源格信息（kind 可选：未来可从事件/探测补充矿种）。 */
export interface ResourceCellInfo {
  readonly position: Position;
  readonly kind?: string;
}

export interface BeaconInfo {
  readonly position: Position;
  readonly status: "GROUND" | "CARRIED";
  readonly carrierId: string | null;
}

export interface PlanningSnapshot {
  readonly tick: number;
  /** 当前资源余额。 */
  readonly resources: number;
  readonly resourceCapacity: number;
  /** 剩余可卸货空间（DEPOSIT 合法性判断；0 = 资源满，卸货通道关闭）。 */
  readonly resourceSpace: number;
  readonly population: number;
  /** 受控单位全量快照（planner 只取 WORKER 分配）。 */
  readonly units: readonly PlanningUnit[];
  /** 已知资源格：key "x,y" → 格信息。 */
  readonly resourceCells: ReadonlyMap<string, ResourceCellInfo>;
  readonly obstacleCells: ReadonlySet<string>;
  readonly enemyUnits: readonly EnemyUnit[];
  readonly corePosition: Position | null;
  readonly coreHp: number | null;
  readonly beacon: BeaconInfo;
  /** 敌人距离衰减风险：key "x,y" → 威胁值（无敌人覆盖的格查不到，视为 0）。 */
  readonly threatMap: ReadonlyMap<string, number>;
}

/** 威胁衰减半径：只在该半径内落 threatMap 条目（之外视为 0）。 */
const THREAT_RADIUS = 3;

/** 威胁贡献 = 1 / (1 + 曼哈顿距离)：距离倒数衰减，敌人自身格 = 1。 */
function threatContribution(distance: number): number {
  return 1 / (1 + distance);
}

/** 由可见敌方单位构建威胁图（距离倒数衰减，多敌人同格累加）。 */
export function buildThreatMap(enemies: readonly EnemyUnit[]): ReadonlyMap<string, number> {
  const threat = new Map<string, number>();
  for (const enemy of enemies) {
    const ex = enemy.position[0];
    const ey = enemy.position[1];
    for (let dx = -THREAT_RADIUS; dx <= THREAT_RADIUS; dx += 1) {
      for (let dy = -THREAT_RADIUS; dy <= THREAT_RADIUS; dy += 1) {
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance > THREAT_RADIUS) {
          continue;
        }
        const key = cellKey([ex + dx, ey + dy]);
        threat.set(key, (threat.get(key) ?? 0) + threatContribution(distance));
      }
    }
  }
  return threat;
}

/** 从 domain TickState 提取规划快照。
 *
 * 注意：TickState 的 resourceCells/obstacleCells 本身已是 "x,y" 键的
 * Set<string>（见 domain/model.ts），此处原样复制为 Map/Set。
 */
export function extractPlanningSnapshot(state: TickState): PlanningSnapshot {
  const units: PlanningUnit[] = state.units.map((unit) => ({
    id: unit.id,
    unitType: unit.unitType,
    position: unit.position,
    hp: unit.hp,
    cargo: unit.cargo,
  }));
  const enemyUnits: EnemyUnit[] = state.visibleEnemies
    .filter((enemy) => enemy.kind === "UNIT")
    .map((enemy) => ({ id: enemy.id, position: enemy.position, unitType: enemy.unitType }));
  const resourceCells = new Map<string, ResourceCellInfo>();
  for (const key of state.resourceCells) {
    resourceCells.set(key, { position: parseCellKey(key) });
  }
  return {
    tick: state.tick,
    resources: state.resources,
    resourceCapacity: state.resourceCapacity,
    resourceSpace: state.resourceSpace,
    population: state.population,
    units,
    resourceCells,
    obstacleCells: new Set(state.obstacleCells),
    enemyUnits,
    corePosition: state.core?.position ?? null,
    coreHp: state.core?.hp ?? null,
    beacon: {
      position: state.beacon.position,
      status: state.beacon.status,
      carrierId: state.beacon.carrierId,
    },
    threatMap: buildThreatMap(enemyUnits),
  };
}
