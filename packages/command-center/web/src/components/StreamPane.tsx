import { useEffect, useRef, useState } from "react";
import { useEngine, getEngine } from "../lib/bridge";

const TENANTS = ["t1", "t2", "t3", "t4"];
const TENANT_COLORS: Record<string, string> = { t1: "#69b3d8", t2: "#57bd84", t3: "#a892d6", t4: "#dd626d" };
const DECISION_KIND_CN: Record<string, string> = {
  accepted: "已接受", rejected: "已拒绝", timeout: "超时", missed: "错过", aborted: "中止",
  not_applicable: "无需决策", in_progress: "进行中", unknown: "未知",
};
const EVENT_KIND_CN: Record<string, string> = {
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
const fmt = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.abs(n) >= 1000 ? n.toLocaleString("en-US") : String(n);
};
const PREFS_KEY = "arena-cc-web.prefs";

interface StreamRow {
  tenant: string;
  tick?: number;
  deadlineOutcome?: string;
  submitResult?: string;
  agentLatencyMs?: number;
  selectionLatencyMs?: number;
  abortRequested?: boolean;
  rotationGeneration?: number;
}
interface EventRow {
  tenant: string;
  tick?: number;
  kind: string;
  actor?: string;
  target?: string;
  amount?: number | null;
}
interface StreamsPayload {
  tab: string;
  streams: Record<string, StreamRow[]>;
  events: Record<string, EventRow[]>;
}

interface Prefs { collapsed: boolean; height: number; quiet: boolean; tab: string }
function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return {
      collapsed: !!p.collapsed,
      height: typeof p.height === "number" ? Math.max(140, Math.min(460, p.height)) : 244,
      quiet: !!p.quiet,
      tab: ["all", "t1", "t2", "t3", "t4", "events"].includes(p.tab) ? p.tab : "all",
    };
  } catch {
    return { collapsed: false, height: 244, quiet: false, tab: "all" };
  }
}
function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* 忽略 */ }
}

const shortId = (id: string | null | undefined): string => (id ? String(id).slice(0, 8) : "");

