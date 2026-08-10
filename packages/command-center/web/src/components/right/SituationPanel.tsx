/**
 * 联盟态势面板（2026-08-08，右栏 tab）：/api/alliance/snapshot 全量态势——
 * 4 租户实时资源/兵力/核心状态 + 每租户 8 方向威胁扇区（敌核邻近度）+ 敌情目击清单
 * + /api/deeds/journal 事迹叙事。纯只读，15s 轮询；点击目击/事迹可跳转大地图定位。
 * 2026-08-10 并入原「测绘」面板（/api/survey 经济测绘：矿带/采集/消费）与原「参谋建议」
 * 面板（/api/alliance/advice + /api/alliance/director 行动清单），右栏不再独立成 tab。
 */
import { useCallback, useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEngine } from "../../lib/bridge";
import { TENANT_COLORS } from "@/engine/tactical";

const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const DIR_VEC: Record<string, [number, number]> = { N: [0, -1], NE: [1, -1], E: [1, 0], SE: [1, 1], S: [0, 1], SW: [-1, 1], W: [-1, 0], NW: [-1, -1] };
const KIND_CN: Record<string, string> = { CORE: "敌核", UNIT: "单位", WORKER: "工", VANGUARD: "锋", RANGER: "射" };
const SV_TYPE_CN: Record<string, string> = { WORKER: "工", VANGUARD: "锋", RANGER: "射" };
const SV_SPEND_CN: Record<string, string> = { spawn: "产兵", core_heal: "核心治疗", repair: "修复", unit_heal: "单位治疗" };

// ===== 经济测绘（原 SurveyPanel 数据契约，2026-08-10 并入）=====
interface SpendRow { kind?: string; count?: number; total?: number }
interface Lifecycle { units?: Array<{ state?: string; type?: string; count?: number }>; spends?: SpendRow[]; harvestCount?: number; harvestFailCount?: number }
interface SurveyData {
  resources?: Array<Record<string, unknown>>;
  obstacles?: Array<Record<string, unknown>>;
  coreHunts?: Array<Record<string, unknown>>;
  chunks?: Array<Record<string, unknown>>;
  lifecycle?: Lifecycle | null;
  spendsTrend?: SpendRow[];
}
interface SurveyResp { tenants?: Record<string, SurveyData>; generatedAt?: string }

