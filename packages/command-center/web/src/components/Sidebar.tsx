import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { useEngine, getEngine } from "../lib/bridge";
import { TENANT_COLORS } from "@/engine/tactical";

const TENANTS = ["t1", "t2", "t3", "t4"];
const TENANT_LABEL: Record<string, string> = { t1: "租户 1", t2: "租户 2", t3: "租户 3", t4: "租户 4" };

const PREFS_KEY = "arena-cc-web.prefs";
/** 侧栏分区折叠（2026-08-08）：1080p 下"图层/租户视图"在折叠线以下，点标题可收起大区块。
 *  子元素保持挂载（display:none），引擎依赖的 #tenantCards/#layerToggles 等 id 不丢失。
 *  Radix Collapsible 提供 Enter/Space 键盘切换 + aria-expanded；视觉仍由 style.css 负责。 */
function CollapsiblePanel({ id, title, children, className = "" }: { id: string; title: ReactNode; children: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(() => {
    try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}"); return p[`sec_${id}`] !== false; } catch { return true; }
  });
  useEffect(() => {
    try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}"); p[`sec_${id}`] = open; localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* 忽略 */ }
  }, [open]);
  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <section className={`panel collapsible${className ? " " + className : ""}${open ? "" : " closed"}`}>
        <CollapsibleTrigger asChild>
          <h3 className="panel-title sec-head" role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } }}>
            <span className="sec-title">{title}</span><span className="sec-chev">{open ? <ChevronDown className="sec-chev-ico" /> : <ChevronRight className="sec-chev-ico" />}</span>
          </h3>
        </CollapsibleTrigger>
        <CollapsibleContent forceMount className="sec-body">{children}</CollapsibleContent>
      </section>
    </Collapsible>
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
    units?: number | null;
    vanguards?: number | null;
    rangers?: number | null;
    workerMaxDistance?: number | null;
    workerMeanDistance?: number | null;
    visibleResources?: number | null;
    visibleEnemies?: number | null;
    coreX?: number | null;
    coreY?: number | null;
    status?: string | null;
    events?: number | null;
  };
}
interface Overview { tenants: OverviewTenant[] }

// useOverview 已去重（2026-08-09）：mapEngine poll 拉 /api/overview 后 emit('overview')
// → bridge bump → Sidebar 重渲染，复用 engine.getState().overview，不再独立 fetch 双拉。

function statusOf(t: OverviewTenant): { cls: string; label: string } {
  if (t.live) return { cls: "live", label: "在线" };
  if (t.fileFresh) return { cls: "fresh", label: "数据新鲜" };
  return { cls: "stale", label: "离线" };
}

/** 综合审计总览（数据线单调用）：/api/audit/overview —— 矿缺口/失联/分工/对齐/停滞/核心增量。
 *  服务端 30s TTL 缓存 + 启动预热，前端 30s 拉一次即可（不新增 I/O，不碰定时任务）。 */
interface AuditTenant {
  tenant?: string;
  mines?: { total?: number | null; neverHarvested?: number | null; overdueRefills?: number | null; maxGapAgeTicks?: number | null } | null;
  mining?: { assigned?: number | null } | null;
  trend?: { coreDelta?: number | null; stallRate?: number | null } | null;
  exploration?: { exploredChunks?: number | null } | null;
}
interface AuditOverview {
  tenants?: Record<string, AuditTenant>;
  global?: {
    totalNeverHarvested?: number | null;
    totalVisibleNever?: number | null;
    totalOverdueRefills?: number | null;
    miningFulfillment?: { assigned?: number | null; harvested?: number | null; effectiveRate?: number | null } | null;
    alignment?: { aligned?: number | null; misaligned?: number | null } | null;
  } | null;
}
function useAuditOverview(): AuditOverview | null {
  const [ao, setAo] = useState<AuditOverview | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/audit/overview", { cache: "no-store" });
        if (res.ok) { const data = await res.json(); if (alive) setAo(data as AuditOverview); }
      } catch { /* 忽略，下次重试 */ }
    };
    load();
    const timer = setInterval(load, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return ao;
}

