# Centralize member-account root access

Do this after the member accounts are enrolled and ordinary Identity Center
administrator access has been verified. Perform these steps from an Identity
Center administrator session in the management account, not while signed in as
the management-account root user.

## Enable central root management

From the management account, open **IAM → Root access management**:

1. If the page offers **Enable**, enable trusted IAM access when prompted and
   enable root credential management and privileged root actions.
2. If the page already lists member accounts with **Take privileged action**,
   central root management is active. Do not look for additional enablement
   switches.
3. Keep administration in the management account for a small organization.
   Delegate it to a security account only when a separate security
   administrator will own the process.

## Remove member-account root credentials

For every member account, including stable dev, prod, Audit, and Log Archive:

1. Select the account.
2. Choose **Take privileged action**.
3. Choose **Delete root credentials**.
4. Confirm that the account reports no root credentials.

This removes the member root password, access keys, signing certificates, and
root MFA configuration. It does not delete the AWS account, its root identity,
or its root email address, and it does not affect Identity Center, workload
roles, or CI deployment roles. New organization-created accounts have no root
credentials by default after centralization is enabled.

Do not choose **Allow password recovery** during setup or routine operation.
That action re-opens direct member-root access to whoever controls the account's
root email. Treat it as an exceptional break-glass action outside this runbook,
then delete the recovered credentials immediately after the exceptional task.

The management-account root cannot be centralized. Keep its password and MFA
under the break-glass controls from the earlier runbook. Never create root
access keys.

If the member account's OU uses Control Tower's **Disallow actions as the root
user** control, enable its **Exempt requests made using AssumeRoot** option.
This allows only the centrally managed root-session recovery path; direct member
root sign-in remains unavailable because its credentials were removed.

References:

- [Centralize root access for member accounts](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_root-enable-root-access.html)
- [Perform a privileged task](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_root-user-privileged-task.html)

Next: [Configure local SSO](60-configure-local-sso.md).
