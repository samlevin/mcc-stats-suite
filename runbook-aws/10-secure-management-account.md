# Create and secure the management account

## Create the account

Create the first AWS account with the management-account email from the plan.
This account is both the organization management account and the only account
whose root user cannot be centrally removed by the organization.

Sign in by choosing **Root user** and using the account email. “Root” is an
identity inside the management account; it is not a different AWS account.

## Secure root before continuing

1. Store the unique root password in a controlled password manager.
2. Register at least two MFA authenticators. Prefer a hardware security key or
   passkey plus a separate backup authenticator.
3. Confirm that the root user has no access keys. Delete any that exist.
4. Configure account, security, operations, and billing alternate contacts.
5. Verify the root email and telephone recovery paths.
6. Enable billing alerts and a small initial budget or cost anomaly monitor.

Never use root for routine console, CLI, Control Tower, or workload activity.
The remaining root session is only for establishing the first administrative
federated identity and tasks that AWS explicitly reserves for root.

Keep management free of application workloads. Service control policies do not
restrict principals in the management account, so compromise there has a wider
blast radius than compromise of a member account.

References:

- [AWS Organizations management-account best practices](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_best-practices_mgmt-acct.html)
- [Secure AWS access keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/securing_access-keys.html)

Next: [Create the Control Tower landing zone](20-create-control-tower-landing-zone.md).

