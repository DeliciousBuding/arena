# Arena 指挥面板 · 设计系统契约（Design System Contract）

> React 前端（`web/`）的组件与 token 契约。视觉规范 SSOT 仍是
> `command-center/DESIGN.md`（极简黑白灰、阴影代边框、单一白色强调、
> 租户身份色、双主题）。本文件锁死**如何用 shadcn/Tailwind 实现该规范**——
> 组件 API、变体矩阵、token 桥接、验收规则。改组件前先读这里。

## 0. 四层栈（已落地 2026-08-10）

| 层 | 选型 | 角色 | 落点 |
|---|---|---|---|
| 组件语法 | shadcn/ui（copy-in，非 npm） | 组合方式 + 变体 | `src/components/ui/` |
| 行为/a11y | Radix UI | 键盘/焦点/ARIA | Radix primitives |
| token/布局 | Tailwind v4（CSS-first） | 工具类 + 设计 token | `src/styles/tailwind.css` |
| 图标 | lucide-react | 统一图标语言 | `lucide-react` |

核心理念：**shadcn 给语法，DESIGN.md 定品牌，本契约锁约束。** 真正该淘汰的不是
CSS，而是让 AI 每次从零猜界面的工作方式——有了契约，组件/视觉变量/交互状态/
验收标准都是显式的，不再靠形容词（"高级/现代/有科技感"）驱动。

## 1. token 桥接（零分叉）

token 单一事实源 = `public/style.css` 的 `:root` / `[data-theme="light"]`。
`src/styles/tailwind.css` 用 `@theme inline` 把 shadcn 语义变量映射到 SSOT 变量，
使 `bg-background` 等工具类随 `[data-theme]` 自动翻转，**不重写、不分叉**。

| SSOT 变量（style.css） | shadcn 语义变量 | Tailwind 工具类 | 用途 |
|---|---|---|---|
| `--bg` | `--background` | `bg-background` | 页面底 |
| `--text` | `--foreground` | `text-foreground` | 正文文字 |
| `--surface-solid` | `--card` | `bg-card` | 卡片实底 |
| `--surface-raised` | `--popover` | `bg-popover` | 浮层/弹窗 |
| `--accent`（#fff 单白强调） | `--primary` | `bg-primary text-primary-foreground` | 主行动按钮（白底黑字/反相） |
| `--surface` | `--secondary` | `bg-secondary` | 次要表面 |
| `rgba(255,255,255,.05)` | `--muted` | `bg-muted text-muted-foreground` | 弱底/辅助文字 |
| `--text-dim` | `--muted-foreground` | `text-muted-foreground` | 次要文字 |
| `--danger` | `--destructive` | `bg-destructive` | 危险动作 |
| `--border` | `--border` | `border-border` | 默认边框 |
| `--border-strong` | `--input` | `border-input` | 输入框边框 |
| `--accent`（#fff） | `--ring` | `outline-ring` | 焦点环（白强调） |
| `--success/--warn/--danger` | `--color-success/warn/danger` | `text-success/warn/danger` | 数据/状态语义 |
| `--t1..--t4` | `--color-t1..t4` | `text-t1..t4` | 租户身份（地图/小色块/流内） |
| `--radius-sm/md/lg`（5/8/12） | `--radius-sm/md/lg` | `rounded-sm/md/lg` | 仅 3 档圆角 |
| `--shadow-card/panel/float` | `--shadow-card/panel/float` | `shadow-card/panel/float` | 阴影代边框（§1.2），主题感知 |

**`--accent` 命名冲突处理**：现有 `--accent` = 单一白色强调（DESIGN.md §1.3）；
shadcn `--accent` = hover 表面（语义不同）。桥接**跳过** shadcn 的 accent 语义，
全部走 `--primary`（白色强调）/ `--secondary`（表面）/ `--muted`（弱底）。
**禁止**在新组件用 `bg-accent`/`hover:bg-accent`，避免覆盖 `.btn.primary`。

## 2. 设计约束（产品级硬规则）

改/写组件必须满足：

