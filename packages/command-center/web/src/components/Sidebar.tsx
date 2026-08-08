import { useEffect, useState, type ReactNode } from "react";
import { useEngine, getEngine } from "../lib/bridge";

const TENANTS = ["t1", "t2", "t3", "t4"];
const TENANT_LABEL: Record<string, string> = { t1: "租户 1", t2: "租户 2", t3: "租户 3", t4: "租户 4" };
const TENANT_COLORS: Record<string, string> = { t1: "#69b3d8", t2: "#7fd8a5", t3: "#a892d6", t4: "#fc5646" };

const PREFS_KEY = "arena-cc-web.prefs";
/** 侧栏分区折叠（2026-08-08）：1080p 下"图层/租户视图"在折叠线以下，点标题可收起大区块。
 *  子元素保持挂载（display:none），引擎依赖的 #tenantCards/#layerToggles 等 id 不丢失。 */
function CollapsiblePanel({ id, title, children, className = "" }: { id: string; title: ReactNode; children: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(() => {
    try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}"); return p[`sec_${id}`] !== false; } catch { return true; }
  });
  useEffect(() => {
    try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}"); p[`sec_${id}`] = open; localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* 忽略 */ }
  }, [open]);
  return (
    <section className={`panel collapsible${className ? " " + className : ""}${open ? "" : " closed"}`}>
      <h3 className="panel-title sec-head" role="button" tabIndex={0} aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }}>
        <span className="sec-title">{title}</span><span className="sec-chev">{open ? "▾" : "▸"}</span>
      </h3>
      <div className="sec-body" hidden={!open}>{children}</div>
    </section>
  );
}

const fmt = (n: number | null | undefined, digits = 0): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.abs(n) >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: digits }) : n.toFixed(digits);
};

interface OverviewTenant {
  tenant: string;
  live?: boolean;
  fileFresh?: boolean;
  latest?: {
    tick?: number | null;
    resources?: number | null;
    resourceDelta?: number | null;
    workers?: number | null;
    workerMaxDistance?: number | null;
    workerMeanDistance?: number | null;
    visibleResources?: number | null;
    events?: number | null;
  };
}
interface Overview { tenants: OverviewTenant[] }

/** 与引擎同源拉取 /api/overview（本地文件读取，3s 一次，开销可忽略）。 */
function useOverview(): Overview | null {
  const [ov, setOv] = useState<Overview | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/overview", { cache: "no-store" });
        if (res.ok) { const data = await res.json(); if (alive) setOv(data); }
      } catch { /* 忽略，下次重试 */ }
    };
    load();
    const timer = setInterval(load, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return ov;
}

function statusOf(t: OverviewTenant): { cls: string; label: string } {
  if (t.live) return { cls: "live", label: "在线" };
  if (t.fileFresh) return { cls: "fresh", label: "数据新鲜" };
  return { cls: "stale", label: "离线" };
}

