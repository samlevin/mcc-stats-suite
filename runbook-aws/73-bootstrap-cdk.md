# Bootstrap CDK

CDK bootstrap is distinct from the OpenTofu backend bootstrap. Run it once in
each stable account and workload Region, starting with dev.

```console
cd "$(git rev-parse --show-toplevel)"
direnv allow
export AWS_PROFILE=mcc-dev-admin
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
npx cdk bootstrap "aws://${MCC_DEV_ACCOUNT_ID}/${MCC_AWS_REGION}" \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

Verify the account ID before approval. Repeat only after dev is correct. Enter
the prod bootstrap directory so direnv loads the dedicated, one-time prod
administrator context:

```console
cd infrastructure/prod/bootstrap
cp .envrc.example .envrc
direnv allow
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
npx cdk bootstrap "aws://${MCC_PROD_ACCOUNT_ID}/${MCC_AWS_REGION}" \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

`AdministratorAccess` is a broad initial CloudFormation execution policy;
replace it with a reviewed project policy after the CDK resource set stabilizes.

The resulting `CDKToolkit` stack belongs to CDK. Do not import it into OpenTofu.
The bootstrap-created GitHub entry role can assume the account-local CDK roles.

A disposable developer account also requires CDK bootstrap, but only from its
owner's SSO session; it does not receive a GitHub CDK entry role.

Next: [Grant local CDK deployer access](74-grant-local-cdk-deployer-access.md).
