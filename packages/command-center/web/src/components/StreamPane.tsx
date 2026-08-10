import { memo, useEffect, useRef, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useEngine, getEngine } from "../lib/bridge";

const TENANTS = ["t1", "t2", "t3", "t4"];
// 常量单一事实源：租户色/决策中文/事件中文/事件与事迹图标统一走 tactical.ts（防漂移）
import { TENANT_COLORS, DECISION_KIND_CN, EVENT_KIND_CN, EVENT_ICON, DEED_ICON } from "../engine/tactical.ts";
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

interface JournalDeed {
  id?: string;
  tick?: number;
  tenant?: string;
  star?: number;
  kind?: string;
  title?: string;
  detail?: string;
  position?: number[] | null;
}
interface JournalPayload {
  deeds?: JournalDeed[];
  narrative?: string;
  generatedAt?: string;
  counts?: Record<string, number>;
  filters?: { categories?: string[]; minStar?: number };
}

interface Prefs { collapsed: boolean; height: number; quiet: boolean; tab: string }
function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return {
      collapsed: !!p.collapsed,
      height: typeof p.height === "number" ? Math.max(140, Math.min(460, p.height)) : 244,
      quiet: !!p.quiet,
      tab: ["all", "t1", "t2", "t3", "t4", "events", "deeds"].includes(p.tab) ? p.tab : "all",
    };
  } catch {
    return { collapsed: false, height: 244, quiet: false, tab: "all" };
  }
}
function savePrefs(p: Prefs) {
  try {
    // 合并写入：arena-cc-web.prefs 与 AppShell（左右栏折叠/tab）和 Sidebar（分区开关）共用，
    // 整体覆盖会把它们的偏好一起冲掉（折叠流/切 tab 后刷新即丢）。
    const all = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...all, collapsed: p.collapsed, height: p.height, quiet: p.quiet, tab: p.tab }));
  } catch { /* 忽略 */ }
}

const shortId = (id: string | null | undefined): string => (id ? String(id).slice(0, 8) : "");

/** 决策行（memo）：引用稳定（引擎每轮复用行对象），tick 间只有变化行重渲。
 *  2026-08-10 性能优化：此前 120 行内联 JSX 每 3s 全量重渲（主线程 93% busy 主因）。 */
const StreamRowItem = memo(function StreamRowItem({ r, tenant }: { r: StreamRow; tenant: string }) {
  const color = TENANT_COLORS[tenant] ?? "var(--text-dim)";
  const outcome = String(r.deadlineOutcome ?? "");
  const submit = String(r.submitResult ?? "");
  const quiet = String(outcome) === "not_applicable";
  const outCls = submit === "accepted" ? "accepted" : submit === "rejected" ? "rejected" : (outcome.includes("timeout") || outcome.includes("missed")) ? "timeout" : "";
  const kindCn = DECISION_KIND_CN[outcome] ?? "决策";
  const badge = submit !== "" ? (DECISION_KIND_CN[submit] ?? submit) : outcome !== "" ? (DECISION_KIND_CN[outcome] ?? outcome) : "—";
  const lat = [];
  if (r.agentLatencyMs != null) lat.push(`决策 ${fmt(r.agentLatencyMs)}ms`);
  if (r.selectionLatencyMs != null) lat.push(`选择 ${fmt(r.selectionLatencyMs)}ms`);
  const extra = [];
  if (r.abortRequested) extra.push("中止请求");
  if (r.rotationGeneration != null) extra.push(`轮次 ${r.rotationGeneration}`);
  const detail = [lat.join(" · "), extra.join(" · ")].filter(Boolean).join(" · ");
  return (
    <div key={`${tenant}:${r.tick}:${outcome}:${submit}`} className={`stream-line${quiet ? " st-quiet" : ""} clickable`} style={{ ["--tc" as string]: color }}
      title={`${tenant.toUpperCase()} · 回合 ${fmt(r.tick)}\n决策 ${kindCn}${submit ? ` · 提交 ${DECISION_KIND_CN[submit] ?? submit}` : ""}${lat.length ? `\n延迟 ${lat.join(" · ")}` : ""}${extra.length ? `\n${extra.join(" · ")}` : ""}\n点击聚焦该租户决策动线`}
      onClick={() => { const e = getEngine(); if (e) e.focusTenant(tenant); }}>
      <span className="st-tenant">{tenant.toUpperCase()}</span>
      <span className="st-tick">{fmt(r.tick)}</span>
      <span className="st-kind" style={{ color }}>{kindCn}</span>
      <span className="st-detail">{detail}</span>
      <span className={`st-badge ${outCls}`}>{badge}</span>
    </div>
  );
});