function TenantCards() {
  const overview = useOverview();
  const engine = useEngine();
  const solo = engine?.getState().soloTenant ?? null;
  const tenants = overview?.tenants ?? [];
  // 目录树折叠（2026-08-08）：点折叠按钮收起详情，只留摘要行；独立于聚焦。
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  return (
    <div id="tenantCards" className="stack">
      {tenants.map((t) => {
        const tenant = String(t.tenant ?? "");
        const color = TENANT_COLORS[tenant] ?? "#999";
        const st = statusOf(t);
        const L = t.latest ?? {};
        const isSolo = solo === tenant;
        const isFolded = collapsed[tenant] === true;
        return (
          <div
            key={tenant}
            className={`tenant-card${isSolo ? " solo" : ""}`}
            data-tenant={tenant}
            style={{ ["--tc" as string]: color }}
            role="button"
            tabIndex={0}
            title={isSolo ? "点击返回全局联盟" : `点击聚焦 ${tenant.toUpperCase()}`}
            onClick={() => getEngine()?.toggleSolo(tenant)}
            onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); getEngine()?.toggleSolo(tenant); } }}
          >
            {isSolo && (
              <div
                className="tc-exit" role="button" tabIndex={0} title="返回全局联盟（Esc / G 也可）"
                onClick={(ev) => { ev.stopPropagation(); getEngine()?.exitSolo(); }}
                onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); getEngine()?.exitSolo(); } }}
              >✕ 返回全局</div>
            )}
            <div className="row1">
              <span className={`dot ${st.cls}`} title={st.label} />
              <span className="tenant-name">{tenant.toUpperCase()}</span>
              <span className="tenant-tag">{TENANT_LABEL[tenant] ?? ""}</span>
              <button type="button" className={`tc-fold${isFolded ? " folded" : ""}`} title={isFolded ? "展开详情" : "折叠详情"}
                aria-expanded={!isFolded}
                onClick={(ev) => { ev.stopPropagation(); setCollapsed((p) => ({ ...p, [tenant]: !isFolded })); }}>
                {isFolded ? "▸" : "▾"}
              </button>
            </div>
            {isFolded ? (
              <div className="fold-summary">
                <span>资源 <b>{fmt(L.resources)}</b></span>
                <span>tick <b>{fmt(L.tick)}</b></span>
                <span className="fold-ellipsis">…</span>
              </div>
            ) : (
            <>
            <div className="metrics">
              <div className="metric"><span className="v">{fmt(L.resources)}</span><span className="k">资源</span></div>
              <div className="metric"><span className={`v ${(L.resourceDelta ?? 0) > 0 ? "delta-pos" : (L.resourceDelta ?? 0) < 0 ? "delta-neg" : ""}`}>{fmt(L.resourceDelta, 0)}</span><span className="k">增量</span></div>
              <div className="metric"><span className="v">{fmt(L.workers)}</span><span className="k">工人</span></div>
              <div className="metric"><span className="v">{fmt(L.events)}</span><span className="k">事件</span></div>
            </div>
            <div className="row3">
              <span>tick <b>{fmt(L.tick)}</b></span>
              <span>最大距离 <b>{fmt(L.workerMaxDistance)}</b></span>
              <span>均值 <b>{fmt(L.workerMeanDistance)}</b></span>
              <span>可见资源 <b>{fmt(L.visibleResources)}</b></span>
            </div>
            </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Legend() {
  return (
    <ul id="legendList" className="legend">
      <li><span className="sw core" />核心</li>
      <li><span className="sw unit" />单位</li>
      <li><span className="sw resource" />资源</li>
      <li><span className="sw obstacle" />障碍</li>
      <li><span className="sw beacon" />冠军信标</li>
      <li><span className="sw memory" />已探索记忆（非当前 tick 淡显）</li>
      <li><span className="sw enemy-mem" />敌情记忆（出视野半透明 · 悬停看最后目击）</li>
    </ul>
  );
}

const LAYERS: Array<[string, string]> = [
  ["obstacle", "障碍"], ["resource", "资源"], ["unit", "单位"], ["core", "核心"], ["beacon", "信标"], ["beaconTrail", "信标轨迹"],
  ["survey", "测绘"], ["patrol", "巡逻环"], ["plan", "计划箭头"], ["trail", "移动轨迹"], ["beaconEdge", "信标指示"], ["coreTrail", "敌核轨迹"], ["enemyMemory", "敌情记忆"], ["enemyHeat", "敌情热区"],
];

function LayerToggles() {
  const engine = useEngine();
  const layers = engine?.getState().layers ?? {};
  return (
    <div id="layerToggles" className="toggles">
      {LAYERS.map(([key, label]) => (
        <label key={key}>
          <input type="checkbox" data-layer={key} checked={!!layers[key]} onChange={(ev) => getEngine()?.setLayer(key, ev.target.checked)} />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

function ViewSwitch() {
  const engine = useEngine();
  const state = engine?.getState();
  const global = !state?.soloTenant;
  const tenantsOn = state?.tenantsOn ?? {};
  return (
    <>
      <div id="tenantToggles" className="toggles">
        {TENANTS.map((t) => (
          <label key={t}>
            <input type="checkbox" data-tenant={t} checked={tenantsOn[t] !== false} onChange={(ev) => getEngine()?.setTenantOn(t, ev.target.checked)} />
            <span style={{ color: TENANT_COLORS[t] }}>{t.toUpperCase()}</span>
          </label>
        ))}
      </div>
      <div className="view-switch">
        <button id="viewGlobal" className={`btn${global ? " active" : ""}`} type="button" onClick={() => getEngine()?.exitSolo()}>全局联盟</button>
        <button id="viewFit" className="btn" type="button" onClick={() => { const e = getEngine(); if (e) { const s = e.getState(); s.soloTenant ? e.fitSolo(s.soloTenant) : e.fitView(); } }}>适应视口</button>
      </div>
    </>
  );
}

/* ---------------- 人类指挥状态（全局视图可见，4 租户） ---------------- */
interface CmdStore { mode?: string; actions?: unknown[]; goals?: unknown[]; telemetry?: { applied?: string[]; rejected?: { unitId: string; reason: string }[]; satisfied?: string[] } | null }
function useCommandStores(): Record<string, CmdStore> {
  const [stores, setStores] = useState<Record<string, CmdStore>>({});
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const results = await Promise.allSettled(TENANTS.map((t) => fetch("/api/commands?tenant=" + t, { cache: "no-store" }).then((r) => r.json())));
      if (!alive) return;
      const next: Record<string, CmdStore> = {};
      results.forEach((r, i) => { if (r.status === "fulfilled") next[TENANTS[i]] = r.value as CmdStore; });
      setStores(next);
    };
    load();
    const timer = setInterval(load, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return stores;
}
async function ccPostJson(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return res.ok;
  } catch { return false; }
}
function CommandStatusPanel() {
  const stores = useCommandStores();
  const engine = useEngine();
  const total = TENANTS.reduce((acc, t) => {
    const st = stores[t];
    return acc + (st ? (st.actions?.length ?? 0) + (st.goals?.length ?? 0) : 0);
  }, 0);
  const anyOverride = TENANTS.some((t) => stores[t]?.mode === "override");
  return (
    <CollapsiblePanel id="cmd" className="cmd-panel" title={<><span className="sec-title-inline">人类指挥 · HUMAN COMMAND</span>{total > 0 ? <span className="cmd-total mono" title="全联盟人类指令总数">{total}</span> : null}</>}>
      <div className="cmd-toggle-row">
        <span className="cmd-toggle-label">{anyOverride ? "接管中 · 命令优先于 agent" : "已交还 agent 全权"}</span>
        <button
          type="button"
          className={`btn cmd-toggle-btn${anyOverride ? " active" : ""}`}
          title={anyOverride ? "一键交还 agent 全权（清空人类指令）" : "启用人类最高控制权"}
          onClick={async () => {
            const nextMode = anyOverride ? "disabled" : "override";
            if (nextMode === "disabled" && total > 0 && !window.confirm("确认清空全部人类指令并交还 agent 全权？")) return;
            for (const t of TENANTS) {
              if (nextMode === "disabled") await ccPostJson("/api/command/clear", { tenant: t });
              await ccPostJson("/api/command/mode", { tenant: t, mode: nextMode });
            }
            setTimeout(() => window.location.reload(), 400);
          }}
        >{anyOverride ? "交还 Agent" : "人类接管"}</button>
      </div>
      <ul className="cmd-list">
        {TENANTS.map((t) => {
          const st = stores[t];
          const n = st ? (st.actions?.length ?? 0) + (st.goals?.length ?? 0) : 0;
          const tele = st?.telemetry;
          const applied = tele?.applied?.length ?? 0;
          const rej = tele?.rejected?.length ?? 0;
          const done = tele?.satisfied?.length ?? 0;
          const color = TENANT_COLORS[t] ?? "#999";
          return (
            <li key={t} className={"cmd-row" + (n > 0 ? " active" : "")} data-tenant={t}>
              <span className="cmd-tenant" style={{ color }}>{t.toUpperCase()}</span>
              <span className="cmd-n mono">{n} 指令</span>
              <span className="cmd-tele mono">
                {applied > 0 ? <b className="ok">✓{applied}</b> : null}
                {rej > 0 ? <b className="no">✗{rej}</b> : null}
                {done > 0 ? <b className="done">✓{done}</b> : null}
                {n === 0 ? <span className="dim">—</span> : null}
              </span>
              <button type="button" className="btn cmd-clear" title={`清空 ${t.toUpperCase()} 人类指令`} disabled={n === 0}
                onClick={async () => { await ccPostJson("/api/command/clear", { tenant: t }); setTimeout(() => window.location.reload(), 300); }}>清空</button>
            </li>
          );
        })}
      </ul>
    </CollapsiblePanel>
  );
}

/** 引擎把 fleetHud / assetPanel 写入这些容器（位于布局内，引擎 els 可解析）。 */
function EngineContainers() {
  return (
    <>
      <div id="fleetHud" className="panel fleet-hud" hidden />
      <section id="assetPanel" className="panel" hidden>
        <h3 className="panel-title">舰队索引 · FLEET INDEX</h3>
        <div id="assetList" className="asset-list" />
      </section>
    </>
  );
}

export function Sidebar() {
  return (
    <aside id="sidebar">
      <CollapsiblePanel id="tenants" title="租户 · TENANTS"><TenantCards /></CollapsiblePanel>
      <CommandStatusPanel />
      <CollapsiblePanel id="legend" title="图例 · LEGEND"><Legend /></CollapsiblePanel>
      <CollapsiblePanel id="layers" title="图层 · LAYERS"><LayerToggles /></CollapsiblePanel>
      <CollapsiblePanel id="view" title="租户视图 · VIEW"><ViewSwitch /></CollapsiblePanel>
      <EngineContainers />
    </aside>
  );
}
