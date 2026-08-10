# Contributing

Thanks for contributing to Arena Hero.

## Development workflow

1. Create a focused branch or repository-local worktree.
2. Keep changes inside one architectural boundary whenever possible.
3. Add tests for behavior, contracts, persistence, parsing, or API changes.
4. Run the complete quality gate before requesting review.
5. Update public documentation when a supported interface or workflow changes.

```bash
pnpm install
pnpm -r check
pnpm -r test
pnpm run schema:check
```

## Design expectations

- Prefer deterministic, pure domain code; keep I/O at the adapters.
- Treat the shared contracts and generated schemas as the single source of truth.
- Do not mix behavior changes with strategy retuning in the same change.
- Preserve explicit uncertainty in differential results.

## Public content

Do not include credentials, production logs, private endpoints, workstation paths, or internal
coordination notes in issues, fixtures, documentation, or commits.
