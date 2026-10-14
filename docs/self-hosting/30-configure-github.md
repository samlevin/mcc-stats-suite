# Configure GitHub and Release Please

## Environments

Create two GitHub Environments, `dev` and `prod`, for application deployments. The CDK entry roles trust only the deployment workflow on `main` in the matching environment, so a deployment from any other branch fails at role assumption.

Give `prod` at least one required reviewer and disable administrator bypass. The deployment workflow checks both before every production job and fails if either is missing. As the only reviewer, leave **Prevent self-review** off so you can approve your own deployments. This gate covers application deployments and rollbacks only. Foundation applies are gated by whoever can run OpenTofu against prod; see [Apply and change the foundation](40-change-foundation.md).

## Variables and secrets

Every value comes from the bootstrap outputs or your own configuration. Store identifiers as variables and the release app key as a secret. None of them is an AWS credential; GitHub Actions gets short-lived AWS sessions through OIDC. Never create `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` secrets.

| Scope | Name | Kind | Value | Used by |
| --- | --- | --- | --- | --- |
| `dev` environment | `AWS_ACCOUNT_ID` | variable | dev `aws_account_id` | application deploys |
| `dev` environment | `AWS_CDK_DEPLOY_ROLE_ARN` | variable | dev `cdk_deploy_role_arn` | application deploys |
| `dev` environment | `AWS_REGION` | variable | workload Region | application deploys |
| `prod` environment | `AWS_ACCOUNT_ID`, `AWS_CDK_DEPLOY_ROLE_ARN`, `AWS_REGION` | variables | prod equivalents of the dev values | application deploys |
| repository | `DEV_AWS_ACCOUNT_ID` | variable | dev `aws_account_id` | Turbo cache in `main` CI |
| repository | `DEV_AWS_REGION` | variable | workload Region | Turbo cache in `main` CI |
| repository | `RELEASE_PLEASE_APP_ID` | variable | your Release Please app ID | `release-please` |
| repository | `RELEASE_PLEASE_APP_PRIVATE_KEY` | secret | that app's private key | `release-please` |

`main` CI fails at its cache step until `DEV_AWS_ACCOUNT_ID` is set and the [dev foundation](40-change-foundation.md) has created the `mcc-stats-suite-dev-github-turbo-cache` role.

The foundation's inputs, including the email domain, are not GitHub settings unless your infrastructure CI/CD runs in GitHub Actions. [Apply and change the foundation](40-change-foundation.md#inputs) lists them.

## Branch protection

Protect `main`: require pull requests and the `check`, `gitleaks`, and `semantic_pr` status checks, require branches to be up to date, and block force pushes and deletion. Enable auto-merge if you want pull requests to merge when their checks pass.

## Release Please

Release Please opens release pull requests as a GitHub App. Pull requests opened with the workflow's `GITHUB_TOKEN` do not start other workflows, so they would never get the required checks.

1. Create a GitHub App owned by you, with read and write access to contents, pull requests, and issues. Disable its webhook.
2. Install it on this repository only.
3. Generate a private key and store the app ID and key as the `RELEASE_PLEASE_APP_ID` variable and `RELEASE_PLEASE_APP_PRIVATE_KEY` secret. Delete the local key file afterwards.

Do not replace the app with a personal access token or give the workflow's `GITHUB_TOKEN` more permissions. [Troubleshooting](60-recover-and-troubleshoot.md#release-please-cannot-open-a-release-pull-request) covers token failures.

## Changes a fork needs

A fork deploys to its own accounts with its own Release Please app. It also needs a few repository changes:

- Workspaces use the `@samlevin` npm scope, and `.npmrc` sends that scope to GitHub Packages. The `publish-shared-packages` workflow (`publish-packages.yml`) publishes the shared packages there, which only works under the matching owner. Rename the scope or delete the workflow. Applications build from the local workspaces and never download published versions.
- `issue-triage.yml` and `pr-issue-metadata.yml` run only in `samlevin/mcc-stats-suite`. They skip on a fork. To use them, change the repository check, point the scripts at your own GitHub Project, and add a `MCC_PROJECT_TOKEN` secret with issue, pull request, and project access.
- The README badges point at the upstream repository.

Next: [Apply the foundation](40-change-foundation.md).
