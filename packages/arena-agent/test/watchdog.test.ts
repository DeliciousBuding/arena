/**
 * arena-watchdog.mjs 可测逻辑单测（算法更新计划 §4-W2）：
 * - worktree 相对路径解析：错误 worktree 路径必须报错退出而非静默跳过
 *   （v4 MSYS 路径静默失效教训）；存在路径解析正确（vbs v5 同款语义）。
 * - PowerShell 探测超时接线：默认 30s，超时/失败保守返回 true（视为监听中）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// @ts-ignore — 纯 JS 运维脚本（.mjs，无类型声明）；仅使用其导出的纯函数
import { probePort8120, resolveWorktreeRoot, shouldFullRecover } from "../../../scripts/arena-watchdog.mjs";

/** 构造临时 <worktree>/scripts 布局（测试用，调用方负责清理）。 */
function makeFakeWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "watchdog-test-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  return root;
}

test("resolveWorktreeRoot: 不存在的 worktree 路径 → 抛错（不静默返回）", () => {
  const missing = join(tmpdir(), "watchdog-no-such-worktree", "scripts");
  assert.throws(() => resolveWorktreeRoot(missing), /arena worktree not found/);
});

test("resolveWorktreeRoot: 存在的 <worktree>/scripts → 解析到 worktree 根", () => {
  const root = makeFakeWorktree();
  try {
    assert.equal(resolveWorktreeRoot(join(root, "scripts")), resolve(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probePort8120: 探测命令带默认 30s 超时且目标端口 8120", () => {
  let capturedArgs: string[] = [];
  let capturedOptions: { timeout?: number } = {};
  const fakeExec = (file: string, args: string[], options: { timeout?: number }): string => {
    assert.equal(file, "powershell");
    capturedArgs = args;
    capturedOptions = options;
    return "1\n";
  };
  assert.equal(probePort8120(fakeExec), true);
  assert.equal(capturedOptions.timeout, 30_000);
  assert.ok(capturedArgs.some((arg) => arg.includes("8120")));
});

test("probePort8120: 自定义超时透传到探测命令", () => {
  let capturedOptions: { timeout?: number } = {};
  const fakeExec = (_file: string, _args: string[], options: { timeout?: number }): string => {
    capturedOptions = options;
    return "0\n";
  };
  assert.equal(probePort8120(fakeExec, 5000), false);
  assert.equal(capturedOptions.timeout, 5000);
});

test("probePort8120: 探测失败（如超时）→ 保守返回 true（视为监听中）", () => {
  const throwingExec = (): never => {
    throw Object.assign(new Error("command timed out"), { code: "ETIMEDOUT" });
  };
  assert.equal(probePort8120(throwingExec), true);
});

test("shouldFullRecover: 全 ready → false（健康，不恢复）", () => {
  assert.equal(shouldFullRecover({ ready: true, tenants: [{ alive: true }, { alive: true }] }), false);
});

test("shouldFullRecover: ready=false 但有租户存活 → false（部分故障，supervisor 自愈中）", () => {
  assert.equal(
    shouldFullRecover({ ready: false, tenants: [{ alive: true }, { alive: false }] }),
    false,
  );
});

test("shouldFullRecover: ready=false 且全部租户 dead → true（整体故障）", () => {
  assert.equal(
    shouldFullRecover({ ready: false, tenants: [{ alive: false }, { alive: false }] }),
    true,
  );
});

test("shouldFullRecover: ready=false 且无 tenants 信息 → true（整体故障，按旧行为恢复）", () => {
  assert.equal(shouldFullRecover({ ready: false }), true);
});

test("shouldFullRecover: fetch 失败（null）→ true（supervisor 可能已死）", () => {
  assert.equal(shouldFullRecover(null), true);
});
