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
- The [CSV recipient list](../../docs/self-hosting/50-deploy-and-release-applications.md#maintain-the-csv-recipient-list) holds the addresses that receive each submission's per-gamertag CSVs by email (see [Results email](#results-email)). Each stack reads only its own namespace. An empty list sends nothing, and the CSVs stay in S3 either way.
- The required [sender allowlist](../../docs/self-hosting/50-deploy-and-release-applications.md#manage-the-sender-allowlist) controls who may submit email. It is an SSM parameter shared by all dev stacks, including ephemeral ones, and administrators change it with `npm run sender-allowlist`. Adding a CSV recipient does not allow that address to submit.

Roster and recipient commands require administrator credentials such as `mcc-dev-admin`, with DynamoDB, KMS, and SSM permissions. The local `mcc-dev` deploy profile is insufficient, and no narrower roster/recipient operator policy exists. Sign in with the administrator profile, then list and add entries:

```console
aws sso login --profile mcc-dev-admin
npm run roster -- --environment dev --profile mcc-dev-admin --ephemeral <name> list
npm run roster -- --environment dev --profile mcc-dev-admin --ephemeral <name> add 'Player01' 'Player 02'
npm run recipients -- --environment dev --profile mcc-dev-admin --ephemeral <name> list
npm run recipients -- --environment dev --profile mcc-dev-admin --ephemeral <name> add '<recipient-address>'
```

Use the same `<name>` as your stack to configure its `ephemeral/<name>` namespace. Omit `--ephemeral` for the environment's `stable` namespace. `--environment` is required. Production uses `prod` and its administrator profile, accepts no `--ephemeral`, and asks for confirmation before writes. Sender allowlist operators need the SSM permissions in its guide. Keep list output local.

## Scripts reference

Run NPM commands from the repository root with `--workspace @mcc/match-to-csv`. For the two `npx tsx` commands, first `cd applications/match-to-csv`. Build and test tools use their own option syntax; repository fixture tools accept `--help`.

| Script | Purpose | Arguments |
| --- | --- | --- |
| `npm run build --workspace @mcc/match-to-csv` | Compile TypeScript, including fixture scripts | None required |
| `npm run typecheck --workspace @mcc/match-to-csv` | Type-check without emitting files | None required |
| `npm test --workspace @mcc/match-to-csv` | Run tests with coverage thresholds and AWS validation disabled | None required |
| `npm run ci:test --workspace @mcc/match-to-csv` | Run the same tests with concurrency limited to two | None required |
| `npm run verify:bundle --workspace @mcc/match-to-csv` | Check synthesized templates and Linux ARM64 Sharp bundles in `cdk.out` | None; synthesize first |
| `npm run cdk:synth --workspace @mcc/match-to-csv` | Invoke the workspace CDK CLI; replace `cdk:synth` with `cdk:diff`, `cdk:deploy`, or `cdk:destroy` for those actions | Required `-- -c environment=dev` (or `prod`); optional `-c ephemeral=<name>` and other CDK options after `--`. Use the repository's [guarded `app:*` commands](../../README.md#scripts-reference) for local operations |
| `npm run ci:synth --workspace @mcc/match-to-csv` | Synthesize the dev `ci` ephemeral stack | None required; Docker must support Linux ARM64 |
| `npx tsx scripts/capture-textract.ts` | Capture real Textract responses and row colors | Required `<output-dir> <image>...`; output must be outside any Git working tree. Uses AWS credentials and Region from the environment |
| `npx tsx scripts/reduce-capture.ts` | Replace real names and reduce a capture into a fixture | Required `--capture <file> --mapping <file> --name <name> --output <file>`; capture and mapping must be outside any Git working tree. No argument defaults |

See [Capturing a real screenshot](test/fixtures/README.md#capturing-a-real-screenshot) for private capture handling, mapping examples, and expected-row transcription.

## Submit screenshots

Read `/mcc/<environment>/match-to-csv/email-alias` and `email-domain` in SSM with an administrator or operator profile that can read them. Send to `<alias>@<domain>` for a stable stack, or `<alias>+<name>@<domain>` for your ephemeral stack. The [test email instructions](../../docs/getting-started.md#send-a-test-email) show how to read and combine the parameters. After an alias or domain change, redeploy an ephemeral stack to receive at the new address.

For example, send a message to your stack's address with this plain-text body and attach one or more PNG or JPEG scoreboard screenshots:

```text
10/18/2026
```

Images must be readable, at least 640 by 360 pixels, and no larger than 10 MB (10,000,000 bytes) each. Only Halo 3 two-team boards are supported. Free-for-all, three-team boards, and boards without two distinguishable team colors produce no rows. A message without a processable screenshot is rejected with `NO_PROCESSABLE_SCREENSHOTS`. See [Evidence layout](#evidence-layout) for the full layout limits.

### Match date

The plain-text body must contain a valid calendar date in `M/D/YYYY` format with a four-digit year. `process-email` uses the first valid date in reading order, skipping invalid candidates. Leading zeros, surrounding text, and signatures are allowed. A candidate touching a digit or slash is ignored, so a longer numeric date token cannot supply a date substring. HTML-only mail has no match date. Use the session's date even if play runs past midnight. A missing or invalid date rejects the submission with `MATCH_DATE_INVALID` before screenshots reach Textract.

Only allowlisted senders receive the invalid-date reply from `noreply@<domain>`. Replies to that address are not read. In the SES sandbox, verify the sender's address as an SES reply recipient before testing this reply. A failed reply does not change the recorded rejection. See the [date and reply contract](../../specs/1.1-mcc-analytics-engine.md#44-match-date-and-error-reply).

### Sender screening

SES spam or virus `FAIL` verdicts reject a message. SPF and DKIM verdicts are recorded but not enforced. Every `From` address must be on the sender allowlist. When the allowlist parameter is missing or lists no address, every message is rejected with `SENDER_NOT_ALLOWED`. Changes take effect within one minute. Ephemeral stacks also reject mail not addressed to their current plus-address.

A rejected submission retains its raw MIME and records the reason in `completion.json`, including `SPAM_VERDICT_FAILED`, `VIRUS_VERDICT_FAILED`, `SENDER_NOT_ALLOWED`, `RECIPIENT_NOT_ALLOWED`, `MATCH_DATE_INVALID`, or `NO_PROCESSABLE_SCREENSHOTS`. Its Step Functions execution ends as succeeded at the `Submission rejected` state without running OCR, so a rejection fires no failure alarm. See [intake details](../../specs/1.1-mcc-analytics-engine.md#4-email-intake-interface).

## Find results

Use an administrator or operator profile with CloudFormation, Step Functions, SSM, and S3 read access. The local deploy profile cannot read the submission address or results. Use your CloudFormation stack's `StateMachineArn` output to find the workflow in Step Functions, then confirm your submission's execution is `SUCCEEDED`. A rejected submission also ends as `SUCCEEDED`, at the `Submission rejected` state, and its `completion.json` has status `REJECTED`. The [result-check commands](../../docs/getting-started.md#check-the-result) find the workflow and list evidence in S3.

The bucket name is `/mcc/<environment>/match-to-csv/evidence-bucket-name` in SSM. Start at `submissions/{submissionId}/` for stable stacks or `ephemeral/<name>/submissions/{submissionId}/` for ephemeral ones:

- Each screenshot's `runs/{runId}/export/extracted.csv` holds its parsed rows, including unmatched players.
- `export/gamertags/` holds one file per roster gamertag with an `EXACT` or `RESOLVED` row, after every screenshot succeeds. These files have no header and use `Date,Kills,Assists,Deaths,Win,Loss` order for pasting into a player's spreadsheet. Unmatched rows are excluded. Replay writes no per-gamertag files. See the [export format](../../specs/1.1-mcc-analytics-engine.md#861-per-gamertag-export).

Download with `aws s3 cp` and compare CSV rows against the screenshot. A successful run can contain zero rows for an unsupported layout. Inspect `parser.noRowsReason` in `normalized/observations.json`. Raw MIME, original images, provider responses, and runs are immutable. Events are append-only, and replay creates a new run.

### Results email

After the per-gamertag files are written, the workflow's last step, `Email gamertag CSVs`, sends one email from `noreply@<domain>` to every active entry of the stack's CSV recipient list. Its subject names the match date as `M/D/YYYY`, its body counts the files and screenshots, and each per-gamertag CSV is its own `text/csv` attachment. The submission's `export/csv-email.json` records the outcome: `SENT` with the SES message ID, `NOT_CONFIGURED` when the list has no active entry, or `NO_FILES` when the submission has no per-gamertag CSV. It also records the recipient list version, recipient count, and attachment names, never an address. SES throttling and server errors are retried; any other send failure fails the execution, and the CSVs stay in S3. In the SES sandbox, every recipient must be a verified SES identity. See [results delivery](../../specs/1.1-mcc-analytics-engine.md#862-results-email).

## Operations

- [Deployment, releases, and rollback](../../docs/self-hosting/50-deploy-and-release-applications.md), [troubleshooting](../../docs/self-hosting/60-recover-and-troubleshoot.md), and [ephemeral cleanup](../../docs/getting-started.md#remove-the-stack).
- [Replay, run comparison, and training-data materialization](../../specs/1.1-mcc-analytics-engine.md#9-replay-comparison-and-training-data), including inputs and stack outputs.
- Only the prod stack has alarms. It publishes them to the `match-to-csv-prod-alarms` SNS topic for workflow failures/timeouts, dead-letter messages, Lambda errors, and zero-row extractions. To receive alarm email, set `/mcc/prod/match-to-csv/alarm-email`, redeploy, and confirm the SNS subscription. The stable dev stack and ephemeral stacks have no alarms or alarm topic. `extract-text` publishes `ZeroRowExtractions` and `ExtractedRows` metrics in the `MCC/MatchToCsv` namespace.

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

Each stat column maps to the column under its header, and no column maps to two fields. A stat header read as its first three or more letters, such as `ASS` for a faint `ASSISTS`, still maps. A stat whose header Textract misses takes the one integer column between its neighbours. When the parser cannot place a stat that way, it leaves the stat empty in every row and flags each row with `UNMAPPED_COLUMN` for that stat, rather than copying another column.

The parser flags player names Textract may have misread: a name word with a `WORD` confidence below 50, or a name whose trailing digits Textract split into their own word at a confidence below 90. A flagged row keeps the name as read and carries `reviewFlags`, which appear in `export/extracted-table.json` and in `parser.rows` of the normalized observations. The CSV leaves them out. Spec 1.1 §8.2.1 has the rules and the evidence behind the thresholds.

The scoreboard parser supports Halo 3 only. Its Halo 3 two-team layout was validated against real Textract captures of two Team Slayer post-game screens, red against blue, four players a side. The fixtures `halo3-two-team-capture-1` and `halo3-two-team-capture-2` hold those captures with gamertags replaced, and their expected rows were transcribed from the screenshots. Textract misread two gamertags in the second capture. The parser keeps both as read and flags those two rows for review, and the fixture lists them as `misreads`. The fixtures `halo3-faint-assists-header-1` and `halo3-faint-assists-header-2` hold two more captures of one red-against-blue pairing. Textract read their faint `ASSISTS` header as `ASS` and as nothing, and added empty columns after `PLAYERS` and `DEATHS`. To capture a new screenshot, see [test/fixtures/README.md](test/fixtures/README.md).

Two-team boards are the only supported layout. The parser clusters the background colors of the player rows, ignoring the header and filtered rows, and names each cluster with its MCC team color. When the player rows form exactly two clusters, every player on the top row's team gets `Win` 1 and everyone else gets `Loss` 1. Free-for-all and three-team matches are not supported. A board whose player rows form one cluster, carry no row color, or form three or more clusters produces no rows. Its run still succeeds, so the other screenshots in the same email are unaffected, and in prod the zero-row alarm fires. `parser.noRowsReason` in the normalized observations records why, for example `{ "code": "UNSUPPORTED_TEAM_LAYOUT", "colorClusterCount": 1 }`, where a count of 0 means no player row had a color.

## Development and tests

```console
npm test --workspace @mcc/match-to-csv
npm run typecheck --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv --environment dev
npm run verify:bundle --workspace @mcc/match-to-csv
```

Tests enforce coverage thresholds and do not call AWS. Synthesis needs Docker for Linux ARM64 Sharp assets. Bundle verification checks the generated native binary. See [development setup and checks](../../docs/getting-started.md#tier-1-run-the-checks-locally) and [capture fixtures](test/fixtures/README.md).
