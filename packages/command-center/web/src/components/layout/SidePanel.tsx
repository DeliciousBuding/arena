import type { ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";

export interface SidePanelProps {
  side: "left" | "right";
  open: boolean;
  width: number;
  onToggle(): void;
  /** 折叠态窄条里竖排的图标按钮（VSCode 活动栏感） */
  rail: ReactNode;
  children: ReactNode;
  /** 窄屏豁免（2026-08-10 响应式接线）：用户在中窄屏手动展开右栏时置位，
   *  解除 CSS `@media (max-width: 1320px)` 的强制折叠（:not(.user-pinned)）。 */
  pinned?: boolean;
}

const RAIL_WIDTH = 40;

/** 通用可折叠侧栏：展开 = 内容面板；折叠 = 窄图标条（VSCode 侧边栏模式）。
 *  宽度过渡动画由 CSS 驱动（width + 内容渐隐），地图自动 resize。
 *  `open` class 供窄屏抽屉断点（@media max-width:1100px）驱动滑入/滑出。 */
export function SidePanel({ side, open, width, onToggle, rail, children, pinned = false }: SidePanelProps) {
  return (
    <aside
      className={`side-panel ${side}${open ? " open" : ""}${open ? "" : " collapsed"}${pinned ? " user-pinned" : ""}`}
      style={{ width: open ? width : RAIL_WIDTH, ["--panel-w" as string]: `${width}px` }}
    >
      <div className="side-panel-body">{children}</div>
      <button type="button" className="side-toggle" title={open ? (side === "left" ? "折叠左栏" : "折叠右栏") : "展开"} onClick={onToggle} aria-expanded={open}>
        {side === "left"
          ? (open ? <PanelLeftClose className="side-toggle-icon" /> : <PanelLeftOpen className="side-toggle-icon" />)
          : (open ? <PanelRightClose className="side-toggle-icon" /> : <PanelRightOpen className="side-toggle-icon" />)}
      </button>
      <div className="side-rail" aria-hidden={open}>
        {rail}
      </div>
    </aside>
  );
}
