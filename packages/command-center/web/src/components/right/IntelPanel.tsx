import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { shopRequest } from "../../lib/shopApi";
import { TENANT_COLORS } from "@/engine/tactical";
import { SituationPanel } from "./SituationPanel";

const fmt = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.abs(n) >= 1000 ? n.toLocaleString("en-US") : String(n);
};
/** 快照年龄 → 人类可读（刚刚 / N 分钟前 / N 小时前）。 */
const ageText = (s?: number): string => {
  if (s === undefined || s === null || !Number.isFinite(s)) return "";
  if (s < 60) return "刚刚更新";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  return `${h} 小时前`;
};

interface EncounterEntry { tenant: string; lastSeenTick?: number | null; distanceToFriendlyCore?: number | null; raidRisk?: string | null }
interface LeaderboardRow { rank: number; username: string; score?: number; damage?: number; tier?: string; ours?: string | null; encountered?: EncounterEntry[] | null }
interface IntelData {
  profiles?: LeaderboardRow[];
  ours?: Array<{ tenant: string; username: string }>;
  encounteredCount?: number;
  encountered?: Record<string, EncounterEntry[]>;
  beacon_ticks_held?: LeaderboardRow[];
  core_destruction_participations?: LeaderboardRow[];
  snapshot?: string;
  generatedAt?: string;
  /** 快照文件 mtime（ISO）+ 动态年龄秒数 + 是否陈旧（服务端 leaderboard.ts 计算）。 */
  snapshotAt?: string;
  ageSeconds?: number;
  stale?: boolean;
}
const TIER_CN: Record<string, string> = { ELITE_AGGRESSOR: "精英攻坚", AGGRESSOR: "攻坚", STANDARD: "常规" };
const TIER_CLS: Record<string, string> = { ELITE_AGGRESSOR: "elite", AGGRESSOR: "agg", STANDARD: "std" };
type Filter = "all" | "ours" | "met";
/** 渲染行（rank 可缺省 = 榜外遭遇玩家，显示 "—"） */
type IntelRow = { rank?: number | null; username: string; score?: number; damage?: number; tag?: string };

function encounterTooltip(entries: EncounterEntry[]): string {
  return "遭遇详情：" + entries.map((e) => `${e.tenant.toUpperCase()} 目击 tick ${e.lastSeenTick ?? "—"} · 距我方核心 ${e.distanceToFriendlyCore ?? "—"} · 威胁 ${e.raidRisk ?? "—"}`).join("；");
}

/** 威胁情报面板（右栏卡片，替代原模态对话框）。2026-08-10 起为情报中心：
 *  内置「态势」tab（原联盟态势：租户现状/威胁扇区/敌情目击/经济测绘/行动清单），
 *  与排行榜三 tab（威胁/信标/核心）并排；右栏不再有独立的联盟态势 tab。 */
