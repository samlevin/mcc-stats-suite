# Secure Terrateam in a public repository

Use this procedure when `mcc-stats-suite` is public and Terrateam will plan or apply OpenTofu changes in AWS. It assumes the dev and prod bootstrap roots have already created their state buckets and Terrateam IAM roles.

The public repository contains deployment policy. It must never contain a reusable cloud credential, a populated OpenTofu state file, or an input containing a secret. Terrateam receives a short-lived AWS session through GitHub OIDC.

## What to commit

Commit these files:

- `.terrateam/config.yml`, copied from `.terrateam/config.yml.example` without replacing its `${...}` placeholders;
- Terrateam's generated `.github/workflows/terrateam.yml`; and
- `CODEOWNERS` rules that require an infrastructure maintainer for changes to `.terrateam/`, `.github/workflows/`, and `infrastructure/`.

Do not commit any of these files or values:

- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or a session token;
- `.env`, `*.tfvars` that contain secret values, `backend.hcl`, `*.tfstate`, `.terraform/`, or plan files; or
- passwords, API tokens, private keys, webhook signing secrets, or production customer data.

Role ARNs, bucket names, and AWS Regions are identifiers, not credentials. Keep them in GitHub Actions variables so the public configuration remains portable and does not disclose account topology.

## 1. Verify the bootstrap is ready

Run these commands locally with your administrator SSO profile. Run the dev commands in `infrastructure/dev/bootstrap` and the prod commands in `infrastructure/prod/bootstrap`.

```sh
tofu output -raw terrateam_role_arn
tofu output -raw state_bucket_name
tofu output -raw aws_region
```

Record the three results for each environment. Do not paste them into the repository or into an issue.

The bootstrap must have created a separate state bucket and a Terrateam role for each account. The repository's bootstrap module already limits the role to the Terrateam workflow path and sets the maximum AWS session duration to one hour.

## 2. Configure GitHub Actions variables

In GitHub, open **Settings -> Secrets and variables -> Actions -> Variables**. Create these repository variables:

| Name | Value |
| --- | --- |
| `DEV_TERRATEAM_ROLE_ARN` | dev `terrateam_role_arn` output |
| `DEV_TOFU_STATE_BUCKET` | dev `state_bucket_name` output |
| `DEV_AWS_REGION` | dev `aws_region` output |
| `PROD_TERRATEAM_ROLE_ARN` | prod `terrateam_role_arn` output |
| `PROD_TOFU_STATE_BUCKET` | prod `state_bucket_name` output |
| `PROD_AWS_REGION` | prod `aws_region` output |

Use **Variables**, not **Secrets**, for these six identifiers. Do not create static AWS credential secrets. If OpenTofu needs a secret input, create a GitHub Actions secret with a `TF_VAR_` prefix instead, such as `TF_VAR_database_password`.

## 3. Install Terrateam and commit its policy

1. In Terrateam Cloud, install the GitHub App for only `mcc-stats-suite`.
2. Accept Terrateam's generated `.github/workflows/terrateam.yml`. Check that it requests only the permissions Terrateam documents, including `id-token: write` for OIDC.
3. Copy the checked-in example without substituting values:

   ```sh
   cp .terrateam/config.yml.example .terrateam/config.yml
   git add .terrateam/config.yml .github/workflows/terrateam.yml
   git diff --cached --check
   git diff --cached
   ```

4. Confirm the staged diff has no AWS access key, token, private key, password, email address, populated `.tfvars`, or state data.
5. Open a pull request. Do not push these files directly to `main`.

The supplied configuration permits plans for contributors, requires writers or maintainers for dev applies, and requires administrators for prod applies. It never auto-applies.

## 4. Protect files that can obtain cloud access

Create `.github/CODEOWNERS` if it does not already exist. Replace `@YOUR_ORG/infra-admins` with a GitHub team that has at least two maintainers:

