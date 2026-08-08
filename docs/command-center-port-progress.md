# Arena 指挥面板 — 官方前端移植进度（2026-08-08）

> 本文件记录 `arena-hero-web`（官方前端）到 command-center 的移植覆盖与验证状态。
> 视觉体系 SSOT：`packages/command-center/DESIGN.md`；实现主体：
> `packages/command-center/web/src/engine/mapEngine.ts`（React 挂载，同构复用
> `public/style.css` + `web/src/styles/theme.css`）。

## 1. 移植覆盖总览（对照官方组件/库）

| 官方组件 | 本面板实现 | 状态 |
|---|---|---|
| WorldCanvas | mapEngine.ts 全量（地形块缓存/滚轮缩放/选中波纹/单位插值） | ✅ 已移植 |
| GameHUD | fleetHud + 顶栏 tick 读条 | ✅ 已移植 |
| CommandCountdown | commandCountdown（15s 倒计时，≤5s 变红） | ✅ 已移植 |
| PendingCommands | pendingPanel（HUMAN/AGENT 分区 + 折叠） | ✅ 已移植 |
| MapControls | mapControls（+/−/适应视口/全局） | ✅ 已移植 |
| MapFeatureInfo | **featurePanel（2026-08-08 新增）** + hover tooltip | ✅ 本次补齐 |
| ResourceActivity | activityPanel（采集/交付/战斗/信标 14 类事件） | ✅ 已移植 |
| RespawnOverlay | respawnOverlay（RESPAWNING 全屏提示） | ✅ 已移植 |
| UnitActionDialog | actionDialog（可用性判定 + blocked 原因 + 生产） | ✅ 已移植 |
| BeaconDirectionIndicator | beaconIndicator（屏幕边缘方向指示 + 点击跳转） | ✅ 已移植 |
| AssetList | assetPanel（舰队索引，点击选中） | ✅ 已移植 |
| GameStats | fleetHud（资源/人口/测绘/生命/指挥遥测） | ✅ 已移植 |
| TutorialCoach | 官方单局新手教学，与指挥面板场景不符 | ⏭️ 合理跳过 |

官方 lib（actionAvailability/combatPreview/combatAnimation/commandPlans/
pathfinding/movementPreview/movementAnimation/exploration/visibility/
worldCanvasPerformance/destruction/resourceActivity/各 art）均已移植到
mapEngine.ts 对应函数。

## 2. 本次新增：地图要素信息卡（官方 MapFeatureInfo 等价物）

**问题**：此前点击地图上的信标/资源/障碍"点了没反应"（只 hover 有提示，
点击非单位格直接清空，无可见反馈）。

**实现**（commit `f64d3e0`）：
- `tactShowFeature(cell, px, py)`：按 信标(独立 beacons) > resource/obstacle
  cell 判定要素，弹出信息卡：图标 + 标题 + 坐标 + 状态标签（信标携带/地面、
  资源记忆新鲜度）+ 归属租户 + 关闭按钮；卡片可拖拽（复用 makeDraggable）。
- `handleCanvasClick` 兜底分支改为"命中要素即弹卡"，不再无反馈清空。
- Esc / tactClear / tactSelect 统一收口隐藏。
- MapHost 增加 `#featurePanel`；theme.css 增加 `fp-*` 样式（无左侧竖条，
  对齐 DESIGN.md 设计 token）。

**验证证据**（Playwright，本地 8787）：
- 点击障碍格 `(-617,-155)` → featurePanel 弹出（title=障碍，2 rows），
  投影坐标精确匹配 `-617,-155`。
- 点击信标 `(-11,-1)` → 弹卡（图标+状态"在地面"+坐标），✕ 关闭成功。
- 单元级 `tactShowFeature` 渲染障碍/信标均正确。

## 3. 官方移植回归验证（本次实测）

| 项目 | 结果 |
|---|---|
| 折叠决策日志时画布 | ✅ 高度 750→956 正常增长，无拉伸变形 |
| 单位/核心稳定性 | ✅ 6 轮采样 4 租户单位数恒定（t1:22 t2:15 t3:8 t4:3，各 1 核心），0 pageerror |
| "两个 T1 核心" | ✅ 数据核实：t1 仅 1 核心；所见相邻双核心为 t3 己方+敌方核心（真实存在） |
| Esc 取消 | ✅ 真实按键：选中→MOVE→Esc = 清空选中/退出模式 |
| 点矿=采矿任务 | ✅ handleCanvasClick MOVE 分支：点资源格 → submitGoal('mine') |
| 15s tick 读条 | ✅ commandCountdown 14.5s 递减 + 顶栏 tick bar |
| 空闲帧率 | ✅ 60fps（rAF 节流）；缩放阻尼流畅（scale 8→9.63） |
| 服务健康 | ✅ /api/overview 200 |

