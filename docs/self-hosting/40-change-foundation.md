# Apply and change the foundation

The foundation roots, `infrastructure/dev/foundation` and `infrastructure/prod/foundation`, hold KMS keys, durable storage, the SES receipt rule set, the Turbo cache bucket and role, and the SSM parameters that applications read. They are ordinary OpenTofu roots. Apply them by hand from an administrator session, or from any infrastructure CI/CD system that can run OpenTofu with AWS credentials for the target account. The commands below are the manual path; a CI/CD system runs the same `init`, `plan`, and `apply` steps with the same inputs. The merged commit is the foundation version; there is no separate release ID.

Whatever runs OpenTofu, keep these rules:

- Apply dev before prod, from the same commit, and compare the prod plan with the applied dev plan before applying prod.
- Review every plan before applying it.
- Only people trusted with production apply prod.
- Never run the foundation without its S3 backend.

## Inputs

Each root reads:

| Input | Where it comes from | Notes |
| --- | --- | --- |
| Backend `bucket` | the bootstrap's `state_bucket_name` output | Copy `backend.hcl.example` to the ignored `backend.hcl` and replace the placeholder, or pass `-backend-config=bucket=<name>`. The key is `operational/foundation.tfstate`. |
| Backend `region` | workload Region | In `backend.hcl`, or `-backend-config=region=<region>`. The example defaults to `us-east-1`. |
| `aws_region` | workload Region | Set it in `<environment>.auto.tfvars`. The example defaults to `us-east-1`, and its value overrides the `TF_VAR_aws_region` the root `.envrc` exports. |
| `email_domain` | verified SES domain for that environment, in lowercase | Required and sensitive. Set it in the ignored `<environment>.auto.tfvars` or export `TF_VAR_email_domain`. In CI/CD, store it as a secret, never a plain variable, and never commit it. |
| `github_oidc_subject_repository` | `OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID` | Needed when the repository uses immutable OIDC subjects, matching the bootstrap. The root `.envrc` exports it as `TF_VAR_github_oidc_subject_repository`. |
| `force_destroy` | `<environment>.auto.tfvars` | `true` in the dev example, `false` in prod. |
| `cache_service_role_arns` | optional | Extra same-account roles allowed to use the Turbo cache bucket. Defaults to none. |

The identity that applies the foundation needs to manage KMS, S3, SES receipt rules, SSM parameters, and the `mcc-stats-suite-<environment>-github-turbo-cache` IAM role with the `mcc-stats-suite-workload-boundary` permissions boundary, plus read and write access to the state bucket. The administrator permission sets from [prerequisites](00-prerequisites.md) are enough. For a CI/CD identity, see [CI roles for the foundation](10-bootstrap-accounts.md#ci-roles-for-the-foundation). To use Terrateam, as the upstream repository does, follow [Apply the foundation with Terrateam](70-optional-terrateam.md).

## Apply dev

From the repository root, with the dev administrator profile:

```console
cd infrastructure/dev/foundation
cp backend.hcl.example backend.hcl
cp dev.auto.tfvars.example dev.auto.tfvars
export AWS_PROFILE=mcc-dev-admin
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
```

Stop unless STS reports the dev account. Fill in `backend.hcl` and `dev.auto.tfvars`, then plan and apply:

```console
tofu init -backend-config=backend.hcl
tofu plan -out=foundation.tfplan
tofu apply foundation.tfplan
```

Read every planned action. Reject unexpected replacements, deletions, or policy changes, a plan for the wrong account, and creation of a named resource that already exists. Run `tofu plan` again afterwards; it must report no changes.

## Apply prod

Repeat at the same commit from `infrastructure/prod/foundation`:

```console
cd infrastructure/prod/foundation
cp backend.hcl.example backend.hcl
cp prod.auto.tfvars.example prod.auto.tfvars
export AWS_PROFILE=mcc-prod-admin
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
```

Stop unless STS reports the prod account. Never reuse the dev backend file or bucket. Compare the prod plan with the applied dev plan, allowing for environment names, account IDs, and values, before applying.

Each environment's foundation must exist before anything deploys there, including ephemeral stacks in dev. The `infrastructure/<environment>/data-platform` roots are inactive; skip them. See [Configure GitHub](30-configure-github.md#variables-and-secrets).

## Change the foundation later

1. Put reusable behavior in `infrastructure/modules/foundation` and environment-only values in the environment root.
2. Run the full infrastructure formatting, validation, and module-test loop in [TESTING.md](../../TESTING.md), along with `npm run check`.
3. Open a pull request. Plan dev and prod at the pull request's head commit, by hand or in your CI/CD, and review both plans. A module change affects both roots; a change to one environment root affects only that root.
4. Apply dev, validate it, then apply prod, both from that commit. If dev needs fixing, push a new commit, plan again, and reapply dev before prod.
5. Merge the pull request once every affected root has applied.

Apply from the pull request before merging, or from `main` right after merging. Pick one and keep to it, so `main` always matches what is deployed. If two changes can reach the same root at once, lock the root for the whole dev-then-prod sequence. The S3 lock file covers only a single `apply`.

If initialization reports a missing backend or a plan proposes recreating the foundation, stop and follow [Recover and troubleshoot](60-recover-and-troubleshoot.md#a-plan-wants-to-create-resources-that-already-exist).

Bootstrap changes are separate; see [Update bootstrap later](10-bootstrap-accounts.md#update-bootstrap-later).

## Detect drift

Run `tofu plan` against each root on a schedule, or use your CI/CD system's drift detection. A non-empty plan with no pending change means drift; see [Foundation drift](60-recover-and-troubleshoot.md#foundation-drift).

Next: [Deploy, release, and roll back applications](50-deploy-and-release-applications.md).
