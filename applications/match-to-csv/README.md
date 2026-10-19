# Match-to-CSV

`match-to-csv` turns emailed Halo MCC scoreboard screenshots into Amazon Textract evidence, per-screenshot CSVs, and per-gamertag CSVs for legacy spreadsheets. It preserves the original inputs and OCR observations for review and replay.

## Getting started

Run commands from the repository root. Replace angle-bracket placeholders locally and keep real addresses, domains, account IDs, and test messages out of commits, issues, and pull requests.

1. Install [Git and the pinned Node.js/npm](../../docs/getting-started.md#tier-1-run-the-checks-locally), then run `npm ci` to install dependencies. Deployment also needs AWS CLI v2, `direnv`, and Docker that can run Linux ARM64 images. Infrastructure setup needs the pinned OpenTofu version.
2. Follow the [self-hosting guide](../../docs/self-hosting/README.md) if the AWS environment does not exist. Use a dev SSO profile and one workload Region that supports SES receiving. Complete [SES domain identity verification and inbound MX DNS](../../docs/self-hosting/00-prerequisites.md#inbound-email), [account bootstrap](../../docs/self-hosting/10-bootstrap-accounts.md#bootstrap-dev), and the [dev foundation apply](../../docs/self-hosting/40-change-foundation.md#apply-dev). The foundation supplies storage, roster and recipient tables, receipt rules, and SSM parameters.
3. Have the [CDK bootstraps](../../docs/self-hosting/20-bootstrap-cdk.md) applied in that account and Region: `CDKToolkit` for GitHub Actions and `CDKToolkitLocal` (`mcclocal1`) for local dev. Obtain [local deploy access](../../docs/self-hosting/20-bootstrap-cdk.md#grant-local-deploy-access), then [configure your shell and sign in](../../docs/getting-started.md#set-up-your-shell) with `mcc-dev`. Confirm STS reports the dev account and your profile has the workload Region.
4. [Choose an unused ephemeral name](../../docs/getting-started.md#pick-a-name), synthesize, inspect, and deploy your stack:

   ```console
   npm run app:synth -- match-to-csv --environment dev --ephemeral <name>
   npm run verify:bundle --workspace @mcc/match-to-csv
   npm run app:diff -- match-to-csv --environment dev --ephemeral <name>
   npm run app:deploy -- match-to-csv --environment dev --ephemeral <name>
   ```

Local stacks are named `match-to-csv-e-<name>`. Stable `match-to-csv-dev` and `match-to-csv-prod` stacks deploy through [GitHub Actions on `main`](../../docs/self-hosting/50-deploy-and-release-applications.md#merge-to-production). An ephemeral stack needs the applied dev foundation, but not the shared dev application stack.

### Configure players and addresses

These are separate settings:

- The [gamertag roster](../../docs/self-hosting/50-deploy-and-release-applications.md#maintain-the-gamertag-roster) resolves OCR player names and determines which rows enter per-gamertag CSVs. Each run records the roster version it used. An empty roster permits processing but produces no per-gamertag files.
- The [CSV recipient list](../../docs/self-hosting/50-deploy-and-release-applications.md#maintain-the-csv-recipient-list) stores intended export recipients. No application reads it yet. CSVs remain in S3 for manual retrieval. Automatic email delivery is tracked in [#207](https://github.com/samlevin/mcc-stats-suite/issues/207).
- The optional [sender allowlist](../../docs/self-hosting/50-deploy-and-release-applications.md#manage-the-sender-allowlist) controls who may submit email. It is an SSM parameter shared by all dev stacks, including ephemeral ones. Adding a CSV recipient does not allow that address to submit.

Roster and recipient commands require administrator credentials such as `mcc-dev-admin`, with DynamoDB, KMS, and SSM permissions. The local `mcc-dev` deploy profile is insufficient, and no narrower roster/recipient operator policy exists. Sign in with the administrator profile, then list and add entries:

```console
aws sso login --profile mcc-dev-admin
npm run roster -- --environment dev --profile mcc-dev-admin --ephemeral <name> list
npm run roster -- --environment dev --profile mcc-dev-admin --ephemeral <name> add 'Player01' 'Player 02'
npm run recipients -- --environment dev --profile mcc-dev-admin --ephemeral <name> list
npm run recipients -- --environment dev --profile mcc-dev-admin --ephemeral <name> add '<recipient-address>'
```

Use the same `<name>` as your stack to configure its `ephemeral/<name>` namespace. Omit `--ephemeral` for the environment's `stable` namespace. `--environment` is required. Production uses `prod` and its administrator profile, accepts no `--ephemeral`, and asks for confirmation before writes. Sender-allowlist operators need the separate SSM permissions in its guide. Keep list output local.

## Submit screenshots

Read `/mcc/<environment>/match-to-csv/email-alias` and `email-domain` in SSM with an administrator or operator profile that can read them. Send to `<alias>@<domain>` for a stable stack, or `<alias>+<name>@<domain>` for your ephemeral stack. The [test email instructions](../../docs/getting-started.md#send-a-test-email) show how to read and combine the parameters. After an alias or domain change, redeploy an ephemeral stack to receive at the new address.

For example, send a message to your stack's address with this plain-text body and attach one or more PNG or JPEG scoreboard screenshots:

```text
10/18/2026
```

Images must be readable, at least 640 by 360 pixels, and no larger than 10 MB (10,000,000 bytes) each. Only Halo 3 two-team boards are supported. Free-for-all, three-team boards, and boards without two distinguishable team colors produce no rows. A message without a processable screenshot is rejected and its workflow fails. See [Evidence layout](#evidence-layout) for the full layout limits.

### Match date

The plain-text body must contain a valid calendar date in `M/D/YYYY` format with a four-digit year. `process-email` uses the first valid date in reading order, skipping invalid candidates. Leading zeros, surrounding text, and signatures are allowed. A candidate touching a digit or slash is ignored, so a longer numeric date token cannot supply a date substring. HTML-only mail has no match date. Use the session's date even if play runs past midnight. A missing or invalid date rejects the submission with `MATCH_DATE_INVALID` before screenshots reach Textract.

Only allowlisted senders receive the invalid-date reply from `noreply@<domain>`. Replies to that address are not read. In the SES sandbox, verify the sender's address as an SES reply recipient before testing this reply. A failed reply does not change the recorded rejection. See the [date and reply contract](../../specs/1.1-mcc-analytics-engine.md#44-match-date-and-error-reply).

### Sender screening

SES spam or virus `FAIL` verdicts reject a message. SPF and DKIM verdicts are recorded but not enforced. When the sender allowlist exists, every `From` address must be listed. Without it, any sender can pass this check. Changes take effect within one minute. Ephemeral stacks also reject mail not addressed to their current plus-address.

A rejected submission retains its raw MIME and records the reason in `completion.json`, including `SPAM_VERDICT_FAILED`, `VIRUS_VERDICT_FAILED`, `SENDER_NOT_ALLOWED`, `RECIPIENT_NOT_ALLOWED`, `MATCH_DATE_INVALID`, or `NO_PROCESSABLE_SCREENSHOTS`. See [intake details](../../specs/1.1-mcc-analytics-engine.md#4-email-intake-interface).

## Find results

Use an administrator or operator profile with CloudFormation, Step Functions, SSM, and S3 read access. The local deploy profile cannot read the submission address or results. Use your CloudFormation stack's `StateMachineArn` output to find the workflow in Step Functions, then confirm your submission's execution is `SUCCEEDED`. The [result-check commands](../../docs/getting-started.md#check-the-result) find the workflow and list evidence in S3.

The bucket name is `/mcc/<environment>/match-to-csv/evidence-bucket-name` in SSM. Start at `submissions/{submissionId}/` for stable stacks or `ephemeral/<name>/submissions/{submissionId}/` for ephemeral ones:

- Each screenshot's `runs/{runId}/export/extracted.csv` holds its parsed rows, including unmatched players.
- `export/gamertags/` holds one file per roster gamertag with an `EXACT` or `RESOLVED` row, after every screenshot succeeds. These files have no header and use `Date,Kills,Assists,Deaths,Win,Loss` order for pasting into a player's spreadsheet. Unmatched rows are excluded. Replay writes no per-gamertag files. See the [export format](../../specs/1.1-mcc-analytics-engine.md#861-per-gamertag-export).

Download with `aws s3 cp` and compare CSV rows against the screenshot. A successful run can contain zero rows for an unsupported layout. Inspect `parser.noRowsReason` in `normalized/observations.json`. Raw MIME, original images, provider responses, and runs are immutable. Events are append-only, and replay creates a new run.

## Operations

- [Deployment, releases, and rollback](../../docs/self-hosting/50-deploy-and-release-applications.md), [troubleshooting](../../docs/self-hosting/60-recover-and-troubleshoot.md), and [ephemeral cleanup](../../docs/getting-started.md#remove-the-stack).
- [Replay, run comparison, and training-data materialization](../../specs/1.1-mcc-analytics-engine.md#9-replay-comparison-and-training-data), including inputs and stack outputs.
- Stable stacks publish alarms to the `match-to-csv-<environment>-alarms` SNS topic for workflow failures/timeouts, dead-letter messages, Lambda errors, and zero-row extractions. `extract-text` publishes `ZeroRowExtractions` and `ExtractedRows` metrics in the `MCC/MatchToCsv` namespace. To receive alarm email, set `/mcc/<environment>/match-to-csv/alarm-email`, redeploy, and confirm the SNS subscription. Ephemeral stacks have no alarms.

## Evidence layout

Stable stacks start at `submissions/`. Ephemeral stacks place the entire tree under `ephemeral/<name>/`.

```text
roster/versions/{rosterVersion}.json
submissions/{submissionId}/
  ingestion.json
  completion.json
  events/
  export/gamertags/{gamertag file}.csv
  screenshots/{screenshotId}/
    source/original
    source/metadata.json
    runs/{runId}/
      manifest.json
      events/
      textract/request.json
      textract/raw-response.json
      normalized/observations.json
      export/extracted-table.json
      export/extracted.csv
      completion.json
```

Submission and processing events are append-only. Successful runs record `RUN_STARTED` and `RUN_SUCCEEDED`. Failed runs record `RUN_STARTED`, `RUN_FAILED`, and a failed completion object. The Textract request is written before the provider call so failed invocations retain an unambiguous attempt record.

Processing manifests include the deployed Git commit, deployment environment, source hash, and version of every pipeline stage. Normalized observations retain provider blocks, tables, cells, tokens, geometry, confidence, relationships, parser output, and validation results.

The semantic mapper evaluates each detected table independently. Recognized columns map to `PLAYER`, `SCORE`, `KILLS`, `ASSISTS`, and `DEATHS`, while each cell is identified as a header or data cell. Numeric validation applies only to data cells. Invalid integers and low-confidence values require review. Unknown layouts remain `UNKNOWN`; the pipeline does not silently correct OCR text.

The parser flags player names Textract may have misread: a name word with a `WORD` confidence below 50, or a name whose trailing digits Textract split into their own word at a confidence below 90. A flagged row keeps the name as read and carries `reviewFlags`, which appear in `export/extracted-table.json` and in `parser.rows` of the normalized observations. The CSV leaves them out. Spec 1.1 §8.2.1 has the rules and the evidence behind the thresholds.

The scoreboard parser supports Halo 3 only. Its Halo 3 two-team layout was validated against real Textract captures of two Team Slayer post-game screens, red against blue, four players a side. The fixtures `halo3-two-team-capture-1` and `halo3-two-team-capture-2` hold those captures with gamertags replaced, and their expected rows were transcribed from the screenshots. Textract misread two gamertags in the second capture. The parser keeps both as read and flags those two rows for review, and the fixture lists them as `misreads`. To capture a new screenshot, see [test/fixtures/README.md](test/fixtures/README.md).

Two-team boards are the only supported layout. The parser clusters the background colors of the player rows, ignoring the header and filtered rows, and names each cluster with its MCC team color. When the player rows form exactly two clusters, every player on the top row's team gets `Win` 1 and everyone else gets `Loss` 1. Free-for-all and three-team matches are not supported. A board whose player rows form one cluster, carry no row color, or form three or more clusters produces no rows. Its run still succeeds, so the other screenshots in the same email are unaffected, and on a stable stack the zero-row alarm fires. `parser.noRowsReason` in the normalized observations records why, for example `{ "code": "UNSUPPORTED_TEAM_LAYOUT", "colorClusterCount": 1 }`, where a count of 0 means no player row had a color.

## Development and tests

```console
npm test --workspace @mcc/match-to-csv
npm run typecheck --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv --environment dev
npm run verify:bundle --workspace @mcc/match-to-csv
```

Tests enforce coverage thresholds and do not call AWS. Synthesis needs Docker for Linux ARM64 Sharp assets. Bundle verification checks the generated native binary. See [development setup and checks](../../docs/getting-started.md#tier-1-run-the-checks-locally) and [capture fixtures](test/fixtures/README.md).
