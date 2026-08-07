import { useEffect, useRef, useState } from "react";

const fmt = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.abs(n) >= 1000 ? n.toLocaleString("en-US") : String(n);
};
const SHOP_COOKIE_KEY = "arena-cc.shop-cookie";
function shopCookieValue(): string { return (localStorage.getItem(SHOP_COOKIE_KEY) ?? "").trim(); }

async function shopRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers ?? {});
  const cookie = shopCookieValue();
  if (cookie) headers.set("X-Shop-Cookie", cookie);
  const res = await fetch(path, { ...options, headers, cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data as { error?: string; message?: string }).error ?? (data as { message?: string }).message ?? `HTTP ${res.status}`);
    throw err;
  }
  return data as T;
}

/* ---------------- 威胁情报 ---------------- */
const TENANT_COLORS: Record<string, string> = { t1: "#69b3d8", t2: "#57bd84", t3: "#a892d6", t4: "#dd626d" };

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
}
const TIER_CN: Record<string, string> = { ELITE_AGGRESSOR: "精英攻坚", AGGRESSOR: "攻坚", STANDARD: "常规" };
const TIER_CLS: Record<string, string> = { ELITE_AGGRESSOR: "elite", AGGRESSOR: "agg", STANDARD: "std" };
type Filter = "all" | "ours" | "met";
/** 渲染行（rank 可缺省 = 榜外遭遇玩家，显示 "—"） */
type IntelRow = { rank?: number | null; username: string; score?: number; damage?: number; tag?: string };

function encounterTooltip(entries: EncounterEntry[]): string {
  return "遭遇详情：" + entries.map((e) => `${e.tenant.toUpperCase()} 目击 tick ${e.lastSeenTick ?? "—"} · 距我方核心 ${e.distanceToFriendlyCore ?? "—"} · 威胁 ${e.raidRisk ?? "—"}`).join("；");
}

