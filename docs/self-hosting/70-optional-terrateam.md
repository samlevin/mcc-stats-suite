# Optional: apply the foundation with Terrateam

The upstream repository applies its foundation with [Terrateam](https://terrateam.io). You do not need it. Any process that follows [Apply and change the foundation](40-change-foundation.md) works, including running OpenTofu by hand. This page collects everything the repository configures for Terrateam, for self-hosters who want the same setup.

## What the committed configuration does

[`.terrateam/config.yml`](../../.terrateam/config.yml) and the generated `.github/workflows/terrateam.yml` define the setup. With them, Terrateam:

- ignores pull requests from the Release Please branch, `release-please--branches--main`, without evaluation, plans, applies, or comments;
- plans the foundation roots only when a `terrateam plan` comment on the pull request asks for it, never when the pull request opens or changes; a change to `infrastructure/modules/foundation` or `.terrateam/config.yml` affects dev and prod, and a change to one environment root affects only that root;
- never applies from `main`; dev and prod are applied from the pull request by comment, and prod only after dev;
- locks each root from its first apply until the pull request merges, and takes no lock when a pull request merges without a Terrateam apply;
- runs dev jobs in the `infra/foundation-dev` GitHub Environment and prod jobs in `infra/foundation-prod`;
- squash-merges the pull request with its title once every planned root has applied without error, never after a failed apply;
- lets repository writers apply dev and only administrators apply prod;
- requires an administrator for changes to Terrateam's workflow or configuration;
- plans and applies `infrastructure/dev/local-cdk`, the local CDK bootstrap, the same way as the dev foundation root, and treats a change to its template or stack policy as a change to that root;
- never touches the bootstrap, module, or inactive data-platform directories;
- treats a change to a foundation root's `external-inputs.revision` file as a change to that root, which is how a changed secret reaches AWS (see [Change an external input](40-change-foundation.md#change-an-external-input)); and
- checks both foundation roots for drift daily and opens an issue instead of reconciling.

A root is affected only when a changed file matches that root's `file_patterns`. Module calls are not discovered, so every local module a root calls needs its own pattern. [Map module calls to roots](#map-module-calls-to-roots) describes the rules.

## Map module calls to roots

The Terrateam indexer is disabled, so Terrateam plans a root only when a changed file matches that root's `file_patterns` in `.terrateam/config.yml`. Map module calls by hand, in the same pull request that changes them:

- When a root calls a local module (`source = "../../modules/<name>"`), add `'infrastructure/modules/<name>/*.tf'` to that root's `file_patterns`. Follow module calls inside that module too, and add a pattern for every local module the root reaches.
- `*` does not match `/`, so `*.tf` covers only that directory. Add one pattern per module directory. Leave out `tests/`, which never affects a plan.
- Every Terrateam-managed root has a `dirs` entry with its environment tags (`dev` or `prod` selects the workflow), `'${DIR}/*.tf'`, `'${DIR}/*.tfvars'`, `'${DIR}/*.hcl'`, its module patterns, and `'.terrateam/config.yml'`.
- Roots Terrateam must not run, such as bootstrap, get an entry with `autoplan: false`, `autoapply: false`, and `file_patterns: ['!**/*']`. Terrateam treats every directory holding `.tf` files as a root and runs one without an entry with its default workflow, so every new root and every new `infrastructure/modules/<name>` directory needs one.
- When a module call is removed, remove its pattern from every root that no longer reaches the module.
- Registry and Git modules need no pattern. The root pins their version, and a version change edits the root's own files.

## Bootstrap the Terrateam role

Set `create_terrateam_role = true` in each account's `bootstrap.auto.tfvars` and apply the bootstrap as in [Bootstrap the dev and prod accounts](10-bootstrap-accounts.md). The bootstrap then creates `mcc-stats-suite-<environment>-terrateam` with:

- `PowerUserAccess`;
- an inline grant to manage only the `mcc-stats-suite-<environment>-github-turbo-cache` role, with the `mcc-stats-suite-workload-boundary` permissions boundary;
- in dev only, an inline grant to manage the `CDKToolkitLocal` stack and the IAM resources it creates, scoped by name to roles named `cdk-mcclocal1-*` and policies named `mcc-stats-suite-local-*`; and
- a trust policy that accepts GitHub OIDC tokens only from this repository, the `terrateam_workflow_path` workflow (`.github/workflows/terrateam.yml` by default), and the `terrateam-action[bot]` actor.

GitHub needs no role ARN: the committed configuration builds `arn:aws:iam::<account>:role/mcc-stats-suite-<environment>-terrateam` from the account ID, the same name `tofu output -raw terrateam_role_arn` reports. Apply bootstrap changes before any foundation change that depends on them; the Terrateam role cannot create the Turbo cache role until the bootstrap grants it.

Treat any change to the Terrateam workflow, the Terrateam configuration, or `infrastructure/modules/bootstrap` as a change to cloud access. Replace `PowerUserAccess` with project-specific permissions before letting many people apply infrastructure.

## Configure GitHub

Create two more GitHub Environments, `infra/foundation-dev` and `infra/foundation-prod`. Give them no required reviewers, so Terrateam jobs never wait for an Actions approval, and no variables or secrets. Terrateam's `access_control`, not the `prod` deployment approval, is the production gate for infrastructure.

Terrateam reads the repository secrets and variables from [Configure GitHub](30-configure-github.md#variables-and-secrets): `DEV_AWS_ACCOUNT_ID`, `PROD_AWS_ACCOUNT_ID`, `DEV_MCC_EMAIL_DOMAIN`, `PROD_MCC_EMAIL_DOMAIN`, `DEV_MCC_EMAIL_ALIAS`, `PROD_MCC_EMAIL_ALIAS`, `DEV_AWS_REGION`, and `PROD_AWS_REGION`. The Terrateam workflow passes both secrets and variables to the runner, and GitHub masks the secrets in its public log, including inside the role ARN and bucket name built from them. `.terrateam/config.yml` builds the rest with the bootstrap naming rules:

| Input | Built from |
| --- | --- |
| Terrateam role | `arn:aws:iam::<account>:role/mcc-stats-suite-<environment>-terrateam` |
| backend bucket and Region | `mcc-stats-suite-tofu-state-<account>-<region>`, and the Region |
| `TF_VAR_aws_region` | the Region |
| `TF_VAR_email_domain` | the email domain, marked sensitive |
| `TF_VAR_email_alias` | the email alias, marked sensitive |
| `TF_VAR_github_oidc_subject_repository` | `<owner>@<owner_id>/<repo>@<repo_id>`, from the runner's `GITHUB_REPOSITORY_OWNER`, `GITHUB_REPOSITORY_OWNER_ID`, `GITHUB_REPOSITORY`, and `GITHUB_REPOSITORY_ID` |

The OIDC subject step assumes immutable OIDC subjects. A repository with mutable subjects changes that step to print `${GITHUB_REPOSITORY}`. The Terrateam runner substitutes `$NAME` and `${NAME}` in every command before it runs and rejects shell syntax such as `$(...)`, so keep any other `$` out of commands in that file.

## Configure the infrastructure merge requirement

The `main` ruleset requires `Require applicable Terrateam applies` from GitHub Actions alongside `Require every check selected for the changed files`, `Scan commits for secrets`, and `Check PR title follows Conventional Commits`. Do not require `terrateam apply` globally: Terrateam intentionally sends no status for the excluded Release Please branch. Keep the pull-request requirement, up-to-date requirement, force-push/deletion protection, and existing bypass policy.

`CI: infrastructure merge gate` publishes the required commit status on each open pull request head targeting `main`. It runs on pull-request changes, Terrateam status events, and manual dispatch. It reads trusted default-branch code and dependencies, never executes pull-request code, and marks the status pending before setup. A dependency installation or API failure leaves the gate pending or failed. It makes no plan, apply, or comment and never writes a `terrateam apply` result.

The gate matches changed paths, including both sides of renames, against the union of the base and proposed `.terrateam/config.yml` mappings. Narrowing or removing a mapping cannot exempt a root managed by the protected base. Unmapped infrastructure source files, incomplete file lists, unsupported mapping syntax, and unreadable configuration block the gate. Explicitly disabled roots remain manual. The matcher supports `*`, `**`, `?`, `${DIR}`, and negated file patterns, with the committed default workspace only. Extend its implementation and tests before using other pattern syntax or workspaces.

| Pull request contents | Required gate result |
| --- | --- |
| Release manifests, changelogs, lockfile, package versions, docs, or application code with no managed root changes | Success without contacting Terrateam or requiring any apply status |
| Managed root, mapped module, root input revision, or local CDK template/policy | Pending until the current head has successful aggregate `terrateam apply` and per-root `terrateam apply: <root> default` statuses from `terrateam-action[bot]` |
| Managed infrastructure on the excluded Release Please branch | Blocked until moved to a normally evaluated branch and applied |

A partial apply, absent apply, failed retry, forged status, or success on an older commit cannot satisfy the gate. Terrateam retains explicit comment approval, dev-before-prod dependencies, access control, and apply locks. Its apply prerequisites ignore only this gate and its evaluator job, so applies can finish while the merge gate waits. Other CI checks and merge-conflict checks remain apply prerequisites. See [Terrateam apply requirements](https://stategraph.com/docs/orchestration/configuration#apply-requirements) for the `status_checks.ignore_matching` setting.

Repository settings need separate human approval. To replace an existing unconditional `terrateam apply` requirement:

1. Merge the workflow, gate script, and configuration through the existing protections. This configuration affects every managed root, so an authorized operator reviews and approves its applicable applies before merge. The trusted gate starts running only after its workflow and script exist on `main`.
2. Manually dispatch `CI: infrastructure merge gate` from `main` with each existing pull request number that needs evaluation. Confirm the new status appears on its current head. For a release-only pull request, it succeeds without Terrateam activity.
3. After explicit approval for the repository-settings change, edit the active `main` ruleset in one update: replace only `terrateam apply` with `Require applicable Terrateam applies`, using GitHub Actions as its expected source. Preserve the other three required checks and all other protections. Do not add the evaluator job as a required check, add a bypass, or send a synthetic apply result.
4. Read back the effective ruleset and check sources. For example, use `gh api repos/OWNER/REPOSITORY/rulesets/RULESET_ID` and `gh api repos/OWNER/REPOSITORY/rules/branches/main`. Confirm the four required contexts above and the unchanged protections.
5. Inspect a release-only pull request such as upstream #277. Verify all four requirements pass on its current head and that Terrateam sent no evaluation, comment, plan, or apply. Inspect an authorized managed-infrastructure pull request before applying, after dev only, and after all applicable approved applies. The gate must remain pending until every applicable root succeeds, then report success. Use the normal dev-before-prod and lock checks in [Change the foundation with Terrateam](#change-the-foundation-with-terrateam). These live checks require separately authorized applies.

Changing files or rerunning the evaluator does not approve an apply or change the ruleset. A manual OpenTofu apply produces no Terrateam status and cannot satisfy this requirement. An administrator must separately approve any temporary protection maintenance needed for an outage recovery or a manual apply workflow. Never fabricate apply evidence.

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

When every planned root has applied without error, Terrateam squash-merges the pull request using its title. A change confined to `infrastructure/prod/foundation` has no dev step. If the merge is blocked by another required check, merge the pull request yourself once all required checks pass. `Require applicable Terrateam applies` also requires success for every affected root, even if only some roots have been planned.

Terrateam takes a lock only when it applies a root, and the merge releases it. Merging a pull request that Terrateam never applied, such as one applied outside Terrateam, takes no lock and does not block later foundation pull requests. Never force-unlock a pull request that has applied part of a change.

Manual applies cannot satisfy the infrastructure merge requirement above. When Terrateam cannot run, a person can invoke `/mcc-apply-foundation` in Claude Code or `$mcc-apply-foundation` in Codex for one pull request. An agent cannot start it for you. It reads the inputs from each foundation root's ignored `.envrc` in your checkout, which you create from the `.envrc.example` in that root. It checks the account, plans and applies dev before prod, applies only the saved plans that person reviewed, and squash-merges with the pull request title, stopping for approval before every step. Because Terrateam never applied that pull request, the merge takes no Terrateam lock.

Do not apply a [recovery](60-recover-and-troubleshoot.md#a-plan-wants-to-create-resources-that-already-exist) import pull request with Terrateam. Its import blocks must never merge, and Terrateam merges a pull request once its applies succeed and its checks pass. Apply it by hand as the recovery steps describe.

## Drift issues

Terrateam's daily drift check opens a GitHub issue when a foundation plan is not empty. Handle it as in [Foundation drift](60-recover-and-troubleshoot.md#foundation-drift), and close the issue after a later plan is empty.

A fork needs its own Terrateam installation, GitHub Environments, values from the table above, and bootstrap roles. [Configure GitHub](30-configure-github.md#changes-a-fork-needs) lists the other fork changes.
