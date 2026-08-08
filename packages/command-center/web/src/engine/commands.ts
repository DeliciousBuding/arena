import { escapeHtml, shortId } from './utils.ts';
import { TACT_ACTION_CN } from './tactical.ts';

/* Arena 指挥面板前端 — 人类指令选择器/遥测差分层（纯函数，无 DOM/state 依赖，可单测）。
 * 读取战术状态中的 commands/commandsByTenant，派生 UI 需要的状态与差分；
 * 实际提交（ccPost/submitGoal 等 I/O）仍在 mapEngine，调用方注入 tac 与回调。 */

/** 人类指令遥测差分：相比上一快照，新增被拒/已完成/已生效单位。 */
export function commandTelemetryDeltas(prevTele: any, tele: any) {
  if (!tele) return { rejected: [], satisfied: [], applied: [] };
  const rejected = (tele.rejected ?? []).filter((rj: any) => !(prevTele?.rejected ?? []).some((p: any) => p.unitId === rj.unitId));
  const satisfied = (tele.satisfied ?? []).filter((u: any) => !(prevTele?.satisfied ?? []).includes(u));
  const applied = (tele.applied ?? []).filter((u: any) => !(prevTele?.applied ?? []).includes(u));
  return { rejected, satisfied, applied };
}

/** 单位目标指令（goal）。 */
export function commandGoalOf(tac: any, tenant: string, unitId: any) {
  const c = tac?.commands;
  if (!c) return null;
  return (c.goals ?? []).find((g: any) => g.unitId === unitId) ?? null;
}

/** 单位一键动作指令（action）。 */
export function commandActionOf(tac: any, tenant: string, unitId: any) {
  const c = tac?.commands;
  if (!c) return null;
  return (c.actions ?? []).find((a: any) => a.unitId === unitId) ?? null;
}

/** 单位是否有活跃人类指令（goal 或一键 action）——舰队索引/地图「指挥中」标记。 */
export function unitHumanCommandOf(tac: any, tenant: string, unitId: any): 'goal' | 'cmd' | null {
  const byT = tac?.commandsByTenant ? tac.commandsByTenant[tenant] : null;
  if (byT) {
    if ((byT.goals ?? []).some((g: any) => g.unitId === unitId)) return 'goal';
    if ((byT.actions ?? []).some((a: any) => a.unitId === unitId)) return 'cmd';
  }
  const c = tac?.commands;
  if (c && c.tenant === tenant && c.mode === 'override') {
    if ((c.goals ?? []).some((g: any) => g.unitId === unitId)) return 'goal';
    if ((c.actions ?? []).some((a: any) => a.unitId === unitId)) return 'cmd';
  }
  return null;
}

/** 人类指令状态摘要：{ mode, actions:[], goals:[], updatedAt, telemetry } → 一行中文。 */
export function commandStatusText(tac: any, tenant: string) {
  const c = tac?.commands;
  if (!c || c.mode !== 'override') return null;
  const n = (c.actions?.length ?? 0) + (c.goals?.length ?? 0);
  const tele = c.telemetry;
  const parts: string[] = [];
  if (n > 0) parts.push(`${n} 条指令`);
  if (tele) {
    if ((tele.applied ?? []).length) parts.push(`${tele.applied.length} 已生效`);
    if ((tele.rejected ?? []).length) parts.push(`${tele.rejected.length} 被拒`);
    if ((tele.satisfied ?? []).length) parts.push(`${tele.satisfied.length} 已完成`);
  }
  if (!parts.length) return null;
  return `人类指挥 · ${parts.join(' · ')}`;
}

/** 单位级人类指令遥测状态行（HTML）：已生效 / 已完成 / 被拒+原因。 */
export function unitTelemetryOf(tac: any, unitId: any) {
  const c = tac?.commands;
  if (!c || !c.telemetry) return null;
  const t = c.telemetry;
  const parts: string[] = [];
  if ((t.applied ?? []).includes(unitId)) parts.push('<b class="ok">已生效</b>');
  if ((t.satisfied ?? []).includes(unitId)) parts.push('<b class="done">已完成</b>');
  const rej = (t.rejected ?? []).find((rj: any) => rj.unitId === unitId);
  if (rej) parts.push(`<b class="no">被拒</b><span class="dim">${escapeHtml(rej.reason)}</span>`);
  if (!parts.length) return null;
  return `人类指挥 · ${parts.join(' ')}`;
}

/** 单位当前指令标签（hover/信息卡用）：人类 goal 优先（指挥·采矿/移动 → 目标），
 *  否则算法决策 action 兜底（决策·移动/采集/... 方向或目标）。纯派生：
 *  从战术状态读取，返回一行中文或 null；可单测。 */
export function unitCommandLabel(tac: any, tenant: string, unitId: any, plan: any): string | null {
  // 1) 人类指令优先：commandsByTenant（全局）或 commands（单租户）
  const byT = tac?.commandsByTenant ? tac.commandsByTenant[tenant] : null;
  const goals = (byT?.goals ?? tac?.commands?.goals ?? []) as any[];
  const g = goals.find((x: any) => x.unitId === unitId && Array.isArray(x.target) && x.target.length >= 2);
  if (g) return `${g.kind === 'mine' ? '指挥 · 采矿' : '指挥 · 移动'} → [${g.target[0]}, ${g.target[1]}]`;
  // 2) 算法决策：plan.unitActions / unit_actions
  const actions = plan ? (plan.unitActions ?? plan.unit_actions ?? {}) : {};
  const act = actions[unitId];
  if (act) {
    const cn = TACT_ACTION_CN[act.type] ?? act.type;
    if (act.direction) return `决策 · ${cn} ${act.direction}`;
    if (act.targetId) return `决策 · ${cn} → ${shortId(act.targetId)}`;
    return `决策 · ${cn}`;
  }
  return null;
}

/** 编队多选摘要（Shift 框选/加选 HUD）：受控 UNIT ≥2 时返回
 *  { count, parts(工/锋/射 构成), hpAvg, hpMin }；否则 null。纯派生可单测。 */
export function squadSummary(tac: any, world: any): { count: number; parts: string; hpAvg: number; hpMin: number } | null {
  if (!tac || !world?.state?.objects) return null;
  const members = world.state.objects.filter((o: any) => tac.multi?.has?.(o.id) && o.kind === "UNIT");
  if (members.length < 2) return null;
  const cnt: Record<string, number> = {};
  let hpSum = 0, hpMin = Infinity;
  for (const o of members) {
    const t = o.unit_type ?? "?";
    cnt[t] = (cnt[t] ?? 0) + 1;
    const hp = Number(o.hp ?? o.health ?? 0);
    hpSum += hp;
    if (hp < hpMin) hpMin = hp;
  }
  const parts = ["WORKER", "VANGUARD", "RANGER"]
    .map((t) => cnt[t] ? cnt[t] + (t === "WORKER" ? "工" : t === "VANGUARD" ? "锋" : "射") : "")
    .filter(Boolean).join("/");
  return { count: members.length, parts: parts || "—", hpAvg: Math.round(hpSum / members.length), hpMin: hpMin === Infinity ? 0 : hpMin };
}

