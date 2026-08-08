import { escapeHtml } from './utils.ts';

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
