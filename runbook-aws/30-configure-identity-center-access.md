# Configure Identity Center access

Use the organization instance in the Control Tower home Region. Create one
human identity per person; do not create IAM users or access keys for routine
access.

## Create the first administrator

1. Open **IAM Identity Center → Users** and create the administrator user.
2. Open **Groups** and add that user to `AWSControlTowerAdmins` and
   `AWSAccountFactory` if Control Tower created those groups.
3. Sign out of root and confirm that the administrator can open Control Tower
   and Account Factory from the AWS access portal.

Use the root session only to repair the first assignment if this verification
fails.

## Prevent member-account Identity Center instances

This organization uses one central IAM Identity Center instance. Prevent a
member account from creating an isolated account instance:

1. Sign in to the management account as the Identity Center administrator.
2. Open **IAM Identity Center → Dashboard**.
3. In **Central management**, choose **Prevent account instances**.
4. Copy the AWS-generated SCP, choose **Go to SCP dashboard**, create the
   policy, and attach it to the **Organization root**.

The policy denies `sso:CreateInstance` for member accounts. It does not affect
the existing organization instance in the management account or normal Identity
Center assignments. Do not add exceptions: dev, prod, and disposable Sandbox
accounts should all use the central instance. Account instances are for
specialized, isolated single-account applications and cannot provide
permission-set access to other AWS accounts.

## Protect organization membership

In **AWS Organizations → Policies → Service control policies**, create
`DenyMemberAccountExitAndClosure` with the following policy, then attach it to
the **Organization root**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyMemberAccountExitAndClosure",
      "Effect": "Deny",
      "Action": [
        "organizations:LeaveOrganization",
        "account:CloseAccount"
      ],
      "Resource": "*"
    }
  ]
}
```

This stops identities in member accounts from removing or closing their own
account. SCPs do not restrict the management account, so intentional account
lifecycle operations remain managed centrally. Do not add broad service denies
or duplicate Control Tower controls here; test any future SCP in Sandbox first.

## Configure MFA

Under **IAM Identity Center → Settings → Authentication → Multi-factor
authentication**:

- Prompt users **Every time they sign in (always-on)**.
- Allow security keys and built-in authenticators.
- Allow authenticator apps as backup.
- Require users without a device to register one at sign-in.
- Ask administrators to register more than one authenticator.

Context-aware MFA trades security for convenience. Use it only after making an
explicit risk decision; do not select **Never** or email OTP as the normal
administrator policy.

## Use groups and permission sets

Keep the Control Tower-created groups. Create the two project groups and
permission sets below in IAM Identity Center, then assign each group to the
listed AWS accounts. Use AWS-managed policies inside the permission sets and
set administrative sessions to one hour.

| Group | Permission | Assignment |
|---|---|---|
| `AWSControlTowerAdmins` | Control Tower-created administrator access | Management and shared accounts |
| `PlatformAdministrators` | New `PlatformAdministratorAccess` permission set using `AdministratorAccess` | Stable dev, prod, owned sandboxes |
| `ProductionReaders` | New `ProductionReadOnlyAccess` permission set using `ViewOnlyAccess` or `ReadOnlyAccess` | Prod |
| `AWSAccountFactory` | Control Tower-created Service Catalog access | Management only |

For each assignment, open **IAM Identity Center → AWS accounts**, select the
account, choose **Assign users or groups**, select the group, and select its
permission set. Add people to groups; do not create one-off assignments for
each person. Verify the first administrator can enter the management account
as `AWSControlTowerAdmins` before signing out of root.

Keep membership in `AWSControlTowerAdmins` and `AWSAccountFactory` narrow. The
stable-account bootstrap initially requires a Platform Administrator because it
creates IAM and OIDC resources. Create the dev-only local CDK deployer group
after CDK bootstrap, using the dedicated runbook; do not use broad
`PowerUserAccess` for ordinary CDK work.

Control Tower also creates service groups and permission sets. Do not delete or
rename those merely to make the list cleaner.

If the Control Tower groups are absent, verify that landing-zone account access
is configured for IAM Identity Center in the same home Region and that the
landing-zone update has completed. Do not manually create look-alike Control
Tower groups while the integration is still reconciling.

Identity Center users enter member accounts from the AWS access portal. They do
not need the console's **Switch role** menu for routine access.

References:

- [Control Tower Identity Center groups](https://docs.aws.amazon.com/controltower/latest/userguide/sso-groups.html)
- [Prevent IAM Identity Center account instances](https://docs.aws.amazon.com/singlesignon/latest/userguide/control-account-instance.html)
- [Management-account security best practices](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_best-practices_mgmt-acct.html)
- [Configure Identity Center MFA](https://docs.aws.amazon.com/singlesignon/latest/userguide/mfa-configure.html)
- [Prompt users for MFA](https://docs.aws.amazon.com/singlesignon/latest/userguide/mfa-getting-started.html)

Next: [Provision workload accounts](40-provision-workload-accounts.md).
