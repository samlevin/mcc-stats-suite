# Bootstrap CDK and grant local deploy access

CDK bootstrap is separate from the OpenTofu bootstrap. Run it once in each account and workload Region, dev first, with the administrator profile:

```console
cd "$(git rev-parse --show-toplevel)"
export AWS_PROFILE=mcc-dev-admin
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
npx cdk bootstrap "aws://${MCC_DEV_ACCOUNT_ID}/${MCC_AWS_REGION}" \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

Verify the account ID before approving. For prod, enter the prod bootstrap directory so `direnv` loads the prod profile and account ID:

```console
cd infrastructure/prod/bootstrap
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
npx cdk bootstrap "aws://${MCC_PROD_ACCOUNT_ID}/${MCC_AWS_REGION}" \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

The `CDKToolkit` stack belongs to CDK. Do not import it into OpenTofu. The GitHub CDK entry role from the OpenTofu bootstrap can assume the account's `cdk-*` roles.

`AdministratorAccess` is a broad starting execution policy. Anyone who can assume the CDK deploy role can deploy almost anything in that account. Replace it with a reviewed project policy once the application resource set is stable.

## Grant local deploy access

Developers deploy ephemeral stacks to dev from their own shells. Production deploys only from GitHub Actions. Do this after the dev CDK bootstrap.

1. In IAM Identity Center, create a group named `MccStatsSuiteLocalCdkDeployers`.
2. Create a custom permission set named `MccStatsSuiteLocalCdkDeploy` with a four-hour session. Do not attach `AdministratorAccess` or `PowerUserAccess`.
3. Copy [the policy template](policies/local-cdk-deployer-dev.json.template), replace both `DEV_ACCOUNT_ID` occurrences and `AWS_REGION`, and paste it as the permission set's inline policy. It allows assuming the four CDK bootstrap roles and reading bootstrap metadata.
4. Assign the group and permission set to the dev account only. Never assign them to prod or to management accounts.
5. Add developers to the group, then point the `mcc-dev` SSO profile at this permission set.

Verify with an ephemeral stack:

```console
aws sso login --profile mcc-dev
aws sts get-caller-identity --profile mcc-dev
npm run app:diff -- match-to-csv --environment dev --ephemeral <name>
```

If CDK reports `sts:AssumeRole` denied, check that the role names in the policy match the `CDKToolkit` account, Region, and `hnb659fds` qualifier. Do not fix the error with a broad AWS managed policy.

Because the CDK execution policy is `AdministratorAccess`, this permission set can still change any stack in dev, including the shared `<application>-dev` stacks. [#32](https://github.com/samlevin/mcc-stats-suite/issues/32) tracks restricting it with IAM.

Next: [Configure GitHub, Terrateam, and Release Please](30-configure-github.md).
