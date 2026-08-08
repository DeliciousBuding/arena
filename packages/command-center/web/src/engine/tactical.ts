/* Arena 指挥面板前端 — 战术规则层（纯常量 + 纯函数，无 DOM/state 依赖，供引擎与测试复用） */

import { pKey, samePos } from "./utils.ts";

export const TENANT_COLORS: Record<string, string> = { t1: "#69b3d8", t2: "#57bd84", t3: "#a892d6", t4: "#dd626d" };
export const TENANT_LABEL: Record<string, string> = { t1: "租户 1", t2: "租户 2", t3: "租户 3", t4: "租户 4" };
export const DECISION_KIND_CN: Record<string, string> = {
  accepted: "已接受", rejected: "已拒绝", timeout: "超时", missed: "错过", aborted: "中止",
  not_applicable: "无需决策", in_progress: "进行中", unknown: "未知",
};
/** 事件 kind → 中文（事件标签页阅读性） */
export const EVENT_KIND_CN: Record<string, string> = {
  UNIT_MOVE_SUCCEEDED: "移动", UNIT_MOVE_FAILED: "移动失败", CORE_MOVE_SUCCEEDED: "核心移动", CORE_MOVE_FAILED: "核心移动失败",
  SPAWN_SUCCEEDED: "生产成功", SPAWN_FAILED: "生产失败",
  HARVEST_SUCCEEDED: "采集成功", HARVEST_FAILED: "采集失败",
  DEPOSIT_SUCCEEDED: "交付成功", DEPOSIT_FAILED: "交付失败",
  SHOT_HIT: "射击命中", SHOT_MISSED: "射击未中", SHOT_BLOCKED: "射击被挡",
  SWEEP_RESOLVED: "清扫解除", SWEEP_FAILED: "清扫失败",
  PICKUP_BEACON_SUCCEEDED: "拾取信标", PICKUP_BEACON_FAILED: "拾取信标失败",
  DROP_BEACON_SUCCEEDED: "放置信标", DROP_BEACON_FAILED: "放置信标失败",
  SELF_DESTRUCT: "自毁", HEAL_SUCCEEDED: "治疗成功", HEAL_FAILED: "治疗失败", REPAIR_SHIELD_SUCCEEDED: "护盾修复",
  UNIT_DESTROYED: "单位被摧毁", CORE_DESTROYED: "核心被摧毁", CORE_DAMAGED: "核心受损", RESPAWN: "重生",
  CORE_RESOURCES_CAPTURED: "夺取敌方资源", CORE_RESOURCE_OVERFLOW_DESTROYED: "溢出资源销毁", WORKER_CARGO_DROPPED: "掉落载货",
  UNIT_HEAL_SUCCEEDED: "单位治疗", UNIT_HEAL_FAILED: "单位治疗失败", CORE_HEAL_SUCCEEDED: "核心治疗", CORE_HEAL_FAILED: "核心治疗失败",
  WAIT: "等待", NOTHING_TO_DO: "无事可做",
};
/** 事件 kind → 图标（事件标签页，几何符号零素材，与 TACT_ACTION_ICON 同风格）。
 *  EventStreamPane 行首图标列；缺省回退「·」（不显示？——统一显示，缺失即 · 防错位）。 */
