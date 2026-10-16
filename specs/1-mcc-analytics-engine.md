# Match-to-CSV: Technical Specification

**Status:** Specification for v1 delivery

**Version:** 2.0-draft (replaces the original system specification; see §1)

**Date:** October 14, 2026

**Component:** `applications/match-to-csv`, with shared code in `packages/contracts` and `packages/cdk-config` and persistent resources in `infrastructure/modules/foundation`

**Runtime:** TypeScript, Node.js 22 on AWS Lambda (ARM64), orchestrated by AWS Step Functions

**Deployment:** one AWS CDK stack per stable environment (`dev`, `prod`) from GitHub Actions, plus ephemeral developer stacks in the dev account

**OCR provider:** Amazon Textract `AnalyzeDocument` with the `TABLES` feature

**Persistent state:** an immutable S3 evidence bucket and a raw-email bucket, both owned by the OpenTofu foundation

**External dependencies at runtime:** Amazon SES, S3, EventBridge, Step Functions, Lambda, Textract, KMS, SSM Parameter Store and SQS

**Out of scope:** match records, screenshot-to-match association, OCR adjudication, anomaly scoring, model training, public user interfaces

Halo: The Master Chief Collection (MCC) players email post-game scoreboard screenshots to a fixed address. This component turns each screenshot into OCR evidence and a per-screenshot CSV of player statistics. It keeps every input and every provider response so later features can replay, compare, label and train on them without asking players to resend anything.

**Changes in 2.0-draft:** the original specification described a Lambda chain that preprocessed images, cropped the scoreboard with Rekognition, and wrote one CSV per match to an output bucket that CDK created. This revision sends the original image to Textract unchanged, records every stage as immutable evidence, runs each screenshot through a Step Functions workflow, adds replay, run comparison and training-data materialization, and moves every persistent resource to the OpenTofu foundation. §1 records each decision. Where the original text and this revision disagree, this revision wins.

---

## 1. Resolved requirement decisions

Each row records how a requirement from the original specification is resolved. These are product decisions.

| Original requirement | Decision | Reason |
| --- | --- | --- |
| Preprocess each image: EXIF auto-rotation, landscape enforcement, sharpening, Rekognition `DetectText` crop with full-image fallback | No preprocessing. Textract receives the stored original bytes after an integrity check. The run manifest records `preprocessingVersion: none-v1`. | Textract is built for unprocessed images, and sharpening or resizing can add artifacts that lower accuracy. Sending the original keeps every provider coordinate aligned with the stored evidence, which row-colour sampling and later labeling depend on. A crop would need its own stored artifact, failure modes and tests. |
| Debug mode writes a cropped PNG to `matches/<matchId>/cropped/` and logs crop dimensions | Removed. Every run always writes its complete evidence (§5), so there is no debug flag. | With no crop there is nothing to debug. Full evidence on every run is more useful than an opt-in partial record. |
| One CSV per match | One CSV per processing run, which is one per screenshot attempt. | The system has no match entity. Grouping screenshots into matches belongs to the match-entry and association features. One email can carry screenshots of different matches. |
| CSV written to a dedicated output bucket | The CSV and its structured table are written under the run in the evidence bucket (`export/extracted.csv`, `export/extracted-table.json`). | The CSV is derived evidence and belongs next to the observations it came from. The foundation still provisions an output bucket and an attachments bucket for later features; v1 writes to neither. |
| CDK provisions the raw-email, attachments and output buckets, the SES receipt rule set and the IAM policies | OpenTofu (`infrastructure/modules/foundation`) owns every persistent resource: the KMS key, all buckets, the receipt rule set, its activation, the shared `<alias>@<domain>` rule and the SSM parameters. CDK owns compute: Lambda functions, state machines, the EventBridge rule, the dead-letter queue, log groups and IAM roles. | Data must outlive application stacks, and no resource may be managed by two tools. The one exception is the ephemeral `<alias>+<name>@<domain>` receipt rule, which an ephemeral stack adds to the foundation rule set and removes with itself. |
| Architecture: SES -> S3 -> handler Lambda -> preprocess Lambda -> CSV | SES -> raw-email bucket -> EventBridge `Object Created` -> Step Functions Standard workflow -> intake Lambda -> `Map` over screenshots -> extraction Lambda -> export Lambda. | A state machine gives per-screenshot isolation, bounded concurrency, declared retries, an execution history and a replay entry point. |
| Emails must contain one or more image attachments | A message with no processable screenshot completes intake with status `REJECTED`, writes its evidence, and then fails the execution. | A silent empty success hides lost submissions. A failed execution shows up in the console and in alarms. |
| Non-image attachments are ignored | Non-image attachments are recorded as `NOT_AN_IMAGE` rejections and stay only in the retained raw MIME message. Rejected images are stored with their rejection codes. | The submission record explains every attachment. |
| Detect the header row dynamically, fall back to column order | The first row of the selected table is the header. Recognized labels map to fields. Any field left unmapped falls back to its standard position. | Matches the original intent with a deterministic rule. |
| Team detection by row background colour, MCC colour names, FFA when one cluster | Changed. Only two-team boards are supported, and free-for-all and three-team matches are not. A board whose player rows form one colour cluster, carry no colour, or form three or more clusters produces no rows, and the run succeeds and records why (§8.4). When both clusters get the same colour name, the second gets a numeric suffix (`Red 2`). | An unsupported board succeeds with no rows instead of failing, because the attachment `Map` tolerates no failed item (§6.1), so one failed screenshot would fail every other screenshot in the email. Names stay unique per screenshot, so win/loss assignment never merges the two teams. |
| Win/loss from the top player row | Kept, for two-team boards. | MCC lists the winning player or team first. |
| JSON logs with `ERROR`, `WARN`, `INFO`, `DEBUG`, `TRACE` | Kept. Each line is one JSON object with `level`, `message` and context fields, written to standard output. | CloudWatch Logs indexes JSON fields. |
| TAP unit tests for `processScoreboardImage` | Kept, plus tests for every handler, the normalizer, CSV escaping, comparison, materialization, deployment configuration, bundling and receipt rules, with coverage thresholds that fail the test command (§16). | The parser is only one of several places where a regression loses evidence. |
| All buckets block public access and use encryption | Kept. The raw-email bucket uses SSE-S3. Every other bucket uses SSE-KMS with the foundation key and S3 Bucket Keys. | SES writes the raw message, and SSE-S3 needs no key grant to the SES service principal. Application data uses a customer-managed key. |
| SES has explicit `PutObject` permission | The raw-email bucket policy allows `ses.amazonaws.com` to put objects only under `incoming/`, only from this account and only from a receipt rule set in this account. It denies every request without TLS. | Limits the service grant to the prefix SES needs. |
| Least-privilege Lambda IAM | Each function receives only the S3, KMS and Textract actions it uses (§13.4), inside a permissions boundary. | Textract `AnalyzeDocument` has no resource-level permissions, so it is granted on `*` to the extraction function only. |

**Additional capabilities included:** append-only submission and run events, immutable writes enforced by S3 conditional requests, source hash verification before OCR, versioned pipeline stages recorded in every run, replay of a stored screenshot as a new run, cell-level comparison of two runs, deterministic training-data splits, ephemeral per-developer stacks with their own email address and object namespace, pre-deployment checks of SES and DNS, and post-deployment health checks.

## 2. Goals and non-goals

### 2.1 Goals

1. Accept scoreboard screenshots by email with no client software, account or upload page.
2. Preserve every input and every provider output immutably, so any result can be traced to the bytes and code versions that produced it.
3. Produce a quoted CSV of `Team,Player,Score,Kills,Assists,Deaths,Win,Loss` for each two-team screenshot, with any number of players on each team. Other boards produce no rows and a recorded reason (§8.4).
4. Record each OCR cell with its geometry, confidence, semantic field and deterministic validation result, ready for human review.
5. Re-run extraction on stored evidence without changing earlier runs, and compare any two runs cell by cell.
6. Materialize unlabeled training datasets with splits that never leak a screenshot across partitions.
7. Let each developer deploy an isolated copy in the dev account that cannot touch shared stacks or shared evidence.

### 2.2 Non-goals

- Image preprocessing of any kind before OCR.
- Creating matches, associating screenshots with matches, or deduplicating screenshots of the same match.
- Correcting OCR text. Unknown layouts stay `UNKNOWN`, and suspicious values are flagged, never changed.
- Adjudication, labeling, anomaly detection or model inference. Specs 2 and 3 cover those, reading the evidence this component writes.
- Replying to the sender, or authenticating senders beyond SES spam and virus scanning.
- Public access to any artifact, or any user interface.
- Exactly-once processing. Retries can produce extra submissions or runs; evidence is never overwritten (§18).

## 3. Runtime architecture

```text
Sender
  |
  v
Amazon SES inbound (foundation receipt rule set mcc-inbound-<env>)
  |  <alias>@<domain>           -> incoming/<env>/      (foundation rule)
  |  <alias>+<name>@<domain>    -> incoming/<name>/     (ephemeral stack rule)
  v
Raw-email bucket (SSE-S3, EventBridge notifications, 90-day expiry)
  |
  v
EventBridge rule: Object Created under incoming/<route>/  --(failed delivery)--> SQS DLQ
  |
  v
Step Functions Standard workflow <stack>
  |
  +-- Process email and attachments   (ProcessEmail Lambda)
  |     parse MIME, validate attachments, store originals and metadata,
  |     write ingestion, completion and events
  |
  +-- Process attachments (Map, max concurrency 2, one item per accepted screenshot)
        |
        +-- Extract text             (ExtractText Lambda)
        |     verify hash, record request, call Textract, sample row colours,
        |     parse scoreboard, normalize observations, write completion and events
        |
        +-- Write extracted CSV      (WriteExtractedCsv Lambda)
              write extracted.csv and extracted-table.json under the run

Replay workflow <stack>-replay: Extract text -> Write extracted CSV, for one stored screenshot
CompareRuns Lambda and MaterializeTrainingData Lambda: invoked directly by an operator
  |
  v
Evidence bucket (SSE-KMS, versioned, Object Lock GOVERNANCE 365 days)
```

