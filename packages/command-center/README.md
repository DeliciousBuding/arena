# Arena 本地指挥面板（Command Center）

4 租户全局联盟指挥工作台：大地图测绘 + 资源/人口展示 + 实时决策流 + 官方商店兑换码
+ **人类最高控制权**（默认 agent 全自动，偶尔人工下指令覆盖）。技术栈：Hono（Node 24
type stripping）+ React 19 + Vite 8 + TS（Bun/Node 工具链），浏览器访问 `http://127.0.0.1:8787`。

> **只读边界**：不写 `data/runtime/`、不连接 Arena、不启动任何 writer。唯一写通道是
> **人类指挥**：`/api/command*` → `data/runtime/human-commands/<tenant>.json`（人类指令最高
> 优先，由 tenant 主循环提交前合并，见 `lib/store.ts` + `arena-agent/src/runtime/human-override.ts`）。
> 数据源：`ARENA_DATA_ROOT` 下 calibration/telemetry JSONL + 测绘库 `runtime/survey/<tenant>.db`
> + supervisor Debug API（127.0.0.1:8120，4 租户）。

## 生产策略变体（2026-08-07）

- `strike-core-v1`：攻坚变体（aggressive 爆兵前压打水晶）——军事成型（attackForce=6）
  后 Vanguard 前压敌 Core、Ranger 断敌经济 + 记忆射击、留 1 Vanguard 守家、超 40 格
  有界攻坚回撤；确定性 core 侧 vanguardRatio=0.5 + accumulateThreshold=30 积累期爆兵。
- `move-failed-avoidance-v1`：MOVE_FAILED 连续失败 ≥2 走垂直绕行（打破进攻争格僵局）。
- 生产启用 = 在 `data/runtime/configs/{t1,t2}.json` 的 `variants` 字段声明（如
  `["move-failed-avoidance-v1", "strike-core-v1"]`）；改配置后先跑
  `npx tsx scripts/validate-config.mts` 验证，再经 supervisor `POST /shutdown` 优雅重启。
- t1/t2 已于 2026-08-07 10:00 UTC 启用（t1 现状：5V+4R+12W、资源 41→爆兵；vanguard_pressure 前压中）。

## 设计体系

- 完整视觉规范见 **DESIGN.md**（SSOT：achromatic 黑白灰、本地 Geist 字体、
  阴影代边框、单一白色强调、3 档圆角、字重体系、动效规格、红线）。
- 基调：黑白灰 achromatic（Vercel/Geist 理念）——近黑 `#030303` 背景、低透明度白边框
  （`rgba(255,255,255,.06-.15)`）、阴影代替实体边框、单一白色强调（主按钮白底黑字）。
- 圆角收敛 3 档 `--radius-sm/md/lg`（6/10/14px）；语义色 `success/warn/danger` 仅用于
  数据与状态；租户色 t1-t4 保留为地图/卡片身份标识（降饱和 muted 版）。
- 微动效：租户卡数值闪烁、决策流/事件新行 slide-in、按钮按压缩放、右栏面板入场
  `rpFadeUp`、侧栏折叠 width 过渡；`prefers-reduced-motion` 全量降级。
- 对齐：JS `TENANT_COLORS` 与 CSS `--t1..--t4` 同步 muted 版本，跨地图/卡片一致。

## 已知修复

- `latestRunDir` 按 run 内最高 case tick 选 run（UUID 字典序 ≠ 时间序——旧 bug 导致
  面板恒显示旧 run 的 stale tick，即"界面卡住显示旧数据"根因）。
## 开发与测试流程（一键，生产级稳定基线）

```bash
cd arena-ts/packages/command-center
npm run check:all        # ① server tsc → ② web typecheck → ③ web build（一键全绿）
npm run test:regression  # ④ Playwright 回归 12 项（需本机 8787 + chromium；高 CPU 下自动放宽超时）
```

- CI（`.github/workflows/ci.yml` `command-center` job）：server tsc + web typecheck + web build，
  与 `check:all` 等价；回归（依赖 live 数据）在本地跑。
- 改动地图/引擎/API 后：`npm run check:all` 全绿再提交；涉及渲染行为再跑回归。
- 回归在并行 agent 高 CPU 时会变慢（API 达 8-25s）：已把超时放宽到 25s 可覆盖
  （`CC_API_TIMEOUT_MS`）、关键项改轮询等待，不再误报。

