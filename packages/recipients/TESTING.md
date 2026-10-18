# Recipient list testing

Run from the repository root:

```console
npm test --workspace @mcc/recipients
npm run typecheck --workspace @mcc/recipients
```

The tests cover the recipient list fold, hash, address validation and change check of [spec 1.1 §4.5](../../specs/1.1-mcc-analytics-engine.md#45-csv-recipient-list): each fold integrity failure, the hash's key and sort order, and every refusal. They use `example.test` addresses only, never a real one. Coverage thresholds match `@mcc/roster`: the test command fails below 80 percent of lines, 65 percent of branches, or 60 percent of functions.

The package is pure, so the tests need no fakes and never call AWS.
