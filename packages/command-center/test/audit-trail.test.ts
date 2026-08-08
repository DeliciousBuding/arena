/**
 * 统一审计流水测试（2026-08-08）：
 * - normalize：四源（human/command/arbitration/supervisor）归一字段；
 * - merge：时间倒序 + tenant/source 过滤 + limit；
 * - 空数据兜底。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAuditTrails, mergeAuditTrails, type AuditTrailEntry } from "../lib/audit-trail.ts";
import type { HumanAuditEntry } from "../lib/human-audit.ts";

test("audit-trail: 四源归一 + 时间倒序 + 过滤", () => {
  const human: HumanAuditEntry[] = [
    { at: "2026-08-08T06:00:00.000Z", tenant: "t2", kind: "goal", action: "mine [1,2]", note: "手操", unitId: "u1" },
  ];
  const commands = {
    t1: [{ tenant: "t1", issuer: "codex", kind: "worker_mine", action: "accepted", evidence: { unitIds: ["u9"], target: [5, 6] }, ts: "2026-08-08T06:01:00.000Z" }],
  };
  const arbitrations = [
    { cell: "3,3", winnerTenant: "t3", note: "override", createdAt: "2026-08-08T06:02:00.000Z" },
    { cell: "4,4", winnerTenant: null, note: "clear", createdAt: "2026-08-08T06:03:00.000Z" },
  ];
  const supervisors = [
    { type: "ready", tenantId: "t4", at: "2026-08-08T06:04:00.000Z", pid: 123 },
  ];
  const norm = normalizeAuditTrails(human, commands, arbitrations, supervisors);
  assert.equal(norm.length, 5);
  const bySource = Object.fromEntries(norm.map((e) => [e.source, e]));
  assert.equal(bySource.human.kind, "goal");
  assert.equal(bySource.human.detail, "mine [1,2] — 手操");
  assert.equal(bySource.human.ref, "u1");
  assert.equal(bySource.command.detail, "accepted → [5,6] unit=1 issuer=codex");
  assert.equal(bySource.command.tenant, "t1");
  const arbs = norm.filter((e) => e.source === "arbitration");
  assert.equal(arbs[0].kind, "arbitrate");
  assert.equal(arbs[0].detail, "cell 3,3 → winner t3（override）");
  assert.equal(bySource.supervisor.kind, "ready");
  assert.equal(bySource.supervisor.detail, "ready pid=123");

  const merged = mergeAuditTrails(norm, {});
  assert.equal(merged.length, 5);
  // 倒序：supervisor(06:04) 最新在前
  assert.equal(merged[0].at, "2026-08-08T06:04:00.000Z");
  assert.equal(merged[4].at, "2026-08-08T06:00:00.000Z");

  const filtered = mergeAuditTrails(norm, { tenant: "t1", source: "command" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].source, "command");

  const limited = mergeAuditTrails(norm, { limit: 2 });
  assert.equal(limited.length, 2);
});

test("audit-trail: 空数据兜底 + clear 仲裁归一", () => {
  const norm = normalizeAuditTrails([], {}, [], []);
  assert.equal(norm.length, 0);
  const merged = mergeAuditTrails(norm, {});
  assert.equal(merged.length, 0);

  const clear = normalizeAuditTrails([], {}, [{ cell: "9,9", winnerTenant: null, createdAt: "2026-08-08T00:00:00.000Z" }], []);
  assert.equal(clear[0].kind, "arbitrate-clear");
  assert.equal(clear[0].detail, "cell 9,9 → winner auto");
});
