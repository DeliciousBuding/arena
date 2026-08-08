/** Release/config compatibility gate. No network, secrets or writer locks. */

import { resolve } from "node:path";
import { compileRuntimeStrategyFile } from "../src/app/strategy-config.ts";

function valueOf(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const configRoot = resolve(valueOf("config-root") ?? resolve(process.cwd(), "..", "..", "data", "runtime", "configs"));
const configs = (valueOf("configs") ?? "t1,t2,t3,t4")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => value.endsWith(".json") ? value : `${value}.json`);

if (configs.length === 0) throw new Error("--configs must contain at least one config name");

const tenants = configs.map((name) => {
  const compiled = compileRuntimeStrategyFile(resolve(configRoot, name));
  return {
    tenantId: compiled.config.tenantId,
    config: name,
    configHash: compiled.configHash,
    strategyHash: compiled.strategyHash,
    restartHash: compiled.restartHash,
    variants: compiled.variants,
  };
});

const duplicateTenant = tenants.find((row, index) => tenants.findIndex((candidate) => candidate.tenantId === row.tenantId) !== index);
if (duplicateTenant !== undefined) throw new Error(`duplicate tenantId in config set: ${duplicateTenant.tenantId}`);

process.stdout.write(`${JSON.stringify({ ok: true, configRoot, tenants }, null, 2)}\n`);
