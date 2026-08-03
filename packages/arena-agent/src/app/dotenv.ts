/**
 * dotenv 加载（切片 6 public 化安全）：多候选路径，密钥绝不入仓。
 *
 * 候选顺序（先到先用，不覆盖已存在的 env）：
 *   1. <repoRoot>/.env            （本地开发；.gitignore，public 化后通常不存在）
 *   2. <repoRoot>/.env.local      （本地开发覆盖层）
 *   3. ~/.secrets/arena.env       （用户级仓外 secrets；public 化清理后唯一来源）
 *
 * 返回实际加载的路径（调用方可打印/观测，绝不打印值）。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadDotEnv(repoRoot: string, secretsPath?: string): string[] {
  const candidates = [
    join(repoRoot, ".env"),
    join(repoRoot, ".env.local"),
    secretsPath ?? join(homedir(), ".secrets", "arena.env"),
  ];
  const loaded: string[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) {
      continue;
    }
    let lines: string[];
    try {
      lines = readFileSync(path, "utf-8").split(/\r?\n/);
    } catch {
      continue; // 读失败跳过（不阻塞启动）
    }
    let applied = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      if (process.env[key] === undefined) {
        process.env[key] = trimmed.slice(eq + 1);
        applied = true;
      }
    }
    if (applied) {
      loaded.push(path);
    }
  }
  return loaded;
}
