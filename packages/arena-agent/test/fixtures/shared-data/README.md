# Bundled shared-data CI mirror

This directory is a **pinned test/CI mirror**, not the shared-schema source of truth.

- Source of truth in the coordinated workspace: `../data/schema/` (`ARENA_DATA_ROOT/schema`).
- Purpose here: let the standalone `arena` repository run tests and `schema:check` on GitHub Actions, where the private coordination sibling is intentionally absent.
- `scripts/check-shared-schemas.mjs` uses the external coordination schemas when available and byte-compares them with this mirror before validation. If the external sibling is absent, it falls back to this mirror.
- Do not edit these JSON files independently. Update the coordination schemas first, then copy the complete schema/fixture set here and run `npm run schema:check` from a coordinated workspace.

The Arena Python SDK is **not** mirrored here. CI checks out the public SDK at the exact commit pinned by the rules manifest and exposes it through `ARENA_SDK_MIRROR_DIR`.