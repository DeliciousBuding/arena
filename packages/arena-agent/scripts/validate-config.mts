/**
 * 生产租户配置变体解析验证（2026-08-07）：加载 runtime/configs/{t1..t4}.json，
 * 校验 schema + 解析 variants 的安全侧/确定性侧覆盖——改配置后先跑这个，
 * 确认变体声明合法（unknown id / 非法结构会在启动前 fail-fast）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/validate-config.mts [t1 t2 ...]
 */
import { loadRuntimeConfig } from "../src/app/runtime-config.ts";
import { resolveVariantsConfig, resolveDeterministicVariantsConfig } from "../src/strategies/variant-registry.ts";

const names = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ["t1", "t2", "t3", "t4"];

for (const name of names) {
  const cfg = loadRuntimeConfig(`D:/Code/Projects/arena/data/runtime/configs/${name}.json`);
  const safety = resolveVariantsConfig(cfg.variants);
  const det = resolveDeterministicVariantsConfig(cfg.variants);
  console.log(name, "OK variants=", JSON.stringify(cfg.variants), "safety=", JSON.stringify(safety), "det=", JSON.stringify(det));
}
