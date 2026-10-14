# Optional: apply the foundation with Terrateam

The upstream repository applies its foundation with [Terrateam](https://terrateam.io). You do not need it. Any process that follows [Apply and change the foundation](40-change-foundation.md) works, including running OpenTofu by hand. This page collects everything the repository configures for Terrateam, for self-hosters who want the same setup.

## What the committed configuration does

[`.terrateam/config.yml`](../../.terrateam/config.yml) and the generated `.github/workflows/terrateam.yml` define the setup. With them, Terrateam:

- plans the foundation roots on every pull request that changes them; a change to `infrastructure/modules/foundation` or `.terrateam/config.yml` plans dev and prod, and a change to one environment root plans only that root;
- never applies from `main`; dev and prod are applied from the pull request by comment, and prod only after dev;
- locks each root from its first apply until the pull request merges;
- runs dev jobs in the `infra/foundation-dev` GitHub Environment and prod jobs in `infra/foundation-prod`;
- squash-merges the pull request with its title once every planned root has applied without error, never after a failed apply;
- lets repository writers apply dev and only administrators apply prod;
- requires an administrator for changes to Terrateam's workflow or configuration;
- never touches the bootstrap, module, or inactive data-platform directories; and
- checks both foundation roots for drift weekly and opens an issue instead of reconciling.

Terrateam plans a root only when a changed file matches that root's `file_patterns`. Module calls are not discovered, so every local module a root calls needs its own pattern. [AGENTS.md](../../AGENTS.md#terrateam-module-mapping) describes the mapping rules.

## Bootstrap the Terrateam role

Set `create_terrateam_role = true` in each account's `bootstrap.auto.tfvars` and apply the bootstrap as in [Bootstrap the dev and prod accounts](10-bootstrap-accounts.md). The bootstrap then creates `mcc-stats-suite-<environment>-terrateam` with:

- `PowerUserAccess`, plus any `additional_terrateam_policy_arns`;
- an inline grant to manage only the `mcc-stats-suite-<environment>-github-turbo-cache` role, with the `mcc-stats-suite-workload-boundary` permissions boundary; and
- a trust policy that accepts GitHub OIDC tokens only from this repository, the `terrateam_workflow_path` workflow (`.github/workflows/terrateam.yml` by default), and the `terrateam-action[bot]` actor.

Record `tofu output -raw terrateam_role_arn` from each bootstrap root. `tofu output terrateam_oidc_hook` prints the matching Terrateam OIDC hook. Apply bootstrap changes before any foundation change that depends on them; the Terrateam role cannot create the Turbo cache role until the bootstrap grants it.

Treat any change to the Terrateam workflow, the Terrateam configuration, or `infrastructure/modules/bootstrap` as a change to cloud access. Replace `PowerUserAccess` with project-specific permissions before letting many people apply infrastructure.

## Configure GitHub

Create two more GitHub Environments, `infra/foundation-dev` and `infra/foundation-prod`. Give them no required reviewers, so Terrateam jobs never wait for an Actions approval. Terrateam's `access_control`, not the `prod` deployment approval, is the production gate for infrastructure.

Store the email domain as a secret. The Terrateam workflow prints its environment's variables in a public log, and GitHub masks secret values.

| Scope | Name | Kind | Value |
| --- | --- | --- | --- |
| `infra/foundation-dev` environment | `DEV_TERRATEAM_ROLE_ARN` | variable | dev `terrateam_role_arn` |
| `infra/foundation-dev` environment | `DEV_TOFU_STATE_BUCKET` | variable | dev `state_bucket_name` |
| `infra/foundation-dev` environment | `DEV_AWS_REGION` | variable | workload Region |
| `infra/foundation-dev` environment | `DEV_MCC_EMAIL_DOMAIN` | secret | verified SES domain that receives dev email, in lowercase |
| `infra/foundation-prod` environment | `PROD_TERRATEAM_ROLE_ARN`, `PROD_TOFU_STATE_BUCKET`, `PROD_AWS_REGION` | variables | prod equivalents of the dev values |
| `infra/foundation-prod` environment | `PROD_MCC_EMAIL_DOMAIN` | secret | verified SES domain that receives prod email, in lowercase |
| repository | `MCC_GITHUB_OIDC_SUBJECT_REPOSITORY` | variable | `OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID`, when the repository uses immutable OIDC subjects |

Terrateam passes these to the foundation roots as the backend bucket and Region, `TF_VAR_aws_region`, `TF_VAR_email_domain`, and `TF_VAR_github_oidc_subject_repository`.

## Install Terrateam

1. Install the Terrateam GitHub App for only this repository.
2. Keep its generated `.github/workflows/terrateam.yml`. Do not replace `.terrateam/config.yml` with a generated example.
3. Do not run Terrateam's own AWS bootstrap. The repository bootstrap already created the roles.

Verify the setup before relying on it:

1. Open a pull request that changes a comment in `infrastructure/dev/foundation` and confirm Terrateam plans dev in `infra/foundation-dev` with no pending deployment review.
2. Confirm a pull request from a non-administrator that changes `.terrateam/config.yml` is blocked from Terrateam operations.
3. From an unrelated workflow, request an OIDC token and try to assume the Terrateam role. AWS must reject it.
4. After a Terrateam run, check CloudTrail for an assumed-role session from the expected workflow and repository.

## Change the foundation with Terrateam

1. Open a pull request. Terrateam plans each affected root. If a plan is missing or stale, comment `terrateam plan`.
2. Read every planned action, as in [Apply and change the foundation](40-change-foundation.md#change-the-foundation-later).
3. Comment `terrateam apply dev and foundation`. Terrateam locks both roots for this pull request. No other pull request can apply them until this one merges.
4. Validate dev. If the change needs fixing, push a new commit, review the new plans, and apply dev again.
5. Compare the prod plan with the applied dev plan, then comment `terrateam apply prod and foundation`. Only repository administrators can apply prod, and prod cannot apply until dev has applied.

When every planned root has applied without error, Terrateam squash-merges the pull request using its title. A change confined to `infrastructure/prod/foundation` has no dev step. If the merge is blocked, for example by a pending required check, merge the pull request yourself once the checks pass.

Do not merge a foundation pull request before applying it. With the strict lock policy, the merge takes the locks anyway, and the roots stay locked until the change is applied. Never force-unlock a pull request that has applied part of a change.

For [recovery](60-recover-and-troubleshoot.md#a-plan-wants-to-create-resources-that-already-exist), apply the import pull request with `terrateam apply dev and foundation`, then `terrateam plan prod and foundation` and `terrateam apply prod and foundation`.

## Drift issues

Terrateam's weekly drift check opens a GitHub issue when a foundation plan is not empty. Handle it as in [Foundation drift](60-recover-and-troubleshoot.md#foundation-drift), and close the issue after a later plan is empty.

## Forks

A fork needs its own Terrateam installation, its own GitHub Environments and values from the table above, and its own bootstrap roles. Without Terrateam, delete `.github/workflows/terrateam.yml` and `.terrateam/config.yml`, or leave them unused.
