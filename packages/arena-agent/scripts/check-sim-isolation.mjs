#!/usr/bin/env node
/**
 * sim 隔离 checker（S1）：从结构上证明 src/sim/** 无线上提交能力。
 *
 * 检查内容：
 * 1. import 图闭包：递归解析 src/sim/** 与 src/cli/run-sim.ts 的所有 import；
 * 2. 危险目标：闭包内任何文件 import 到线上路径（client.ts / runtime loop /
 *    tenant-runtime / single-writer-lock / arena-hero-ts client）即失败；
 * 3. 危险标识：闭包文件文本中出现 fetch(/WebSocket/createServer/listen/
 *    端口/.env/dotenv/凭据名 即失败；
 * 4. 白名单：只允许 @arena/arena-hero-ts 的 type-only import。
 *
 * 用法：node scripts/check-sim-isolation.mjs [--self-test]
 * 退出码：0 = 隔离通过；1 = 失败；2 = self-test 失败。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");

const SIM_DIR = join(PKG_ROOT, "src", "sim");
const RUN_SIM = join(PKG_ROOT, "src", "cli", "run-sim.ts");
const CLIENT_ENTRY = join(REPO_ROOT, "packages", "arena-hero-ts", "src", "client.ts");

/** 危险 import 目标（解析到真实文件后匹配；相对 sim 的线上路径）。 */
const FORBIDDEN_IMPORT_FRAGMENTS = [
  "client.ts",
  "runtime/loop.ts",
  "tenant-runtime",
  "single-writer-lock",
];

/** 危险源码标识（文本扫描，import 闭包内所有文件）。 */
const FORBIDDEN_TOKENS = [
  "ArenaHeroClient",
  "fetch(",
  "WebSocket",
  "createServer",
  ".listen(",
  "8123",
  "8124",
  "8125",
  "8126",
  "dotenv",
  "process.env.API_KEY",
  "process.env.BASE_URL",
  "process.env.WEBSOCKET_URL",
];

/** 允许的裸包 import：arena-hero-ts 只允许 type-only。 */
const BARE_TYPE_ONLY = new Set(["@arena/arena-hero-ts"]);

function collectImports(filePath, seen) {
  if (seen.has(filePath) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return;
  }
  seen.add(filePath);
  const text = readFileSync(filePath, "utf8");
  const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s*)?["']([^"']+)["']/g;
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1];
    if (specifier.startsWith(".")) {
      const target = normalize(join(dirname(filePath), specifier));
      // tsx 允许省略后缀，但本仓库约定带后缀；两种都解析
      const candidates = [target, `${target}.ts`, `${target}.tsx`];
      const resolved = candidates.find((c) => existsSync(c));
      if (resolved !== undefined) {
        collectImports(resolved, seen);
      }
    }
    // bare specifier 不递归（node_modules 白名单校验在闭包外做）
  }
  return seen;
}

function classifyImports(files) {
  const issues = [];
  const textScan = [];
  const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s*)?["']([^"']+)["']/g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const token of FORBIDDEN_TOKENS) {
      if (text.includes(token)) {
        textScan.push({ file, token });
      }
    }
    // import 语句本身引用危险目标（即使路径无法解析也要拦——防伪造/未来文件）
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1];
      for (const frag of FORBIDDEN_IMPORT_FRAGMENTS) {
        if (specifier.includes(frag)) {
          issues.push({ file, detail: `import specifier "${specifier}" references forbidden target ${frag}` });
        }
      }
    }
    // 裸包 import：arena-hero-ts 必须 type-only
    const barePattern = /import\s+((?:type\s+)?)\{[^}]*\}\s+from\s+["'](@arena\/arena-hero-ts)["']/g;
    for (const match of text.matchAll(barePattern)) {
      if (match[1].trim() !== "type") {
        issues.push({ file, detail: `value import from ${match[2]} (only type-only allowed)` });
      }
    }
  }
  return { issues, textScan };
}

/** 递归收集目录下所有 .ts 文件（不跟随符号链接）。 */
function collectDirFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectDirFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function checkSimIsolation() {
  const files = new Set();
  for (const file of collectDirFiles(SIM_DIR)) {
    collectImports(file, files);
  }
  if (!existsSync(RUN_SIM)) {
    return { ok: false, errors: [`missing ${RUN_SIM}`] };
  }
  collectImports(RUN_SIM, files);

  const errors = [];
  for (const file of [...files].sort()) {
    const rel = relative(PKG_ROOT, file);
    if (file === CLIENT_ENTRY) {
      errors.push(`${rel}: imports arena-hero-ts client.ts`);
      continue;
    }
    const norm = file.replace(/\\/g, "/");
    for (const frag of FORBIDDEN_IMPORT_FRAGMENTS) {
      if (norm.endsWith(`/${frag}`) || norm.includes(`/src/${frag}`)) {
        errors.push(`${rel}: imports forbidden target ${frag}`);
      }
    }
    if (norm.includes("/src/sim/") && norm.includes("/src/arena_bot/")) {
      errors.push(`${rel}: imports python runtime path`);
    }
  }

  const { issues, textScan } = classifyImports([...files].sort());
  for (const issue of issues) {
    errors.push(`${relative(PKG_ROOT, issue.file)}: ${issue.detail}`);
  }
  for (const hit of textScan) {
    errors.push(`${relative(PKG_ROOT, hit.file)}: forbidden token "${hit.token}"`);
  }

  return { ok: errors.length === 0, errors, files: [...files].sort() };
}

function runSelfTest() {
  const dir = mkdtempSync(join(tmpdir(), "sim-isolation-"));
  try {
    const simDir = join(dir, "src", "sim");
    mkdirSync(simDir, { recursive: true });
    // 文件系统布局模仿包结构（isolation checker 需要 imports 相对解析）
    const evil = join(simDir, "evil.ts");
    writeFileSync(evil, 'import { ArenaHeroClient } from "../../../../../packages/arena-hero-ts/src/client.ts";\n');
    const files = new Set();
    for (const file of collectDirFiles(simDir)) {
      collectImports(file, files);
    }
    const { issues, textScan } = classifyImports([...files]);
    const specHit = issues.some((i) => i.detail.includes("client.ts"));
    const tokenHit = textScan.some((h) => h.token === "ArenaHeroClient");
    if (!specHit || !tokenHit) {
      console.error(
        `self-test: malicious import not detected (specHit=${specHit} tokenHit=${tokenHit} issues=${issues.length})`,
      );
      return false;
    }
    console.log("self-test: malicious client import + token both detected ✓");
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const selfTest = process.argv.includes("--self-test");
if (selfTest) {
  process.exit(runSelfTest() ? 0 : 2);
}

const result = checkSimIsolation();
if (result.ok) {
  console.log(`sim isolation OK (${result.files.length} files in import closure)`);
  process.exit(0);
}
console.error("sim isolation FAILED:");
for (const error of result.errors) {
  console.error(`  - ${error}`);
}
process.exit(1);
