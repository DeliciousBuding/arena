/** W1 Golden Replay：真实 raw-state fixture 解析验证。
 *
 * fixture 来自 Python burn-in 的 raw-state dump（脱敏：owner_username
 * 替换为 fixture_user），包成 state envelope 走完整解析链路。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseStreamMessage } from "../src/protocol.ts";
import { ProtocolError } from "../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "contracts", "fixtures", "raw-ws");

function fixtureFiles(): string[] {
  try {
    return readdirSync(FIXTURES).filter((f) => f.startsWith("state-") && f.endsWith(".json"));
  } catch {
    return [];
  }
}

const files = fixtureFiles();

test("fixture 存在（burn-in raw-state 已收集）", () => {
  assert.ok(files.length >= 1, `无 fixture：${FIXTURES}`);
});

for (const file of files) {
  test(`Golden Replay: ${file} 完整解析 + 关键字段`, () => {
    const raw = JSON.parse(readFileSync(join(FIXTURES, file), "utf-8"));
    // 包成 state envelope（与 WS 线上格式一致）
    const envelope = JSON.stringify({ type: "state", data: raw });
    const state = parseStreamMessage(envelope);
    assert.ok("status" in state, "expected PlayerState");

    assert.equal(state.status, "ACTIVE");
    assert.ok(Number.isInteger(state.resources) && state.resources >= 0);
    assert.ok(Number.isInteger(state.population) && state.population >= 0);
    assert.ok(Array.isArray(state.objects));
    assert.ok(Array.isArray(state.events));
    assert.ok(Array.isArray(state.champion_beacon.position));

    // 脱敏检查：真实 username 不得出现（fixture_user 替换生效）
    const text = JSON.stringify(raw);
    assert.ok(!/buding|delicious/i.test(text), "fixture 不应含真实 username");

    // 对象结构一致性
    for (const obj of state.objects) {
      assert.ok(
        obj.kind === "OBSTACLE" || obj.kind === "RESOURCE" ||
        obj.kind === "CORE" || obj.kind === "UNIT",
      );
      if (obj.kind === "UNIT" || obj.kind === "CORE") {
        assert.ok(Number.isInteger(obj.hp) && obj.hp >= 0);
        assert.ok(Array.isArray(obj.position) && obj.position.length === 2);
      }
    }
  });
}

test("Golden Replay: 非 ACTIVE/RESPAWNING status 拒绝（wire 校验）", () => {
  const file = files[0];
  if (!file) {
    return; // 无 fixture 时跳过
  }
  const raw = JSON.parse(readFileSync(join(FIXTURES, file), "utf-8"));
  raw.status = "HACKER";
  const envelope = JSON.stringify({ type: "state", data: raw });
  assert.throws(() => parseStreamMessage(envelope), ProtocolError);
});
