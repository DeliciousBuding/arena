/**
 * 商店监控（2026-08-06 逆向 linuxdoshop.arenahero.io）：查询公开商品/库存
 * API + 本地 Core 资源（calibration 最新快照）→ 输出"兑换就绪度"。
 *
 * 逆向结论（决策引擎引入评估）：
 * - GET /api/v1/products 公开可读（id/name/resource_cost/purchase_limit/available_stock）；
 * - GET /api/v1/me、GET/POST /api/v1/orders 需 OAuth 登录 session（linux-do/GitHub）——
 *   兑换动作不在 bot 能力范围（凭据边界），监控层只做就绪度判定；
 * - 服务端校验"库存 + Core 资源 + 限购"同时满足才扣款，先到先得。
 *
 * 用法：cd packages/arena-agent && bun run scripts/shop-monitor.mts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PRODUCTS_URL = "https://linuxdoshop.arenahero.io/api/v1/products";

interface ShopProduct {
  readonly id: string;
  readonly name: string;
  readonly resource_cost: number;
  readonly purchase_limit: number;
  readonly available_stock: number;
}

/** 取本地某租户最新 Core 资源（calibration 快照）。 */
function latestCoreResources(tenant: string): number | null {
  const root = join(process.cwd(), "..", "..", "runtime", tenant, "calibration");
  try {
    const runs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, mtime: statMtime(join(root, entry.name)) }))
      .sort((a, b) => a.mtime - b.mtime);
    if (runs.length === 0) return null;
    const cases = readdirSync(join(root, runs[runs.length - 1].name, "cases"))
      .filter((name) => name.endsWith(".json"))
      .sort();
    if (cases.length === 0) return null;
    const last = JSON.parse(readFileSync(join(root, runs[runs.length - 1].name, "cases", cases[cases.length - 1]), "utf8"));
    return last.before?.state?.resources ?? null;
  } catch {
    return null;
  }
}

function statMtime(path: string): number {
  try {
    const { statSync } = require("node:fs") as typeof import("node:fs");
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

const response = await fetch(PRODUCTS_URL);
if (!response.ok) {
  console.error(`shop API failed: ${response.status}`);
  process.exit(1);
}
const { products } = (await response.json()) as { products: ShopProduct[] };

const t1Core = latestCoreResources("t1");
const t2Core = latestCoreResources("t2");
const core = Math.max(t1Core ?? 0, t2Core ?? 0);

const lines: string[] = [];
lines.push(`商店库存监控（本地 Core 资源：t1=${t1Core ?? "?"} t2=${t2Core ?? "?"} → 可支配=${core}）`);
lines.push("=".repeat(96));
for (const product of products) {
  const affordable = core >= product.resource_cost;
  const inStock = product.available_stock > 0;
  const ready = affordable && inStock;
  const shortage = Math.max(0, product.resource_cost - core);
  const stock = product.available_stock > 0 ? `剩 ${product.available_stock}` : "已售罄";
  lines.push(
    `${product.name}（${product.resource_cost} Core，限购 ${product.purchase_limit}）${stock} ` +
      `→ ${ready ? "✅ 可兑换" : affordable ? "⏳ 等库存" : `缺 ${shortage} Core`}`,
  );
}
const output = lines.join("\n");
console.log(output);
await Bun.write("shop-monitor-result.txt", output + "\n");
