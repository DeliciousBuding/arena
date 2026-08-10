import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  shopCookieValue, saveShopCookie, shopRequest, loadRedeemHistory, pushRedeemHistory, clearRedeemHistory,
  type ShopProduct, type ShopMe,
} from "../../lib/shopApi";
import { RedeemCard } from "./RedeemCard";

const fmt = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.abs(n) >= 1000 ? n.toLocaleString("en-US") : String(n);
};

/** 官方商店兑换码面板（右栏卡片，替代原模态对话框）。 */
export function RedeemPanel() {
  const [cookie, setCookie] = useState(shopCookieValue());
  const [products, setProducts] = useState<ShopProduct[]>([]);
  const [account, setAccount] = useState<ShopMe | null>(null);
  const [accErr, setAccErr] = useState("");
  const [result, setResult] = useState<{ cls: string; msg: string } | null>(null);
  const [history, setHistory] = useState(loadRedeemHistory);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [priceNote, setPriceNote] = useState("");
  const prevPrices = useRef<Record<string, number | null | undefined> | null>(null);

  const refresh = useCallback(() => {
    setResult(null);
    setLoading(true);
    Promise.all([
      shopRequest<{ products?: ShopProduct[] }>("/api/shop"),
      shopCookieValue() ? shopRequest<ShopMe>("/api/shop/me").then((m) => { setAccount(m); setAccErr(""); }).catch((e) => { setAccount(null); setAccErr(String((e as Error).message ?? e)); }) : Promise.resolve(),
    ]).then(([shop]) => {
      const list = shop.products ?? [];
      setProducts(list);
      // 价格变动提示（官方价格动态变化）：仅首次加载不提示，之后刷新有变化才提示
      const next = Object.fromEntries(list.map((p) => [p.id, p.resource_cost]));
      const prev = prevPrices.current;
      if (prev) {
        const changed = list.filter((p) => prev[p.id] !== undefined && prev[p.id] !== p.resource_cost).length;
        if (changed > 0) setPriceNote(`商品价格已更新：${changed} 项（自动刷新）`);
      }
      prevPrices.current = next;
    }).catch((e) => setResult({ cls: "err", msg: `商品加载失败：${String((e as Error).message ?? e)}` })).finally(() => setLoading(false));
  }, []);

  // 面板每次激活（tab 切入）重新挂载 → 自动拉取最新价格与库存
  useEffect(() => { refresh(); }, [refresh]);

  const saveCookie = () => {
    const v = cookie.trim();
    if (!v) { setResult({ cls: "err", msg: "Cookie 不能为空" }); return; }
    saveShopCookie(v);
    setResult({ cls: "pending", msg: "Cookie 已保存（仅本机浏览器）。正在连接官方商店…" });
    shopRequest<ShopMe>("/api/shop/me").then((m) => { setAccount(m); setAccErr(""); setResult({ cls: "pending", msg: `已连接：@${m.username ?? "?"}` }); }).catch((e) => { setAccount(null); setAccErr(String((e as Error).message ?? e)); setResult({ cls: "err", msg: "连接失败" }); });
  };

  const redeem = async (p: ShopProduct) => {
    if (!shopCookieValue()) { setResult({ cls: "err", msg: "请先粘贴并保存官方商店 Cookie" }); return; }
    if (!window.confirm(`确认使用 ${p.resource_cost ?? "?"} 个 Core 资源兑换「${p.name ?? ""}」？

库存与资源同时满足时才扣款。`)) return;
    setBusyId(p.id);
    setResult({ cls: "pending", msg: "正在提交兑换…" });
    try {
      const data = await shopRequest<{ status?: string }>("/api/shop/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product_id: p.id }) });
      const status = data.status ?? "PENDING";
      setResult(status === "COMPLETED" ? { cls: "ok", msg: `兑换成功！订单状态：${status}` } : { cls: "pending", msg: `订单已提交（${status}），正在确认扣款，可在账户页查看进度。` });
      setHistory(pushRedeemHistory({ at: new Date().toISOString(), code: p.name ?? p.id, status }));
      setTimeout(refresh, 1200); // 提交后刷新库存与账户资源
    } catch (e) {
      setResult({ cls: "err", msg: `兑换失败：${String((e as Error).message ?? e)}` });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div id="redeemDialog" className="intel-panel rp-pane" data-panel="redeem">
      <div className="rp-pane-head">
        <div>
          <p className="dialog-eyebrow">OFFICIAL STORE · LINUXDO</p>
          <h2>官方商店 · 兑换码</h2>
        </div>
        <Button variant="ghost" size="icon-sm" className={`rp-refresh${loading ? " busy" : ""}`} title="刷新价格与库存" onClick={refresh} disabled={loading}><RotateCw className="rp-refresh-ico" /></Button>
      </div>

      <div className="shop-cookie-row">
        <input id="shopCookie" className="input" type="password" placeholder="官方商店登录 Cookie（linuxdoshop.arenahero.io）" autoComplete="off" spellCheck={false} value={cookie} onChange={(e) => setCookie(e.target.value)} />
        <Button id="cookieSave" variant="default" size="sm" onClick={saveCookie}>保存</Button>
      </div>
      <div id="shopAccount" className="shop-account" hidden={!account && !accErr}>
        {account ? <span className="acc-name">@{account.username ?? "?"} · 资源 <b>{fmt(account.resources)}</b></span> : <span className="acc-err">连接失败：{accErr}（Cookie 可能已失效）</span>}
      </div>

      {priceNote ? <div id="priceNote" className="redeem-result pending">{priceNote}</div> : null}
      <div id="shopList" className="shop-list">
        {loading ? <div className="stream-empty">加载官方商品…</div>
          : !products.length ? <div className="stream-empty">官方商店暂无商品</div>
          : products.map((p) => <RedeemCard key={p.id} product={p} busy={busyId === p.id} onRedeem={redeem} />)}
      </div>

      {result && <div id="redeemResult" className={`redeem-result ${result.cls}`}>{result.msg}</div>}

      <div className="dialog-history">
        <h3>我的兑换订单
          {history.length > 0 && (
            <Button variant="ghost" size="sm" className="dh-clear" title="清空本地兑换记录" onClick={() => { clearRedeemHistory(); setHistory([]); }}>清空</Button>
          )}
        </h3>
        <ul id="redeemHistory">
          {history.length ? history.map((h) => (
            <li key={h.at}>
              <span className="h-time">{new Date(h.at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
              <span>{h.code}</span>
              <span className="h-status">{h.status}</span>
            </li>
          )) : <li className="dh-empty">暂无本地记录</li>}
        </ul>
      </div>
      <p className="dialog-note">价格与库存来自官方商店（动态变化），可手动刷新。Cookie 仅保存在本机浏览器，请求时经内存转发，不落盘服务器。</p>
    </div>
  );
}
