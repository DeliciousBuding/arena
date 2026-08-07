import type { ReactNode } from "react";

export interface SidePanelProps {
  side: "left" | "right";
  open: boolean;
  width: number;
  onToggle(): void;
  /** 折叠态窄条里竖排的图标按钮（VSCode 活动栏感） */
  rail: ReactNode;
  children: ReactNode;
}

const RAIL_WIDTH = 40;

/** 通用可折叠侧栏：展开 = 内容面板；折叠 = 窄图标条（VSCode 侧边栏模式）。
 *  宽度过渡动画由 CSS 驱动（width + 内容渐隐），地图自动 resize。 */
export function SidePanel({ side, open, width, onToggle, rail, children }: SidePanelProps) {
  return (
    <aside
      className={`side-panel ${side}${open ? "" : " collapsed"}`}
      style={{ width: open ? width : RAIL_WIDTH, ["--panel-w" as string]: `${width}px` }}
    >
      <div className="side-panel-body">{children}</div>
      <button type="button" className="side-toggle" title={open ? (side === "left" ? "折叠左栏" : "折叠右栏") : "展开"} onClick={onToggle} aria-expanded={open}>
        {side === "left" ? (open ? "«" : "»") : (open ? "»" : "«")}
      </button>
      <div className="side-rail" aria-hidden={open}>
        {rail}
      </div>
    </aside>
  );
}
