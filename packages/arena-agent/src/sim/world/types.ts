/**
 * SimWorld 领域模型（S2）：模拟器内部唯一权威状态。
 *
 * 三层状态严格分离（architecture §5.2）：
 *   SimWorld（可含隐藏信息）→ projectPlayerState → PlayerState（wire 等价）→ reduceTurn → TickState
 * 禁止把 SimWorld 强转为 TickState。
 */

import type { Position, UnitType } from "../../domain/model.ts";

/** 已触发/标记的 unsupported 能力（不得当作成功或 WAIT 静默处理）。 */
export type SimFeature =
  | "combat"
  | "core-migration"
  | "beacon"
  | "respawn"
  | "opponent-action"
  | "refill-unknown";

export type PlayerStatus = "ACTIVE" | "RESPAWNING";
export type CoreState = "NORMAL" | "MOVING";

export interface SimCore {
  readonly id: string;
  readonly position: Position;
  readonly hp: number;
  readonly shield: number;
  readonly state: CoreState;
}

export interface SimUnit {
  readonly id: string;
  readonly owner: string; // playerId（SimWorld.players 的 key）
  readonly position: Position;
  readonly hp: number;
  readonly unitType: UnitType;
  readonly cargo: number;
}

export interface SimPlayer {
  readonly id: string;
  readonly username: string;
  readonly status: PlayerStatus;
  readonly resources: number;
  readonly core: SimCore | null;
  readonly units: readonly SimUnit[];
}

export interface ResourceNode {
  readonly cell: Position;
}

export interface SimTerrain {
  /** cellKey（"x,y"）→ 永久障碍格。 */
  readonly obstacles: ReadonlySet<string>;
  /** cellKey → 资源节点（动态可消耗层）。 */
  readonly resources: ReadonlyMap<string, ResourceNode>;
}

export interface SimBeacon {
  readonly position: Position;
}

export interface SimWorld {
  readonly tick: number;
  readonly resolvedTickCount: number;
  readonly rulesVersion: string;
  /** playerId → 玩家（含 Core/Units）。 */
  readonly players: ReadonlyMap<string, SimPlayer>;
  readonly terrain: SimTerrain;
  readonly beacon: SimBeacon | null;
  /** 显式注入的随机源种子；refill/对手动作只从这里取。 */
  readonly seed: number;
  /** 已消费随机数数量（stream position，恢复用）。 */
  readonly rngStreamPosition: number;
  /** 已触发的 unsupported feature（episode 不得作为确定性 Golden）。 */
  readonly unsupportedFeatures: readonly SimFeature[];
  readonly provenance: {
    readonly scenario: string | null;
    readonly sourceCaseHash: string | null;
  };
}

/** occupancy 索引：cellKey → 占位实体数（派生，结算后重建）。 */
export interface OccupancyIndex {
  readonly cells: ReadonlyMap<string, number>;
}