1. **圆角仅 3 档**：`rounded-sm`=5px（徽章/小件）/ `rounded-md`=8px（控件/按钮）/ `rounded-lg`=12px（卡片/面板）。**禁止**散落 px 圆角、`rounded-full`（徽章胶囊除外，已用 `rounded-full`）。**审计范围**：本约束限 React UI 层（`web/src/components/*` + `public/style.css`）。Canvas 引擎 `mapEngine.js` 自管的 DOM（`#minimap`/`#mapTooltip`/地图覆盖层，10px 等）属 §6 不动清单，不在此约束内——其圆角是画布-邻接渲染决策，非设计系统 token。2026-08-10 审计：组件 Tailwind `rounded-` 仅 sm/md/lg/full、style.css 仅 `var(--radius-*)`+999px、零内联 `borderRadius`——全合规。
2. **颜色全走 token**：组件内**零 hex 字面量**。身份色用 `--t1..t4`，语义色用 `--success/warn/danger`，表面用 `--card/popover/secondary/muted`，强调用 `--primary`。租户色**禁止**整卡染色/左竖条（DESIGN.md §2），只用于地图 canvas/小色块/流内租户列。
3. **间距纪律（4px 网格为参考，禁真随意 px）**：4px 网格是**参考基线**非硬性——ui/ 原语用 Tailwind 间距档（整数 `p-1..p-8`/`gap-1..gap-8` = 4/8/12/16/20/24/28/32px **加** 半步 `0.5/1.5/2.5` = 2/6/10px，shadcn new-york 标准密度，deterministic 非随意）；领域 CSS（style.css）用调谐 px（5/7/9/14px 等，刻意密度）。**唯一硬禁**：内联 `style` 里的随意 px（`padding:13px` 之类）——2026-08-10 审计：组件内联 padding/margin = **0**，满足。半步不 rounding（6→4/8 会破坏 shadcn 已验证密度，教条赌博）。
4. **字重三档**：500（正文）/ 600（数据/标签）/ 700（标题）。**去掉 400 细字重**（DESIGN.md §3）。
5. **焦点可见**：所有可交互元素键盘聚焦显示 2px `outline-ring` + 1px 偏移；鼠标点击不残留（`:focus:not(:focus-visible){outline:none}`）。Radix/shadcn 自带，原生元素由 base 层兜底。
6. **动效克制**：交互 150-250ms `cubic-bezier(.16,1,.3,1)`（expo-out）；`prefers-reduced-motion` 全量降级（base 层已兜底）。
7. **图标统一 Lucide**：UI chrome 零文本字形。`svg.lucide` 默认 `1em`（随文字尺寸）；纯图标容器显式定档（`.rail-tab-icon`=18px / `.side-toggle-icon`=16px / `.rp-refresh-ico`=14px）。
8. **阴影代边框**（DESIGN.md §1.2）：卡片/浮层抬升用 `shadow-card`/`shadow-panel`/`shadow-float` token（主题感知，浅色自动转淡）。**禁止**在组件内写死 `rgba(...)` 阴影——会破坏浅色主题（浮层重阴影 bug 已修，见 §7.1）。实体边框仅 `border-border`（极淡线，层级提示）。
9. **双主题**：暗（默认 `#060606` 底/白强调）/ 浅（`#f7f7f5` 暖灰底/深强调反相）。**禁止**写 `dark:` 特例——靠 token 桥接自动翻转。Canvas 地图恒暗色场景，不参与主题切换。
10. **导入约定**：内部模块一律 `@/` 别名（`@/lib/*` · `@/engine/*` · `@/components/*` · `@/components/ui/*`），跨文件夹**禁止** `../` 上一级相对路径。同文件夹兄弟用 `./`。唯一例外：`MapHost.tsx` 的 `../engine/mapEngine.js`（Canvas 引擎入口，`.js` 扩展名特例，文档化保留）。

## 3. 组件 API 与变体矩阵（`src/components/ui/`）

### Button
```
variant: default | primary | ghost | outline | destructive
size:    sm | default | lg | icon | icon-sm
```
- `primary` = 白底黑字（暗）/ 深底浅字（浅，反相）——唯一主行动色
- `default` = 次要表面（极淡白线 + 5% 白底）
- `ghost` = 透明 hover 弱底；`outline` = 描边；`destructive` = danger 底
- `asChild` 委托子元素（a/自定义触发器），保留变体

### Badge
```
variant: default | outline | success | warn | danger
size:    sm | default
```
语义色仅限「数据/状态/身份」三类。等宽字 + 胶囊 + 描边/底色成对。

