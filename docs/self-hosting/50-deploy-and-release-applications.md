# Deploy, release, and roll back applications

Each application owns a CDK stack per environment:

```text
<application>-dev       shared dev stack, deployed by GitHub Actions
<application>-e-<name>  ephemeral stack in dev, deployed from a local shell
<application>-prod      production stack, deployed by GitHub Actions
```

`scripts/cdk-app.mjs` refuses plain `dev` and `prod` deploys outside GitHub Actions on `main`, refuses ephemeral deploys inside GitHub Actions, and refuses to destroy a stable stack. Ephemeral deploys use the local `mcclocal1` bootstrap, which deploys only through CloudFormation change sets named `mcclocal1-deploy`. The wrapper therefore rejects hotswap and watch, role ARN, toolkit stack, and change-set name options, the short `-r` and `-m` options, and deployment methods other than `--method=direct`.

For a stable deploy, the wrapper confirms that the active AWS account matches `MCC_DEV_ACCOUNT_ID` or `MCC_PROD_ACCOUNT_ID`, or the profile's `sso_account_id` when the variable is unset. It then builds `@mcc/cdk-config` and runs `cdk deploy` for the application, passing any other options through unchanged. The wrapper does not compare the release with the deployed template, so it will not stop a change that removes or replaces a stateful resource or a custom resource. The production job prints a CDK diff before it deploys, but nothing gates the deploy on that diff. If the deploy fails, see [Recover and troubleshoot](60-recover-and-troubleshoot.md#cdk-deployment-failure).

The CDK wrapper, roster, recipients, and sender allowlist scripts accept `-env` for `--environment` and `-p` for `--profile`, and all but the sender allowlist accept `-e` for `--ephemeral`. Both `-env dev` and `-env=dev` work. Use `-h` or `--help` for the command's options. The [shared CLI convention](../../scripts/README.md) lists the alias table, value syntax, and entry point coverage.

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

