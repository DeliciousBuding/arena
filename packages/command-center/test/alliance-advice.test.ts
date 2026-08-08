/** 参谋建议层测试（2026-08-08）：buildResurveyAdvice——补测目标提升为可执行建议。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildResurveyAdvice, buildGoldMineAdvice } from "../lib/alliance-advice.ts";
import type { ResurveyTarget } from "../lib/exploration-coverage.ts";

const t = (key: string, near: string, stale: number, dist: number): ResurveyTarget => ({
  key, cx: 0, cy: 0, lastSeenTick: 70000 - stale, stalenessTicks: stale, nearCoreOf: near, distChunks: dist, corePos: [0, 0],
});

test("alliance-advice: 补测目标——按租户聚合 + 陈旧度排序 + 每租户 ≤3", () => {
  const targets = [
    t("-13,75", "t2", 12000, 2),
    t("-14,73", "t2", 15000, 3),
    t("-15,74", "t2", 9000, 1),
    t("10,10", "t1", 8000, 1),
    t("10,11", "t1", 7000, 2),
    t("10,12", "t1", 6000, 3),
    t("10,13", "t1", 5000, 4),
    t("10,14", "t1", 4000, 5),
  ];
  const adv = buildResurveyAdvice(targets);
  const t2 = adv.find((a) => a.tenant === "t2");
  const t1 = adv.find((a) => a.tenant === "t1");
  assert.ok(t2 && t2.title.includes("3 块旧观测区待补测"), "t2 聚合 3 块");
  assert.ok(t2 && t2.title.includes("陈旧 15000 tick"), "t2 取最旧陈旧度");
  assert.ok(t2 && t2.detail.includes("-14,73"), "t2 最旧格");
  assert.ok(t2 && t2.category === "INTEL", "INTEL 类别");
  assert.equal(t2.severity, "MEDIUM", "陈旧 ≥5000 → MEDIUM（避免被 15 条上限挤出）");
  assert.ok(t1 && t1.title.includes("3 块旧观测区待补测"), "t1 每租户上限 3（8 目标只取 3）");
});

test("alliance-advice: 补测建议空兜底", () => {
  assert.deepEqual(buildResurveyAdvice([]), [], "空输入 → 空数组");
});

test("alliance-advice: 金牌矿建议——byAmount 榜首值得守/抢", () => {
  const tenants = {
    t1: { topMines: { byAmount: [{ cell: "-632,-145", x: -632, y: -145, harvestAmount: 3, harvestOk: 3 }] } },
    t2: { topMines: { byAmount: [{ cell: "-37,75", x: -37, y: 75, harvestAmount: 5, harvestOk: 2 }] } },
    t3: { topMines: { byAmount: [] } },
  };
  const adv = buildGoldMineAdvice(tenants);
  assert.equal(adv.length, 2, "t1/t2 各一条，t3 无榜首跳过");
  const t2 = adv.find((a) => a.tenant === "t2");
  assert.ok(t2 && t2.title.includes("金牌矿 -37,75"), "金牌矿标题含格");
  assert.ok(t2 && t2.title.includes("累计收益 5"), "收益金额");
  assert.ok(t2 && t2.category === "INTEL" && t2.severity === "MEDIUM", "INTEL/MEDIUM（高价值防挤出）");
  assert.ok(t2 && t2.action.includes("守护"), "动作含守护");
  assert.deepEqual(buildGoldMineAdvice({}), [], "空输入 → 空数组");
  assert.deepEqual(buildGoldMineAdvice({ t1: { topMines: { byAmount: [{ cell: "1,1", harvestAmount: 0 }] } } }), [], "收益 0 → 跳过");
});