// ===== 行动清单（原 AdvicePanel 数据契约，2026-08-10 并入）=====
interface Advice { severity: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO"; category: "ECONOMY" | "MILITARY" | "THREAT" | "CONFLICT" | "INTEL"; tenant: string | null; title: string; detail: string; action: string; weight: number; confidence?: number; evidence?: { type?: string; tenant?: string; ref?: string } | string; at: string }
interface AdvicePayload { generatedAt?: string; advice?: Advice[]; summary?: { critical: number; high: number; medium: number; info: number } }
interface DirectorPayload {
  available?: boolean; enabled?: boolean; mode?: string; actionOwnership?: string; revision?: number; tick?: number | null;
  frameTenants?: string[];
  runtime?: { directiveSentCount?: number; ackCount?: number; directorErrorCount?: number; invalidOutputCount?: number; sendErrorCount?: number };
  policy?: { treasuryTenant?: string; missions?: Array<{ id?: string; kind?: string; defendTenant?: string; scope?: string }>; taskForces?: Array<{ id?: string; missionId?: string; commanderTenant?: string; fleetRefs?: Array<{ tenantId?: string; fleetId?: string }> }> } | null;
}
const SEV_CN: Record<string, string> = { CRITICAL: "危急", HIGH: "高", MEDIUM: "中", INFO: "提示" };
const CAT_CN: Record<string, string> = { ECONOMY: "经济", MILITARY: "军事", THREAT: "威胁", CONFLICT: "冲突", INTEL: "情报" };
const EVIDENCE_TYPE_CN: Record<string, string> = { world: "世界态", heat: "敌情热区", intel: "情报", economy: "经济", survey: "测绘" };
/** 证据链摘要：后端 /api/alliance/advice 的 evidence 对象 → 一行人类可读来源。 */
const fmtEvidence = (ev: Advice["evidence"]): string => {
  if (!ev) return "";
  if (typeof ev === "string") return ev;
  const parts: string[] = [];
  if (ev.type) parts.push(EVIDENCE_TYPE_CN[ev.type] ?? ev.type);
  if (ev.tenant) parts.push(ev.tenant.toUpperCase());
  if (ev.ref) parts.push(ev.ref);
  return parts.join(" · ");
};

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
        <span className="sit-chip" style={{ background: TENANT_COLORS[t] ?? "var(--text-dim)" }} />
        <b>{t.toUpperCase()}</b>
        <span className={`sit-status${m.status === "READY" ? " ok" : ""}`}>{m.status ?? "—"}</span>
        <span className="sit-m-pos mono dim">({fmt(m.core.position?.[0])},{fmt(m.core.position?.[1])})</span>
        <Button variant="ghost" size="sm" className="sit-focus" title={`地图聚焦 ${t.toUpperCase()} 核心`} onClick={(e) => { e.stopPropagation(); onFocus?.(t); }}>聚焦</Button>
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

/** 经济测绘行（原 SurveyPanel 的租户卡瘦身为单行，2026-08-10 并入）：矿带/障碍/敌核/探索
 *  分区 + 存活单位构成 + 采集/消费 + 消费构成条；完整细节在 hover title。 */
function SurveyRow({ t, d }: { t: string; d: SurveyData }) {
  const lc = d.lifecycle;
  const alive = (lc?.units ?? []).filter((u) => u.state === "alive").reduce((s, u) => s + (u.count ?? 0), 0);
  const unitLabel = ["WORKER", "VANGUARD", "RANGER"].map((ty) => {
    const c = (lc?.units ?? []).find((u) => u.state === "alive" && u.type === ty)?.count ?? 0;
    return c ? `${c}${SV_TYPE_CN[ty] ?? ty}` : "";
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
  const tip = [
    `矿带 ${fmt(d.resources?.length)} · 障碍 ${fmt(d.obstacles?.length)} · 敌核 ${fmt(d.coreHunts?.length)} · 探索分区 ${fmt(d.chunks?.length)}`,
    `采集 ${fmt(lc?.harvestCount)}${lc?.harvestFailCount ? ` · 失败 ${lc.harvestFailCount}` : ""}`,
    Object.entries(trend).map(([k, v]) => `${SV_SPEND_CN[k] ?? k} ${fmt(v)}`).join(" · "),
  ].filter(Boolean).join("\n");
  return (
    <div className="sit-sv" data-tenant={t} title={tip}>
      <span className="sv-chip" style={{ background: TENANT_COLORS[t] ?? "var(--text-dim)" }} />
      <b className="sit-sv-name">{t.toUpperCase()}</b>
      <span className="sit-sv-line mono dim">矿 {fmt(d.resources?.length)} · 障碍 {fmt(d.obstacles?.length)} · 敌核 {fmt(d.coreHunts?.length)} · 探索 {fmt(d.chunks?.length)}</span>
      {lc ? (
        <span className="sit-sv-econ">
          <b>{fmt(alive)}{unitLabel ? ` · ${unitLabel}` : ""}</b>
          <span className="dim">采集 {fmt(lc.harvestCount)} · 消费 {fmt(spendTotal)}</span>
        </span>
      ) : <span className="sit-sv-econ dim">—</span>}
      {spendBar.length ? (
        <span className="sv-bar sit-sv-bar">
          {spendBar.map((x) => (
            <i key={x.kind} className="sv-bar-seg" style={{ width: `${x.pct}%`, background: x.kind === "spawn" ? "var(--green-resource)" : x.kind === "repair" ? "var(--cyan-signal)" : "var(--warn)" }} title={`${SV_SPEND_CN[x.kind] ?? x.kind} ${x.total}`} />
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** 行动清单（原 AdvicePanel 并入，2026-08-10）：危急/高/中/提示胶囊 + 可执行建议列表；
 *  Director 自动指挥状态压成一行摘要，内部字段（rev/ACK/模式/帧租户）收进 hover title。 */
function AdviceSection({ payload, director }: { payload: AdvicePayload | null; director: DirectorPayload | null }) {
  const advices = payload?.advice ?? [];
  const summary = payload?.summary;
  const dirOnline = !!director?.available && !!director?.enabled;
  const dirTip = [
    `模式 ${director?.mode ?? "ASSIST_ONLY"}`,
    `rev ${director?.revision ?? "—"} · 回合 ${director?.tick ?? "—"}`,
    `指令确认 ${director?.runtime?.ackCount ?? 0}/${director?.runtime?.directiveSentCount ?? 0}`,
    director?.frameTenants?.length ? `帧租户 ${director.frameTenants.join("/")}` : "",
    director?.policy?.treasuryTenant ? `金库 ${director.policy.treasuryTenant.toUpperCase()}` : "",
  ].filter(Boolean).join(" · ");
  return (
    <div className="sit-block">
      <div className="sit-sight-head">
        <span className="eyebrow">ACTION LIST · 行动清单</span>
        <span className="mono dim">{advices.length ? advices.length + " 条" : ""}</span>
      </div>
      {director ? (
        <div className="sv-summary sit-dir-row">
          <span className={`adv-sum ${dirOnline ? "adv-info" : "adv-medium"}`} title={dirTip}>{dirOnline ? "自动指挥在线" : "自动指挥待命"}</span>
          {director.policy?.missions?.length ? <span className="adv-sum" title={director.policy.missions.slice(0, 6).map((m) => `${m.defendTenant ?? m.scope ?? "全部"}:${m.kind ?? "?"}`).join(" · ")}>中央任务 {director.policy.missions.length}</span> : null}
          {director.policy?.taskForces?.length ? <span className="adv-sum">联合队 {director.policy.taskForces.length}</span> : null}
        </div>
      ) : null}
      {summary ? (
        <div className="sv-summary">
          {(["CRITICAL", "HIGH", "MEDIUM", "INFO"] as const).map((k) => (
            <span key={k} className={`adv-sum adv-${k.toLowerCase()}`}>{SEV_CN[k]} {summary[k.toLowerCase() as keyof typeof summary] ?? 0}</span>
          ))}
        </div>
      ) : null}
      {advices.length === 0 ? (
        <div className="sv-empty">暂无待办行动——联盟运行平稳</div>
      ) : (
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

/** 联盟态势（2026-08-10 起作为威胁情报的内部「态势」tab 渲染，非独立右栏 tab）。
 *  embedded 模式：不渲染自身头部（情报中心已有），根容器去面板壳/动画。 */
export function SituationPanel({ embedded }: { embedded?: boolean }) {
  const engine = useEngine();
  const [data, setData] = useState<SnapshotData | null>(null);
  const [journal, setJournal] = useState<JournalData | null>(null);
  const [err, setErr] = useState("");
  const [at, setAt] = useState("");
  const [audit, setAudit] = useState<HumanAuditEntry[]>([]);
  const [survey, setSurvey] = useState<SurveyResp | null>(null);
  const [advice, setAdvice] = useState<AdvicePayload | null>(null);
  const [director, setDirector] = useState<DirectorPayload | null>(null);

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

  /** 全量拉取：态势主数据（失败显示错误）+ 测绘/行动清单/审计（失败静默，不影响主数据）。 */
  const load = useCallback(async () => {
    try {
      const [s, j] = await Promise.all([
        fetch("/api/alliance/snapshot", { cache: "no-store" }),
        fetch("/api/deeds/journal", { cache: "no-store" }),
      ]);
      if (!s.ok) throw new Error("快照 HTTP " + s.status);
      const sd = (await s.json()) as SnapshotData;
      const jd = j.ok ? (await j.json()) as JournalData : null;
      setData(sd); setJournal(jd); setAt(sd.generatedAt ?? sd.cachedAt ?? ""); setErr("");
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
    const grab = async (url: string): Promise<unknown | null> => {
      try { const r = await fetch(url, { cache: "no-store" }); return r.ok ? (await r.json()) : null; } catch { return null; }
    };
    const [sv, av, dd, ad] = await Promise.all([
      grab("/api/survey?tenant=all"),
      grab("/api/alliance/advice"),
      grab("/api/alliance/director"),
      grab("/api/audit/human"),
    ]);
    setSurvey(sv as SurveyResp | null);
    setAdvice(av as AdvicePayload | null);
    setDirector(dd as DirectorPayload | null);
    if (ad) setAudit(((ad as AuditPayload).records ?? []) as HumanAuditEntry[]);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  const members = data?.members ?? {};
  const sightings = [...(data?.sightings ?? [])].sort((a, b) => (b.lastSeenTick ?? 0) - (a.lastSeenTick ?? 0)).slice(0, 24);
  const counts = data?.counts;
  const summaries = data?.threatSummaries ?? [];
  const headline = journal?.headline;

  return (
    <div className={embedded ? "sit-embedded" : "rp-pane"}>
      {!embedded ? (
        <div className="rp-pane-head">
          <div>
            <p className="dialog-eyebrow">ALLIANCE SITUATION · 实时态势</p>
            <h2>联盟态势</h2>
          </div>
          <Button variant="ghost" size="icon-sm" className="rp-refresh" title="刷新态势快照" onClick={() => { setErr(""); setData(null); load(); }}><RotateCw className="rp-refresh-ico" /></Button>
        </div>
      ) : null}
      {at ? <span className="sit-gen dim">{at.replace("T", " ").slice(5, 16)} UTC · 回合 {fmt(data?.currentTick)} · 15s 刷新</span> : null}

      <div className="sit-global">
        {data?.treasuryTenant ? (
          <span className="sit-g-chip" title="联盟金库（当前资源最高租户）">
            <i className="sit-g-dot" style={{ background: TENANT_COLORS[data.treasuryTenant] ?? "var(--text-dim)" }} />
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
                {s.sourceTenant ? <i className="sit-sight-src dot" style={{ background: TENANT_COLORS[s.sourceTenant] ?? "var(--text-dim)" }} title={`由 ${s.sourceTenant.toUpperCase()} 目击`} /> : null}
                <span className={`sit-sight-vis${s.currentlyVisible ? " on" : ""}`}>{s.currentlyVisible ? "可见" : "记忆"}</span>
                <span className="sit-sight-pos mono dim">({fmt(s.position?.[0])},{fmt(s.position?.[1])})</span>
                <span className="sit-sight-age mono dim">{age !== null && age >= 0 ? `${age} 回合前` : "—"}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="sit-block">
        <div className="sit-sight-head">
          <span className="eyebrow">ECONOMY SURVEY · 经济测绘</span>
          <span className="mono dim">{Object.keys(survey?.tenants ?? {}).length} 租户</span>
        </div>
        {survey ? (
          <div className="sit-sv-list">
            {(["t1", "t2", "t3", "t4"] as const).map((t) => survey.tenants?.[t] ? <SurveyRow key={t} t={t} d={survey.tenants[t]} /> : null)}
          </div>
        ) : <div className="sv-empty">加载经济测绘…</div>}
      </div>

      <AdviceSection payload={advice} director={director} />

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
                <span className="sit-sight-src dot" style={{ background: TENANT_COLORS[a.tenant] ?? "var(--text-dim)" }} title={a.tenant.toUpperCase()} />
                <span className="sit-sight-name">{a.action ?? a.note ?? "—"}</span>
              </li>
            ))}
          </ul>
        ) : <div className="sv-empty dim">暂无手动操作——智能体全自动运行中</div>}
      </div>
    </div>
  );
}
