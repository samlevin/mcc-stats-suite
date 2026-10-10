# Check prerequisites

## Accounts

You need two AWS accounts, `dev` and `prod`, and an IAM Identity Center administrator permission set in each. Any account structure works. [samlevin/aws-bootstrap](https://github.com/samlevin/aws-bootstrap) describes one way to build it.

Pick a workload Region that supports SES email receiving. `match-to-csv` also needs a domain with a verified SES identity and an MX record pointing at SES in that Region.

## Tools

Install the versions pinned in [`.tool-versions`](../../.tool-versions), plus:

- AWS CLI v2 with IAM Identity Center profiles
- `direnv`
- Docker, for CDK assets with Linux ARM64 native dependencies

## SSO profiles

Create an SSO profile for each account and permission set you use. Keep `dev` or `prod` in each profile name. `scripts/cdk-app.mjs` compares the profile name with the requested environment and refuses a mismatch. The templates assume these names, which you can change in your `.envrc` files:

| Profile | Account | Use |
| --- | --- | --- |
| `mcc-dev-admin` | dev | Bootstrap and CDK bootstrap |
| `mcc-prod-admin` | prod | Bootstrap and CDK bootstrap |
| `mcc-dev` | dev | Everyday local deployments, after [local deploy access](20-bootstrap-cdk.md#grant-local-deploy-access) exists |

## Verify

From the repository root:

```console
npm ci
npm run check
aws sso login --profile mcc-dev-admin
aws sts get-caller-identity --profile mcc-dev-admin
aws sso login --profile mcc-prod-admin
aws sts get-caller-identity --profile mcc-prod-admin
```

The checks pass and the two account IDs differ.

For infrastructure changes, run the full formatting, validation, and module-test loop in [TESTING.md](../../TESTING.md).

Next: [Bootstrap the dev and prod accounts](10-bootstrap-accounts.md).
