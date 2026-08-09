# Grant local CDK deployer access

Do this only after stable dev has completed [CDK bootstrap](73-bootstrap-cdk.md).
It grants humans local CDK deployment access to **dev only**. Production stays
GitHub-only.

## Create the group and permission set

In **IAM Identity Center → Groups**, create:

```text
MccStatsSuiteLocalCdkDeployers
```

In **IAM Identity Center → Permission sets**, create a **Custom permission
set** named `MccStatsSuiteLocalCdkDeploy` with a four-hour session duration. Do
not attach `AdministratorAccess` or `PowerUserAccess`.

Copy [the policy template](policies/local-cdk-deployer-dev.json.template),
replace both `DEV_ACCOUNT_ID` occurrences and `AWS_REGION`, and paste it as the
permission set's inline policy. It grants only the ability to assume the four
roles created by modern CDK bootstrap and read bootstrap deployment metadata.

## Assign and use it

1. In **IAM Identity Center → AWS accounts**, select the stable dev account.
2. Choose **Assign users or groups**.
3. Select `MccStatsSuiteLocalCdkDeployers` and
   `MccStatsSuiteLocalCdkDeploy`.
4. Add the intended developer to the group.
5. Reconfigure or sign in to the `mcc-dev` SSO profile using this permission
   set, then run `aws sso login --profile mcc-dev`.

Do not assign this group or permission set to prod, management, Audit, Log
Archive, or disposable accounts.

Verify with a personal dev stack:

```console
aws sts get-caller-identity --profile mcc-dev
npm run app:diff -- match-to-csv
npm run app:deploy -- match-to-csv
```

If CDK reports `sts:AssumeRole` denied, verify the four role names in the
policy match the `CDKToolkit` account, Region, and `hnb659fds` qualifier. Also
verify that their trust policies still allow same-account CDK deployment; do
not solve the error by granting a broad AWS managed policy.

The current CDK bootstrap execution role uses `AdministratorAccess`, so anyone
who can assume its deploy role can deploy broadly **within dev**. This
permission set is deliberately limited to dev. Tighten the CDK execution policy
and apply a permissions boundary when the application's resource set is stable.

References:

- [How CDK deployments use bootstrap roles](https://docs.aws.amazon.com/cdk/v2/guide/deploy.html)
- [Create an IAM Identity Center permission set](https://docs.aws.amazon.com/singlesignon/latest/userguide/howtocreatepermissionset.html)

Next: [Connect GitHub and Terrateam](80-connect-github-and-terrateam.md).
