import { useEffect, useState } from "react";
import { useEngine, getEngine } from "../lib/bridge";

const TENANTS = ["t1", "t2", "t3", "t4"];
const TENANT_LABEL: Record<string, string> = { t1: "租户 1", t2: "租户 2", t3: "租户 3", t4: "租户 4" };
const TENANT_COLORS: Record<string, string> = { t1: "#69b3d8", t2: "#57bd84", t3: "#a892d6", t4: "#dd626d" };

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
  return (
    <div id="tenantCards" className="stack">
      {tenants.map((t) => {
        const tenant = String(t.tenant ?? "");
        const color = TENANT_COLORS[tenant] ?? "#999";
        const st = statusOf(t);
        const L = t.latest ?? {};
        const isSolo = solo === tenant;
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
            </div>
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
    </ul>
  );
}

const LAYERS: Array<[string, string]> = [
  ["obstacle", "障碍"], ["resource", "资源"], ["unit", "单位"], ["core", "核心"], ["beacon", "信标"],
  ["survey", "测绘"], ["patrol", "巡逻环"], ["plan", "计划箭头"], ["trail", "移动轨迹"], ["beaconEdge", "信标指示"],
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
      <TenantCards />
      <section className="panel"><h3 className="panel-title">图例</h3><Legend /></section>
      <section className="panel"><h3 className="panel-title">图层</h3><LayerToggles /></section>
      <section className="panel"><h3 className="panel-title">租户视图</h3><ViewSwitch /></section>
      <EngineContainers />
    </aside>
  );
}
