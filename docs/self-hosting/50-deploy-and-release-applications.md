# Deploy, release, and roll back applications

Each application owns a CDK stack per environment:

```text
<application>-dev       shared dev stack, deployed by GitHub Actions
<application>-e-<name>  ephemeral stack in dev, deployed from a local shell
<application>-prod      production stack, deployed by GitHub Actions
```

`scripts/cdk-app.mjs` refuses plain `dev` and `prod` deploys outside GitHub Actions on `main`, refuses ephemeral deploys inside GitHub Actions, and refuses to destroy a stable stack. Ephemeral deploys use the local `mcclocal1` bootstrap, which deploys only through CloudFormation change sets named `mcclocal1-deploy`. The wrapper therefore rejects hotswap and watch, role ARN, toolkit stack, and change-set name options, the short `-r` and `-m` options, and deployment methods other than `--method=direct`.

For a stable deploy, the wrapper confirms that the active AWS account matches `MCC_DEV_ACCOUNT_ID` or `MCC_PROD_ACCOUNT_ID`, or the profile's `sso_account_id` when the variable is unset. It then builds `@mcc/cdk-config` and runs `cdk deploy` for the application, passing any other options through unchanged. The wrapper does not compare the release with the deployed template, so it will not stop a change that removes or replaces a stateful resource or a custom resource. The production job prints a CDK diff before it deploys, but nothing gates the deploy on that diff. If the deploy fails, see [Recover and troubleshoot](60-recover-and-troubleshoot.md#cdk-deployment-failure).

## Ephemeral stacks

Test application changes in an ephemeral stack before opening a pull request. Use the `mcc-dev` profile and a name of 1 to 20 lowercase letters, numbers, or hyphens that starts with a letter or number. Names such as `devin` and `sam-devtest` are allowed. The exact names `dev` and `prod` are reserved for the shared environments, and `incoming` and `ephemeral` are reserved object prefixes:

```console
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity
npm run app:synth -- <application> --environment dev --ephemeral <name>
npm run app:diff -- <application> --environment dev --ephemeral <name>
npm run app:deploy -- <application> --environment dev --ephemeral <name>
```

For `match-to-csv`, run `npm run verify:bundle --workspace @mcc/match-to-csv` after synthesis. The dev foundation owns the SES receipt rule set and publishes its name, the alias, and the domain in SSM, so the foundation must be applied before any ephemeral stack; the `match-to-csv-dev` stack is not required. An ephemeral stack adds one receipt rule to that rule set for `<alias>+<name>@<domain>` and stores mail under `incoming/<name>/`, so send test email to that address and it starts only your stack's workflow. Its evidence lives under `ephemeral/<name>/`. Destroying the stack removes its rule and leaves the rule set and the shared `<alias>@<domain>` rule alone. If the alias or domain changes later, the stack's `process-email` rejects any message not sent to the current `<alias>+<name>@<domain>`, so mail to the old address stops within one minute without a redeploy. Redeploy to receive mail at the new address.

Remove the stack when you are done:

```console
npm run app:destroy -- <application> --environment dev --ephemeral <name>
```

## Merge to production

1. Merge the pull request after its checks pass.
2. `CI: checks` validates the merge commit and records which applications it affects. A shared-package change affects every consumer, and an empty selection deploys nothing.
3. `Delivery: deploy to dev then prod` starts at that exact commit and runs one sequence per affected application. Each sequence deploys and verifies the application's `-dev` stack, then queues its `-prod` job.
4. The production job waits for approval on the `prod` environment. Finish the application's smoke test in dev first; for `match-to-csv`, see [Validate match-to-csv](#validate-match-to-csv).
5. Open the deployment run from the merged pull request’s approval comment or the Actions page. In the run, choose **Review deployments**, check the application and commit, and approve or reject with your GitHub account. The waiting job is named `Deploy <application> to prod (waits for approval)`. Rejecting leaves production unchanged.
6. Review the production CDK diff, confirm the deployment and stack verification succeed, and run the application's production health check.

Each application's production job depends only on its own successful dev job. A failed, cancelled, or skipped dev job blocks that application and nothing else. GitHub records every deployment, with its commit, application version, and shared-package versions, on the repository's Deployments page.

## Validate match-to-csv

After a `match-to-csv` change reaches dev, and before approving prod:

1. Send a representative PNG or JPEG screenshot to your configured inbound recipient.
2. Open the new `match-to-csv-dev` Step Functions execution and confirm every state succeeds.
3. In the evidence bucket, confirm the run contains the source image, metadata, run manifest, start and success events, Textract request and response, normalized observations, extracted table, CSV, and completion object.
4. Compare the CSV with the screenshot. OCR differences are observations to label, not corruption.

For a failure test, send an unsupported or undersized image. The submission records a rejection and the workflow does not report an empty success. For a provider failure, the run contains `RUN_STARTED`, `RUN_FAILED`, the provider request, and a failed completion object.

Never commit test messages, recipient addresses, or domains.

To get alarm email for a stable stack, create a `String` SSM parameter `/mcc/<environment>/match-to-csv/alarm-email` holding the address, then redeploy. The [application README](../../applications/match-to-csv/README.md) describes the alarms.

## Manage the sender allowlist

The optional `match-to-csv` sender allowlist is the SSM parameter `/mcc/<environment>/match-to-csv/sender-allowlist`. Use `/mcc/dev/match-to-csv/sender-allowlist` for shared dev and every ephemeral stack, and `/mcc/prod/match-to-csv/sender-allowlist` for production. A dev allowlist change affects all those dev stacks.