**Ownership rules:** `process-email` owns submissions and source screenshots. `extract-text` owns processing runs, the Textract request and response, normalized observations and the run completion. `write-extracted-csv` owns the run's export artifacts. `compare-runs` and `materialize-training-data` only read runs and write their own new objects. `scoreboard-logic` and `csv` are pure and perform no I/O. Only Lambda entry points construct AWS SDK clients; every handler's core function receives its I/O as an injected dependencies object so tests run without AWS.

**Packaging:** one npm workspace, `@mcc/match-to-csv`, with Lambda sources under `src/lambdas/`, pure libraries under `src/lib/`, and the CDK app under `cdk/`. The payload types that cross Lambda and state-machine boundaries live in `@mcc/contracts` so later applications can read the same evidence.

### 3.1 Execution policy

- One email is one submission and one execution of the main workflow. One accepted screenshot is one `Map` item and one processing run.
- At most two screenshots from one email are processed at a time, which bounds Textract throughput per message.
- Every evidence write uses `If-None-Match: *`. No stage overwrites an object. A retried stage writes under a new identifier, except the export stage, which treats an existing object as already written (§6.4).
- A Lambda failure fails its state. The workflow retries only the transient errors listed in §6.3, then fails the execution. Earlier evidence stays in place.
- The extraction stage never calls Textract on bytes whose SHA-256 differs from the hash recorded at intake.
- The workflow never deletes, moves or rewrites evidence. Expiry is a bucket lifecycle concern owned by the foundation (§13.1).

## 4. Email intake interface

### 4.1 Addresses and routing

| Deployment | Recipient | Receipt rule owner | Raw object prefix | Evidence namespace |
| --- | --- | --- | --- | --- |
| Stable `dev` or `prod` | `<alias>@<domain>` | Foundation (`aws_ses_receipt_rule.store_raw_email`, rule `submit`) | `incoming/<env>/` | bucket root (`submissions/`, `datasets/`) |
| Ephemeral `<name>` in dev | `<alias>+<name>@<domain>` | Ephemeral stack (`StoreRawEmail`, rule named after the stack) | `incoming/<name>/` | `ephemeral/<name>/` |

- A Region has one active receipt rule set, so the foundation creates `mcc-inbound-<env>`, activates it only after the shared rule exists, and publishes its name, the alias, and the domain in SSM. The alias and domain come from `<ENV>_MCC_EMAIL_ALIAS` and `<ENV>_MCC_EMAIL_DOMAIN` repository secrets. Stacks read them; nothing in source control holds either. The rule named `submit` keeps that AWS name whatever the alias is.
- An ephemeral rule keeps the alias and domain from its last deploy. Its `process-email` reads both parameters for every message and rejects one whose SES recipients, from the `for` clause of the topmost `Received` header, do not include the current `<alias>+<name>@<domain>`. SES lists only recipients a rule accepted, so a stale rule never lists the current address. It records the rejection code `RECIPIENT_NOT_ALLOWED`, stores no attachment, and keeps the raw MIME. A stale rule therefore accepts nothing.
- Every rule enables SES spam and virus scanning, accepts optional TLS, writes the raw MIME message with an S3 action, then stops rule-set evaluation.
- The foundation ignores rule ordering (`after`) on the shared rule so ephemeral rules can be added to the set without drift.

### 4.2 Trigger

The raw-email bucket sends events to EventBridge. The stack's rule matches `aws.s3` `Object Created` events for the raw-email bucket with a key prefix of `incoming/<route>/` and starts the main workflow with input `{ "bucket": <bucket>, "key": <key> }`. EventBridge retries delivery up to three times within two hours and then sends the event to the `<stack>-events-dlq` queue, which uses SQS-managed encryption and keeps messages for 14 days.

### 4.3 Attachment acceptance

The intake Lambda parses the message with `mailparser` and walks attachments in order. For each attachment:

| Check | Rejection code | Notes |
| --- | --- | --- |
| Content type does not start with `image/` | `NOT_AN_IMAGE` | Recorded in the submission; the bytes are not copied to the evidence bucket. |
| Sharp cannot read the metadata, or reports no format | `UNREADABLE_IMAGE` | The original is still stored. |
| Format is not `png`, `jpeg` or `jpg` | `UNSUPPORTED_IMAGE_FORMAT` | Textract byte input accepts PNG and JPEG. |
| Larger than 10 MiB | `IMAGE_TOO_LARGE` | Textract's synchronous byte limit. |
| Narrower than 640 px or shorter than 360 px | `IMAGE_TOO_SMALL` | Too small to read reliably. |

Codes accumulate, so one attachment can carry several. An image with no codes becomes an accepted `SourceScreenshot` with `acquisitionType: SCREENSHOT`; v1 never sets `PHOTO` or `OTHER`, which are reserved for later classification. Attachment names are normalized with NFKC, reduced to `[a-zA-Z0-9._-]`, trimmed of leading and trailing hyphens and cut to 160 characters, falling back to `attachment-<n>`.

## 5. Evidence model and storage layout

### 5.1 Layout

```text
[ephemeral/<name>/]submissions/{submissionId}/
  ingestion.json
  completion.json
  events/{occurredAt}-{eventId}.json
  screenshots/{screenshotId}/
    source/original
    source/metadata.json
    runs/{runId}/
      manifest.json
      events/{occurredAt}-{eventId}.json
      textract/request.json
      textract/raw-response.json
      normalized/observations.json
      export/extracted-table.json
      export/extracted.csv
      completion.json
[ephemeral/<name>/]datasets/{datasetId}/
  manifest.json
  train.jsonl
  validation.jsonl
  test.jsonl
```

A run's prefix derives from its source key (`<source prefix>/runs/<runId>`), so a replayed run of an ephemeral screenshot stays in the ephemeral namespace. Every identifier is `evidenceId()`: the current time in base-36 milliseconds, a hyphen, and a random UUID. Identifiers sort roughly by creation time.

### 5.2 Rules

1. Evidence is immutable. Every object is written once with `If-None-Match: *`. A conflicting write fails, except in the export stage (§6.4).
2. Events are append-only. Each event is its own object, keyed by timestamp and identifier.
3. A replay creates a new run. Nothing modifies an earlier run, its CSV or its events.
4. The Textract request record is written before the provider call, so a failed or timed-out invocation still leaves a record of the attempt.
5. A run records the deployed Git commit, the deployment environment, the source hash and the version of every stage.
6. Unknown layouts stay `UNKNOWN`. Validation flags values; it never edits them.

### 5.3 Document schemas

| Object | `schemaVersion` | Writer | Contents |
| --- | --- | --- | --- |
| `ingestion.json` | `email-submission/v1` | `process-email` | `submissionId`, `rawEmail` (bucket and key), `messageId`, `subject`, `receivedAt`, `attachmentCount` |
| `source/metadata.json` | `source-screenshot/v1` | `process-email` | every `SourceScreenshot` field, `fileSizeBytes`, `originalFilename`, `contentDisposition`, `contentId`, `uploadedAt`, `processingStatus` (`ACCEPTED` or `REJECTED`), `rejectionCodes`, Sharp `metadata`, `metadataError` |
| submission `completion.json` | `email-submission-completion/v1` | `process-email` | `status` (`SUCCEEDED`, `REJECTED` or `FAILED`), `completedAt`, `acceptedScreenshotCount`, `rejectedAttachments`, `error` when failed |
| submission event | `submission-event/v1` | `process-email` | `type` (`SUBMISSION_ACCEPTED`, `SUBMISSION_REJECTED`, `SUBMISSION_FAILED`), `occurredAt`, `detail` |
| `manifest.json` | `processing-run/v1` | `extract-text` | `runId`, `screenshotId`, `inputArtifact` (the source with `kind: ORIGINAL`), `versions`, `build` (`gitSha`, `environment`), `startedAt` |
| run event | `processing-event/v1` | `extract-text` | `type` (`RUN_STARTED`, `RUN_SUCCEEDED`, `RUN_FAILED`), `occurredAt`, `detail` |
| `textract/request.json` | none | `extract-text` | `provider: AWS_TEXTRACT`, `operation: AnalyzeDocument`, `featureTypes: [TABLES]`, `invokedAt`, `inputSha256`, `inputSizeBytes` |
| `textract/raw-response.json` | none | `extract-text` | the unmodified `AnalyzeDocument` response |
| `normalized/observations.json` | `normalized-ocr/v2` | `extract-text` | `blocks`, `tables`, `cells`, `tokens`, `parser` (`version`, `rows`, `rowColors`, and `noRowsReason` when the team layout is unsupported, §8.4), `validation` (§7.2) |
| run `completion.json` | `processing-run-completion/v1` | `extract-text` | `status`, `completedAt`; on success `textract` (response reference, response SHA-256, request reference, request ID) and `metrics` (table, cell, token and extracted row counts); on failure `request` and `error` |
| `export/extracted-table.json` | `extracted-table/v1` | `write-extracted-csv` | `runId`, `rows`, `normalizedArtifact` |
| `export/extracted.csv` | none | `write-extracted-csv` | §8.6 |
| comparison output | `run-comparison/v1` | `compare-runs` | §9.2 |
| dataset `manifest.json` | `ocr-cell-dataset/v1` | `materialize-training-data` | §9.3 |
| dataset JSONL record | `ocr-cell-example/v1` | `materialize-training-data` | §9.3 |

### 5.4 Stage versions

Every run manifest records these values. A change to a stage's behavior changes its version in the same delivery.

