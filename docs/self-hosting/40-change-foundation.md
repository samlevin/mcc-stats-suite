# Apply and change the foundation

The foundation roots, `infrastructure/dev/foundation` and `infrastructure/prod/foundation`, hold KMS keys, durable storage, the SES receipt rule set, the Turbo cache bucket and role, and the SSM parameters that applications read. They are ordinary OpenTofu roots. Apply them by hand from an administrator session, or from any infrastructure CI/CD system that can run OpenTofu with AWS credentials for the target account. The commands below are the manual path; a CI/CD system runs the same `init`, `plan`, and `apply` steps with the same inputs. The merged commit is the foundation version; there is no separate release ID.

Whatever runs OpenTofu, keep these rules:

- Apply dev before prod, from the same commit, and compare the prod plan with the applied dev plan before applying prod.
- Review every plan before applying it.
- Only people trusted with production apply prod.
- Never run the foundation without its S3 backend.

## Inputs

Each root's ignored `.envrc`, created from the `.envrc.example` in that directory, supplies every input, so `tofu init`, `plan`, and `apply` need nothing else. [Configure local inputs](10-bootstrap-accounts.md#configure-local-inputs) explains its layout.

| Input | Where it comes from | Notes |
| --- | --- | --- |
| Backend `bucket` and `region` | `TF_CLI_ARGS_init`, derived from the profile | `mcc-stats-suite-tofu-state-<account>-<region>`, the bucket the bootstrap created. The key, `operational/foundation.tfstate`, is in `versions.tf`. |
| `aws_region` | `TF_VAR_aws_region`, derived from the profile | The profile's Region, or `AWS_REGION` when the profile has none. |
| `email_domain` | `TF_VAR_email_domain`, read from the SSM parameter `/mcc/<environment>/match-to-csv/email-domain` | Verified SES domain for that environment, in lowercase. Required and sensitive. The applied foundation owns the parameter, so a local plan sees the applied domain and never changes it. The read needs a signed-in profile; when it fails, the `.envrc` warns and leaves the input unset. In CI/CD, store the domain as a secret, never a plain variable, and never commit it. |
| `github_oidc_subject_repository` | `TF_VAR_github_oidc_subject_repository`, which you edit | `OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID`, or `OWNER/REPOSITORY` with mutable OIDC subjects, matching the bootstrap. The Turbo cache role trusts only this repository, and a root without it creates no cache role. |
| `force_destroy` | variable default | `true` in dev, `false` in prod. |
| `cache_service_role_arns` | optional | Extra same-account roles allowed to use the Turbo cache bucket. Defaults to none. |

The identity that applies the foundation needs to manage KMS, S3, SES receipt rules, SSM parameters, and the `mcc-stats-suite-<environment>-github-turbo-cache` IAM role with the `mcc-stats-suite-workload-boundary` permissions boundary, plus read and write access to the state bucket. The administrator permission sets from [prerequisites](00-prerequisites.md) are enough. For a CI/CD identity, see [CI roles for the foundation](10-bootstrap-accounts.md#ci-roles-for-the-foundation). To use Terrateam, as the upstream repository does, follow [Apply the foundation with Terrateam](70-optional-terrateam.md).

## Apply dev

From the repository root, with the dev administrator profile:

```console
cd infrastructure/dev/foundation
cp .envrc.example .envrc
```

Edit the first section of `.envrc`, then load it and sign in:

```console
direnv allow
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
```

Stop unless STS reports the dev account. Run `direnv reload` after signing in, so the `.envrc` can read the email domain. The first apply in a new environment has no parameter to read yet: for that apply only, set `email_domain_override` in the `.envrc` to the lowercase domain verified for SES, and remove it afterwards. Then plan and apply:

```console
tofu init
tofu plan -out=foundation.tfplan
tofu apply foundation.tfplan
```

Read every planned action. Reject unexpected replacements, deletions, or policy changes, a plan for the wrong account, and creation of a named resource that already exists. Run `tofu plan` again afterwards; it must report no changes.

## Apply prod

Repeat at the same commit from `infrastructure/prod/foundation`:

```console
cd infrastructure/prod/foundation
cp .envrc.example .envrc
```

Edit the first section of `.envrc`, then run `direnv allow`, sign in, and check the identity as for dev. Stop unless STS reports the prod account. Never reuse the dev `.envrc` or bucket. Compare the prod plan with the applied dev plan, allowing for environment names, account IDs, and values, before applying.

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

## Change an external input

The email domain is set in one place, the `DEV_MCC_EMAIL_DOMAIN` or `PROD_MCC_EMAIL_DOMAIN` repository secret. Terrateam writes it to AWS, including the SSM parameter that local `.envrc` files and application deploys read. Terrateam's change detection cannot see a secret, so a change to the domain, or to any other secret that feeds a foundation root, goes through a pull request. To switch an environment to a new domain:

1. Prepare the new domain in that environment's account and workload Region, as in [Inbound email](00-prerequisites.md#inbound-email). Its SES identity must show `Success`, and its MX record must point at `inbound-smtp.<region>.amazonaws.com`. Without both, mail to the new domain never arrives, and every `match-to-csv` deploy fails its identity and MX checks.
2. Update the secret, for example `gh secret set PROD_MCC_EMAIL_DOMAIN`.
3. Open a pull request that adds a line with the date and the reason to `infrastructure/<environment>/foundation/external-inputs.revision`. Never write the value or a hash of it there.
4. Comment `terrateam plan`, review the `(sensitive value)` changes, and apply as in [Change the foundation with Terrateam](70-optional-terrateam.md#change-the-foundation-with-terrateam). The apply moves the shared `submit@` receipt rule and the SSM parameter to the new domain.
5. Redeploy `match-to-csv` in that environment. The deploy reads the domain from SSM and checks that its SES identity is verified and that its MX record points at SES inbound in the deployment Region, which confirms the switch. The shared stacks redeploy with the next change that affects `match-to-csv`, through [Merge to production](50-deploy-and-release-applications.md#merge-to-production), and receive mail before then because the foundation owns the shared rule. Each dev [ephemeral stack](50-deploy-and-release-applications.md#ephemeral-stacks) keeps its `submit+<name>@` rule on the old domain until its next deploy.
6. In each foundation root you plan from locally, run `direnv reload`, after `aws sso login --profile "$AWS_PROFILE"` if the session has expired. The `.envrc` reads the domain from SSM only when the directory loads. Until you reload it, a local plan proposes changing the domain back.

Steps 2 to 4 apply to every secret that feeds a foundation root.

Terrateam checks the foundation roots for drift daily and never reconciles, so a secret changed without a revision pull request shows up as a drift issue within a day and is never applied without review.

## Detect drift

Run `tofu plan` against each root on a schedule, or use your CI/CD system's drift detection. A non-empty plan with no pending change means drift; see [Foundation drift](60-recover-and-troubleshoot.md#foundation-drift).

Next: [Deploy, release, and roll back applications](50-deploy-and-release-applications.md).