const EventRowItem = memo(function EventRowItem({ e, tenant }: { e: EventRow; tenant: string }) {
  const color = TENANT_COLORS[tenant] ?? "var(--text-dim)";
  const evColor = e.kind.startsWith("SHOT") || e.kind.includes("DESTROYED") || e.kind.includes("FAILED") ? "var(--danger)"
    : e.kind.includes("SUCCEEDED") || e.kind === "SPAWN" || e.kind === "PICKUP_BEACON" || e.kind === "HEAL" ? "var(--green-resource)" : "var(--text-dim)";
  const detail = [e.actor ? `actor ${shortId(e.actor)}` : "", e.target ? `target ${shortId(e.target)}` : "", e.amount != null ? `×${e.amount}` : ""].filter(Boolean).join(" ");
  return (
    <div key={`${tenant}:${e.tick}:${e.kind}:${e.actor ?? ""}:${e.target ?? ""}`} className="stream-line" style={{ ["--tc" as string]: color }}>
      <span className="st-tenant">{tenant.toUpperCase()}</span>
      <span className="st-tick">{fmt(e.tick)}</span>
      <span className="st-ico" style={{ color: evColor }} title={EVENT_KIND_CN[e.kind] ?? e.kind}>{EVENT_ICON[e.kind] ?? "·"}</span>
      <span className="st-kind" style={{ color: evColor }}>{EVENT_KIND_CN[e.kind] ?? e.kind}</span>
      <span className="st-detail">{detail}</span>
    </div>
  );
});

const DeedRowItem = memo(function DeedRowItem({ d }: { d: JournalDeed }) {
  const color = TENANT_COLORS[d.tenant ?? ""] ?? "var(--text-dim)";
  const star = d.star ?? 0;
  const pos = d.position;
  return (
    <div key={d.id} className={`stream-line${pos ? " clickable" : ""}`} style={{ ["--tc" as string]: color }}
      title={pos ? `点击定位 (${pos[0]}, ${pos[1]})` : undefined}
      onClick={pos ? () => { const e = getEngine(); if (e) { e.jumpTo(pos[0], pos[1]); e.toast(`定位事迹「${d.title ?? ""}」`); } } : undefined}>
      <span className="st-tenant">{d.tenant ? d.tenant.toUpperCase() : "盟"}</span>
      <span className="st-tick">{fmt(d.tick)}</span>
      <span className="st-ico" title={d.title ?? d.kind ?? "事迹"}>{DEED_ICON[d.kind ?? ""] ?? "·"}</span>
      <span className="st-kind">{d.title ?? d.kind ?? "事迹"}</span>
      <span className="st-detail">{d.detail ?? ""}</span>
      <span className={`st-badge${star >= 3 ? " deed-hot" : " deed"}`}>★{star}</span>
    </div>
  );
});