## 4. 待办（后续候选）

1. ~~兑换码 cookie 接入~~ ✅ 已实现（2026-08-08）：右栏兑换码面板（Cookie 输入/保存、
   库存徽章/限购、兑换下单 + 本地历史），替换原 stub `/api/redeem` 通道。
2. ~~RespawnOverlay 增强"摧毁者"信息~~ ✅ 已映射（server `loadEvents` 输出
   `destroyedBy: values.destroyed_by`，前端 `tactRenderRespawn` 读取显示）。
3. ~~信标轨迹图层独立开关~~ ✅ 已拆（2026-08-08）：`layers.beaconTrail` 独立控制
   轨迹虚线，与 `beacon`（精灵）分离，侧栏图层可单独关。
4. ~~全流程 Playwright 回归脚本入库~~ ✅ 已入库（2026-08-08）：`web/scripts/cc-regression.mjs`
   （`npm run test:regression`），覆盖加载零错误/四 tab/决策流数据/聚焦 HUD/计划层渲染/
   人类指挥 UI 链（写后清除）/API 健康，12/12 通过；`playwright-core` 入 web devDependencies；
   替换 `C:\Users\Ding\tmp\cc-*.cjs` 55 个散件。

## 5. 2026-08-08 续：官方子集审计 + 侧栏 HUD 可见性修复 + 结构化重构

### 5.1 官方 web 完整子集审计（commit f656002）
- 逐项对照 `reference/arena-hero-web/src` 全部 60+ 文件，见
  `docs/command-center-official-subset.md`。
- 结论：核心组件 13/13、核心 lib 15/15、交互细节 5/5 全覆盖，本面板是官方超集
  （人类最高控制权 / 4 租户联盟测绘 / 回放引擎 / 威胁雷达 / 信标+敌核轨迹）。
- 跳过项均有场景理由（auth 账号、营销落地页、单局新手教学，与指挥台定位冲突）。

### 5.2 侧栏 HUD 不可见 UX 修复（commit fca2cb5）
- 问题：侧栏内容高（租户卡+图例+图层+视图 ≈1328px）把 fleetHud/assetPanel 推到
  可视区外（relY≈1326/1516 vs 可视 751）——聚焦租户后用户看不到资源/测绘/舰队。
- 修复：聚焦时侧栏 smooth-scroll 到 HUD；退出/返回全局时回顶部。
- 实测：聚焦 t1 后 fleetHud relY 1326→259、assetPanel 1516→449（均可见）。

### 5.3 并行 agent 边界（2026-08-08，已合并）
- 并行 agent 曾独占：`lib/survey.ts`、`server.ts`、`public/style.css`、`DESIGN.md`、
  `web/src/components/Sidebar.tsx`、`web/src/engine/mapEngine.js`（enemyMemory 敌情记忆层）。
- 后续会话已合并其 WIP：敌情记忆层/测绘 hover 已上线（DESIGN.md 2026-08-08 条目）；
  `mapEngine.js` → `mapEngine.ts`（全量 TS，`tsc --noEmit` 零错误）。
- 教训：并行 WIP 合并前先跑 `npm run typecheck` + 构建 + 浏览器冒烟。

## 6. 2026-08-08 续：三栏壳 + 前端结构化重构（2026-08-08 完成）

- **三栏布局（AppShell）**：左栏（租户/图层/视图）+ 地图 + 右栏（VSCode tab 容器：
  决策流 / 威胁情报 / 兑换码）。左右栏折叠为 40px 窄条（SidePanel），折叠状态 + tab
  `arena-cc-web.prefs` 持久化；折叠/展开引擎 `resize()`。
- **弹窗收口**：`Dialogs.tsx` 删除，全部弹窗/对话框迁入右栏面板
  （`right/IntelPanel`、`right/RedeemPanel`、`right/RedeemCard`），不再模态遮挡地图。
