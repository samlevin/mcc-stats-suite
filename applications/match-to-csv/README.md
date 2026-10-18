# Match-to-CSV

`match-to-csv` receives MIME email through a configured SES receipt rule, preserves screenshot evidence, and runs Amazon Textract table extraction. One message can contain several attachments. Each accepted image becomes one `SCREENSHOT` source and one independent processing run.

The package does not create matches, associate screenshots with matches, adjudicate OCR, or train models. It preserves the observations and metadata required by those later features.

## Pipeline

```text
configured SES recipient
  -> raw MIME email in S3
  -> EventBridge and Step Functions
  -> sender screening (SES verdicts and optional allowlist)
  -> match date from the email body
  -> attachment validation
  -> one SourceScreenshot per accepted image
  -> one ProcessingRun per screenshot
  -> raw Textract response, normalized observations, and extracted CSV
```

The original image is never transformed or replaced. Rejected image attachments are preserved with rejection metadata. Non-image attachments remain available in the retained MIME message.

V1 processing accepts PNG and JPEG images up to 10 MB (10,000,000 bytes, the Textract synchronous limit) with dimensions of at least 640 by 360 pixels. It rejects unreadable images, unsupported formats, oversized images, and small images. A message without a processable screenshot records a rejected submission and fails its workflow execution instead of succeeding without output.

## Sender screening

The receipt rules enable SES scanning, so SES prepends `X-SES-Spam-Verdict`, `X-SES-Virus-Verdict`, `X-SES-SPF-Verdict`, and `X-SES-DKIM-Verdict` headers to each message. `process-email` reads the topmost copy of each header, so a copy the sender wrote lower in the message cannot override it. A `FAIL` spam or virus verdict rejects the submission before any attachment is stored or sent to Textract. The SPF and DKIM verdicts are recorded but not enforced.

