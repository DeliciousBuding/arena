import type { ShopProduct } from "../../lib/shopApi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const fmt = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.abs(n) >= 1000 ? n.toLocaleString("en-US") : String(n);
};

export type StockBadge = { cls: "out" | "low" | "ok"; label: string };

/** 库存徽章语义：缺货 / 仅剩少量（警告）/ 正常在库。 */
export function stockBadgeOf(p: ShopProduct): StockBadge | null {
  if (p.out_of_stock) return { cls: "out", label: "缺货" };
  const stock = p.available_stock;
  if (stock === null || stock === undefined) return null;
  if (stock <= 0) return { cls: "out", label: "缺货" };
  if (stock <= 5) return { cls: "low", label: `仅剩 ${stock}` };
  return { cls: "ok", label: `库存 ${fmt(stock)}` };
}

export interface RedeemCardProps {
  product: ShopProduct;
  busy: boolean;
  onRedeem(product: ShopProduct): void;
}

/** 官方商店商品卡片：名称 + 价格 + 库存/限购徽章 + 兑换按钮。 */
export function RedeemCard({ product, busy, onRedeem }: RedeemCardProps) {
  const badge = stockBadgeOf(product);
  const soldOut = badge !== null && badge.cls === "out";
  const limit = product.purchase_limit;
  return (
    <div className={`shop-item${soldOut ? " sold-out" : ""}`} data-product-id={product.id}>
      <div className="si-main">
        <span className="si-name">{product.name ?? "未命名商品"}</span>
        <div className="si-meta">
          <span className="cost">{(product.resource_cost ?? "?") + " Core"}</span>
          {badge ? <Badge variant={badge.cls === "out" ? "danger" : badge.cls === "low" ? "warn" : "success"} size="sm" className="stock">{badge.label}</Badge> : null}
          {limit !== null && limit !== undefined ? <span className="limit">限购 {limit}/人</span> : null}
        </div>
      </div>
      <Button variant="primary" size="sm" className="si-btn" disabled={soldOut || busy} onClick={() => onRedeem(product)}>
        {busy ? "…" : "兑换"}
      </Button>
    </div>
  );
}
