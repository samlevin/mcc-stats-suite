# Bootstrap stable prod

Repeat the stable-dev bootstrap from the production root and with a production
Platform Administrator session:

```console
cd infrastructure/prod/bootstrap
cp .envrc.example .envrc
direnv allow
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
cp bootstrap.auto.tfvars.example bootstrap.auto.tfvars
```

Stop unless STS reports the production account. Populate the ignored input with
the CI-role choices. The root `.envrc` supplies the repository identity and
workload Region; the directory `.envrc` supplies the prod account ID, selects
the prod administrator profile, and sets the GitHub Environment. Keep both
CI-role flags enabled.

Run the local bootstrap apply, migrate its state to the production state bucket,
and require a final no-change plan. Never reuse the dev backend file, bucket, or
role ARN. Record the same outputs as dev with `PROD_` labels.

Production bootstrap remains human-operated. Terrateam and GitHub deployment
roles must not be allowed to change their own OIDC trust or bootstrap state.
This is a one-time seed, not a normal production deployment: it creates the
state bucket and CI identities that Terrateam and GitHub need before they can
operate. After its final no-change plan, production foundation changes go
through Terrateam and application changes go through the protected GitHub
production workflow.

Next: [Bootstrap CDK](73-bootstrap-cdk.md).