export function IntelPanel() {
  const [data, setData] = useState<IntelData | null>(null);
  const [tab, setTab] = useState("situation");
  const [filter, setFilter] = useState<Filter>("all");
  const [expand, setExpand] = useState(false);
  const [err, setErr] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  /** 拉取官方排行榜：POST /api/leaderboard/refresh（服务端异步 fetch 官方快照），
   *  完成后重读本地快照。无计划任务，纯请求驱动。 */
  const refreshOfficial = async () => {
    setErr("");
    setRefreshing(true);
    try {
      await shopRequest<{ ok?: boolean }>("/api/leaderboard/refresh", { method: "POST" });
      setData(await shopRequest<IntelData>("/api/leaderboard"));
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    setErr("");
    setData(null);
    setFilter("all");
    setExpand(false);
    shopRequest<IntelData>("/api/leaderboard").then(setData).catch((e) => setErr(String((e as Error).message ?? e)));
  }, []);

  const oursOf = (username: string): string | null => data?.ours?.find((o) => o.username === username)?.tenant ?? null;
  const encountersOf = (username: string): EncounterEntry[] | null => data?.encountered?.[username] ?? null;

  // 威胁 tab：默认前 30 + 榜外我方账号置顶（不展开也能看到自己）；展开后全量
  const allProfiles = data?.profiles ?? [];
  const visibleProfiles = expand ? allProfiles : allProfiles.slice(0, 30);
  const pinnedProfiles = expand ? [] : allProfiles.filter((p) => oursOf(p.username) !== null && !visibleProfiles.some((v) => v.username === p.username));
  const rawRows: IntelRow[] =
    tab === "beacon" ? (data?.beacon_ticks_held ?? [])
    : tab === "core" ? (data?.core_destruction_participations ?? [])
    : visibleProfiles;
  const pinned: IntelRow[] = tab === "threat" ? pinnedProfiles : [];
  const filtered = rawRows.filter((r) =>
    filter === "all" ? true
    : filter === "ours" ? oursOf(r.username) !== null
    : (encountersOf(r.username)?.length ?? 0) > 0);
  const filteredPinned = pinned.filter((r) =>
    filter === "all" ? true
    : filter === "ours" ? oursOf(r.username) !== null
    : (encountersOf(r.username)?.length ?? 0) > 0);

  const oursOnBoard = allProfiles.some((p) => oursOf(p.username) !== null) ? allProfiles.filter((p) => oursOf(p.username) !== null).length : 0;
  const metOnBoard = allProfiles.filter((p) => (encountersOf(p.username)?.length ?? 0) > 0).length;
  const encTotal = Object.keys(data?.encountered ?? {}).length;

  // 榜外遭遇玩家：遇到过但不在当前榜单中的，按最后目击 tick 倒序补充展示
  const boardNames = new Set(rawRows.map((r) => r.username));
  const offBoardMet: Array<{ username: string; entries: EncounterEntry[] }> = Object.entries(data?.encountered ?? {})
    .filter(([u]) => !boardNames.has(u))
    .map(([username, entries]) => ({ username, entries }))
    .sort((a, b) => (b.entries[0]?.lastSeenTick ?? 0) - (a.entries[0]?.lastSeenTick ?? 0));

  const renderRow = (r: IntelRow, keySuffix = "") => {
    const oursTenant = oursOf(r.username);
    const encounters = encountersOf(r.username);
    const cls = ["intel-row", oursTenant ? "ir-ours" : "", encounters?.length ? "ir-met" : "", typeof r.rank === "number" && r.rank <= 3 ? "ir-top" : ""].filter(Boolean).join(" ");
    return (
      <div className={cls} key={`${tab}-${r.rank ?? "off"}-${r.username}${keySuffix}`} title={encounters?.length ? encounterTooltip(encounters) : r.username}>
        <span className="ir-rank">{typeof r.rank === "number" ? `#${r.rank}` : "—"}</span>
        <span className="ir-name">{r.username}</span>
        {oursTenant ? (
          <span className="ir-badge ours" style={{ ["--rc" as string]: TENANT_COLORS[oursTenant] ?? "var(--accent)" }} title={`我方账号 · ${oursTenant.toUpperCase()}`}>
            <i className="ir-tdot" />我们 · {oursTenant.toUpperCase()}
          </span>
        ) : null}
        {encounters?.length ? (
          <span className="ir-badge met" title={encounterTooltip(encounters)}>
            <span className="ir-tenant-dots">{encounters.map((e) => <i key={e.tenant} className="dot" style={{ background: TENANT_COLORS[e.tenant] ?? "var(--text-dim)" }} />)}</span>
            遭遇
          </span>
        ) : null}
        {r.tag ? <span className={`ir-tag ${TIER_CLS[r.tag] ?? "std"}`}>{TIER_CN[r.tag] ?? r.tag}</span> : null}
        <span className="ir-score">{fmt(r.score ?? r.damage)}</span>
      </div>
    );
  };

  const emptyHint = filter === "ours" ? "我方账号不在该榜单中" : filter === "met" ? "还没有遭遇玩家上榜" : "暂无数据";

  return (
    <div id="intelDialog" className="intel-panel rp-pane" data-panel="intel">
      <div className="rp-pane-head">
        <div>
          <p className="dialog-eyebrow">{tab === "situation" ? "ALLIANCE SITUATION · 实时态势" : "THREAT INTEL · OFFICIAL LEADERBOARD"}</p>
          <h2>{tab === "situation" ? "联盟态势" : "威胁情报 · 排行榜"}</h2>
        </div>
        {tab === "situation" ? null : (
          <Button variant="ghost" size="icon-sm" className={`rp-refresh${refreshing ? " busy" : ""}`} title={refreshing ? "正在拉取官方排行榜…" : "立即拉取官方排行榜（POST /api/leaderboard/refresh）"} disabled={refreshing} onClick={refreshOfficial}><RotateCw className="rp-refresh-ico" /></Button>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => v && setTab(v)}>
        <TabsList id="intelTabs" className="intel-tabs h-auto p-0 gap-[6px] rounded-none bg-transparent">
          {([["situation", "态势"], ["threat", `威胁排行 ${data?.profiles?.length ?? 0}`], ["beacon", `信标持有 ${data?.beacon_ticks_held?.length ?? 0}`], ["core", `核心摧毁 ${data?.core_destruction_participations?.length ?? 0}`]] as Array<[string, string]>).map(([id, label]) => (
            <TabsTrigger key={id} data-intel-tab={id} value={id}
              className="px-[11px] py-[5px] text-[10.5px] font-mono rounded-full data-[state=active]:bg-transparent data-[state=active]:ring-0">{label}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {tab === "situation" ? (
        <SituationPanel embedded />
      ) : (
        <>
      <div className="intel-summary">
        <span className="is-chip"><i className="is-dot ours" />我方在榜 <b>{oursOnBoard}</b></span>
        <span className="is-chip" title={`榜单内 ${metOnBoard} · 榜外 ${Math.max(0, encTotal - metOnBoard)}`}><i className="is-dot met" />遭遇玩家 <b>{encTotal}</b></span>
        {tab === "threat" && allProfiles.length > 30 ? (
          <button type="button" className="chip-link" onClick={() => setExpand(!expand)}>{expand ? "收起（前 30）" : `展开全部 ${allProfiles.length}`}</button>
        ) : null}
      </div>
      <ToggleGroup type="single" value={filter} onValueChange={(v) => v && setFilter(v as Filter)} className="intel-filters" aria-label="排行榜过滤">
        {([["all", "全部"], ["ours", "我方"], ["met", "遭遇"]] as Array<[Filter, string]>).map(([id, label]) => (
          <ToggleGroupItem key={id} value={id}
            className="chip px-[12px] py-[4px] text-[10.5px] font-mono rounded-full border-[var(--border-strong)] data-[state=on]:bg-transparent data-[state=on]:ring-0">{label}</ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div id="intelBody" className="intel-body">
        {err ? <div className="stream-empty">威胁情报加载失败：{err}</div>
          : !data ? <div className="stream-empty">加载威胁情报…</div>
          : filtered.length === 0 && filteredPinned.length === 0 && (filter === "ours" || offBoardMet.length === 0) ? <div className="stream-empty">{emptyHint}</div>
          : <>
              {filtered.map((r) => renderRow(r))}
              {filteredPinned.length ? <div className="ir-pin-sep">我方账号（榜外置顶）</div> : null}
              {filteredPinned.map((r) => renderRow(r))}
              {filter !== "ours" && offBoardMet.length ? <div className="ir-pin-sep">遭遇玩家（榜外 · 不在排行榜）</div> : null}
              {filter !== "ours" && offBoardMet.map((o) => renderRow({ username: o.username }, `-off-${o.username}`))}
            </>}
      </div>
      <p id="intelMeta" className="dialog-note">
        {tab === "beacon" ? "信标累计持有 tick" : tab === "core" ? "核心摧毁参与次数" : "按造成伤害排名的玩家威胁画像"}
        {` · 快照 ${data?.snapshot ?? ""}${ageText(data?.ageSeconds) ? ` · ${ageText(data?.ageSeconds)}` : ""}`}
        {data?.stale ? <span className="ir-stale" title="官方排行榜约 15 分钟一档，快照已过期">已过期 · 点 ↻ 拉取最新</span> : null}
        {tab === "threat" && (encTotal > 0 || oursOnBoard > 0) ? ` · 我方 ${oursOnBoard} 个账号 · 遭遇 ${encTotal} 位玩家` : ""}
      </p>
        </>
      )}
    </div>
  );
}
