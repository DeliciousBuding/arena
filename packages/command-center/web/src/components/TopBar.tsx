import { useEffect, useState } from "react";
import { Sun, Moon, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useEngine } from "@/lib/bridge";
import { useShell } from "@/lib/shell";
import { TENANT_COLORS } from "@/engine/tactical";

interface TickPayload { clock: string; tick: number; period: number; frac: number; remain?: number | null }
interface HealthPayload {
  global?: { healthy?: boolean; maxLagTicks?: number; avgLagTicks?: number; staleTenants?: string[]; missingTenants?: string[] };
}

const TENANT_LABEL: Record<string, string> = { t1: "T1", t2: "T2", t3: "T3", t4: "T4" };

interface OverviewTenant {
  tenant: string;
  live?: boolean;
  latest?: {
    resources?: number | null;
    resourceDelta?: number | null;
    workers?: number | null;
    units?: number | null;
    visibleEnemies?: number | null;
    coreX?: number | null;
    coreY?: number | null;
    status?: string | null;
    tick?: number | null;
  };
}

export function TopBar() {
  const engine = useEngine();
  const { openRight, toggleLeft } = useShell();
  const [tick, setTick] = useState<TickPayload | null>(null);
  const [refreshOk, setRefreshOk] = useState<boolean>(true);
  const [encounteredCount, setEncounteredCount] = useState(0);
  const [overview, setOverview] = useState<OverviewTenant[]>([]);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  // 主题切换：深色/浅色，localStorage 持久化；Canvas 地图保持暗色场景不变
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try { return (localStorage.getItem("arena-cc.theme") as "dark" | "light") || "dark"; } catch { return "dark"; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("arena-cc.theme", theme); } catch { /* 隐私模式忽略 */ }
  }, [theme]);

  useEffect(() => {
    if (!engine) return;
    return engine.subscribe((topic, payload) => {
      if (topic === "tick") setTick(payload as TickPayload);
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

  // 数据管线健康：survey-db 同步水位 vs live tick 滞后（/api/health/pipeline，15s 缓存）
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
        <Button id="drawerToggle" variant="ghost" size="icon-sm" className="map-drawer-toggle" title="展开/收起左侧面板（租户/图层）" onClick={toggleLeft} aria-label="左侧面板">
          <PanelLeftOpen className="side-toggle-icon" />
        </Button>
        <img src="/assets/game/units/core.png" alt="" className="brand-icon" draggable="false" />
        <div className="brand-text">
          <h1>Arena 指挥面板</h1>
          <p className="subtitle">COMMAND CENTER</p>
        </div>
      </div>
      <div className="empire-strip" title="帝国总览：各租户 资源 / 单位 / 增量 / 敌方单位数（点击租户卡可聚焦该租户）">
        {overview.map((t) => {
          const color = TENANT_COLORS[t.tenant] ?? "var(--t1)";
          const L = t.latest ?? {};
          const d = L.resourceDelta ?? null;
          return (
            <div key={t.tenant} className="empire-cell" style={{ ["--tc" as string]: color }}>
              <b><i>{TENANT_LABEL[t.tenant] ?? t.tenant.toUpperCase()}</i> {L.resources ?? "—"}</b>
              <span>
                单位 {L.units ?? L.workers ?? "—"} ·{" "}
                {d === null ? (
                  <em>—</em>
                ) : (
                  <em className={d > 0 ? "delta-pos" : d < 0 ? "delta-neg" : ""}>{d > 0 ? `+${d}` : d}</em>
                )}
                {L.visibleEnemies != null ? <em className="enemy-count"> · 敌 {L.visibleEnemies}</em> : null}
              </span>
            </div>
          );
        })}
      </div>
      <div className="top-status">
        <span id="clock" className="mono dim">{tick?.clock ?? "—"}</span>
        <Badge id="refreshBadge" variant={refreshOk ? "success" : "danger"} size="sm" pulse={refreshOk}>{refreshOk ? "实时" : "离线"}</Badge>
        <span className="tick-meter mono" title="世界回合周期（约 15 秒一回合，进度条表示距下一回合）">
          <span id="tickLabel" className={`dim${urgent ? " warn" : ""}`}>回合 {tick ? `${tick.tick} · ${Math.round((tick.period ?? 15000) / 1000)}s${tick.remain != null ? ` · 剩 ${Math.max(0, Math.round(tick.remain))}s` : ""}` : "—"}</span>
          <span className={`tick-bar${urgent ? " warn" : ""}`}><i id="tickFill" style={{ transform: `scaleX(${frac.toFixed(3)})` }} /></span>
        </span>
        <Button id="intelBtn" variant="default" size="sm" title="官方排行榜威胁画像（谁在打我们）" onClick={() => openRight("intel")}>
          威胁情报
          {encounteredCount > 0 ? <span className="btn-count" title={`目击过的敌方玩家数（唯一账号）· 详情见右侧威胁情报面板`}>{encounteredCount}</span> : null}
        </Button>
        <Button id="redeemBtn" variant="primary" size="sm" onClick={() => openRight("redeem")}>兑换码</Button>
        <Badge id="healthChip"
          variant={health?.global?.healthy === false ? (health.global.missingTenants?.length ? "danger" : "warn") : "success"}
          size="sm"
          title={(() => {
            const g = health?.global;
            if (!g) return "数据同步状态（加载中）";
            const parts = [];
            if (g.missingTenants?.length) parts.push(`数据缺失 ${g.missingTenants.join(",").toUpperCase()}`);
            if (g.staleTenants?.length) parts.push(`数据滞后 ${g.staleTenants.join(",").toUpperCase()}`);
            parts.push(`最大滞后 ${g.maxLagTicks ?? 0} 回合 · 平均 ${g.avgLagTicks ?? 0} 回合`);
            return "数据同步 · " + parts.join(" · ");
          })()}>
          {health?.global?.healthy === false
            ? (health.global.missingTenants?.length ? "数据缺失" : `数据滞后 ${health.global.maxLagTicks ?? "?"} 回合`)
            : "数据同步"}
        </Badge>
        <Button id="themeToggle" variant="ghost" size="icon-sm"
          title={theme === "dark" ? "切换到浅色主题（UI 层；地图保持暗色场景）" : "切换到深色主题"}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label="切换主题">
          {theme === "dark" ? <Sun className="theme-icon" /> : <Moon className="theme-icon" />}
        </Button>
      </div>
    </header>
  );
}