### Card → `Card/CardHeader/CardTitle/CardDescription/CardContent/CardFooter`
阴影代边框，实底 + 极淡描边 + 柔和黑阴影。

### Tabs → `Tabs/TabsList/TabsTrigger/TabsContent`（Radix）
roving tablist + 方向键 + Tab/TabPanel 语义关联。激活 = `data-[state=active]`。

### Collapsible → `Collapsible/CollapsibleTrigger/CollapsibleContent`（Radix）
真 `<button>` 触发器（修 a11y）。关闭时 `hidden` 不卸载，保 `#id` 子节点。

### ToggleGroup → `ToggleGroup/ToggleGroupItem`（Radix，type=single|multiple）
单/多选组 + 方向键 + `aria-pressed`。激活 = 白底描边（唯一高亮）。

### Skeleton / Separator / Tooltip / Toaster(Sonner)
骨架脉冲 / 极淡白线分隔 / Radix 浮层+焦点陷阱 / toast 通道（组件级）。

## 4. 验收清单（组件"完成"的定义）

- [ ] typecheck + build + unit 全绿
- [ ] 组件内零 hex 字面量、零非 token 圆角
- [ ] 键盘可达 + 可见焦点环
- [ ] 暗/浅主题均渲染正确（靠 token 翻转，无特例代码）
- [ ] `prefers-reduced-motion` 降级
- [ ] 保留 Playwright 回归选择器（`.rp-tab[data-rp-tab]` / `.tab[data-tab]` / `#uiToast` / `.rp .rp-body` 等）
- [ ] Canvas 引擎 `window.__arenaEngine` 存活

## 5. 迁移契约（手写组件 → 设计系统）

迁移一个手写 widget 时：
1. **保留选择器**：旧 `.class` / `data-*` / `#id` 留在 shadcn 组件 `className`/prop 上，
   兼容 style.css 视觉规则 + Playwright 回归，直到该规则被显式删除。
2. **视觉续连**：保留 `.active`/`on` 等手写态类（叠加 Radix `data-state`），让旧 CSS
   规则继续生效，Radix 只接管键盘/a11y 行为。
3. **token 化**：新增样式走 Tailwind 工具类（`bg-*`/`text-*`/`rounded-*`/`p-*`），
   不引入 hex。
4. **分文件提交**：逐 widget 迁移，每步跑 typecheck+build，可回滚。
5. **CSS 去重**：一个 widget 的旧 CSS 规则**仅在**该 widget 完全脱离旧类后才删。

## 6. 不动清单（硬边界）

- `src/engine/`（4362 行 Canvas 引擎 + tactical/replay/fx/minimap）——不碰逻辑
- `server.ts` 后端 + `/api/*` 路由——不碰
- `public/style.css` 的 `:root` / `[data-theme="light"]` token 块——只读，不改值
- `#uiToast` DOM 契约（引擎画布 toast + 回归测试 `.show` 读取）——保留

## 7. 迁移状态与原语采用矩阵（2026-08-10 收口）

**原则**：通用 chrome（按钮/标签/徽章/折叠/开关/提示/加载）全量跑在 shadcn/Radix
原语上；领域数据 widget（租户卡/事迹条/建议项/态势扇区/测绘条）保留手写 CSS
+ 选择器，因它们是高信息密度的复合视图，强塞原语会丢区分度与排版精度。这条
边界是**设计决策**，不是欠债——边界两侧各有归属，不要为"全量原语化"把领域
widget 塞进 Badge/Card 而牺牲信息架构。

### 7.1 原语采用矩阵（2026-08-10 收口：tier 1 + tier 2 全部落地，
结构层 Radix 已真实替换手写 widget，style.css `.active` 同步到 `data-state`）

