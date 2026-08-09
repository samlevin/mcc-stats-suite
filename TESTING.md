# Repository testing

Install once and run every workspace from the repository root:

```console
npm ci
npm test
```

The full local quality gate is:

```console
npm run check
npm run tofu:fmt:check
```

Target one logical application with npm's workspace flag:

```console
npm test --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv
```

Current application guidance:

- [`applications/match-to-csv/TESTING.md`](applications/match-to-csv/TESTING.md)
- [`packages/cdk-config/TESTING.md`](packages/cdk-config/TESTING.md)

Future application scaffolds still participate in the root workspace checks but
are not part of the current deployment runbook.

`npm test` is AWS-free. CDK synth verifies infrastructure shape; AWS smoke
tests belong in development before promotion.
