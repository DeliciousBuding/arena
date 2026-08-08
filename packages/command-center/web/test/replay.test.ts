/**
 * 回放引擎核心测试（2026-08-08）：replay.ts 抽取的 mapEngine 回放逻辑——
 * 状态初始、动画推进/越界停播、手动步进钳位、播放暂停重播、倍速循环、UI 同步、加载。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createReplayState, replayAdvance, replayStep, replayToggle,
  replayCycleSpeed, updateReplayUI, replayLoad, TICK_MS,
  type ReplayState, type ReplayDeps,
} from "../src/engine/replay.ts";

function fakeEls() {
  const classes = new Set<string>();
  const bar = {
    hidden: false,
    classList: {
      toggle: (c: string, force?: boolean) => {
        if (force === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
        else if (force) classes.add(c); else classes.delete(c);
      },
      has: (c: string) => classes.has(c),
    },
  };
  return {
    els: {
      replayBar: bar,
      rbTick: { textContent: "" },
      rbMaxTick: { textContent: "" },
      rbFill: { style: { width: "" } },
      rbCountdown: { textContent: "" },
      rbPlay: { textContent: "" },
      rbSpeed: { textContent: "" },
    } as any,
    bar, classes,
  };
}

function fakeData(ticks: number[] = [100, 101, 102, 103], units: any[] = []) {
  return { ticks, units, cores: [], loadedFor: null };
}

function fakeDeps(els: any, over: Partial<ReplayDeps> = {}): ReplayDeps {
  return {
    getJSON: async () => ({ replay: fakeData() }),
    draw: () => {},
    getEls: () => els,
    ...over,
  };
}

test("create: 初始态为空且未播放", () => {
  const s = createReplayState();
  assert.equal(s.data, null);
  assert.equal(s.frame, 0);
  assert.equal(s.playing, false);
  assert.equal(s.speed, 1);
  assert.equal(s.loadedFor, null);
});

test("advance: elapsed 达 TICK_MS/speed 前进一帧，进度钳 0-1", () => {
  const s = createReplayState();
  s.data = fakeData();
  s.tickStart = 0;
  s.speed = 1;
  s.playing = true;
  replayAdvance(s, TICK_MS / 2);      // 半程：进度 0.5，不越帧
  assert.equal(s.frame, 0);
  assert.ok(Math.abs(s.progress - 0.5) < 1e-9);
  replayAdvance(s, TICK_MS);          // 满程：前进一帧
  assert.equal(s.frame, 1);
  assert.equal(s.progress, 0);
  assert.equal(s.tickStart, TICK_MS);
});

test("advance: 末帧越界自动停播并钳到最后帧", () => {
  const s = createReplayState();
  s.data = fakeData();               // 4 ticks → frame 0..3
  s.frame = 3;
  s.tickStart = 0;
  s.speed = 1;
  s.playing = true;
  replayAdvance(s, TICK_MS);
  assert.equal(s.frame, 3);
  assert.equal(s.playing, false, "末帧越界应停播");
});

test("advance: 无数据时安全空转", () => {
  const s = createReplayState();
  replayAdvance(s, 9999);
  assert.equal(s.frame, 0);
  assert.equal(s.progress, 0);
});

test("step: 手动步进 ±1 且钳位在 [0, len-1]", () => {
  const { els } = fakeEls();
  const deps = fakeDeps(els);
  const s = createReplayState();
  s.data = fakeData();
  replayStep(s, deps, 1);
  assert.equal(s.frame, 1);
  replayStep(s, deps, 2);
  assert.equal(s.frame, 3);
  replayStep(s, deps, 1);            // 越上界钳到 3
  assert.equal(s.frame, 3);
  replayStep(s, deps, -9);           // 越下界钳到 0
  assert.equal(s.frame, 0);
});

test("toggle: 播放↔暂停，末帧按播放回到开头", () => {
  const { els } = fakeEls();
  const deps = fakeDeps(els);
  const s = createReplayState();
  s.data = fakeData();
  s.playing = true;
  replayToggle(s, deps);
  assert.equal(s.playing, false);
  replayToggle(s, deps);
  assert.equal(s.playing, true);
  s.frame = 3;                        // 末帧
  replayToggle(s, deps);
  assert.equal(s.playing, false);
  replayToggle(s, deps);              // 重播：回到开头
  assert.equal(s.playing, true);
  assert.equal(s.frame, 0);
});

test("cycle-speed: 1× → 2× → 4× → 1×", () => {
  const { els } = fakeEls();
  const deps = fakeDeps(els);
  const s = createReplayState();
  s.data = fakeData();
  s.speed = 1;
  replayCycleSpeed(s, deps);
  assert.equal(s.speed, 2);
  replayCycleSpeed(s, deps);
  assert.equal(s.speed, 4);
  replayCycleSpeed(s, deps);
  assert.equal(s.speed, 1);
});

test("update-ui: 同步 tick/进度/倒计时/按钮文本与 at-end 态", () => {
  const { els, bar, classes } = fakeEls();
  const s = createReplayState();
  s.data = fakeData([7, 8, 9]);
  s.frame = 1;
  s.progress = 0.5;
  s.speed = 2;
  s.playing = true;
  s.tickStart = performance.now();
  updateReplayUI(s, els);
  assert.equal(els.rbTick.textContent, "8");
  assert.equal(els.rbMaxTick.textContent, "9");
  assert.ok(els.rbFill.style.width.endsWith("%"));
  assert.ok(els.rbCountdown.textContent.includes("s"));
  assert.equal(els.rbPlay.textContent, "⏸");
  assert.equal(els.rbSpeed.textContent, "×2");
  assert.equal(classes.has("at-end"), false);
  // 末帧且停播 → at-end
  s.frame = 2;
  s.playing = false;
  updateReplayUI(s, els);
  assert.equal(classes.has("at-end"), true);
  assert.equal(els.rbCountdown.textContent, "已到最新");
});

test("load: 成功置为从头播放并显示回放条；空数据/异常返回 null", async () => {
  const { els } = fakeEls();
  let calls = 0;
  const deps = fakeDeps(els, { getJSON: async () => { calls++; return { replay: fakeData([1, 2, 3]) }; } });
  const s = createReplayState();
  const r = await replayLoad(s, deps, "t1");
  assert.ok(r);
  assert.equal(s.loadedFor, "t1");
  assert.equal(s.playing, true);
  assert.equal(s.frame, 0);
  assert.equal(els.replayBar.hidden, false);
  assert.equal(calls, 1);

  const deps2 = fakeDeps(els, { getJSON: async () => ({ replay: { ticks: [] } }) });
  const s2 = createReplayState();
  assert.equal(await replayLoad(s2, deps2, "t1"), null);

  const deps3 = fakeDeps(els, { getJSON: async () => { throw new Error("boom"); } });
  const s3 = createReplayState();
  assert.equal(await replayLoad(s3, deps3, "t1"), null);
});
