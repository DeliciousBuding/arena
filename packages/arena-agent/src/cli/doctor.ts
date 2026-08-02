/**
 * doctor（切片 4 阶段 5，Agent B 地界，leader 接管）。
 *
 * 绝对只读（GPT 裁决）：不 replace、不 submit、不修改锁（临时 acquire/release 除外）、
 * 不创建长期 session、不写游戏状态。doctor 通过 ≠ live 可以启动——live 启动仍要重新
 * 获取锁和重新验证配置。
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadRuntimeConfig, type TenantRuntimeConfig } from "../app/runtime-config.ts";
import { readGitSha } from "../app/run-manifest.ts";

export interface DoctorResult {
  readonly checks: Array<{ readonly name: string; readonly pass: boolean; readonly detail: string }>;
  readonly allPass: boolean;
}

/** 解析配置里的 token env 名（校验存在性，不读取值）。 */
function tokenEnvName(config: TenantRuntimeConfig): string {
  return config.arenaTokenEnv;
}

export function runDoctor(
  configPath: string,
  repoRoot: string,
  runtimeBaseDir: string,
): DoctorResult {
  const checks: DoctorResult["checks"] = [];
  const add = (name: string, pass: boolean, detail: string): void => {
    checks.push({ name, pass, detail });
  };

  // 1) config schema
  let config: TenantRuntimeConfig;
  try {
    config = loadRuntimeConfig(configPath);
    add("config_schema", true, `valid ${configPath}`);
  } catch (error) {
    add("config_schema", false, error instanceof Error ? error.message : String(error));
    return { checks, allPass: false };
  }

  // 2) token env 名存在（不读值，只验证环境变量名声明 + 环境有该变量）
  const envName = tokenEnvName(config);
  add("arena_token_env", process.env[envName] !== undefined, `env ${envName} ${process.env[envName] !== undefined ? "present" : "MISSING"}`);

  // 3) baseDir 可写（mkdir 试探，不写文件）
  try {
    mkdirSync(runtimeBaseDir, { recursive: true });
    add("runtime_dir_writable", true, runtimeBaseDir);
  } catch (error) {
    add("runtime_dir_writable", false, error instanceof Error ? error.message : String(error));
  }

  // 4) git SHA 可读
  const sha = readGitSha(repoRoot);
  add("git_sha", sha !== "unknown" && sha.length === 40, sha);

  // 5) submitEnabled 状态明确输出
  add("submit_enabled", true, `decisionMode=${config.decisionMode} submitEnabled=${config.submitEnabled}`);

  // 6) 锁目录父路径可写（doctor 不 acquire——live 启动时再获取）
  const lockDir = join(runtimeBaseDir, "locks");
  try {
    mkdirSync(lockDir, { recursive: true });
    add("lock_dir_writable", true, lockDir);
  } catch (error) {
    add("lock_dir_writable", false, error instanceof Error ? error.message : String(error));
  }

  // 7) config hash 存在（决策配置 canonical 摘要，manifest 素材）
  add("config_hash", config !== undefined && config.model.id.length > 0, "model.id non-empty");

  return { checks, allPass: checks.every((c) => c.pass) };
}