- **引擎 TS 化（进行中）**：`mapEngine.js` → `mapEngine.ts`（187KB 命令式 Canvas 引擎）；
  **注意**：`mapEngine.ts` 顶部仍标 `// @ts-nocheck`（自 .js 迁移后从未全类型化，
  全量类型化列为独立迁移项，见 DESIGN.md 技术债）；web typecheck 其余文件（React 组件/
  utils.ts/api.ts）全绿。公共逻辑已抽 `engine/utils.ts`、`engine/api.ts`（类型化版本）；
  **旧 `engine/api.js` / `engine/utils.js` 仍保留在仓**（未删除，待确认调用方后清理）。
- **UI 状态壳**：`lib/shell.tsx`（ShellContext）+ `lib/shopApi.ts`（商店 API 封装）。
- 该轮前端重构独立于并行 agent 边界——所有涉及文件本轮已合并入库。

## 7. 2026-08-08 续：数据完整性修复 + 视觉弱化 + 依赖清理（本轮）

### 7.1 全局地图合并键修复（commit 8501ab0）——"某租户单位看不到/时有时无"根因
- **问题**：`lib/map.ts` 最终 cells 只按 `x,y` 去重（cellKey 不带租户），
  后处理的租户整格覆盖前租户（TENANTS 顺序 t4 最后 → t4 覆盖 t1/t2/t3）；
  且单位/核心也按格去重，**同租户同格叠放单位**（worker 叠 core）会被吞。
- **修复**：cells 键改为 `tenant:kind:id`（地形 `tenant:type:x,y`；单位/核心
  `tenant:unit:id` / `tenant:core:id`）。前端 `cellIndex` 同步 `tenant:x,y`，
  drawLiveTrails/点矿判定/障碍判定查目标格都带当前租户。
- **实测**：修复前 t1 18/t2 14/t3 8/t4 4 单位；修复后与各租户最新 case
  `after.state` 逐项一致（t1 24/t2 20/t3 11/t4 5），cellCount 161→279+。
- **副作用修好**：点矿判定不再误读他租户地形（曾因跨租户同格覆盖）。

### 7.2 疆域色晕弱化（commit e75ba0e）——"诡异绿色球/绿色区域"
- 原 `drawTenantRegions` 径向色晕 alpha .10/.045，缩放后像一团实色球（t2 绿最扎眼）。
- 现降为 .045/.02 极淡打底 + 租户色虚线疆域环（结构化领地边界，随缩放 1.2-2px），
  租户色只作身份语义。

### 7.3 回归脚本抗 CPU 高占用（commit e75ba0e）
- API 超时 5s→25s（`CC_API_TIMEOUT_MS` 可覆盖）；survey tab 轮询等真实内容；
  聚焦 HUD / worker 资产行改轮询等待（并行 agent 高 CPU 时不再误报）。
- 并行高占用环境实测 5/12→10/12；余 2 项为并行 worktree 重启 8787 服务打断
  （服务 PID 会被并行 agent 的 start-cc.mjs 争抢，回归需在低 CPU 时段跑）。

### 7.4 引擎依赖类型化（commit e61c230）
- `mapEngine.ts` 由 `./utils.js`/`./api.js` 迁移到类型化 `./utils.ts`/`./api.ts`
  （同源导出超集）；全仓确认无其他调用方后删除两个遗留 .js。tsc + build 全绿。

## 8. 2026-08-08 续：后端结构性性能优化 + 开发测试一键流程

### 8.1 /api/map 缓存（commit 5ec4ed9）——poll 热点 2000ms → 1.1ms
- **问题**：`/api/map` 每 3s poll 一次，原每次重扫 4 租户 × 最近 24 个 case
  （~96 次文件读 + 全量 JSON 解析，冷 ~2000ms）。
- **修复**：case 文件原子写入 → 以 `(runId, caseCount, 最新 case 名)` 为签名的
  `mergedCache`；tick 未前进直接命中（15s tick vs 3s poll 命中率 ~80%）。
- **附带**：`latestRunDir` 全量扫描 run 目录（被 stream/replay/plan/world/store
  多端点共用，签名本身 ~100ms/次）加 1.5s TTL 记忆化（run 身份只在 agent 重启时变，
  语义不变）。
- **实测**：缓存命中路径 2000ms → 1.1ms/次；HTTP /api/map 冷 129ms / 命中 16ms。

