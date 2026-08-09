# Bootstrap stable dev

Use a Platform Administrator session in the stable dev account:

First, from the repository root, create the local environment file with
`cp .envrc.example .envrc`, replace its placeholders, and run `direnv allow`.

```console
cd infrastructure/dev/bootstrap
cp .envrc.example .envrc
direnv allow
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
cp bootstrap.auto.tfvars.example bootstrap.auto.tfvars
```

Stop unless STS reports the stable dev account. Populate the ignored input with
the CI-role choices. The root `.envrc` supplies the workload Region and exact
case-sensitive GitHub owner and repository; the directory `.envrc` selects the
dev administrator profile and GitHub Environment.
Leave both CI-role flags enabled.

If this AWS account already has the GitHub Actions OIDC provider, set
`github_oidc_provider_arn`. For repositories using immutable GitHub OIDC
subjects, also set `github_oidc_subject_repository` to
`OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID`.

Create the resources using temporary local state:

```console
tofu init -reconfigure
tofu plan -out=bootstrap.tfplan
tofu apply bootstrap.tfplan
```

The plan should contain only the state bucket, workload boundary, GitHub OIDC
provider when needed, Terrateam role, and CDK entry role.

Migrate the bootstrap state immediately:

```console
cp backend.hcl.example backend.hcl
tofu output bootstrap_backend_config
```

Copy those output values into the ignored `backend.hcl`, then create the
backend declaration and migrate:

```console
cp backend.tf.example backend.tf
tofu init -migrate-state -backend-config=backend.hcl
tofu plan
```

Approve the migration. The final plan must report no changes. Record these
outputs in the private setup record or GitHub runtime configuration:

```console
tofu output -raw aws_account_id
tofu output -raw state_bucket_name
tofu output -raw terrateam_role_arn
tofu output -raw cdk_deploy_role_arn
tofu output -raw workload_boundary_arn
```

Commit only source and `.terraform.lock.hcl`, never populated inputs or state.

Next: [Bootstrap stable prod](72-bootstrap-stable-prod.md).