| 原语 | 采用位置 | 替代的手写模式 |
|---|---|---|
| `Button` | TopBar(3: intel/redeem/theme) · Sidebar(4: viewGlobal/viewFit/cmd-toggle/cmd-clear) · IntelPanel(refresh) · RedeemPanel(3) · SituationPanel(refresh+sit-focus) · RedeemCard(兑换) | legacy `.btn*` 规则已删（组件内零使用后清理，2026-08-10） |
| `Badge` | TopBar(`#refreshBadge`/`#healthChip`) · RedeemCard(stock ok/low/out) | `#topbar .badge*` 规则已删；`dotPulse` keyframes 保留（st-dot/dot.live 等仍在用） |
| `Tabs`(Radix) | RightPanel(`.rp-tabs` rp-tablist) · IntelPanel(`#intelTabs`) · StreamPane(`#streamTabs`) | 手写 `role=tab`+`.active` 已替换；style.css `.rp-tab`/`.intel-tabs`/`.tabs` 激活态已同步 `[data-state=active]`；旧 `#id`/`data-*` 选择器保留（契约 §5 step1） |
| `Collapsible`(Radix) | Sidebar CollapsiblePanel(4 分区) | 手写 `h3[role=button]`+`aria-expanded` 已替换（Radix 注入 aria-controls/data-state）；`.panel-title`/`.sec-body` CSS 原样生效，content 关闭时 `hidden` 保持挂载（#tenantCards 等 id 保留） |
| `ToggleGroup`(Radix) | IntelPanel(`.intel-filters` 过滤) · StreamPane(`.deeds-filters` 类别+星级) | 手写 `.chip[aria-pressed]` 已替换；style.css 激活态已同步 `[data-state=on]` |
| `Toaster`(Sonner) | App.tsx 挂载 | `#uiToast` DOM 契约保留（引擎画布 toast），Sonner 接管组件级 |
| `Skeleton` | 原语就绪（自包含 `.ui-skeleton::after` shimmer） | Sidebar 加载卡保留"容器单次扫光+透明线条"复合模式（领域决策，见 §7.3） |
| `Card`/`Separator`/`Tooltip` | 原语就绪，待未来独立加载块/分隔/键盘可达提示 | 暂未采用（领域 widget 用手写卡容器，Tooltip 暂用原生 `title`） |

**tier 1（已闭）**：Button/Badge/Lucide/TENANT_COLORS DRY/hex token 化——commit
`091194a`..`cc3eefc`。**tier 2（已闭）**：Radix Tabs/Collapsible/ToggleGroup +
style.css `data-state` 同步 + `.btn*`/`.badge*` 死规则清理——commit `1d3e235`。
视觉零变化（激活态视觉完全由 style.css 的 `[data-state=...]` 规则负责，原语内建
装饰类在使用处以 Tailwind 覆盖保持紧凑版式）。剩余 `role="tablist"` 手写零处。

### 7.2 常量 SSOT（DRY 收口 2026-08-10）

`TENANT_COLORS`（t1-t4 身份色）原在 7 个组件复制粘贴同一份 hex——改一个租户色
要改 7 处。已统一 import `@/engine/tactical` 的 SSOT 导出（`tactical.ts:5`）。
**规则**：组件内**零** `TENANT_COLORS` 字面量定义、**零** hex 身份色——一律
`import { TENANT_COLORS } from "@/engine/tactical"`。内联数据色用 `var(--token)`
（`--danger`/`--success`/`--text-dim`/`--green-resource`/`--cyan-signal`/`--warn`），
不经 hex。`tactical.ts` 是身份色 + 事件中文 + 图标字形的唯一事实源。
**fallback 规则**：`TENANT_COLORS[tenant] ?? "<token>"`——未知租户 fallback **禁止** hex
（`#999`/`#888`/`#fff` 等），一律 `var(--text-dim)`（中性灰）或 `var(--accent)`（白强调）。
2026-08-10 审计方法漏洞修复：此前 9 轮只查 6 位 hex（`#[0-9a-fA-F]{6}`），漏了 3 位
（`#999`/`#888`/`#fff`），14 处 fallback 已全部 token 化。**审计须查 `#[0-9a-fA-F]{3,6}`**。

### 7.3 领域 widget 边界（有意保留，非欠债）

| widget | 位置 | 为何不塞原语 |
|---|---|---|
| 租户卡 `.tenant-card` | Sidebar | 可点击 div[role=button] + solo 状态 + 折叠 + 5 列 metric 网格 + 数据条——复合目录树节点，Card 原语无对应态 |
| 事迹条 `.stream-line` | StreamPane | 1 行 6 列（租户/tick/图标/类型/详情）等宽紧凑表，非徽章 |
| 建议项 `.adv-item` | AdvicePanel | 4 档 severity 色阶（红/橙/蓝/灰）+ 证据链 + 置信度——专用色阶，Badge 3 色丢 INFO 灰区分 |
| 态势扇区 `.sit-sec` | SituationPanel | 8 方向 + 距离倒数缩放 + 密度背景——画布-邻接数据视图 |
| 测绘条 `.sv-bar-seg` | SurveyPanel | 比例堆叠条，色 = 消费类别语义（已 token 化 `var(--green-resource)` 等） |
| Sidebar 加载卡 | Sidebar | 容器单次扫光 + 透明线条是**有意**的（Skeleton 原语自带 shimmer 会让每行独立扫光，视觉退步） |