### 8.2 一键 check:all（commit ee28a3f）
- `packages/command-center` 根新增 `npm run check:all`（server tsc → web typecheck →
  web build）与 `npm run test:regression` 转发；README 增「开发与测试流程」节，
  与 CI `command-center` job 等价。



## 9. 2026-08-08 续：联盟态势 tab（/api/alliance/snapshot + /api/deeds/journal）

**背景**：用户要求"4 租户资源展示 + 总体大地图 + 实时决策"。`/api/alliance/snapshot`
（并行 agent 已提交）此前前端未消费——本 tab 将其全量接入，成为右栏第 5 个面板。

### 9.1 实现（commit 待填，2026-08-08）
- 新组件 `web/src/components/right/SituationPanel.tsx`：15s 轮询 `Promise.all`
  拉 `/api/alliance/snapshot` + `/api/deeds/journal`，右上 ↻ 手动刷新。
- **全局条**：当前 tick / 联盟金库（treasuryTenant 色点）/ 可见交战 / 近期遭遇 /
  历史目击 / 估算兵力（counts）。
- **事迹叙事卡**：journal headline（★星级 + 标题 + 详情）+ 联盟 narrative；有坐标时
  点击跳转大地图定位（engine.jumpTo + toast）。
- **4 租户态势卡**：资源（含载货）/ 人口 / 兵力构成（工/锋/射）/ 核心 HP·护盾 mini-bar /
  核心坐标 / 状态徽章；每卡内嵌 **8 方向威胁扇区**（threatSummaries 的
  N/NE/E/SE/S/SW/W/NW）：背景白 alpha ∝ score、敌核数字号随距离缩放（视觉权重=距离倒数）、
  <32 格 warn / <18 格 danger 描边。
- **敌情目击清单**：sightings 按 lastSeenTick 倒序前 24 条：类型徽章（敌核/单位）/
  归属玩家/目击租户色点/可见·记忆徽章/坐标/距今 tick；**点击整行跳转地图定位**。
- 无左侧竖色条；租户色仅小色点/身份语义——对齐 DESIGN.md。

### 9.2 配套清理
- `public/style.css`：新增 `.sit-*` 全套（面板/卡片/扇区/目击行）+
  `.rp-head/.eyebrow/.rp-sub` 通用头部类（修参谋建议面板此前未样式化的头部）。
- **移除 `.adv-item.adv-*` 左侧 2px 竖色条**（用户明确"卡片不要左侧竖着的彩色条"，
  DESIGN.md 红线"禁止左侧竖条"）——严重度改由 `.adv-sev` 胶囊表达，hover 提升不变。

### 9.3 验证证据（Playwright 冒烟，本地 8787，headless chromium）
- 联盟态势 tab：4 张租户卡 / 32 个威胁扇区格 / 24 条目击行 / 5 全局 chips / 1 事迹卡，
  全部真实数据（如 t1 资源 116 人口 24 工11锋7射6；T1 NW 扇区 9 敌核 最近 21 格）。
- 参谋建议 tab 切换正常（6 条建议，左竖条已移除）。
- 零 console/pageerror；`npm run check:all`（server tsc + web typecheck + vite build）全绿；
  dist 已构建，服务 /app/ 直接托管新包（index-Bcv1IvGf.js）。


### 9.4 决策流「事迹」tab（commit a18aed1）
- StreamPane 新增「事迹」tab：纯前端 30s 轮询 `/api/deeds/journal`，不经过引擎 stream
  状态机（`prefs.tab` 白名单加 `deeds`，同步 effect 跳过 deeds，避免干扰决策流轮询）。
- 事迹行 = 租户 / tick / 标题 / 详情 / ★星级；有坐标的行可点击 → `engine.jumpTo` +
  toast 定位（敌核摧毁 / 夺取核心资源 / 敌情高浓度区 / 资源濒危等）。
- 样式：`.st-badge.deed`（琥珀）/ `.deed-hot`（高危红）/ `.stream-line.clickable`。
- 验证：check:all 全绿；Playwright 冒烟 30 事迹行 / 18 可点击 / 0 报错。


### 9.5 偏好持久化合并修复（commit 7b0d45a）
- **根因**：`StreamPane.savePrefs` 整体覆盖 `arena-cc-web.prefs`，而 `AppShell`
  （leftCollapsed/rightCollapsed/rightTab）与 `Sidebar`（sec_* 分区开关）均合并写入
  同一 key——折叠决策流/切 tab/切只看决策后刷新即丢布局偏好。
