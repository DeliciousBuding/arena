/** 参谋建议层测试（2026-08-08）：buildResurveyAdvice——补测目标提升为可执行建议。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildResurveyAdvice } from "../lib/alliance-advice.ts";
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
