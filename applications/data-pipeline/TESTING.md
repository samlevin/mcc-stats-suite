# Data pipeline testing

Run from the repository root:

```console
npm test --workspace @mcc/data-pipeline
npm run app:synth -- data-pipeline
```

Keep transformation fixtures small and deterministic. Test Glue/DuckDB
business logic locally; reserve AWS integration tests for catalog, permissions,
and representative bronze-to-gold runs.
