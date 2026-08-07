import { useEffect, useState } from "react";
import { useEngine } from "../lib/bridge";

interface TickPayload { clock: string; tick: number; period: number; frac: number }

export function TopBar({ onIntel, onRedeem }: { onIntel: () => void; onRedeem: () => void }) {
  const engine = useEngine();
  const [tick, setTick] = useState<TickPayload | null>(null);
  const [dataRoot, setDataRoot] = useState<string>("");
  const [refreshOk, setRefreshOk] = useState<boolean>(true);

  useEffect(() => {
    if (!engine) return;
    return engine.subscribe((topic, payload) => {
      if (topic === "tick") setTick(payload as TickPayload);
      else if (topic === "dataRoot") setDataRoot(String(payload ?? ""));
      else if (topic === "refresh") setRefreshOk(payload !== false);
    });
  }, [engine]);

  const frac = tick?.frac ?? 0;
  const urgent = frac > 0.82;
  return (
    <header id="topbar">
      <div className="brand">
        <img src="/assets/game/units/core.png" alt="" className="brand-icon" draggable="false" />
        <div className="brand-text">
          <h1>Arena 指挥面板</h1>
          <p className="subtitle">COMMAND CENTER · 4 租户全局联盟测绘 · 人类最高控制权</p>
        </div>
      </div>
      <div className="top-status">
        <span id="clock" className="mono dim">{tick?.clock ?? "—"}</span>
        <span id="dataRoot" className="mono dim" title="数据根（只读）">{dataRoot}</span>
        <span id="refreshBadge" className={`badge ${refreshOk ? "ok" : "err"}`}>{refreshOk ? "实时" : "离线"}</span>
        <span className="tick-meter mono" title="世界 tick 周期（估计）：游戏每 ~15s 一个 tick，进度条表示距下一 tick">
          <span id="tickLabel" className={`dim${urgent ? " warn" : ""}`}>tick {tick ? `${tick.tick} · ${Math.round((tick.period ?? 15000) / 1000)}s` : "—"}</span>
          <span className={`tick-bar${urgent ? " warn" : ""}`}><i id="tickFill" style={{ transform: `scaleX(${frac.toFixed(3)})` }} /></span>
        </span>
        <button id="intelBtn" className="btn" type="button" title="官方排行榜威胁画像（谁在打我们）" onClick={onIntel}>威胁情报</button>
        <button id="redeemBtn" className="btn primary" type="button" onClick={onRedeem}>兑换码</button>
      </div>
    </header>
  );
}
