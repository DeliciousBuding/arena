import { isAbsolute, join, resolve } from "node:path";

/** Resolve ARENA_DATA_ROOT with CLI > environment > sibling ../data precedence. */
export function resolveArenaDataRoot(
  repoRoot: string,
  cliDataRoot?: string,
  environmentDataRoot?: string,
): string {
  const configuredDataRoot = nonEmpty(cliDataRoot) ?? nonEmpty(environmentDataRoot);
  if (configuredDataRoot === undefined) return resolve(repoRoot, "..", "data");
  return isAbsolute(configuredDataRoot)
    ? resolve(configuredDataRoot)
    : resolve(repoRoot, configuredDataRoot);
}

export function resolveArenaRuntimeRoot(dataRoot: string): string {
  return join(dataRoot, "runtime");
}

export function resolveTenantBaseDir(dataRoot: string, configuredBaseDir?: string): string {
  if (configuredBaseDir === undefined) return resolveArenaRuntimeRoot(dataRoot);
  return isAbsolute(configuredBaseDir)
    ? resolve(configuredBaseDir)
    : resolve(dataRoot, configuredBaseDir);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
