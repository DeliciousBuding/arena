import { useEffect, useState } from "react";
import { useEngine } from "../lib/bridge";
import { useShell } from "../lib/shell";

interface TickPayload { clock: string; tick: number; period: number; frac: number; remain?: number | null }
interface HealthPayload {
  global?: { healthy?: boolean; maxLagTicks?: number; avgLagTicks?: number; staleTenants?: string[]; missingTenants?: string[] };
}

const TENANT_COLORS: Record<string, string> = { t1: "#69b3d8", t2: "#57bd84", t3: "#a892d6", t4: "#dd626d" };
const TENANT_LABEL: Record<string, string> = { t1: "T1", t2: "T2", t3: "T3", t4: "T4" };

interface OverviewTenant {
  tenant: string;
  live?: boolean;
  latest?: {
    resources?: number | null;
    resourceDelta?: number | null;
    workers?: number | null;
    tick?: number | null;
  };
}

export function TopBar() {
  const engine = useEngine();
  const { openRight } = useShell();
  const [tick, setTick] = useState<TickPayload | null>(null);
  const [dataRoot, setDataRoot] = useState<string>("");
  const [refreshOk, setRefreshOk] = useState<boolean>(true);
  const [encounteredCount, setEncounteredCount] = useState(0);
  const [overview, setOverview] = useState<OverviewTenant[]>([]);
  const [health, setHealth] = useState<HealthPayload | null>(null);

  useEffect(() => {
    if (!engine) return;
    return engine.subscribe((topic, payload) => {
      if (topic === "tick") setTick(payload as TickPayload);
      else if (topic === "dataRoot") setDataRoot(String(payload ?? ""));
      else if (topic === "refresh") setRefreshOk(payload !== false);
      else if (topic === "overview") {
        const ov = payload as { tenants?: OverviewTenant[] } | null;
        setOverview(Array.isArray(ov?.tenants) ? ov.tenants : []);
      }
      else if (topic === "intel") {
        const intel = payload as { enemies?: Array<{ username?: string | null }> } | null;
        const enemies = Array.isArray(intel?.enemies) ? intel.enemies : [];
        const unique = new Set(enemies.map((e) => e?.username).filter(Boolean)).size;
        setEncounteredCount(unique);
      }
    });
  }, [engine]);

  // 数据管线健康（2026-08-08）：survey-db 同步水位 vs live tick 滞后——测绘记录层
  // 是否健康前进一眼可读（后端 /api/health/pipeline，15s 缓存）。
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch("/api/health/pipeline", { cache: "no-store" });
        if (r.ok && !stop) setHealth((await r.json()) as HealthPayload);
      } catch { /* 端点暂不可用则保持上次状态 */ }
    };
    load();
    const timer = setInterval(load, 15000);
    return () => { stop = true; clearInterval(timer); };
  }, []);

  const frac = tick?.frac ?? 0;
  const urgent = frac > 0.82;
  return (
    <header id="topbar">
      <div className="brand">
        <img src="/assets/game/units/core.png" alt="" className="brand-icon" draggable="false" />
        <div className="brand-text">
          <h1>Arena 指挥面板</h1>
          <p className="subtitle">COMMAND CENTER</p>
        </div>
      </div>
      <div className="empire-strip" title="帝国总览：各租户 资源 / 工人 / 增量（点击租户卡可聚焦）">
        {overview.map((t) => {
          const color = TENANT_COLORS[t.tenant] ?? "#69b3d8";
          const L = t.latest ?? {};
          const d = L.resourceDelta ?? 0;
          return (
            <div key={t.tenant} className="empire-cell" style={{ ["--tc" as string]: color }}>
              <b><i>{TENANT_LABEL[t.tenant] ?? t.tenant.toUpperCase()}</i> {L.resources ?? "—"}</b>
              <span>工人 {L.workers ?? "—"} · <em className={d > 0 ? "delta-pos" : d < 0 ? "delta-neg" : ""}>{d > 0 ? `+${d}` : d}</em></span>
            </div>
          );
        })}
      </div>
      <div className="top-status">
        <span id="clock" className="mono dim">{tick?.clock ?? "—"}</span>
        <span id="dataRoot" className="mono dim" title="数据根（只读）">{dataRoot}</span>
        <span id="refreshBadge" className={`badge ${refreshOk ? "ok" : "err"}`}>{refreshOk ? "实时" : "离线"}</span>
        <span className="tick-meter mono" title="世界 tick 周期（估计）：游戏每 ~15s 一个 tick，进度条表示距下一 tick">
          <span id="tickLabel" className={`dim${urgent ? " warn" : ""}`}>tick {tick ? `${tick.tick} · ${Math.round((tick.period ?? 15000) / 1000)}s${tick.remain != null ? ` · 剩 ${Math.max(0, Math.round(tick.remain))}s` : ""}` : "—"}</span>
          <span className={`tick-bar${urgent ? " warn" : ""}`}><i id="tickFill" style={{ transform: `scaleX(${frac.toFixed(3)})` }} /></span>
        </span>
        <button id="intelBtn" className="btn" type="button" title="官方排行榜威胁画像（谁在打我们）" onClick={() => openRight("intel")}>
          威胁情报
          {encounteredCount > 0 ? <span className="btn-count" title={`目击过的敌方玩家数（唯一账号）· 详情见右侧威胁情报面板`}>{encounteredCount}</span> : null}
        </button>
        <button id="redeemBtn" className="btn primary" type="button" onClick={() => openRight("redeem")}>兑换码</button>
        <span id="healthChip" className={`health-chip${health?.global?.healthy === false ? (health.global.missingTenants?.length ? " err" : " warn") : " ok"}`}
          title={(() => {
            const g = health?.global;
            if (!g) return "数据管线健康状态（加载中）";
            const parts = [];
            if (g.missingTenants?.length) parts.push(`测绘缺失 ${g.missingTenants.join(",").toUpperCase()}`);
            if (g.staleTenants?.length) parts.push(`测绘滞后 ${g.staleTenants.join(",").toUpperCase()}`);
            parts.push(`最大滞后 ${g.maxLagTicks ?? 0} tick · 平均 ${g.avgLagTicks ?? 0} tick`);
            return "数据管线健康 · " + parts.join(" · ");
          })()}>
          {health?.global?.healthy === false
            ? (health.global.missingTenants?.length ? "测绘缺失" : `测绘滞后 ${health.global.maxLagTicks ?? "?"}t`)
            : "测绘同步"}
        </span>
      </div>
    </header>
  );
}
