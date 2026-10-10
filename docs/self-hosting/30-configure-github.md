# Configure GitHub, Terrateam, and Release Please

## Environments

Create GitHub Environments named `dev` and `prod`. The CDK entry roles trust only the deployment workflow on `main` in the matching environment, so a deployment from any other branch fails at role assumption.

Give `prod` at least one required reviewer and disable administrator bypass. The deployment workflow checks both before every production job and fails if either is missing. As the only reviewer, leave **Prevent self-review** off so you can approve your own deployments.

## Variables and secrets

Every value comes from the bootstrap outputs or your own configuration. Store identifiers as variables. None of them is an AWS credential; Terrateam and GitHub Actions get short-lived AWS sessions through OIDC. Never create `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` secrets.

| Scope | Name | Kind | Value | Used by |
| --- | --- | --- | --- | --- |
| `dev` environment | `AWS_ACCOUNT_ID` | variable | dev `aws_account_id` | application deploys |
| `dev` environment | `AWS_CDK_DEPLOY_ROLE_ARN` | variable | dev `cdk_deploy_role_arn` | application deploys |
| `dev` environment | `AWS_REGION` | variable | workload Region | application deploys |
| `dev` environment | `MCC_EMAIL_DOMAIN` | variable | verified SES domain | `match-to-csv` deploys |
| `dev` environment | `DEV_TERRATEAM_ROLE_ARN` | variable | dev `terrateam_role_arn` | Terrateam |
| `dev` environment | `DEV_TOFU_STATE_BUCKET` | variable | dev `state_bucket_name` | Terrateam |
| `dev` environment | `DEV_AWS_REGION` | variable | workload Region | Terrateam |
| `prod` environment | `AWS_ACCOUNT_ID`, `AWS_CDK_DEPLOY_ROLE_ARN`, `AWS_REGION`, `MCC_EMAIL_DOMAIN` | variables | prod equivalents of the dev values | application deploys |
| `prod` environment | `PROD_TERRATEAM_ROLE_ARN`, `PROD_TOFU_STATE_BUCKET`, `PROD_AWS_REGION` | variables | prod equivalents of the dev values | Terrateam |
| repository | `DEV_AWS_ACCOUNT_ID` | variable | dev `aws_account_id` | Turbo cache in `main` CI |
| repository | `DEV_AWS_REGION` | variable | workload Region | Turbo cache in `main` CI |
| repository | `MCC_GITHUB_OIDC_SUBJECT_REPOSITORY` | variable | `OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID`, when the repository uses immutable OIDC subjects | Terrateam, for the Turbo cache role trust |
| repository | `RELEASE_PLEASE_APP_ID` | variable | your Release Please app ID | `release-please` |
| repository | `RELEASE_PLEASE_APP_PRIVATE_KEY` | secret | that app's private key | `release-please` |

`main` CI fails at its cache step until `DEV_AWS_ACCOUNT_ID` is set and the dev foundation has created the `mcc-stats-suite-dev-github-turbo-cache` role.

## Branch protection

Protect `main`: require pull requests and the `check`, `gitleaks`, and `semantic_pr` status checks, require branches to be up to date, and block force pushes and deletion. Enable auto-merge if you want pull requests to merge when their checks pass.

## Terrateam

1. Install the Terrateam GitHub App for only this repository.
2. Keep its generated `.github/workflows/terrateam.yml`. Do not replace [`.terrateam/config.yml`](../../.terrateam/config.yml) with a generated example. It already defines the roots, access policy, OIDC workflows, and drift schedule.
3. Do not run Terrateam's own AWS bootstrap. The repository bootstrap already created the roles.

The committed configuration does the following:

- plans the foundation roots on every pull request that changes them;
- never applies from `main`; dev and prod are applied from the pull request by comment, and prod only after dev;
- locks each root from its first apply until the pull request merges;
- squash-merges the pull request with its title once every planned root has applied;
- lets repository writers apply dev and only administrators apply prod;
- requires an administrator for changes to Terrateam's workflow or configuration;
- never touches the bootstrap roots; and
- checks both foundation roots for drift weekly and opens an issue instead of reconciling.

The Terrateam role trust requires this repository, the `.github/workflows/terrateam.yml` workflow, and the `terrateam-action[bot]` actor. Treat any change to that workflow, the Terrateam configuration, or `infrastructure/modules/bootstrap` as a change to cloud access.

Verify the setup before relying on it:

1. Open a pull request that changes a comment in `infrastructure/dev/foundation` and confirm Terrateam plans dev.
2. Confirm a pull request from a non-administrator that changes `.terrateam/config.yml` is blocked from Terrateam operations.
3. From an unrelated workflow, request an OIDC token and try to assume the Terrateam role. AWS must reject it.
4. After a Terrateam run, check CloudTrail for an assumed-role session from the expected workflow and repository.

The Terrateam role has `PowerUserAccess`. Replace it with project-specific permissions before letting many people apply infrastructure.

## Release Please

Release Please opens release pull requests as a GitHub App. Pull requests opened with the workflow's `GITHUB_TOKEN` do not start other workflows, so they would never get the required checks.

1. Create a GitHub App owned by you, with read and write access to contents, pull requests, and issues. Disable its webhook.
2. Install it on this repository only.
3. Generate a private key and store the app ID and key as the `RELEASE_PLEASE_APP_ID` variable and `RELEASE_PLEASE_APP_PRIVATE_KEY` secret. Delete the local key file afterwards.

Do not replace the app with a personal access token or give the workflow's `GITHUB_TOKEN` more permissions. [Troubleshooting](60-recover-and-troubleshoot.md#release-please-cannot-open-a-release-pull-request) covers token failures.

## Changes a fork needs

A fork deploys to its own accounts with its own Terrateam and Release Please installations. It also needs a few repository changes:

- Workspaces use the `@samlevin` npm scope, and `.npmrc` sends that scope to GitHub Packages. The `publish-shared-packages` workflow (`publish-packages.yml`) publishes the shared packages there, which only works under the matching owner. Rename the scope or delete the workflow. Applications build from the local workspaces and never download published versions.
- `issue-triage.yml` and `pr-issue-metadata.yml` run only in `samlevin/mcc-stats-suite`. They skip on a fork. To use them, change the repository check, point the scripts at your own GitHub Project, and add a `MCC_PROJECT_TOKEN` secret with issue, pull request, and project access.
- The README badges point at the upstream repository.

Next: [Change the foundation](40-change-foundation.md).
