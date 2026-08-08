/**
 * 联盟态势面板（2026-08-08，右栏 tab）：/api/alliance/snapshot 全量态势——
 * 4 租户实时资源/兵力/核心状态 + 每租户 8 方向威胁扇区（敌核邻近度）+ 敌情目击清单
 * + /api/deeds/journal 事迹叙事。纯只读，15s 轮询；点击目击/事迹可跳转大地图定位。
 */
import { useEffect, useState } from "react";
import { useEngine } from "../../lib/bridge";

const TENANT_COLORS: Record<string, string> = { t1: "#69b3d8", t2: "#57bd84", t3: "#a892d6", t4: "#dd626d" };
const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const DIR_VEC: Record<string, [number, number]> = { N: [0, -1], NE: [1, -1], E: [1, 0], SE: [1, 1], S: [0, 1], SW: [-1, 1], W: [-1, 0], NW: [-1, -1] };
const KIND_CN: Record<string, string> = { CORE: "敌核", UNIT: "单位", WORKER: "工", VANGUARD: "锋", RANGER: "射" };

interface Sector { direction: string; score: number; entityCount: number; nearestDistance: number | null; entityKeys: string[] }
interface ThreatSummary { tenantId: string; corePosition: number[]; sectors: Sector[] }
interface Sighting { key: string; kind: string; ownerUsername: string; position: number[]; sourceTenant: string; firstSeenTick: number; lastSeenTick: number; currentlyVisible: boolean; confidence: number; evidence?: string }
interface MemberCore { id: string; position: number[]; hp: number; shield: number; moving: boolean }
interface Member { tenantId: string; tick: number; observedAtMs: number; core: MemberCore; resources: number; resourceCapacity: number; population: number; workers: number; vanguards: number; rangers: number; carriedResources: number; activeFleetIds: string[]; localThreat: number; localHarvestRate: number; status: string }
interface SnapshotData {
  generatedAt?: string; currentTick?: number; revision?: number;
  members?: Record<string, Member>; sightings?: Sighting[];
  counts?: Record<string, number>; threatSummaries?: ThreatSummary[];
  treasuryTenant?: string; cachedAt?: string;
}
interface Deed { id: string; tick: number; tenant: string; star: number; kind: string; title: string; detail: string; position: number[] | null; actor: string | null; target: string | null }
interface JournalData { generatedAt?: string; currentTick?: number; headline?: Deed | null; narrative?: string; counts?: Record<string, number> }
/** 人类指挥审计（后端 /api/audit/human）：手操流水——复盘"什么时候手操了什么"。 */
interface HumanAuditEntry { at: string; tenant: string; kind: string; unitId?: string; action?: string; note?: string }
interface AuditPayload { generatedAt?: string; records?: HumanAuditEntry[] }
const AUDIT_KIND_CN: Record<string, string> = { command: "指令", goal: "目标", mode: "模式", clear: "清空", delete: "删除" };

const fmt = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.abs(n) >= 1000 ? n.toLocaleString("en-US") : String(n);
};
const distCls = (d: number | null | undefined): string => {
  if (d === null || d === undefined) return "";
  if (d < 18) return "danger";
  if (d < 32) return "warn";
  return "";
};
/** 缩放敏感：近处威胁号大、远处小（视觉权重=距离倒数）。 */
const near = (d: number | null | undefined, f: number): number => {
  if (d === null || d === undefined || d <= 0) return f;
  return Math.max(0.62, Math.min(1.6, f * 1.6 / Math.sqrt(d)));
};