- **修复**：savePrefs 读现有对象后 `{...all, collapsed, height, quiet, tab}` 合并回写。
- **验证**：预置外壳/侧栏偏好 → 切两次流 tab → 偏好保留且刷新后仍在；回归 14/14。


### 9.6 全局威胁扇区玫瑰图（2026-08-08）
- **背景**：联盟态势 tab 的 8 方向威胁扇区数据（/api/alliance/snapshot threatSummaries）
  此前只在右栏面板可读；指挥员在大地图上无法一眼看出"哪个方向敌核在逼近哪颗核心"。
- **实现**（mapEngine.ts）：全局模式每 20s 拉 snapshot → 每己方核心按 8 方向画敌情扇区条
  （长度/透明度 ∝ score，租户色身份语义），<32 格显示最近距离（黄）、<18 红；
  随「敌情热区」图层开关显隐（复用 threat 层语义，不新增开关）。
- **验证**：像素级确认玫瑰距离标签随敌情热区开关（heat 开 77 / 关 61 琥珀标签像素）；
  回归新增「全局威胁玫瑰数据管道」断言（snapshot 已拉取）→ 15/15 全绿。


### 9.7 联盟态势 ↔ 大地图聚焦闭环（2026-08-08）
- 每张租户态势卡头部新增「聚焦」胶囊按钮 → `engine.toggleSolo(t)`：地图飞抵该租户
  核心并进入 solo 态（HUD/资产/聚焦徽章全量加载）；再点同一按钮/按 G/Esc 返回全局。
- 右栏面板数据与大地图操作第一次直接互连：看态势 → 一键下钻 → 可继续指挥。
- 验证：聚焦 t2 → 徽章「T2 · 聚焦 ✕」/HUD 可见/缩放 ×12；再点返回全局；回归 15/15 全绿。


### 9.8 态势扇区点击情报（2026-08-08）
- 每张态势卡的 8 方向威胁扇区格（非空）可点击 → 地图定位该方向最近敌情：
  优先用目击列表精确敌核坐标（entityKeys 匹配 sightings.ownerUsername），
  无精确坐标则按「核心 + 方向向量 × nearestDistance」估算落点；toast 反馈。
- 验证：点击 t1:N → toast「T1 N 方向最近敌情约 38 格（估算）」+ 画布跳图 + 0 报错；
  回归 15/15 全绿。


### 9.9 跳转定位圈 + 回归稳健化（2026-08-08）
- **跳转定位圈**：所有 jumpTo（目击/扇区/事迹跳图）在目标位置画短暂脉冲定位圈
  （3.2s 淡出+外扩，白描边+琥珀脉冲+十字准星），跳图后不丢失目标。
- **调试钩子**：MapHost 暴露 `window.__arenaEngine`（引擎句柄，供测试/调试读相机变换）。
- **回归稳健化**：人类指挥链不再赌「工人行 + 固定视口点击」——探测首个有 MOVE 动作的
  受控单位行，用 `__arenaEngine` 读相机变换 + 世界障碍，精确点击单位旁可达格；
  玫瑰数据管道改为轮询等待（服务重启/慢请求不再误报）。
- 验证：回归 15/15 全绿；跳转圈中心 Δ金 23 + Δ白 15 px 出现并 4s 淡出。


### 9.10 指挥链「点了没反应」结构性根治（2026-08-08）
- **背景**：编队多选（Shift 加选）与命令队列（Shift 入队）在完整回归下偶发失败；
  用户实操时「点单位没反应」「选择目标被卡牌挡住」「指令莫名消失」。
- **根因（diag 实证，共 4 个）**：
  1. `handleCanvasClick` 在命令瞄准态下仍先走「单位/核心解释」分支——陈旧单位格
     （合并地图轮询 3s 落后 tick）命中后 obj 为 null，静默 `tactClear()` 清掉
     `tac.mode`（移动/入队指令消失）。
  2. live 校正写回的是**点击坐标**而非单位真实坐标，下游 `tactObjectAt` 精确查仍落空。
  3. `pending-panel`（待执行命令面板，画布左上角）未设 `pointer-events:none`，
     实体挡住其下方的单位格点击（`elementFromPoint` 实证 `li.pp-row` 拦截）。
  4. 回归 6f/6g 目标取自 `/api/world` 快照，与画布插值位置差 1-2 格（高负载 flake）。
