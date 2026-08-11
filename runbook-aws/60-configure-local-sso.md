# Configure local SSO profiles

Install AWS CLI v2. Never run `aws configure` with access-key credentials for
this project.

Create the administrator and read-only profiles needed before bootstrap:

```console
aws configure sso --profile mcc-management-admin
aws configure sso --profile mcc-dev-admin
aws configure sso --profile mcc-prod-admin
aws configure sso --profile mcc-prod-readonly
```

For each profile:

- Use the same SSO session name and AWS access portal URL.
- Set **SSO Region** to the Identity Center/Control Tower home Region.
- Select the matching account and permission set.
- Set **Default client Region** to the project's workload Region.
- Keep `dev` or `prod` in workload profile names; the project wrapper uses it
  as an account safety signal.

After [Grant local CDK deployer access](74-grant-local-cdk-deployer-access.md),
create `mcc-dev` with `MccStatsSuiteLocalCdkDeploy`. It is the normal local
deployment profile. Use `mcc-prod-readonly` for routine production inspection;
it is not a local deployment profile.

For a disposable account, use a name such as `mcc-dev-samlevin`.

Verify one profile at a time:

```console
aws sso login --profile mcc-dev-admin
aws sts get-caller-identity --profile mcc-dev-admin
```

Compare the returned account ID with the access portal before applying. The
AWS CLI stores SSO configuration and temporary cached tokens outside this
repository. Do not copy `~/.aws`, cached tokens, or shell exports into Git.

Local CDK deployment requires an explicit ephemeral name:

```console
npm run app:synth -- match-to-csv --ephemeral sam
```

Reference: [Configure IAM Identity Center authentication for AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html).

Next: [Bootstrap project accounts](70-bootstrap-project-accounts.md).
