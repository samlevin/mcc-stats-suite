# Configure Terrateam and GitHub

Install the Terrateam GitHub App for the repository and keep its generated workflow under `.github/workflows/`. The repository's OpenTofu roots, access policy, OIDC workflows, and drift schedule are already defined in [`.terrateam/config.yml`](../.terrateam/config.yml). Do not replace that file with a generated example.

Create GitHub Environments named `dev` and `prod`. Set these environment variables from the corresponding bootstrap outputs:

| Environment | Variable | Value |
|---|---|---|
| `dev` | `DEV_AWS_REGION` | AWS region for the dev foundation |
| `dev` | `DEV_TERRATEAM_ROLE_ARN` | Dev Terrateam role ARN |
| `dev` | `DEV_TOFU_STATE_BUCKET` | Dev OpenTofu state bucket name |
| `prod` | `PROD_AWS_REGION` | AWS region for the prod foundation |
| `prod` | `PROD_TERRATEAM_ROLE_ARN` | Prod Terrateam role ARN |
| `prod` | `PROD_TOFU_STATE_BUCKET` | Prod OpenTofu state bucket name |

These values are identifiers, not credentials, so GitHub Environment variables are the right storage location. Do not create long-lived AWS access keys. Terrateam obtains short-lived credentials through GitHub OIDC.

Protect the `prod` environment. Terrateam also limits prod applies to repository administrators. Changes to `.terrateam/config.yml` require an administrator, which prevents a pull request from weakening its own deployment rules.

Terrateam checks both foundation roots for drift weekly. A non-empty drift plan creates a GitHub issue. Drift reconciliation is deliberately manual: the configuration does not set `reconcile: true`, so a scheduled job cannot make an unattended S3, KMS, or Parameter Store change.

Verify the setup with a pull request that changes a foundation file. The pull request should receive plans for every matching root. A change under `infrastructure/modules/foundation` should plan both dev and prod because both roots consume that module.

Next: [`20-promote-foundation-to-dev.md`](20-promote-foundation-to-dev.md).
