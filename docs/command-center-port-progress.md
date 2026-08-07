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
2. RespawnOverlay 增强"摧毁者"信息：官方读 `events[].values.destroyed_by`，
   当前 server `loadEvents` 未映射该字段；世界 ACTIVE 时无 respawn 场景，
   优先级低。
3. 信标轨迹图层独立开关（当前 `layers.beacon` 同时管精灵+轨迹，可拆）。
4. 全流程 Playwright 回归脚本入库（当前验证脚本在 `USER_HOME\tmp\cc-*.cjs`）。

## 5. 2026-08-08 续：官方子集审计 + 侧栏 HUD 可见性修复

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