export const EVENT_ICON: Record<string, string> = {
  UNIT_MOVE_SUCCEEDED: "➤", UNIT_MOVE_FAILED: "➤", CORE_MOVE_SUCCEEDED: "➤", CORE_MOVE_FAILED: "➤",
  SPAWN_SUCCEEDED: "◈", SPAWN_FAILED: "◈",
  HARVEST_SUCCEEDED: "⛏", HARVEST_FAILED: "⛏",
  DEPOSIT_SUCCEEDED: "▣", DEPOSIT_FAILED: "▣",
  SHOT_HIT: "⚔", SHOT_MISSED: "⚔", SHOT_BLOCKED: "⚔",
  SWEEP_RESOLVED: "✸", SWEEP_FAILED: "✸",
  PICKUP_BEACON_SUCCEEDED: "⚑", PICKUP_BEACON_FAILED: "⚑", DROP_BEACON_SUCCEEDED: "⚑", DROP_BEACON_FAILED: "⚑",
  SELF_DESTRUCT: "✕", HEAL_SUCCEEDED: "✚", HEAL_FAILED: "✚", REPAIR_SHIELD_SUCCEEDED: "✚",
  UNIT_DESTROYED: "✕", CORE_DESTROYED: "✕", CORE_DAMAGED: "✕", RESPAWN: "↻",
  CORE_RESOURCES_CAPTURED: "▣", CORE_RESOURCE_OVERFLOW_DESTROYED: "✕", WORKER_CARGO_DROPPED: "▣",
  UNIT_HEAL_SUCCEEDED: "✚", UNIT_HEAL_FAILED: "✚", CORE_HEAL_SUCCEEDED: "✚", CORE_HEAL_FAILED: "✚",
  WAIT: "◷", NOTHING_TO_DO: "·",
};
/** 事迹类别 → 图标（事迹标签页徽标；类别与 /api/deeds/journal 的 categories 对齐）。 */
export const DEED_ICON: Record<string, string> = {
  milestone: "★", harvest: "⛏", deposit: "▣", spawn: "◈",
  death: "✕", conflict: "⚔", economy: "⬢", other: "·",
};

export const TACT_UNIT_BASE_COST: Record<string, number> = { WORKER: 5, VANGUARD: 10, RANGER: 12 };
export const TACT_UNIT_CN: Record<string, string> = { WORKER: "工人", VANGUARD: "先锋", RANGER: "游侠", CORE: "核心" };
/** 单位/核心可用动作 → 中文标签（与 server 校验集一致，缺省显示原文）。 */
export const TACT_ACTION_CN: Record<string, string> = {
  MOVE: "移动", HARVEST: "采集", DEPOSIT: "回仓", SWEEP: "清扫", SHOOT: "攻击",
  PICKUP_BEACON: "拾取信标", DROP_BEACON: "放置信标", SELF_DESTRUCT: "自毁",
  HEAL: "维修", WAIT: "等待", REPAIR_SHIELD: "修复护盾",
  START_MOVE: "开始移动", CANCEL_MOVE: "取消移动",
};
/** 动作图标（右键菜单/批量菜单，几何符号，无需素材）。 */
export const TACT_ACTION_ICON: Record<string, string> = {
  MOVE: "➤", HARVEST: "⛏", DEPOSIT: "▣", SWEEP: "✸", SHOOT: "⚔",
  PICKUP_BEACON: "⚑", DROP_BEACON: "⚑", SELF_DESTRUCT: "✕", HEAL: "✚",
  WAIT: "◷", REPAIR_SHIELD: "◈", START_MOVE: "➤", CANCEL_MOVE: "✕",
};
/** 提交时需要方向参数的动作（点地图选方向），其余为一键动作直接提交。 */
export const TACT_DIRECTION_ACTIONS = new Set(["MOVE", "SWEEP", "START_MOVE"]);
/** 提交时需要目标参数的动作（点地图选敌方目标）。 */
export const TACT_TARGET_ACTIONS = new Set(["SHOOT"]);
export const TACT_STEPS = [{ d: "UP", dx: 0, dy: -1 }, { d: "RIGHT", dx: 1, dy: 0 }, { d: "DOWN", dx: 0, dy: 1 }, { d: "LEFT", dx: -1, dy: 0 }];
export const TACT_RANGER_RAYS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

/** 决策意图 → 短中文标签（2026-08-08，人类观察）：/api/plan 的 intents 值
 *  （vanguard_hunt/go_harvest_mem/capacity_wait:ranger_move/DEPOSIT/WAIT…）映射为
 *  单位头顶小标签——一眼看懂 agent 这 tick 在干嘛；WAIT/无事可做不画（防噪）。 */
