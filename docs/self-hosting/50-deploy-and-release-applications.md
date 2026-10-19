# Deploy, release, and roll back applications

Each application owns a CDK stack per environment:

```text
<application>-dev       shared dev stack, deployed by GitHub Actions
<application>-e-<name>  ephemeral stack in dev, deployed from a local shell
<application>-prod      production stack, deployed by GitHub Actions
```

`scripts/cdk-app.mjs` refuses plain `dev` and `prod` deploys outside GitHub Actions on `main`, refuses ephemeral deploys inside GitHub Actions, and refuses to destroy a stable stack. Ephemeral deploys use the local `mcclocal1` bootstrap, which deploys only through CloudFormation change sets named `mcclocal1-deploy`. The wrapper therefore rejects hotswap and watch, role ARN, toolkit stack, and change-set name options, the short `-r` and `-m` options, and deployment methods other than `--method=direct`.

For a stable deploy, the wrapper confirms that the active AWS account matches `MCC_DEV_ACCOUNT_ID` or `MCC_PROD_ACCOUNT_ID`, or the profile's `sso_account_id` when the variable is unset. It then builds `@mcc/cdk-config` and runs `cdk deploy` for the application, passing any other options through unchanged. The wrapper does not compare the release with the deployed template, so it will not stop a change that removes or replaces a stateful resource or a custom resource. The production job prints a CDK diff before it deploys, but nothing gates the deploy on that diff. If the deploy fails, see [Recover and troubleshoot](60-recover-and-troubleshoot.md#cdk-deployment-failure).

The CDK wrapper, roster, and recipients accept `-env` for `--environment`, `-e` for `--ephemeral`, and `-p` for `--profile`. Both `-env dev` and `-env=dev` work. Use `-h` or `--help` for the command's options. The [shared CLI convention](../../scripts/README.md) lists the alias table, value syntax, and entry point coverage.

## Ephemeral stacks

Test application changes in an ephemeral stack before opening a pull request. Use the `mcc-dev` profile and a name of 1 to 20 lowercase letters, numbers, or hyphens that starts with a letter or number. Names such as `devin` and `sam-devtest` are allowed. The exact names `dev` and `prod` are reserved for the shared environments, and `incoming` and `ephemeral` are reserved object prefixes:

```console
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity
npm run app:synth -- <application> -env dev -e <name>
npm run app:diff -- <application> --environment dev --ephemeral <name>
npm run app:deploy -- <application> --environment dev --ephemeral <name>
```

For `match-to-csv`, run `npm run verify:bundle --workspace @mcc/match-to-csv` after synthesis. The dev foundation owns the SES receipt rule set and publishes its name, the alias, and the domain in SSM, so the foundation must be applied before any ephemeral stack; the `match-to-csv-dev` stack is not required. An ephemeral stack adds one receipt rule to that rule set for `<alias>+<name>@<domain>` and stores mail under `incoming/<name>/`, so send test email to that address and it starts only your stack's workflow. Its evidence lives under `ephemeral/<name>/`. Destroying the stack removes its rule and leaves the rule set and the shared `<alias>@<domain>` rule alone. If the alias or domain changes later, the stack's `process-email` rejects any message not sent to the current `<alias>+<name>@<domain>`, so mail to the old address stops within one minute without a redeploy. Redeploy to receive mail at the new address.

Remove the stack when you are done:

```console
npm run app:destroy -- <application> --environment dev --ephemeral <name>
```

## Merge to production