function MemberCard({ t, m, ts, onFocus, onSector }: { t: string; m: Member; ts?: ThreatSummary; onFocus?: (t: string) => void; onSector?: (t: string, sec: Sector, corePos: number[] | undefined) => void }) {
  const hpPct = Math.max(0, Math.min(100, (m.core.hp / 5) * 100));
  const shPct = Math.max(0, Math.min(100, (m.core.shield / 5) * 100));
  const sectors = ts?.sectors ?? [];
  return (
    <div className="sit-member" data-tenant={t}>
      <div className="sit-m-head">
        <span className="sit-chip" style={{ background: TENANT_COLORS[t] ?? "#888" }} />
        <b>{t.toUpperCase()}</b>
        <span className={`sit-status${m.status === "READY" ? " ok" : ""}`}>{m.status ?? "—"}</span>
        <span className="sit-m-pos mono dim">({fmt(m.core.position?.[0])},{fmt(m.core.position?.[1])})</span>
        <button type="button" className="sit-focus" title={`地图聚焦 ${t.toUpperCase()} 核心`} onClick={(e) => { e.stopPropagation(); onFocus?.(t); }}>聚焦</button>
      </div>
      <div className="sit-m-stats">
        <div className="sit-stat">
          <span className="sit-stat-label">资源</span>
          <b className="sit-stat-val">{fmt(m.resources)}</b>
          {m.carriedResources ? <span className="sit-stat-sub">载 {m.carriedResources}</span> : null}
        </div>
        <div className="sit-stat">
          <span className="sit-stat-label">人口</span>
          <b className="sit-stat-val">{fmt(m.population)}</b>
        </div>
        <div className="sit-stat sit-fleet">
          <span className="sit-stat-label">兵力</span>
          <span className="sit-fleet-line">
            {m.workers ? <span className="sit-fleet-w">工{m.workers}</span> : null}
            {m.vanguards ? <span className="sit-fleet-v">锋{m.vanguards}</span> : null}
            {m.rangers ? <span className="sit-fleet-r">射{m.rangers}</span> : null}
            {!m.workers && !m.vanguards && !m.rangers ? <span className="dim">—</span> : null}
          </span>
        </div>
      </div>
      <div className="sit-corebars">
        <span className="sit-cb-label">核心</span>
        <span className="sit-cb"><i className="hp" style={{ width: `${hpPct}%` }} title={`HP ${m.core.hp}/5`} /></span>
        <span className="sit-cb"><i className="sh" style={{ width: `${shPct}%` }} title={`护盾 ${m.core.shield}/5`} /></span>
        {m.core.moving ? <span className="sit-moving mono dim">迁移中</span> : null}
      </div>
      {sectors.length ? (
        <div className="sit-sectors" title="8 方向威胁扇区：分数 = 敌情密度 · 数字 = 敌核数/最近距离">
          {DIRS.map((d) => {
            const s = sectors.find((x) => x.direction === d);
            if (!s || !s.entityCount) return (
              <div key={d} className="sit-sec empty" title={`${d} · 无目击`}>
                <span className="sit-sec-dir mono">{d}</span>
                <span className="sit-sec-dash" />
              </div>
            );
            const intensity = Math.max(0.05, Math.min(0.5, 0.05 + (s.score ?? 0) * 0.5));
            const dCls = distCls(s.nearestDistance);
            const tip = `${d} · 敌核 ${s.entityCount} · 最近 ${s.nearestDistance ?? "—"} 格 · 分数 ${(s.score ?? 0).toFixed(2)}${s.entityKeys.length ? "\n" + s.entityKeys.join(", ") : ""}`;
            return (
              <div key={d} data-sector={`${t}:${d}`} className={`sit-sec${dCls ? " " + dCls : ""} clickable`} style={{ background: `rgba(255,255,255,${intensity.toFixed(3)})` }} title={tip + " · 点击定位该方向最近敌情"} onClick={(e) => { e.stopPropagation(); onSector?.(t, s, m.core.position); }}>
                <span className="sit-sec-dir mono">{d}</span>
                <span className="sit-sec-n" style={{ fontSize: `${near(s.nearestDistance, 9.5).toFixed(1)}px` }}>{s.entityCount}</span>
                <span className="sit-sec-d mono">{s.nearestDistance ?? "—"}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function SituationPanel() {
  const engine = useEngine();
  const [data, setData] = useState<SnapshotData | null>(null);
  const [journal, setJournal] = useState<JournalData | null>(null);
  const [err, setErr] = useState("");
  const [at, setAt] = useState("");
  const [audit, setAudit] = useState<HumanAuditEntry[]>([]);

  const focusTenant = (t: string) => { if (!engine) return; engine.toggleSolo(t); }; // 完整聚焦：solo 态 + HUD/资产 + 徽章（再点退出，引擎自带返回提示）
  /** 扇区点击 → 定位该方向最近敌情：优先目击列表精确敌核坐标，回退方向+距离估点。 */
  const focusSector = (t: string, sec: Sector, corePos: number[] | undefined) => {
    if (!engine) return;
    const keys = sec.entityKeys ?? [];
    const sight = keys.length
      ? (data?.sightings ?? []).find((sg) => keys.includes(sg.ownerUsername) && Array.isArray(sg.position) && sg.position.length >= 2)
      : undefined;
    if (sight) {
      engine.jumpTo(sight.position[0], sight.position[1], `${t.toUpperCase()} ${sec.direction} 敌核「${sight.ownerUsername}」`);
      engine.toast(`定位 ${t.toUpperCase()} ${sec.direction} 方向敌核「${sight.ownerUsername}」`);
      return;
    }
    const dir = DIR_VEC[sec.direction] ?? [0, 0];
    const dist = sec.nearestDistance ?? 20;
    engine.jumpTo((corePos?.[0] ?? 0) + dir[0] * dist, (corePos?.[1] ?? 0) + dir[1] * dist, `${t.toUpperCase()} ${sec.direction} 最近敌情`);
    engine.toast(`${t.toUpperCase()} ${sec.direction} 方向最近敌情约 ${dist} 格（估算）`);
  };

  const jump = (x: number | null | undefined, y: number | null | undefined, label: string) => {
    if (typeof x !== "number" || typeof y !== "number" || !engine) return;
    engine.jumpTo(x, y, label);
    engine.toast(`定位 ${label}（${x}, ${y}）`);
  };

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const [s, j] = await Promise.all([
          fetch("/api/alliance/snapshot", { cache: "no-store" }),
          fetch("/api/deeds/journal", { cache: "no-store" }),
        ]);
        if (!s.ok) throw new Error("快照 HTTP " + s.status);
        const sd = (await s.json()) as SnapshotData;
        const jd = s.ok && j.ok ? (await j.json()) as JournalData : null;
        // 人类手操审计：独立拉取（失败不影响态势主数据）
        let ad: AuditPayload | null = null;
        try { const a = await fetch("/api/audit/human", { cache: "no-store" }); if (a.ok) ad = (await a.json()) as AuditPayload; } catch { /* 忽略 */ }
        if (!stop) { setData(sd); setJournal(jd); setAt(sd.generatedAt ?? sd.cachedAt ?? ""); setErr(""); setAudit(ad?.records ?? []); }
      } catch (e) { if (!stop) setErr(String((e as Error).message ?? e)); }
    };
    load();
    const timer = setInterval(load, 15000);
    return () => { stop = true; clearInterval(timer); };
  }, []);

  const members = data?.members ?? {};
  const sightings = [...(data?.sightings ?? [])].sort((a, b) => (b.lastSeenTick ?? 0) - (a.lastSeenTick ?? 0)).slice(0, 24);
  const counts = data?.counts;
  const summaries = data?.threatSummaries ?? [];
  const headline = journal?.headline;

  return (
    <div className="rp-pane">
      <div className="rp-pane-head">
        <div>
          <p className="dialog-eyebrow">ALLIANCE SITUATION · 实时态势</p>
          <h2>联盟态势</h2>
        </div>
        <button type="button" className="btn ghost rp-refresh" title="刷新态势快照" onClick={() => {
          setErr(""); setData(null);
          Promise.all([fetch("/api/alliance/snapshot", { cache: "no-store" }), fetch("/api/deeds/journal", { cache: "no-store" })])
            .then(async ([s, j]) => {
              if (!s.ok) throw new Error("HTTP " + s.status);
              const sd = (await s.json()) as SnapshotData;
              const jd = j.ok ? (await j.json()) as JournalData : null;
              setData(sd); setJournal(jd); setAt(sd.generatedAt ?? sd.cachedAt ?? "");
            })
            .catch((e) => setErr(String((e as Error).message ?? e)));
        }}>↻</button>
      </div>
      {at ? <span className="sit-gen dim">{at.replace("T", " ").slice(5, 16)} UTC · tick {fmt(data?.currentTick)} · 15s 刷新</span> : null}

      <div className="sit-global">
        {data?.treasuryTenant ? (
          <span className="sit-g-chip" title="联盟金库（当前资源最高租户）">
            <i className="sit-g-dot" style={{ background: TENANT_COLORS[data.treasuryTenant] ?? "#999" }} />
            金库 <b>{data.treasuryTenant.toUpperCase()}</b>
          </span>
        ) : null}
        <span className="sit-g-chip"><i className="sit-g-dot c-ok" />可见交战 <b>{fmt(counts?.currentVisibleCombat)}</b></span>
        <span className="sit-g-chip"><i className="sit-g-dot c-ok" />近期遭遇 <b>{fmt(counts?.recentUniqueCombat)}</b></span>
        <span className="sit-g-chip"><i className="sit-g-dot c-dim" />历史目击 <b>{fmt(counts?.historicalSightingCount)}</b></span>
        <span className="sit-g-chip"><i className="sit-g-dot c-dim" />估算兵力 <b>{fmt(counts?.estimatedForce)}</b></span>
      </div>

      {journal?.narrative || headline ? (
        <button type="button" className="sit-journal" onClick={() => headline?.position?.[0] != null && headline.position[1] != null && jump(headline.position[0], headline.position[1], "事迹: " + headline.title)} title={headline?.position ? "点击定位到该事迹位置" : "联盟最近事迹叙事"}>
          <span className="sit-j-star">★{headline?.star ?? "·"}</span>
          <span className="sit-j-body">
            {headline ? <><b>{headline.title}</b> · {headline.detail}</> : null}
            {journal?.narrative ? <em className="sit-j-narr">{journal.narrative}</em> : null}
          </span>
          <span className="sit-j-arrow">→</span>
        </button>
      ) : null}

      {err ? <div className="sv-empty">态势加载失败：{err}</div> : null}
      {!err && !data ? <div className="sv-empty">加载联盟态势…</div> : null}

      <div className="sit-members">
        {(["t1", "t2", "t3", "t4"] as const).map((t) => members[t] ? (
          <MemberCard key={t} t={t} m={members[t]} ts={summaries.find((x) => x.tenantId === t)} onFocus={focusTenant} onSector={focusSector} />
        ) : null)}
      </div>

      {sightings.length ? (
        <div className="sit-sight">
          <div className="sit-sight-head">
            <span className="eyebrow">ENEMY SIGHTINGS · 敌情目击</span>
            <span className="mono dim">{sightings.length}/{fmt(data?.sightings?.length)} 最新</span>
          </div>
          {sightings.map((s) => {
            const age = typeof data?.currentTick === "number" ? data.currentTick - (s.lastSeenTick ?? 0) : null;
            return (
              <button key={s.key} type="button" className="sit-sight-row" title={`${s.evidence ?? "目击"} · 首次 ${s.firstSeenTick} · 置信 ${Math.round((s.confidence ?? 0) * 100)}%`} onClick={() => jump(s.position?.[0], s.position?.[1], s.ownerUsername)}>
                <span className="sit-sight-kind">{KIND_CN[s.kind] ?? s.kind}</span>
                <b className="sit-sight-name">{s.ownerUsername}</b>
                {s.sourceTenant ? <i className="sit-sight-src dot" style={{ background: TENANT_COLORS[s.sourceTenant] ?? "#999" }} title={`由 ${s.sourceTenant.toUpperCase()} 目击`} /> : null}
                <span className={`sit-sight-vis${s.currentlyVisible ? " on" : ""}`}>{s.currentlyVisible ? "可见" : "记忆"}</span>
                <span className="sit-sight-pos mono dim">({fmt(s.position?.[0])},{fmt(s.position?.[1])})</span>
                <span className="sit-sight-age mono dim">{age !== null && age >= 0 ? `${age}t 前` : "—"}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="sit-sight">
        <div className="sit-sight-head">
          <span className="eyebrow">HUMAN AUDIT · 手操记录</span>
          <span className="mono dim">{audit.length ? audit.length + " 条" : ""}</span>
        </div>
        {audit.length ? (
          <ul className="sit-sight-list">
            {audit.slice(0, 20).map((a, i) => (
              <li key={i} className="sit-sight-row" title={a.note ?? ""}>
                <span className="mono dim">{new Date(a.at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                <span className="sit-sight-kind">{AUDIT_KIND_CN[a.kind] ?? a.kind}</span>
                <span className="sit-sight-src dot" style={{ background: TENANT_COLORS[a.tenant] ?? "#999" }} title={a.tenant.toUpperCase()} />
                <span className="sit-sight-name">{a.action ?? a.note ?? "—"}</span>
              </li>
            ))}
          </ul>
        ) : <div className="sv-empty dim">暂无手操——agent 全自动运行中</div>}
      </div>
    </div>
  );
}
