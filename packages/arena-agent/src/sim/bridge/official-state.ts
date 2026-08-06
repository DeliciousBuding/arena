/**
 * 官方 PlayerState JSON 构造（桥接外部策略进程的状态接口，与 Rust 线
 * arena-sim-bridge 对偶）。形状对齐官方 Python SDK `arena_hero.models.PlayerState`
 * （snake_case）：顶层 status/respawn_at_tick/resources/population/
 * population_tier/upkeep_next_tick/champion_beacon/objects/events；objects 是
 * 带 kind 判别器的 WorldObject 数组（CoreView/UnitView/TerrainView 批）。
 *
 * 已知差距（与 Rust 线登记一致）：**vision 过滤不做**——solo 场景默认全可见
 * 语义（我方策略同样全可见），公平对等。
 */

import type { TickState } from "../../domain/model.ts";
import { canonicalUuid } from "./canonical-uuid.ts";

type Json = Record<string, unknown>;

/** TickState → 官方 PlayerState JSON（snake_case）。 */
export function stateToOfficialJson(state: TickState): Json {
  const objects: Json[] = [];

  if (state.core !== null) {
    const owner = state.core.ownerUsername.length >= 3 ? state.core.ownerUsername : "sim";
    objects.push({
      kind: "CORE",
      id: canonicalUuid(state.core.id),
      controlled: true,
      owner_username: owner,
      position: [state.core.position[0], state.core.position[1]],
      hp: state.core.hp,
      shield: state.core.shield,
      state: state.core.state,
    });
  }

  for (const unit of [...state.workers, ...state.vanguards, ...state.rangers]) {
    const view: Json = {
      kind: "UNIT",
      id: canonicalUuid(unit.id),
      controlled: true,
      position: [unit.position[0], unit.position[1]],
      hp: unit.hp,
      unit_type: unit.unitType,
    };
    if (unit.unitType === "WORKER") {
      view.cargo = unit.cargo;
    }
    objects.push(view);
  }

  for (const enemy of state.visibleEnemies) {
    objects.push({
      kind: "UNIT",
      id: canonicalUuid(enemy.id),
      controlled: false,
      position: [enemy.position[0], enemy.position[1]],
      hp: enemy.hp,
      unit_type: enemy.unitType ?? "WORKER",
    });
  }

  const obstaclePositions = [...state.obstacleCells].map(parseCellKey);
  if (obstaclePositions.length > 0) {
    objects.push({ kind: "OBSTACLE", positions: obstaclePositions });
  }
  const resourcePositions = [...state.resourceCells].map(parseCellKey);
  if (resourcePositions.length > 0) {
    objects.push({ kind: "RESOURCE", positions: resourcePositions });
  }

  const events = state.events.map((event, index) => ({
    // sim 事件 ID 是 "sim:..." 内部格式，SDK 要求合法 UUID——一律确定性转换
    //（同 eventId 恒同 UUID；空 ID 用 tick+序号 生成）。
    event_id:
      event.eventId.length > 0 ? canonicalUuid(event.eventId) : canonicalUuid(`evt-${event.tick}-${index}`),
    tick: event.tick,
    event_type: event.eventType,
    reason_code: event.reasonCode,
    actor_id: event.actorId !== null ? canonicalUuid(event.actorId) : null,
    target_id: event.targetId !== null ? canonicalUuid(event.targetId) : null,
    position: event.position !== undefined ? [event.position[0], event.position[1]] : null,
    values: event.values,
  }));

  return {
    status: state.status,
    respawn_at_tick: null,
    resources: state.resources,
    population: state.population,
    population_tier: 0,
    upkeep_next_tick: 0,
    champion_beacon: {
      position: [state.beacon.position[0], state.beacon.position[1]],
      status: state.beacon.status,
      carrier_id: state.beacon.carrierId !== null ? canonicalUuid(state.beacon.carrierId) : null,
    },
    objects,
    events,
  };
}

function parseCellKey(key: string): readonly [number, number] {
  const parts = key.split(",");
  return [Number(parts[0]), Number(parts[1])];
}
