# Bootstrap the dev and prod accounts

Each account has a local OpenTofu bootstrap root, `infrastructure/<environment>/bootstrap`, that you apply once from an administrator SSO session. It creates:

- an encrypted, versioned, deletion-protected S3 state bucket that requires TLS and retains noncurrent versions for 90 days; neither CI role operates the bootstrap state;
- the GitHub Actions OIDC provider, unless the account already has one;
- optionally, `mcc-stats-suite-<environment>-terrateam`, a role for [Terrateam](70-optional-terrateam.md), with an inline grant to manage only the `mcc-stats-suite-<environment>-github-turbo-cache` role;
- `mcc-stats-suite-<environment>-github-cdk-deploy`, with `PowerUserAccess`, trusted only by the deployment workflows on `main` in the matching GitHub Environment (see [Trusted deployment workflows](#trusted-deployment-workflows));
- `mcc-stats-suite-workload-boundary`, the permissions boundary for application roles.

Bootstrap stays local so that CI identities cannot rewrite their own trust. Never let infrastructure CI/CD apply the bootstrap roots.

## Configure local inputs

Each OpenTofu root under `infrastructure/<environment>/` has its own ignored `.envrc`, which you create from the committed `.envrc.example` in that directory. Each is self-contained, so `tofu init`, `plan`, and `apply` work from that directory with nothing else set. Every `.envrc` follows the rule stated at its top:

- `AWS_*` names are read by the AWS CLI and SDKs: `AWS_PROFILE`, and `AWS_REGION` only when the profile has no Region.
- `TF_VAR_<name>` sets the OpenTofu input `<name>` and nothing else.
- `TF_CLI_ARGS_init` carries the backend bucket and Region, so there are no backend files to fill in.

You edit the first section of each file. The second section reads the account ID and Region from the profile with `aws configure get`, which reads the local AWS config and makes no network call, and builds the state bucket name `mcc-stats-suite-tofu-state-<account>-<region>`. The foundation `.envrc` also reads the email domain from the applied foundation's SSM parameter, which needs a signed-in profile. If the profile has no `sso_account_id`, set `account_id` in the first section, without `export`.

| Root | You edit |
| --- | --- |
| bootstrap | `AWS_PROFILE`, `TF_VAR_github_organization`, `TF_VAR_github_oidc_subject_repository` |
| foundation | `AWS_PROFILE`, `TF_VAR_github_oidc_subject_repository`, and `email_domain_override` and `email_alias_override` only for the first apply in a new environment |
| data-platform | `AWS_PROFILE` |

The repository root has its own `.envrc`, created from the root `.envrc.example`. It sets only `AWS_PROFILE`, which `npm run app:*` reads. It defaults to `mcc-dev`, which works only after [local deploy access](20-bootstrap-cdk.md#grant-local-deploy-access) exists. Until then, use the administrator profiles the commands name.

Some repositories use immutable OIDC subjects. To check, print the `sub` claim of an OIDC token requested by any workflow in the repository. If it contains `@`, set `TF_VAR_github_oidc_subject_repository` to `OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID`, taking the IDs from `gh api repos/OWNER/REPOSITORY --jq '.owner.id, .id'`. Otherwise set it to `OWNER/REPOSITORY`. The foundation's optional Turbo cache role needs this value either way. A leftover placeholder becomes the trusted subject, and every GitHub role then rejects your workflows. A rename or transfer changes the subject and needs a bootstrap update.

The `match-to-csv` email domain is a foundation input, not bootstrap configuration; [Apply the foundation](40-change-foundation.md#inputs) describes how to supply it.

## Bootstrap dev

```console
cd infrastructure/dev/bootstrap
cp .envrc.example .envrc
cp bootstrap.auto.tfvars.example bootstrap.auto.tfvars
```

Edit the first section of `.envrc`, then load it and sign in:

```console
direnv allow
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
```

Stop unless STS reports the dev account. In `bootstrap.auto.tfvars`, keep `create_cdk_deploy_role = true` and keep the `create_terrateam_role = false` line unless you use Terrateam. Do not delete that line: the variable defaults to `true`. If the account already has a GitHub OIDC provider, also set `github_oidc_provider_arn` there. Leave `state_bucket_name` unset: every `.envrc` and Terrateam derive the bucket name from the account and Region.

Create the resources with temporary local state:

```console
tofu init -reconfigure
tofu plan -out=bootstrap.tfplan
tofu apply bootstrap.tfplan
```

The plan should contain only the resources listed above. Migrate the state into the new bucket immediately. `backend.tf.example` holds the state key, and the `.envrc` already passes the bucket and Region:

```console
cp backend.tf.example backend.tf
tofu init -migrate-state
tofu plan
```

Approve the migration. The final plan must report no changes. [GitHub configuration](30-configure-github.md) needs only the account ID, `tofu output -raw aws_account_id`. Keep it private; the workflows build the role ARNs and the bucket name from it.

## Bootstrap prod

Repeat the dev procedure from `infrastructure/prod/bootstrap`. Its `.envrc` selects the prod administrator profile. Stop unless STS reports the prod account. Never reuse the dev `.envrc`, bucket, or role ARNs.

## Update bootstrap later

CI never changes bootstrap resources, so apply every change to `infrastructure/modules/bootstrap` or the bootstrap roots locally, in dev first and then prod, from the same administrator sessions. Apply a bootstrap change before any foundation change that depends on it. For example, with the Terrateam role, the foundation's Turbo cache role needs the bootstrap cache-role grant first.

Run the AWS-free bootstrap contract tests before applying:

```console
tofu -chdir=infrastructure/dev/bootstrap init -backend=false -lockfile=readonly -test-directory=../../modules/bootstrap/tests
tofu -chdir=infrastructure/dev/bootstrap test -test-directory=../../modules/bootstrap/tests
```

Then run `tofu plan` in each bootstrap root and apply only the reviewed change.

Once the change is on `main`, you can invoke `/mcc-apply-bootstrap` in Claude Code or `$mcc-apply-bootstrap` in Codex instead. An agent cannot start it for you. It plans and applies both roots at the current `origin/main` commit, dev and then prod, from a detached worktree. It reads the same local `.envrc` and `bootstrap.auto.tfvars` files, checks the account before every step, and waits for your approval before each plan and apply.

### Trusted deployment workflows

The CDK entry role trusts a GitHub OIDC token only when its `workflow` claim matches an entry in `cdk_workflow_names` in `infrastructure/modules/bootstrap/variables.tf`. GitHub sets that claim to the `name:` of the top-level workflow that started the run, never to the name of a reusable workflow it calls. The list names the current callers of `.github/workflows/_delivery-deploy-environment.yml`: `Delivery: deploy to dev then prod` for continuous delivery and `Delivery: roll back prod` for prod rollback. It also holds `deploy-applications` and `rollback-aws-application`, two names that no workflow uses. Remove them in a bootstrap change once delivery and rollback have succeeded with the current names. `node --test scripts/deployment-workflows.test.mjs` checks the current callers and this exact list.

Prepare a rename or a new caller in a separate bootstrap pull request first. Add the future workflow name and preserve every current name. Merge that prerequisite, then re-apply bootstrap from `main`, dev first and then prod, before merging the workflow change:

```console
cd infrastructure/dev/bootstrap
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
tofu init
tofu plan -out=bootstrap.tfplan
tofu apply bootstrap.tfplan
```

Repeat from `infrastructure/prod/bootstrap`. Each plan should change only the assume-role policy of `mcc-stats-suite-<environment>-github-cdk-deploy`. Confirm both applies succeeded before merging the workflow rename or adding the caller. Otherwise it fails at `aws-actions/configure-aws-credentials` with `Not authorized to perform sts:AssumeRoleWithWebIdentity`. Keep the old names through the rename; remove them only in a follow-up bootstrap change after verifying delivery and rollback with the new names.

## CI roles for the foundation

The bootstrap creates no generic CI role for the foundation. To apply it from CI/CD, give that system its own role in each account. It needs to manage the foundation's resources, including the `mcc-stats-suite-<environment>-github-turbo-cache` IAM role with the `mcc-stats-suite-workload-boundary` permissions boundary, and to read and write the state bucket. Treat that role, and the workflow it trusts, as production access.

`create_terrateam_role = true` creates a role that only Terrateam can assume. See [Apply the foundation with Terrateam](70-optional-terrateam.md#bootstrap-the-terrateam-role).

## Disposable developer accounts

A personal sandbox account can reuse the dev bootstrap root without trusting GitHub. Use a separate checkout so its ignored `.envrc` files and `.terraform` directories can never be confused with dev, and set both flags to `false` in `bootstrap.auto.tfvars`:

```hcl
create_terrateam_role  = false
create_cdk_deploy_role = false
```

The root then creates state and the workload boundary only. Apply the dev foundation against that account's state bucket and bootstrap CDK from your own SSO session. The foundation needs `email_domain` and `email_alias`. For the first apply, set `email_domain_override` in that checkout's foundation `.envrc` to a lowercase domain verified for SES in that account, and `email_alias_override` to the lowercase part of the address before the @. Later plans read both from the parameters that apply creates. The apply makes `mcc-inbound-dev` the account's active receipt rule set. Do not add the account to your infrastructure CI/CD or GitHub Environments. Destroy CDK stacks and the foundation before recycling it.

## Keep local files untracked

These files are ignored and must stay that way: `**/backend.tf`, `**/*.auto.tfvars`, `*.tfstate*`, `*.tfplan`, `.env*`, and `.envrc`. Commit only source, `.example` files, and `.terraform.lock.hcl`. Account IDs and role ARNs are not credentials, but the repository is public, so GitHub keeps the account IDs as secrets and the workflows build the role ARNs from them.

Next: [Bootstrap CDK and grant local deploy access](20-bootstrap-cdk.md).
