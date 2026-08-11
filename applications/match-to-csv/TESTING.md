# Match-to-CSV testing

Run from the repository root:

```console
npm test --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv
```

The unit suite uses JSON Textract fixtures and does not call AWS. Before
promoting, ensure Docker is running so CDK packages Sharp for Lambda's Linux
ARM runtime. Set the locally ignored `MCC_EMAIL_DOMAIN` to the verified dev
domain. GitHub Actions deploys `match-to-csv-dev` before any ephemeral stack.
Deploy a local stack with `--ephemeral <name>`. It receives email at
`submit+<name>@<MCC_EMAIL_DOMAIN>` and writes artifacts under
`ephemeral/<name>/`.

For an end-to-end test through the real email boundary, follow
[`22-validate-match-to-csv-in-dev.md`](../../runbooks/22-validate-match-to-csv-in-dev.md).
The plain dev stack owns the SES rule set and its default ingress rule.

Never use production email or player data in local fixtures.