/** 目录树根节点：全联盟加总（未采/失联/停滞）——一眼看联盟整体健康。
 *  2026-08-10 精简：删分工/对齐（分析型数据，非状态）；卡内数据条同源三指标。 */
function AllianceRoot({ audit }: { audit: AuditOverview | null }) {
  const g = audit?.global ?? null;
  const stallAvg = (() => {
    const rates = Object.values(audit?.tenants ?? {}).map((x) => x?.trend?.stallRate ?? null).filter((x): x is number => x != null);
    if (!rates.length) return null;
    return Math.round((rates.reduce((a, x) => a + x, 0) / rates.length) * 100) + "%";
  })();
  const items: Array<{ k: string; v: string; cls?: string; title?: string }> = [
    { k: "未采", v: fmt(g?.totalNeverHarvested), title: "全联盟发现后从未开采的矿数" },
    { k: "失联", v: fmt(g?.totalOverdueRefills), cls: (g?.totalOverdueRefills ?? 0) > 0 ? "warn" : "", title: "预测该刷新却未再出现（需复测）" },
    { k: "停滞", v: stallAvg ?? "—", title: "等待决策占比（4 租户均值）" },
  ];
  return (
    <div className="alliance-root" data-alliance-root>
      <div className="ar-head"><span className="ar-dot" />全联盟 · ALLIANCE</div>
      <div className="ar-strip">
        {items.map((it) => (
          <span key={it.k} className={`ar-item${it.cls ? " " + it.cls : ""}`} title={it.title}>
            <b>{it.v}</b><i>{it.k}</i>
          </span>
        ))}
      </div>
    </div>
  );
}

/** 单租户矿健康数据条（2026-08-10 精简：3 行 6 指标 → 1 行 3 指标）。
 *  未采/失联/停滞 是唯一值得一眼盯的状态；积压/分工/核心Δ/探索移入悬停说明。 */
function TenantDataStrip({ a }: { a: AuditTenant | undefined }) {
  const m = a?.mines;
  const stall = a?.trend?.stallRate ?? null;
  const stallCls = stall !== null && stall > 0.7 ? "warn" : "";
  const overdue = m?.overdueRefills ?? 0;
  return (
    <div className="data-strip" data-tenant-strip>
      <div className="ds-row">
        <span className="ds-k">矿</span>
        <span className="ds-v"><b className={overdue > 0 ? "warn" : ""}>{fmt(m?.neverHarvested)}</b> 未采 · <b className={overdue > 0 ? "warn" : ""}>{fmt(overdue)}</b> 失联</span>
        <span className="ds-sep" />
        <span className="ds-v" title={`等待决策占比 · 总矿 ${fmt(m?.total)} · 积压 ${fmt(m?.maxGapAgeTicks)} 回合 · 分工 ${fmt(a?.mining?.assigned)} · 核心Δ ${fmt(a?.trend?.coreDelta)} · 探索 ${fmt(a?.exploration?.exploredChunks)} 区块`}>
          <b className={stallCls}>{stall !== null ? Math.round(stall * 100) + "%" : "—"}</b> 停滞
        </span>
      </div>
    </div>
  );
}

