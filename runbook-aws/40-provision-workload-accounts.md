# Provision stable and disposable accounts

Use Account Factory while signed in through Identity Center, never as root.
Provision from the Control Tower home Region.

## Create stable dev and prod

From **Control Tower → Account factory → Create account**:

1. Create `dev` in the registered **Sandbox OU**.
2. Create `prod` in the registered **Production OU**.
3. Use a unique account email for each account.
4. Use the existing administrator's exact Identity Center email as the account
   SSO user rather than creating a duplicate user.
5. Do not add Account Factory customizations yet.

Wait until both accounts show **Enrolled** and their inherited
`AWSControlTowerBaseline` is enabled.
Assign `PlatformAdministrators` to both and `ProductionReaders` to prod. After
CDK bootstrap, use the dedicated local-CDK access runbook to grant the dev-only
deployer permission set. Do not grant ordinary developers production write
access.

An enrolled workload account may still show **Owner: Self**. Do not try to
change that field. It identifies account ownership, not governance; the
management, Audit, and Log Archive accounts created as part of the landing zone
may show **AWS Control Tower** instead. For dev and prod, verify **Enrolled**,
the registered parent OU, enabled baselines, and no drift.

If Account Factory reports **No launch paths found** or asks for Service Catalog
portfolio access, confirm that the signed-in Identity Center user belongs to
`AWSAccountFactory`. Root sessions cannot provision Account Factory accounts.

If a workload account already exists, do not recreate it merely for Account
Factory consistency. Move it to the intended registered OU and enroll it after
satisfying the `AWSControlTowerExecution` and AWS Config prerequisites. Recreate
only when the account is genuinely disposable and enrollment costs more than
replacement.

## Create an on-demand developer account

When account-level isolation is necessary, repeat Account Factory provisioning:

```text
Account name: <project>-dev-<owner>
OU: Sandbox
Owner: one named developer
Lifetime: days or weeks, not one pull request
```

Here, on-demand means the developer requests a governed account through the
Account Factory interface, then triggers all project deployments locally. Do
not bypass Control Tower with `organizations create-account`. Automate account
vending with Account Factory for Terraform only if the request volume later
justifies operating that additional platform.

The developer deploys OpenTofu and CDK locally through SSO. Do not connect the
account to Terrateam or GitHub Actions. Set a small account budget and record an
owner and review date outside the repository.

Prefer resetting and recycling a sandbox account over repeatedly closing and
creating accounts. Account closure suspends the account for 90 days and can
block Control Tower OU operations while it remains in a registered OU.

## Understand the two management roles

- `OrganizationAccountAccessRole` is an Organizations recovery/admin role in
  accounts created by Organizations. Invited accounts need it created manually
  if that recovery path is desired.
- `AWSControlTowerExecution` is the service role Control Tower uses to enroll
  and govern member accounts. Do not use or edit it for normal administration.

Accounts created by Account Factory arrive with the Control Tower role. An
existing account enrolled manually must satisfy Control Tower's role and AWS
Config prerequisites first.

References:

- [Provision accounts in the Control Tower console](https://docs.aws.amazon.com/controltower/latest/userguide/account-create-console.html)
- [Account Factory permissions and account lifecycle](https://docs.aws.amazon.com/controltower/latest/userguide/account-factory.html)
- [Enrollment prerequisites](https://docs.aws.amazon.com/controltower/latest/userguide/enrollment-prerequisites.html)

Next: [Centralize member-account root access](50-centralize-member-root-access.md).
