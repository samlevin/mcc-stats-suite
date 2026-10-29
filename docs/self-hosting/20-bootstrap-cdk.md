# Bootstrap CDK and grant local deploy access

CDK bootstrap is separate from the OpenTofu bootstrap. Run the default bootstrap, `CDKToolkit`, once in each account and workload Region, dev first, with the administrator profile, and again after a CDK upgrade. No workflow runs it. Creating `CDKToolkit` creates IAM roles, and the GitHub CDK entry role can only assume `cdk-*` roles that already exist.

You can invoke `/apply-bootstrap` in Claude Code or `$apply-bootstrap` in Codex to run the commands on this page for you. An agent cannot start it for you. After the OpenTofu bootstrap roots, or right away if you reply `cdk` when `main` has nothing to plan there, it creates or upgrades `CDKToolkit` in dev, then in prod. It never touches the local bootstrap, which OpenTofu deploys as described [below](#bootstrap-local-deployments-separately). Before each stack it shows the deployed and pinned bootstrap versions, skips a stack that is already current, and waits for your approval. The commands below stay the reference.

Pass the Region explicitly. `aws configure get region` prints nothing when the profile sets no Region. Use the workload Region that the bootstrap root's `.envrc` exports as `TF_VAR_aws_region`. The account ID comes from the profile's `sso_account_id`:

```console
cd "$(git rev-parse --show-toplevel)"
export AWS_PROFILE=mcc-dev-admin AWS_REGION=<workload Region>
aws sso login
aws sts get-caller-identity
npx cdk bootstrap "aws://$(aws configure get sso_account_id)/$AWS_REGION" \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

Verify the account ID before approving. For prod, run the same commands with the prod administrator profile:

```console
export AWS_PROFILE=mcc-prod-admin AWS_REGION=<workload Region>
aws sso login
aws sts get-caller-identity
npx cdk bootstrap "aws://$(aws configure get sso_account_id)/$AWS_REGION" \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

The `CDKToolkit` stack belongs to CDK. Do not import it into OpenTofu. The GitHub CDK entry role from the OpenTofu bootstrap can assume the account's `cdk-*` roles, which in dev also covers the local `cdk-mcclocal1-*` roles described below. Those roles are narrower than the `hnb659fds` roles, so this grants GitHub Actions nothing new.

`AdministratorAccess` is a broad starting execution policy. Anyone who can assume the CDK deploy role can deploy almost anything in that account. Replace it with a reviewed project policy once the application resource set is stable.

## Bootstrap local deployments separately

Keep the default `hnb659fds` bootstrap for GitHub Actions. Local developers use the separate `mcclocal1` bootstrap, the `CDKToolkitLocal` stack in dev. The OpenTofu root `infrastructure/dev/local-cdk` deploys it from two committed files in that directory:

- `bootstrap-template.json`, which `scripts/local-cdk-bootstrap.mjs` generates from the CDK bootstrap template of the `aws-cdk` version pinned in `package-lock.json`; and
- the [stack policy](../../infrastructure/dev/local-cdk/stack-policy.json), `stack-policy.json`.

Terrateam plans and applies the root like the dev foundation root, as in [Change the foundation with Terrateam](70-optional-terrateam.md#change-the-foundation-with-terrateam), except that the apply comment is `terrateam apply dev and local-cdk`. CloudFormation creates the stack's IAM roles and policies with the caller's credentials, so apply the dev bootstrap first: it grants the dev Terrateam role access to this stack and its IAM resources ([Bootstrap the Terrateam role](70-optional-terrateam.md#bootstrap-the-terrateam-role)). Without Terrateam, a dev administrator applies the root with OpenTofu, using its `.envrc` created from `.envrc.example`, as in [Apply dev](40-change-foundation.md#apply-dev). Nobody runs `cdk bootstrap` for `mcclocal1`.

The stack policy stops any update from deleting or replacing the local policies. A stock `cdk bootstrap --qualifier mcclocal1` would otherwise replace the local roles' policies with the upstream `AdministratorAccess` execution policy, which every local developer can then use. The root's `prevent_destroy` stops any plan from deleting the stack.

See [Local CDK bootstrap design](../local-cdk-bootstrap-design.md) for the allowed resources, known limits, and boundary validation procedure.

### Change or upgrade the local bootstrap

To change the local permissions, edit `scripts/local-cdk-bootstrap.mjs`. To upgrade, update `aws-cdk` in `package-lock.json`. Either way, regenerate the template and commit it:

```console
npm run cdk:local-template
```

A test fails while the committed template differs from a fresh generation, or when it is larger than 51,200 bytes, the CloudFormation limit for an inline template body. Open a pull request, comment `terrateam plan`, review the plan for `infrastructure/dev/local-cdk`, then comment `terrateam apply dev and local-cdk`. If the stack policy rejects an update, the template is missing a local policy: fix the generator instead of removing the stack policy.

### Remove the local bootstrap

1. Revoke the local permission set's assignments.
2. Destroy every ephemeral stack. Their runtime roles use the local boundary, so the toolkit stack cannot be deleted while they exist, and deleting the execution role first leaves the stacks without a role to delete them with.
3. As the dev administrator, remove `prevent_destroy` from `infrastructure/dev/local-cdk/main.tf` in your checkout and run `tofu destroy` from that directory with its `.envrc`. Then delete the root and its `.terrateam/config.yml` entry in a pull request.
4. Empty and delete the retained `cdk-mcclocal1-*` staging bucket and ECR repository.

## Grant local deploy access

Developers deploy ephemeral stacks to dev from their own shells. Production deploys only from GitHub Actions. Do this after the dev `CDKToolkit` bootstrap and the first apply of `infrastructure/dev/local-cdk`.

1. In IAM Identity Center, create a group named `MccStatsSuiteLocalCdkDeployers`.
2. Create a custom permission set named `MccStatsSuiteLocalCdkDeploy` with a four-hour session. Do not attach `AdministratorAccess` or `PowerUserAccess`.
3. Copy [the policy template](policies/local-cdk-deployer-dev.json.template), replace every `DEV_ACCOUNT_ID` and `AWS_REGION` placeholder, and paste it as the permission set's inline policy. It allows assuming only the four `mcclocal1` CDK bootstrap roles, reading bootstrap metadata, and reading ephemeral match-to-csv logs. The log access covers live tail, log events, and Logs Insights queries and their results, only on `match-to-csv-e-*` Lambda and Step Functions log groups, so it never reaches stable dev logs. It also lists log group names and stops queries, because those actions cannot be limited to a log group. It does not allow `logs:DescribeQueries`, which would list every query in the account, so the console's query history is unavailable.
4. Assign the group and permission set to the dev account only. Never assign them to prod or to management accounts.
5. Add developers to the group, then point the `mcc-dev` SSO profile at this permission set.

Verify with an ephemeral stack:

```console
aws sso login --profile mcc-dev
aws sts get-caller-identity --profile mcc-dev
npm run app:diff -- match-to-csv --environment dev --ephemeral <name>
```

After the ephemeral stack is deployed, check log access:

```console
aws logs tail /aws/lambda/match-to-csv-e-<name>-ExtractText --profile mcc-dev
```

If CDK reports `sts:AssumeRole` denied, check that the role names in the policy match the `CDKToolkitLocal` account, Region, and `mcclocal1` qualifier. Do not fix the error with a broad AWS managed policy.

An `AccessDenied` that names `cdk-mcclocal1-cfn-exec-role` during a deploy, or `mcc-stats-suite-local-workload-boundary` at runtime, means the local policy lacks an action the application needs. Extend `scripts/local-cdk-bootstrap.mjs`, then change the local bootstrap as above. Never run `cdk bootstrap` for `mcclocal1`.

Next: [Configure GitHub and Release Please](30-configure-github.md).