Pull requests never deploy applications. `Delivery: deploy application releases` deploys only applications whose releases Release Please publishes after a release pull request merges to `main`. `Release: release PR` starts it only when a push to `main` publishes at least one application release, so ordinary merges and releases containing only shared packages deploy nothing and create no deploy run. Foundation changes are applied with OpenTofu instead; see [Change the foundation later](40-change-foundation.md#change-the-foundation-later).

1. Merge ordinary pull requests after their checks pass. Release Please collects their Conventional Commits into one release pull request.
2. Review that release pull request's versions and changelogs, then merge it. Release Please publishes component releases and tags. The release workflow reads the action's per-path outputs, selects only `applications/` releases, and starts `Delivery: deploy application releases` on `main` with each application's release tag and full release commit SHA. That workflow first checks that each tag is a published GitHub Release whose commit is that SHA and is on `main`.
3. Each released application deploys its `-dev` stack at that exact commit and verifies the resulting CloudFormation stack. For `match-to-csv`, verification also requires its Lambda functions and Step Functions state machines to be active.
4. After that application's dev deployment succeeds, its prod job waits for approval in the same deploy run. Applications have independent dev-to-prod dependencies, so another application's failure does not block a successful one. A skipped dev deployment does not request prod approval.
5. Finish the application's smoke test in dev; for `match-to-csv`, see [Validate match-to-csv](#validate-match-to-csv). Open the `Delivery: deploy application releases` run from the Actions page. Choose **Review deployments**, check the application, release tag and commit, and approve or reject with your GitHub account. The waiting job is named `Deploy <application> to prod (waits for approval)`. Pending or rejected approval leaves dev deployed. Rejecting leaves production unchanged.
6. Review the production CDK diff, confirm the deployment and stack verification succeed, and run the application's production health check.

GitHub records every deployment with its release tag, commit, application version and shared-package versions on the repository's Deployments page. Release delivery and rollback call `_delivery-deploy-environment.yml`, which retains account checks, scoped secrets and the prod environment's required reviewers with administrator bypass disabled. Deploy jobs run on `refs/heads/main` through that reusable workflow, even while checking out an older release commit, so the CDK role's OIDC trust needs no change.

Each application and environment has one concurrency group shared by forward deploys and rollback. It queues up to 100 pending jobs and never cancels a running deploy. Queue order follows when jobs start waiting, so the reusable workflow checks versions after approval and after acquiring the queue lock. A forward release skips successfully if its version is equal to or older than the latest successful deployment for that application and environment. The job summary names the requested and deployed versions. Failed deployments do not advance that baseline; legacy deployment records use their recorded application version. Missing version metadata on a successful record stops forward deployment for investigation. Rollback bypasses the version comparison, and its successful deployment becomes the baseline for later forward releases.

### Slack deploy messages

Slack deploy messages are optional and off by default. They turn on only when the repository secret `SLACK_DEPLOY_WEBHOOK_URL` is set, and that secret is the only setting. Without it, the Slack steps show as skipped in each run and write no warning or notice.

With the secret set, `_delivery-deploy-environment.yml` posts plain-text messages to that Slack incoming webhook, one per application for each of these events:

- **Dev result:** `match-to-csv match-to-csv-v3.2.1 -> dev: succeeded <run link>`. The result is `succeeded`, `failed`, `cancelled`, or `skipped` when the version is not newer than the latest successful deployment.
- **Prod approval request:** `match-to-csv match-to-csv-v3.2.1 -> prod: waiting for approval <run link>`. `Verify prod reviewer protection` posts it after its check passes and before the deploy job waits. Open the link to approve or reject.
- **Prod result:** `match-to-csv match-to-csv-v3.2.1 -> prod: succeeded <run link>`. The result is `succeeded`, `failed`, `rejected`, `cancelled`, or `skipped`.

Rollbacks post the prod approval request and the prod result with `prod (rollback)` in place of `prod`. A merge that releases no application posts nothing.

Each delivery workflow passes the secret explicitly to the reusable workflows. Only the two jobs that post to Slack receive it, and only their Slack steps send it. When Slack does not answer within 10 seconds or returns an error, the step logs a warning and the deploy continues. A Slack failure never fails or blocks a deploy.

To turn the messages on:

1. In Slack, create an app from scratch at <https://api.slack.com/apps> in your workspace. Under **Incoming Webhooks**, turn on **Activate Incoming Webhooks**, choose **Add New Webhook to Workspace**, pick the channel, and copy the webhook URL.
2. Store the URL as a repository secret. `gh secret set` prompts for the value, so it stays out of your shell history:

   ```console
   gh secret set SLACK_DEPLOY_WEBHOOK_URL --repo <owner>/<repository>
   ```

3. If the channel subscribes to this repository with the GitHub app for Slack, remove the workflow and deployment subscriptions so each deploy is reported once. Run these in the channel:

   ```console
   /github unsubscribe <owner>/<repository> workflows
   /github unsubscribe <owner>/<repository> deployments
   ```

To turn the messages off, delete the secret. To move them to another channel, add a webhook for that channel and replace the secret.

## Validate match-to-csv

After a `match-to-csv` change reaches dev, and before approving prod:

1. Send a representative PNG or JPEG screenshot to your configured inbound recipient.
2. Open the new `match-to-csv-dev` Step Functions execution and confirm every state succeeds.
3. In the evidence bucket, confirm the run contains the source image, metadata, run manifest, start and success events, Textract request and response, normalized observations, extracted table, CSV, and completion object.
4. Compare the CSV with the screenshot. OCR differences are observations to label, not corruption.
5. With a loaded roster and a verified test address on the dev recipient list, confirm one email arrives with one CSV per roster player on the screenshots, and that the submission's `export/csv-email.json` has status `SENT`.

For a rejection test, send only an unsupported or undersized image. The submission's `completion.json` has status `REJECTED` with `NO_PROCESSABLE_SCREENSHOTS`, and the execution ends as succeeded at the `Submission rejected` state without running OCR. For a provider failure, the run contains `RUN_STARTED`, `RUN_FAILED`, the provider request, and a failed completion object.

Never commit test messages, recipient addresses, or domains.

Only the prod stack has alarms. To get alarm email, create a `String` SSM parameter `/mcc/prod/match-to-csv/alarm-email` holding the address, then redeploy. The [application README](../../applications/match-to-csv/README.md) describes the alarms.

## Manage the sender allowlist

The `match-to-csv` sender allowlist is required. It is the SSM parameter `/mcc/<environment>/match-to-csv/sender-allowlist`. Use `/mcc/dev/match-to-csv/sender-allowlist` for shared dev and every ephemeral stack, and `/mcc/prod/match-to-csv/sender-allowlist` for production. A dev allowlist change affects all those dev stacks. Create the environment's parameter before its first deploy of `match-to-csv`.

`process-email` splits the value on commas or whitespace and matches addresses without regard to case. Every `From` address must be listed. A message with no `From` address is rejected. When the parameter is missing or lists no address, every message is rejected with `SENDER_NOT_ALLOWED`, and `ingestion.json` records `senderAllowlist.status` as `NOT_CONFIGURED`. Any other read error, such as throttling or denied access, fails the invocation before it writes evidence and does not reject the message.

`process-email` checks the allowlist for each message. A warm Lambda caches the parameter value, including a missing parameter, for 60 seconds. Changes therefore take effect within one minute without a plan, pull request, or deploy. Keep this parameter out of OpenTofu, and never commit its value or real sender addresses to the repository.

Administrators change the allowlist with `scripts/sender-allowlist.mjs`, using the administrator profiles from [prerequisites](00-prerequisites.md#sso-profiles). The local `mcc-dev` deploy profile cannot manage it. Another operator profile needs `ssm:GetParameter` and `ssm:PutParameter` on the parameter in the target account and Region. The script also needs the AWS CLI and a repository checkout with dependencies installed.

```console
export AWS_PROFILE=mcc-dev-admin
aws sso login --profile "$AWS_PROFILE"
npm run sender-allowlist -- --environment dev list
npm run sender-allowlist -- --environment dev add 'player@example.test' 'teammate@example.test'
npm run sender-allowlist -- --environment dev remove 'teammate@example.test'
```

For production, use `mcc-prod-admin` and `--environment prod`. `--environment` is required, and the script has no `--ephemeral` option. Before any other AWS call, the script runs the same account check as `scripts/cdk-app.mjs` and `npm run recipients`: it needs `AWS_PROFILE` or `--profile`, refuses a profile whose name implies the other environment, and refuses to continue unless the active account matches `MCC_DEV_ACCOUNT_ID` or `MCC_PROD_ACCOUNT_ID`, or the profile's `sso_account_id` when the variable is unset.

- `list` prints the parameter's type, version, and addresses, or says that the parameter is missing or empty.
- `add` takes one or more addresses and writes them lowercase. It refuses an invalid address (`INVALID_ADDRESS`) and an address already listed in any case (`ALREADY_LISTED`). When the parameter is missing, `add` creates it as a `StringList`.
- `remove` takes one or more addresses, matched ignoring case. It refuses an address that is not listed (`NOT_LISTED`), and refuses to remove the last address (`LAST_ADDRESS`). To replace the only address, add the new one first. The script never deletes the parameter.
- Each write saves the whole list as comma-separated addresses and keeps the parameter's existing type. The script refuses a parameter of any type other than `String` or `StringList`.
- In `prod`, each write prints the change and asks you to type `yes`. Pass `--yes` to skip the prompt.
- After each write, the script reads the parameter back. Parameter Store has no conditional write, so when the saved list or version differs from what the script wrote, another change was saved at the same time. The script then exits 2 with `READ_BACK_MISMATCH` and prints both lists. Run `list` and repeat the change if it is still needed.
- Exit status is 0 on success, 1 when a change is refused or declined, and 2 for a usage, account, AWS, or read-back error.

Addresses are typed as arguments and printed only to your terminal. The script reads no input file and writes no file. Keep its output out of commits, issues, and pull requests.

### Verify in dev

After changing the dev allowlist, wait one minute for cached values to expire, then send a valid screenshot from a listed sender to your dev or ephemeral recipient and confirm the workflow processes it. Send another from an unlisted sender and confirm the submission's `completion.json` has status `REJECTED` and rejection code `SENDER_NOT_ALLOWED`. Its `ingestion.json` records `senderAllowlist.status` as `DENIED`, and the raw MIME remains stored. Use messages that pass SES spam and virus checks so those checks do not obscure the allowlist result.

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

Each environment's recipient table holds the addresses that receive each submission's per-gamertag CSVs ([spec 1.1 §4.5](../../specs/1.1-mcc-analytics-engine.md#45-csv-recipient-list)). Each `match-to-csv` stack emails the CSVs to the active entries of its own namespace ([results email](../../applications/match-to-csv/README.md#results-email)). In the SES sandbox, every recipient must also be a verified SES identity; production recipients receive mail only after SES production access is granted in the prod account. Administrators maintain it with `scripts/recipients.mjs`, which writes the table directly with their own AWS credentials. Only administrators change the list. The script needs DynamoDB, KMS, and SSM rights that the `mcc-<environment>-admin` profiles from [prerequisites](00-prerequisites.md#sso-profiles) already have, and no narrower operator policy exists. The recipient table must be applied in that environment's foundation first. The script also needs the AWS CLI and a repository checkout with dependencies installed.

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
