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

Protect `main` with pull requests, strict required status checks, resolved conversations, blocked force pushes, and blocked deletion. A sole-maintainer repository does not require an approving review because GitHub does not allow an author to approve their own pull request. Enable GitHub auto-merge so a pull request can merge when its checks pass.

The `prod` environment restricts which branches may use its variables. It does not require a deployment reviewer in a sole-maintainer repository. Terrateam limits prod applies to repository administrators, and changes to `.terrateam/config.yml` require an administrator.

Terrateam checks both foundation roots for drift weekly. A non-empty drift plan creates a GitHub issue. Drift reconciliation is deliberately manual: the configuration does not set `reconcile: true`, so a scheduled job cannot make an unattended S3, KMS, or Parameter Store change.

Verify the setup with a pull request that changes a foundation file. Terrateam plans the dev layer first. After the pull request merges, it applies dev and continues to the prod plan and apply only when dev succeeds. A prod-only change does not pull dev into the run. A dev-only change does not run prod; `prune_on_no_change` removes it while retaining dependency ordering.

Terrateam ties each plan to the files used by its commit and locks each directory and workspace during apply. If another foundation change reaches `main` while an apply is running, Terrateam may mark the older run stale. Let the newer revision finish its layered run, or re-plan it if Terrateam requests one. Never force-unlock an active foundation run to make a later run start.

Next: [`20-promote-foundation-to-dev.md`](20-promote-foundation-to-dev.md).
