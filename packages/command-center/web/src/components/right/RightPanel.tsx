import { lazy, Suspense } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useShell, RIGHT_TABS, type RightTab } from "../../lib/shell";
import { StreamPane } from "../StreamPane";

// 非默认面板按需加载（2026-08-10 性能优化）：首屏只打包决策流 + 地图引擎，
// 其余 2 面板（威胁情报/兑换码）首次切到时才拉 chunk。
// 参谋建议、测绘、联盟态势已于 2026-08-10 并入威胁情报，不再独立成 tab。
const IntelPanel = lazy(() => import("./IntelPanel").then((m) => ({ default: m.IntelPanel })));
const RedeemPanel = lazy(() => import("./RedeemPanel").then((m) => ({ default: m.RedeemPanel })));

function PanelFallback() {
  return <div className="rp-pane" data-panel="lazy"><div className="stream-empty">加载面板…</div></div>;
}

/** 右栏：VSCode 风格 tab 容器（决策流 / 威胁情报 / 兑换码）。
 *  激活面板随 tab 切换；切回时重挂载 → 数据自动刷新。
 *  Radix Tabs 提供 roving tablist + 方向键；激活态视觉仍由 style.css `.rp-tab` 负责
 *  （下划线动画），故覆盖原语内建激活背景。 */
export function RightPanel() {
  const { rightTab, setRightTab } = useShell();
  return (
    <div className="rp">
      <Tabs value={rightTab} onValueChange={(v) => setRightTab(v as RightTab)}>
        <TabsList
          className="rp-tabs h-auto p-0 gap-[2px] rounded-none bg-transparent"
          aria-label="右侧面板"
        >
          {RIGHT_TABS.map((t) => (
            <TabsTrigger
              key={t.id}
              value={t.id}
              data-rp-tab={t.id}
              className="rp-tab px-[11px] py-[8px] pb-[9px] rounded-none data-[state=active]:bg-transparent data-[state=active]:ring-0"
            >
              <t.icon className="rp-tab-ico" aria-hidden={true} />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="rp-body">
        {rightTab === "logs" ? <StreamPane embedded />
          : rightTab === "intel" ? <Suspense fallback={<PanelFallback />}><IntelPanel /></Suspense>
          : <Suspense fallback={<PanelFallback />}><RedeemPanel /></Suspense>}
      </div>
    </div>
  );
}
