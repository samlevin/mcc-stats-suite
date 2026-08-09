# Create the Control Tower landing zone

Perform this once from the management account.

## Create the organization

1. Open **AWS Organizations**.
2. Create an organization with **all features** enabled.
3. Complete any email verification AWS requests.
4. Do not create workload accounts from Organizations. Account Factory will
   create governed accounts after the landing zone exists.

An account created directly through Organizations normally receives
`OrganizationAccountAccessRole`. An invited account does not. This role gives
the management account administrative recovery access; it is not a daily human
login and does not replace Identity Center.

## Align Identity Center and Control Tower

Select the planned home Region in the console. If IAM Identity Center is not
enabled, let Control Tower configure the organization instance. If it is already
enabled, verify that its primary Region is exactly the selected Control Tower
home Region before continuing.

## Launch Control Tower

1. Open **AWS Control Tower** in the chosen home Region.
2. Choose **Set up landing zone**.
3. Use the existing management account.
4. Use AWS-managed account access with IAM Identity Center.
5. Create or supply unique Audit and Log Archive account emails.
6. Create the optional **Sandbox OU**.
7. Retain the organization CloudTrail and logging defaults.
8. Select only the additional governed Regions the project needs.
9. Review estimated AWS Config, CloudTrail, and logging costs, then launch.

Wait for the landing-zone status to become available before making another
Control Tower change. Do not modify Control Tower-created StackSets, roles,
Config recorders, trails, or shared-account resources manually.

## Create the Production OU

Use the **Control Tower → Organization** page to create `Production`, then
register it. Confirm both `Sandbox` and `Production` show the
`AWSControlTowerBaseline` as enabled before provisioning accounts into them.

The two OU-level baselines are mutually exclusive:

- **AWS Control Tower baseline** is the full registration baseline. It includes
  the AWS Config resources needed by Control Tower as well as auditing, security
  monitoring, mandatory controls, and optional Identity Center access.
- **AWS Config baseline** installs only the Config resources needed for
  detective controls. It is a subset intended for an OU that is not using the
  full Control Tower baseline.

For this project, `Sandbox` and `Production` should show **AWS Control Tower
baseline: Enabled**. **AWS Config baseline: Not enabled** on those same OUs is
expected; do not try to enable it. The landing zone's AWS Config integration
must still be enabled because it is a prerequisite of the full baseline.

On landing zone 4.0, both baselines can show **Not applicable** for the Security
OU and its service-integration accounts because Control Tower manages them from
the landing-zone configuration instead.

## Compare controls between OUs

The **Controls → Enabled controls** page does not provide an account or OU
comparison filter. Controls are normally enabled on OUs and inherited by their
accounts. To inspect them without using an API:

1. Open **Control Tower → Organization**.
2. Select the `Production` OU name to open its details page.
3. Review the **Enabled controls** section on that OU.
4. Return to **Organization**, open `Sandbox`, and review the same section.

To inspect one account's enrollment or inherited-control drift, change the
**Organization** page selector to **Accounts**, then open the account name. The
account details page is not a general filter for the global Enabled controls
table.

References:

- [How AWS Control Tower works](https://docs.aws.amazon.com/controltower/latest/userguide/how-control-tower-works.html)
- [Extending governance to an existing organization](https://docs.aws.amazon.com/controltower/latest/userguide/about-extending-governance.html)
- [Guidance for Control Tower resources](https://docs.aws.amazon.com/controltower/latest/userguide/getting-started-guidance.html)
- [View Control Tower accounts](https://docs.aws.amazon.com/controltower/latest/userguide/view-your-accounts.html)
- [Control Tower baseline types](https://docs.aws.amazon.com/controltower/latest/userguide/types-of-baselines.html)

Next: [Configure initial Production controls](25-configure-production-controls.md).
