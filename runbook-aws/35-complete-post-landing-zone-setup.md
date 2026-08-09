# Complete AWS setup after the landing zone

Use this fast path when Control Tower and IAM Identity Center are healthy and
the only human access is an administrator assigned to the management account.
It consolidates the remaining settings for this project.

The completed setup has no static AWS credentials. Humans use Identity Center
SSO; GitHub Actions and Terrateam use repository-scoped OIDC roles.

## 1. Finish management-account access

In **IAM Identity Center → Groups**, add the existing administrator to the
Control Tower-created groups:

- `AWSControlTowerAdmins`
- `AWSAccountFactory`

Verify both groups retain their Control Tower-created management-account
assignments. Sign into the AWS access portal and verify Control Tower and
Account Factory access before removing any direct assignment from the user.
Do not create an IAM user or access key.

Prevent per-account IAM Identity Center instances now: open **IAM Identity
Center → Dashboard → Prevent account instances**, copy the generated SCP, then
create and attach it to the **Organization root** in AWS Organizations. This
denies `sso:CreateInstance` in member accounts without affecting the central
organization instance. Do not add dev, prod, or Sandbox exceptions.

In **AWS Organizations → Policies → Service control policies**, create and
attach this policy to the **Organization root**:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenyMemberAccountExitAndClosure",
    "Effect": "Deny",
    "Action": ["organizations:LeaveOrganization", "account:CloseAccount"],
    "Resource": "*"
  }]
}
```

It prevents principals in a member account from removing or closing that
account. It does not affect the management account, so intentional lifecycle
operations remain centralized. Leave other organization-wide guardrails to
Control Tower until a concrete need arises.

## 2. Create human permission sets

In **IAM Identity Center → Permission sets**, create:

| Permission set | AWS managed policy | Session | Purpose |
|---|---|---:|---|
| `PlatformAdministratorAccess` | `AdministratorAccess` | 1 hour | Bootstrap and break-glass administration |
| `ProductionViewAccess` | `ViewOnlyAccess` | 1 hour | Production inspection without mutation |

Create matching groups named `PlatformAdministrators` and `ProductionReaders`.
Add the current user to both for the initial solo
setup. Add future users through groups, not direct account assignments.

Assign groups from **IAM Identity Center → AWS accounts**:

| Account | Group | Permission set |
|---|---|---|
| Management | `AWSControlTowerAdmins` | Control Tower-created admin set |
| Management | `AWSAccountFactory` | Control Tower-created Account Factory set |
| Stable dev | `PlatformAdministrators` | `PlatformAdministratorAccess` |
| Prod | `PlatformAdministrators` | `PlatformAdministratorAccess` |
| Prod | `ProductionReaders` | `ProductionViewAccess` |
| Owned disposable dev | `PlatformAdministrators` | `PlatformAdministratorAccess` |

Do not assign local CDK deployer access to management or prod. Keep production
membership in `PlatformAdministrators` narrow. After CDK bootstrap, create the
dev-only `MccStatsSuiteLocalCdkDeployers` group and
`MccStatsSuiteLocalCdkDeploy` permission set through the dedicated local-CDK
access runbook. Permission sets control human access; they do not authenticate
CI/CD.

## 3. Confirm or create workload accounts

Use **Control Tower → Organization → Create resources → Create account**:

- Stable `dev`: registered `Sandbox` OU.
- Stable `prod`: registered `Production` OU.
- Disposable `<project>-dev-<owner>`: registered `Sandbox` OU.

Reuse an existing enrolled account rather than recreating it. Each target must
show `Enrolled`, inherit `AWSControlTowerBaseline: Enabled`, and show no drift.
`AWS Config baseline: Not enabled` is expected because the two OU baselines are
mutually exclusive.

Stable dev and prod receive CI roles. Disposable accounts remain local-only and
should be recycled rather than created per pull request.

## 4. Configure SSO profiles

Create separate profiles for everyday and administrative sessions:

```console
aws configure sso --profile mcc-management-admin
aws configure sso --profile mcc-dev-admin
aws configure sso --profile mcc-dev
aws configure sso --profile mcc-prod-admin
aws configure sso --profile mcc-prod-readonly
```

Use the Identity Center/Control Tower home Region as the SSO Region. Select the
matching account and permission set for each profile. For the current Ohio
landing zone, `us-east-2` is also a valid workload Region for SES receiving;
use it consistently unless another workload Region was deliberately selected.

Verify the profile before every bootstrap or deployment:

```console
export AWS_PROFILE=mcc-dev-admin
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity
```

The CLI configuration and temporary SSO cache live outside the repository.

## 5. Bootstrap stable dev and prod

In dev, copy the ignored bootstrap input:

```console
cd infrastructure/dev/bootstrap
cp bootstrap.auto.tfvars.example bootstrap.auto.tfvars
```

Use these settings, replacing only the placeholders:

```hcl
aws_region                  = "us-east-2"
github_organization         = "GITHUB_OWNER"
github_repository           = "mcc-stats-suite"
github_environment_name     = "dev"
create_terrateam_role       = true
create_cdk_deploy_role      = true

