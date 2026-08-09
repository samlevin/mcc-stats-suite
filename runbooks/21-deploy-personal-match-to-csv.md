# Deploy a personal dev stack

Use the dev account:

```console
direnv allow
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity
npm test --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv
npm run app:diff -- match-to-csv
npm run app:deploy -- match-to-csv
```

The wrapper derives the qualifier from `whoami`. Use `--instance <name>` only
when needed. Personal stacks do not receive email automatically; use the shared
dev deployment for end-to-end email testing.

Destroy the personal application when it is no longer useful:

```console
npm run app:destroy -- match-to-csv
```

Next: [`22-validate-match-to-csv-in-dev.md`](22-validate-match-to-csv-in-dev.md).
