# Match-to-CSV testing

Run from the repository root:

```console
npm test --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv
```

The unit suite uses JSON Textract fixtures and does not call AWS. Before
deploying, ensure Docker is running so CDK packages Sharp for Lambda's Linux
ARM runtime. Set the locally ignored `MCC_EMAIL_DOMAIN` to the verified dev
domain. GitHub Actions deploys `match-to-csv-dev` before any ephemeral stack.
Deploy a local stack with `--ephemeral <name>`. One email may contain several
image attachments. Each accepted attachment becomes a `SCREENSHOT` source and
receives its own immutable processing run under its generated screenshot ID.

For an end-to-end test through the real email boundary, follow
[`22-validate-match-to-csv-in-dev.md`](../../runbooks/22-validate-match-to-csv-in-dev.md).
The plain dev stack owns the SES rule set and its default ingress rule. It
keeps the original image, raw Textract response, normalized observations,
processing manifest, append-only events, and extracted CSV in the evidence
bucket.

Never use production email or player data in local fixtures.