export const INTENT_LABEL_CN: Record<string, string> = {
  vanguard_hunt: "猎敌", ranger_hunt: "猎敌", go_harvest_mem: "采忆", go_harvest: "采矿",
  return_deposit: "回仓", escort_core: "护核", protect_core: "守核", pickup_beacon: "取信标",
  drop_beacon: "放信标", sweep: "清扫", patrol: "巡逻", scout: "侦察",
};
export function intentLabelCn(intent: any) {
  if (!intent) return null;
  const base = String(intent).split(":")[0];
  if (INTENT_LABEL_CN[base]) return INTENT_LABEL_CN[base];
  if (intent === "DEPOSIT") return "交付";
  if (intent === "WAIT" || intent === "NOTHING_TO_DO" || intent === "IDLE") return null;
  if (base === "capacity_wait") return "等容";
  if (base === "move_failed" || base.startsWith("move_failed")) return "绕行";
  if (String(intent).includes("_move") || intent === "MOVE") return "移动";
  return String(intent).slice(0, 6);
}

export function tactCoreCapacity(pop: any) { return Math.max(10, Math.max(0, pop) * 5); }
export function tactUnitCost(unitType: any, pop: any) {
  const base = TACT_UNIT_BASE_COST[unitType];
  const exp = pop < 20 ? 0 : Math.floor((pop - 20) / 5) + 1;
  return Math.round(base * Math.pow(1.3, exp));
}
/** 单位/核心近邻命中（2026-08-08）：在 r 格（切比雪夫）内找最近的单位/核心。
 *  用于点击实时命中容差——tick 边界单位移位 1-2 格后，点击其渲染位仍能选中（贴近视觉瞄准）。 */
export function tactObjectNear(world: any, x: any, y: any, r: number) {
  if (!world || !world.state || !Array.isArray(world.state.objects)) return null;
  let best: any = null, bestD = Infinity;
  for (const o of world.state.objects) {
    if (o.kind !== "UNIT" && o.kind !== "CORE") continue;
    if (!o.position) continue;
    const d = Math.max(Math.abs(o.position[0] - x), Math.abs(o.position[1] - y));
    if (d <= r && d < bestD) { bestD = d; best = o; }
  }
  return best;
}
export function tactObjectAt(world: any, x: any, y: any) {
  if (!world) return null;
  for (const o of world.state.objects) {
    if (o.kind === "OBSTACLE" || o.kind === "RESOURCE") continue;
    const p = o.position;
    if (p && p[0] === x && p[1] === y) return o;
  }
  return null;
}
export function tactTerrain(world: any, kind: any) {
  const s = new Set();
  if (!world) return s;
  for (const o of world.state.objects) if (o.kind === kind) for (const p of o.positions ?? []) s.add(pKey(p));
  return s;
}
export function tactHostileAt(world: any, pos: any, includeOwnCore: any) {
  for (const o of world.state.objects) {
    if (o.kind !== "UNIT" && o.kind !== "CORE") continue;
    const p = o.position; if (!p || p[0] !== pos[0] || p[1] !== pos[1]) continue;
    if (o.controlled === false) return true;
    if (includeOwnCore && o.kind === "CORE") return true;
  }
  return false;
}
export function tactMoveTargets(world: any, obj: any) {
  if (!obj || obj.controlled !== true || !obj.position) return [];
  if (obj.kind !== "UNIT" && obj.kind !== "CORE") return [];
  const obstacles = tactTerrain(world, "OBSTACLE"), resources = tactTerrain(world, "RESOURCE");
  const out = [];
  for (const { dx, dy } of TACT_STEPS) {
    const t = [obj.position[0] + dx, obj.position[1] + dy] as [number, number], k = pKey(t);
    if (obstacles.has(k)) continue;
    if (obj.kind === "CORE") {
      if (resources.has(k)) continue;
      if (tactHostileAt(world, t, true)) continue;
    } else if (tactHostileAt(world, t, false)) continue;
    out.push(t);
  }
  return out;
}

