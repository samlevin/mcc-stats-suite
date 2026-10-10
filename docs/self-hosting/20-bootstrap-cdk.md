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

## Bootstrap local deployments separately

Keep the default `hnb659fds` bootstrap for GitHub Actions. Local developers use the separate `mcclocal1` bootstrap and its restricted execution policy. As the dev administrator, verify the identity and create it:

```console
aws sts get-caller-identity --profile mcc-dev-admin
npx cdk bootstrap --show-template | node scripts/local-cdk-bootstrap.mjs > /tmp/mcc-local-bootstrap.yaml
npx cdk bootstrap "aws://${MCC_DEV_ACCOUNT_ID}/${MCC_AWS_REGION}" \
  --profile mcc-dev-admin --qualifier mcclocal1 \
  --toolkit-stack-name CDKToolkitLocal --template /tmp/mcc-local-bootstrap.yaml
```

The custom template scopes CloudFormation writes to the five application stack prefixes and explicitly denies every `<application>-dev*` stack. Its execution role can manage ephemeral compute and bounded runtime roles; it cannot call CloudFormation, assume roles, change bootstrap IAM, or pass existing privileged roles. Local runtime roles use a separate boundary that denies deployment and identity administration. It allows S3 writes and listing only under `ephemeral/<name>/` and reads only under `ephemeral/<name>/` and `incoming/<name>/`, where `<name>` is the `Ephemeral` tag CDK applies to the stack's roles. It also allows invoking or starting only ephemeral application compute. The lookup role has no AWS managed policy; it reads only stack metadata and the bootstrap version, because this repository makes no context lookups. The deployment role executes only change sets named `mcclocal1-deploy`. For ephemeral deploys, the wrapper passes `--change-set-name mcclocal1-deploy` and `--toolkit-stack-name CDKToolkitLocal`, and rejects hotswap, watch, and other deployment methods except `--method=direct`. Ephemeral synthesis selects this bootstrap and boundary automatically. GitHub Actions keeps the default bootstrap for shared stacks.

SES receipt-rule APIs do not support IAM resource scoping, so the local execution role allows their create, update, delete, and describe operations on `*` for ephemeral email routes. It does not allow changing or activating receipt rule sets. This boundary protects CloudFormation stack writes; it does not isolate SES rule contents from arbitrary local templates.

This policy covers the currently implemented resources. Review and extend it when an application introduces a new AWS resource type. Do not replace it with `AdministratorAccess`. Names beginning `<application>-dev` are reserved for shared resources, so ephemeral names cannot begin with `dev` or contain `-dev`. The bootstrap's IAM policy names are account-wide, matching the shared workload boundary, so bootstrap one Region per account.

For an existing installation, create `CDKToolkitLocal` first, then replace and reprovision the local permission set below. Revoke existing SSO role sessions or wait for them to expire before treating the boundary as active. Before granting local access, an administrator must destroy old ephemeral stacks and delete their change sets, then recreate them with the local bootstrap. This includes stacks whose ephemeral name begins with `dev`, such as `admin-devin`: the local bootstrap denies every `<application>-dev*` stack, so only an administrator can delete them. An existing stack or change set can retain its old administrator execution role. Do not create administrator-backed stacks under the ephemeral application prefixes after enabling local access.

## Grant local deploy access

Developers deploy ephemeral stacks to dev from their own shells. Production deploys only from GitHub Actions. Do this after both dev CDK bootstraps.

1. In IAM Identity Center, create a group named `MccStatsSuiteLocalCdkDeployers`.
2. Create a custom permission set named `MccStatsSuiteLocalCdkDeploy` with a four-hour session. Do not attach `AdministratorAccess` or `PowerUserAccess`.
3. Copy [the policy template](policies/local-cdk-deployer-dev.json.template), replace every `DEV_ACCOUNT_ID` and `AWS_REGION` placeholder, and paste it as the permission set's inline policy. It allows assuming only the four `mcclocal1` CDK bootstrap roles and reading bootstrap metadata.
4. Assign the group and permission set to the dev account only. Never assign them to prod or to management accounts.
5. Add developers to the group, then point the `mcc-dev` SSO profile at this permission set.

Verify with an ephemeral stack:

```console
aws sso login --profile mcc-dev
aws sts get-caller-identity --profile mcc-dev
npm run app:diff -- match-to-csv --environment dev --ephemeral <name>
```

If CDK reports `sts:AssumeRole` denied, check that the role names in the policy match the `CDKToolkitLocal` account, Region, and `mcclocal1` qualifier. Do not fix the error with a broad AWS managed policy.

## Validate the boundary

Use a disposable dev account. Sign in with the local permission set, verify the identity, and deploy, diff, and destroy `admin-<name>` through the wrapper. In that account, test `cdk deploy` and `cdk destroy` targeting `admin-dev`, and `aws cloudformation update-stack` and `delete-stack` targeting every `<application>-dev`; each write must return `AccessDenied`. Include `CreateChangeSet` and `ExecuteChangeSet` in policy simulation, and verify passing the default execution role, removing a runtime boundary, and creating an unbounded role are denied. Never run destructive denial probes against shared dev.

After the operator creates the local bootstrap and updates the permission set, verify a merge to `main` still deploys shared dev through GitHub Actions. AWS-free tests validate the generated policies and synthesizer selection; they do not replace this live validation.

Next: [Configure GitHub, Terrateam, and Release Please](30-configure-github.md).
