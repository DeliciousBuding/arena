import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getEngine } from "../../lib/bridge";
import { ShellContext, RIGHT_TABS, type RightTab } from "../../lib/shell";
import { TENANT_COLORS } from "@/engine/tactical";
import { TopBar } from "../TopBar";
import { MapHost } from "../MapHost";
import { Sidebar } from "../Sidebar";
import { RightPanel } from "../right/RightPanel";
import { SidePanel } from "./SidePanel";

const PREFS_KEY = "arena-cc-web.prefs";
const LEFT_WIDTH = 292;
const RIGHT_WIDTH = 340;
/** 响应式断点（与 public/style.css 的 @media 对齐）：
 *  1320 以下右栏默认折叠（用户可展开 = 钉住）；1100 以下左栏转抽屉浮层。 */
const NARROW_MQ = "(max-width: 1320px)";
const DRAWER_MQ = "(max-width: 1100px)";

interface ShellPrefs {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightTab: RightTab;
}

function loadShellPrefs(): ShellPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as ShellPrefs;
    // 默认右栏 = 威胁情报（2026-08-10 产品化：决策流是开发调试视角，玩家首看威胁）
    const validTab = RIGHT_TABS.some((t) => t.id === p.rightTab) ? (p.rightTab as RightTab) : "intel";
    return {
      leftCollapsed: !!p.leftCollapsed,
      rightCollapsed: !!p.rightCollapsed,
      rightTab: validTab,
    };
  } catch {
    return { leftCollapsed: false, rightCollapsed: false, rightTab: "intel" };
  }
}

/** 用户是否明确设置过侧栏折叠偏好（未设置过时由断点默认决定）。 */
function hasCollapsedPref(key: "leftCollapsed" | "rightCollapsed"): boolean {
  try {
    return typeof (JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Record<string, unknown>)[key] === "boolean";
  } catch {
    return false;
  }
}

function saveShellPrefs(p: ShellPrefs) {
  try {
    const all = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...all, leftCollapsed: p.leftCollapsed, rightCollapsed: p.rightCollapsed, rightTab: p.rightTab }));
  } catch { /* 忽略 */ }
}

/** 三栏应用壳：顶栏 + 左栏（资源/图层）+ 地图 + 右栏（日志/面板）。
 *  左右栏均可折叠为窄条（VSCode 侧边栏模式），折叠/展开后通知引擎重算画布尺寸。
 *  响应式（2026-08-10 接线）：1320 以下右栏默认折叠，用户展开后自动钉住
 *  （.user-pinned 豁免 CSS 强制折叠）；1100 以下左栏转抽屉，顶栏汉堡按钮滑入/滑出。 */
export function AppShell() {
  const layoutRef = useRef<HTMLElement>(null);
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(() =>
    hasCollapsedPref("leftCollapsed") ? loadShellPrefs().leftCollapsed : window.matchMedia(DRAWER_MQ).matches);
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(() =>
    hasCollapsedPref("rightCollapsed") ? loadShellPrefs().rightCollapsed : window.matchMedia(NARROW_MQ).matches);
  const [rightTab, setRightTabState] = useState<RightTab>(loadShellPrefs().rightTab);
  const [narrow, setNarrow] = useState<boolean>(() => window.matchMedia(NARROW_MQ).matches);

  useEffect(() => {
    const mqNarrow = window.matchMedia(NARROW_MQ);
    const onNarrow = () => setNarrow(mqNarrow.matches);
    mqNarrow.addEventListener("change", onNarrow);
    return () => mqNarrow.removeEventListener("change", onNarrow);
  }, []);

  useEffect(() => {
    saveShellPrefs({ leftCollapsed, rightCollapsed, rightTab });
  }, [leftCollapsed, rightCollapsed, rightTab]);

  // 栏折叠/展开改变地图视口 → 引擎重设画布尺寸并重绘
  useEffect(() => {
    const raf = requestAnimationFrame(() => getEngine()?.resize());
    return () => cancelAnimationFrame(raf);
  }, [leftCollapsed, rightCollapsed]);

  const setRightTab = useCallback((tab: RightTab) => setRightTabState(tab), []);
  const openRight = useCallback((tab: RightTab) => {
    setRightCollapsed(false);
    setRightTabState(tab);
  }, []);

  const shell = useMemo(() => ({
    leftCollapsed,
    rightCollapsed,
    rightTab,
    toggleLeft: () => setLeftCollapsed((v) => !v),
    setLeftCollapsed,
    toggleRight: () => setRightCollapsed((v) => !v),
    setRightCollapsed,
    openRight,
    setRightTab,
  }), [leftCollapsed, rightCollapsed, rightTab, openRight, setRightTab]);

  const leftRail = (
    <div className="shell-rail left">
      {Object.entries(TENANT_COLORS).map(([t, color]) => (
        <button key={t} type="button" className="rail-dot" style={{ ["--rc" as string]: color }} title={`租户 ${t.toUpperCase()}`} onClick={() => setLeftCollapsed(false)}>
          <i />
        </button>
      ))}
    </div>
  );

  const rightRail = (
    <div className="shell-rail right">
      {RIGHT_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`rail-tab${rightTab === t.id ? " active" : ""}`}
          title={t.railTitle}
          onClick={() => openRight(t.id)}
        >
          <t.icon className="rail-tab-icon" aria-hidden={true} />
        </button>
      ))}
    </div>
  );

  return (
    <ShellContext.Provider value={shell}>
      <TopBar />
      <main id="layout" ref={layoutRef}>
        <SidePanel side="left" open={!leftCollapsed} width={LEFT_WIDTH} onToggle={() => setLeftCollapsed((v) => !v)} rail={leftRail}>
          <Sidebar />
        </SidePanel>
        <MapHost hostRef={layoutRef} />
        <SidePanel side="right" open={!rightCollapsed} width={RIGHT_WIDTH} onToggle={() => setRightCollapsed((v) => !v)} rail={rightRail} pinned={narrow && !rightCollapsed}>
          <RightPanel />
        </SidePanel>
      </main>
    </ShellContext.Provider>
  );
}
