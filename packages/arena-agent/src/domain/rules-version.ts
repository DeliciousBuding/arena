/**
 * Arena rules-version single source of truth shared by production + simulator.
 *
 * Production must never infer a protocol version from SDK shape or a simulator
 * fixture. Recognized historical versions are explicit; the live writer has one
 * current version and must fail closed when a config declares another one.
 */

export const SUPPORTED_RULES_VERSIONS = ["v0.11", "v0.14"] as const;
export type RulesVersion = (typeof SUPPORTED_RULES_VERSIONS)[number];

/** Current official rules version accepted by the production writer. */
export const PRODUCTION_RULES_VERSION: RulesVersion = "v0.14";

export function isRulesVersion(value: unknown): value is RulesVersion {
  return typeof value === "string" && (SUPPORTED_RULES_VERSIONS as readonly string[]).includes(value);
}

export function assertProductionRulesVersion(version: RulesVersion): void {
  if (version !== PRODUCTION_RULES_VERSION) {
    throw new Error(
      `runtime rulesVersion ${version} is recognized but not current production ${PRODUCTION_RULES_VERSION}`,
    );
  }
}
