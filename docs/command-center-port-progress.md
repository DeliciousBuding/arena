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
   替换 `USER_HOME\tmp\cc-*.cjs` 55 个散件。

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

