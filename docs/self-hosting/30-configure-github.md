# Configure GitHub and Release Please

## Environments

Create two GitHub Environments, `dev` and `prod`, for application deployments. They gate deployments and hold no variables or secrets. The CDK entry roles trust only the deployment workflow on `main` in the matching environment, so a deployment from any other branch fails at role assumption.

Give `prod` at least one required reviewer and disable administrator bypass. The deployment workflow checks both before every production job and fails if either is missing. As the only reviewer, leave **Prevent self-review** off so you can approve your own deployments. This gate covers application deployments and rollbacks only. Foundation applies are gated by whoever can run OpenTofu against prod; see [Apply and change the foundation](40-change-foundation.md).

## Variables and secrets

GitHub holds only the values nobody can derive: for each environment, the AWS account ID, the workload Region, and the email domain. Store them at repository level. The repository is public and variables print unmasked in workflow logs, so the account IDs and domains are secrets, which GitHub masks everywhere, including inside role ARNs built from them. The deployment workflow builds the CDK entry role ARN, `arn:aws:iam::<account>:role/mcc-stats-suite-<environment>-github-cdk-deploy`, from the account ID, and picks the `DEV_` or `PROD_` names by the environment it deploys. None of these values is an AWS credential; GitHub Actions gets short-lived AWS sessions through OIDC. Never create `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` secrets.

| Scope | Name | Kind | Value | Used by |
| --- | --- | --- | --- | --- |
| repository | `DEV_AWS_ACCOUNT_ID`, `PROD_AWS_ACCOUNT_ID` | secrets | each bootstrap's `aws_account_id` | application deploys, Turbo cache in `main` CI |
| repository | `DEV_AWS_REGION`, `PROD_AWS_REGION` | variables | workload Region of each account | application deploys, Turbo cache in `main` CI |
| repository | `DEV_MCC_EMAIL_DOMAIN`, `PROD_MCC_EMAIL_DOMAIN` | secrets | verified SES domain that receives each environment's email, in lowercase | [Terrateam](70-optional-terrateam.md) only |
| repository | `RELEASE_PLEASE_APP_ID` | variable | your Release Please app ID | `release-please` |
| repository | `RELEASE_PLEASE_APP_PRIVATE_KEY` | secret | that app's private key | `release-please` |
| repository | `MCC_TURBO_CACHE` | variable | `true` to turn on the Turbo cache (optional) | Turbo cache in `main` CI and deploys |

### Turbo cache

The Turbo cache is optional. Without `MCC_TURBO_CACHE`, CI and deploys build uncached and need no cache settings. To turn it on in your repository, apply both [foundation roots](40-change-foundation.md) with `github_oidc_subject_repository` set to your repository: `OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID` with immutable OIDC subjects, otherwise `OWNER/REPOSITORY`. Each root then creates a `mcc-stats-suite-<environment>-github-turbo-cache` role in your account that trusts only your repository. Set `MCC_TURBO_CACHE` to `true` after the account and Region settings above. `main` CI uses the dev account and Region, and each deploy uses those of the environment it deploys. If you set `MCC_TURBO_CACHE` before the roles exist, the cache step fails at role assumption.

Only Terrateam reads the email domain secrets, as the table shows. A local foundation apply reads the domain from the SSM parameter the foundation owns; [Apply and change the foundation](40-change-foundation.md#inputs) lists every foundation input.

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

- `issue-triage.yml`, `pr-issue-metadata.yml`, and `pr-issue-status.yml` run only in `samlevin/mcc-stats-suite`. They skip on a fork. To use them, change the repository check, point the scripts at your own GitHub Project, and add a `MCC_PROJECT_TOKEN` secret with issue, pull request, and project access.
- The README badges point at the upstream repository.
- `match-to-csv` CI and deploy jobs run on GitHub-hosted ARM64 runners (`ubuntu-24.04-arm`), which are free only for public repositories.
- Enable Actions on the fork. GitHub disables workflows on new forks.
- Terrateam is optional. Without it, delete `.github/workflows/terrateam.yml` and `.terrateam/config.yml`, or leave them unused; see [Apply the foundation with Terrateam](70-optional-terrateam.md).

Next: [Apply the foundation](40-change-foundation.md).
