/**
 * 共享测绘人工仲裁存储测试（2026-08-08，冲突闭环）：
 * - appendArbitration 落盘 JSONL + loadArbitrations 按 cell 取最后生效；
 * - clearArbitration 追加 null winner（回自动规则）；
 * - 坏行容错。
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendArbitration, clearArbitration, listArbitrations, loadArbitrations } from "../lib/arbitration.ts";

test("arbitration: 追加式 JSONL——同 cell 最后一条生效，override/clear 交替", () => {
  const root = mkdtempSync(join(tmpdir(), "arb-"));
  try {
    appendArbitration({ cell: "-30,51", winnerTenant: "t2", note: "t2 占矿", createdAt: "t1" }, root);
    appendArbitration({ cell: "-30,51", winnerTenant: "t3", note: "改判 t3", createdAt: "t2" }, root);
    const m = loadArbitrations(root);
    assert.equal(m.get("-30,51")?.winnerTenant, "t3", "同 cell 最后一条生效");
    assert.equal(m.size, 1);
    // clear：回自动规则
    clearArbitration("-30,51", root);
    const m2 = loadArbitrations(root);
    assert.equal(m2.get("-30,51")?.winnerTenant, null, "clear 后 winner 为 null（自动规则）");
    assert.equal(listArbitrations(root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("arbitration: 坏行容错 + 多 cell 独立", () => {
  const root = mkdtempSync(join(tmpdir(), "arb2-"));
  try {
    const dir = join(root, "runtime", "survey");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "arbitration.jsonl"), [
      "{ bad json",
      JSON.stringify({ cell: "1,2", winnerTenant: "t1", createdAt: "a" }),
      JSON.stringify({ cell: "3,4", winnerTenant: "t4", createdAt: "b" }),
      "",
    ].join("\n"), "utf8");
    const m = loadArbitrations(root);
    assert.equal(m.size, 2, "坏行跳过，合法行保留");
    assert.equal(m.get("1,2")?.winnerTenant, "t1");
    assert.equal(m.get("3,4")?.winnerTenant, "t4");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