## 启动（随用随起，无计划任务/管理员）

```bash
cd arena-ts/packages/command-center
npm start                           # 前台：node server.ts（终端可见日志）
node scripts/start-cc.mjs           # 前台：日志同时落 logs/cc-server.log
node scripts/start-cc.mjs --hidden  # 后台：无终端窗口，日志落 logs/cc-server.log
node scripts/start-cc.mjs --stop    # 停止上次 --hidden 实例
# 打开 http://127.0.0.1:8787
```

访问：http://127.0.0.1:8787/ （重定向到 /app/ · React 前端） · http://127.0.0.1:8787/app/ （React 构建产物）。

> 注：旧 `public/index.html` + `public/app.js`（零依赖原生 JS 面板）已被 React 前端取代，
> 根 `/` 重定向到 `/app/`；`public/` 现仅作静态素材（美术/字体）+ `style.css` 单一视觉源。

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ARENA_DATA_ROOT` | `arena-ts/../../data` | 数据根（只读） |
| `COMMAND_CENTER_PORT` | `8787` | 监听端口（仅 127.0.0.1） |

## 能力

- **全局联盟大地图**：合并 t1–t4 同一 run 的 calibration case（`before.state` 投影），官方素材渲染
  （core/worker/vanguard/ranger/crystal/asteroid/beacon），租户配色、图层开关、平移/缩放/自适应、悬浮详情。
  测绘语义：障碍/资源静态累积（带 lastSeen 新鲜度，被采完的资源淡出）、单位/核心按 id 保留最新
  tick 快照（消除旧版"单位云团/核心幽灵"——之前 3 个 case 每 tick 位置堆成 cell 导致单位成片、
  核心像有两个）。每租户疆域色晕 + 核心标签，一眼区分 4 租户领地。
- **跨 run 测绘库（survey-db）**：`runtime/survey/<tenant>.db`（node:sqlite 只读）累积全部历史 run
  的资源/障碍/敌核（含 firstSeenTick/seenCount/state）+ 单位生命周期（unit_lifecycle 出生/阵亡/原因）+
  消费记账（core_spends）/矿格事件时间线（resource_events）；数据源优先级高于 calibration 扫描。
- **探索测绘（fog 记忆）**：聚焦租户时，`/api/exploration` 累积同一 run 全部 calibration case
  （同一世界连续 tick 采样）的 obstacle/resource 位置 → 完整地形测绘（半透明"已测绘"层，按距最新
  tick 的步数淡出），当前 case 可见物体全亮覆盖。HUD 显示测绘统计；"测绘"图层可开关。
- **单位在动可视化**：live 视图画最近 5 tick 移动轨迹（fading trail）；回放引擎自动播放连续 tick
  快照（单位插值移动 + 15s tick 读条 + 事件浮字）；SHOT/SWEEP/HARVEST/DEPOSIT/CORE_DESTROYED 等
  事件特效 + 销毁碎片迸溅。
- **租户卡片**：在线状态（supervisor 探测 / outcome.jsonl 新鲜度）、资源、增量、工人数、最大/均值距离、可见资源、事件数、60 tick 均值。
- **实时决策流**：`runtime.jsonl` 尾部决策（tick / deadlineOutcome / agent/selection 延迟 / submitResult / 中止请求），统一或按租户 tab；事件 tab 聚合 outcome events。
- **三栏布局 + 右栏面板（2026-08-08）**：左栏（租户/图层）+ 地图 + 右栏三 tab（决策流 / 威胁情报 / 兑换码），
  左右栏可折叠为 40px 窄条（VSCode 侧边栏模式，折叠状态持久化）。威胁情报 = 官方排行榜（威胁/信标/核心三 tab、
  我方/遭遇高亮、榜外遭遇补全）；兑换码 = 官方商店面板（Cookie 连接、库存徽章、兑换历史）。
- **测绘生命周期（2026-08-08）**：矿/障碍悬停查看生命周期（状态/seenCount/首次/最后看到 tick，源
  survey-db）；HUD 生命行含累计阵亡数（unit_lifecycle）；`/api/survey` 提供每租户矿/障碍/敌核/探索分区 + 消费趋势。
- **敌情记忆层**：出视野的敌方核心/战斗单位半透明常驻（新鲜度衰减），hover 显示 lastSeen；图例/图层可开关。
- **战术交互层（官方 Arena Hero 前端移植 · 人类真实指挥）**：
  - 舰队索引（AssetList）：聚焦租户的受控单位列表，点击选中；
  - 单位/核心详情面板（坐标/HP/护盾/载货/拥有者/状态）；
  - 动作面板（UnitActionDialog）：按单位类型给出动作集与可用性
    （WORKER: MOVE/HARVEST/DEPOSIT/HEAL；VANGUARD: MOVE/SWEEP；RANGER: MOVE/SHOOT；
    CORE: HEAL/REPAIR_SHIELD/START_MOVE/CANCEL_MOVE + SPAWN 区），动作按钮 title=「提交（人类指挥）」；
  - MOVE 模式：可达格高亮 + BFS 寻路虚线路线（obstacle/实体绕行）；点矿 = 提交采矿任务
    （到达自动采、满仓自动回仓，`submitGoal` mine），点空地 = 移动任务（goto）；
  - SHOOT 模式（RANGER）：8 方向射程 3（障碍遮挡）+ 可攻击目标高亮；
  - SWEEP 模式（VANGUARD）：4 邻域清扫格；
  - 视野圈（官方 visibility 半径：核心 5 / 工人 3 / 先锋 4 / 游侠 5）；
  - 信标方向指示器（BeaconDirectionIndicator）：屏幕边缘金色箭头 + 点击居中；
  - 租户 HUD（GameStats）：资源/容量/人口/tick；
  - 命令窗口倒计时（CommandCountdown）：最近观测计划 tick 起 15s 读条，≤5s 变红；
  - 资源活动面板（ResourceActivity）：左下角悬浮最近采集/交付/治疗/信标事件；
  - 重生覆盖层（RespawnOverlay）：world status=RESPAWNING 时全屏提示；
  - 悬浮信息框（MapFeatureInfo）：图标头 + 指向箭头 + 记忆态标注；
  - 单位/核心官方细节：WORKER 载货条、受伤 HP 条、同格堆叠 ×2 徽章、选中波纹、
    核心 @拥有者标签 + 盾条/血条（携带冠军信标盾上限 10）；
  - Esc 取消选择/模式。
- **官方商店兑换码**：代理 `https://linuxdoshop.arenahero.io`（公开 `/api/v1/products` 动态价格/库存；`me`/`orders` 需登录 Cookie）。
  - 商品卡片显示**库存徽章**（`available_stock`）：`库存 N`（绿）/ `仅剩 ≤5`（琥珀警告）/ `缺货`（红 + 卡片灰化 + 按钮禁用），并标注限购数（`purchase_limit`）；面板可手动刷新，兑换后自动刷新库存与账户资源。
  - Cookie 在浏览器 localStorage 保存，请求时经 `X-Shop-Cookie` 头内存转发，**不落盘服务器、不进日志**。
  - CSRF：从 Cookie 内 `arena_shop_csrf` 自动提取并设置 `X-CSRF-Token`。
  - 兑换会真实扣减官方 Core 资源，谨慎操作。

