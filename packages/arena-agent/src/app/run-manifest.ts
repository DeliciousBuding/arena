/**
 * 运行 manifest（切片 4 阶段 5，Agent B 地界，leader 接管）。
 *
 * 每次启动写 runs/<processRunId>/manifest.json，固定运行环境可复现：
 * processRunId/gitSha/piVersion/sdkVersion/tenantId/mode/submitEnabled/model/provider/
 * rulesVersion/configHash/startedAt。**绝不写任何密钥。**
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

export interface RunManifest {
  readonly processRunId: string;
  readonly gitSha: string;
  readonly piVersion: string;
  readonly sdkVersion: string;
  readonly tenantId: string;
  readonly decisionMode: string;
  readonly submitEnabled: boolean;
  readonly modelId: string;
  readonly provider: string;
  readonly rulesVersion: string;
  readonly configHash: string;
  readonly startedAt: string;
}

/** 新 processRunId（每次启动一个）。 */
export function newProcessRunId(): string {
  return randomUUID();
}

/** 读取 git SHA；失败降级 "unknown"（不抛——doctor 会单独报告）。 */
export function readGitSha(repoRoot: string): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

/** SDK 版本：从 @arena/arena-hero-ts 包入口读 package.json（拿不到降级 "unknown"）。 */
export function readSdkVersion(packageDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** 写 manifest（目录自动建）。 */
export function writeRunManifest(
  runDir: string,
  manifest: RunManifest,
): string {
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, "manifest.json");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return path;
}

/** 读回 manifest（用于进程内核对）。 */
export function readRunManifest(runDir: string): RunManifest {
  return JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf-8")) as RunManifest;
}
