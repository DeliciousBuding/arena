# Arena 指挥面板 — 官方前端移植进度（2026-08-08）

> 本文件记录 `arena-hero-web`（官方前端）到 command-center 的移植覆盖与验证状态。
> 视觉体系 SSOT：`packages/command-center/DESIGN.md`；实现主体：
> `packages/command-center/web/src/engine/mapEngine.js`（React 挂载，同构复用
> `public/style.css` + `web/src/styles/theme.css`）。

## 1. 移植覆盖总览（对照官方组件/库）

| 官方组件 | 本面板实现 | 状态 |
|---|---|---|
| WorldCanvas | mapEngine.js 全量（地形块缓存/滚轮缩放/选中波纹/单位插值） | ✅ 已移植 |
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
mapEngine.js 对应函数。

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

1. 兑换码 cookie 接入：server `/api/shop*`/`/api/redeem` 已就绪，等用户提供
   linuxdoshop 有效 cookie。
2. RespawnOverlay 增强"摧毁者"信息：官方读 `events[].values.destroyed_by`，
   当前 server `loadEvents` 未映射该字段；世界 ACTIVE 时无 respawn 场景，
   优先级低。
3. 信标轨迹图层独立开关（当前 `layers.beacon` 同时管精灵+轨迹，可拆）。
4. 全流程 Playwright 回归脚本入库（当前验证脚本在 `USER_HOME\tmp\cc-*.cjs`）。