Create the parameter by hand as `String` or `StringList`. `process-email` splits the value on commas or whitespace and matches addresses without regard to case. Use comma-separated addresses for `StringList`, as Parameter Store requires. When the parameter exists, every `From` address must be listed. A message with no `From` address is rejected. If the parameter is missing, the allowlist accepts every sender; SES verdict screening and attachment validation still apply.

`process-email` checks the allowlist for each message. A warm Lambda caches the parameter value, including a missing parameter, for 60 seconds. Creation, updates, and deletion therefore take effect within one minute without a plan, pull request, or deploy. Keep this parameter hand-managed. Never add it to OpenTofu or commit its value or real sender addresses to the repository.

### AWS console

1. Sign in to the target environment's AWS account with its administrator permission set, as configured in [prerequisites](00-prerequisites.md#accounts), and select the Region where `match-to-csv` is deployed. Open **Systems Manager -> Parameter Store**.
2. To create the allowlist, choose **Create parameter**. Enter the environment's full parameter name above, choose the **Standard** tier, and choose **String** or **StringList** as the type. For `String`, keep the data type as **text**. Enter the allowed addresses, such as `player@example.test,teammate@example.test`, then choose **Create parameter**. See AWS's [console creation reference](https://docs.aws.amazon.com/systems-manager/latest/userguide/parameter-create-console.html) for the field descriptions.
3. To update it, open the parameter and choose **Edit**. Replace the value with the complete desired list, save the changes, then check the saved value.
4. To remove the restriction, select the parameter in Parameter Store, choose **Delete**, and confirm deletion. A missing parameter accepts every sender through the allowlist.

### AWS CLI

Use the administrator profiles from [prerequisites](00-prerequisites.md#sso-profiles). These examples use `mcc-dev-admin` in the dev account and its configured workload Region. For production, change both the profile to `mcc-prod-admin` and `environment` to `prod` before running any command. The local `mcc-dev` deploy profile cannot manage the allowlist. An alternative operator profile needs `ssm:PutParameter`, `ssm:GetParameter`, and `ssm:DeleteParameter` on `/mcc/<environment>/match-to-csv/sender-allowlist` in the target account and Region.

```console
export AWS_PROFILE=mcc-dev-admin
environment=dev
allowlist_parameter="/mcc/${environment}/match-to-csv/sender-allowlist"
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity
```

Confirm that `get-caller-identity` reports the intended dev or prod account before changing the parameter.

Create or replace the complete list with [`put-parameter --overwrite`](https://docs.aws.amazon.com/cli/latest/reference/ssm/put-parameter.html). Replace these placeholder addresses with your allowed senders locally. Use the existing parameter's type when updating it; this example creates a `String`.

```console
aws ssm put-parameter \
  --name "$allowlist_parameter" \
  --type String \
  --value 'player@example.test,teammate@example.test' \
  --overwrite
```

Read the saved type, value, and version:

```console
aws ssm get-parameter \
  --name "$allowlist_parameter" \
  --query 'Parameter.{Type:Type,Value:Value,Version:Version}'
```

To add or remove a sender, rerun `put-parameter --overwrite` with the entire revised list, then read it back. To remove the restriction entirely, delete the parameter:

```console
aws ssm delete-parameter --name "$allowlist_parameter"
aws ssm get-parameter --name "$allowlist_parameter"
```

The final read should return `ParameterNotFound`. Sender addresses in CLI history and output stay local; never copy them into a commit, issue, or pull request.

### Verify in dev

After saving the dev allowlist, wait one minute for cached values to expire, then send a valid screenshot from a listed sender to your dev or ephemeral recipient and confirm the workflow processes it. Send another from an unlisted sender and confirm the submission's `completion.json` has status `REJECTED` and rejection code `SENDER_NOT_ALLOWED`. Its `ingestion.json` records `senderAllowlist.status` as `DENIED`, and the raw MIME remains stored. Use messages that pass SES spam and virus checks so those checks do not obscure the allowlist result. After an update or deletion, wait one minute and send a new message to verify the new behavior without redeploying.

## Releases

Release Please versions each application and the shared `@mcc/cdk-config` and `@mcc/contracts` packages from Conventional Commit titles. It keeps one release pull request open. Merging it creates tags such as `match-to-csv-v1.2.3` and published GitHub Releases. Review the changelogs before merging; a shared-package change bumps every dependent application in the same pull request.

A release does not gate deployment. The release commit deploys like any other merge. The tags exist so you can roll back to a known version.

## Roll back

Rollback redeploys a previous release of one application to prod. It does not reset `main` or touch other applications.

1. Find the most recent known-good release tag for the application and confirm it appears in its production deployment history.
2. Run **Actions -> Delivery: roll back prod -> Run workflow** from `main`.
3. Select the application, enter the tag and the incident reason, and run it.
4. Approve the production job, review the CDK diff, and check production health.

The workflow accepts only a published, non-prerelease release tag for that application, on `main`, whose version matches the package, and with a previous successful prod deployment of the same commit.

Then fix forward. Open a normal pull request from current `main` that reverts or corrects the change, and let it go through CI, dev, and production approval. Do not reset `main` or move a release tag. Keep schema and data changes backward-compatible so a rollback stays safe.

Next: [Recover and troubleshoot](60-recover-and-troubleshoot.md).
