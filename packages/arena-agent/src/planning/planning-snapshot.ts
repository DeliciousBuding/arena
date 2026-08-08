/** PlanningSnapshot：把 domain TickState 降采样为规划所需的不可变快照。
 *
 * - 只保留规划关心的字段，planner 不直接依赖 domain 全量状态
 * - 提取时复制并冻结集合/映射，保证不可变
 * - 格子键统一 "x,y"（与 domain model.ts 的 cellKey 同格式）
 */

import { cellKey, parseCellKey, type CoreState, type Position, type TickState, type UnitType } from "../domain/model.ts";

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

/** 已知资源格信息（kind 可选：未来可从事件/探测补充矿种；
 *  visible/lastSeenTick/seeded：目标置信元数据——可见格由快照提取标注，
 *  记忆/测绘种子格由 decide() 合并 World.resourceCandidates 时标注。 */
export interface ResourceCellInfo {
  readonly position: Position;
  readonly kind?: string;
  /** 本 Tick 可见（快照提取时置 true；记忆合并格为 false）。 */
  readonly visible?: boolean;
  /** 最近一次看到该格的 tick（visible 格 = 当前 tick）。 */
  readonly lastSeenTick?: number;
  /** 跨 run 测绘种子（survey-db seed）：无真实观察，置信低于可见/新鲜记忆。 */
  readonly seeded?: boolean;
}

export interface BeaconInfo {
  readonly position: Position;
  /** null = Beacon 格不在本玩家视野内（官方：坐标恒知，状态仅格子可见时可知）。 */
  readonly status: "GROUND" | "CARRIED" | null;
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
  /** 所有可见敌人占用格（含敌方 CORE——CORE 是永久障碍，Worker 回仓路线
   *  被敌方 CORE 挡时会反复 capacity_wait:DEPOSIT，生产实测）。 */
  readonly enemyCells: ReadonlySet<string>;
  readonly enemyUnits: readonly EnemyUnit[];
  readonly corePosition: Position | null;
  readonly coreHp: number | null;
  /** 受控核心迁移状态（2026-08-07，core-moving-hold-v1）：MOVING 时
   *  deterministic worker 的 DEPOSIT 必须持货待命，不能追交空跑。 */
  readonly coreState: CoreState | null;
  readonly beacon: BeaconInfo;
  /** 敌人距离衰减风险：key "x,y" → 威胁值（无敌人覆盖的格查不到，视为 0）。 */
  readonly threatMap: ReadonlyMap<string, number>;
  /** 矿刷新预测（Phase 2，G3 数据管道）：key "x,y" → dueInTicks（正=还有多久预计
   *  刷新，负=已过预期——疑似采空）。缺省 undefined = 无预测（零回归）。 */
  readonly refillPredictions?: ReadonlyMap<string, number>;
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
  const enemyCells = new Set(state.visibleEnemies.map((enemy) => cellKey(enemy.position)));
  const resourceCells = new Map<string, ResourceCellInfo>();
  for (const key of state.resourceCells) {
    resourceCells.set(key, {
      position: parseCellKey(key),
      visible: true,
      lastSeenTick: state.tick,
    });
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
    enemyCells,
    enemyUnits,
    corePosition: state.core?.position ?? null,
    coreHp: state.core?.hp ?? null,
    coreState: state.core?.state ?? null,
    beacon: {
      position: state.beacon.position,
      status: state.beacon.status,
      carrierId: state.beacon.carrierId,
    },
    threatMap: buildThreatMap(enemyUnits),
  };
}
