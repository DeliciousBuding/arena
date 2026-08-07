import { createContext, useContext } from "react";

/** 右栏面板标签：决策流 / 威胁情报 / 兑换码 */
export type RightTab = "logs" | "intel" | "survey" | "redeem";

export const RIGHT_TABS: Array<{ id: RightTab; label: string; railIcon: string; railTitle: string }> = [
  { id: "logs", label: "决策流", railIcon: "≣", railTitle: "决策流 · 日志" },
  { id: "intel", label: "威胁情报", railIcon: "◎", railTitle: "威胁情报 · 排行榜" },
  { id: "survey", label: "测绘", railIcon: "◈", railTitle: "测绘 · 矿/探索/生命周期" },
  { id: "redeem", label: "兑换码", railIcon: "⛃", railTitle: "官方商店 · 兑换码" },
];

export interface ShellState {
  /** 左栏（资源/图层）是否折叠为窄条 */
  leftCollapsed: boolean;
  /** 右栏（日志/面板）是否折叠为窄条 */
  rightCollapsed: boolean;
  /** 右栏当前激活的面板 */
  rightTab: RightTab;
  toggleLeft(): void;
  setLeftCollapsed(value: boolean): void;
  toggleRight(): void;
  setRightCollapsed(value: boolean): void;
  /** 展开右栏并切换到指定面板（顶栏按钮入口） */
  openRight(tab: RightTab): void;
  setRightTab(tab: RightTab): void;
}

export const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell 必须在 <AppShell> 内部使用");
  return shell;
}
