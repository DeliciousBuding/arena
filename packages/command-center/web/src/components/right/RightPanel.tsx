import { useShell, RIGHT_TABS } from "../../lib/shell";
import { StreamPane } from "../StreamPane";
import { IntelPanel } from "./IntelPanel";
import { RedeemPanel } from "./RedeemPanel";

/** 右栏：VSCode 风格 tab 容器（决策流 / 威胁情报 / 兑换码）。
 *  激活面板随 tab 切换；切回时重挂载 → 数据自动刷新。 */
export function RightPanel() {
  const { rightTab, setRightTab } = useShell();
  return (
    <div className="rp">
      <div className="rp-tabs" role="tablist" aria-label="右侧面板">
        {RIGHT_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            data-rp-tab={t.id}
            className={`rp-tab${rightTab === t.id ? " active" : ""}`}
            role="tab"
            aria-selected={rightTab === t.id}
            onClick={() => setRightTab(t.id)}
          >
            <span className="rp-tab-ico" aria-hidden="true">{t.railIcon}</span>
            {t.label}
          </button>
        ))}
      </div>
      <div className="rp-body">
        {rightTab === "logs" ? <StreamPane embedded />
          : rightTab === "intel" ? <IntelPanel />
          : <RedeemPanel />}
      </div>
    </div>
  );
}
