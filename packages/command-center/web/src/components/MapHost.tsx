import { useEffect, type RefObject } from "react";
import { createMapEngine } from "../engine/mapEngine.js";
import { setEngine, bump } from "../lib/bridge";

/** 地图宿主：渲染与 legacy 一致的 #mapPane 骨架（同一 ID/类名 → 复用 public/style.css），
 *  然后把整个 <main id="layout">（由 AppShell 提供）交给 mapEngine.js 挂载
 *  （引擎管理画布/战术/回放/覆盖层，chrome 由 React 子组件渲染，引擎只读其容器）。 */
export function MapHost({ hostRef }: { hostRef: RefObject<HTMLElement | null> }) {
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const api = createMapEngine(el);
    setEngine(api);
    // 调试/回归钩子：暴露引擎句柄供测试精确计算相机变换与状态（生产无副作用）
    (window as unknown as Record<string, unknown>).__arenaEngine = api;
    const off = api.subscribe(() => bump());
    return () => { off(); setEngine(null); delete (window as unknown as Record<string, unknown>).__arenaEngine; };
  }, [hostRef]);

  return (
    <section id="mapPane">
      <canvas id="map" />
      <canvas id="minimap" title="全局小地图 · 点击/拖拽跳转视野" />
      <div id="mapHint">拖拽平移 · 滚轮缩放 · 左键选中 / 右键命令 · Esc 取消</div>
      <div id="mapTooltip" hidden />
      <div id="beaconIndicator" hidden />
      <div id="replayBar" className="panel replay-bar" hidden>
        <span className="rb-label mono">TICK</span>
        <span id="rbTick" className="rb-tick mono">—</span>
        <span className="rb-sep mono dim">/</span>
        <span id="rbMaxTick" className="mono dim">—</span>
        <div className="rb-track"><div id="rbFill" /></div>
        <span id="rbCountdown" className="rb-count mono">15.0s</span>
        <div className="rb-controls">
          <button id="rbPlay" className="rb-btn" title="播放/暂停">▶</button>
          <button id="rbPrev" className="rb-btn" title="上一 tick">◀</button>
          <button id="rbNext" className="rb-btn" title="下一 tick">▶│</button>
          <button id="rbSpeed" className="rb-btn" title="回放速度">×1</button>
        </div>
      </div>
      <div id="actionDialog" className="action-dialog" hidden />
      <div id="ctxMenu" className="ctx-menu" hidden />
      <div id="inspectPanel" className="panel inspect-panel" hidden />
      <div id="featurePanel" className="panel feature-panel" hidden />
      <div id="pendingPanel" className="panel pending-panel" hidden />
      <div id="resourceActivity" className="panel-strong activity-panel" hidden>
        <h2 className="act-title">资源活动 · RESOURCE ACTIVITY</h2>
        <ul id="activityList" className="act-list" />
      </div>
      <div id="commandCountdown" className="cmd-countdown" hidden>
        <div className="cc-head"><span className="mono cc-label">命令窗口</span><span id="ccTime" className="mono cc-time">15.0s</span></div>
        <div className="cc-track"><div id="ccFill" className="cc-fill" /></div>
      </div>
      <div id="respawnOverlay" className="respawn-overlay" hidden>
        <div className="ro-card">
          <div className="ro-icon">⛨</div>
          <div className="ro-body">
            <h1 className="ro-title">核心被摧毁 · 等待重生</h1>
            <p id="roTick" className="ro-sub mono" />
          </div>
          <div className="ro-rule" />
          <p className="ro-hint">生产与指挥将在重生后恢复。敌方核心仍然存活，重生后优先组织反攻。</p>
        </div>
      </div>
      <div id="mapControls">
        <span id="soloBadge" className="solo-badge mono" hidden />
        <button id="mapGlobal" className="ctl ctl-global" type="button" title="返回全局联盟地图（Esc / G 也可）" hidden><span className="cg-arrow">←</span>全局联盟</button>
        <span id="zoomLevel" className="ctl-label" title="当前缩放">×8.0</span>
        <button id="zoomIn" className="ctl" type="button" title="放大">+</button>
        <button id="zoomOut" className="ctl" type="button" title="缩小">−</button>
        <button id="fitBtn" className="ctl" type="button" title="适应视口">⤢</button>
      </div>
    </section>
  );
}