export function StreamPane({ embedded = false }: { embedded?: boolean }) {
  const engine = useEngine();
  const [payload, setPayload] = useState<StreamsPayload | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [newDot, setNewDot] = useState(false);
  const [journal, setJournal] = useState<JournalPayload | null>(null);
  // 事迹折叠/筛选（2026-08-08）：类别 + 星级下限，服务端 /api/deeds/journal 过滤
  const [deedCat, setDeedCat] = useState<string>("all");
  const [deedStar, setDeedStar] = useState<number>(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!engine) return;
    const off = engine.subscribe((topic, data) => {
      if (topic === "streams") setPayload(data as StreamsPayload);
    });
    return off;
  }, [engine]);

  // 事迹 tab：纯前端拉取 /api/deeds/journal（不经过引擎 stream 状态机），30s 刷新
  useEffect(() => {
    if (prefs.tab !== "deeds") return;
    let stop = false;
    const q = new URLSearchParams();
    if (deedCat !== "all") q.set("category", deedCat);
    if (deedStar > 0) q.set("minStar", String(deedStar));
    const qs = q.toString();
    const load = async () => {
      try {
        const r = await fetch(`/api/deeds/journal${qs ? `?${qs}` : ""}`, { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = (await r.json()) as JournalPayload;
        if (!stop) setJournal(d);
      } catch { /* 静默：保留上次数据 */ }
    };
    load();
    const timer = setInterval(load, 30000);
    return () => { stop = true; clearInterval(timer); };
  }, [prefs.tab, deedCat, deedStar]);

  // 折叠/只看决策/标签页变化 → 通知引擎（引擎持有 tab 状态并决定拉哪个租户）
  useEffect(() => { savePrefs(prefs); }, [prefs]);
  useEffect(() => {
    if (engine && prefs.tab !== "deeds" && payload && payload.tab !== prefs.tab) getEngine()?.setTab(prefs.tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.tab, engine]);

  // pair 保留原始行对象引用（引擎每轮复用），memo 浅比较才能跳过未变化行
  const rowPairs: Array<{ r: StreamRow; t: string }> = [];
  const tab = prefs.tab;
  for (const t of (tab === "all" ? TENANTS : tab === "events" ? [] : [tab])) {
    for (const r of payload?.streams[t] ?? []) rowPairs.push({ r, t });
  }
  rowPairs.sort((a, b) => (b.r.tick ?? 0) - (a.r.tick ?? 0));

  const quietRow = (r: StreamRow) => String(r.deadlineOutcome ?? "") === "not_applicable";
  const kept = prefs.quiet ? rowPairs.filter((p) => !quietRow(p.r)) : rowPairs;
  const shown = kept.slice(0, 120);
  const quietCount = prefs.quiet ? 0 : rowPairs.filter((p) => quietRow(p.r)).length;
  const liveRow = shown.length > 0 ? shown[0].r : null;
  const eventPairs = tab === "events"
    ? TENANTS.flatMap((t) => (payload?.events[t] ?? []).map((e) => ({ e, t }))).sort((a, b) => (b.e.tick ?? 0) - (a.e.tick ?? 0)).slice(0, 120)
    : [];

  const setPrefs = (patch: Partial<Prefs>) => setPrefsState((p) => ({ ...p, ...patch }));
  const toggle = () => { const next = !prefs.collapsed; setPrefs({ collapsed: next }); setNewDot(false); requestAnimationFrame(() => getEngine()?.resize()); };
  // 嵌入右栏时恒展开（折叠行为由右栏整体折叠接管）
  const collapsed = embedded ? false : prefs.collapsed;
  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const nearTop = el.scrollTop < 28;
    const jump = document.getElementById("streamJump");
    if (jump) jump.hidden = nearTop;
  };
  const jumpTop = () => { const el = bodyRef.current; if (el) el.scrollTop = 0; };

  return (
    <section id="streamPane" className={embedded ? "rp-stream embedded" : ""} style={embedded ? undefined : { height: prefs.collapsed ? "38px" : `${prefs.height}px` }}>
      {!embedded && (
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
      )}
      <div className="stream-head">
        {embedded ? (
          <span id="streamToggle" className="stream-toggle static" aria-expanded="true">
            <span className={`st-dot${newDot ? " has-new" : ""}`} />
            <span className="st-title">决策流 · LIVE{prefs.quiet ? " · 只看决策" : ""}</span>
            <span id="streamCount" className="mono st-count">{prefs.quiet ? `${shown.length} 条实际决策` : `${rowPairs.length} 条 · ${rowPairs.length - quietCount} 实际决策`}</span>
          </span>
        ) : (
          <button id="streamToggle" type="button" className="stream-toggle" aria-expanded={!prefs.collapsed} onClick={toggle}>
            <span className={`st-dot${newDot ? " has-new" : ""}`} />
            <span className="st-title">决策流 · LIVE{prefs.quiet ? " · 只看决策" : ""}</span>
            <span id="streamCount" className="mono st-count">{prefs.quiet ? `${shown.length} 条实际决策` : `${rowPairs.length} 条 · ${rowPairs.length - quietCount} 实际决策`}</span>
            <span className="st-chev">{prefs.collapsed ? "▸" : "▾"}</span>
          </button>
        )}
        {!collapsed && (
          <button id="streamFilter" className={`stream-filter${prefs.quiet ? " on" : ""}`} type="button"
            title={prefs.quiet ? "显示全部（含无需决策）" : "只显示实际决策（隐藏无需决策行）"}
            onClick={() => { setPrefs({ quiet: !prefs.quiet }); }}>
            只看决策
          </button>
        )}
        {!embedded && prefs.collapsed && liveRow && (
          <span id="streamLive" className="st-live">
            <span className="sl-t" style={{ color: TENANT_COLORS[liveRow.tenant] ?? "var(--text-dim)" }}>{liveRow.tenant.toUpperCase()}</span>
            <span className="sl-tick">#{fmt(liveRow.tick)}</span>
            <span className="sl-text">{DECISION_KIND_CN[String(liveRow.deadlineOutcome ?? "")] ?? "决策"}</span>
          </span>
        )}
      </div>
      <Tabs value={tab} onValueChange={(v) => setPrefs({ tab: v })}>
        <TabsList id="streamTabs" className="tabs h-auto gap-[2px] px-[14px] pt-[8px] pb-0 rounded-none bg-transparent">
          {[{ id: "all", label: "全局" }, ...TENANTS.map((t) => ({ id: t, label: t.toUpperCase() })), { id: "events", label: "事件" }, { id: "deeds", label: "事迹" }].map((tb) => {
            const n = tb.id === "deeds"
              ? journal?.deeds?.length ?? 0
              : tb.id === "events"
              ? TENANTS.reduce((a, t) => a + (payload?.events[t]?.length ?? 0), 0)
              : (prefs.quiet ? kept : rowPairs).filter((p) => tb.id === "all" || p.t === tb.id).length;
            return (
              <TabsTrigger key={tb.id} data-tab={tb.id} value={tb.id}
                className="gap-0 px-[14px] py-[9px] pb-[10px] rounded-none data-[state=active]:bg-transparent data-[state=active]:ring-0">
                {tb.label}{n > 0 ? <span className="tab-badge">{Math.min(n, 999)}</span> : null}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>
      <div id="streamBody" ref={bodyRef} onScroll={onScroll}>
        {tab === "events" ? (
          eventPairs.length === 0 ? (
            <div className="stream-empty">暂无事件数据</div>
          ) : (
            eventPairs.map(({ e, t }) => (
              <EventRowItem key={`${t}:${e.tick}:${e.kind}:${e.actor ?? ""}:${e.target ?? ""}`} e={e} tenant={t} />
            ))
          )
        ) : tab === "deeds" ? (
          <>
            <div className="deeds-filters">
              <span className="df-label">类别</span>
              <ToggleGroup type="single" value={deedCat} onValueChange={(v) => v && setDeedCat(v)} className="inline-flex flex-wrap items-center gap-[5px]" aria-label="事迹类别">
                {([["all", "全部"], ["milestone", "里程碑"], ["harvest", "采集"], ["deposit", "交付"], ["spawn", "产兵"], ["death", "阵亡"], ["conflict", "冲突"], ["economy", "经济"], ["other", "其他"]] as Array<[string, string]>).map(([id, label]) => (
                  <ToggleGroupItem key={id} value={id}
                    className="chip px-[7px] py-[1px] text-[10.5px] font-mono rounded-full border-[var(--border-strong)] data-[state=on]:bg-transparent data-[state=on]:ring-0">{label}</ToggleGroupItem>
                ))}
              </ToggleGroup>
              <span className="df-label">星级</span>
              <ToggleGroup type="single" value={String(deedStar)} onValueChange={(v) => v && setDeedStar(Number(v))} className="inline-flex flex-wrap items-center gap-[5px]" aria-label="事迹星级">
                {([[0, "全部"], [2, "★2+"], [3, "★3+"]] as Array<[number, string]>).map(([v, label]) => (
                  <ToggleGroupItem key={v} value={String(v)}
                    className="chip px-[7px] py-[1px] text-[10.5px] font-mono rounded-full border-[var(--border-strong)] data-[state=on]:bg-transparent data-[state=on]:ring-0">{label}</ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            {(journal?.deeds?.length ?? 0) === 0 ? (
              <div className="stream-empty">{journal ? "暂无联盟事迹（30s 刷新）" : "加载联盟事迹…"}</div>
            ) : (
              journal?.deeds?.map((d) => (
                <DeedRowItem key={d.id} d={d} />
              ))
            )}
          </>
        ) : shown.length === 0 ? (
          <div className="stream-empty">{prefs.quiet ? "暂无实际决策（可关闭「只看决策」查看全部行）" : "暂无决策数据"}</div>
        ) : (
          shown.map(({ r, t }) => (
            <StreamRowItem key={`${t}:${r.tick}:${String(r.deadlineOutcome ?? "")}:${String(r.submitResult ?? "")}`} r={r} tenant={t} />
          ))
        )}
      </div>
      <button id="streamJump" className="stream-jump" type="button" hidden onClick={jumpTop}>↑ 最新</button>
    </section>
  );
}
