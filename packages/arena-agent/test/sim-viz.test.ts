/**
 * arena-bench-v1 可视化模块测试：五维画像计算器（agent-profile）+
 * SVG 渲染器（heatmap/radar/bars）的数值正确性与输出契约。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeAgentProfile, normalizeProfiles, type AgentProfile } from "../src/sim/viz/agent-profile.ts";
import { barsSvg, heatmapSvg, radarSvg } from "../src/sim/viz/svg.ts";
import type { PlayerCostLedger } from "../src/sim/harness/episode.ts";

function makeLedger(overrides: Partial<PlayerCostLedger> = {}): PlayerCostLedger {
  return {
    harvested: 0,
    deposited: 0,
    damageDealt: 0,
    beaconTicks: 0,
    respawnCount: 0,
    unitsLost: 0,
    healCost: 0,
    repairCost: 0,
    spawnCost: 0,
    overflowDestroyed: 0,
    resourcesLost: 0,
    finalPopulation: 0,
    finalResources: 0,
    aliveTicks: 0,
    populationPeak: 0,
    eventCounts: { movement: 0, combat: 0, economy: 0, beacon: 0, respawn: 0 },
    unrecognizedEventCount: 0,
    decisionTimeouts: 0,
    ...overrides,
  };
}

test("computeAgentProfile: 已知 ledger 的五个维度数值正确", () => {
  const ledger = makeLedger({
    harvested: 100,
    damageDealt: 40,
    unitsLost: 8,
    beaconTicks: 20,
    aliveTicks: 50,
    finalPopulation: 6,
  });
  const profile = computeAgentProfile(ledger, 100);
  assert.equal(profile.economy, 2, "economy = harvested / aliveTicks");
  assert.equal(profile.military, 5, "military = damageDealt / unitsLost");
  assert.equal(profile.survival, 0.5, "survival = aliveTicks / totalTicks");
  assert.equal(profile.beacon, 0.4, "beacon = beaconTicks / aliveTicks");
  assert.equal(profile.expansion, 6, "expansion = finalPopulation");
});

test("computeAgentProfile: aliveTicks=0 时经济/信标/存活取 0（不 NaN）", () => {
  const ledger = makeLedger({
    harvested: 100,
    damageDealt: 30,
    beaconTicks: 40,
    aliveTicks: 0,
    unitsLost: 0,
    finalPopulation: 3,
  });
  const profile = computeAgentProfile(ledger, 200);
  assert.equal(profile.economy, 0);
  assert.equal(profile.beacon, 0);
  assert.equal(profile.survival, 0);
  assert.equal(profile.military, 30, "military 用 max(unitsLost,1) 分母，unitsLost=0 时=damageDealt");
  assert.equal(profile.expansion, 3);
  assert.ok(Object.values(profile).every(Number.isFinite), "全维度有限");
});

test("computeAgentProfile: totalTicks=0 时存活取 0", () => {
  const ledger = makeLedger({ aliveTicks: 5 });
  const profile = computeAgentProfile(ledger, 0);
  assert.equal(profile.survival, 0);
  assert.ok(Number.isFinite(profile.survival));
});

test("normalizeProfiles: 常规 min-max 归一化精确值", () => {
  const profiles: Record<string, AgentProfile> = {
    a: { economy: 10, military: 5, survival: 0.5, beacon: 0.2, expansion: 4 },
    b: { economy: 30, military: 5, survival: 0.25, beacon: 0.8, expansion: 8 },
  };
  const out = normalizeProfiles(profiles);
  // economy: [10,30] → [0,1]；0 被地板抬到 0.05
  assert.equal(out.a.economy, 0.05);
  assert.equal(out.b.economy, 1);
  // military: min==max → 全 1
  assert.equal(out.a.military, 1);
  assert.equal(out.b.military, 1);
  // survival: [0.25,0.5] spread 0.25 → a=1, b=0→地板
  assert.equal(out.a.survival, 1);
  assert.equal(out.b.survival, 0.05);
  // beacon: [0.2,0.8] spread 0.6 → a=0→地板, b=1
  assert.equal(out.a.beacon, 0.05);
  assert.equal(out.b.beacon, 1);
  // expansion: [4,8] → a=0→地板, b=1
  assert.equal(out.a.expansion, 0.05);
  assert.equal(out.b.expansion, 1);
});

test("normalizeProfiles: 中间值不被地板误伤", () => {
  const profiles: Record<string, AgentProfile> = {
    a: { economy: 10, military: 0, survival: 0, beacon: 0, expansion: 0 },
    b: { economy: 30, military: 0, survival: 0, beacon: 0, expansion: 0 },
  };
  const out = normalizeProfiles(profiles);
  // (15-10)/20 = 0.25 > 0.05，不被抬升
  const mid = normalizeProfiles({
    ...profiles,
    c: { economy: 15, military: 0, survival: 0, beacon: 0, expansion: 0 },
  });
  assert.equal(mid.c.economy, 0.25);
  assert.ok(out.a.economy === 0.05 && out.b.economy === 1);
});

test("normalizeProfiles: min==max 时该维全 1", () => {
  const profiles: Record<string, AgentProfile> = {
    a: { economy: 7, military: 3, survival: 0.9, beacon: 0.6, expansion: 5 },
    b: { economy: 7, military: 3, survival: 0.9, beacon: 0.6, expansion: 5 },
  };
  const out = normalizeProfiles(profiles);
  for (const id of ["a", "b"]) {
    for (const dim of ["economy", "military", "survival", "beacon", "expansion"] as const) {
      assert.equal(out[id][dim], 1, `${id}.${dim} min==max 全 1`);
    }
  }
});

test("normalizeProfiles: 全 0 输入不产生 NaN（min==max → 全 1）", () => {
  const profiles: Record<string, AgentProfile> = {
    a: { economy: 0, military: 0, survival: 0, beacon: 0, expansion: 0 },
    b: { economy: 0, military: 0, survival: 0, beacon: 0, expansion: 0 },
  };
  const out = normalizeProfiles(profiles);
  for (const id of ["a", "b"]) {
    const profile = out[id];
    assert.ok(Object.values(profile).every((v) => Number.isFinite(v)), `${id} 无 NaN`);
    assert.equal(profile.economy, 1);
    assert.equal(profile.military, 1);
    assert.equal(profile.survival, 1);
    assert.equal(profile.beacon, 1);
    assert.equal(profile.expansion, 1);
  }
});

test("normalizeProfiles: 空输入返回空对象", () => {
  assert.deepEqual(normalizeProfiles({}), {});
});

test("normalizeProfiles: 单 agent 全维 1（自 min==max）", () => {
  const profiles: Record<string, AgentProfile> = {
    solo: { economy: 2, military: 9, survival: 0.4, beacon: 0.1, expansion: 11 },
  };
  const out = normalizeProfiles(profiles);
  for (const dim of ["economy", "military", "survival", "beacon", "expansion"] as const) {
    assert.equal(out.solo[dim], 1);
  }
});

test("heatmapSvg: 完整 svg 文档 + 轴标签 + 百分比 + 色阶", () => {
  const svg = heatmapSvg({
    agents: ["alpha", "beta"],
    cell: (row, col) => {
      if (row === col) {
        return { value: 0.5, label: "self" };
      }
      return { value: 0.8, label: "wins 8/10" };
    },
  });
  assert.ok(svg.startsWith("<svg"), "以 <svg 开头");
  assert.ok(svg.endsWith("</svg>"), "以 </svg> 结尾");
  assert.ok(svg.includes("alpha"), "行/列轴标签 alpha");
  assert.ok(svg.includes("beta"), "行/列轴标签 beta");
  assert.ok(svg.includes("80.0%"), "格子百分比 1 位小数");
  assert.ok(svg.includes("50.0%"), "对角线渲染层强制 0.5");
  assert.ok(svg.includes("wins 8/10"), "格子辅助 label");
  assert.ok(svg.includes("#d73a49"), "色阶红端");
  assert.ok(svg.includes("#e3b341"), "色阶琥珀中端");
  assert.ok(svg.includes("#3fb950"), "色阶绿端");
  assert.ok(svg.includes("100%"), "图例 100%");
  assert.ok(!svg.includes("NaN") && !svg.includes("undefined"), "无 NaN/undefined 串");
});

test("heatmapSvg: 非对角线越界值被 clamp 到 0-1", () => {
  const svg = heatmapSvg({
    agents: ["a", "b"],
    cell: () => ({ value: 3, label: "" }),
  });
  assert.ok(svg.includes("100.0%"), "3 → clamp 100%");
});

test("heatmapSvg: XML 转义防注入", () => {
  const svg = heatmapSvg({
    agents: ["a&b", "c<d"],
    cell: () => ({ value: 0.1, label: "" }),
  });
  assert.ok(svg.includes("a&amp;b"), "& 转义");
  assert.ok(svg.includes("c&lt;d"), "< 转义");
  assert.ok(!svg.includes("NaN") && !svg.includes("undefined"));
});

test("radarSvg: 完整 svg + 中文五轴名 + title + 透明度填充", () => {
  const profile: AgentProfile = {
    economy: 1,
    military: 0.5,
    survival: 0.25,
    beacon: 0,
    expansion: 0.9,
  };
  const svg = radarSvg({ title: "Alpha 画像", profile, color: "#123456" });
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.endsWith("</svg>"));
  assert.ok(svg.includes("Alpha 画像"), "title");
  for (const axis of ["经济", "军事", "生存", "信标", "扩张"]) {
    assert.ok(svg.includes(axis), `中文轴名 ${axis}`);
  }
  assert.ok(svg.includes("fill=\"#123456\""), "显式颜色填充");
  assert.ok(svg.includes("stroke=\"#123456\""), "显式颜色描边");
  assert.ok(svg.includes("fill-opacity=\"0.3\""), "填充 30% 透明度");
  assert.ok(svg.includes("100.0%"), "economy 100%");
  assert.ok(svg.includes("50.0%"), "military 50%");
  assert.ok(svg.includes("25.0%"), "survival 25%");
  assert.ok(svg.includes("0.0%"), "beacon 0%");
  assert.ok(svg.includes("90.0%"), "expansion 90%");
  assert.ok(!svg.includes("NaN") && !svg.includes("undefined"));
});

test("radarSvg: 缺省颜色按 title 哈希从调色板选取", () => {
  const palette = ["#58a6ff", "#3fb950", "#f78166", "#d2a8ff", "#e3b341", "#79c0ff", "#ff7b72", "#56d4dd"];
  const svg = radarSvg({ title: "t1", profile: { economy: 0.5, military: 0.5, survival: 0.5, beacon: 0.5, expansion: 0.5 } });
  assert.ok(palette.some((c) => svg.includes(`fill="${c}"`)), "缺省颜色在调色板内");
  const again = radarSvg({ title: "t1", profile: { economy: 0.5, military: 0.5, survival: 0.5, beacon: 0.5, expansion: 0.5 } });
  assert.equal(again, svg, "同 title 稳定同色");
});

test("barsSvg: 完整 svg + label + 数值标签 + detail 小字", () => {
  const svg = barsSvg({
    title: "资源效率排行",
    items: [
      { label: "alpha", value: 0.75, detail: "harvest 3000 / alive 4000" },
      { label: "beta", value: 0.1 },
    ],
  });
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.endsWith("</svg>"));
  assert.ok(svg.includes("资源效率排行"), "title");
  assert.ok(svg.includes("alpha"), "label");
  assert.ok(svg.includes("beta"), "label");
  assert.ok(svg.includes("75.0%"), "数值标签");
  assert.ok(svg.includes("10.0%"), "数值标签 0.1");
  assert.ok(svg.includes("harvest 3000 / alive 4000"), "detail 小字");
  assert.ok(svg.includes("url(#bar-grad)"), "渐变柱填充");
  assert.ok(!svg.includes("NaN") && !svg.includes("undefined"));
});

test("barsSvg: 越界值 clamp + 空 items 仍产出合法 svg", () => {
  const clamped = barsSvg({ title: "t", items: [{ label: "x", value: 2 }] });
  assert.ok(clamped.includes("100.0%"), "2 → clamp 100%");
  const empty = barsSvg({ title: "t", items: [] });
  assert.ok(empty.startsWith("<svg") && empty.endsWith("</svg>"));
  assert.ok(!empty.includes("NaN") && !empty.includes("undefined"));
});
