# Contracts testing

Run from the repository root:

```console
npm test -- --filter=@samlevin/contracts
npm run typecheck -- --filter=@samlevin/contracts
```

The package currently contains TypeScript-only contracts, so typechecking is
its primary validation.
