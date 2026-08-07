# Arena 本地指挥面板（Command Center）

只读观测工具：4 租户全局联盟测绘地图 + 资源/人口展示 + 实时决策流 + 官方商店兑换码。
纯 Node 内置能力 + 原生前端（无第三方依赖），浏览器访问 `http://127.0.0.1:8787`。

> **只读保证**：不写 `data/runtime/`、不连接 Arena、不启动任何 writer。仅读取
> `ARENA_DATA_ROOT` 下的 calibration/telemetry JSONL，以及 supervisor Debug API（127.0.0.1:8120，仅 t1/t2）。

## 启动

```bash
cd arena-ts/packages/command-center
npm start          # 或 node server.mjs
# 打开 http://127.0.0.1:8787
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ARENA_DATA_ROOT` | `arena-ts/../../data` | 数据根（只读） |
| `COMMAND_CENTER_PORT` | `8787` | 监听端口（仅 127.0.0.1） |

## 能力

- **全局联盟大地图**：合并 t1–t4 最新 calibration case（`before.state` 投影），官方素材渲染
  （core/worker/vanguard/ranger/crystal/asteroid/beacon），租户配色、图层开关、平移/缩放/自适应、悬浮详情。
- **租户卡片**：在线状态（supervisor 探测 / outcome.jsonl 新鲜度）、资源、增量、工人数、最大/均值距离、可见资源、事件数、60 tick 均值。
- **实时决策流**：`runtime.jsonl` 尾部决策（tick / deadlineOutcome / agent/selection 延迟 / submitResult / 中止请求），统一或按租户 tab；事件 tab 聚合 outcome events。
- **官方商店兑换码**：代理 `https://linuxdoshop.arenahero.io`（公开 `/api/v1/products` 动态价格/库存；`me`/`orders` 需登录 Cookie）。
  - Cookie 在浏览器 localStorage 保存，请求时经 `X-Shop-Cookie` 头内存转发，**不落盘服务器、不进日志**。
  - CSRF：从 Cookie 内 `arena_shop_csrf` 自动提取并设置 `X-CSRF-Token`。
  - 兑换会真实扣减官方 Core 资源，谨慎操作。

## API（全部只读 + 商店代理）

| 端点 | 说明 |
|---|---|
| `GET /api/overview` | 4 租户 outcome 最新快照 + 60 tick 均值 |
| `GET /api/map` | 合并最近 3 个 calibration case × 4 租户 → 全局 cells/bounds/beacons |
| `GET /api/stream?tenant=&n=` | runtime.jsonl 尾部（决策流） |
| `GET /api/events?tenant=&n=` | outcome.jsonl 尾部事件聚合 |
| `GET /api/tenants` | supervisor 探测 + 4 租户在线状态 |
| `GET /api/shop` | 官方商店商品（动态价格/库存，20s 缓存） |
| `GET /api/shop/me` | 官方账户 + Core 资源（需 `X-Shop-Cookie`） |
| `GET /api/shop/orders` | 官方兑换订单（需 `X-Shop-Cookie`） |
| `POST /api/shop/order` | 兑换下单 `{product_id}`（需 `X-Shop-Cookie`，真实扣资源） |
| `POST /api/redeem` | 兑换申请记录 stub（等待 cookie 接入的旧通道，保留兼容） |

## 目录

```
command-center/
├── server.mjs            # Node 内置 http 服务 + API
├── package.json
├── public/               # 零依赖前端（index.html / app.js / style.css / assets）
│   └── assets/           # 官方 Arena Hero 美术素材（自 reference/arena-hero-web 拷贝）
└── docs/command-center-preview.png
```

## 上游素材来源

- 参考实现：`arena/reference/arena-hero-web`（官方 React 前端，Apache-2.0）
- 素材拷贝自其 `public/assets/`；视觉 token（深色、cyan-signal/coral-hostile 等）同源移植
- 官方商店：`https://linuxdoshop.arenahero.io`（兑换码需登录 Cookie）

## 门禁

本包**不加入** arena-ts 根 workspaces，`npm run check` / `npm test` / `npm run schema:check` 不受影响。