## API（全部只读 + 商店代理）

| 端点 | 说明 |
|---|---|
| `GET /api/overview` | 4 租户 outcome 最新快照 + 60 tick 均值 |
| `GET /api/map` | 同一 run 校准 case 合并 → 全局 cells（含 fresh 新鲜度）/bounds/beacons |
| `GET /api/stream?tenant=&n=` | runtime.jsonl 尾部（决策流） |
| `GET /api/events?tenant=&n=` | calibration case 结构化事件聚合（`after.state.events`，2026-08-08 修复） |
| `GET /api/survey?tenant=all&states=` | 跨 run 测绘库：矿/障碍/敌核/探索分区 chunks + 生命周期 + 消费趋势（30s 内存缓存） |
| `GET /api/exploration?tenant=` | 单租户测绘 + 生命周期 + 当前帧（fog 记忆层数据源） |
| `GET /api/intel` | 联盟威胁情报（敌核/敌单位记忆、遭遇索引，30s 缓存） |
| `GET /api/commands?tenant=` | 人类指令存储 + 遥测（applied/rejected/satisfied + stuck 卡死跳出） |
| `POST /api/command` · `POST /api/command/goal` · `DELETE /api/command` · `POST /api/command/clear` · `POST /api/command/mode` | 人类指挥写通道（最高优先，真实提交） |
| `GET /api/tenants` | supervisor 探测 + 4 租户在线状态 |
| `GET /api/shop` | 官方商店商品（动态价格/库存，20s 缓存） |
| `GET /api/shop/me` | 官方账户 + Core 资源（需 `X-Shop-Cookie`） |
| `GET /api/shop/orders` | 官方兑换订单（需 `X-Shop-Cookie`） |
| `POST /api/shop/order` | 兑换下单 `{product_id}`（需 `X-Shop-Cookie`，真实扣资源） |
| `POST /api/redeem` | 兑换申请记录 stub（等待 cookie 接入的旧通道，保留兼容） |

