/**
 * 参谋建议面板（2026-08-08，右栏 tab）：联盟态势快照 + 共享测绘 + 排行榜综合出的
 * 具体可执行运维建议（经济濒危/零战斗单位敌核邻近/热区逼近核心/抢矿冲突/高威胁玩家）。
 * 给手操指挥一个一眼可读的「该做什么」清单。纯只读，数据源 /api/alliance/advice（30s 缓存）。
 */
import { useEffect, useState } from "react";
import { TENANT_COLORS } from "@/engine/tactical";

interface Advice {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
  category: "ECONOMY" | "MILITARY" | "THREAT" | "CONFLICT" | "INTEL";
  tenant: string | null;
  title: string;
  detail: string;
  action: string;
  weight: number;
  confidence?: number;
  evidence?: { type?: string; tenant?: string; ref?: string } | string;
  at: string;
}
interface AdvicePayload { generatedAt?: string; advice?: Advice[]; summary?: { critical: number; high: number; medium: number; info: number } }
interface DirectorPayload {
  available?: boolean; enabled?: boolean; mode?: string; actionOwnership?: string; revision?: number; tick?: number | null;
  frameTenants?: string[];
  runtime?: { directiveSentCount?: number; ackCount?: number; directorErrorCount?: number; invalidOutputCount?: number; sendErrorCount?: number };
  policy?: { treasuryTenant?: string; missions?: Array<{ id?: string; kind?: string; defendTenant?: string; scope?: string }>; taskForces?: Array<{ id?: string; missionId?: string; commanderTenant?: string; fleetRefs?: Array<{ tenantId?: string; fleetId?: string }> }> } | null;
}

const SEV_CN: Record<string, string> = { CRITICAL: "危急", HIGH: "高", MEDIUM: "中", INFO: "提示" };
const CAT_CN: Record<string, string> = { ECONOMY: "经济", MILITARY: "军事", THREAT: "威胁", CONFLICT: "冲突", INTEL: "情报" };

/** 证据链摘要：后端 /api/alliance/advice 的 evidence 对象 → 一行人类可读来源。 */
const EVIDENCE_TYPE_CN: Record<string, string> = { world: "世界态", heat: "敌情热区", intel: "情报", economy: "经济", survey: "测绘" };
const fmtEvidence = (ev: Advice["evidence"]): string => {
  if (!ev) return "";
  if (typeof ev === "string") return ev;
  const parts: string[] = [];
  if (ev.type) parts.push(EVIDENCE_TYPE_CN[ev.type] ?? ev.type);
  if (ev.tenant) parts.push(ev.tenant.toUpperCase());
  if (ev.ref) parts.push(ev.ref);
  return parts.join(" · ");
};

export function AdvicePanel() {
  const [data, setData] = useState<AdvicePayload | null>(null);
  const [err, setErr] = useState("");
  const [at, setAt] = useState("");
  const [director, setDirector] = useState<DirectorPayload | null>(null);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const [r, dr] = await Promise.all([
          fetch("/api/alliance/advice", { cache: "no-store" }),
          fetch("/api/alliance/director", { cache: "no-store" }),
        ]);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = (await r.json()) as AdvicePayload;
        const dd = dr.ok ? (await dr.json()) as DirectorPayload : { available: false, enabled: false, mode: "ASSIST_ONLY", actionOwnership: "none" };
        if (!stop) { setData(d); setDirector(dd); setAt(d.generatedAt ?? ""); setErr(""); }
      } catch (e) { if (!stop) setErr(String((e as Error).message ?? e)); }
    };
    load();
    const timer = setInterval(load, 30000);
    return () => { stop = true; clearInterval(timer); };
  }, []);
  const advices = data?.advice ?? [];
  const summary = data?.summary;
  return (
    <div className="rp-pane">
      <div className="rp-head">
        <span className="eyebrow">STAFF ADVICE · 参谋建议</span>
        <h3>该做什么清单</h3>
        <span className="rp-sub mono dim">{at ? "更新 " + at.slice(5, 16).replace("T", " ") + " UTC" : ""}</span>
      </div>
      {director ? (
        <>
          <div className="sv-summary">
            <span className={`adv-sum ${director.available && director.enabled ? "adv-info" : "adv-medium"}`}>
              Director {director.available && director.enabled ? "SHADOW" : "OFFLINE"}
            </span>
            <span className="adv-sum">rev {director.revision ?? "—"} · tick {director.tick ?? "—"}</span>
            <span className="adv-sum">任务 {director.policy?.missions?.length ?? 0}</span>
            <span className="adv-sum">联合队 {director.policy?.taskForces?.length ?? 0}</span>
            <span className="adv-sum">ACK {director.runtime?.ackCount ?? 0}/{director.runtime?.directiveSentCount ?? 0}</span>
          </div>
          <div className="rp-sub mono dim">
            {director.mode ?? "ASSIST_ONLY"} · actionOwnership={director.actionOwnership ?? "none"}
            {director.frameTenants?.length ? ` · frames ${director.frameTenants.join("/")}` : ""}
            {director.policy?.treasuryTenant ? ` · treasury ${director.policy.treasuryTenant.toUpperCase()}` : ""}
          </div>
          {director.policy?.missions?.length ? (
            <div className="rp-sub mono dim">中央任务：{director.policy.missions.slice(0, 6).map((m) => `${m.defendTenant ?? m.scope ?? "ALL"}:${m.kind ?? "?"}`).join(" · ")}</div>
          ) : null}
        </>
      ) : null}
      {summary ? (
        <div className="sv-summary">
          {(["CRITICAL", "HIGH", "MEDIUM", "INFO"] as const).map((k) => (
            <span key={k} className={`adv-sum adv-${k.toLowerCase()}`}>{SEV_CN[k]} {summary[k.toLowerCase() as keyof typeof summary] ?? 0}</span>
          ))}
        </div>
      ) : null}
      {err ? <div className="sv-empty">建议加载失败：{err}</div>
        : advices.length === 0 ? <div className="sv-empty">暂无待办建议——联盟运行平稳 🎉（30s 刷新）</div>
        : (
          <ul className="adv-list">
            {advices.map((a, i) => (
              <li key={i} className={`adv-item adv-${a.severity.toLowerCase()}`}>
                <div className="adv-top">
                  <span className="adv-sev">{SEV_CN[a.severity] ?? a.severity}</span>
                  {a.confidence != null ? (
                    <span className="adv-conf mono" title={"置信度 " + Math.round(a.confidence * 100) + "%"} style={{ color: a.confidence >= 0.8 ? "var(--success)" : "var(--text-dim)" }}>{Math.round(a.confidence * 100)}%</span>
                  ) : null}
                  {a.tenant ? <span className="adv-tenant" style={{ color: TENANT_COLORS[a.tenant] ?? "var(--text-dim)" }}>{a.tenant.toUpperCase()}</span> : null}
                  <span className="adv-cat mono dim">{CAT_CN[a.category] ?? a.category}</span>
                </div>
                <b className="adv-title">{a.title}</b>
                <p className="adv-detail dim">{a.detail}</p>
                {a.action ? <p className="adv-action"><span className="adv-action-label">建议</span>{a.action}</p> : null}
                {a.evidence ? <p className="adv-evidence dim" title="决策证据来源（后端证据链）">证据 · {fmtEvidence(a.evidence)}</p> : null}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
