/**
 * dotenv 多路径加载测试：repo .env / .env.local / 仓外 secrets 优先级与不覆盖语义。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv } from "../src/app/dotenv.ts";

const ENV_KEYS = ["TEST_DOTENV_A", "TEST_DOTENV_B", "TEST_DOTENV_C", "TEST_DOTENV_D"] as const;

test.beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

test("loads repo .env, .env.local and external secrets with first-wins precedence", () => {
  const dir = mkdtempSync(join(tmpdir(), "dotenv-test-"));
  mkdirSync(join(dir, ".secrets"), { recursive: true });
  writeFileSync(join(dir, ".env"), "TEST_DOTENV_A=from-env\nTEST_DOTENV_B=from-env\n");
  writeFileSync(join(dir, ".env.local"), "TEST_DOTENV_B=from-local\nTEST_DOTENV_C=from-local\n");
  writeFileSync(join(dir, ".secrets", "arena.env"), "TEST_DOTENV_D=from-secrets\n");

  const loaded = loadDotEnv(dir, join(dir, ".secrets", "arena.env"));

  assert.equal(process.env.TEST_DOTENV_A, "from-env");
  assert.equal(process.env.TEST_DOTENV_B, "from-env"); // .env 优先于 .env.local
  assert.equal(process.env.TEST_DOTENV_C, "from-local"); // .env.local 优先于 secrets
  assert.equal(process.env.TEST_DOTENV_D, "from-secrets"); // 全新 key 从 secrets 补上
  assert.equal(loaded.length, 3);

  rmSync(dir, { recursive: true, force: true });
});

test("does not override already-set process env", () => {
  const dir = mkdtempSync(join(tmpdir(), "dotenv-test-"));
  process.env.TEST_DOTENV_A = "already-set";
  writeFileSync(join(dir, ".env"), "TEST_DOTENV_A=from-file\n");

  loadDotEnv(dir, join(dir, ".secrets", "arena.env"));

  assert.equal(process.env.TEST_DOTENV_A, "already-set");

  rmSync(dir, { recursive: true, force: true });
});

test("external secrets file is used when repo .env is absent (public-repo scenario)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dotenv-test-"));
  mkdirSync(join(dir, ".secrets"), { recursive: true });
  writeFileSync(join(dir, ".secrets", "arena.env"), "TEST_DOTENV_B=from-secrets-only\n");

  const loaded = loadDotEnv(dir, join(dir, ".secrets", "arena.env"));

  assert.equal(process.env.TEST_DOTENV_B, "from-secrets-only");
  assert.deepEqual(loaded, [join(dir, ".secrets", "arena.env")]);

  rmSync(dir, { recursive: true, force: true });
});
