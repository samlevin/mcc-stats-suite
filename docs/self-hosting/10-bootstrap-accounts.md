# Bootstrap the dev and prod accounts

Each account has a local OpenTofu bootstrap root, `infrastructure/<environment>/bootstrap`, that you apply once from an administrator SSO session. It creates:

- an encrypted, versioned, deletion-protected S3 state bucket;
- the GitHub Actions OIDC provider, unless the account already has one;
- optionally, `mcc-stats-suite-<environment>-terrateam`, a role for [Terrateam](70-optional-terrateam.md), with an inline grant to manage only the `mcc-stats-suite-<environment>-github-turbo-cache` role;
- `mcc-stats-suite-<environment>-github-cdk-deploy`, trusted only by the deployment workflows on `main` in the matching GitHub Environment (see [Trusted deployment workflows](#trusted-deployment-workflows));
- `mcc-stats-suite-workload-boundary`, the permissions boundary for application roles.

Bootstrap stays local so that CI identities cannot rewrite their own trust. Never let infrastructure CI/CD apply the bootstrap roots.

## Configure local inputs

From the repository root, copy the template, replace every placeholder, and allow it:

```console
cp .envrc.example .envrc
direnv allow
```

The root `.envrc` sets the workload Region, your GitHub owner and repository, and the dev profile and account ID. The `match-to-csv` email domain is a foundation input, not bootstrap configuration; [Apply the foundation](40-change-foundation.md#inputs) describes how to supply it. Set `MCC_AWS_REGION` to your workload Region.

Recently created repositories use immutable OIDC subjects. To check, print the `sub` claim of an OIDC token requested by any workflow in the repository. If it contains `@`, set `MCC_GITHUB_OIDC_SUBJECT_REPOSITORY` to `OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID`, taking the IDs from `gh api repos/OWNER/REPOSITORY --jq '.owner.id, .id'`. Otherwise delete that line and the `TF_VAR_github_oidc_subject_repository` line. A leftover placeholder becomes the trusted subject, and every GitHub role then rejects your workflows. A rename or transfer changes the subject and needs a bootstrap update.

The root `.envrc` defaults `AWS_PROFILE` to `mcc-dev`, which works only after [local deploy access](20-bootstrap-cdk.md#grant-local-deploy-access) exists. Until then, use the administrator profiles the commands name.

## Bootstrap dev

```console
cd infrastructure/dev/bootstrap
cp .envrc.example .envrc
cp bootstrap.auto.tfvars.example bootstrap.auto.tfvars
direnv allow
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
```

Stop unless STS reports the dev account. In `bootstrap.auto.tfvars`, keep `create_cdk_deploy_role = true` and keep the `create_terrateam_role = false` line unless you use Terrateam. Do not delete that line: the variable defaults to `true`. If the account already has a GitHub OIDC provider, also set `github_oidc_provider_arn` there.

Create the resources with temporary local state:

```console
tofu init -reconfigure
tofu plan -out=bootstrap.tfplan
tofu apply bootstrap.tfplan
```

The plan should contain only the resources listed above. Migrate the state into the new bucket immediately. Copy the values from `tofu output bootstrap_backend_config` into `backend.hcl`:

```console
cp backend.hcl.example backend.hcl
tofu output bootstrap_backend_config
cp backend.tf.example backend.tf
tofu init -migrate-state -backend-config=backend.hcl
tofu plan
```

Approve the migration. The final plan must report no changes. Keep these outputs somewhere private; [GitHub configuration](30-configure-github.md) needs them:

```console
tofu output -raw aws_account_id
tofu output -raw state_bucket_name
tofu output -raw cdk_deploy_role_arn
```

## Bootstrap prod

Repeat the dev procedure from `infrastructure/prod/bootstrap`. Its `.envrc` selects the prod administrator profile and sets the prod account ID. Stop unless STS reports the prod account. Never reuse the dev backend file, bucket, or role ARNs.

## Update bootstrap later

CI never changes bootstrap resources, so apply every change to `infrastructure/modules/bootstrap` or the bootstrap roots locally, in dev first and then prod, from the same administrator sessions. Apply a bootstrap change before any foundation change that depends on it. For example, with the Terrateam role, the foundation's Turbo cache role needs the bootstrap cache-role grant first.

Run the AWS-free bootstrap contract tests before applying:

```console
tofu -chdir=infrastructure/dev/bootstrap init -backend=false -lockfile=readonly -test-directory=../../modules/bootstrap/tests
tofu -chdir=infrastructure/dev/bootstrap test -test-directory=../../modules/bootstrap/tests
```

Then run `tofu plan` in each bootstrap root and apply only the reviewed change.

Once the change is on `main`, you can invoke `/mcc-apply-bootstrap` in Claude Code or `$mcc-apply-bootstrap` in Codex instead. An agent cannot start it for you. It plans and applies both roots at the current `origin/main` commit, dev and then prod, from a detached worktree. It reads the same local `.envrc`, `backend.hcl`, and `bootstrap.auto.tfvars` files, checks the account before every step, and waits for your approval before each plan and apply.

### Trusted deployment workflows

The CDK entry role trusts a GitHub OIDC token only when its `workflow` claim matches an entry in `cdk_workflow_names` in `infrastructure/modules/bootstrap/variables.tf`. GitHub sets that claim to the `name:` of the top-level workflow that started the run, never to the name of a reusable workflow it calls. The list therefore names every workflow that calls `.github/workflows/_deploy-aws-application.yml`: `deploy-applications` for continuous delivery and `rollback-aws-application` for production rollback. `node --test scripts/deployment-workflows.test.mjs` fails when the list and those workflows disagree.

When you rename one of those workflows, or add a workflow that calls the reusable deployment workflow, update the list in the same pull request. After it merges, re-apply bootstrap from the `main` checkout, dev first and then prod:

```console
cd infrastructure/dev/bootstrap
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
tofu init -backend-config=backend.hcl
tofu plan -out=bootstrap.tfplan
tofu apply bootstrap.tfplan
```

Repeat from `infrastructure/prod/bootstrap`. Each plan should change only the assume-role policy of `mcc-stats-suite-<environment>-github-cdk-deploy`. Until both accounts are re-applied, a renamed or new workflow fails at `aws-actions/configure-aws-credentials` with `Not authorized to perform sts:AssumeRoleWithWebIdentity`. Afterwards, re-run the failed workflow.

## CI roles for the foundation

The bootstrap creates no generic CI role for the foundation. To apply it from CI/CD, give that system its own role in each account. It needs to manage the foundation's resources, including the `mcc-stats-suite-<environment>-github-turbo-cache` IAM role with the `mcc-stats-suite-workload-boundary` permissions boundary, and to read and write the state bucket. Treat that role, and the workflow it trusts, as production access.

`create_terrateam_role = true` creates a role that only Terrateam can assume. See [Apply the foundation with Terrateam](70-optional-terrateam.md#bootstrap-the-terrateam-role).

## Disposable developer accounts

A personal sandbox account can reuse the dev bootstrap root without trusting GitHub. Use a separate checkout so its ignored backend files and `.terraform` directory can never be confused with dev, and set both flags to `false` in `bootstrap.auto.tfvars`:

```hcl
create_terrateam_role  = false
create_cdk_deploy_role = false
```

The root then creates state and the workload boundary only. Apply the dev foundation against that account's state bucket and bootstrap CDK from your own SSO session. The foundation needs `email_domain`: set it in the ignored `dev.auto.tfvars` or export `TF_VAR_email_domain`, using a lowercase domain verified for SES in that account. The apply makes `mcc-inbound-dev` the account's active receipt rule set. Do not add the account to your infrastructure CI/CD or GitHub Environments. Destroy CDK stacks and the foundation before recycling it.

## Keep local files untracked

These files are ignored and must stay that way: `**/backend.hcl`, `**/*.auto.tfvars`, `*.tfstate*`, `*.tfplan`, `.env*`, and `.envrc`. Commit only source, `.example` files, and `.terraform.lock.hcl`. Role ARNs and account IDs are not credentials, but keeping them in GitHub variables keeps forks portable and the account layout private.

Next: [Bootstrap CDK and grant local deploy access](20-bootstrap-cdk.md).