- **修复**（mapEngine.ts / style.css / cc-regression.ts）：
  - 命令模式优先：瞄准/入队态下点击直接进模式处理（点单位格 = 移动到该格，RTS 惯例）；
    MOVE 模式 world 缺失时补拉取；Shift 入队必达。
  - 抽出 `resolveLiveTarget`：live 校正写回 `liveObj.position` 真实坐标；命中半径 2→3
    （高缩放单位插值移位可达 2-3 格）；陈旧 ghost 明确 toast，不静默吞点击；
    `openCtxMenu` 同源修复。
  - `pending-panel` 加入点击穿透组（折叠按钮保留可点）。
  - 回归 6f/6g 目标改用引擎已渲染 `st.cells`（与画布同源）+ 聚焦租户过滤 + 屏幕内候选
    + 失败诊断；`getState` 暴露 cells/multi/mode/selected 投影。
- **验证**：完整 22 项回归全绿（含编队多选、命令队列、右键菜单、人类指挥链、tick 读条）；
  `check:all`（server tsc + alliance-sync + web typecheck + build）全绿。


### 9.11 移动渲染 20fps→60fps（2026-08-08 高刷丝滑）
- **背景**：单位插值移动动画窗口贯穿整个 15s tick，但调度器对移动态 draw 节流 50ms
  （20fps）——175Hz 显示器上单位移动/虚线流动发虚跳帧（"不够丝滑"残留点）。
- **实测**：全局视图拖拽采样 draw() 单帧中位 2.0ms / p99 3.8ms（6515 格），余量充足；
  solo 视图 1.7ms。20fps 纯属节流浪费。
- **修复**：animLoop 移动 draw 节流 50ms → 16ms（60fps）；idle 仍 120ms 降频省电。
- **同轮修复**：右键菜单偶发红——`openCtxMenu` 原内联实时命中半径 1（左键已统一 3），
  单位位移后渲染格脱靶；重构为与左键共用 `resolveLiveTarget`（半径 3 + 写回真实坐标 +
  solo 兜底），右键空白仍保持取消选中语义。
- **验证**：`#map` 画布实例 clearRect 计数（=draw 次数），solo 移动态 **20→61fps**；
  右键菜单定向 3/3 + 完整回归 22/22 全绿（连跑两轮）+ check:all 全绿。


### 9.12 前端架构化：战术规则层抽取 tactical.ts（2026-08-08）
- **背景**：mapEngine.ts 单文件 4925 行（256KB）——目标"架构化/不屎山"最大技术债。
  已有 utils.ts（纯工具/素材）与 api.ts 基础；本轮抽取**战术规则层**。
- **抽取** `web/src/engine/tactical.ts`（117 行纯常量 + 纯函数，无 DOM/state 依赖）：
  租户色/中文映射（TENANT_COLORS、TACT_UNIT_CN、EVENT_KIND_CN 等）、单位成本/核心容量、
  意图短标签、近邻命中/精确格/障碍地形/敌情判定/移动可达方向。mapEngine 改为导入，删除内联副本
  （4925→4863 行）。
- **收益**：纯函数可单测——新增 `test/tactical.test.ts` 7 项（成本阶梯/容量/标签/命中/地形/敌情/可达），
  verify 单测 59+10 全绿。
- **验证**：web typecheck 0 / build 0 / 完整回归 22/22 全绿（零行为变化）。


### 9.13 点击链三连根治：右键竞态 + 单位站矿点不到 + 寻路模块化（2026-08-08）
- **① 右键菜单竞态（偶发红真根因）**：canvas pointerup 未校验 `e.button`——右键的
  pointerup 也触发 `handleCanvasClick`（当左键），与 contextmenu 的 openCtxMenu 异步竞态，
  时而关掉刚开的菜单。修复：pointerdown/pointerup 增加 `e.button !== 0` 守卫，右键全权交给
  contextmenu。诊断实证：右键菜单回归偶发红（4 轮里 3 轮），定向隔离却 5/5 绿——全回归
  才触发的异步竞态。
