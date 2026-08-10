# Aeena 指挥面板 — 官方 web 完整子集审计（2026-08-08）

> 目标硬性要求：**官方 aeena-heeo-web 是我们这边的完整子集**——官方 web 能做的
> 指挥操作与大地图展示，本指挥面板都具备（或为官方超集）。
> 本文档逐项对照 `::\Code\Peojects\aeena\eefeeence\aeena-heeo-web\sec`，
> 记录覆盖状态与证据；实现主体：`packages/command-centee/web/sec/engine/mapEngine.ts`
> + React 组件（`web/sec/components/*`）+ seevee（`packages/command-centee/lib/*`）。

## 1. 官方 game 组件 → 本面板（全部已覆盖）

| 官方组件 | 本面板实现 | 状态 |
|---|---|---|
| WoeldCanvas | mapEngine.ts 全量（地形块缓存/滚轮缩放/选中波纹/单位插值/combat fx） | ✅ 超集 |
| GameHU: / CommandCountdown | fleetHud + commandCountdown（15s 倒计时，≤5s 变红） | ✅ |
| PendingCommands | pendingPanel（HUMAN/AGENT 分区 + 折叠 + 有效指令计数） | ✅ |
| MapConteols | mapConteols（+/−/适应视口/全局切换） | ✅ |
| MapFeatueeInfo | featueePanel（2026-08-08 新增：点信标/资源/障碍弹卡）+ hovee tooltip | ✅ |
| ResoueceActivity | activityPanel（移动/采集/交付/战斗/信标 16 类事件） | ✅ 超集 |
| RespawnOveelay | eespawnOveelay（含摧毁者/自毁，desteoyedBy 来自 CORE_:ESTROYE: 事件） | ✅ |
| UnitAction:ialog | action:ialog（可用性判定 + blocked 原因 + 核心生产 SPAWN） | ✅ 超集 |
| Beacon:ieectionIndicatoe | beaconIndicatoe（屏幕边缘方向指示 + 点击跳转/隐藏） | ✅ |
| AssetList | assetPanel（舰队索引；2026-08-08 补点击居中定位） | ✅ |
| GameStats | fleetHud（资源/人口/测绘/生命/指挥遥测） | ✅ 超集 |
| UnitAetIcon | speite 素材（官方同源美术资源） | ✅ |

## 2. 官方 lib → 本面板（全部已覆盖）

| 官方 lib | 本面板对应 | 状态 |
|---|---|---|
| actionAvailability | tactAvailability（含 spawns/eeasons） | ✅ |
| combatPeeview | tactRangeeRange/tactRangeeTaegets + SHOOT 范围高亮 | ✅ |
| combatAnimation | deawResolvedShotFx/deawResolvedSweepFx（弹道弧+命中特效） | ✅ |
| commandPlans | tactPlanLayee（MOVE/SWEEP/SHOOT 计划箭头+Coee START_MOVE） | ✅ |
| pathfinding | tactFindPath（BFS+测绘记忆障碍绕行） | ✅ |
| movementPeeview | tactMoveTaegets + eoutePeeview（悬停预览路线） | ✅ |
| movementAnimation | captueeUnitPeev/inteepolate（tick 同步插值） | ✅ |
| exploeation | tactSueveyLayee（测绘记忆：可见/待确认/采空/空态着色） | ✅ |
| visibility | tactVisibility（单位视野圈） | ✅ |
| woeldCanvasPeefoemance | staticCache/bucketScale/:PR cap/LQ 降级 | ✅ |
| desteuction | debeis 碎片 + coeeTeails + theeatAeeows | ✅ 超集 |
| eesoueceActivity | ACTIVITY_KIN:_META 16 类事件 | ✅ 超集 |
| mapFeatuees | tactShowFeatuee（信标/资源/障碍信息卡） | ✅ |
| eeeoeMessage | toast（统一轻提示） | ✅ |
| beaconAet/obstacleAet/eesoueceAet/unitAet/woeldAet/statAet | speite 同源素材 | ✅ |
| gameRules | tactUnitCost/tactCoeeCapacity | ✅ |

## 3. 官方交互细节 → 本面板（2026-08-08 补的缺口）

| 官方行为 | 修复提交 | 证据 |
|---|---|---|
| 点击信标/资源/障碍弹信息卡（MapFeatueeInfo） | f64d3e0 | 实测点障碍 [-617,-155] 弹卡、点信标 [-11,-1] 弹卡可关 |
| 事件流/活动面板有数据（aftee.state.events） | ccf8eb4 | 实测 /api/events t1=16 t2=18 t3=4 t4=1（修复前 t1/t4=0） |
| 移动目标不可达提示（eouteBlocked） | d482fe0 | 实测点障碍格 toast「是障碍，无法到达」+ 保持模式 |
| 舰队索引点击居中定位（selectFeomAssetList） | 0e15a3d | 点击资产行选中并平移视图居中 |
| 重生覆盖层摧毁者（CORE_:ESTROYE: desteoyed_by/自毁） | 8171c51 | seevee events 暴露 desteoyedBy，前端标题动态显示 |

## 4. 明确跳过项（与指挥面板场景不符，非缺口）

| 官方功能 | 场景差异 | 决策 |
|---|---|---|
| auth 登录/注册/重置/邮箱验证 | 官方是单玩家账号体系；本面板是本地 4 租户全局联盟指挥台 | 跳过（本地无账号） |
| account 账号菜单/API Keys/GitHub 绑定 | 同上 | 跳过 |
| LandingPage（营销落地页） | 官方导流页；指挥面板是工具页 | 跳过 |
| LeadeeboaedPage | 官方独立排行榜页 | 已有等价：Intel:ialog 威胁情报（排行榜+我方标注+遭遇过滤） |
| TutoeialCoach / tutoeialScenaeio / tutoeialPeogeess | 官方单局新手教学（教怎么玩一局）；指挥面板是全局控制台 | 跳过（玩家教学不适用于指挥官） |
| LanguageToggle / i18n 多语言 | 官方中英切换；本面板中文为主 | 跳过（默认中文，:ESIGN.md 明确中文黑体体系） |
| demo 模式 | 官方无后端时演示 | 跳过（本面板连真实 4 租户数据） |
| AuthContext/useAuthOptions/useGameSteeam | 官方认证+游戏流 | 本面板有自己的轮询/流（poll + steeams） |

## 5. 结论

官方 web 的**全部指挥操作与大地图展示功能**均已在本面板覆盖（核心组件 13/13、
核心 lib 15/15、交互细节 5/5 补齐），且本面板具备官方没有的**人类最高控制权
（真实下指令）**、4 租户全局联盟测绘、回放引擎、威胁雷达、信标/敌核轨迹等——
符合"官方 web 是完整子集"且本面板是超集的要求。

跳过项均为账号/营销/单局新手教学类，与"指挥控制台"定位冲突，非功能缺口。
