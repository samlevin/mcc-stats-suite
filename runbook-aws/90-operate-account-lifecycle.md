# Operate and retire accounts

## Routine checks

Review monthly:

- Control Tower landing-zone and OU drift
- Account baseline and AWS Config baseline status
- Member-account root credentials remain deleted and password recovery remains
  disabled
- Identity Center users, group membership, MFA, and permission assignments
- Unused sandbox accounts and CDK stacks
- Budgets, cost anomalies, and unexpected Regional spend
- Terrateam and GitHub deployment-role trust
- CloudTrail and security findings in the shared accounts

Enable paid services such as GuardDuty or Security Hub organization-wide only
after reviewing their coverage and cost. Control Tower controls and Config are
not substitutes for active security monitoring.

Trusted Advisor requires no landing-zone enablement. Its available checks and
recommendations depend on the AWS Support plan; review it as advisory input,
not as a substitute for Control Tower or security monitoring.

## Recycle a disposable sandbox

1. Confirm the owner and account ID.
2. Destroy personal CDK stacks.
3. Destroy the locally managed dev foundation while preserving anything the
   organization requires.
4. Check every enabled Region for residual resources and charges.
5. Remove human assignments or transfer the account to its next owner.
6. Reuse the account when practical.

## Close an account only when necessary

1. Unmanage the account from Control Tower and wait for **Not enrolled**.
2. Remove it from registered OUs as directed by Control Tower.
3. Close it from Organizations in the management account.
4. Record the 90-day suspension window and clean up the Service Catalog
   provisioned product when required.

Unmanaging is not closure. Service Catalog “terminate” unenrolls the account;
it does not delete the AWS account. Do not close Audit, Log Archive, or the
management account as part of sandbox cleanup.

References:

- [Unenroll a Control Tower account](https://docs.aws.amazon.com/controltower/latest/userguide/unmanage-account.html)
- [Close an Account Factory account](https://docs.aws.amazon.com/controltower/latest/userguide/delete-account.html)

The AWS landing zone is complete. Continue with the project
[runbook index](../runbooks/README.md).