export function StreamPane() {
  const engine = useEngine();
  const [payload, setPayload] = useState<StreamsPayload | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [newDot, setNewDot] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!engine) return;
    const off = engine.subscribe((topic, data) => {
      if (topic === "streams") setPayload(data as StreamsPayload);
    });
    return off;
  }, [engine]);

  // 折叠/只看决策/标签页变化 → 通知引擎（引擎持有 tab 状态并决定拉哪个租户）
  useEffect(() => { savePrefs(prefs); }, [prefs]);
  useEffect(() => {
    if (engine && payload && payload.tab !== prefs.tab) getEngine()?.setTab(prefs.tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.tab, engine]);

  const rows: StreamRow[] = [];
  const tab = prefs.tab;
  for (const t of (tab === "all" ? TENANTS : tab === "events" ? [] : [tab])) {
    for (const r of payload?.streams[t] ?? []) rows.push({ ...r, tenant: t });
  }
  rows.sort((a, b) => (b.tick ?? 0) - (a.tick ?? 0));

  const quietRow = (r: StreamRow) => String(r.deadlineOutcome ?? "") === "not_applicable";
  const kept = prefs.quiet ? rows.filter((r) => !quietRow(r)) : rows;
  const shown = kept.slice(0, 120);
  const quietCount = prefs.quiet ? 0 : rows.filter(quietRow).length;
  const liveRow = shown.length > 0 ? shown[0] : null;
  const eventRows = tab === "events"
    ? TENANTS.flatMap((t) => (payload?.events[t] ?? []).map((e) => ({ ...e, tenant: t }))).sort((a, b) => (b.tick ?? 0) - (a.tick ?? 0)).slice(0, 120)
    : [];

  const setPrefs = (patch: Partial<Prefs>) => setPrefsState((p) => ({ ...p, ...patch }));
  const toggle = () => { const next = !prefs.collapsed; setPrefs({ collapsed: next }); setNewDot(false); requestAnimationFrame(() => getEngine()?.resize()); };
  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const nearTop = el.scrollTop < 28;
    const jump = document.getElementById("streamJump");
    if (jump) jump.hidden = nearTop;
  };
  const jumpTop = () => { const el = bodyRef.current; if (el) el.scrollTop = 0; };

  return (
    <section id="streamPane" style={{ height: prefs.collapsed ? "38px" : `${prefs.height}px` }}>
      <div id="streamGrip" className="stream-grip" title="拖拽调整决策流高度"
        onPointerDown={(ev) => {
          ev.preventDefault();
          const startY = ev.clientY;
          const startH = prefs.height;
          const move = (e2: PointerEvent) => {
            const h = Math.max(140, Math.min(460, startH + (startY - e2.clientY)));
            setPrefs({ height: h });
            getEngine()?.resize();
          };
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }} />
      <div className="stream-head">
        <button id="streamToggle" type="button" className="stream-toggle" aria-expanded={!prefs.collapsed} onClick={toggle}>
          <span className={`st-dot${newDot ? " has-new" : ""}`} />
          <span className="st-title">决策流 · LIVE{prefs.quiet ? " · 只看决策" : ""}</span>
          <span id="streamCount" className="mono st-count">{prefs.quiet ? `${shown.length} 条实际决策` : `${rows.length} 条 · ${rows.length - quietCount} 实际决策`}</span>
          <span className="st-chev">{prefs.collapsed ? "▸" : "▾"}</span>
        </button>
        {!prefs.collapsed && (
          <button id="streamFilter" className={`stream-filter${prefs.quiet ? " on" : ""}`} type="button"
            title={prefs.quiet ? "显示全部（含无需决策）" : "只显示实际决策（隐藏无需决策行）"}
            onClick={() => { setPrefs({ quiet: !prefs.quiet }); }}>
            只看决策
          </button>
        )}
        {prefs.collapsed && liveRow && (
          <span id="streamLive" className="st-live">
            <span className="sl-t" style={{ color: TENANT_COLORS[liveRow.tenant] ?? "#999" }}>{liveRow.tenant.toUpperCase()}</span>
            <span className="sl-tick">#{fmt(liveRow.tick)}</span>
            <span className="sl-text">{DECISION_KIND_CN[String(liveRow.deadlineOutcome ?? "")] ?? "决策"}</span>
          </span>
        )}
      </div>
      <div id="streamTabs" className="tabs" role="tablist">
        {[{ id: "all", label: "统一决策" }, ...TENANTS.map((t) => ({ id: t, label: t.toUpperCase() })), { id: "events", label: "事件" }].map((tb) => {
          const n = tb.id === "events"
            ? TENANTS.reduce((a, t) => a + (payload?.events[t]?.length ?? 0), 0)
            : (prefs.quiet ? kept : rows).filter((r) => tb.id === "all" || r.tenant === tb.id).length;
          return (
            <button key={tb.id} data-tab={tb.id} className={tab === tb.id ? "active" : ""} role="tab" onClick={() => setPrefs({ tab: tb.id })}>
              {tb.label}{n > 0 ? <span className="tab-badge">{Math.min(n, 999)}</span> : null}
            </button>
          );
        })}
      </div>
      <div id="streamBody" ref={bodyRef} onScroll={onScroll}>
        {tab === "events" ? (
          eventRows.length === 0 ? (
            <div className="stream-empty">暂无事件数据</div>
          ) : (
            eventRows.map((e) => {
              const color = TENANT_COLORS[e.tenant] ?? "#999";
              const evColor = e.kind.startsWith("SHOT") || e.kind.includes("DESTROYED") || e.kind.includes("FAILED") ? "#dd626d"
                : e.kind.includes("SUCCEEDED") || e.kind === "SPAWN" || e.kind === "PICKUP_BEACON" || e.kind === "HEAL" ? "#57bd84" : "#d3ad55";
              const detail = [e.actor ? `actor ${shortId(e.actor)}` : "", e.target ? `target ${shortId(e.target)}` : "", e.amount != null ? `×${e.amount}` : ""].filter(Boolean).join(" ");
              return (
                <div key={`${e.tenant}:${e.tick}:${e.kind}:${e.actor ?? ""}:${e.target ?? ""}`} className="stream-line" style={{ ["--tc" as string]: color }}>
                  <span className="st-tenant">{e.tenant.toUpperCase()}</span>
                  <span className="st-tick">{fmt(e.tick)}</span>
                  <span className="st-kind" style={{ color: evColor }}>{EVENT_KIND_CN[e.kind] ?? e.kind}</span>
                  <span className="st-detail">{detail}</span>
                </div>
              );
            })
          )
        ) : shown.length === 0 ? (
          <div className="stream-empty">{prefs.quiet ? "暂无实际决策（可关闭「只看决策」查看全部行）" : "暂无决策数据"}</div>
        ) : (
          shown.map((r) => {
            const color = TENANT_COLORS[r.tenant] ?? "#999";
            const outcome = String(r.deadlineOutcome ?? "");
            const submit = String(r.submitResult ?? "");
            const quiet = quietRow(r);
            const outCls = submit === "accepted" ? "accepted" : submit === "rejected" ? "rejected" : (outcome.includes("timeout") || outcome.includes("missed")) ? "timeout" : "";
            const kindCn = DECISION_KIND_CN[outcome] ?? "决策";
            const badge = submit !== "" ? (DECISION_KIND_CN[submit] ?? submit) : outcome !== "" ? (DECISION_KIND_CN[outcome] ?? outcome) : "—";
            const lat = [];
            if (r.agentLatencyMs != null) lat.push(`agent ${fmt(r.agentLatencyMs)}ms`);
            if (r.selectionLatencyMs != null) lat.push(`select ${fmt(r.selectionLatencyMs)}ms`);
            const extra = [];
            if (r.abortRequested) extra.push("中止请求");
            if (r.rotationGeneration != null) extra.push(`rot ${r.rotationGeneration}`);
            const detail = [lat.join(" · "), extra.join(" · ")].filter(Boolean).join(" · ");
            return (
              <div key={`${r.tenant}:${r.tick}:${outcome}:${submit}`} className={`stream-line${quiet ? " st-quiet" : ""}`} style={{ ["--tc" as string]: color }}>
                <span className="st-tenant">{r.tenant.toUpperCase()}</span>
                <span className="st-tick">{fmt(r.tick)}</span>
                <span className="st-kind" style={{ color }}>{kindCn}</span>
                <span className="st-detail">{detail}</span>
                <span className={`st-badge ${outCls}`}>{badge}</span>
              </div>
            );
          })
        )}
      </div>
      <button id="streamJump" className="stream-jump" type="button" hidden onClick={jumpTop}>↑ 最新</button>
    </section>
  );
}
