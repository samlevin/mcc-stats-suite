# Bootstrap the dev and prod accounts

Each account has a local OpenTofu bootstrap root, `infrastructure/<environment>/bootstrap`, that you apply once from an administrator SSO session. It creates:

- an encrypted, versioned, deletion-protected S3 state bucket;
- the GitHub Actions OIDC provider, unless the account already has one;
- `mcc-stats-suite-<environment>-terrateam`, trusted only by this repository's Terrateam workflow;
- `mcc-stats-suite-<environment>-github-cdk-deploy`, trusted only by the deployment workflow on `main` in the matching GitHub Environment;
- an inline Terrateam grant to manage only the `mcc-stats-suite-<environment>-github-turbo-cache` role; and
- `mcc-stats-suite-workload-boundary`, the permissions boundary for application roles.

Bootstrap stays local so that CI identities cannot rewrite their own trust. Terrateam ignores both bootstrap roots.

## Configure local inputs

From the repository root, copy the template, replace every placeholder, and allow it:

```console
cp .envrc.example .envrc
direnv allow
```

The root `.envrc` sets the workload Region, your GitHub owner and repository, the dev profile and account ID, and the `match-to-csv` email domain. Repositories created recently use immutable OIDC subjects. If yours does, set `MCC_GITHUB_OIDC_SUBJECT_REPOSITORY` to `OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID`. A rename or transfer changes the subject and needs a bootstrap update.

## Bootstrap dev

```console
cd infrastructure/dev/bootstrap
cp .envrc.example .envrc
cp bootstrap.auto.tfvars.example bootstrap.auto.tfvars
direnv allow
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
```

Stop unless STS reports the dev account. Leave both CI-role flags in `bootstrap.auto.tfvars` set to `true`. If the account already has a GitHub OIDC provider, also set `github_oidc_provider_arn` there.

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
tofu output -raw terrateam_role_arn
tofu output -raw cdk_deploy_role_arn
```

## Bootstrap prod

Repeat the dev procedure from `infrastructure/prod/bootstrap`. Its `.envrc` selects the prod administrator profile and sets the prod account ID. Stop unless STS reports the prod account. Never reuse the dev backend file, bucket, or role ARNs.

## Update bootstrap later

Terrateam cannot change bootstrap resources, so apply every change to `infrastructure/modules/bootstrap` or the bootstrap roots locally, in dev first and then prod, from the same administrator sessions. Apply a bootstrap change before any foundation change that depends on it. For example, the foundation's Turbo cache role needs the bootstrap cache-role grant first.

Run the AWS-free bootstrap contract tests before applying:

```console
tofu -chdir=infrastructure/dev/bootstrap init -backend=false -lockfile=readonly -test-directory=../../modules/bootstrap/tests
tofu -chdir=infrastructure/dev/bootstrap test -test-directory=../../modules/bootstrap/tests
```

Then run `tofu plan` in each bootstrap root and apply only the reviewed change.

## Disposable developer accounts

A personal sandbox account can reuse the dev bootstrap root without trusting GitHub. Use a separate checkout so its ignored backend files and `.terraform` directory can never be confused with dev, and set both flags to `false` in `bootstrap.auto.tfvars`:

```hcl
create_terrateam_role  = false
create_cdk_deploy_role = false
```

The root then creates state and the workload boundary only. Apply the dev foundation against that account's state bucket and bootstrap CDK from your own SSO session. Do not add the account to Terrateam or GitHub Environments. Destroy CDK stacks and the foundation before recycling it.

## Keep local files untracked

These files are ignored and must stay that way: `**/backend.hcl`, `**/*.auto.tfvars`, `*.tfstate*`, `*.tfplan`, `.env*`, and `.envrc`. Commit only source, `.example` files, and `.terraform.lock.hcl`. Role ARNs and account IDs are not credentials, but keeping them in GitHub variables keeps forks portable and the account layout private.

Next: [Bootstrap CDK and grant local deploy access](20-bootstrap-cdk.md).
