# Check prerequisites

## Accounts

You need two AWS accounts, `dev` and `prod`, and an IAM Identity Center administrator permission set in each. Any account structure works. [samlevin/aws-bootstrap](https://github.com/samlevin/aws-bootstrap) describes one way to build it.

Pick one workload Region that supports SES email receiving, and use it everywhere. Set it as the `region` of every AWS profile below; each `.envrc` reads it from there.

## Inbound email

`match-to-csv` receives screenshots by email. Use a separate domain or subdomain for each environment, and in each account's workload Region:

1. Create an SES domain identity for it and finish DNS verification. The identity must show `Success`.
2. Publish `MX 10 inbound-smtp.<region>.amazonaws.com` for the domain.

The foundation makes its own receipt rule set, `mcc-inbound-<environment>`, the account's active rule set. Any other active rule set in that Region stops receiving mail. Every deployment checks the identity, the MX record, and the active rule set, and fails if one is missing.

## Tools

Install the tools from [Getting started](../getting-started.md#install-the-tools), plus:

- AWS CLI v2 with IAM Identity Center profiles
- `direnv`
- Docker that can run Linux ARM64 images, for CDK assets with native dependencies. Apple silicon runs them natively; on x86, install QEMU emulation, for example with `docker run --privileged --rm tonistiigi/binfmt --install arm64`.

## SSO profiles

Create an SSO profile for each account and permission set you use. Keep `dev` or `prod` in each profile name. `scripts/cdk-app.mjs` compares the profile name with the requested environment and refuses a mismatch. Each profile needs `sso_account_id` and `region`, which every `.envrc` reads to find the account, Region, and state bucket. The templates assume these names, which you can change in your `.envrc` files:

| Profile | Account | Use |
| --- | --- | --- |
| `mcc-dev-admin` | dev | Bootstrap and CDK bootstrap |
| `mcc-prod-admin` | prod | Bootstrap and CDK bootstrap |
| `mcc-dev` | dev | Everyday local deployments, after [local deploy access](20-bootstrap-cdk.md#grant-local-deploy-access) exists |

## Verify

Complete [tier 1 of Getting started](../getting-started.md#tier-1-run-the-checks-locally), so `npm run check` passes. Then, from the repository root:

```console
aws sso login --profile mcc-dev-admin
aws sts get-caller-identity --profile mcc-dev-admin
aws sso login --profile mcc-prod-admin
aws sts get-caller-identity --profile mcc-prod-admin
```

The checks pass and the two account IDs differ.

For infrastructure changes, run `npm run tofu:check`, as the [Getting started table](../getting-started.md#choose-the-checks-for-your-change) lists. [TESTING.md](../../TESTING.md) explains what it checks.

Next: [Bootstrap the dev and prod accounts](10-bootstrap-accounts.md).
