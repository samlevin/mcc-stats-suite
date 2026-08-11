# Deploy an ephemeral match-to-csv stack

Use the dev account and choose a lowercase ephemeral name:

```console
direnv allow
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity
npm test --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv --environment dev --ephemeral <name>
npm run verify:bundle --workspace @mcc/match-to-csv
npm run app:diff -- match-to-csv --environment dev --ephemeral <name>
npm run app:deploy -- match-to-csv --environment dev --ephemeral <name>
```

Set `MCC_EMAIL_DOMAIN` only in ignored local configuration. GitHub Actions must deploy the plain dev stack before an ephemeral stack because the plain stack owns the SES rule set.

Remove the application when it is no longer needed:

```console
npm run app:destroy -- match-to-csv --environment dev --ephemeral <name>
```

Continue with [22-validate-match-to-csv-in-dev.md](22-validate-match-to-csv-in-dev.md).