| Key | v1 value |
| --- | --- |
| `pipelineVersion` | `1.0.0` |
| `preprocessingVersion` | `none-v1` |
| `textractConfigurationVersion` | `textract-tables-v1` |
| `textractNormalizerVersion` | `textract-normalizer-v2` |
| `tableParserVersion` | `scoreboard-parser-v5` |
| `semanticMapperVersion` | `scoreboard-semantic-v2` |
| `validationRulesVersion` | `scoreboard-validation-v2` |

## 6. Processing pipeline

### 6.1 Main workflow

`<stack>` is a Standard state machine with a 15-minute timeout, X-Ray tracing, and `ALL`-level logging with execution data to `/aws/vendedlogs/states/<stack>`.

1. **Process email and attachments** invokes `ProcessEmail` with the trigger input and replaces the state with `ProcessEmailOutput`.
2. **Process attachments** is a `Map` over `$.screenshots` with a maximum concurrency of 2. Each item is `{ "source": <SourceScreenshot> }`. Results go to `$.results`.
3. Inside each item, **Extract text** invokes `ExtractText` and returns `ExtractTextOutput`, then **Write extracted CSV** invokes `WriteExtractedCsv` and stores its output at `$.summary`.

A failure in any item fails the `Map` and the execution. Items that already finished keep their evidence.

### 6.2 Replay workflow

`<stack>-replay` is a Standard state machine with a 15-minute timeout and X-Ray tracing. Its input is `ProcessingRunInput`, an existing `SourceScreenshot` under `source`. It runs **Replay extract text** and then **Replay write extracted CSV**, with the same Lambdas and retries as the main workflow, and creates a new run beside the earlier ones. The stack exports its ARN as `ReplayStateMachineArn`.

### 6.3 Retries

Every task disables the default service-exception retry and declares one explicit policy: an initial interval of 2 seconds, a backoff rate of 2 and at most 3 attempts, for these errors:

```text
Lambda.ClientExecutionTimeoutException  Lambda.ServiceException  Lambda.AWSLambdaException
Lambda.SdkClientException  Lambda.TooManyRequestsException
Textract.InternalServerError  Textract.ProvisionedThroughputExceededException  Textract.ThrottlingException
InternalServerError  ProvisionedThroughputExceededException  ThrottlingException
```

A retried intake creates a new submission identifier, and a retried extraction creates a new run identifier, so retries never collide with partial evidence from the failed attempt.

### 6.4 Export idempotency

`write-extracted-csv` writes its two objects concurrently. If either write fails with HTTP 412 (the object already exists), the stage treats that object as written and continues, so a retry after a partial export completes instead of failing. Any other storage error fails the stage.

## 7. OCR extraction and normalization

### 7.1 Extraction run

`runExtraction(event, dependencies)` performs these steps in order:

1. Create a `runId`, write `manifest.json`, then append `RUN_STARTED`.
2. Read the original image and its Sharp metadata.
3. Refuse the image with `SourceHashMismatchError` when its SHA-256 differs from `source.sha256`, `ImageTooLargeError` when it exceeds 10 MiB, or `UnsupportedImageFormatError` when it is not PNG or JPEG. Textract is not called.
4. Write `textract/request.json`, call `AnalyzeDocument` with the image bytes and `FeatureTypes: ['TABLES']`, and write the full response to `textract/raw-response.json`.
5. Sample row colours (§8.3), run `processScoreboardImage` (§8), and normalize every block (§7.2). Write `normalized/observations.json`. A board with an unsupported team layout yields no rows and still completes the run.
6. Write a `SUCCEEDED` completion, append `RUN_SUCCEEDED`, log `Screenshot processed`, and return `ExtractTextOutput`.

On any error after step 1, the stage writes a `FAILED` completion and `RUN_FAILED` with the request reference (when one exists) and the error name and message, then rethrows. A failure to record the failure is logged at `ERROR` and does not mask the original error.

### 7.2 Normalized observations

The normalizer keeps every provider block and adds derived records. Observation identifiers are `<runId>:<kind>:<providerBlockId>`.

- **Blocks:** every block with its type, text, confidence, geometry, page, row and column index and span, entity types, selection status, relationships and text type.
- **Tables:** one record per `TABLE` block with its index in response order, confidence, geometry, child cell identifiers and a `classification` of `SCOREBOARD` when the header maps `PLAYER` and at least two semantic fields, otherwise `UNKNOWN`.
- **Cells:** one record per `CELL` block. `observedText` joins the cell's child token text with spaces. `tableLocation` holds table, row and column indexes and spans. `semanticLocation` holds the mapped field (`PLAYER`, `SCORE`, `KILLS`, `ASSISTS`, `DEATHS` or `UNKNOWN`) and `rowRole` (`HEADER` for row 1, otherwise `DATA`). `parsed` holds the expected type, whether parsing succeeded, the string value, the integer value when the text is all digits, and an empty `transformations` list.
- **Tokens:** `WORD`, `LINE` and `SELECTION_ELEMENT` blocks with their parent cell when one exists.
- **Geometry:** `imageArtifactId` (the screenshot ID), the normalized bounding box and the polygon. Coordinates refer to the stored original image.

Header text maps to a field per table: text containing `PLAYER` maps to `PLAYER`; text equal to `SCORE`, `KILLS`, `ASSISTS` or `DEATHS` maps to that field. Matching is case-insensitive after trimming.

### 7.3 Deterministic validation

Validation version `scoreboard-validation-v2` evaluates each cell:

| Flag | Condition | Severity |
| --- | --- | --- |
| `EMPTY_REQUIRED_CELL` | observed text is empty | `WARNING` |
| `LOW_TEXTRACT_CONFIDENCE` | confidence below 95 (records `actual`) | `WARNING` |
| `INVALID_INTEGER` | a `DATA` cell in a `SCORE`, `KILLS`, `ASSISTS` or `DEATHS` column whose non-empty text is not all digits | `WARNING` |

A cell is `valid` when it is non-empty and has no invalid integer. `deterministicReviewRequired` is true when any flag applies. Flags never change the observed text.

## 8. Scoreboard parsing

`processScoreboardImage(blocks, rowColors)` in `src/lib/scoreboard-logic.ts` is a pure function. It never calls AWS or Sharp. It returns `{ rows, noRowsReason? }`, where `noRowsReason` is set only when §8.4 rejects the team layout.

### 8.1 Table selection

Each `TABLE` block is scored on its row-1 cells: 3 points for a header containing `PLAYER` and 1 point for each header equal to `SCORE`, `KILLS`, `ASSISTS` or `DEATHS`. The highest score wins; ties keep response order. With no table, or a table without relationships, the result is empty. Only the selected table becomes CSV rows; normalized observations keep every table.

### 8.2 Columns and player rows

1. Build a row-by-column grid of cell text, joining `WORD` children with spaces.
2. The lowest row index is the header. Map recognized headers to `player`, `score`, `kills`, `assists` and `deaths`.
3. Any field left unmapped falls back to the header's columns in order: player first, then score, kills, assists and deaths.
4. For each later row, tidy the player name: drop words that hold no letter, digit or square bracket, remove one leading clan tag in square brackets, and collapse runs of whitespace. Gamertags hold only letters, digits and spaces, so a dropped word is an icon Textract read as text, such as the chat bubble MCC draws as `...`. Skip rows with an empty name.
5. Skip rows where neither score nor kills is all digits. This drops totals, footers and other non-player rows.
6. Flag player names Textract may have misread (§8.2.1).

#### 8.2.1 Player review flags

A row gets `reviewFlags` when a rule below applies to its player name, and has no `reviewFlags` otherwise. The name's words are the last words of the player cell after the icon filter in step 4, as many as the tidied name holds, so clan-tag words never count. A word without a confidence is skipped, and a name with no known confidence gets no flags. Flags never change the name, which stays as read. Correcting a name needs a source of truth beyond the screenshot and is out of scope (§2.2).

| Code | Condition | `wordConfidence` |
| --- | --- | --- |
| `LOW_WORD_CONFIDENCE` | a name word's `WORD` confidence is below 50 | the lowest name-word confidence |
| `SPLIT_TRAILING_DIGITS` | the name's last word is all digits, the word before it ends in a letter, and either word's confidence is below 90 | the lower of the two |

Each flag records `field: 'player'`. The thresholds come from the two real Halo 3 captures: correctly read gamertag words went as low as 52, a lowercase `l` read as `I` scored 39, and a space inserted before trailing digits split one gamertag into words scoring 55 and 88. Gamertags may contain spaces, so a split read with high confidence is not flagged. A `CELL` block's confidence describes table structure and stays near 89 for every player cell in those captures, so it cannot single out a misread.

### 8.3 Row colour sampling

`computeRowColors` in `src/lib/textract-analysis.ts` computes one `RowColor` per table row index found in `CELL` blocks. `extract-text` and the fixture capture script both call it. For each row it takes the union of its cells' vertical extents, decodes a band one pixel high at the row's vertical midpoint from 10% to 40% of the image width, and records the band's mean red, green and blue. Sharp's `stats()` reads the whole image and ignores `extract()`, so the band is averaged from its raw pixels. Dimensions come from the original image. With unknown dimensions there are no colours.

### 8.4 Team detection and naming

1. Cluster the colours of the player rows greedily in input order. The header and rows §8.2 dropped take no part, so a shaded header cannot form a team. A row joins the nearest existing cluster when the Euclidean RGB distance is at most 40, and the cluster's mean updates. Otherwise it starts a new cluster.
2. Only two-team boards are supported. When no player row has a colour, or the player rows form one cluster or three or more, the result has no rows and `noRowsReason` is `{ code: 'UNSUPPORTED_TEAM_LAYOUT', colorClusterCount }`. The count is 0 when no player row has a colour. Free-for-all and three-team boards end here.
3. With exactly two clusters, name each cluster from the HSV values of its mean colour:

