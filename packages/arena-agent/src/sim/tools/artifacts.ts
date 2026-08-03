/** Deterministic, atomic, output-bounded simulator artifact helpers (S9). */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function canonicalizeAt(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`canonical JSON rejects non-finite number at ${path}`);
    return value;
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new Error(`canonical JSON rejects sparse array at ${path}[${index}]`);
      output.push(canonicalizeAt(value[index], `${path}[${index}]`));
    }
    return output;
  }
  if (typeof value !== "object") {
    throw new Error(`canonical JSON rejects ${typeof value} at ${path}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`canonical JSON rejects non-plain object at ${path}`);
  }
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    output[key] = canonicalizeAt(source[key], `${path}.${key}`);
  }
  return output;
}

export function canonicalize(value: unknown): unknown {
  return canonicalizeAt(value, "$");
}

export function canonicalJson(value: unknown, pretty = true): string {
  return JSON.stringify(canonicalize(value), null, pretty ? 2 : 0) + "\n";
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Text(canonicalJson(value, false));
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function resolveInputPath(repoRoot: string, raw: string): string {
  return isAbsolute(raw) ? resolve(raw) : resolve(repoRoot, raw);
}

function isWithin(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

function nearestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`no existing ancestor for ${path}`);
    current = parent;
  }
  return current;
}

function assertRealAncestorWithin(base: string, candidate: string, label: string): void {
  const realBase = realpathSync(base);
  const existingAncestor = nearestExistingAncestor(candidate);
  const realAncestor = realpathSync(existingAncestor);
  if (!isWithin(realBase, realAncestor)) {
    throw new Error(`${label} escapes through symlink/junction: ${candidate}`);
  }
}

/** Output is strictly confined to <repo>/runs/sim or a descendant. */
export function resolveOutputBase(repoRoot: string, raw: string | null): string {
  if (raw !== null && isAbsolute(raw)) {
    throw new Error("output must be relative to repo root (absolute paths rejected: isolation policy)");
  }
  if (raw !== null && raw.split(/[\\/]+/u).includes("..")) {
    throw new Error("output path traversal rejected (.. not allowed)");
  }
  const base = resolve(repoRoot, "runs", "sim");
  const candidate = raw === null ? base : resolve(repoRoot, raw);
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) {
    throw new Error(`output must be under runs/sim (got ${raw ?? candidate})`);
  }
  const resolvedRepo = resolve(repoRoot);
  const realRepo = realpathSync(resolvedRepo);
  const baseAncestor = nearestExistingAncestor(base);
  if (!isWithin(realRepo, realpathSync(baseAncestor))) {
    throw new Error("runs/sim escapes repo through symlink/junction");
  }
  mkdirSync(base, { recursive: true });
  const realBase = realpathSync(base);
  if (!isWithin(realRepo, realBase)) {
    throw new Error("runs/sim escapes repo through symlink/junction");
  }
  assertRealAncestorWithin(base, candidate, "output path");
  return candidate;
}

export function validateRunId(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
    throw new Error("run-id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}");
  }
  return runId;
}

export function defaultRunId(kind: string, identity: unknown): string {
  return `${kind}-${sha256Json(identity).slice(0, 12)}`;
}

export function prepareRunDir(outputBase: string, runId: string, force: boolean): string {
  validateRunId(runId);
  const runDir = resolve(outputBase, runId);
  if (relative(outputBase, runDir).startsWith("..")) {
    throw new Error("run-id escaped output base");
  }
  assertRealAncestorWithin(outputBase, runDir, "run directory");
  if (existsSync(runDir)) {
    if (!force) throw new Error(`run directory already exists: ${runDir} (use --force to replace)`);
    rmSync(runDir, { recursive: true, force: true });
  }
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

export function atomicWriteText(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

export function atomicWriteJson(path: string, value: unknown): string {
  const content = canonicalJson(value);
  atomicWriteText(path, content);
  return sha256Text(content);
}

export function atomicWriteJsonl(path: string, values: readonly unknown[]): string {
  const content = values.map((value) => canonicalJson(value, false).trimEnd()).join("\n") + "\n";
  atomicWriteText(path, content);
  return sha256Text(content);
}
