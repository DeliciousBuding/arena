/**
 * 测绘面板（2026-08-08，右栏 tab）：每租户矿/障碍/敌核/探索分区 + 生命周期
 * 摘要（单位构成/采集/消费）+ 消费趋势占比。纯只读，数据源 /api/survey?tenant=all。
 */
import { useEffect, useState } from "react";

const TENANT_COLORS: Record<string, string> = { t1: "#69b3d8", t2: "#57bd84", t3: "#a892d6", t4: "#dd626d" };
const KIND_CN: Record<string, string> = { spawn: "产兵", core_heal: "核心治疗", repair: "修复", unit_heal: "单位治疗" };

interface SpendRow { kind?: string; count?: number; total?: number }
interface Lifecycle { units?: Array<{ state?: string; type?: string; count?: number }>; spends?: SpendRow[]; harvestCount?: number; harvestFailCount?: number }
interface SurveyData {
  resources?: Array<Record<string, unknown>>;
  obstacles?: Array<Record<string, unknown>>;
  coreHunts?: Array<Record<string, unknown>>;
  chunks?: Array<Record<string, unknown>>;
  lifecycle?: Lifecycle | null;
  spendsTrend?: SpendRow[];
  unitsDetail?: Array<Record<string, unknown>>;
}
interface SurveyResp { tenants?: Record<string, SurveyData>; generatedAt?: string }

const fmt = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : String(n);

const TYPE_CN: Record<string, string> = { WORKER: "工", VANGUARD: "锋", RANGER: "射" };

function TenantCard({ t, d }: { t: string; d: SurveyData }) {
  const lc = d.lifecycle;
  const alive = (lc?.units ?? []).filter((u) => u.state === "alive").reduce((s, u) => s + (u.count ?? 0), 0);
  const unitLabel = ["WORKER", "VANGUARD", "RANGER"].map((ty) => {
    const c = (lc?.units ?? []).find((u) => u.state === "alive" && u.type === ty)?.count ?? 0;
    return c ? `${c}${TYPE_CN[ty] ?? ty}` : "";
  }).filter(Boolean).join("/");
  const spendTotal = (lc?.spends ?? []).reduce((s, x) => s + (x.total ?? 0), 0);
  const spendBar = (lc?.spends ?? []).map((x) => ({
    kind: x.kind ?? "?",
    pct: spendTotal > 0 ? Math.round(((x.total ?? 0) / spendTotal) * 100) : 0,
    total: x.total ?? 0,
  })).sort((a, b) => b.total - a.total);
  const trend = (d.spendsTrend ?? []).reduce<Record<string, number>>((m, x) => {
    const k = x.kind ?? "?";
    m[k] = (m[k] ?? 0) + (x.total ?? 0);
    return m;
  }, {});
  return (
    <div className="sv-card">
      <div className="sv-head">
        <span className="sv-chip" style={{ background: TENANT_COLORS[t] ?? "#888" }} />
        <b>{t.toUpperCase()}</b>
        <span className="sv-sub">矿 {fmt(d.resources?.length)} · 障碍 {fmt(d.obstacles?.length)} · 敌核 {fmt(d.coreHunts?.length)} · 探索分区 {fmt(d.chunks?.length)}</span>
      </div>
      {lc ? (
        <div className="sv-body">
          <div className="sv-row"><span>单位</span><b>{fmt(alive)}{unitLabel ? ` · ${unitLabel}` : ""}</b></div>
          <div className="sv-row"><span>采集</span><b>{fmt(lc.harvestCount)}{lc.harvestFailCount ? ` · 失败 ${lc.harvestFailCount}` : ""}</b></div>
          <div className="sv-row"><span>消费</span><b>{fmt(spendTotal)}</b></div>
          {spendBar.length ? (
            <div className="sv-bar">
              {spendBar.map((x) => (
                <span key={x.kind} className="sv-bar-seg" style={{ width: `${x.pct}%`, background: x.kind === "spawn" ? "#7ee0a0" : x.kind === "repair" ? "#5fd4e8" : "#e0b94f" }} title={`${KIND_CN[x.kind] ?? x.kind} ${x.total}`} />
              ))}
            </div>
          ) : null}
          <div className="sv-row dim">{Object.entries(trend).map(([k, v]) => `${KIND_CN[k] ?? k} ${fmt(v)}`).join(" · ") || "无消费"}</div>
        </div>
      ) : (<div className="sv-empty">无生命周期数据</div>)}
    </div>
  );
}

export function SurveyPanel() {
  const [data, setData] = useState<SurveyResp | null>(null);
  const [err, setErr] = useState("");
  const [at, setAt] = useState("");
  useEffect(() => {
    fetch("/api/survey?tenant=all")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: SurveyResp) => { setData(d); setAt(d.generatedAt ?? ""); })
      .catch((e) => setErr(String((e as Error).message ?? e)));
  }, []);
  const tenants = data?.tenants ?? {};
  return (
    <div className="sv">
      <div className="sv-toolbar">{at ? <span className="sv-gen">更新 {at.replace("T", " ").slice(5, 16)} UTC</span> : null}</div>
      {err ? <div className="sv-empty">加载失败：{err}</div> : null}
      {!err && !data ? <div className="sv-empty">加载测绘数据…</div> : null}
      {["t1", "t2", "t3", "t4"].map((t) => tenants[t] ? <TenantCard key={t} t={t} d={tenants[t]} /> : null)}
    </div>
  );
}
