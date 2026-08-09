# Contracts testing

Run from the repository root:

```console
npm test -- --filter=@mcc/contracts
npm run typecheck -- --filter=@mcc/contracts
```

The package currently contains TypeScript-only contracts, so typechecking is
its primary validation.
