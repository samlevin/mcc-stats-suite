# Deploy an ephemeral match-to-csv stack

Use the dev account:

```console
direnv allow
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity
npm test --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv --ephemeral sam
npm run app:diff -- match-to-csv --ephemeral sam
npm run app:deploy -- match-to-csv --ephemeral sam
```

Set the locally ignored `MCC_EMAIL_DOMAIN` to the verified dev domain before
deployment. GitHub Actions must deploy the plain dev stack first. Each
ephemeral stack receives mail at `submit+sam@<MCC_EMAIL_DOMAIN>`.

Destroy the personal application when it is no longer useful:

```console
npm run app:destroy -- match-to-csv --ephemeral sam
```

Next: [`22-validate-match-to-csv-in-dev.md`](22-validate-match-to-csv-in-dev.md).