```text
/.terrateam/ @YOUR_ORG/infra-admins
/.github/workflows/ @YOUR_ORG/infra-admins
/infrastructure/ @YOUR_ORG/infra-admins
```

In GitHub, open **Settings -> Branches -> Add branch ruleset** and create a ruleset for `main` with these settings:

1. Require a pull request before merging.
2. Require approval from Code Owners.
3. Require at least one approval. Require two for production infrastructure if the team supports it.
4. Dismiss stale approvals when new commits are pushed.
5. Require status checks to pass, including the repository CI and Terrateam checks.
6. Block force pushes and direct pushes for everyone except a tightly controlled break-glass administrator group.
7. Do not allow administrators to bypass the ruleset unless a documented incident requires it.

Terrateam's `access_control` settings protect Terrateam operations when a pull request changes `.terrateam/config.yml` or the Terrateam workflow. Confirm that the Terrateam edition in use supports `ci_config_update` and `terrateam_config_update`; Terrateam documents those controls as Enterprise features. If it does not, do not allow Terrateam to run privileged plans against untrusted pull requests. Restrict runs to trusted maintainers until you add an equivalent control.

## 5. Harden the AWS OIDC trust policy

The bootstrap module already limits the role to this repository and `.github/workflows/terrateam.yml`. Keep that condition. Add Terrateam's second layer of protection: require the GitHub OIDC token's `actor` claim to equal `terrateam-action[bot]` for Terrateam Cloud.

In `infrastructure/modules/bootstrap/main.tf`, add this condition inside `data "aws_iam_policy_document" "terrateam_assume_role"`:

```hcl
condition {
  test     = "StringEquals"
  variable = "token.actions.githubusercontent.com:actor"
  values   = ["terrateam-action[bot]"]
}
```

If you self-host Terrateam, use the name of your GitHub App bot instead. Apply this change through the dev and prod bootstrap roots with your administrator SSO profile. Do not update the IAM role manually, because the next OpenTofu apply would overwrite the manual change.

The workflow-path condition prevents another workflow file from assuming the role. The actor condition prevents a manually triggered workflow from doing so. Neither condition makes a changed trusted workflow safe, which is why code-owner review and Terrateam's configuration-update controls are mandatory.

Keep the Terrateam role narrowly scoped. This repository currently attaches AWS `PowerUserAccess`; replace it with project-specific permissions before allowing many maintainers to apply infrastructure changes.

## 6. Use the GitOps workflow

1. Make an infrastructure change on a branch.
2. Open a pull request to `main`.
3. Let Terrateam create a plan. Review the plan and the changed files.
4. A permitted maintainer runs the Terrateam apply command for dev after review.
5. Promote the same reviewed release to prod in a separate pull request.
6. A permitted administrator reviews and applies prod.

Do not apply from a contributor fork or from a pull request that changes `.terrateam/config.yml`, `.github/workflows/terrateam.yml`, or the OIDC bootstrap without the required infrastructure-owner approval.

## 7. Verify the boundary before relying on it

After merging the initial setup:

1. Open a harmless branch that changes a Terraform comment and verify Terrateam can plan.
2. Confirm a repository writer can perform the intended dev apply but cannot apply prod.
3. Confirm a non-admin pull request that changes `.terrateam/config.yml` or `.github/workflows/terrateam.yml` is blocked from Terrateam operations.
4. From an unrelated GitHub Actions workflow, request an OIDC token and try `sts:GetCallerIdentity`. AWS must reject the role assumption.
5. Inspect CloudTrail after a Terrateam run. The assumed-role session should identify the expected Terrateam workflow and repository.

Review IAM role permissions, the trust policy, branch rules, Code Owners, and Terrateam access controls whenever you add a maintainer or a new environment.

## References

- [Terrateam AWS OIDC hardening](https://docs.terrateam.io/security/hardening-aws-oidc)
- [Terrateam secrets and variables](https://docs.terrateam.io/configuration/variables/)
- [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)
