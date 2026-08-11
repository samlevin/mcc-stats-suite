# Match-to-CSV testing

Run from the repository root:

```console
npm test --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv
```

The unit suite uses JSON Textract fixtures and does not call AWS. Before
promoting, ensure Docker is running so CDK packages Sharp for Lambda's Linux
ARM runtime. Set the locally ignored `MCC_EMAIL_DOMAIN` to the verified dev
domain and deploy the shared dev stack before personal instances. A personal
instance receives email at `submit+<name>@<MCC_EMAIL_DOMAIN>` and writes
artifacts under `instances/<name>/`. Its stack name is `match-to-csv-<name>`;
dots and punctuation in `whoami` are removed.

For an end-to-end test through the real email boundary, follow
[`22-validate-match-to-csv-in-dev.md`](../../runbooks/22-validate-match-to-csv-in-dev.md).
The shared development instance owns SES and EventBridge ingress.

Never use production email or player data in local fixtures.
