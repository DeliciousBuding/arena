import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getEngine } from "../../lib/bridge";
import { ShellContext, RIGHT_TABS, type RightTab } from "../../lib/shell";
import { TopBar } from "../TopBar";
import { MapHost } from "../MapHost";
import { Sidebar } from "../Sidebar";
import { RightPanel } from "../right/RightPanel";
import { SidePanel } from "./SidePanel";

const PREFS_KEY = "arena-cc-web.prefs";
const LEFT_WIDTH = 292;
const RIGHT_WIDTH = 340;
const TENANT_COLORS: Record<string, string> = { t1: "#69b3d8", t2: "#7fd8a5", t3: "#a892d6", t4: "#fc5646" };

interface ShellPrefs {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightTab: RightTab;
}

function loadShellPrefs(): ShellPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as ShellPrefs;
    const validTab = RIGHT_TABS.some((t) => t.id === p.rightTab) ? (p.rightTab as RightTab) : "logs";
    return {
      leftCollapsed: !!p.leftCollapsed,
      rightCollapsed: !!p.rightCollapsed,
      rightTab: validTab,
    };
  } catch {
    return { leftCollapsed: false, rightCollapsed: false, rightTab: "logs" };
  }
}

function saveShellPrefs(p: ShellPrefs) {
  try {
    const all = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...all, leftCollapsed: p.leftCollapsed, rightCollapsed: p.rightCollapsed, rightTab: p.rightTab }));
  } catch { /* 忽略 */ }
}

/** 三栏应用壳：顶栏 + 左栏（资源/图层）+ 地图 + 右栏（日志/面板）。
 *  左右栏均可折叠为窄条（VSCode 侧边栏模式），折叠/展开后通知引擎重算画布尺寸。 */
export function AppShell() {
  const layoutRef = useRef<HTMLElement>(null);
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(loadShellPrefs().leftCollapsed);
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(loadShellPrefs().rightCollapsed);
  const [rightTab, setRightTabState] = useState<RightTab>(loadShellPrefs().rightTab);

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
          {t.railIcon}
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
        <SidePanel side="right" open={!rightCollapsed} width={RIGHT_WIDTH} onToggle={() => setRightCollapsed((v) => !v)} rail={rightRail}>
          <RightPanel />
        </SidePanel>
      </main>
    </ShellContext.Provider>
  );
}
