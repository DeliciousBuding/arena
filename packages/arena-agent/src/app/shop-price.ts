/**
 * 商店兑换价快照（2026-08-10，shop-price-intel 数据源接入）：
 * 读取协调仓 `data/shop/` 下的商店商品快照（由
 * docs/progress/shop-price-intel.py 拉取 linuxdoshop.arenahero.io/api/v1/products），
 * 取全店最高可兑换商品价作为资源高水位基准——用户裁决"资源池以商店价格为标准
 * 维护"：当前黑与白公益站注册码 = 150（2026-08-10 实测，全店最贵），攒够即可
 * 兑换顶级商品，超出部分花掉造单位。
 *
 * 纯只读 + 降级设计：快照缺失/解析失败返回 null（调用方用默认 150，历史行为
 * 零回归）；运行时绝不联网（拉取是外部计划任务职责，live loop 保持确定性，
 * 与 official-intel/leaderboard 同架构纪律）。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 商店商品行（linuxdoshop.arenahero.io/api/v1/products 返回形状，只取决策所需）。 */
export interface ShopProductRow {
  readonly name: string;
  readonly resource_cost: number;
}

/** 商店商品快照（全店商品列表，供审计；派生值由读取端计算）。 */
export interface ShopPriceSnapshot {
  readonly ts?: string;
  readonly products: readonly ShopProductRow[];
}

/** 读取最新商店快照（按文件名时间降序取 shop-price-*.json）；目录缺失/
 *  无快照/解析失败返回 null（降级 = 无商店情报，调用方用默认高水位）。 */
export function loadLatestShopSnapshot(shopRoot: string): ShopPriceSnapshot | null {
  try {
    if (!statSync(shopRoot, { throwIfNoEntry: false })?.isDirectory()) return null;
    const files = readdirSync(shopRoot)
      .filter((name) => /^shop-price-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(name))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const parsed: unknown = JSON.parse(readFileSync(join(shopRoot, files[0]), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as ShopPriceSnapshot).products)) {
      return null;
    }
    return parsed as ShopPriceSnapshot;
  } catch {
    return null;
  }
}

/** 快照 → 全店最高可兑换商品价（黑与白 150 即当前最大值）；商品列表空/
 *  价格非法（非正数）返回 null。纯函数可测。 */
export function shopHighWaterOf(snapshot: ShopPriceSnapshot): number | null {
  let maxCost: number | null = null;
  for (const product of snapshot.products) {
    if (!Number.isSafeInteger(product.resource_cost) || product.resource_cost <= 0) continue;
    maxCost = maxCost === null ? product.resource_cost : Math.max(maxCost, product.resource_cost);
  }
  return maxCost;
}

/** 读取最新商店快照并派生高水位；任何缺失/损坏路径返回 null（调用方回退默认
 *  150，零回归）。导出为单函数便于 tenant-runtime 一行接入。 */
export function loadLatestShopHighWater(shopRoot: string): number | null {
  const snapshot = loadLatestShopSnapshot(shopRoot);
  return snapshot === null ? null : shopHighWaterOf(snapshot);
}
