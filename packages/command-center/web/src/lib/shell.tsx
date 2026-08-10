import { createContext, useContext } from "react";
import { ScrollText, Target, Lightbulb, Map, Activity, Gift, type LucideIcon } from "lucide-react";

/** 右栏面板标签：决策流 / 威胁情报 / 参谋建议 / 地图 / 联盟态势 / 兑换码 */
export type RightTab = "logs" | "intel" | "advice" | "survey" | "situation" | "redeem";

export const RIGHT_TABS: Array<{ id: RightTab; label: string; icon: LucideIcon; railTitle: string }> = [
  { id: "logs", label: "决策流", icon: ScrollText, railTitle: "决策流 · 实时决策" },
  { id: "intel", label: "威胁情报", icon: Target, railTitle: "威胁情报 · 排行榜" },
  { id: "advice", label: "参谋建议", icon: Lightbulb, railTitle: "参谋建议 · 行动清单" },
  { id: "survey", label: "地图", icon: Map, railTitle: "地图 · 矿带/探索/生命周期" },
  { id: "situation", label: "联盟态势", icon: Activity, railTitle: "联盟态势 · 资源与威胁" },
  { id: "redeem", label: "兑换码", icon: Gift, railTitle: "官方商店 · 兑换码" },
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
