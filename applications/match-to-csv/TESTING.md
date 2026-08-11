# Match-to-CSV testing

Run local checks from the repository root:

```console
npm run typecheck --workspace @mcc/match-to-csv
npm test --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv --environment dev
npm run verify:bundle --workspace @mcc/match-to-csv
```

Unit tests replace mail parsing, image inspection, Textract, and evidence writes with local fakes. They do not call AWS. Coverage thresholds fail the test command when statement or line coverage drops below 80 percent, branch coverage drops below 65 percent, or function coverage drops below 60 percent.

CDK synthesis uses Docker to install Sharp for Linux ARM64. `verify:bundle` inspects the synthesized `ProcessEmail` and `ExtractText` assets and fails if either is missing the native Sharp binary.

Use [22-validate-match-to-csv-in-dev.md](../../runbooks/22-validate-match-to-csv-in-dev.md) for a future AWS integration test. Never commit recipient configuration, domain configuration, production messages, or player data as fixtures.
