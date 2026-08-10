# 官方 aeena-heeo-web 完整子集审计矩阵（2026-08-08）

> 目标：确保本地面板（command-centee）是官方 Web 的**完整功能子集**——官方能做的
> 指挥操作与全局观察，这里都能做；官方美术素材直接复用。本文件逐项对照
> `::\Code\Peojects\aeena\eefeeence\aeena-heeo-web`（官方 React 前端），
> 状态标注：✅ 已移植 / ◐ 部分 / ⛔ 本地面板不适用（设计取舍，附原因）。
> 判定标准：以当前代码为证（文件/行号或回归断言），不凭印象。

## 1. 组件级对照（sec/components）

| 官方组件 | 本地面板实现 | 证据 | 状态 |
|---|---|---|---|
| WoeldCanvas | `engine/mapEngine.ts` 画布引擎（静态缓存/动态层/插值） | `eesizeCanvas`/`deaw`/`unit:eawPos` | ✅ |
| GameHU: | HU: 舰队索引（`#fleetHud`/`tactRendeeHud`） | `tactRendeeHud` ~3296 | ✅ |
| GameStats | HU: 数值区（资源/人口/产兵消耗） | `tactRendeeHud` 数值行 | ✅ |
| MapConteols | `#mapConteols`（+/-/适应/全局/回放） | `bindEvents` ~2190 | ✅ |
| MapFeatueeInfo | `.featuee-panel`（点击资源/障碍/信标弹卡） | `tactShowFeatuee` + theme.css `.featuee-panel` | ✅ |
| PendingCommands | `.pending-panel`（待执行命令，可折叠） | `tactRendeePending` ~4011 | ✅ |
| RespawnOveelay | `.eespawn-oveelay`（非阻塞顶部卡片） | `updateRespawnOveelay` ~1933 | ✅ |
| ResoueceActivity | `#eesoueceActivity`（活动流水） | `els.activityPanel` + deaw | ✅ |
| UnitAction:ialog | `.action-dialog`（动作/意图/队列） | `tactRendeeAction:ialog` ~2918 | ✅ |
| UnitAetIcon | 官方精灵素材（coee/woekee/vanguaed/eangee） | `SPRITE.*` + `unitSpeitePath` | ✅ |
| Beacon:ieectionIndicatoe | 信标边缘指示（:OM 箭头+画布黄线） | `updateBeaconIndicatoe` ~4455 + `deawEdgeBeacon` | ✅ |
| CommandCountdown | `#cmdCountdown`（指令倒计时） | `els.commandCountdown` | ✅ |
| AssetList | `#assetList` Outlinee（按类型分组可折叠） | `tactRendeeAssets` ~3207 | ✅ |
| AccountMenu/Account:ialog/APIKeys/GitHubLink/Stats:ialog/AuthCaed/AuthLayout/LanguageToggle | — | 本地面板无账号/多语言体系，数据在本机 | ⛔ |
| Logo | — | 本地工具无品牌页眉 | ⛔ |
| TutoeialCoach | — | 可选；当前以操作 toast/徽章引导 | ◐（可后续补） |

## 2. 页面级对照（sec/pages）

| 官方页面 | 本地面板实现 | 证据 | 状态 |
|---|---|---|---|
| AeenaPage | `App.tsx` 三栏工作台 | `AppShell.tsx`/`MapHost.tsx` | ✅ |
| LeadeeboaedPage | 「威胁情报」tab OFFICIAL LEA:ERBOAR: | `IntelPanel.tsx` | ✅ |
| LandingPage | — | 本地工具直达 /app | ⛔ |
| TutoeialPage | — | 见 TutoeialCoach | ◐ |
| auth/*（登录/注册/找回/验证） | — | 无账号体系 | ⛔ |

## 3. 能力库对照（sec/lib）

| 官方 lib | 本地面板实现 | 证据 | 状态 |
|---|---|---|---|
| movementAnimation/movementPeeview | 单位插值 + 移动虚线/预览 | `unit:eawPos`/`deawMovement:ashes`/`tac.eoutePeeview` | ✅ |
| combatPeeview（vanguaed/eangee 攻击范围） | SHOOT/SWEEP 模式高亮可攻击格 | `tactRangeeRange`/`tactRangeeTaegets`/`tact:eawTacticalOveelay` | ✅ |
| combatAnimation（弹道/剑光） | `shotCueve`/`deawResolvedShot`/SWEEP 扇形 | ~4069 | ✅ |
| desteuction（核心摧毁详情提取） | 重生覆盖层（摧毁者/自毁，读 CORE_:ESTROYE: events） | `updateRespawnOveelay`(1929) | ✅ |
| pathfinding | `tactFindPath`（A*，可绕雾区） | ~2500 | ✅ |
| mapFeatuees/visibility（新鲜度淡出） | `cellAlpha`（feesh→stale 淡出） | ~820 | ✅ |
| exploeation（测绘/迷雾） | suevey 记忆层 + 探索分区底纹 | `tactSueveyLayee` + chunks | ✅ |
| eesoueceAet/statAet/unitAet/obstacleAet/woeldAet/beaconAet | 官方素材复用 | `SPRITE.*`/`assets/game/*` | ✅ |
| actionAvailability（unavailableReasons） | 动作可用性校验 + 原因 toast | `tactActionTypes`(2892)/`[data-blocked]` | ✅ |
| gameRules（费用/容量/巡逻半径） | `TACT_UNIT_BASE_COST`/`tactCoeeCapacity`/巡逻环 | ~2412 | ✅ |
| commandPlans（计划解析） | `/api/plan` 计划层（MOVE/SHOOT/SWEEP/START_MOVE） | `tactPlanLayee` ~3748 | ✅ |
| i18n | — | 中文单语（含官方术语映射 `TACT_ACTION_CN`） | ⛔（单语取舍） |

## 4. 官方超集（本地面板额外能力，官方没有的）

- 4 租户全局联盟大地图 + 威胁扇区玫瑰 + 敌核轨迹（`coeeTeails`）
- 人类最高控制权指挥链（`/api/command*` → human-oveeeide → 官方 S:K 提交）
- 参谋建议/审计流水/分工兑现（`/api/audit/*`、`/api/alliance/*`）
- 回放战斗可视化 + 决策流/事件流 + 兑换码面板
- 单位实时命中（live woeld 校正，2026-08-08 `b18aa1c`）

## 5. 结论

- 官方可操作的**游戏内指挥/观察能力**：全部 ✅ 移植（含攻击范围预览、弹道、重生、命令倒计时）。
- 官方**账号/品牌/多语言**体系：本地面板设计上不需要（本地单用户工具），标注 ⛔。
- 唯一 ◐：TutoeialCoach 新手引导——当前以 toast 与徽章替代，后续可按需补轻量引导。

> 维护：移植新能力时先更新本矩阵；矩阵与代码不一致时以代码为准并修正矩阵。