- **② 单位站矿点不到（"点工人没反应"真实 UX bug）**：/api/map 实证 4 格 unit+resource 同格
  （工人站在矿上）；nearestCell 返回资源格 → 弹资源卡而非选中单位。修复：resolveLiveTarget
  重构为 **live 单位优先**——单位格半径 3（插值移位）、地形格半径 0（单位恰在该格才抢）、
  空白半径 1（solo 兜底），点单位永远选中单位（RTS 语义）。
- **③ 回归 6f 重写**：候选取 st.cells 的 id，点击前按 live world 重解析单位当前位置
  （诊断实证点旧渲染位 → hit=resource 脱靶）。
- **④ 寻路模块化**：`tactFindPath` BFS 核心抽到 `web/src/engine/pathfind.ts`（纯函数
  `findPath(world, from, to, extraObstacles)`，测绘记忆由调用方注入），mapEngine 保留薄包装
  合并 survey 障碍；新增 `test/pathfind.test.ts` 6 项（直达/绕障/目标为障/动态单位不可穿/
  记忆障碍/不可达）。
- **验证**：回归 **22/22 连跑两轮全绿** + verify（server tsc + alliance + web typecheck +
  build + 单测 61+16）全绿。

### 9.14 点击命中视觉瞄准 + MOVE 新鲜校验 + 回归加固（2026-08-08）
- **① 屏幕空间单位命中（unitAtScreen）**：`resolveLiveTarget` 增加画布插值绘制位命中
  （半径 3.6~4.2 格，低缩放用世界格数上限兜底），命中后按 **id** 去 live world 精确定位，
  不再只靠位置半径搜索——tick 插值/测绘轮询滞后使画布位与 live 位最多差数格，纯位置搜索
  漂移 >3 格即脱靶（"点了没反应"、回归 6f 第二击 toast 为空根因，2026-08-08 实证）。
  画布有单位但 live 无 → 明确 ghost 反馈，不静默吞点击。
- **② MOVE 模式强制刷新世界**：动态地形（周期交替障碍）下，人类指令目标校验改用最新
  /api/world，避免 3s 轮询缓存误拒（"目标 X 是障碍，无法到达"但新世界该格畅通，脱靶实证）。
  人类指挥最高控制权：不因陈旧缓存拒绝有效指令。
- **③ 回归 6/6f/6g 加固**：目标优先取引擎绘制位（所见即所点）+ 屏内候选 + 双障碍源
  （live world + engine cells）+ **elementFromPoint 校验**（避开小地图/资产列/面板遮挡，
  实证点击被 UI 覆盖层拦截时 /api/commands 无落盘）+ MOVE 模式以引擎 state.mode 为准
  （.act-targeting 视觉元素可能被重渲染延迟掩盖）。
- **④ 战术层扩展**：`tactRangerRange / tactRangerTargets / tactVisibility / tactAvailability`
  从 mapEngine 抽到 tactical.ts（4821→4794 行），新增 `test/tactical.test.ts` 5 项
  （游侠射程/目标切比雪夫/视野半径/工人采集回仓/核心信标移动受限）。
- **验证**：完整回归 **22/22 全绿**（含人类指挥链 goal 落盘、编队多选、命令队列、右键菜单、
  tick 读条）+ web 单测 21/21 + web typecheck/build + root tsc 全绿。

### 9.15 重生横幅仅聚焦租户显示（2026-08-08）
- **根因**：`tactRenderRespawn` 按任意租户世界 status=RESPAWNING 直接显隐单一横幅；
  聚焦某重生租户后退出到全局视图，横幅无人再隐藏而常显（"一打开就是一直核心被摧毁"）。
- **修复**：横幅仅 `state.soloTenant === tenant && respawning` 时显示；toggleSolo/exitSolo
  退出聚焦时显式隐藏。
- **验证**：typecheck/build/单测 21/21 全绿；全局+聚焦+退出三态横幅均隐藏。

### 9.16 事件特效层抽取 fx.ts（2026-08-08）
- **抽取** `web/src/engine/fx.ts`（187 行）：FX_KIND_CN/FX_LIFE_MS 常量 + spawnEventFx
  （事件帧 → 浮字/弹道/剑光/碎片）+ shotCurveFx（弹道抛物线纯几何）+ drawEventFx
  （注入 ctx/project/ring/font 的绘制层）。mapEngine 4589→4401 行。
- **顺手修复潜伏 bug**：销毁碎片生成原在 FX_KIND_CN spec 检查之后——`UNIT_DESTROYED`
  不在表中，`continue` 导致单位销毁碎片**永不生成**（测试实证）。挪到 spec 检查前。
