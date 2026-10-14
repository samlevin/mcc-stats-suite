# Optional: apply the foundation with Terrateam

The upstream repository applies its foundation with [Terrateam](https://terrateam.io). You do not need it. Any process that follows [Apply and change the foundation](40-change-foundation.md) works, including running OpenTofu by hand. This page collects everything the repository configures for Terrateam, for self-hosters who want the same setup.

## What the committed configuration does

[`.terrateam/config.yml`](../../.terrateam/config.yml) and the generated `.github/workflows/terrateam.yml` define the setup. With them, Terrateam:

- plans the foundation roots only when a `terrateam plan` comment on the pull request asks for it, never when the pull request opens or changes; a change to `infrastructure/modules/foundation` or `.terrateam/config.yml` affects dev and prod, and a change to one environment root affects only that root;
- never applies from `main`; dev and prod are applied from the pull request by comment, and prod only after dev;
- locks each root from its first apply until the pull request merges, and takes no lock when a pull request merges without a Terrateam apply;
- runs dev jobs in the `infra/foundation-dev` GitHub Environment and prod jobs in `infra/foundation-prod`;
- squash-merges the pull request with its title once every planned root has applied without error, never after a failed apply;
- lets repository writers apply dev and only administrators apply prod;
- requires an administrator for changes to Terrateam's workflow or configuration;
- never touches the bootstrap, module, or inactive data-platform directories; and
- checks both foundation roots for drift weekly and opens an issue instead of reconciling.

A root is affected only when a changed file matches that root's `file_patterns`. Module calls are not discovered, so every local module a root calls needs its own pattern. [AGENTS.md](../../AGENTS.md#terrateam-module-mapping) describes the mapping rules.

## Bootstrap the Terrateam role

Set `create_terrateam_role = true` in each account's `bootstrap.auto.tfvars` and apply the bootstrap as in [Bootstrap the dev and prod accounts](10-bootstrap-accounts.md). The bootstrap then creates `mcc-stats-suite-<environment>-terrateam` with:

- `PowerUserAccess`;
- an inline grant to manage only the `mcc-stats-suite-<environment>-github-turbo-cache` role, with the `mcc-stats-suite-workload-boundary` permissions boundary; and
- a trust policy that accepts GitHub OIDC tokens only from this repository, the `terrateam_workflow_path` workflow (`.github/workflows/terrateam.yml` by default), and the `terrateam-action[bot]` actor.

GitHub needs no role ARN: the committed configuration builds `arn:aws:iam::<account>:role/mcc-stats-suite-<environment>-terrateam` from the account ID, the same name `tofu output -raw terrateam_role_arn` reports. Apply bootstrap changes before any foundation change that depends on them; the Terrateam role cannot create the Turbo cache role until the bootstrap grants it.

Treat any change to the Terrateam workflow, the Terrateam configuration, or `infrastructure/modules/bootstrap` as a change to cloud access. Replace `PowerUserAccess` with project-specific permissions before letting many people apply infrastructure.

## Configure GitHub

Create two more GitHub Environments, `infra/foundation-dev` and `infra/foundation-prod`. Give them no required reviewers, so Terrateam jobs never wait for an Actions approval, and no variables or secrets. Terrateam's `access_control`, not the `prod` deployment approval, is the production gate for infrastructure.

Terrateam reads the repository secrets and variables from [Configure GitHub](30-configure-github.md#variables-and-secrets): `DEV_AWS_ACCOUNT_ID`, `PROD_AWS_ACCOUNT_ID`, `DEV_MCC_EMAIL_DOMAIN`, `PROD_MCC_EMAIL_DOMAIN`, `DEV_AWS_REGION`, and `PROD_AWS_REGION`. The Terrateam workflow passes both secrets and variables to the runner, and GitHub masks the secrets in its public log, including inside the role ARN and bucket name built from them. `.terrateam/config.yml` builds the rest with the bootstrap naming rules:

| Input | Built from |
| --- | --- |
| Terrateam role | `arn:aws:iam::<account>:role/mcc-stats-suite-<environment>-terrateam` |
| backend bucket and Region | `mcc-stats-suite-tofu-state-<account>-<region>`, and the Region |
| `TF_VAR_aws_region` | the Region |
| `TF_VAR_email_domain` | the email domain, marked sensitive |
| `TF_VAR_github_oidc_subject_repository` | `<owner>@<owner_id>/<repo>@<repo_id>`, from the runner's `GITHUB_REPOSITORY_OWNER`, `GITHUB_REPOSITORY_OWNER_ID`, `GITHUB_REPOSITORY`, and `GITHUB_REPOSITORY_ID` |

The OIDC subject step assumes immutable OIDC subjects. A repository with mutable subjects changes that step to print `${GITHUB_REPOSITORY}`. The Terrateam runner substitutes `$NAME` and `${NAME}` in every command before it runs and rejects shell syntax such as `$(...)`, so keep any other `$` out of commands in that file.

## Install Terrateam

1. Install the Terrateam GitHub App for only this repository.
2. Keep its generated `.github/workflows/terrateam.yml`. Do not replace `.terrateam/config.yml` with a generated example.
3. Do not run Terrateam's own AWS bootstrap. The repository bootstrap already created the roles.

Verify the setup before relying on it:

1. Open a pull request that changes a comment in `infrastructure/dev/foundation` and confirm Terrateam plans nothing. Comment `terrateam plan` and confirm Terrateam plans dev in `infra/foundation-dev` with no pending deployment review.
2. Confirm a pull request from a non-administrator that changes `.terrateam/config.yml` is blocked from Terrateam operations.
3. From an unrelated workflow, request an OIDC token and try to assume the Terrateam role. AWS must reject it.
4. After a Terrateam run, check CloudTrail for an assumed-role session from the expected workflow and repository.

## Change the foundation with Terrateam

1. Open a pull request. Terrateam plans nothing until someone asks. Comment `terrateam plan` to start. When dev is affected, the comment plans dev only, and prod plans after the dev apply. A change confined to `infrastructure/prod/foundation` plans prod at once. After pushing a new commit, comment `terrateam plan` again.
2. Read every planned action, as in [Apply and change the foundation](40-change-foundation.md#change-the-foundation-later).
3. Comment `terrateam apply dev and foundation`. Terrateam locks the dev root for this pull request. No other pull request can apply it until this one merges.
4. Validate dev. If the change needs fixing, push a new commit, comment `terrateam plan`, review the new plan, and apply dev again.
5. After the dev apply succeeds, Terrateam plans prod. If no prod plan appears, comment `terrateam plan prod and foundation`. Compare the prod plan with the applied dev plan, then comment `terrateam apply prod and foundation`. Terrateam locks the prod root until the pull request merges. Only repository administrators can apply prod, and prod cannot plan or apply until dev has applied.

When every planned root has applied without error, Terrateam squash-merges the pull request using its title. A change confined to `infrastructure/prod/foundation` has no dev step. If the merge is blocked, for example by a pending required check, merge the pull request yourself once the checks pass.

Terrateam takes a lock only when it applies a root, and the merge releases it. Merging a pull request that Terrateam never applied, such as one applied outside Terrateam, takes no lock and does not block later foundation pull requests. Never force-unlock a pull request that has applied part of a change.

When Terrateam cannot run, a person can invoke `/mcc-apply-foundation` in Claude Code or `$mcc-apply-foundation` in Codex for one pull request. An agent cannot start it for you. It reads the inputs from each foundation root's ignored `.envrc` in your checkout, which you create from the `.envrc.example` in that root. It checks the account, plans and applies dev before prod, applies only the saved plans that person reviewed, and squash-merges with the pull request title, stopping for approval before every step. Because Terrateam never applied that pull request, the merge takes no Terrateam lock.

For [recovery](60-recover-and-troubleshoot.md#a-plan-wants-to-create-resources-that-already-exist), apply the import pull request with `terrateam plan` and `terrateam apply dev and foundation`, then `terrateam plan prod and foundation` and `terrateam apply prod and foundation`.

## Drift issues

Terrateam's weekly drift check opens a GitHub issue when a foundation plan is not empty. Handle it as in [Foundation drift](60-recover-and-troubleshoot.md#foundation-drift), and close the issue after a later plan is empty.

A fork needs its own Terrateam installation, GitHub Environments, values from the table above, and bootstrap roles. [Configure GitHub](30-configure-github.md#changes-a-fork-needs) lists the other fork changes.