Pull requests never deploy applications. `Release: release PR` deploys only applications whose releases Release Please publishes after a release pull request merges to `main`. Ordinary merges and releases containing only shared packages deploy nothing. Foundation changes are applied with OpenTofu instead; see [Change the foundation later](40-change-foundation.md#change-the-foundation-later).

1. Merge ordinary pull requests after their checks pass. Release Please collects their Conventional Commits into one release pull request.
2. Review that release pull request's versions and changelogs, then merge it. Release Please publishes component releases and tags. The release workflow reads the action's per-path outputs, selects only `applications/` releases, and passes each application's release tag and full release commit SHA to delivery.
3. Each released application deploys its `-dev` stack at that exact commit and verifies the resulting CloudFormation stack. For `match-to-csv`, verification also requires its Lambda functions and Step Functions state machines to be active.
4. After that application's dev deployment succeeds, its prod job waits for approval in the same release run. Applications have independent dev-to-prod dependencies, so another application's failure does not block a successful one. A skipped dev deployment does not request prod approval.
5. Finish the application's smoke test in dev; for `match-to-csv`, see [Validate match-to-csv](#validate-match-to-csv). Open the release run from the Actions page. Choose **Review deployments**, check the application, release tag and commit, and approve or reject with your GitHub account. The waiting job is named `Deploy <application> to prod (waits for approval)`. Pending or rejected approval leaves dev deployed. Rejecting leaves production unchanged.
6. Review the production CDK diff, confirm the deployment and stack verification succeed, and run the application's production health check.

GitHub records every deployment with its release tag, commit, application version and shared-package versions on the repository's Deployments page. Release delivery and rollback call `_delivery-deploy-environment.yml`, which retains account checks, scoped secrets and the prod environment's required reviewers with administrator bypass disabled. Deploy jobs run on `refs/heads/main` through that reusable workflow, even while checking out an older release commit, so the CDK role's OIDC trust needs no change.

Each application and environment has one concurrency group shared by forward deploys and rollback. It queues up to 100 pending jobs and never cancels a running deploy. Queue order follows when jobs start waiting, so the reusable workflow checks versions after approval and after acquiring the queue lock. A forward release skips successfully if its version is equal to or older than the latest successful deployment for that application and environment. The job summary names the requested and deployed versions. Failed deployments do not advance that baseline; legacy deployment records use their recorded application version. Missing version metadata on a successful record stops forward deployment for investigation. Rollback bypasses the version comparison, and its successful deployment becomes the baseline for later forward releases.

After merging workflow changes, confirm an ordinary PR merge starts no deploy. Merge the next release PR and confirm each released application deploys to dev, then waits for prod approval.

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

## Maintain the gamertag roster

Each environment's roster table holds the gamertag roster ([spec 1.2](../../specs/1.2-gamertag-roster.md)). No application reads it yet. Administrators maintain it with `scripts/roster.mjs`, which writes the table directly with their own AWS credentials. Only administrators change the roster. The script needs DynamoDB, KMS, and SSM rights that the `mcc-<environment>-admin` profiles from [prerequisites](00-prerequisites.md#sso-profiles) already have, and no narrower operator policy exists. The roster table must be applied in that environment's foundation first. The script also needs the AWS CLI and a repository checkout with dependencies installed.

```console
export AWS_PROFILE=mcc-dev-admin
aws sso login --profile "$AWS_PROFILE"
npm run roster -- -env dev list
npm run roster -- --environment dev add 'Player01' 'Player 02' --reason 'new season'
npm run roster -- --environment dev deactivate 'Player 02' --reason 'renamed'
npm run roster -- --environment dev reactivate 'Player 02'
npm run roster -- --environment dev list --all
npm run roster -- --environment dev history --after 10
```

`--environment` is required. Before any other AWS call, the script runs the same account check as `scripts/cdk-app.mjs`: it needs `AWS_PROFILE` or `--profile`, refuses a profile whose name implies the other environment, and refuses to continue unless the active account matches `MCC_DEV_ACCOUNT_ID` or `MCC_PROD_ACCOUNT_ID`, or the profile's `sso_account_id` when the variable is unset. It then reads the table name from `/mcc/<environment>/roster/table-name`.

- `list` shows active entries, or inactive ones with `--inactive` and every entry with `--all`, with each entry's ID, matching key, and the versions that added and last changed it. `history` shows the change log after a version, including who made each change.
- `add` takes one or more gamertags and stops at the first refusal. `deactivate` and `reactivate` take one gamertag, matched ignoring case. There is no delete. A renamed player is a deactivation and an add.
- The script refuses an invalid gamertag, a gamertag already on the roster in any case, and a gamertag whose matching key equals an active entry's (`KEY_CONFLICT`), and names the entries involved. When an add or reactivate leaves an active gamertag one key edit away, it prints a warning, because readings between the two will not resolve.
- In `prod`, each write prints the change and asks you to type `yes`. Pass `--yes` to skip the prompt.
- Exit status is 0 on success, 1 when a change is refused or declined, and 2 for a usage, account, AWS, or roster integrity error. When two administrators write at once, the script tries the write up to three times, then exits 1 with `CONCURRENT_CHANGE`. Run the command again.

To try changes without touching the shared roster, add `--ephemeral <name>` in dev. The script then reads and writes only that name's partition, which belongs to the ephemeral stacks of the same name. Production does not accept `--ephemeral`.

Gamertags are typed as arguments and printed only to your terminal. The script reads no input file and writes no file. Keep roster output out of commits, issues, and pull requests, as with sender addresses.

## Maintain the CSV recipient list

Each environment's recipient table holds the addresses that receive each submission's per-gamertag CSVs ([spec 1.1 §4.5](../../specs/1.1-mcc-analytics-engine.md#45-csv-recipient-list)). No application reads it yet. Administrators maintain it with `scripts/recipients.mjs`, which writes the table directly with their own AWS credentials. Only administrators change the list. The script needs DynamoDB, KMS, and SSM rights that the `mcc-<environment>-admin` profiles from [prerequisites](00-prerequisites.md#sso-profiles) already have, and no narrower operator policy exists. The recipient table must be applied in that environment's foundation first. The script also needs the AWS CLI and a repository checkout with dependencies installed.

```console
export AWS_PROFILE=mcc-dev-admin
aws sso login --profile "$AWS_PROFILE"
npm run recipients -- -env dev list
npm run recipients -- --environment dev add 'player@example.test' 'teammate@example.test' --reason 'new season'
npm run recipients -- --environment dev deactivate 'teammate@example.test' --reason 'left'
npm run recipients -- --environment dev reactivate 'teammate@example.test'
npm run recipients -- --environment dev list --all
npm run recipients -- --environment dev history --after 10
```

`--environment` is required. Before any other AWS call, the script runs the same account check as `scripts/cdk-app.mjs` and `npm run roster`: it needs `AWS_PROFILE` or `--profile`, refuses a profile whose name implies the other environment, and refuses to continue unless the active account matches `MCC_DEV_ACCOUNT_ID` or `MCC_PROD_ACCOUNT_ID`, or the profile's `sso_account_id` when the variable is unset. It then reads the table name from `/mcc/<environment>/recipients/table-name`.

- `list` shows active entries, or inactive ones with `--inactive` and every entry with `--all`, with each entry's ID and the versions that added and last changed it, sorted by address ignoring case. `history` shows the change log after a version, including who made each change.
- `add` takes one or more addresses and stops at the first refusal. `deactivate` and `reactivate` take one address, matched ignoring case. There is no delete. A changed address is a deactivation and an add.
- An address is trimmed and must have no spaces or commas, exactly one `@` with text on both sides, and at most 254 characters. The script refuses an invalid address (`INVALID_ADDRESS`) and an address already on the list in any case, active or inactive (`DUPLICATE_ADDRESS`), and names the entry involved.
- In `prod`, each write prints the change and asks you to type `yes`. Pass `--yes` to skip the prompt.
- Exit status is 0 on success, 1 when a change is refused or declined, and 2 for a usage, account, AWS, or recipient list integrity error. When two administrators write at once, the script tries the write up to three times, then exits 1 with `CONCURRENT_CHANGE`. Run the command again.

To try changes without touching the shared list, add `--ephemeral <name>` in dev. The script then reads and writes only that name's partition, which belongs to the ephemeral stacks of the same name. Production does not accept `--ephemeral`.

To verify the script in dev, use an ephemeral name and test addresses at a domain you control, or reserved ones such as `example.test`. Run `add` with two addresses, `list`, `deactivate` one, `list --inactive`, `reactivate` it, and `history`. Check that each write prints the new version, that `list` shows the expected statuses, and that `history` shows every change with your role ARN.

Addresses are typed as arguments and printed only to your terminal. The script reads no input file and writes no file. Keep recipient output out of commits, issues, and pull requests, as with sender addresses.

## Releases

Release Please versions each application and the shared `@mcc/cdk-config`, `@mcc/contracts`, `@mcc/roster`, and `@mcc/recipients` packages from Conventional Commit titles. It keeps one release pull request open. Merging it creates tags such as `match-to-csv-v1.2.3` and published GitHub Releases. Review the changelogs before merging; a shared-package change bumps every dependent application in the same pull request.

Only published application releases start forward deployment. Shared packages have no stacks to deploy. Their dependent applications deploy when those applications also have releases. Release tags identify the exact revision for delivery and rollback.

## Roll back

Rollback redeploys a previous release of one application to prod. It does not reset `main` or touch other applications.

1. Find the most recent known-good release tag for the application and confirm it appears in its production deployment history.
2. Run **Actions -> Delivery: roll back prod -> Run workflow** from `main`.
3. Select the application, enter the tag and the incident reason, and run it.
4. Approve the production job, review the CDK diff, and check production health.

The workflow accepts only a published, non-prerelease release tag for that application, on `main`, whose version matches the package, and with a previous successful prod deployment of the same commit.

Then fix forward. Open a normal pull request from current `main` that reverts or corrects the change, merge it after CI passes, then merge its release pull request for dev deployment and production approval. Do not reset `main` or move a release tag. Keep schema and data changes backward-compatible so a rollback stays safe.

Next: [Recover and troubleshoot](60-recover-and-troubleshoot.md).