- **测试**：新增 `test/fx.test.ts` 5 项（弹道曲线控制点/侧偏方向/事件帧浮字+碎片/
  上限裁剪/未知事件跳过），web 单测 21→26 全绿。
- **验证**：typecheck/build + 完整回归 **22/22 全绿**。

### 9.17 人类指令选择器/遥测差分抽取 commands.ts（2026-08-08）
- **抽取** `web/src/engine/commands.ts`（纯函数，无 DOM/state 依赖）：commandTelemetryDeltas
  （遥测差分：新增被拒/已完成/已生效）+ commandGoalOf/commandActionOf/unitHumanCommandOf/
  commandStatusText/unitTelemetryOf（人类指令选择器）。mapEngine 中对应实现改为薄包装，
  consumeCommandTelemetry 用 teleDeltas 替代内联 filter。
- **收益**：人类指挥链路（用户核心诉求"人类指挥最高控制权"）的选择器与差分逻辑可单测，
  渲染/提交 I/O 与派生逻辑解耦。
- **测试**：新增 `test/commands.test.ts` 4 项（遥测差分/goal-action 命中/状态摘要/单位遥测行），
  web 单测 26→30 全绿。
- **验证**：typecheck/build + 完整回归 **22/22 全绿**（含人类指挥链 goal 落盘、命令队列）。

### 9.18 纯几何/回放插值抽取 utils.ts + 6f 遗留动作框根治（2026-08-08）
- **抽取**：`bucketScale`（缩放桶）/`gridStepFor`（网格步长）/`extendScreen`（屏幕线段保底）/
  `replayInterp`（回放 trail 插值）4 个纯函数从 mapEngine 移入 utils.ts（纯工具层），
  mapEngine 4557→4530 行。新增 `test/utils.test.ts` 4 项（缩放桶半档幂/网格步长/
  线段方向拉长/插值钳位），web 单测 30→34 全绿。
- **6f 遗留动作框根治（探针实证）**：6e 右键菜单后 actionDialog 未关，6f 首次点击的
  绘制位正好压在 `.act-btn`（等待按钮）上 → 点击提交「等待」而非选中单位（toast 为空
  的真根因，非慢/脱靶）。修复：6f 开头 Esc 清遗留动作框；clickShift 点击前 elementFromPoint
  校验为画布，被遮挡则 Esc 后重算一次，仍挡则带元素诊断报错。
- **探针 TS 化**：probe-toast.mjs → probe-toast.ts（主树零 .mjs 遗留，Node 24 类型擦除直跑），
  加 @ts-nocheck（Playwright 黑盒探针，与 cc-regression 同约定）。
- **验证**：完整回归 **22/22 全绿** + web 单测 34/34 + typecheck/build 全绿。

### 9.19 画布绘制助手层 canvas.ts + 右键/队列回归加固（2026-08-08）
- **抽取** `web/src/engine/canvas.ts`：CANVAS_FONT 常量 + ring/drawMeterBar/drawUnitHealth/
  drawWorkerCargo/drawCoreOwnerLabel/drawStackBadge 6 个纯绘制助手（模块级 ctx + setCtx，
  与 mapEngine 约定一致；实证 0 调用在静态缓存 ctx 换入路径）。mapEngine 4530→4466 行。
- **6e 右键菜单根治**：与 6f 同源——原按 /api/world 实时位点击，mid-tick 与画布插值位差数格
  脱靶（右键落空）；改为画布插值绘制位（引擎按 id 实时命中），live 兜底。
- **6g 队列加固**：资产行探测加 20s 重试循环 + MOVE 按钮轮询（高负载动作框渲染 >800ms）；
  队列轮询窗 2.4s→4s。
- **验证**：完整回归 **22/22 全绿** + web 单测 34/34 + typecheck/build 全绿。

### 9.20 全局小地图抽取 minimap.ts（2026-08-08）
- **抽取** `web/src/engine/minimap.ts`：全局小地图（世界缩略 + 视野框 + 点击/拖拽跳转）
  自包含模块化——注入 getCanvas/getState/getViewSize/getDpr/onJump，内部持有 mmCtx/缓存。
  mapEngine 4466→4362 行。
- **验证**：完整回归 **22/22 全绿** + web 单测 34/34 + typecheck/build 全绿。
