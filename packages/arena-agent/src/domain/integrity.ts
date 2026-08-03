/** Format-independent canonical JSON integrity helpers. */

import { createHash } from "node:crypto";

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
  if (typeof value !== "object") throw new Error(`canonical JSON rejects ${typeof value} at ${path}`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`canonical JSON rejects non-plain object at ${path}`);
  }
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) throw new Error(`canonical JSON rejects undefined at ${path}.${key}`);
    output[key] = canonicalizeAt(source[key], `${path}.${key}`);
  }
  return output;
}

export function canonicalizeIntegrity(value: unknown): unknown {
  return canonicalizeAt(value, "$");
}

/** No pretty printing and no trailing newline: independent of artifact file formatting. */
export function canonicalIntegrityJson(value: unknown): string {
  return JSON.stringify(canonicalizeIntegrity(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalIntegrityJson(value), "utf8").digest("hex");
}
