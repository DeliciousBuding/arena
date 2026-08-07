# Arena 指挥面板 Design System（对齐 Vercel/Geist DESIGN.md 理念）

> 本文件是前端视觉体系的唯一事实源（SSOT）。改样式前先读这里；改这里后要同步
> `public/style.css` 的 `:root` token 与组件实现。

## 1. 设计原则

1. **Achromatic 基调**：界面以黑/白/灰为主，彩色只用于「数据/状态/身份」三类语义，
   不做装饰性渐变与光晕。
2. **阴影代替边框**：卡片层级用 `0 0 0 1px rgba(255,255,255,.02-.05)` + 柔和黑阴影表达
   抬升，实体边框只用极低透明度 `rgba(255,255,255,.06-.15)`。
3. **单一白色强调**：唯一的主行动色是纯白（primary 按钮白底黑字）；hover/active 走明度
   梯度（#fff→#e8e8e8→#d9d9d9），不引入第二种强调色。
4. **留白即设计**：面板内 padding ≥12px、卡片间距 10px、行高 1.6+；不靠边框堆砌密度。
5. **瑞士排印**：等宽字（Geist Mono）只用于数据/标签/ID，正文用 Geist Sans；字重层次
   靠 500/600/700 三级（去掉 400 细字重），中文一律黑体类回退，杜绝细宋体。
6. **动效克制**：交互反馈 150-250ms、`cubic-bezier(.16,1,.3,1)`（expo-out）；
   `prefers-reduced-motion` 全量降级。

## 2. 颜色 token（:root）

| Token | 值 | 用途 |
|---|---|---|
| `--bg-deep` / `--bg` | `#030303` / `#060606` | 页面底 / 次级底 |
| `--surface` | `rgba(16,16,16,.78)` | 面板底（+blur） |
| `--surface-solid` / `--surface-raised` | `#0e0e0e` / `rgba(23,23,23,.92)` | 实底 / 悬浮 |
| `--border` / `--border-strong` / `--border-faint` | `rgba(255,255,255,.08/.15/.05)` | 三档边框 |
| `--text` / `--text-dim` / `--text-faint` | `#fafafa` / `#a2a2a8` / `#6a6a70` | 三档文字 |
| `--accent` | `#ffffff` | 单一白色强调 |
| `--success` / `--warn` / `--danger` | `#57bd84` / `#d3ad55` / `#dd626d` | 数据/状态语义 |
| `--t1..--t4` | 蓝/绿/紫/红（muted） | 租户身份（地图/小色块） |

语义色规则：只出现在「连接徽章、决策结果、增量正负、活动图标、命令窗口 ≤5s」；
租户色只出现在「地图 canvas、租户名小色块、流内租户列」——**禁止**整卡染色/左侧竖条。

## 3. 字体

- 本地 `@font-face`（`public/assets/fonts/`，SIL OFL，离线可用）：
  - **Geist**（Vercel 官方）：400/500/600/700 → `--font-sans` / `--font-display`
  - **Geist Mono**：400/500/600 → `--font-mono`
- CJK 回退（**黑体类，杜绝细宋体**）：`PingFang SC` / `Microsoft YaHei UI` /
  `Microsoft YaHei` / `Noto Sans CJK SC`；Latin/数字用 Geist 保证高级感。
  `--font-mono` 末尾同样追加 CJK 黑体回退——决策流/标签等中英混排文字
  **不得**回退到 SimSun（宋体细瘦）。
- 字重体系：`--weight-regular/medium/semibold/bold`（**500/600/700/800**）；
  正文 500、数据/标签 600、标题 700——全站去掉 400 细字重，小字号也保持辨识度。
- 画布内浮动文字（`ctx.font`）：统一 `CANVAS_FONT` 粗黑体栈
  `"Geist","PingFang SC","Microsoft YaHei UI","Microsoft YaHei","Noto Sans CJK SC",sans-serif`，
  字重 600-700；**不再用 Geist Mono**（其无 CJK 字形，中文会回退成细宋体）。

## 4. 圆角 / 阴影 / 间距

| Token | 值 | 用途 |
|---|---|---|
| `--radius-sm/md/lg` | 6/10/14px | 小件 / 控件 / 卡片面板（仅 3 档） |
| `--shadow-card` | `0 0 0 1px rgba(255,255,255,.03), 0 8px 24px rgba(0,0,0,.38)` | 卡片 |
| `--shadow-float` | `0 24px 64px rgba(0,0,0,.62), 0 0 0 1px rgba(255,255,255,.05)` | 悬浮层/弹窗 |
| 间距 | 4/8/12/16 节奏 | 面板 padding 12、卡片 11×13、卡片间距 10 |

## 5. 动效

| 场景 | 时长/曲线 |
|---|---|
| hover / active / 数值闪烁 | 150-250ms `--ease` |
| 面板入场 `panelIn` / `dialogIn` | 400-450ms expo-out |
| 决策流新行 `rowIn` | 500ms `--ease`，仅新行 |
| 数值变化 `valueFlash` | 700ms 白底淡出（仅值变化时打 `.flash`） |
| 折叠决策流 | height 550ms `cubic-bezier(.22,1,.36,1)` |

## 6. 组件要点

- **按钮**：默认 = 白描边 + 4% 白底；primary = 白底黑字；ghost = 透明；
  active 统一 `scale(.97)`；focus-visible 白 outline。
- **租户卡**：无左侧色条；租户身份 = 名字前 8px 圆角小色块（`.tenant-name::before`）；
  solo = 租户色 40% 透明度 1px 环 + 6% 极淡底色。
- **面板**：`--surface` + blur(16) + 1px `--border`；hover 仅提亮边框。
- **标签页**：白 1.5px 下划线（scaleX 动画），激活文字纯白。
- **地图**：画布保持官方美术素材；canvas 尺寸变化必须走 ResizeObserver 重设 bitmap（防拉伸）。

## 7. 红线

- 不新增第三方运行时依赖（字体文件除外，属静态资源）。
- 不把租户色/语义色用于装饰（发光、渐变、大色块背景）。
- 改字体/颜色先改本文件与 `:root`，再动组件。