export function IntelDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<IntelData | null>(null);
  const [tab, setTab] = useState("threat");
  const [filter, setFilter] = useState<Filter>("all");
  const [expand, setExpand] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setErr("");
    setData(null);
    setFilter("all");
    setExpand(false);
    shopRequest<IntelData>("/api/leaderboard").then(setData).catch((e) => setErr(String((e as Error).message ?? e)));
  }, [open]);

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
  // （"遇到过的玩家"完整覆盖——不在榜上的照样能看到遭遇详情）
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
          <span className="ir-badge ours" style={{ ["--rc" as string]: TENANT_COLORS[oursTenant] ?? "#fff" }} title={`我方账号 · ${oursTenant.toUpperCase()}`}>
            <i className="ir-tdot" />我们 · {oursTenant.toUpperCase()}
          </span>
        ) : null}
        {encounters?.length ? (
          <span className="ir-badge met" title={encounterTooltip(encounters)}>
            <span className="ir-tenant-dots">{encounters.map((e) => <i key={e.tenant} className="dot" style={{ background: TENANT_COLORS[e.tenant] ?? "#999" }} />)}</span>
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
    <dialog ref={ref} id="intelDialog" className="shop-dialog intel-dialog" onClose={onClose}>
      <div id="intelForm">
        <div className="dialog-head">
          <div className="dh-text">
            <p className="dialog-eyebrow">THREAT INTEL · OFFICIAL LEADERBOARD</p>
            <h2>威胁情报 · 排行榜</h2>
          </div>
          <button type="button" id="intelClose" className="btn ghost" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        <div id="intelTabs" className="intel-tabs" role="tablist">
          {([["threat", `威胁排行 ${data?.profiles?.length ?? 0}`], ["beacon", `信标持有 ${data?.beacon_ticks_held?.length ?? 0}`], ["core", `核心摧毁 ${data?.core_destruction_participations?.length ?? 0}`]] as Array<[string, string]>).map(([id, label]) => (
            <button key={id} data-intel-tab={id} className={tab === id ? "active" : ""} type="button" onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div className="intel-summary">
          <span className="is-chip"><i className="is-dot ours" />我方在榜 <b>{oursOnBoard}</b></span>
          <span className="is-chip" title={`榜单内 ${metOnBoard} · 榜外 ${Math.max(0, encTotal - metOnBoard)}`}><i className="is-dot met" />遭遇玩家 <b>{encTotal}</b></span>
          {tab === "threat" && allProfiles.length > 30 ? (
            <button type="button" className="chip-link" onClick={() => setExpand(!expand)}>{expand ? "收起（前 30）" : `展开全部 ${allProfiles.length}`}</button>
          ) : null}
        </div>
        <div className="intel-filters" role="group" aria-label="排行榜过滤">
          {([["all", "全部"], ["ours", "我方"], ["met", "遭遇"]] as Array<[Filter, string]>).map(([id, label]) => (
            <button key={id} type="button" className={`chip${filter === id ? " active" : ""}`} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
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
          {` · 快照 ${data?.snapshot ?? ""}`}
          {tab === "threat" && (encTotal > 0 || oursOnBoard > 0) ? ` · 我方 ${oursOnBoard} 个账号 · 遭遇 ${encTotal} 位玩家` : ""}
        </p>
      </div>
    </dialog>
  );
}

/* ---------------- 兑换码（官方商店） ---------------- */
interface ShopProduct { id: string; name?: string; resource_cost?: number; out_of_stock?: boolean }
interface ShopMe { username?: string; resources?: number }
interface ShopOrder { id?: string; product_name?: string; status?: string; created_at?: string }

export function RedeemDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [cookie, setCookie] = useState(shopCookieValue());
  const [products, setProducts] = useState<ShopProduct[]>([]);
  const [account, setAccount] = useState<ShopMe | null>(null);
  const [accErr, setAccErr] = useState("");
  const [result, setResult] = useState<{ cls: string; msg: string } | null>(null);
  const [history, setHistory] = useState<Array<{ at: string; code: string; status: string }>>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setLoading(true);
    Promise.all([
      shopRequest<{ products?: ShopProduct[] }>("/api/shop"),
      shopCookieValue() ? shopRequest<ShopMe>("/api/shop/me").then((m) => { setAccount(m); setAccErr(""); }).catch((e) => { setAccount(null); setAccErr(String((e as Error).message ?? e)); }) : Promise.resolve(),
    ]).then(([shop]) => setProducts(shop.products ?? [])).catch((e) => setResult({ cls: "err", msg: `商品加载失败：${String((e as Error).message ?? e)}` })).finally(() => setLoading(false));
    const list = JSON.parse(localStorage.getItem("arena-cc.redeem-history") ?? "[]");
    setHistory(Array.isArray(list) ? list : []);
  }, [open]);

  const saveCookie = () => {
    const v = cookie.trim();
    if (!v) { setResult({ cls: "err", msg: "Cookie 不能为空" }); return; }
    localStorage.setItem(SHOP_COOKIE_KEY, v);
    setResult({ cls: "pending", msg: "Cookie 已保存（仅本机浏览器）。正在连接官方商店…" });
    shopRequest<ShopMe>("/api/shop/me").then((m) => { setAccount(m); setAccErr(""); setResult({ cls: "pending", msg: `已连接：@${m.username ?? "?"}` }); }).catch((e) => { setAccount(null); setAccErr(String((e as Error).message ?? e)); setResult({ cls: "err", msg: "连接失败" }); });
  };

  const redeem = async (p: ShopProduct) => {
    if (!shopCookieValue()) { setResult({ cls: "err", msg: "请先粘贴并保存官方商店 Cookie" }); return; }
    if (!window.confirm(`确认使用 ${p.resource_cost ?? "?"} 个 Core 资源兑换「${p.name ?? ""}」？

库存与资源同时满足时才扣款。`)) return;
    setResult({ cls: "pending", msg: "正在提交兑换…" });
    try {
      const data = await shopRequest<{ status?: string }>("/api/shop/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product_id: p.id }) });
      const status = data.status ?? "PENDING";
      setResult(status === "COMPLETED" ? { cls: "ok", msg: `兑换成功！订单状态：${status}` } : { cls: "pending", msg: `订单已提交（${status}），正在确认扣款，可在账户页查看进度。` });
      const list = JSON.parse(localStorage.getItem("arena-cc.redeem-history") ?? "[]");
      list.unshift({ at: new Date().toISOString(), code: p.name ?? p.id, status });
      localStorage.setItem("arena-cc.redeem-history", JSON.stringify(list.slice(0, 20)));
      setHistory(list.slice(0, 20));
    } catch (e) {
      setResult({ cls: "err", msg: `兑换失败：${String((e as Error).message ?? e)}` });
    }
  };

  return (
    <dialog ref={ref} id="redeemDialog" className="shop-dialog" onClose={onClose}>
      <div id="redeemForm">
        <div className="dialog-head">
          <div className="dh-text">
            <p className="dialog-eyebrow">OFFICIAL STORE · LINUXDO</p>
            <h2>官方商店 · 兑换码</h2>
          </div>
          <button type="button" id="redeemClose" className="btn ghost" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        <div className="shop-cookie-row">
          <input id="shopCookie" className="input" type="password" placeholder="粘贴官方商店登录 Cookie（linuxdoshop.arenahero.io）" autoComplete="off" spellCheck={false} value={cookie} onChange={(e) => setCookie(e.target.value)} />
          <button type="button" id="cookieSave" className="btn" onClick={saveCookie}>保存</button>
        </div>
        <div id="shopAccount" className="shop-account" hidden={!account && !accErr}>
          {account ? <span className="acc-name">@{account.username ?? "?"} · 资源 {fmt(account.resources)}</span> : <span className="acc-err">连接失败：{accErr}（Cookie 可能已失效）</span>}
        </div>
        <div id="shopList" className="shop-list">
          {loading ? <div className="stream-empty">加载官方商品…</div>
            : !products.length ? <div className="stream-empty">官方商店暂无商品</div>
            : products.map((p) => (
              <div className="shop-item" key={p.id}>
                <span className="si-name">{p.name ?? "未命名商品"}</span>
                <span className="si-desc">{p.out_of_stock ? "缺货" : `${p.resource_cost ?? "?"} Core`}</span>
                <button type="button" className="btn primary si-btn" disabled={!!p.out_of_stock} onClick={() => redeem(p)}>兑换</button>
              </div>
            ))}
        </div>
        {result && <div id="redeemResult" className={`redeem-result ${result.cls}`}>{result.msg}</div>}
        <div className="dialog-history">
          <h3>我的兑换订单</h3>
          <ul id="redeemHistory">{history.length ? history.map((h) => <li key={h.at}><span className="h-time">{new Date(h.at).toLocaleTimeString("zh-CN", { hour12: false })}</span><span>{h.code}</span><span className="h-status">{h.status}</span></li>) : <li style={{ color: "#56626c" }}>暂无本地记录</li>}</ul>
        </div>
        <p className="dialog-note">价格与库存来自官方商店（动态变化）。Cookie 仅保存在本机浏览器，请求时经内存转发，不落盘服务器。</p>
      </div>
    </dialog>
  );
}