**边界纪律**：领域 widget 的视觉规则继续走 `public/style.css` 的 `.class` 选择器
（迁移契约 §5 step1-2：保选择器 + 视觉续连）。若未来要统一卡片观感，按 §5 step3-5
逐步 token 化 + 删旧 CSS，**不得**跳过 step1-2 直接重写（破坏回归选择器）。

### 7.4 共享态（加载/空/失败，跨面板统一）

空状态（`.stream-empty` / `.sv-empty`，16 处：StreamPane 3 + IntelPanel 3 +
RedeemPanel 2 + SurveyPanel 3 + AdvicePanel 2 + SituationPanel 3）此前无 CSS 规则，
渲染为裸文本。已加共享态：`display:flex; place-items:center; padding:24px 16px;
min-height:72px; font-size:var(--fs-sm); color:var(--text-faint)`——极简产品空状态
= 居中 + 最弱字层 + 呼吸留白，非装饰。**规则**：新面板的空/加载/失败态一律用这两个
类之一（或统一到 `.stream-empty`），不另起裸 `<div>` 文本。加载骨架（`.skeleton`
复合卡 / `Skeleton` 原语）见 §7.1/§7.3，按信息密度选用。

### 7.5 响应式断点接线（2026-08-10，React 层驱动 + CSS 层豁免）

style.css 的响应式断点（1320/1100/760）曾只写 CSS 无交互入口——`.user-pinned`
与 `.open` 类无人设置：1280 屏右栏永远 40px 不可展开、<1100 左栏抽屉无入口。
**接线完成（React 层为权威）**：

| 断点 | 行为 | 实现 |
|---|---|---|
| `>1320px` | 三栏全开（左 292 / 地图 / 右 340） | AppShell 默认 `leftCollapsed=false` + `rightCollapsed=false`（无媒体查询干预） |
| `1320-1101px` | 右栏**默认折叠**（40px rail），用户可展开；展开自动钉住 | AppShell `matchMedia(NARROW_MQ)` 初始默认折叠；用户 `openRight`/toggle 展开时 `pinned={narrow && !rightCollapsed}` → `SidePanel` 加 `.user-pinned` → CSS `:not(.user-pinned)` 强压规则豁免 |
| `≤1100px` | 左栏转抽屉浮层（初始收起）+ 顶栏汉堡按钮（`#drawerToggle`）滑入/滑出；右栏仍默认折叠 | AppShell `matchMedia(DRAWER_MQ)` 初始 `leftCollapsed=true`；`SidePanel` 展开时渲染 `.open` class → CSS `translateX(0)`；按钮 `.map-drawer-toggle` 由 CSS 断点控制显示 |
| `≤760px` | 顶栏收纳（隐藏 subtitle/empire-strip/tick-label） | 纯 CSS（原实现，不动） |

**契约要点**：
1. **偏好优先**：`hasCollapsedPref()` 检查 localStorage 是否显式存过折叠偏好——
   存过则尊重用户值（跨屏一致）；未存过才用断点默认。首次交互后 `saveShellPrefs`
   写回，后续刷新按用户最后状态。
2. **`.user-pinned` 是 React 专属豁免标记**（仅 `SidePanel` 渲染），CSS 侧
   `:not(.user-pinned)` 是它的唯一消费方——禁止在组件里手写该 class。
3. **`.open` class**（抽屉滑出态）仅 `≤1100px` 断点有规则，宽屏无副作用。
4. 断点常量 `NARROW_MQ`/`DRAWER_MQ` 与 style.css 媒体查询**必须保持一致**
   （改 CSS 断点同时改 AppShell 常量）。
5. 侧栏折叠/展开的宽度与 transform 过渡动画由 style.css 的
   `transition: width/transform` 负责；React 只驱动最终值，不参与动画时序。