| Name | Rule (hue in degrees, saturation and value from 0 to 1) |
| --- | --- |
| Red | hue >= 345 or < 10 |
| Brown | hue 10 to 25 with value < 0.55 or saturation < 0.55 |
| Orange | hue 15 to 35 with saturation >= 0.45 |
| Gold | hue 35 to 60 with value >= 0.55 |
| Green | hue 95 to 140 |
| Blue | hue 200 to 250 |
| Purple | hue 260 to 290 |
| Pink | hue 290 to 345 |
| Fallbacks | value < 0.45 and saturation < 0.45 is Brown; hue 55 to 95 is Gold; otherwise the nearest hue target among Red 0, Orange 25, Gold 50, Green 120, Blue 225, Purple 275, Pink 315, Brown 20 |

Rules apply in table order and the first match wins. When both clusters receive the same name, the second becomes `<name> 2`. A player row without a colour has an empty team.

### 8.5 Win and loss

- The winning team is the team of the player row with the lowest row index.
- Every row on the winning team has `win = 1, loss = 0`. Every other row, including a row with no team, has `win = 0, loss = 1`.

### 8.6 CSV format

`rowsToCsv(rows)` writes the header `Team,Player,Score,Kills,Assists,Deaths,Win,Loss`, then one line per row in table order. Every value, including the header and the numeric flags, is wrapped in double quotes with embedded quotes doubled. Lines end with `\n`, including the last. Statistics are written exactly as observed. The CSV leaves out `reviewFlags`; `extract-text`'s output, `parser.rows` in normalized observations, and `export/extracted-table.json` keep them.

## 9. Replay, comparison and training data

### 9.1 Replay

An operator starts the replay workflow with an existing `SourceScreenshot` (§6.2), usually copied from `source/metadata.json`. The new run records the current stage versions and commit, so replaying after a parser change produces a comparable run without altering the original.

### 9.2 Run comparison

The `CompareRuns` Lambda (exported as `RunComparisonFunctionName`) takes `{ bucket, baselineKey, candidateKey, outputKey }`.

- Both input keys must end in `/normalized/observations.json`. The output key must end in `.json` and differ from both inputs. Both runs must belong to the same screenshot when both record one.
- Cells are matched on `tableIndex:rowIndex:columnIndex`. A coordinate is reported when it exists in only one run, or when its text or confidence differs.
- The output (`run-comparison/v1`) holds the screenshot ID, both run IDs, `comparedAt`, a summary of baseline, candidate and changed cell counts, and the list of changes with before and after text and confidence. It is written once and returned.

### 9.3 Training-data materialization

The `MaterializeTrainingData` Lambda (exported as `TrainingDataMaterializerFunctionName`) takes `{ bucket, normalizedKeys, splitSeed? }` with 1 to 1,000 keys. It deduplicates and sorts the keys, reads each normalized artifact with the run manifest beside it, and writes a dataset under `[ephemeral/<name>/]datasets/<datasetId>/`.

- **Split:** `sha256(splitSeed + "\0" + screenshotId)`, first four bytes as an unsigned integer, modulo 10,000. Below 8,000 is `TRAIN`, below 9,000 is `VALIDATION`, otherwise `TEST`. The default seed is `ocr-cells-v1`. Every cell and every replayed run of one screenshot lands in the same split.
- **Records:** one `ocr-cell-example/v1` line per cell, joining the cell, its tokens, its validation result, the run's stage versions and build, the source artifact and the normalized artifact reference, with `labelStatus: UNLABELED`.
- **Manifest:** `ocr-cell-dataset/v1` with `datasetId`, `createdAt`, `splitAlgorithm: sha256-screenshot-80-10-10-v1`, `splitSeed`, `labelStatus`, cell `counts` and `screenshotCounts` per split, the three file references, and one source entry per run.

## 10. Typed domain model

### 10.1 Shared contracts

`@mcc/contracts` exports the payloads that cross Lambda, state-machine and application boundaries:

```typescript
interface S3ObjectReference { bucket: string; key: string }

type AcquisitionType = 'SCREENSHOT' | 'PHOTO' | 'OTHER';

interface SourceScreenshot extends S3ObjectReference {
  screenshotId: string;
  submissionId: string;
  attachmentName: string;
  contentType: string;
  sha256: string;
  acquisitionType: AcquisitionType;
  widthPx: number;
  heightPx: number;
}

type RowReviewCode = 'LOW_WORD_CONFIDENCE' | 'SPLIT_TRAILING_DIGITS';

interface RowReviewFlag {
  field: 'player';
  code: RowReviewCode;
  wordConfidence: number; // lowest WORD confidence the rule read, 0 to 100
}

interface CsvRow {
  team: string; player: string; score: string; kills: string;
  assists: string; deaths: string; win: number; loss: number;
  reviewFlags?: RowReviewFlag[]; // present only when a §8.2.1 rule applies
}

type ProcessEmailInput = S3ObjectReference;

type AttachmentRejectionCode =
  | 'NOT_AN_IMAGE' | 'UNREADABLE_IMAGE' | 'UNSUPPORTED_IMAGE_FORMAT'
  | 'IMAGE_TOO_LARGE' | 'IMAGE_TOO_SMALL';

interface RejectedAttachment {
  attachmentIndex: number;
  attachmentName: string;
  contentType: string;
  fileSizeBytes: number;
  rejectionCodes: AttachmentRejectionCode[];
  source?: S3ObjectReference; // present for stored images
}

interface ProcessEmailOutput {
  submissionId: string;
  screenshots: SourceScreenshot[];
  rejectedAttachments: RejectedAttachment[];
}

interface ProcessingRunInput { source: SourceScreenshot }

interface ExtractTextOutput {
  runId: string;
  source: SourceScreenshot;
  rows: CsvRow[];
  normalizedArtifact: S3ObjectReference;
}

interface WriteExtractedCsvOutput extends S3ObjectReference { runId: string; rowCount: number }

type DatasetSplit = 'TRAIN' | 'VALIDATION' | 'TEST';

interface MaterializeTrainingDataInput { bucket: string; normalizedKeys: string[]; splitSeed?: string }

interface MaterializeTrainingDataOutput {
  datasetId: string;
  bucket: string;
  prefix: string;
  manifest: S3ObjectReference;
  files: Record<Lowercase<DatasetSplit>, S3ObjectReference>;
  counts: Record<Lowercase<DatasetSplit>, number>;
}
```

### 10.2 Internal types

`scoreboard-logic.ts` defines `TextractBlockLite` (the block fields the parser needs: `Id`, `BlockType`, `Text`, `Confidence`, `RowIndex`, `ColumnIndex`, the bounding box `Top` and `Height`, and relationships), `RowColor` (`rowIndex`, `r`, `g`, `b`), and the parser result `ScoreboardParseResult` (`rows` and the optional `noRowsReason`, a `NoRowsReason` with `code` and `colorClusterCount`). `compare-runs.ts` and `materialize-training-data.ts` declare the partial views of normalized artifacts and manifests they read. `@mcc/cdk-config` defines `DeploymentConfig` (§13.3).

### 10.3 Relationships

```text
Raw email 1 -> 1 submission (per successful intake attempt)
Submission 1 -> many attachments -> 0..1 stored source each
Submission 1 -> many SourceScreenshot (accepted) -> many processing runs (first run plus replays)
Processing run 1 -> 1 manifest, 1 request, 0..1 raw response, 0..1 normalized artifact, 0..1 export pair, 1 completion
Normalized artifact 1 -> many tables -> many cells -> many tokens
Dataset 1 -> many runs (by normalized artifact) -> many cell examples
Comparison 1 -> exactly 2 runs of one screenshot
```

## 11. Module and function catalog

Every handler exports `handler` for Lambda and a core function that takes an injected dependencies object. Only the default dependencies construct SDK clients.

### 11.1 Lambda entry points

| File | Public functions | Purpose |
| --- | --- | --- |
| `src/lambdas/process-email.ts` | `handler(event)`; `processEmail(event, dependencies)`; `attachmentRejectionCodes(content, metadata, metadataError?)` | Parse the raw message, store originals and metadata, record the submission, return accepted screenshots. Requires `EVIDENCE_BUCKET`. |
| `src/lambdas/extract-text.ts` | `handler(event)`; `runExtraction(event, dependencies)`; `normalize(rawBlocks, source, runId)` | Run one processing run (§7). Records `GIT_SHA` and `DEPLOYMENT_ENVIRONMENT` in the manifest. |
| `src/lambdas/write-extracted-csv.ts` | `handler(event)`; `writeExtractedCsv(event, dependencies)` | Write the CSV and structured table under the run (§6.4). |
| `src/lambdas/compare-runs.ts` | `handler(event)`; `compareNormalizedRuns(baseline, candidate)` | Compare two runs of one screenshot (§9.2). |
| `src/lambdas/materialize-training-data.ts` | `handler(event)`; `splitForScreenshot(screenshotId, splitSeed?)`; `materializeExamples(...)`; `manifestKeyForNormalized(normalizedKey)` | Build an unlabeled dataset (§9.3). |

### 11.2 Libraries