export function tactRangerRange(world: any, obj: any) {
  const obstacles = tactTerrain(world, "OBSTACLE");
  const out = [];
  for (const [dx, dy] of TACT_RANGER_RAYS) {
    for (let d = 1; d <= 3; d++) {
      const p = [obj.position[0] + dx * d, obj.position[1] + dy * d] as [number, number];
      if (obstacles.has(pKey(p))) break;
      out.push(p);
    }
  }
  return out;
}
export function tactRangerTargets(world: any, obj: any) {
  const out = [];
  for (const o of world.state.objects) {
    if (!o.id || o.controlled !== false || !o.position) continue;
    const dx = o.position[0] - obj.position[0], dy = o.position[1] - obj.position[1];
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    if (dist < 1 || dist > 3) continue;
    if (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy)) continue;
    out.push(o);
  }
  return out;
}
export function tactVisibility(world: any) {
  const radiusFor = (o: any) => o.kind === "CORE" ? 5 : o.unit_type === "WORKER" ? 3 : o.unit_type === "VANGUARD" ? 4 : 5;
  const out = [];
  for (const o of world.state.objects) {
    if (o.controlled !== true || !o.position) continue;
    if (o.kind !== "CORE" && o.kind !== "UNIT") continue;
    out.push({ x: o.position[0], y: o.position[1], r: radiusFor(o) });
  }
  return out;
}
export function tactAvailability(world: any, obj: any) {
  const actions: Record<string, boolean> = { SELF_DESTRUCT: true, WAIT: true }, spawns: Record<string, any> = {}, reasons: Record<string, any> = {};
  if (!obj || obj.controlled !== true || !obj.position) return { actions, spawns, reasons };
  const beacon = world.state.champion_beacon ?? {};
  const carries = beacon.status === "CARRIED" && beacon.carrier_id === obj.id;
  const atGround = beacon.status === "GROUND" && samePos(beacon.position, obj.position);
  if (obj.kind === "CORE") {
    const normal = obj.state !== "MOVING";
    actions.HEAL = normal; actions.REPAIR_SHIELD = normal;
    actions.START_MOVE = normal && tactMoveTargets(world, obj).length > 0;
    actions.CANCEL_MOVE = !normal;
    actions.PICKUP_BEACON = normal && atGround;
    actions.DROP_BEACON = normal && carries;
    if (!normal) { reasons.HEAL = "核心移动中，无法维修"; reasons.REPAIR_SHIELD = "核心移动中，无法修盾"; }
    if (!actions.START_MOVE) reasons.START_MOVE = "核心移动不可用（无可行路径）";
    if (!actions.PICKUP_BEACON) reasons.PICKUP_BEACON = "信标不在核心所在格";
    if (!actions.DROP_BEACON) reasons.DROP_BEACON = "核心未携带信标";
    spawns.WORKER = normal; spawns.VANGUARD = normal; spawns.RANGER = normal;
    return { actions, spawns, reasons };
  }
  const canMove = tactMoveTargets(world, obj).length > 0;
  const atOwnCore = world.state.objects.some((o: any) => o.kind === "CORE" && o.controlled === true && o.position && samePos(o.position, obj.position));
  const atResource = world.state.objects.some((o: any) => o.kind === "RESOURCE" && (o.positions ?? []).some((p: any) => samePos(p, obj.position)));
  actions.MOVE = canMove;
  if (!canMove) reasons.MOVE = "无可达移动目标（周围被障碍堵死）";
  if (obj.unit_type === "WORKER") {
    actions.HARVEST = (obj.cargo ?? 0) === 0 && atResource;
    actions.DEPOSIT = (obj.cargo ?? 0) > 0 && atOwnCore;
    actions.HEAL = atOwnCore;
    if ((obj.cargo ?? 0) > 0) reasons.HARVEST = "载货已满，先回仓交付";
    else if (!atResource) reasons.HARVEST = "需站在资源格上才能采集";
    if ((obj.cargo ?? 0) === 0) reasons.DEPOSIT = "无载货可交付";
    else if (!atOwnCore) reasons.DEPOSIT = "需回到己方核心旁";
  } else if (obj.unit_type === "VANGUARD") {
    actions.SWEEP = true; actions.HEAL = atOwnCore;
  } else if (obj.unit_type === "RANGER") {
    actions.SHOOT = true; actions.HEAL = atOwnCore;
  }
  if (!atOwnCore) reasons.HEAL = "需在己方核心旁才能维修";
  actions.PICKUP_BEACON = atGround;
  actions.DROP_BEACON = carries;
  if (!atGround) reasons.PICKUP_BEACON = "信标不在脚下（当前格）";
  if (!carries) reasons.DROP_BEACON = "未携带信标";
  return { actions, spawns, reasons };
}
