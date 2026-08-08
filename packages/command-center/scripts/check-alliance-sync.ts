import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 联盟纯函数同步护栏（2026-08-08）
 * 单一源：packages/arena-agent/src/alliance/*（agent 线维护）
 * 镜像：  packages/command-center/lib/alliance/*（控制面独立运行，不依赖 agent 包）
 * 改任一测后须同步另一侧；本脚本 diff 兜底，漂移即 check:all 失败。
 */
const HERE = fileURLToPath(import.meta.url);
const CC = resolve(HERE, "..", ".."); // packages/command-center
const ROOT = resolve(CC, "..", ".."); // 仓库根
const A = join(ROOT, "packages", "command-center", "lib", "alliance");
const B = join(ROOT, "packages", "arena-agent", "src", "alliance");

const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();
let drift = 0, checked = 0;
for (const f of readdirSync(A).filter((x) => x.endsWith(".ts")).sort()) {
  const pa = join(A, f), pb = join(B, f);
  if (!existsSync(pb)) { console.log(`  ❌ ${f} — arena-agent 侧缺失`); drift++; continue; }
  checked++;
  if (norm(readFileSync(pa, "utf8")) !== norm(readFileSync(pb, "utf8"))) {
    console.log(`  ❌ ${f} — 内容漂移：command-center/lib/alliance 与 arena-agent/src/alliance 不同步`);
    drift++;
  }
}
if (drift) {
  console.error(`\n${drift} 个文件漂移。联盟纯函数单一源在 arena-agent/src/alliance，改动后需同步镜像到 command-center/lib/alliance（或后续抽共享包消除复制）。`);
  process.exit(1);
}
console.log(`✅ lib/alliance ${checked} 文件与 arena-agent/src/alliance 同步无漂移`);