| File | Public functions | Purpose |
| --- | --- | --- |
| `src/lib/scoreboard-logic.ts` | `processScoreboardImage(blocks, rowColors)` | Pure scoreboard parser (§8), returning rows and the reason they are empty for an unsupported team layout. |
| `src/lib/textract-analysis.ts` | `analyzeDocumentInput(image)`; `toLiteBlock(block)`; `computeRowColors(image, width, height, blocks)` | The `AnalyzeDocument` request, parser block projection and row colour sampling (§8.3), shared by `extract-text` and `scripts/capture-textract.ts`. |
| `src/lib/csv.ts` | `rowsToCsv(rows)` | Quoted CSV serializer (§8.6). |
| `src/lib/evidence.ts` | `evidenceId()`; `sha256(bytes)`; `putJson(bucket, key, value)`; `now()` | Identifiers, hashing, create-only JSON writes and timestamps. |
| `src/lib/s3.ts` | `bodyToBuffer(body)`; `safeObjectName(value)`; `namespacedObjectKey(key)`; `sourceScreenshotPrefix(source)`; `processingRunPrefix(source, runId)` | S3 body handling and key construction. `namespacedObjectKey` prepends `OBJECT_PREFIX`. |
| `src/lib/log.ts` | `log(level, message, details?)` | One JSON log line per call. |

### 11.3 Infrastructure code

| File | Public API | Purpose |
| --- | --- | --- |
| `cdk/lib/app.ts` | `createMatchToCsvApp(props?, environmentVariables?)` | Build the stack exactly as deployment does, so tests synthesize what ships. |
| `cdk/lib/match-to-csv-stack.ts` | `MatchToCsvStack` | All compute resources (§13.2). |
| `cdk/lib/bundling.ts` | `BUNDLING_IMAGE`; `bundlingRuntime`; `bundlingOptions(includeSharp, bundlingRequired)`; `localEsbuildVersion()`; `checkLocalEsbuild(local)` | Reproducible Lambda bundling (§13.5). |
| `scripts/verify-bundles.mjs` | CLI | Fail when a synthesized Sharp function lacks a Linux ARM64 Sharp binary. |
| `packages/cdk-config/src/index.ts` | `resolveDeployment(context, application, environmentVariables?)` | Deployment identity and safety checks (§13.3). |
| `scripts/cdk-app.mjs` | `npm run app:<synth\|diff\|deploy\|destroy>` | Guarded CDK wrapper (§13.3). |

## 12. Directory structure and ownership

```text
mcc-stats-suite/
  applications/match-to-csv/
    cdk.json                          # CDK app entry: cdk/bin/match-to-csv.ts
    package.json                      # @mcc/match-to-csv; build, typecheck, test, verify:bundle
    tsconfig.json
    README.md                         # Pipeline, evidence layout, replay, materialization
    TESTING.md
    cdk/
      bin/match-to-csv.ts             # Calls createMatchToCsvApp
      lib/{app,match-to-csv-stack,bundling}.ts
    scripts/verify-bundles.mjs
    src/
      lambdas/{process-email,extract-text,write-extracted-csv,compare-runs,materialize-training-data}.ts
      lib/{scoreboard-logic,csv,evidence,s3,log}.ts
    test/
      *.test.ts                       # One file per module or behavior
      fixtures/*.fixture.json         # Reduced Textract blocks, row colours and expected rows
      support/app.ts                  # Stack synthesis helper
  packages/
    contracts/src/index.ts            # Shared payload types
    cdk-config/src/index.ts           # resolveDeployment
  infrastructure/
    modules/foundation/{main,ses,outputs,variables}.tf
    {dev,prod}/foundation/            # Environment roots calling the module
  scripts/{cdk-app,cdk-targets}.mjs
  .github/workflows/{ci-checks,delivery-deploy,_delivery-promote-application,_delivery-deploy-environment,delivery-rollback}.yml
```

`match-to-csv` imports only `@mcc/contracts` and `@mcc/cdk-config` from the monorepo. The foundation never references CDK resources; CDK reads the foundation through SSM parameters.

## 13. Infrastructure and deployment

### 13.1 Foundation resources (OpenTofu)

| Resource | Configuration |
| --- | --- |
| KMS key `alias/<project>-<env>-application-data` | Rotation enabled; deletion window 30 days in prod, 7 in dev. |
| Raw-email bucket `<project>-<env>-<account>-raw-email` | Versioned, public access blocked, SSE-S3, EventBridge notifications on, objects expire after 90 days and noncurrent versions after 1 day. Policy in §1. |
| Evidence bucket `<project>-<env>-<account>-ocr-evidence` | Versioned, public access blocked, SSE-KMS with Bucket Keys, Object Lock with a default GOVERNANCE retention of 365 days. |
| Attachments and output buckets | Versioned, public access blocked, SSE-KMS. Reserved for later features; v1 does not write to them. |
| `ephemeral/` lifecycle | Attachments and output objects expire after 30 days, evidence after 366 days (after its lock ends). Noncurrent versions expire after 30 days, incomplete uploads abort after 7 days, and expired delete markers are removed. Objects outside `ephemeral/` never expire. |
| SES | Rule set `mcc-inbound-<env>`, the `submit` rule (§4.1) and its activation. |
| SSM parameters under `/mcc/<env>/match-to-csv/` | `raw-email-bucket-name`, `evidence-bucket-name`, `attachments-bucket-name`, `output-bucket-name`, `data-key-arn`, `receipt-rule-set-name`, `email-domain`, `email-alias` |

The `email_domain` and `email_alias` variables are sensitive, so plans posted to the public repository redact them and the recipients built from them. The domain must be a lowercase bare domain. The alias must be at most 43 lowercase letters, digits, `_` or `-`, with single dots between them and no `+`.

### 13.2 Application stack (CDK)

| Resource | Configuration |
| --- | --- |
| `ProcessEmail` | 1,024 MB, 2-minute timeout, Sharp, env `EVIDENCE_BUCKET`, `OBJECT_PREFIX` |
| `ExtractText` | 2,048 MB, 2-minute timeout, Sharp, env `OBJECT_PREFIX`, `GIT_SHA`, `DEPLOYMENT_ENVIRONMENT` |
| `WriteExtractedCsv` | 1,024 MB, 2-minute timeout, env `OBJECT_PREFIX` |
| `CompareRuns` | 1,024 MB, 2-minute timeout, env `OBJECT_PREFIX` |
| `MaterializeTrainingData` | 2,048 MB, 10-minute timeout, env `OBJECT_PREFIX` |
| All functions | Node.js 22, ARM64, X-Ray active, named `<stack>-<Id>`, log group `/aws/lambda/<name>` |
| State machines | `<stack>` and `<stack>-replay` (§6) |
| EventBridge rule and DLQ | §4.2 |
| Ephemeral receipt rule | §4.1, only in ephemeral stacks |
| Outputs | `StateMachineArn`, `ReplayStateMachineArn`, `RunComparisonFunctionName`, `TrainingDataMaterializerFunctionName`, `ObjectPrefix` |

Log groups keep events for three months in prod and two weeks otherwise. Stable log groups are retained when the stack is updated or deleted; ephemeral log groups are destroyed with the stack. The stack tags every resource with `Application`, `Environment` and, for ephemeral stacks, `Ephemeral`.

### 13.3 Deployment identity

`resolveDeployment` reads CDK context `environment` (`dev` or `prod`), optional `ephemeral` and optional `expectedAccount`, and returns:

| Field | Stable | Ephemeral `<name>` |
| --- | --- | --- |
| `stackName`, `resourcePrefix` | `match-to-csv-<env>` | `match-to-csv-e-<name>` |
| `objectPrefix` | empty | `ephemeral/<name>` |
| `workloadBoundaryName` | `mcc-stats-suite-workload-boundary` | `mcc-stats-suite-local-workload-boundary` |
| `bootstrapQualifier` | `hnb659fds` | `mcclocal1` |
| `rolePath` | none | `/mcc-local/` |
| `terminationProtection` | true | false |

It rejects ephemeral names in prod, names outside `^[a-z0-9][a-z0-9-]{0,19}$`, the reserved names `ephemeral`, `incoming`, `dev` and `prod`, malformed account IDs, and any mismatch between the expected account and `CDK_DEFAULT_ACCOUNT`.

