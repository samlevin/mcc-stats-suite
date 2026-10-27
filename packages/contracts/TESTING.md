# Contracts testing

Run from the repository root:

```console
npm run build -- --filter=@mcc/contracts
npm run typecheck -- --filter=@mcc/contracts
```

The package contains only TypeScript types and has no tests, so it has no
`test` or `ci:test` script, and Turbo skips it for those tasks. Type checking
through `build` and `typecheck` is its validation, and consumers such as
`@mcc/match-to-csv` type-check against it in their own builds.