## 目录

```
command-center/
├── server.ts             # Hono 服务入口（Node 24 type stripping 直接运行，无构建）
├── lib/                  # 模块化 API（fs-jsonl/streams/map/survey/trails/intel/
│                         #   leaderboard/store/shop/supervisor，全 TS）
├── scripts/start-cc.mjs  # 前台/后台/停止启动器（--hidden/--stop）
├── package.json
├── public/               # 静态素材 + style.css（单一视觉源）；app.js/index.html 为已退役 legacy 面板
│   └── assets/           # 官方 Arena Hero 美术素材（自 reference/arena-hero-web 拷贝）
├── web/                  # React + Vite + TS 前端（web/src；构建到 dist，/app/* 托管）
└── docs/command-center-preview.png
```

## 上游素材来源

- 参考实现：`arena/reference/arena-hero-web`（官方 React 前端，Apache-2.0）
- 素材拷贝自其 `public/assets/`；视觉 token（深色、cyan-signal/coral-hostile 等）同源移植
- 官方商店：`https://linuxdoshop.arenahero.io`（兑换码需登录 Cookie）

## 门禁

本包**不加入** arena-ts 根 workspaces，`npm run check` / `npm test` / `npm run schema:check`
不受影响。CI 有独立专项 job 校验本包（`ci.yml`：server `tsc --noEmit` + web typecheck + vite build）。

## React + Vite + Bun/Node 工具链（web/，全 TS）

- cd web 之后 bun install
- bun run dev        vite dev :5173，/api 代理到 8787
- bun run build      vite build --base=/app/ 到 web/dist（server 以 /app/* 托管）
- bun run typecheck  tsc --noEmit（strict，全量 TS：无 .js 源码）

架构：**三栏布局（AppShell）**——左栏（租户卡/图例/图层/视图）+ 地图 + 右栏（VSCode tab 容器：
决策流 / 威胁情报 / 兑换码）。左右栏均可折叠为 40px 窄条（`SidePanel` 通用组件，折叠后地图自动
resize）。所有弹窗/对话框已移入右栏面板（`right/IntelPanel`、`right/RedeemPanel`、`right/RedeemCard`），
不再模态遮挡地图。布局状态经 `lib/shell.tsx`（ShellContext：折叠/tab，localStorage 持久化）。
画布引擎 `src/engine/mapEngine.ts`（全 TS：`ArenaState` 接口 + legacy JSON 宽松标注；由 public/app.js
移植，React 挂载到 main#layout，引擎管理地图/战术/回放/覆盖层）。视觉单一源 = public/style.css
（React 直接 import，不复制）。

## 人类最高控制权（真实指挥，Manual 优先于 Agent 优先于 Safety）

- 前端（/app）：战术动作框按钮 = 真实命令（非演练）。点工人-点移动-点矿 = 下达采矿任务（到达自动采集、
  满仓自动回仓、目标采空自动交还 agent）；点空地 = 移动任务；SHOOT/SWEEP/SPAWN/采集/回仓等 = 一键动作直提。
- 后端：server.ts 提供 /api/command（一键动作）、/api/command/goal（持续意图）、/api/commands（读取）、
  /api/command DELETE（按单位清除）、/api/command/clear（清空租户）、/api/command/mode（开关人类接管）。
  指令写入 data/runtime/human-commands/<tenant>.json（数据层，仅本机）。
- 控制链：tenant 主循环提交前由 packages/arena-agent/src/runtime/human-override.ts 合并人类指令/意图
  （复用 validatePlan 权威净校验；未知单位/不适配动作逐条拒绝并进遥测），保持单一 writer（仅 agent 经官方 SDK 提交）。
- 测试：packages/arena-agent/test/human-override.test.ts（9 例：意图全流程/校验拒绝/优先级/disabled 交还）。