`scripts/cdk-app.mjs` wraps every CDK command. It allows stable deploys only from GitHub Actions on `refs/heads/main`, ephemeral deploys only from a local shell, and `destroy` only for ephemeral stacks. Before any AWS call it compares the STS caller account with `MCC_DEV_ACCOUNT_ID` or `MCC_PROD_ACCOUNT_ID` (or the profile's SSO account), refuses a profile whose name implies the other environment, and passes the checked-out commit as `GIT_SHA`. It never accepts raw `-c` context.

### 13.4 IAM

| Function | Raw-email bucket | Evidence bucket | KMS data key | Textract |
| --- | --- | --- | --- | --- |
| `ProcessEmail` | read | `PutObject` | encrypt, decrypt | none |
| `ExtractText` | none | `GetObject`, `PutObject` | encrypt, decrypt | `AnalyzeDocument` on `*` |
| `WriteExtractedCsv` | none | `PutObject` | encrypt, decrypt | none |
| `CompareRuns` | none | `GetObject`, `PutObject` | encrypt, decrypt | none |
| `MaterializeTrainingData` | none | `GetObject`, `PutObject` | encrypt, decrypt | none |

Every role carries the workload permissions boundary named in §13.3. Ephemeral roles use the `/mcc-local/` path, the only path the local bootstrap lets CloudFormation create or pass. No function has `DeleteObject` or any bucket-configuration permission.

### 13.5 Bundling

Functions are bundled with esbuild, minified, with source maps, targeting `node22`. `ProcessEmail` and `ExtractText` install `sharp` as a node module and always bundle in Docker so the native binary matches Linux ARM64. The Docker image is the SAM Node.js 22 build image pinned by digest. Docker bundling installs the esbuild version locked in `package-lock.json`, and synthesis fails when a local esbuild differs from it. After synthesis, `verify:bundle` inspects both Sharp assets for a Linux ARM64 binary.

### 13.6 Delivery

CI synthesizes the stack and verifies bundles on every affecting change. After a merge to `main`, the delivery workflow deploys to dev and then, after a required reviewer approves, to prod. For `match-to-csv` the deploy job runs on an ARM64 runner and:

1. Verifies the deployment request, the checked-out SHA and the target account.
2. Reads the CDK bootstrap version parameter and the five foundation parameters it needs (raw-email bucket, evidence bucket, data key, rule set name, domain), and fails if any is missing.
3. Masks the domain in all later log lines, then checks that the foundation rule set is the active one, that the SES identity for the domain is verified, and that the domain's MX record targets `inbound-smtp.<region>.amazonaws.com`.
4. Synthesizes, verifies bundles, and prints a CDK diff for prod.
5. Records a GitHub deployment, deploys, and verifies the stack status, that every Lambda is `Active` with a `Successful` last update, and that both state machines are `ACTIVE`.

Prod requires an Environment with required reviewers and administrator bypass disabled. A rollback workflow redeploys a published release tag that was previously deployed to prod.

## 14. Security and privacy

1. No artifact is public. Every bucket blocks public access, and the raw-email bucket denies requests without TLS.
2. Screenshots, OCR text and CSVs contain gamertags. They live only in the evidence bucket, encrypted with the customer-managed key.
3. The receiving domain, recipient addresses, account IDs and real messages never appear in source control, fixtures or logs. The deploy workflow masks the domain before using it.
4. SES scans every inbound message for spam and viruses. Attachments are parsed with `mailparser` and inspected with Sharp using `failOn: 'none'`, so a corrupt image becomes a rejection instead of a crash.
5. Attachment names are normalized before they appear in keys, so a crafted filename cannot change the key structure.
6. Integrity is checked before OCR (§7.1). Object Lock and create-only writes prevent the application from altering evidence.
7. Ephemeral stacks cannot reach shared evidence through key construction: every key they write starts with `ephemeral/<name>/`, their roles carry the local boundary, and the reserved names stop one stack from claiming another's namespace.

## 15. Observability

- Lambdas log JSON lines through `log(level, message, details)` with the levels `ERROR`, `WARN`, `INFO`, `DEBUG` and `TRACE`. Handlers log the start and end of intake, the processed screenshot with its row count and any `noRowsReason`, and any failure to record a failure.
- Step Functions logs every state with execution data. The execution history shows each screenshot's path and error.
- X-Ray tracing is active on every function and both state machines.
- Evidence is the audit record. Submission completions and run completions carry counts, request IDs, response hashes and error summaries.
- Undeliverable trigger events wait in the dead-letter queue for 14 days.

## 16. Testing, CI and release

### 16.1 Unit and synthesis tests

Tests use `tap`, run from `applications/match-to-csv/test/*.test.ts`, and never call AWS. The command fails below 80% statements, 65% branches, 80% lines or 60% functions. CloudFormation schema validation is disabled in TAP child processes.

| File | Covers |
| --- | --- |
| `scoreboard-logic.test.ts` | two-team match, no rows and the reason for one-cluster, no-colour and three-cluster boards, header and non-player row colours kept out of clustering, non-player row filtering, header fallback, choosing the scoreboard over an earlier decoy table, win/loss, player review flags |
| `scoreboard-fixtures.test.ts` | every `*.fixture.json` produces its `expectedRows`, with each listed misread kept as read and flagged, except the fields a `knownIssue` lists, which run as a `todo` test; the directory holds at least one fixture |
| `normalization.test.ts` | semantic header mapping; independent mapping per table; invalid integer flags |
| `extract-text-handler.test.ts` | a complete successful run; a board that is not two-team succeeds with no rows and records `noRowsReason`; provider failure records and rethrow; hash mismatch never calls the provider |
| `process-email.test.ts` | multiple attachments with an ephemeral prefix; rejected submission; independent rejection codes; failed completion when storage fails |
| `write-extracted-csv.test.ts` | both export objects; resume after one exists; storage failures surface |
| `csv.test.ts` | quoting of commas, quotes and numeric flags |
| `run-comparison.test.ts` | changed cells only; added and removed cells; physical coordinates across tables |
| `materialize-training-data.test.ts` | stable splits; all three partitions used; joins of cells, tokens, validation, versions and provenance; manifest key derivation |
| `s3.test.ts` | stable keys unchanged; ephemeral namespacing; run prefix follows the source key |
| `receipt-rules.test.ts` | stable stacks add no receipt rule; ephemeral stacks add exactly one plus-addressed rule |
| `app.test.ts` | termination protection by stack type; `GIT_SHA` precedence over `GITHUB_SHA` |
| `bundling.test.ts` | locked esbuild for Docker bundling; Docker forced only for Sharp functions; local esbuild check; pinned image |

A fixture is a JSON file with `name`, `blocks`, `rowColors` and `expectedRows`, plus an optional `knownIssue` naming a tracked mismatch and the fields it affects, and optional `misreads` listing values the parser keeps as read and flags for review. Each fixture covers one behavior, preferably a real Textract output reduced to the smallest failing case with player data replaced. `test/fixtures/README.md` describes capturing a screenshot with `scripts/capture-textract.ts` and reducing it with `scripts/reduce-capture.ts`.

### 16.2 CI and release

CI runs format, lint, typecheck and tests for affected workspaces, then synthesizes `match-to-csv` with `-c environment=dev -c ephemeral=ci` and runs `verify:bundle` in a separate job that pulls the pinned bundling image. Release Please versions the application and both shared packages from Conventional Commit titles; a shared-package change bumps every dependent application.

### 16.3 Live validation

After a change reaches dev and before approving prod, an operator sends a representative PNG or JPEG to the dev recipient, confirms every state of the execution succeeded, checks that the run holds every object in §5.1, and compares the CSV with the screenshot. A failure test sends an unsupported or undersized image and confirms a `REJECTED` submission and a failed execution.

## 17. Acceptance criteria

v1 is complete when all of the following hold:

1. An email with two valid screenshots and one PDF to the dev recipient produces one submission with two `ACCEPTED` sources, one `NOT_AN_IMAGE` rejection, two runs with every §5.1 object, and a succeeded execution.
2. An email with only an undersized image produces a `REJECTED` submission with `IMAGE_TOO_SMALL`, a stored original, and a failed execution.
3. A Textract throttling error that persists through retries leaves `RUN_STARTED`, `RUN_FAILED`, the request record and a `FAILED` completion.
4. A two-team screenshot produces a CSV with MCC colour names and the top team marked as winners. A screenshot whose player rows share one colour produces no rows, a `SUCCEEDED` run, and `parser.noRowsReason` with a cluster count of 1.
5. Replaying a screenshot creates a second run without changing the first, and comparing the two runs reports zero changes when the stage versions are unchanged.
6. Materializing runs from at least 20 screenshots places every cell of a screenshot in one split and records the split algorithm and seed.
7. An ephemeral stack receives mail at its plus address, writes only under `ephemeral/<name>/`, and destroys cleanly.
8. Every §16.1 test passes with the coverage thresholds, CDK synthesis succeeds, and `verify:bundle` finds Linux ARM64 Sharp in both Sharp functions.
9. The prod deploy job passes its preflight and post-deploy checks.

## 18. Risks and accepted limitations

1. **Only two-team boards produce rows.** Free-for-all and three-team screenshots produce no rows, and so does a two-team screenshot whose team colours merge at a distance of 40 or less or whose row colours could not be sampled. Each run succeeds, so the only signals are `parser.noRowsReason`, the `Screenshot processed` log line, and on a stable stack the zero-row alarm.
2. **The top row decides the winner.** The parser trusts MCC's ordering. It does not read placement, detect ties or check scores.
3. **Colour naming is heuristic.** The thresholds come from MCC's palette, not from a labeled corpus. Lighting in photographed screens can shift hues, and two similar teams can merge at a distance of 40 or less.
4. **Only one table becomes CSV.** A scoreboard that Textract splits into several tables yields a partial CSV. The normalized evidence keeps every table, so a later parser can recover the rest by replay.
5. **No orientation correction.** A photo whose EXIF orientation tag rotates it will be read as stored. v1 treats every accepted image as a screenshot.
6. **Retries can duplicate work.** A retried intake creates a second submission for the same raw message, and a retried extraction creates a second run. A Lambda timeout can leave a run with `RUN_STARTED` and no completion. Consumers must treat a run without a `SUCCEEDED` completion as incomplete.
7. **GOVERNANCE mode, not COMPLIANCE.** A principal with `s3:BypassGovernanceRetention` can delete locked evidence. That keeps deliberate cleanup possible, at the cost of no protection against a compromised administrator.
8. **Raw MIME expires after 90 days.** Non-image attachments and the original headers are lost after that. Accepted screenshots are kept in the evidence bucket.
9. **Player names reach logs.** Step Functions logs include execution data, which carries attachment names and extracted rows. Log retention is two weeks in dev and three months in prod.
10. **Operator Lambdas trust IAM alone.** `CompareRuns` and `MaterializeTrainingData` accept any key in the bucket. Create-only writes stop them from overwriting evidence, but they can write new objects outside a run.
11. **`EMPTY_REQUIRED_CELL` fires on every empty cell,** including cells in unmapped columns. Reviewers should expect noise there until the validation rules know which columns are required.
12. **Player review thresholds come from two captures.** §8.2.1 separates the misreads in those captures from every correct reading, with a margin of a few points on one side. More captures may show misreads above 50 or correct readings below it. A misread that scores high and keeps the word count, such as `I` for `l` at 90, passes unflagged.

## 19. Reference documentation

- SES receipt rule S3 action: https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html
- Textract `AnalyzeDocument`: https://docs.aws.amazon.com/textract/latest/dg/API_AnalyzeDocument.html
- Textract tables: https://docs.aws.amazon.com/textract/latest/dg/how-it-works-tables.html
- Textract input limits: https://docs.aws.amazon.com/textract/latest/dg/limits-document.html
- S3 conditional writes: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html
- S3 Object Lock: https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html
- S3 events in EventBridge: https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventBridge.html
- EventBridge dead-letter queues: https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html
- Step Functions `Map` state: https://docs.aws.amazon.com/step-functions/latest/dg/state-map.html
- Step Functions error handling: https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html
- CDK `NodejsFunction` bundling: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_nodejs-readme.html
- IAM permissions boundaries: https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html
- Sharp input and metadata: https://sharp.pixelplumbing.com/api-input
- node-tap: https://node-tap.org/

## 20. Delivery plan: phases and slices

This section is the backlog source for building the component. It is written to be turned directly into GitHub issues.

### 20.1 How to file this plan

- Each **phase** becomes one epic. Use the phase title as the epic title and its goal and exit criteria as the epic body. Create epics only when someone explicitly asks for issue filing; reading or revising this plan does not authorize filing.
- Each **slice** becomes one leaf issue under its phase epic, titled without its code. Put the code in the body as `Plan ID: P2.3` so later issues can cross-reference it. File with `/mcc-create-github-issue`.
- **Size** is XS, S or M. Split a slice by independently testable behavior when it outgrows one reviewable PR, and keep the original Plan ID on the container.
- **Blocked by** lists Plan IDs. Create native blocked-by relationships after every issue in the batch exists. Blockers in earlier phases still apply.
- **Acceptance** bullets become the issue's acceptance criteria verbatim. Every slice also inherits §20.3.
- **Spec** lists the sections the implementer must read. Link them rather than copying them. This document stays the source of truth.
- Plan IDs are stable. New slices take the next free number in their phase.
- Phase 8 is backlog. File it only after Phase 7 closes.

### 20.2 Seam contracts

| Contract | Defined in | Main consumers |
| --- | --- | --- |
| Payload types in `@mcc/contracts` (§10.1) | P0.2 | every Lambda, the state machines, later applications |
| `DeploymentConfig` and `resolveDeployment` | P0.3 | the stack, the CDK wrapper, every application |
| Foundation SSM parameter names (§13.1) | P1.1, P1.2 | the stack, the deploy preflight |
| Evidence key layout and create-only writes (§5) | P2.1 | every Lambda, comparison, materialization, specs 2 and 3 |
| `source-screenshot/v1` and submission records | P2.3 | extraction, replay |
| `RowColor`, `TextractBlockLite` and `processScoreboardImage` | P3.1, P3.2 | extraction, fixtures |
| `normalized-ocr/v2` and stage versions | P3.4, P3.5 | export, comparison, materialization, specs 2 and 3 |

A change to a contract updates every consumer in the same PR.

### 20.3 Definition of done for every slice

- Handlers keep I/O behind an injected dependencies object; only default dependencies construct SDK clients.
- New behavior has `tap` tests that run without AWS, and the workspace stays above its coverage thresholds.
- `npm run check` passes. Slices that touch CDK or bundling also pass `npm run app:synth -- match-to-csv --environment dev` and `npm run verify:bundle --workspace @mcc/match-to-csv`. Slices that touch `infrastructure/` pass `npm run tofu:check`.
- Any change to a stage's behavior bumps that stage's version (§5.4).
- No domain, address, account ID, real message or player data appears in code, fixtures, logs or docs.
- Operator-visible changes update `applications/match-to-csv/README.md` or the self-hosting guide.

### Phase 0: Workspace and contracts

**Goal:** a buildable workspace, shared payload types and safe deployment identity.
**Exit criteria:** the workspace builds and tests in CI, contracts compile, and `resolveDeployment` rejects every unsafe input in §13.3.

#### P0.1 Application workspace and test gate (S)

- **Blocked by:** none
- **Spec:** §3, §12, §16.1
- **Files:** `applications/match-to-csv/{package.json,tsconfig.json,cdk.json,TESTING.md}`, `cdk/bin/match-to-csv.ts`
- **Provides:** `build`, `typecheck`, `test` and `verify:bundle` scripts
- **Acceptance:**
  - `npm test --workspace @mcc/match-to-csv` runs every `test/*.test.ts` with `tap` and fails below 80% statements, 65% branches, 80% lines or 60% functions.
  - The workspace depends only on `@mcc/contracts` and `@mcc/cdk-config` from the monorepo.
  - CI runs the workspace's typecheck and tests on affecting changes.

#### P0.2 Shared payload contracts (XS)

- **Blocked by:** none
- **Spec:** §10.1
- **Files:** `packages/contracts/src/index.ts`, `packages/contracts/package.json`
- **Provides:** every type in §10.1
- **Acceptance:**
  - The package exports exactly the §10.1 types and builds without runtime code.
  - Release Please versions the package, and `npm run release:check` passes.

#### P0.3 Deployment identity and guarded CDK wrapper (M)

- **Blocked by:** none
- **Spec:** §13.3
- **Files:** `packages/cdk-config/src/index.ts`, `packages/cdk-config/test/config.test.js`, `scripts/cdk-app.mjs`, `scripts/cdk-targets.mjs`
- **Provides:** `resolveDeployment`, `npm run app:*`
- **Acceptance:**
  - Stable and ephemeral deployments resolve to the §13.3 values.
  - Ephemeral names in prod, invalid names, reserved names, malformed account IDs and account mismatches all fail with a message.
  - The wrapper refuses stable deploys outside GitHub Actions on `main`, ephemeral deploys inside GitHub Actions, `destroy` of stable stacks, raw `-c` context, and an STS account that differs from the expected one.
  - The wrapper sets `GIT_SHA` from the checked-out commit.

### Phase 1: Persistent foundation

**Goal:** encrypted storage and inbound email that outlive any application stack.
**Exit criteria:** both environment roots plan and apply, and every §13.1 parameter exists.

#### P1.1 Key, buckets and parameters (M)

- **Blocked by:** none
- **Spec:** §1 (encryption and SES rows), §13.1
- **Files:** `infrastructure/modules/foundation/{main,outputs,variables}.tf`, `infrastructure/{dev,prod}/foundation/*.tf`, `.terrateam/config.yml`
- **Provides:** buckets, key and the bucket and key SSM parameters
- **Acceptance:**
  - The four buckets exist with versioning, public access blocks and the §13.1 encryption.
  - The evidence bucket has Object Lock with a GOVERNANCE default of 365 days.
  - The raw-email bucket sends EventBridge notifications, expires objects after 90 days, denies non-TLS requests and allows SES `PutObject` only under `incoming/` with source account and rule-set ARN conditions.
  - The `ephemeral/` lifecycle rules match §13.1, and objects outside the prefix never expire.
  - `npm run tofu:check` passes, and each root's Terrateam `file_patterns` include the module.

#### P1.2 Inbound email rule set (S)

- **Blocked by:** P1.1
- **Spec:** §4.1, §13.1
- **Files:** `infrastructure/modules/foundation/ses.tf`, `infrastructure/modules/foundation/tests/ses.tftest.hcl`
- **Provides:** `receipt-rule-set-name`, `email-domain`, and `email-alias` parameters
- **Acceptance:**
  - The rule set `mcc-inbound-<env>` holds a `submit` rule for `<alias>@<domain>` that scans, stores to `incoming/<env>/` and stops.
  - The set activates only after the rule exists, and the rule ignores ordering changes.
  - `email_domain` and `email_alias` are sensitive and validated as in §13.1; the module test covers both.

### Phase 2: Intake

**Goal:** every inbound message becomes a recorded submission with stored originals.
**Exit criteria:** `processEmail` passes the §16.1 intake tests with fakes.

#### P2.1 Evidence helpers and key layout (S)

- **Blocked by:** P0.1, P0.2
- **Spec:** §5.1, §5.2, §15
- **Files:** `src/lib/{evidence,s3,log}.ts`, `test/s3.test.ts`
- **Provides:** `evidenceId`, `sha256`, `putJson`, `now`, `bodyToBuffer`, `safeObjectName`, `namespacedObjectKey`, `sourceScreenshotPrefix`, `processingRunPrefix`, `log`
- **Acceptance:**
  - `putJson` writes with `If-None-Match: *`.
  - `namespacedObjectKey` leaves keys unchanged without `OBJECT_PREFIX` and prefixes them with it.
  - `processingRunPrefix` derives from the source key and rejects keys not ending in `/source/original`.
  - `safeObjectName` follows §4.3.

#### P2.2 Attachment validation (XS)

- **Blocked by:** P0.2
- **Spec:** §4.3
- **Files:** `src/lambdas/process-email.ts` (`attachmentRejectionCodes`), `test/process-email.test.ts`
- **Provides:** `attachmentRejectionCodes`
- **Acceptance:**
  - Each §4.3 condition yields its code, and an attachment failing several checks reports every code.

#### P2.3 Intake Lambda (M)

- **Blocked by:** P2.1, P2.2
- **Spec:** §4.3, §5.3, §7.1 (failure recording pattern)
- **Files:** `src/lambdas/process-email.ts`, `test/process-email.test.ts`
- **Provides:** `ProcessEmailOutput`
- **Acceptance:**
  - Writes `ingestion.json`, stores every image original before inspecting it, writes `source/metadata.json` for each, then the submission completion and event.
  - Returns accepted screenshots and rejected attachments, with `source` set for stored images.
  - With no accepted screenshot, records `REJECTED` and `SUBMISSION_REJECTED`, then throws.
  - On any other error, records `FAILED` and `SUBMISSION_FAILED` on a best-effort basis and rethrows the original error.

### Phase 3: Extraction

**Goal:** one screenshot becomes a complete, versioned processing run with CSV rows.
**Exit criteria:** `runExtraction` and `writeExtractedCsv` pass their tests with fakes, and every parser test passes.

#### P3.1 Scoreboard table and row parsing (M)

- **Blocked by:** P0.2
- **Spec:** §8.1, §8.2
- **Files:** `src/lib/scoreboard-logic.ts`, `test/scoreboard-logic.test.ts`
- **Provides:** `processScoreboardImage` without team logic, `TextractBlockLite`
- **Acceptance:**
  - Selects the highest-scoring table, including when a decoy table comes first.
  - Maps headers, falls back to column order, tidies names, and drops rows without a numeric score or kills.

#### P3.2 Team detection, naming and win/loss (M)

- **Blocked by:** P3.1
- **Spec:** §8.4, §8.5
- **Files:** `src/lib/scoreboard-logic.ts`, `test/scoreboard-logic.test.ts`
- **Provides:** `RowColor`, complete `CsvRow[]` output
- **Acceptance:**
  - A two-team test produces the expected teams and flags.
  - One-cluster, no-colour and three-cluster boards produce no rows and an `UNSUPPORTED_TEAM_LAYOUT` reason with the cluster count.
  - Duplicate colour names receive numeric suffixes.

#### P3.3 CSV serializer (XS)

- **Blocked by:** P0.2
- **Spec:** §8.6
- **Files:** `src/lib/csv.ts`, `test/csv.test.ts`
- **Provides:** `rowsToCsv`
- **Acceptance:**
  - Quotes every value, doubles embedded quotes, and ends every line with `\n`.

#### P3.4 Textract normalizer and validation (M)

- **Blocked by:** P0.2
- **Spec:** §7.2, §7.3
- **Files:** `src/lambdas/extract-text.ts` (`normalize`), `test/normalization.test.ts`
- **Provides:** `normalized-ocr/v2` blocks, tables, cells and tokens
- **Acceptance:**
  - Maps headers per table, classifies tables, and assigns header and data roles.
  - Produces the three §7.3 flags under their conditions without changing observed text.

#### P3.5 Extraction Lambda (M)

- **Blocked by:** P2.1, P3.2, P3.4
- **Spec:** §5.3, §5.4, §7.1, §8.3
- **Files:** `src/lambdas/extract-text.ts`, `test/extract-text-handler.test.ts`
- **Provides:** `ExtractTextOutput`, processing runs
- **Acceptance:**
  - A successful run writes the manifest with versions and build, both events, the request before the call, the raw response, normalized observations and a `SUCCEEDED` completion with metrics.
  - A hash mismatch, oversized image or unsupported format fails before Textract is called.
  - A provider error leaves the request, `RUN_FAILED` and a `FAILED` completion, then rethrows.
  - Row colours follow §8.3.

#### P3.6 Export Lambda (S)

- **Blocked by:** P2.1, P3.3
- **Spec:** §6.4, §8.6
- **Files:** `src/lambdas/write-extracted-csv.ts`, `test/write-extracted-csv.test.ts`
- **Provides:** `WriteExtractedCsvOutput`
- **Acceptance:**
  - Writes `export/extracted.csv` and `export/extracted-table.json` under the run.
  - Treats HTTP 412 as already written and surfaces every other storage error.

### Phase 4: Orchestration and deployment

**Goal:** a deployable stack that runs the pipeline on inbound mail.
**Exit criteria:** dev receives mail and produces a complete run; prod deploys behind approval with every check in §13.6.

#### P4.1 Functions, bundling and IAM (M)

- **Blocked by:** P0.3, P1.1, P2.3, P3.5, P3.6
- **Spec:** §13.2, §13.4, §13.5
- **Files:** `cdk/lib/{app,match-to-csv-stack,bundling}.ts`, `scripts/verify-bundles.mjs`, `test/{app,bundling}.test.ts`, `test/support/app.ts`
- **Provides:** the five functions
- **Acceptance:**
  - Functions match §13.2 and receive only the §13.4 grants inside the permissions boundary, with the local role path on ephemeral stacks.
  - Sharp functions bundle in Docker on the pinned image, and synthesis fails on an esbuild mismatch.
  - `verify:bundle` fails when either Sharp function lacks a Linux ARM64 binary.
  - Stable stacks have termination protection and ephemeral stacks do not; `GIT_SHA` takes precedence over `GITHUB_SHA`.

#### P4.2 Main workflow and trigger (M)

- **Blocked by:** P4.1, P1.2
- **Spec:** §4.2, §6.1, §6.3
- **Files:** `cdk/lib/match-to-csv-stack.ts`
- **Provides:** `StateMachineArn`
- **Acceptance:**
  - The workflow, `Map`, retries, logging and tracing match §6.
  - The EventBridge rule matches only the stack's `incoming/<route>/` prefix and dead-letters failed deliveries.
  - A rejected submission fails the execution.

#### P4.3 Ephemeral receipt rule (S)

- **Blocked by:** P4.2
- **Spec:** §4.1
- **Files:** `cdk/lib/match-to-csv-stack.ts`, `test/receipt-rules.test.ts`
- **Provides:** per-developer addresses
- **Acceptance:**
  - Stable stacks create no receipt rule.
  - An ephemeral stack adds exactly one rule for `<alias>+<name>@<domain>` to the foundation rule set, reading the rule set, alias, and domain from SSM, storing to `incoming/<name>/`.
  - An ephemeral `process-email` rejects a recipient other than the current `<alias>+<name>@<domain>` (§4.1).

#### P4.4 Deployment preflight and verification (S)

- **Blocked by:** P4.2
- **Spec:** §13.6
- **Files:** `.github/workflows/_delivery-deploy-environment.yml`
- **Provides:** guarded dev and prod deploys
- **Acceptance:**
  - The job fails when a foundation parameter is missing, the rule set is not active, the identity is unverified or the MX record does not target SES in the Region.
  - The domain is masked before first use.
  - After deploy, the job fails unless the stack, every Lambda and both state machines are healthy.

### Phase 5: Replay and datasets

**Goal:** operators can re-run, compare and export evidence without touching earlier runs.
**Exit criteria:** acceptance criteria 5 and 6 in §17 pass in dev.

#### P5.1 Replay workflow (S)

- **Blocked by:** P4.2
- **Spec:** §6.2, §9.1
- **Files:** `cdk/lib/match-to-csv-stack.ts`
- **Provides:** `ReplayStateMachineArn`
- **Acceptance:**
  - Replaying a stored source creates a new run beside the earlier ones with the current versions and commit.

#### P5.2 Run comparison (S)

- **Blocked by:** P3.5, P4.1
- **Spec:** §9.2
- **Files:** `src/lambdas/compare-runs.ts`, `test/run-comparison.test.ts`, `cdk/lib/match-to-csv-stack.ts`
- **Provides:** `RunComparisonFunctionName`
- **Acceptance:**
  - Rejects invalid keys, an output key equal to an input, and runs of different screenshots.
  - Reports added, removed, text-changed and confidence-changed cells by physical coordinate, and writes the result once.

#### P5.3 Training-data materializer (M)

- **Blocked by:** P3.5, P4.1
- **Spec:** §9.3
- **Files:** `src/lambdas/materialize-training-data.ts`, `test/materialize-training-data.test.ts`, `cdk/lib/match-to-csv-stack.ts`
- **Provides:** `TrainingDataMaterializerFunctionName`, `ocr-cell-dataset/v1`
- **Acceptance:**
  - Accepts 1 to 1,000 keys, deduplicated and sorted.
  - Splits depend only on seed and screenshot ID, and all three partitions appear over a representative population.
  - Records join every §9.3 field, and the manifest records counts per split.

### Phase 6: Fixtures and validation

**Goal:** regressions in the parser show up as failing fixtures, and live behavior is checked before prod.
**Exit criteria:** the fixture runner passes and the §16.3 checklist is documented.

#### P6.1 Scoreboard fixture corpus (S)

- **Blocked by:** P3.2
- **Spec:** §16.1
- **Files:** `test/scoreboard-fixtures.test.ts`, `test/fixtures/`
- **Provides:** reduced real-world regression cases
- **Acceptance:**
  - Every `*.fixture.json` runs as its own test, and an empty directory fails.
  - Fixtures cover at least a two-team match, with no real player names.

#### P6.2 Operator documentation and live validation (XS)

- **Blocked by:** P5.3
- **Spec:** §9, §16.3
- **Files:** `applications/match-to-csv/README.md`, `docs/self-hosting/50-deploy-and-release-applications.md`
- **Provides:** the replay, comparison, materialization and validation procedures
- **Acceptance:**
  - The README documents the evidence layout, replay input, comparison and materializer inputs.
  - The self-hosting guide lists the success and failure checks in §16.3.

### Phase 7: Release

**Goal:** v1 ships to prod.
**Exit criteria:** every §17 criterion passes.

#### P7.1 Production release (XS)

- **Blocked by:** P4.4, P5.1, P5.2, P5.3, P6.1, P6.2
- **Spec:** §13.6, §17
- **Files:** none beyond release metadata
- **Provides:** a released, deployed v1
- **Acceptance:**
  - The §17 criteria pass in dev, a reviewer approves prod, and the post-deploy checks pass.

### Phase 8: Backlog (not filed with v1)

| ID | Slice | Size | Note |
| --- | --- | --- | --- |
| P8.1 | Cluster only player-row colours | S | Done. §8.4 clusters only player-row colours. |
| P8.2 | Read placement instead of trusting row order | M | §18 item 2. Needs a labeled corpus first. |
| P8.3 | Calibrate colour naming against labeled screenshots | S | §18 item 3. Thresholds become data, with a fixture per MCC colour. |
| P8.4 | Merge split scoreboard tables | M | §18 item 4. Replay recovers older screenshots. |
| P8.5 | Classify `PHOTO` acquisitions and record EXIF orientation | S | §18 item 5. Records the tag as metadata; still no preprocessing. |
| P8.6 | Required-column awareness for `EMPTY_REQUIRED_CELL` | XS | §18 item 11. Bumps `validationRulesVersion`. |
| P8.7 | Alarm on the dead-letter queue and failed executions | S | Today an operator must look. |