For the optional sender allowlist, see [Manage the sender allowlist](../../docs/self-hosting/50-deploy-and-release-applications.md#manage-the-sender-allowlist). The self-hosting guide covers its behavior and how to create, update, or remove it through the AWS console or CLI.

A screened-out message keeps its raw MIME object. Its `completion.json` has status `REJECTED` and lists the `SubmissionRejectionCode` values from `@mcc/contracts`: `SPAM_VERDICT_FAILED`, `VIRUS_VERDICT_FAILED`, `SENDER_NOT_ALLOWED`, `RECIPIENT_NOT_ALLOWED`, or `MATCH_DATE_INVALID` (see [Match date](#match-date)). A message rejected because no attachment passed validation records `NO_PROCESSABLE_SCREENSHOTS`. `ingestion.json` and the `SUBMISSION_ACCEPTED` or `SUBMISSION_REJECTED` event record the verdicts as `sesVerdicts`, with `null` for an absent header, and the allowlist decision as `senderAllowlist` (`NOT_CONFIGURED`, `ALLOWED`, or `DENIED`, with the parameter name and the `From` addresses). They record the recipient check as `recipientCheck` (`NOT_CONFIGURED` for stable stacks, otherwise `ALLOWED` or `DENIED`, with the recipients SES recorded in its `Received` header).

## Match date

The plain-text body of each submission holds one string, the date of the match. Screenshots from one session can run past midnight, so the date cannot come from timestamps. After trimming whitespace, the body must be a calendar date written `M/D/YYYY`: month 1 to 12, a day that exists in that month, and a four-digit year. Leading zeros are accepted, so `5/2/2026` and `05/02/2026` are the same date. Only a text/plain part counts: HTML is never converted to text, so an HTML-only email has no match date.

`process-email` checks the date only for a message that passed sender screening. A valid date is recorded as `matchDate` (`YYYY-MM-DD`) in `ingestion.json` and returned in `ProcessEmailOutput`. A missing or invalid date records `matchDate: null` and rejects the submission with `MATCH_DATE_INVALID` before any attachment is stored, so no screenshot reaches Textract.

For `MATCH_DATE_INVALID` only, `process-email` replies to the `From` address from `noreply@<domain>`, where the domain is `/mcc/<environment>/match-to-csv/email-domain`, resolved when the stack deploys. The reply's subject is `Re: <original subject>`, its `In-Reply-To` and `References` headers name the original message ID, and its body says the email was not processed because the body must contain only the match date as `M/D/YYYY`. It asks the sender to send the email again to the submission address, because replies to the no-reply address are not read. Only an allowlisted sender gets a reply, so a message with no sender allowlist configured is rejected without one. No other rejection sends a reply. A failed send is logged with the SES error name only, and the recorded rejection stays as it is.

`ProcessEmail` may call `ses:SendEmail` only with the `From` address `noreply@<domain>`, on SES identities in its own account and Region. The domain's identity exists outside OpenTofu. While an account is in the SES sandbox, SES delivers only to verified addresses and also checks the grant against the recipient's identity, so the grant names every identity instead of only the domain's. A reply to an unverified sender in a sandbox account fails and is logged. The local workload boundary that ephemeral stacks use allows the same send. A local bootstrap from before this boundary change denies it, so [upgrade the local bootstrap](../../docs/self-hosting/20-bootstrap-cdk.md#upgrade-the-local-bootstrap) before you expect an ephemeral stack to reply.

## Deployment

Apply the matching environment foundation before deploying the application. The foundation creates the raw-message bucket, immutable evidence bucket, KMS key, and required SSM parameters.

GitHub Actions deploys stable environments. Its preflight checks verify the target account, CDK bootstrap parameter, foundation parameters, SES identity status, and inbound MX target. The workflow builds native dependencies for Linux ARM64 and inspects both Sharp-using Lambda assets before deployment.

Local developer stacks are explicit:

```console
npm run app:deploy -- match-to-csv --environment dev --ephemeral <name>
```

Ephemeral deployments build their `<alias>+<name>@<domain>` rule from `/mcc/dev/match-to-csv/email-alias` and `/mcc/dev/match-to-csv/email-domain`, which the foundation publishes, so no local configuration holds either. The foundation owns the shared rule set and the `<alias>@<domain>` rule. The rule keeps the alias and domain from the stack's last deploy, so an ephemeral `process-email` reads both parameters for every message and rejects one whose SES recipients do not include the current `<alias>+<name>@<domain>` with `RECIPIENT_NOT_ALLOWED`, before storing any attachment. A warm Lambda reuses parameter values for up to a minute. Changing the alias or domain therefore needs no ephemeral redeploy to stop mail to the old address, only to receive mail at the new one. Never put the alias or domain in source files or documentation. Production and plain dev deployments are restricted to GitHub Actions on `main`.

## Alarms

Stable stacks publish CloudWatch alarms to the `match-to-csv-<environment>-alarms` SNS topic. An alarm fires on any failed or timed-out execution of either state machine, any message in the `-events-dlq` queue, any Lambda error, and any screenshot whose extraction succeeds with no rows. `extract-text` reports the row count as the `ZeroRowExtractions` and `ExtractedRows` metrics in the `MCC/MatchToCsv` namespace, using the CloudWatch embedded metric format. Ephemeral stacks create no alarms or topic.

To receive alarm email, create a `String` parameter named `/mcc/<environment>/match-to-csv/alarm-email` that holds the address, then redeploy. The deploy workflow subscribes the address only when the parameter exists, and CloudFormation reads the value at deploy time, so the address stays out of the repository, the template, and the workflow logs. SNS sends a confirmation email, and the subscription delivers alarms only after someone confirms it.

## Evidence layout

Stable stacks start at `submissions/`. Ephemeral stacks place the entire tree under `ephemeral/<name>/`.

```text
submissions/{submissionId}/
  ingestion.json
  completion.json
  events/
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

The parser flags player names Textract may have misread: a name word with a `WORD` confidence below 50, or a name whose trailing digits Textract split into their own word at a confidence below 90. A flagged row keeps the name as read and carries `reviewFlags`, which appear in `export/extracted-table.json` and in `parser.rows` of the normalized observations. The CSV columns are unchanged. Spec 1.1 §8.2.1 has the rules and the evidence behind the thresholds.

The scoreboard parser supports Halo 3 only. Its Halo 3 two-team layout was validated against real Textract captures of two Team Slayer post-game screens, red against blue, four players a side. The fixtures `halo3-two-team-capture-1` and `halo3-two-team-capture-2` hold those captures with gamertags replaced, and their expected rows were transcribed from the screenshots. Textract misread two gamertags in the second capture. The parser keeps both as read and flags those two rows for review, and the fixture lists them as `misreads`. To capture a new screenshot, see [test/fixtures/README.md](test/fixtures/README.md).

Two-team boards are the only supported layout. The parser clusters the background colors of the player rows, ignoring the header and filtered rows, and names each cluster with its MCC team color. When the player rows form exactly two clusters, every player on the top row's team gets `Win` 1 and everyone else gets `Loss` 1. Free-for-all and three-team matches are not supported. A board whose player rows form one cluster, carry no row color, or form three or more clusters produces no rows. Its run still succeeds, so the other screenshots in the same email are unaffected, and on a stable stack the zero-row alarm fires. `parser.noRowsReason` in the normalized observations records why, for example `{ "code": "UNSUPPORTED_TEAM_LAYOUT", "colorClusterCount": 1 }`, where a count of 0 means no player row had a color.

## Replay and comparison

The main state machine handles new messages. The replay state machine accepts an existing `SourceScreenshot` and creates a new processing run without changing prior evidence:

```json
{
  "source": {
    "submissionId": "...",
    "screenshotId": "...",
    "bucket": "...",
    "key": ".../source/original",
    "attachmentName": "scoreboard.png",
    "contentType": "image/png",
    "sha256": "...",
    "acquisitionType": "SCREENSHOT",
    "widthPx": 1920,
    "heightPx": 1080
  }
}
```

The `ReplayStateMachineArn` stack output identifies the replay workflow. The `RunComparisonFunctionName` output identifies the comparison Lambda. Comparison uses table index, row, and column. It reports added cells, removed cells, text changes, and confidence changes without altering either run.

## Training-data materialization

The `TrainingDataMaterializerFunctionName` stack output identifies the materializer Lambda. Invoke it with normalized artifact keys from completed runs:

```json
{
  "bucket": "...",
  "normalizedKeys": [
    ".../normalized/observations.json"
  ],
  "splitSeed": "ocr-cells-v1"
}
```

The materializer writes an immutable dataset under `datasets/{datasetId}/`:

```text
manifest.json
train.jsonl
validation.jsonl
test.jsonl
```

Each JSONL record joins the cell observation, related tokens, validation result, processing versions, build metadata, source artifact, and normalized artifact reference. Records are marked `UNLABELED` until the separate labeling workflow produces ground truth.

The split algorithm hashes the seed and `screenshotId`. Eighty percent of screenshots go to training, ten percent to validation, and ten percent to testing. All cells and all replayed runs for one screenshot always use the same split.

## Development and tests

```console
npm test --workspace @mcc/match-to-csv
npm run typecheck --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv --environment dev
npm run verify:bundle --workspace @mcc/match-to-csv
```

The test suite enforces minimum statement, branch, line, and function coverage. It covers MIME intake behavior, multiple attachments, rejections, submission events, processing success and failure records, parser behavior, semantic mapping, multiple tables, CSV escaping, comparison behavior, ephemeral paths, materialization joins, and deterministic dataset splits. Tests do not call AWS.

CDK synthesis requires Docker because Sharp is packaged for the Lambda Linux ARM64 runtime. Run the bundle verification after synthesis; it checks the actual generated assets for the native binary.
