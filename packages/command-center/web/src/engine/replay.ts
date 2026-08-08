/* Arena 指挥面板 · 回放引擎核心（从 mapEngine.ts 抽取，2026-08-08）
 * 连续 tick 快照 → 单位/核心移动动画 + 15s tick 读条。
 * 纯状态 + 控制 + UI 更新（无画布依赖，可单测）；渲染层 replayDrawLayer 留在
 * mapEngine.ts（依赖 project/ctx/images/sprite/事件特效等绘制上下文）。
 * 设计：状态由 mapEngine 持有（createReplayState），控制/推进/UI 为纯函数——
 * 动画循环推进与手动步进共享同一语义，避免"回放越界/提前到位"类状态分歧。 */

export const TICK_MS = 15000;

export interface ReplayState {
  data: any;
  frame: number;
  playing: boolean;
  speed: number;
  loadedFor: string | null;
  tickStart: number;
  progress: number;
}

export function createReplayState(): ReplayState {
  return { data: null, frame: 0, playing: false, speed: 1, loadedFor: null, tickStart: 0, progress: 0 };
}

/** 动画循环推进：elapsed 达 TICK_MS/speed 前进一帧；越界自动停播并钳到最后帧。 */
export function replayAdvance(st: ReplayState, ts: number): void {
  if (!st.data) return;
  const elapsed = ts - st.tickStart;
  st.progress = Math.min(1, elapsed / (TICK_MS / st.speed));
  if (elapsed >= TICK_MS / st.speed) {
    st.frame += 1;
    if (st.frame >= st.data.ticks.length) {
      st.playing = false;
      st.frame = st.data.ticks.length - 1;
    }
    st.tickStart = ts;
    st.progress = 0;
  }
}

export interface ReplayUiEls {
  replayBar?: HTMLElement | null;
  rbTick?: HTMLElement | null;
  rbMaxTick?: HTMLElement | null;
  rbFill?: HTMLElement | null;
  rbCountdown?: HTMLElement | null;
  rbPlay?: HTMLElement | null;
  rbSpeed?: HTMLElement | null;
}

export interface ReplayDeps {
  getJSON: (url: string) => Promise<any>;
  draw: () => void;
  getEls: () => ReplayUiEls;
}

/** 读条/按钮/计数 DOM 同步（动画循环每帧 + 手动步进/加载后调用）。 */
export function updateReplayUI(st: ReplayState, els: ReplayUiEls): void {
  const d = st.data;
  if (!d || !els.rbTick) return;
  els.rbTick.textContent = String(d.ticks[st.frame] ?? '—');
  if (els.rbMaxTick) els.rbMaxTick.textContent = String(d.ticks[d.ticks.length - 1]);
  const overall = (st.frame + st.progress) / d.ticks.length;
  if (els.rbFill) els.rbFill.style.width = `${Math.round(overall * 100)}%`;
  const remain = Math.max(0, (TICK_MS / st.speed - (performance.now() - st.tickStart)) / 1000);
  const atEnd = st.frame >= d.ticks.length - 1 && !st.playing;
  els.replayBar?.classList.toggle('at-end', atEnd);
  if (els.rbCountdown) els.rbCountdown.textContent = atEnd ? '已到最新' : `${st.playing ? remain.toFixed(1) : '—'}s`;
  if (els.rbPlay) els.rbPlay.textContent = st.playing ? '⏸' : '▶';
  if (els.rbSpeed) els.rbSpeed.textContent = `×${st.speed}`;
}

/** 加载租户回放：成功则置为从头播放并显示回放条（渲染层随后由 draw() 接管单位/核心）。 */
export async function replayLoad(st: ReplayState, deps: ReplayDeps, tenant: any): Promise<any> {
  try {
    const r = await deps.getJSON(`/api/replay?tenant=${tenant}`);
    if (!r.replay || !r.replay.ticks.length) return null;
    st.data = r.replay;
    st.frame = 0;
    st.playing = true;
    st.speed = 1;
    st.loadedFor = tenant;
    st.tickStart = performance.now();
    st.progress = 0;
    const els = deps.getEls();
    if (els.replayBar) els.replayBar.hidden = false;
    updateReplayUI(st, els);
    return st.data;
  } catch { return null; }
}

/** 手动步进 ±delta 帧（上一帧/下一帧按钮）。 */
export function replayStep(st: ReplayState, deps: ReplayDeps, delta: number): void {
  if (!st.data) return;
  st.frame = Math.max(0, Math.min(st.data.ticks.length - 1, st.frame + delta));
  st.progress = 0;
  st.tickStart = performance.now();
  updateReplayUI(st, deps.getEls());
  deps.draw();
}

/** 播放/暂停；停在末帧时按播放回到开头（重播语义）。 */
export function replayToggle(st: ReplayState, deps: ReplayDeps): void {
  if (!st.data) return;
  if (st.playing) {
    st.playing = false;
  } else {
    if (st.frame >= st.data.ticks.length - 1) st.frame = 0;
    st.playing = true;
    st.tickStart = performance.now();
    st.progress = 0;
  }
  updateReplayUI(st, deps.getEls());
}

/** 倍速循环：1× → 2× → 4× → 1×（重置当前帧计时）。 */
export function replayCycleSpeed(st: ReplayState, deps: ReplayDeps): void {
  st.speed = st.speed >= 4 ? 1 : st.speed * 2;
  st.tickStart = performance.now();
  st.progress = 0;
  updateReplayUI(st, deps.getEls());
}