function TenantCards() {
  const audit = useAuditOverview();
  const engine = useEngine();
  const overview = (engine?.getState()?.overview ?? null) as Overview | null;
  const solo = engine?.getState().soloTenant ?? null;
  const tenants = overview?.tenants ?? [];
  // 目录树折叠（2026-08-08）：点折叠按钮收起详情，只留摘要行；独立于聚焦。
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // 首载骨架占位（替代黑屏空白）：overview 未到前渲染 4 张骨架卡，符合极简风
  if (!overview) {
    return (
      <div id="tenantCards" className="stack" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="tenant-card skeleton" aria-hidden="true">
            <div className="row1"><span className="skeleton-line short" /></div>
            <div className="metrics">
              {[0, 1, 2, 3].map((j) => <div key={j} className="skeleton-line" />)}
            </div>
            <div className="skeleton-line mid" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div id="tenantCards" className="stack">
      <AllianceRoot audit={audit} />
      {tenants.map((t) => {
        const tenant = String(t.tenant ?? "");
        const color = TENANT_COLORS[tenant] ?? "var(--text-dim)";
        const st = statusOf(t);
        const L = t.latest ?? {};
        const A = audit?.tenants?.[tenant] as AuditTenant | undefined;
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
              ><X className="tc-exit-ico" /> 返回全局</div>
            )}
            <div className="row1">
              <span className={`dot ${st.cls}`} title={st.label} />
              <span className="tenant-name">{tenant.toUpperCase()}</span>
              <span className="tenant-tag">{TENANT_LABEL[tenant] ?? ""}{L.status ? ` · ${L.status}` : ""}</span>
              <button type="button" className={`tc-fold${isFolded ? " folded" : ""}`} title={isFolded ? "展开详情" : "折叠详情"}
                aria-expanded={!isFolded}
                onClick={(ev) => { ev.stopPropagation(); setCollapsed((p) => ({ ...p, [tenant]: !isFolded })); }}>
                {isFolded ? <ChevronRight className="tc-fold-ico" /> : <ChevronDown className="tc-fold-ico" />}
              </button>
            </div>
            {isFolded ? (
              <div className="fold-summary">
                <span>资源 <b>{fmt(L.resources)}</b></span>
                <span>矿 <b>{fmt(A?.mines?.total)}</b></span>
                <span className="fold-ellipsis">…</span>
              </div>
            ) : (
            <>
            <div className="metrics">
              <div className="metric"><span className="v">{fmt(L.resources)}</span><span className="k">资源</span></div>
              <div className="metric" title={`单位总数（含工人/先锋/游侠，台账上报）${L.vanguards != null || L.rangers != null ? `：工${L.units != null && L.vanguards != null && L.rangers != null ? L.units - L.vanguards - L.rangers : "?"} / 锋${L.vanguards ?? "?"} / 射${L.rangers ?? "?"}` : ""}`}>
                <span className="v">{fmt(L.units ?? L.workers)}</span><span className="k">单位</span>
              </div>
              <div className="metric" title="当前可见敌方单位数（智能体上报）">
                <span className="v">{fmt(L.visibleEnemies)}</span><span className="k">敌方</span>
              </div>
            </div>
            <div className="row3">
              <span>回合 <b>{fmt(L.tick)}</b></span>
            </div>
            <TenantDataStrip a={A} />
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
      <li><span className="sw memory" />已探索记忆（非本回合淡显）</li>
      <li><span className="sw enemy-mem" />敌情记忆（出视野半透明 · 悬停看最后目击）</li>
    </ul>
  );
}

/** 图例折叠行（2026-08-10）：符号说明属低频参考，默认收起，点「图例」展开。 */
function LegendFold() {
  const [open, setOpen] = useState(false);
  return (
    <div className="legend-fold">
      <button type="button" className="legend-fold-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="lf-title">图例</span>
        <span className="sec-chev">{open ? <ChevronDown className="sec-chev-ico" /> : <ChevronRight className="sec-chev-ico" />}</span>
      </button>
      {open && <Legend />}
    </div>
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
        <Button id="viewGlobal" variant={global ? "primary" : "default"} size="sm" onClick={() => getEngine()?.exitSolo()}>全局联盟</Button>
        <Button id="viewFit" variant="default" size="sm" onClick={() => { const e = getEngine(); if (e) { const s = e.getState(); s.soloTenant ? e.fitSolo(s.soloTenant) : e.fitView(); } }}>适应视口</Button>
      </div>
    </>
  );
}

/** 显示分区（2026-08-10 合并：图例/图层/租户视图 三个分区 → 一个「显示」，
 *  侧栏 6 分区 → 4 分区。图层与租户视图是地图操作高频项；图例折叠为低频参考。 */
function DisplayPanel() {
  return (
    <>
      <div className="db-label">图层 · LAYERS</div>
      <LayerToggles />
      <div className="db-label">租户 · TENANTS</div>
      <ViewSwitch />
      <LegendFold />
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
      <CollapsiblePanel id="tenants" title="租户 · TENANTS"><TenantCards /></CollapsiblePanel>
      <CollapsiblePanel id="display" title="显示 · DISPLAY"><DisplayPanel /></CollapsiblePanel>
      <EngineContainers />
    </aside>
  );
}