tags = {
  Owner = "YOUR_NAME_OR_TEAM"
}
```

For a repository using GitHub immutable OIDC subjects, also set:

```hcl
github_oidc_subject_repository = "OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID"
```

Run the local bootstrap with `mcc-dev-admin`, migrate its temporary state to the
new bucket, and require a final no-change plan by following
[Bootstrap stable dev](71-bootstrap-stable-dev.md). Repeat from the prod root
with `mcc-prod-admin`, `github_environment_name = "prod"`, and
[Bootstrap stable prod](72-bootstrap-stable-prod.md).

Each stable account creates:

- one encrypted OpenTofu state bucket;
- one GitHub OIDC provider, unless the account already has it;
- `mcc-stats-suite-<environment>-terrateam`;
- `mcc-stats-suite-<environment>-github-cdk-deploy`; and
- `mcc-stats-suite-workload-boundary`.

The Terrateam role trusts only this repository's Terrateam workflow. The CDK
entry role trusts only the named deployment workflow on `main` using its
matching `dev` or `prod` GitHub Environment.

## 6. Bootstrap CDK

Run CDK bootstrap once per stable account and workload Region through the
administrative SSO profile. Follow [Bootstrap CDK](73-bootstrap-cdk.md), first
for dev and then prod.

The initial CloudFormation execution policy is `AdministratorAccess`. This is
acceptable for the solo bootstrap but means anyone allowed to use those CDK
roles can indirectly deploy broadly. Replace it with a project-scoped execution
policy before granting stable-dev deployment access to a larger team.

## 7. Connect Terrateam

1. Install Terrateam Cloud for only this repository.
2. Accept and commit its generated `.github/workflows/terrateam.yml` on `main`.
3. Copy `.terrateam/config.yml.example` to `.terrateam/config.yml` and commit it.
4. Add these GitHub repository **Actions variables**:

```text
DEV_TERRATEAM_ROLE_ARN
DEV_TOFU_STATE_BUCKET
DEV_AWS_REGION
PROD_TERRATEAM_ROLE_ARN
PROD_TOFU_STATE_BUCKET
PROD_AWS_REGION
```

Use bootstrap outputs for the ARNs and bucket names. Terrateam receives
short-lived AWS sessions through OIDC; do not create `AWS_ACCESS_KEY_ID` or
`AWS_SECRET_ACCESS_KEY` secrets.

Dev foundation changes are applied from a dev promotion PR. After validation,
a separate prod promotion PR advances prod's `release_id`. Neither bootstrap
state is managed by Terrateam.

## 8. Connect GitHub Actions CDK deployments

Create GitHub Environments named `dev` and `prod`. Add these environment
**variables** to each using that account's bootstrap outputs:

```text
AWS_ACCOUNT_ID
AWS_CDK_DEPLOY_ROLE_ARN
AWS_REGION
```

Add this environment **secret** to each:

```text
STATS_RECIPIENT_EMAIL
```

Protect `prod` with `main` as the only deployment branch, a required reviewer,
no self-review when another maintainer exists, and no administrator bypass when
practical. Restrict `dev` to `main`; personal feature work deploys locally.

The `deploy-aws-application` workflow deploys `match-to-csv-dev` when `dev` is
selected and `match-to-csv-prod` when `prod` is selected. It never stores AWS
keys.

## 9. Use personal and disposable development

For a personal CDK stack in stable dev:

```console
export AWS_PROFILE=mcc-dev
aws sso login --profile "$AWS_PROFILE"
npm run app:deploy -- match-to-csv
```

The wrapper validates the SSO account and derives the qualifier from `whoami`,
producing a name such as `match-to-csv-samlevin`. Personal stacks have isolated
S3 prefixes and no email ingress.

For a disposable account, configure a profile such as
`mcc-dev-samlevin-admin`, use a separate checkout, and reuse the dev bootstrap
with:

```hcl
create_terrateam_role  = false
create_cdk_deploy_role = false
```

Apply its foundation and bootstrap CDK locally. Do not add the account to
Terrateam or GitHub Environments. Destroy project resources before recycling
the account.

## Completion check

- Human management access works without root or IAM users.
- Stable dev and prod are enrolled in registered OUs.
- Stable accounts have separate bootstrap and foundation state.
- Terrateam can plan only the durable foundation roots.
- GitHub Actions can deploy only through `dev` or `prod` Environments.
- Personal CDK stacks deploy locally to stable dev.
- Disposable accounts contain no CI trust.
- No long-lived AWS credential exists in GitHub or the repository.

Continue with the [project runbooks](../runbooks/README.md).
