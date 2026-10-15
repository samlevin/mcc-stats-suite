# OCR Quality: Technical Specification

**Status:** Draft; not implemented

**Version:** 2.0-draft (rewrites the original OCR quality specification on the specification template; see §1)

**Date:** October 15, 2026

**Component:** `applications/ocr-quality`, with shared result types in `packages/contracts` and one change to `infrastructure/modules/foundation`

**Runtime:** TypeScript, Node.js 22 on AWS Lambda (ARM64), orchestrated by one AWS Step Functions Standard workflow

**Deployment:** one AWS CDK stack per stable environment (`dev`, `prod`) from GitHub Actions, plus ephemeral developer stacks in the dev account, through the same guarded wrapper as match-to-csv

**Input:** the `normalized-ocr/v2` evidence that match-to-csv writes for every successful processing run ([spec 1](1-mcc-analytics-engine.md) §5, §7.2)

**Persistent state:** quality evidence under each processing run in the OpenTofu-owned evidence bucket; from Phase 4, a rebuildable DynamoDB baseline cache owned by the application stack

**External dependencies at runtime:** S3, EventBridge, Step Functions, Lambda, KMS, SSM Parameter Store, SQS; DynamoDB from Phase 4

**Out of scope:** correcting OCR text, human review and correction capture (spec 3), any API or user interface, training or serving a risk model (a later specification), match records, the stats lakehouse

Match-to-csv records every OCR cell with its text, confidence, geometry and semantic field, and flags a few obvious problems. This component reads each successful run, scores every cell of every scoreboard table for how likely it is to be wrong, and records a feature row for every cell. Today spec 3's reviewers confirm every cell, and the scores tell them where to look hardest. The feature rows, joined with those confirmations, are the training data for a later risk model that decides which cells need review at all (§9.6).

**Changes in 2.0-draft:** the original text predates match-to-csv. It defined its own bucket, OCR manifest, identifiers, tenant model, normalized table contract and a `OcrRuns` DynamoDB table, and it included a human correction workflow with its own API. This revision consumes match-to-csv evidence as built, writes results beside the run they score, drops the correction workflow in favor of spec 3, replaces seven Lambdas and a run table with one scoring Lambda behind conditional S3 writes, limits Halo rules to fields match-to-csv extracts, and moves cross-run baselines to a later phase that waits for spec 3's verified labels. It also records a versioned feature row for every cell at scoring time and reserves the result fields a risk model will fill, so labels collected from the first review are usable for training. §1 records each decision.

**Readiness:** this revision authorizes filing Phases 0 to 3. Phase 4 waits until spec 3 writes adjudications. Contracts in §5.3 and §10.1 freeze when P0.2 merges.

---

## 1. Resolved requirement decisions

| Original requirement | Decision | Reason |
| --- | --- | --- |
| Own bucket `ocr-quality-{account}-{region}-{environment}` with `runs/yyyy/mm/dd/{run_id}/` | No bucket. Results are written under the scored run's prefix in the existing evidence bucket (§5.1). | The evidence already lives there, under Object Lock and the foundation key. A second bucket duplicates screenshots and provider output. |
| OCR writes `manifest.json` last to signal completion; workflow triggers on it | Trigger on match-to-csv's run `completion.json` and score only `SUCCEEDED` runs (§4.1). | Match-to-csv writes its manifest when a run starts. Its completion is the only marker of a finished run (spec 1 §18.6). |
| Inputs `raw-output.json`, `table-structure.json`, `extracted.csv` | Read `normalized/observations.json` (`normalized-ocr/v2`) only. Its `parser.rows` holds the CSV rows. | `normalized-ocr/v2` already carries cells with confidence, geometry and semantic location. `extracted-table/v1` and `extracted.csv` are written after the run completion, so they may not exist when scoring starts. |
| Scorer reads only OCR artifacts | `ScoreRun` also reads `source/metadata.json`, the submission `ingestion.json`, the run `completion.json` and `textract/raw-response.json`, for image, submission and provider-model fields (§8.4). | Textract changes its model without notice, and `AnalyzeDocumentModelVersion` in the raw response is the only record of which model read a run. Image hash, format and submission timing belong in every feature row from the first run. |
| Parser decisions are visible only as CSV rows | P0.3 adds parser provenance to `normalized-ocr/v2`: the selected table, the field each column was exported under, and the table row of each exported row. | Features, spec 3 labels and lakehouse values must describe a cell the same way. Without provenance, a column the parser exports by position fallback is `UNKNOWN` in the normalized cell but kills or deaths in the CSV. |
| Three shapes of training example: spec 1 `ocr-cell-example/v1`, the current spec 3 labeled export, and these feature rows | Labeled training data come only from the dataset builder rules in §8.5. Spec 1's materializer stays for unlabeled exports until the risk model's builder exists, then is retired (P5.8). Spec 3 does not define its own labeled export. | One labeled dataset definition, so datasets cannot diverge. |
| Canonical normalized table contract and `NormalizeTables` stage | Removed. Rules and statistics read `normalized-ocr/v2` cells directly. | Re-normalizing a normalized artifact adds a contract and a stage with nothing to do. |
| Run, table and cell IDs as UUIDv7 or ULID, cells as `r{row}_c{col}` | Use match-to-csv identifiers: `evidenceId()` for new IDs and `cellObservationId` / `tableObservationId` for observations. | Results must join to evidence and to spec 3 adjudications without a mapping table. |
| OCR confidence from 0 to 1 with a 0.70 threshold | Textract confidence from 0 to 100, as stored. | The stored value is the provider value. |
| `tenant_id` on records, keys and API calls | Removed. | The system has no tenants. |
| Step 1: `CorrectionEvents`, correction and verification API, reviewed materialization, comparison UI | Removed. Spec 3 owns review and correction. This component reads spec 3 adjudications only to build baselines (§8.3). | Two designs for the same reviewer decisions with different vocabularies would split the labels. Spec 3 already defines the immutable adjudication and its projection. |
| Standard workflow with seven Lambdas, a `Parallel` state and SDK integrations for DynamoDB and EventBridge | One Standard workflow with one `ScoreRun` task (§6.1). Profiling, rules, anomalies and scoring are pure library functions inside it. | Each run scores one table of about 50 cells in milliseconds. Separate states add IAM roles, payload plumbing and failure paths without isolating anything. |
| `OcrRuns` table with `ClaimRun`, ownership checks and status updates | Removed. A create-only claim object per run and quality version gives idempotency (§5.2). Status lives in the quality run's `outcome.json`. | S3 conditional writes already enforce write-once evidence. A second store for status can disagree with the evidence. |
| `quality/v1/` output prefix keyed by version | Each scoring creates a quality run with its own `qualityRunId` (§5.1). | A re-score under the same version would otherwise overwrite or collide. |
| Generic type inference across `INTEGER`, `CURRENCY`, `DATE` and others | Removed. Types come from `semanticLocation.field`: `PLAYER` is a name, the other mapped fields are integers. | Match-to-csv already maps the five fields it extracts. Inference from eight values is unreliable. |
| Rules `C001_REQUIRED_EMPTY`, `C002_TYPE_PARSE_FAILURE`, `C005_LOW_OCR_CONFIDENCE` | Import match-to-csv's validation flags as signals (§7.1) instead of re-evaluating them. | One definition per check. A change to match-to-csv validation changes its `validationRulesVersion`, which every quality result records. |
| Halo rules for team totals, placement, medals and ratios; template-specific schemas | Only rules over extracted fields (§7.3). No template IDs. Tables classified `UNKNOWN` are not assessed (§7.4). | Match-to-csv extracts player, score, kills, assists and deaths, and classifies tables only as `SCOREBOARD` or `UNKNOWN`. |
| `ColumnBaselines` table updated with mergeable statistics | Phase 4: rebuild immutable baseline snapshots from spec 3 labels, load them into a DynamoDB cache behind a `BaselineSource` port, and record `baselineVersion` in every result (§8.3). | Incremental merges depend on update order and cannot be rebuilt exactly. A snapshot can be rebuilt and replaced by another source later. |
| Configuration as versioned JSON in S3 | Versioned JSON bundled with the Lambda (§13.1). | The configuration changes only with a deploy, and the bundled file is reviewed with the code. |
| "Later ML compatibility": a later model trains on verified examples and calibrates `P(correct)` | Every scoring writes one feature row per cell, for every table, with a `featureSchemaVersion` (§8.4). Label-derived values never become features. The result reserves `riskModel` fields that stay empty until a model exists (§9.6). | A model trained on features recomputed later by newer code does not match what production scored. Recording features at scoring time keeps training and serving identical, and labels collected before any model exists stay usable. |
| Heuristic score routes cells to review | The heuristic never decides what is reviewed. Spec 3 confirms every cell until a risk model passes its gate (§9.6). | Reviewing every cell gives labels for every cell, so the first model is trained and evaluated without the selection bias of reviewing only flagged cells. |
| Completion and failure events on EventBridge | Not in v1. Consumers read `outcome.json` (backlog P5.2). | No consumer exists yet. |
| Retention moves screenshots and OCR output to Intelligent-Tiering after 30 days | Removed. Retention is the foundation's concern. | The evidence bucket is under Object Lock and its lifecycle belongs to OpenTofu. |
| AWS CDK in Python with `infra/` and `services/` | TypeScript in the `applications/ocr-quality` workspace (§12). | The repository is a TypeScript monorepo. |
| `snake_case` JSON fields | `camelCase`, as in every other evidence document. | One convention across evidence. |

**Additional capabilities included:** a re-score entry point that creates a new quality run beside earlier ones, and run-level signals for runs with no scoreboard table or more than one.

## 2. Goals and non-goals

### 2.1 Goals

1. Score every successful match-to-csv run within one minute of its completion, with no operator action.
2. Give every cell in a scoreboard table a `suspicionScore`, a `reviewPriority` and the structured signals behind them, and summarize them per row, table and run.
3. Write results as immutable evidence beside the run, so any score can be traced to its input hash, code commit and stage versions.
4. Re-score a run under new rules or configuration without changing earlier results.
5. Keep the scoring contract stable when cross-run baselines and, later, a risk model are added.
6. Record, for every cell of every successful run, the features a risk model needs, exactly as they were at scoring time, so the model can be trained and evaluated on every label spec 3 collects.

### 2.2 Non-goals

- Training, evaluating or serving a risk model, and deciding which cells skip review. A later specification owns those (§9.6).
- Changing OCR text. Scores flag values; they never edit them.
- Review, correction, verification or labeling of cells. Spec 3 owns those.
- Any API or user interface. Spec 3 and later admin features read `result.json`.
- Calibrated probabilities. `suspicionScore` is a heuristic and is never presented as `P(correct)`.
- Assessing tables classified `UNKNOWN`, or fields match-to-csv does not extract.
- Writing to the stats lakehouse. Feature rows, scores and training data stay in the evidence bucket; the lakehouse ingests only spec 3's validated tables.
- Exactly-once scoring. Duplicate match-to-csv runs are each scored, and a re-score is always a new quality run.

## 3. Runtime architecture

```text
match-to-csv extract-text
  |  writes runs/{runId}/completion.json (create-only)
  v
Evidence bucket (EventBridge notifications, enabled by P1.1)
  |
  v
EventBridge rule: Object Created, key matches the run completion pattern (§4.1)  --(failed delivery)--> SQS DLQ
  |
  v
Step Functions Standard workflow <stack>
  |
  +-- Score run   (ScoreRun Lambda)
        read completion, manifest and normalized observations
        claim the run for the quality version (create-only)
        profile -> rules -> anomalies -> score   (pure libraries)
        write quality manifest, profiles, signals, feature rows, result, outcome
  |
  v
Evidence bucket: runs/{runId}/quality/{qualityRunId}/

Phase 4:
BuildBaselines Lambda (operator-invoked)
  read spec 3 adjudications and normalized cells -> write baseline snapshot -> load BaselineCache table
ScoreRun reads the current baseline through BaselineSource
```

**Ownership rules:** `score-run` owns claims and everything under `quality/{qualityRunId}/`. `build-baselines` owns `baselines/` and the `BaselineCache` table. Neither writes anything match-to-csv or spec 3 owns. `profiles`, `rules`, `anomalies` and `scoring` are pure and perform no I/O. Only Lambda entry points construct AWS SDK clients; each core function receives an injected dependencies object.

**Packaging:** the `@mcc/ocr-quality` workspace with Lambda sources under `src/lambdas/`, pure libraries under `src/lib/`, bundled configuration under `config/` and the CDK app under `cdk/`. The read-side types for `normalized-ocr/v2` and the quality result types live in `@mcc/contracts`, because spec 3 reads both.

**Orchestration decision:** one Step Functions task is kept, rather than an EventBridge target that invokes the Lambda directly, for declared retries, execution history, redrive, and one operator entry point (`mode: RESCORE`) with the same retry policy as automatic scoring. A second task is justified only when one stage needs different retries or concurrency than the others, such as a provider call.

### 3.1 Execution policy

- One run completion object is one execution and at most one quality run per attempt.
- Only runs whose completion has `status: SUCCEEDED` are scored. Failed runs and runs with no completion are never scored.
- In `AUTOMATIC` mode, a run is scored once per `qualityVersion`. A second execution for the same run and version finds the claim and succeeds without writing (§5.2).
- In `RESCORE` mode, the claim is skipped and a new quality run is always written.
- Every write uses `If-None-Match: *`. Each attempt writes under a new `qualityRunId`, so a retry never collides with a failed attempt's partial output.
- The workflow never deletes, moves or rewrites evidence, and never reads or writes outside its namespace (`ephemeral/<name>/` for ephemeral stacks).

## 4. Trigger and operator interface

### 4.1 Trigger

The stack's EventBridge rule matches `aws.s3` `Object Created` events from the evidence bucket whose key matches:

| Deployment | Key pattern (EventBridge `wildcard`) |
| --- | --- |
| Stable `dev` or `prod` | `submissions/*/screenshots/*/runs/*/completion.json` |
| Ephemeral `<name>` | `ephemeral/<name>/submissions/*/screenshots/*/runs/*/completion.json` |

The rule starts the workflow with `{ "runCompletion": { "bucket": <bucket>, "key": <key> }, "mode": "AUTOMATIC" }`. EventBridge retries delivery up to three times within two hours, then sends the event to `<stack>-events-dlq` (SQS-managed encryption, 14-day retention).

The wildcard also matches deeper keys, so `ScoreRun` re-checks the key against `^(ephemeral/[a-z0-9][a-z0-9-]{0,19}/)?submissions/[^/]+/screenshots/[^/]+/runs/[^/]+/completion\.json$` and against its own namespace, and fails with `InvalidRunCompletionKeyError` otherwise. This component never writes an object named `completion.json`, so its own output cannot start it.

An ephemeral ocr-quality stack scores only runs from the ephemeral match-to-csv stack of the same name.

### 4.2 Operator re-score

An operator starts the same workflow with `mode: "RESCORE"` and the key of a run's `completion.json`. The execution skips the claim and writes a new quality run with `trigger.mode: RESCORE`. Starting `AUTOMATIC` executions for a list of completions is the backfill path after a `qualityVersion` change, and stays idempotent.

### 4.3 Input validation and skips

| Condition | Result | Writes |
| --- | --- | --- |
| Key fails the pattern or namespace check | `InvalidRunCompletionKeyError`; execution fails | nothing |
| Completion `schemaVersion` is not `processing-run-completion/v1` | `UnsupportedSchemaError`; execution fails | nothing |
| Completion `status` is not `SUCCEEDED` | succeeds with `skipped: SOURCE_RUN_NOT_SUCCEEDED` | nothing |
| `AUTOMATIC` and a claim by another execution exists | succeeds with `skipped: ALREADY_CLAIMED` | nothing |
| `normalized/observations.json` missing or not `normalized-ocr/v2` | `MissingArtifactError` or `UnsupportedSchemaError`; execution fails | claim, quality `manifest.json`, `FAILED` outcome |

## 5. Quality evidence

### 5.1 Layout

```text
[ephemeral/<name>/]submissions/{submissionId}/screenshots/{screenshotId}/runs/{runId}/
  quality/
    claims/{qualityVersion}.json
    {qualityRunId}/
      manifest.json
      profiles.json
      signals.json
      features.jsonl
      row-features.jsonl
      table-features.jsonl
      result.json
      outcome.json
[ephemeral/<name>/]baselines/{baselineVersion}/       (Phase 4)
  manifest.json
  members.jsonl
  snapshot.json
```

`qualityRunId` and `baselineVersion` are `evidenceId()` values (spec 1 §5.1), so the latest quality run of a run sorts last.

### 5.2 Rules

1. Quality evidence is immutable. Every object is written once with `If-None-Match: *`.
2. The claim is written before any analysis. In `AUTOMATIC` mode a 412 on the claim reads the existing claim. When its `executionArn` equals the current execution (a Lambda retry or a redrive), scoring continues. Otherwise the execution succeeds as a no-op.
3. Every attempt creates a new `qualityRunId` and writes `manifest.json` first. On any error after that, it writes a `FAILED` `outcome.json` with the error name and message, then rethrows. A failure to record the failure is logged at `ERROR` and does not mask the original error.
4. `outcome.json` is written last. A quality run without a `SUCCEEDED` outcome is incomplete, and consumers ignore it.
5. The latest quality result of a run is the `SUCCEEDED` quality run with the greatest `qualityRunId`.
6. Every quality run records the input artifact's SHA-256, the source run's stage versions, the deployed commit and every quality stage version (§5.4).
7. Signals flag values; they never change `observedText`.

### 5.3 Document schemas

| Object | `schemaVersion` | Writer | Contents |
| --- | --- | --- | --- |
| `claims/{qualityVersion}.json` | `quality-claim/v1` | `score-run` | `runId`, `qualityVersion`, `executionArn`, `claimedAt` |
| `manifest.json` | `quality-run/v1` | `score-run` | `qualityRunId`, `runId`, `screenshotId`, `trigger` (`mode`, `executionArn`), `input` (completion, run manifest and normalized references, normalized SHA-256), `sourceVersions` (the run manifest's `versions`), `versions` (§5.4), `build` (`gitSha`, `environment`), `startedAt` |
| `profiles.json` | `quality-profiles/v1` | `score-run` | one `FieldProfile` per assessed table and mapped field (§8.1) |
| `signals.json` | `quality-signals/v1` | `score-run` | every signal before scoring, grouped by run, table and cell |
| `features.jsonl` | `cell-feature-row/v1` on every line | `score-run` | one `CellFeatureRow` per cell of every table, assessed or not (§8.4) |
| `row-features.jsonl` | `row-feature-row/v1` on every line | `score-run` | one `RowFeatureRow` per row of every table (§8.4) |
| `table-features.jsonl` | `table-feature-row/v1` on every line | `score-run` | one `TableFeatureRow` per table (§8.4) |
| `result.json` | `quality-result/v1` | `score-run` | `QualityResult` (§10.1) |
| `outcome.json` | `quality-run-outcome/v1` | `score-run` | `status` (`SUCCEEDED` or `FAILED`), `completedAt`; on success `result` reference and `summary`; on failure `error` |
| baseline `manifest.json` | `baseline-build/v1` | `build-baselines` | `baselineVersion`, `builderVersion`, `builtAt`, `labelCutoff`, `adjudicationCount`, `memberScreenshotCount`, `adjudicationSetSha256`, `membersSha256`, `build` |
| baseline `members.jsonl` | `baseline-member/v1` on every line | `build-baselines` | `screenshotId`, `imageSha256`, `submissionId`, `runId`, `adjudicationCount` for every run that contributed a value |
| baseline `snapshot.json` | `baseline-snapshot/v1` | `build-baselines` | one `FieldBaseline` per field (§8.3) |

### 5.4 Stage versions

`qualityVersion` names the combination below. Any change to a stage's behavior bumps that stage's version and `qualityVersion` in the same delivery.

| Key | v1 value |
| --- | --- |
| `qualityVersion` | `quality-v1` |
| `profileVersion` | `field-profile-v1` |
| `rulesetVersion` | `quality-rules-v1` |
| `anomalyVersion` | `within-table-anomaly-v1` |
| `scoringVersion` | `noisy-or-v1` |
| `configVersion` | `quality-config-v1` |
| `featureSchemaVersion` | `features-v1` |
| `baselineVersion` | `none` until Phase 4; then the snapshot's version |

`baselineVersion` is recorded per quality run but is not part of `qualityVersion`, so a new snapshot does not re-score old runs automatically.

## 6. Scoring workflow

### 6.1 Main workflow

`<stack>` is a Standard state machine with a 5-minute timeout, X-Ray tracing and `ALL`-level logging with execution data. Its payloads hold only S3 references, modes and counts.

1. **Score run** invokes `ScoreRun` with the execution input plus `executionArn` from `$$.Execution.Id`, and ends with its output (`ScoreRunOutput`).

### 6.2 `ScoreRun` steps

`scoreRun(input, dependencies)`:

1. Validate the key (§4.1). Read `completion.json`. Return a skip when it is not `SUCCEEDED` (§4.3).
2. In `AUTOMATIC` mode, write the claim, or resolve an existing one (§5.2).
3. Create a `qualityRunId`. Read the run `manifest.json`, `normalized/observations.json`, `textract/raw-response.json`, the screenshot's `source/metadata.json` and the submission's `ingestion.json`. Hash the normalized bytes, and write the quality `manifest.json`.
4. Load the current baseline through `BaselineSource` (`none` before Phase 4).
5. Build field profiles (§8.1), evaluate rules (§7) and anomalies (§8.2, §8.3), and combine signals (§9). Build cell, row and table feature rows for every table (§8.4). Write `profiles.json`, `signals.json`, the three feature files and `result.json`.
6. Write a `SUCCEEDED` `outcome.json`, log `Run scored` with counts and priority, and return `ScoreRunOutput`.

### 6.3 Retries and failure

The task disables the default service-exception retry and declares one policy: an initial interval of 2 seconds, a backoff rate of 2 and at most 3 attempts, for `Lambda.ClientExecutionTimeoutException`, `Lambda.ServiceException`, `Lambda.AWSLambdaException`, `Lambda.SdkClientException`, `Lambda.TooManyRequestsException`, `InternalError`, `SlowDown` and `ServiceUnavailable`. `InvalidRunCompletionKeyError`, `UnsupportedSchemaError`, `MissingArtifactError` and `InvalidQualityConfigError` are not retried. A retried attempt reuses the claim and writes a new `qualityRunId`; the failed attempt's `FAILED` outcome stays.

## 7. Rules

Rules run only on assessed tables (§7.4), except run-level rules. Each produces `QualitySignal` records (§10.1) with a stable `id`, a `group` for scoring (§9.2), a `severity`, a `messageCode` and structured `evidence`. Severities are defaults from `config/quality-config-v1.json`.

### 7.1 Imported match-to-csv validation

Each cell's `validation.flags` (spec 1 §7.3) becomes a signal with `source: VALIDATION`:

| Flag | Imported when | Severity | Group |
| --- | --- | --- | --- |
| `EMPTY_REQUIRED_CELL` | `DATA` row and a mapped field (`PLAYER`, `SCORE`, `KILLS`, `ASSISTS`, `DEATHS`) | `HIGH` | `EMPTY` |
| `LOW_TEXTRACT_CONFIDENCE` | always | `MEDIUM` when `actual` is below `confidenceMediumBelow` (80), otherwise `LOW` | `OCR_CONFIDENCE` |
| `INVALID_INTEGER` | always | `HIGH` | `TYPE_PARSE` |

Empty cells in header rows and unmapped columns are ignored, which removes the noise in spec 1 §18.11. `LOW_TEXTRACT_CONFIDENCE` uses the `CELL` block's confidence, which describes table structure. Textract reports text-recognition confidence on `WORD` tokens, so `C004` (§7.2) adds a word-based check.

### 7.2 Structural and content rules

| ID | Scope | Condition | Severity | Group |
| --- | --- | --- | --- | --- |
| `R001_NO_SCOREBOARD_TABLE` | run | no table is classified `SCOREBOARD` | `HIGH` | `STRUCTURE` |
| `R002_MULTIPLE_SCOREBOARD_TABLES` | run | more than one table is `SCOREBOARD`; only one became CSV (spec 1 §18.4) | `MEDIUM` | `STRUCTURE` |
| `T001_DUPLICATE_CELL_LOCATION` | table, cells | two cells share table, row and column index | `CRITICAL` | `STRUCTURE` |
| `T002_MISSING_FIELD` | table | a `SCOREBOARD` table maps no header to one of `SCORE`, `KILLS`, `ASSISTS`, `DEATHS`, so the parser fell back to column order | `HIGH` | `STRUCTURE` |
| `T003_CELL_OUTSIDE_TABLE` | cell | the cell's bounding box extends beyond its table's by more than `geometryTolerance` (0.01) | `MEDIUM` | `GEOMETRY` |
| `C001_SUSPICIOUS_GLYPH` | cell | a `DATA` cell in an integer field fails `INVALID_INTEGER` and becomes all digits after the substitutions `O o Q D -> 0`, `I l i \| ! -> 1`, `Z z -> 2`, `S s $ -> 5`, `G b -> 6`, `T -> 7`, `B -> 8`, `g q -> 9`; evidence holds the candidate value | `MEDIUM` | `TYPE_PARSE` |
| `C002_DIGIT_LIMIT` | cell | an integer field has more digits than `maxDigits` (`SCORE` 6, `KILLS` 3, `ASSISTS` 3, `DEATHS` 3) | `HIGH` | `LENGTH` |
| `C003_PLAYER_NAME_CHARACTERS` | cell | after removing one leading `[tag]` and collapsing whitespace, a `PLAYER` cell does not match `playerNamePattern` (`^[A-Za-z0-9 ]{1,16}(#[0-9]{1,4})?$`) | `LOW` | `CHARACTER_COMPOSITION` |
| `C004_LOW_WORD_CONFIDENCE` | cell | the lowest `WORD` confidence in the cell is below `wordConfidenceLowBelow` (90); `MEDIUM` below `confidenceMediumBelow` (80) | `LOW` | `OCR_CONFIDENCE` |

`C001` and `INVALID_INTEGER` share a group, so the glyph signal adds a candidate value without raising the score above the parse failure (§9.2).

### 7.3 Halo rules

These use only fields match-to-csv extracts. They live in `src/lib/rules/halo.ts`, apart from the generic rules.

| ID | Scope | Condition | Severity | Group |
| --- | --- | --- | --- | --- |
| `H001_DUPLICATE_PLAYER` | cells | two `DATA` rows of one table have the same player name after tag removal, whitespace collapse and case folding | `HIGH` | `IDENTITY` |
| `H002_ROSTER_SIZE` | table | a table has more `DATA` rows with a non-empty player than `maxRosterSize` (16) | `HIGH` | `STRUCTURE` |

Team totals, placement, medals and derived ratios need fields match-to-csv does not extract (backlog P5.4).

### 7.4 Unknown layouts

A table classified `UNKNOWN` is not assessed: it gets `assessed: false`, no cell entries, no signals and `reviewPriority: NONE` in `result.json`. Its cells still get feature rows (§8.4), because every label needs features and spec 3 reviewers can label any cell. Every cell of an unassessed table needs a review decision when the table is the parser's selected table or a reviewer marks it as a scoreboard ([spec 3](3-cell-labeling.md) §7.1). Its presence is still counted in the run summary (`unassessedTableCount`), and `R001` flags a run with no assessed table.

## 8. Profiles, anomalies and baselines

### 8.1 Field profiles

For each assessed table and each mapped field, `profileTable` computes over `DATA` cells: `cellCount`, `nonEmptyCount`, `parseSuccessCount`, and for integer fields `values` statistics (`count`, `median`, `mad`, `min`, `max`) over parsed integers, plus digit-length `median` and `mad`. `mad` is the median absolute deviation. Profiles are deterministic for identical input and are written to `profiles.json`.

### 8.2 Within-table anomalies

Within-table statistics on about eight rows are weak, so in v1 every within-table anomaly is capped at `withinTableMaxSeverity` (`LOW`). Signals have `source: ANOMALY`.

| ID | Condition | Group |
| --- | --- | --- |
| `A001_NUMERIC_ROBUST_Z` | integer field with at least `minSampleSize` (5) parsed values and `mad > 0`; `abs(0.6745 * (value - median) / mad) >= robustZThreshold` (4.0). With `mad = 0` the check does not fire, and the profile records `madZero: true`. | `NUMERIC_DISTRIBUTION` |
| `A002_DIGIT_LENGTH` | integer field with at least 5 parsed values; the value's digit count differs from the field's median digit count by 2 or more | `LENGTH` |
| `A003_ROW_ALIGNMENT` | the cell's vertical centre differs from its row's median centre by more than half the row's median cell height | `GEOMETRY` |
| `A004_COLUMN_ALIGNMENT` | the cell's horizontal centre differs from its column's median centre by more than half the column's median cell width | `GEOMETRY` |

### 8.3 Cross-run baselines (Phase 4)

Baselines compare a value with every verified value of the same field, which is where most of the anomaly signal is at this table size. They need spec 3's labels, so they start after spec 3 writes adjudications.

**Source of truth.** Spec 3 `cell-adjudication/v1` objects under each run's `adjudications/` prefix, resolved with spec 3's supersession rules. A cell counts when its current decision is `ACCEPTED` (value: `observedTextAtReview`) or `CORRECTED` (value: `submittedValue`), it is a `DATA` cell of a `SCOREBOARD` table, and its field is mapped. `UNREADABLE` and `SKIPPED` cells are excluded.

**Build.** `BuildBaselines` is invoked by an operator. It lists adjudications under the namespace, resolves them, reads the matching cells from each run's normalized observations, computes one `FieldBaseline` per field, writes `members.jsonl`, `snapshot.json` and then `manifest.json` under a new `baselineVersion`, loads the snapshot and its membership into the `BaselineCache` table, and finally moves the table's `CURRENT` pointer with a conditional write. `members.jsonl` lists the `screenshotId`, `imageSha256`, `submissionId` and `runId` of every run that contributed a value, and the manifest records `labelCutoff`, the latest `reviewedAt` among the adjudications used. Membership is by screenshot and by image hash, so a reviewed sibling run of the same screenshot, or the same image emailed again under another screenshot ID, makes the scored image a member. A field with fewer than `minBaselineObservations` (200) values gets `usable: false`. `adjudicationSetSha256` is the SHA-256 of the UTF-8 adjudication object keys, sorted bytewise and joined with `\n`, so two builds over the same labels are recognizable. Spec 3's validated-table lineage hash uses the same definition, so a baseline and a validated table built from the same labels carry the same value.

**Read.** `ScoreRun` asks the `BaselineSource` port once per execution for the baseline to use for the run's screenshot: the newest snapshot whose members include neither that `screenshotId` nor its `imageSha256`. A baseline therefore never contains a label of the screenshot being scored, whether scoring happens before review, after review through `RESCORE` or a backfill, or after a sibling run was reviewed. `DynamoBaselineSource` reads the snapshot versions newest first and the `MEMBER` items for the screenshot ID and the image hash, and picks the first version that is not among them. `NoBaselineSource` returns `none`, as does a source with no qualifying snapshot. The quality manifest, result and every feature row record the `baselineVersion` used and its `labelCutoff`.

| ID | Condition | Severity | Group |
| --- | --- | --- | --- |
| `B001_FIELD_RANGE` | integer value outside the field's baseline `[p005, p995]` | `MEDIUM` | `NUMERIC_DISTRIBUTION` |
| `B002_FIELD_DIGITS` | digit count outside the baseline's observed digit-length range | `MEDIUM` | `LENGTH` |

**Migration.** The S3 snapshots are the record and the table is a cache: deleting the table and rebuilding from the latest snapshot loses nothing. Moving baselines to the data platform means adding a `BaselineSource` implementation that reads there and producing snapshots from it. Scoring code, signal IDs and the result contract do not change, and old results stay reproducible because each names its `baselineVersion`.

### 8.4 Feature rows

Every quality run writes three feature files, one flat JSON line per unit, in table, row and cell order: `features.jsonl` with one `cell-feature-row/v1` line per cell of every table, `row-features.jsonl` with one `row-feature-row/v1` line per table row, and `table-features.jsonl` with one `table-feature-row/v1` line per table. Every table is included, assessed or not. A line is the complete model input for that unit as it was at scoring time. Training selects rows by `(qualityRunId, <unit key>)` under §8.5; it never recomputes features with newer code. Values that do not apply are `null`, never omitted. All three files share one `featureSchemaVersion` (`features-v1`).

**Sources.** Image and submission fields come from the run `manifest.json` (`inputArtifact`, the `SourceScreenshot`), `source/metadata.json` and the submission `ingestion.json`. `textractModelVersion` comes from `AnalyzeDocumentModelVersion` in `textract/raw-response.json`, which the normalizer does not keep, and `textractRequestId` from the run `completion.json`. Parser fields come from the `parser` section of `normalized/observations.json`, including the provenance P0.3 adds; for runs written before P0.3 they are `null`. Everything else comes from the normalized cells, tables and tokens.

**Cell rows (`features.jsonl`).**

| Group | Fields |
| --- | --- |
| Identity and lineage | `schemaVersion`, `featureSchemaVersion`, `cellObservationId`, `tableObservationId`, `runId`, `screenshotId`, `submissionId`, `qualityRunId`, `qualityVersion`, `imageSha256`, `textractModelVersion`, `textractRequestId`, `textractNormalizerVersion`, `tableParserVersion`, `validationRulesVersion`, `receivedAt`, `runStartedAt` |
| Image | `imageWidthPx`, `imageHeightPx`, `imageAspectRatio`, `imageFormat`, `fileSizeBytes`, `acquisitionType`, `contentType` |
| Table | `tableIndex`, `tableClassification`, `tableConfidence`, `tableRowCount`, `tableColumnCount`, `tableLeft`, `tableTop`, `tableWidth`, `tableHeight`, `scoreboardTableCount`, `mappedFieldCount`, `selectedByParser` |
| Position | `semanticField` (from the header), `exportedField` (the field the parser exported the column under, including its column-order fallback; `null` when the table is not the parser's selected table), `headerText`, `rowRole`, `rowIndex`, `columnIndex`, `rowSpan`, `columnSpan`, `relativeRowPosition` (row index over row count) |
| OCR | `cellConfidence` (the `CELL` block), `wordCount`, `wordConfidenceMin`, `wordConfidenceMean`, `wordConfidenceMax` (from `WORD` tokens), `printedWordFraction` (share of words with `TextType` `PRINTED`), `entityTypes`, `neighborConfidenceAbove`, `neighborConfidenceBelow`, `neighborConfidenceLeft`, `neighborConfidenceRight` |
| Text | `observedText`, `textLength`, `digitCount`, `letterCount`, `upperCount`, `spaceCount`, `otherCount`, `isEmpty`, `parseSucceeded`, `integerValue`, `glyphCandidate`, `glyphSubstitutionCount` |
| Geometry | `bboxLeft`, `bboxTop`, `bboxWidth`, `bboxHeight`, `cellHeightPx`, `skewDegrees` (angle of the polygon's top edge), `rowCenterOffset` and `columnCenterOffset` (in units of the median cell height and width), `outsideTableDistance` |
| Row context | `rowColorR`, `rowColorG`, `rowColorB`, `rowLuminance`, `rowColorDistanceToTeamMean` (RGB distance to the mean colour of rows the parser put on the same team; `null` in free-for-all), `parserKeptRow`, `parserTeam` |
| Statistics | `fieldMedian`, `fieldMad`, `fieldCount`, `robustZ`, `digitLengthDeviation`, `rowEmptyCellCount`, `rowSignalCount`, `rowPlayerDuplicate`, `rosterSize` |
| Validation and rules | `flagEmptyRequiredCell`, `flagLowTextractConfidence`, `flagInvalidInteger`, `signalIds` (sorted), `heuristicSuspicionScore`, `heuristicReviewPriority` |
| Baseline | `baselineVersion`, `baselineLabelCutoff`, `baselineP005`, `baselineP995`, `baselineDistance`, `baselineUsable` (all `null` before Phase 4) |

**Row rows (`row-features.jsonl`).** Keyed by `tableObservationId` and `rowIndex`, with the identity and lineage fields of a cell row except the cell ID, plus: `rowRole`, `cellCount`, `emptyCellCount`, `mappedEmptyCellCount`, `meanCellConfidence`, `minWordConfidence`, `signalCount`, `maxCellSuspicion`, `rowColorR`, `rowColorG`, `rowColorB`, `rowLuminance`, `rowColorDistanceToTeamMean`, `parserKeptRow`, `parserTeam`, `parserWin`, `parserLoss`, `playerText`, `rowPlayerDuplicate`, `rowTop`, `rowHeight`, `gapAbove` and `gapBelow` (in median row heights), `isFirstDataRow`, `isLastRow`. These are the inputs for row labels in spec 3: missing, extra, wrong team and wrong win or loss.

**Table rows (`table-features.jsonl`).** Keyed by `tableObservationId`, with the identity, lineage and image fields, plus: `tableIndex`, `classification`, `tableConfidence`, table bounding box, `rowCount`, `columnCount`, `mappedFieldCount`, `headerTexts`, `selectedByParser`, `parserTableScore` (the spec 1 §8.1 score), `parserRowCount`, `droppedDataRowCount`, `teamCount`, `isFreeForAll`, `rowGapMedian`, `rowGapMax`, `scoreboardTableCount`, `tableSignalIds`. These are the inputs for table labels in spec 3: wrong table and wrong column mapping.

Rules for the feature rows:

1. **No leakage.** No feature comes from a spec 3 adjudication, a resolution, reviewer behavior, a later run of the same screenshot, or anything written after the quality run started. Parser outputs are features, not labels: they are what the reviewer checks. Labels are joined at training time only.
2. **Baselines exclude the target screenshot.** A baseline feature comes from the newest snapshot that has no member from the scored screenshot (§8.3), never from the current snapshot unconditionally. The snapshot's `members.jsonl` is the evidence a training job uses to verify this.
3. **Schema changes are versioned.** Adding, removing or redefining a field bumps `featureSchemaVersion` and `qualityVersion`. Old runs get the new schema only through an `AUTOMATIC` backfill or `RESCORE` (§4.2), which writes a new quality run and leaves the old feature rows in place.
4. **Flat and typed.** Each value is a string, number, boolean, `null` or, for `signalIds`, `tableSignalIds`, `entityTypes` and `headerTexts`, an array of strings, so the rows load into a columnar table without reshaping.

The fields are candidates for a gradient-boosted classifier, and the schema is expected to change. The stored inputs are the complete record: the original image, the full Textract response, the normalized observations and the submission and screenshot metadata are immutable evidence. Any feature derivable from them can be added later under a new `featureSchemaVersion` by re-scoring, and those rows train (§8.5). What cannot be recovered later is an input nobody stores and the label-side context spec 3 captures at review time.

### 8.5 Training example selection

A cell can have several feature rows: the automatic scoring, retries, re-scores and schema backfills each write their own quality run. A future training dataset builder, owned by the risk model specification, must turn labels and feature rows into exactly one example per labeled cell. This section fixes the rules now so that the evidence collected from the first review supports them.

1. **Label.** The label for a cell is its spec 3 resolution as of the dataset's `labelCutoff`: the latest adjudication not superseded by another adjudication reviewed at or before the cutoff, following spec 3's supersession rule. `SKIPPED` cells have no label. Whether `UNREADABLE` is a class or an exclusion is the risk model specification's decision, and the dataset manifest records it.
2. **Eligibility.** A feature row is eligible when its quality run has a `SUCCEEDED` outcome, its `featureSchemaVersion` is the one the dataset requests, and its baseline, if any, has no member from the cell's screenshot, checked against that snapshot's `members.jsonl`. Ineligible rows are skipped and counted in the dataset manifest.
3. **One row per label.** For each labeled cell the builder picks one eligible row, keyed by `(qualityRunId, cellObservationId)`: the row from the quality run the reviewer was shown (spec 3 records that `qualityRunId` on the adjudication) when it is eligible, otherwise the eligible row with the greatest `qualityRunId`. The dataset records, per example, the chosen `qualityRunId` and which rule chose it (`SHOWN` or `LATEST_ELIGIBLE`).
4. **Backfills qualify for training, not for routing analysis.** A row from a `RESCORE` or schema backfill written after review is eligible for training, because its features read only match-to-csv evidence and a baseline that excludes the screenshot. Any analysis of what the reviewer saw, such as the effect of the shown priority or the heuristic's routing performance, uses only `SHOWN` rows, and cells without one are left out of it.
5. **Rows and tables use the same rules.** Spec 3 row labels select from `row-features.jsonl` by `(qualityRunId, tableObservationId, rowIndex)`, and table labels from `table-features.jsonl` by `(qualityRunId, tableObservationId)`.
6. **Splits group duplicates.** The same image can arrive twice under two screenshot IDs, and several players can submit the same match. Train, validation and test splits assign whole groups: screenshots sharing an `imageSha256` or a `submissionId` form one group, transitively. When the stats lakehouse (#159) defines a match identity, the dataset also groups by it; the dataset manifest records the grouping it used.
7. **Labels attach to the reviewed run.** Adjudications name a `cellObservationId`, which belongs to one processing run. Cells of a sibling run of the same screenshot are different observations and are never labeled by another run's adjudications.

## 9. Scoring and results

### 9.1 Score types

- `suspicionScore`: a deterministic composite from 0 to 1. It is a heuristic, not a probability.
- `reviewPriority`: `NONE`, `LOW`, `MEDIUM`, `HIGH` or `CRITICAL`.
- `needsReview`: true for `MEDIUM`, `HIGH` and `CRITICAL`.
- `signals`: the structured reasons.

The risk model's output has its own reserved fields (§9.6) and never reuses `suspicionScore`.

### 9.2 Cell score

Each severity maps to a signal score: `CRITICAL` 0.98, `HIGH` 0.75, `MEDIUM` 0.40, `LOW` 0.15. Within one group, the cell takes the highest signal score. Across groups:

```text
suspicionScore = 1 - product over groups of (1 - groupScore)
```

Groups: `TYPE_PARSE`, `EMPTY`, `CHARACTER_COMPOSITION`, `LENGTH`, `OCR_CONFIDENCE`, `NUMERIC_DISTRIBUTION`, `GEOMETRY`, `STRUCTURE`, `IDENTITY`. Scores are rounded to four decimal places.

### 9.3 Priority

| Priority | Condition |
| --- | --- |
| `CRITICAL` | any `CRITICAL` signal |
| `HIGH` | `suspicionScore >= 0.75` |
| `MEDIUM` | `suspicionScore >= 0.45` |
| `LOW` | `suspicionScore >= 0.20` |
| `NONE` | otherwise |

Thresholds are configuration (§13.1).

### 9.4 Row, table and run summaries

- Row: `maxSuspicion`, `expectedIssueCount` (sum of cell scores) and `hasCritical`. Rows sort by `hasCritical`, then `maxSuspicion`, then `expectedIssueCount`, all descending.
- Table: `cellCount`, `flaggedCellCount` (cells with `needsReview`), `criticalCellCount`, `meanSuspicion`, `maxSuspicion`, `estimatedIssueCount` and `reviewPriority`, the highest of its cell priorities and the priorities of its table signals.
- Run: the same counts across assessed tables, `assessedTableCount`, `unassessedTableCount`, and `reviewPriority`, the highest of its table priorities and run signals.

`estimatedIssueCount` is a heuristic until scores are calibrated, and consumers must label it that way.

### 9.5 Stored messages

Results store `messageCode` and structured `evidence`, never prose, so a UI can word and translate messages itself.

### 9.6 Path to automated review

The goal is to send as few cells to people as possible while keeping errors in the accepted data below a fixed rate. This component gets there in three stages. Only stage 1 is in scope here; a later risk model specification owns stages 2 and 3.

| Stage | Who reviews | What this component writes | Purpose |
| --- | --- | --- | --- |
| 1. Review every cell (v1) | Spec 3 reviewers confirm every cell and row, with `selectionReason: REVIEW_ALL` | Heuristic score, signals, feature rows; `riskModel` absent | Complete, unbiased labels. The heuristic highlights where to look harder and is the baseline any model must beat. |
| 2. Shadow model | Still every cell | `riskModel` filled with `decision` recorded but not used | Every model version is measured exactly against reviewer decisions at no extra review cost. |
| 3. Flagged plus audit | Cells the model flags, plus a random audit sample of auto-accepted cells (`selectionReason: MODEL_FLAGGED` or `AUDIT_SAMPLE`) | `riskModel.decision` routes review | Automation, with the audit sample measuring the error rate of auto-accepted cells and keeping labels flowing. |

**Reserved result fields.** `CellQuality.riskModel` (§10.1) holds `modelId`, `modelVersion`, `featureSchemaVersion`, `predictedErrorProbability`, `thresholdVersion`, `threshold`, `decision` (`AUTO_ACCEPT` or `REVIEW_REQUIRED`) and `mode` (`SHADOW` or `ROUTING`). v1 never writes it. Consumers must treat it as optional now so stage 2 adds no contract change.

**Success measure.** The gate for stage 3 is stated in terms the data from stage 1 can measure: at the chosen threshold, the error rate among cells the model would auto-accept, at the upper bound of its 95% confidence interval, is below a target the risk model specification sets (for example 0.1%), and the review rate is as low as that allows. Errors are rare, so measuring a rate that low needs tens of thousands of labeled cells. Review-all labeling from the first screenshot is what makes that sample exist.

**Blind labels.** Reviewers see the heuristic priority, so errors they miss will concentrate in `NONE` and `LOW` cells, which is the population a model would auto-accept, and a gate measured on those labels underestimates the error rate. The stage 3 gate is therefore measured on labels collected blind: spec 3's double-review sample, reviewed without the first decision or any priority, and adjudications whose `priorityShown` and `priorDecisionsShown` are both false ([spec 3](3-cell-labeling.md) §7.6). In stage 3 the audit sample of auto-accepted cells is reviewed without the model's decision or score.

**Prerequisites this specification guarantees for the risk model:** cell, row and table feature rows for every table of every scored run (§8.4); stable join keys (`cellObservationId`, `runId`, `screenshotId`) shared with spec 3; recorded heuristic scores as the comparison baseline; versioned features, configuration and baselines; and re-scoring to produce new feature schemas for old runs. Spec 3 owns the label-side prerequisites: an explicit decision on every cell, row and table, `selectionReason`, the shown `qualityRunId` and whether a priority was shown (`priorityShown`), error types, a blind double-review sample, and labels keyed to the parser's exported field as well as the semantic field.

## 10. Typed domain model

### 10.1 Shared contracts

`@mcc/contracts` exports the read-side view of `normalized-ocr/v2` that this component and spec 3 consume (`NormalizedObservations`, `NormalizedTable`, `NormalizedCell`, `ValidationFlag`, `SemanticField`), moved from `extract-text` in P0.2 so match-to-csv writes the same type. It also exports:

```typescript
type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type ReviewPriority = 'NONE' | Severity;
type SignalSource = 'VALIDATION' | 'RULE' | 'ANOMALY' | 'BASELINE';
type SignalGroup =
  | 'TYPE_PARSE' | 'EMPTY' | 'CHARACTER_COMPOSITION' | 'LENGTH' | 'OCR_CONFIDENCE'
  | 'NUMERIC_DISTRIBUTION' | 'GEOMETRY' | 'STRUCTURE' | 'IDENTITY';

interface QualitySignal {
  source: SignalSource;
  id: string;                 // e.g. 'C001_SUSPICIOUS_GLYPH' or 'INVALID_INTEGER'
  group: SignalGroup;
  severity: Severity;
  score: number;
  messageCode: string;
  evidence: Readonly<Record<string, string | number | boolean | null>>;
}

interface QualityVersions {
  qualityVersion: string; profileVersion: string; rulesetVersion: string;
  anomalyVersion: string; scoringVersion: string; configVersion: string;
  featureSchemaVersion: string;
  baselineVersion: string;    // 'none' before Phase 4
}

// Reserved for the risk model (§9.6). Never written in v1.
interface RiskModelAssessment {
  modelId: string;
  modelVersion: string;
  featureSchemaVersion: string;
  predictedErrorProbability: number;
  thresholdVersion: string;
  threshold: number;
  decision: 'AUTO_ACCEPT' | 'REVIEW_REQUIRED';
  mode: 'SHADOW' | 'ROUTING';
}

// One line of features.jsonl (§8.4). Every field is present; inapplicable values are null.
// RowFeatureRow ('row-feature-row/v1') and TableFeatureRow ('table-feature-row/v1') follow the same pattern.
interface CellFeatureRow {
  schemaVersion: 'cell-feature-row/v1';
  featureSchemaVersion: 'features-v1';
  cellObservationId: string;
  runId: string;
  screenshotId: string;
  qualityRunId: string;
  // ...every remaining field listed in §8.4, typed string | number | boolean | null,
  // except the array fields named in §8.4 rule 4
}

interface CellQuality {
  cellObservationId: string;
  rowIndex: number;
  columnIndex: number;
  field: SemanticField;
  observedText: string;
  suspicionScore: number;
  reviewPriority: ReviewPriority;
  needsReview: boolean;
  signals: readonly QualitySignal[];
  riskModel?: RiskModelAssessment; // absent in v1
}

interface RowQuality { rowIndex: number; maxSuspicion: number; expectedIssueCount: number; hasCritical: boolean }

interface QualitySummary {
  cellCount: number; flaggedCellCount: number; criticalCellCount: number;
  meanSuspicion: number; maxSuspicion: number; estimatedIssueCount: number;
  reviewPriority: ReviewPriority;
}

interface TableQuality {
  tableObservationId: string;
  tableIndex: number;
  classification: 'SCOREBOARD' | 'UNKNOWN';
  assessed: boolean;
  summary: QualitySummary;
  tableSignals: readonly QualitySignal[];
  rows: readonly RowQuality[];   // sorted per §9.4
  cells: readonly CellQuality[]; // empty when not assessed
}

interface QualityResult {
  schemaVersion: 'quality-result/v1';
  qualityRunId: string;
  runId: string;
  screenshotId: string;
  generatedAt: string;
  versions: QualityVersions;
  summary: QualitySummary & { assessedTableCount: number; unassessedTableCount: number };
  runSignals: readonly QualitySignal[];
  tables: readonly TableQuality[];
}

type ScoreRunMode = 'AUTOMATIC' | 'RESCORE';
interface ScoreRunInput { runCompletion: S3ObjectReference; mode: ScoreRunMode }

type ScoreRunOutput =
  | { qualityRunId: string; runId: string; result: S3ObjectReference; reviewPriority: ReviewPriority }
  | { runId?: string; skipped: 'SOURCE_RUN_NOT_SUCCEEDED' | 'ALREADY_CLAIMED' };
```

Workflow inputs are validated at the trust boundary in `score-run` before any read. `observedText` is copied from evidence and is never interpreted; rules cap the text they inspect at 256 characters.

### 10.2 Internal types

`src/lib/` defines `FieldProfile`, `QualityConfig`, `FieldBaseline` and `BaselineSnapshot`, and the port:

```typescript
interface BaselineSource {
  // Newest snapshot with no member from this screenshot; undefined means baselineVersion 'none'.
  forScreenshot(screenshotId: string): Promise<BaselineSnapshot | undefined>;
}
```

### 10.3 Relationships

```text
Processing run 1 -> 0..many quality runs (automatic, retries, re-scores)
Processing run 1 -> 0..1 claim per qualityVersion
Quality run 1 -> 1 manifest, 0..1 profiles, 0..1 signals, 0..1 result, 0..1 outcome
Quality result 1 -> many tables -> many cells -> many signals
Quality run many -> 0..1 baseline snapshot (by baselineVersion)
Baseline snapshot 1 -> many spec 3 adjudications (by adjudicationSetSha256)
```

## 11. Module and function catalog

Every handler exports `handler` for Lambda and a core function that takes an injected dependencies object. Only the default dependencies construct SDK clients.

### 11.1 Lambda entry points

| File | Public functions | Purpose |
| --- | --- | --- |
| `src/lambdas/score-run.ts` | `handler(event)`; `scoreRun(input, dependencies)` | Score one run (§6.2). Records `GIT_SHA` and `DEPLOYMENT_ENVIRONMENT`. |
| `src/lambdas/build-baselines.ts` | `handler(event)`; `buildBaselines(input, dependencies)` | Build and load a baseline snapshot (§8.3). Phase 4. |

### 11.2 Libraries

| File | Public functions | Purpose |
| --- | --- | --- |
| `src/lib/run-keys.ts` | `parseRunCompletionKey(key, objectPrefix)`; `qualityRunPrefix(runPrefix, qualityRunId)`; `claimKey(runPrefix, qualityVersion)` | Key validation and construction. |
| `src/lib/evidence.ts` | `evidenceId()`; `sha256(bytes)`; `putJsonOnce(bucket, key, value)`; `now()` | Identifiers in the spec 1 format and create-only writes. |
| `src/lib/config.ts` | `loadQualityConfig()` | Read and validate the bundled configuration. |
| `src/lib/profiles.ts` | `profileTable(table, cells)` | Field profiles (§8.1). |
| `src/lib/rules/generic.ts` | `evaluateRunRules(observations, config)`; `evaluateTableRules(table, cells, config)` | §7.1, §7.2. |
| `src/lib/rules/halo.ts` | `evaluateHaloRules(table, cells, config)` | §7.3. |
| `src/lib/anomalies.ts` | `evaluateAnomalies(table, cells, profiles, baseline, config)` | §8.2, §8.3 checks. |
| `src/lib/scoring.ts` | `scoreCell(signals, config)`; `priorityFor(score, signals, config)`; `assembleResult(...)` | §9. |
| `src/lib/features.ts` | `buildFeatureRows(inputs, profiles, signals, scores, baseline, versions)` returning cell, row and table rows | §8.4. Pure; covers every table. |
| `src/lib/baseline-source.ts` | `NoBaselineSource`; `DynamoBaselineSource` | The `BaselineSource` port. |
| `src/lib/log.ts` | `log(level, message, details?)` | One JSON log line per call. |

### 11.3 Infrastructure code

| File | Public API | Purpose |
| --- | --- | --- |
| `cdk/lib/app.ts` | `createOcrQualityApp(props?, environmentVariables?)` | Build the stack exactly as deployment does. |
| `cdk/lib/ocr-quality-stack.ts` | `OcrQualityStack` | All compute resources (§13.3). |

## 12. Directory structure and ownership

```text
mcc-stats-suite/
  applications/ocr-quality/
    cdk.json
    package.json                     # @mcc/ocr-quality; build, typecheck, test
    TESTING.md
    config/quality-config-v1.json    # Bundled, immutable once released
    cdk/
      bin/ocr-quality.ts
      lib/{app,ocr-quality-stack}.ts
    src/
      lambdas/{score-run,build-baselines}.ts
      lib/{run-keys,evidence,config,profiles,anomalies,scoring,features,baseline-source,log}.ts
      lib/rules/{generic,halo}.ts
    test/
      *.test.ts
      fixtures/*.fixture.json        # Reduced normalized-ocr/v2 artifacts with expected signals
  packages/contracts/src/index.ts    # normalized-ocr/v2 read types, quality result types
  infrastructure/modules/foundation/main.tf   # evidence bucket EventBridge notifications
```

`ocr-quality` imports only `@mcc/contracts` and `@mcc/cdk-config` from the monorepo and never imports `match-to-csv` code.

## 13. Configuration and infrastructure

### 13.1 Configuration schema

```json
{
  "configVersion": "quality-config-v1",
  "severityScores": { "CRITICAL": 0.98, "HIGH": 0.75, "MEDIUM": 0.40, "LOW": 0.15 },
  "priorityThresholds": { "HIGH": 0.75, "MEDIUM": 0.45, "LOW": 0.20 },
  "needsReviewFrom": "MEDIUM",
  "confidenceMediumBelow": 80,
  "wordConfidenceLowBelow": 90,
  "geometryTolerance": 0.01,
  "maxDigits": { "SCORE": 6, "KILLS": 3, "ASSISTS": 3, "DEATHS": 3 },
  "playerNamePattern": "^[A-Za-z0-9 ]{1,16}(#[0-9]{1,4})?$",
  "maxRosterSize": 16,
  "minSampleSize": 5,
  "robustZThreshold": 4.0,
  "withinTableMaxSeverity": "LOW",
  "minBaselineObservations": 200
}
```

The file is bundled into the Lambda. `loadQualityConfig` validates every key and range at cold start and throws `InvalidQualityConfigError` on any problem. A released configuration file is never edited; a change adds `quality-config-v2.json` and bumps `configVersion` and `qualityVersion`.

### 13.2 Persistent resources

| Resource | Owner | Configuration |
| --- | --- | --- |
| Evidence bucket | OpenTofu foundation | Existing (spec 1 §13.1). P1.1 adds `aws_s3_bucket_notification` with `eventbridge = true`. |
| KMS key and SSM parameters | OpenTofu foundation | Existing. The stack reads `/mcc/<env>/match-to-csv/evidence-bucket-name` and `/mcc/<env>/match-to-csv/data-key-arn`. |

### 13.3 Application resources

| Resource | Configuration |
| --- | --- |
| `ScoreRun` | Node.js 22, ARM64, 1,024 MB, 1-minute timeout, X-Ray, env `EVIDENCE_BUCKET`, `OBJECT_PREFIX`, `GIT_SHA`, `DEPLOYMENT_ENVIRONMENT`, and from Phase 4 `BASELINE_TABLE` |
| `BuildBaselines` (Phase 4) | Node.js 22, ARM64, 2,048 MB, 10-minute timeout, env `EVIDENCE_BUCKET`, `OBJECT_PREFIX`, `BASELINE_TABLE` |
| State machine `<stack>` | §6.1 |
| EventBridge rule and DLQ | §4.1 |
| `BaselineCache` table (Phase 4) | On-demand, partition key `pk` (`VERSIONS`, `baselineVersion` or `MEMBER#screenshot#<id>` or `MEMBER#image#<sha256>`), sort key `sk` (`baselineVersion` or field), encrypted with the foundation data key, removed with the stack because it is rebuildable from snapshots |
| Outputs | `StateMachineArn`, `BuildBaselinesFunctionName` (Phase 4), `ObjectPrefix` |

Log groups follow match-to-csv: three months in prod, two weeks otherwise, retained for stable stacks and destroyed with ephemeral ones.

### 13.4 Permissions

| Principal | Evidence bucket | KMS data key | `BaselineCache` |
| --- | --- | --- | --- |
| `ScoreRun` | `GetObject` on `<ns>submissions/*`; `PutObject` on `<ns>submissions/*/runs/*/quality/*` | decrypt, encrypt | `GetItem`, `Query` (Phase 4) |
| `BuildBaselines` | `ListBucket` with prefix `<ns>submissions/`; `GetObject` on `<ns>submissions/*`; `PutObject` on `<ns>baselines/*` | decrypt, encrypt | `PutItem`, `BatchWriteItem`, `UpdateItem` |
| State machine role | none | none | none; `lambda:InvokeFunction` on `ScoreRun` only |

`<ns>` is empty for stable stacks and `ephemeral/<name>/` for ephemeral ones. Every role carries the workload permissions boundary and, for ephemeral stacks, the `/mcc-local/` path. No role has `DeleteObject` or any bucket-configuration permission.

### 13.5 Deployment

The stack deploys through `scripts/cdk-app.mjs` exactly like match-to-csv: stable stacks from GitHub Actions on `main`, dev then prod with a required reviewer; ephemeral stacks from a local shell with `--environment dev --ephemeral <name>`. The deploy preflight fails when either SSM parameter in §13.2 is missing. Post-deploy verification checks that the stack is complete, `ScoreRun` is `Active` and the state machine is `ACTIVE`. P1.1 must be applied to an environment before its stack can receive events.

## 14. Security and privacy

1. OCR text is untrusted player-supplied content. It is never evaluated, used in keys or used to build regular expressions, and rules inspect at most 256 characters of it.
2. Workflow input is untrusted: keys are validated against the run completion pattern and the stack namespace before any read (§4.1).
3. Quality evidence contains gamertags copied from OCR. It lives only in the evidence bucket under the foundation key.
4. Workflow payloads and logs carry keys, IDs, counts and priorities, never `observedText`.
5. Create-only writes and Object Lock prevent this component from altering any evidence, including its own.
6. Ephemeral stacks read and write only under `ephemeral/<name>/`, enforced by key validation and IAM resource patterns.

## 15. Observability

- Lambdas log JSON lines with `level`, `message` and context fields: `runId`, `qualityRunId`, `mode`, counts, `reviewPriority`, durations and error names.
- Step Functions logs every state with execution data, which holds only references (§14).
- X-Ray tracing is active on every function and the state machine.
- The audit record for "what happened to this run" is its `quality/` prefix: the claim names the owning execution, and each quality run's manifest and outcome record inputs, versions and errors.
- Undeliverable trigger events wait in the DLQ for 14 days. Alarms follow match-to-csv's observability specification ([spec 5](5-match-to-csv-observability.md); backlog P5.6).

## 16. Testing, CI and release

### 16.1 Tests

Tests use `tap`, run from `applications/ocr-quality/test/*.test.ts`, and never call AWS. The command fails below 80% statements, 65% branches, 80% lines or 60% functions.

| File | Covers |
| --- | --- |
| `run-keys.test.ts` | stable and ephemeral completion keys accepted; submission completions, deeper keys and other namespaces rejected |
| `config.test.ts` | bundled config loads; missing keys and out-of-range values throw |
| `profiles.test.ts` | medians and MAD; `madZero`; empty and unparsed cells; determinism |
| `rules.test.ts` | every rule in §7 fires on a seeded case and stays quiet on a clean table; imported flags respect §7.1 scoping; `UNKNOWN` tables produce no signals |
| `anomalies.test.ts` | robust z with and without zero MAD; small samples; alignment checks; within-table cap |
| `features.test.ts` | one cell row per cell, one row row per table row and one table row per table, `UNKNOWN` tables included; every §8.4 field present with `null` where inapplicable; parser fields `null` without P0.3 provenance; `textractModelVersion` taken from the raw response; no field read from adjudications or resolutions; values match fixtures; rows are flat |
| `scoring.test.ts` | noisy-OR across groups; max within a group; priority thresholds; `CRITICAL` override; row ordering; summaries |
| `score-run.test.ts` | complete automatic run writes claim, manifest, profiles, signals, features, result and outcome in order; `FAILED` source skipped with no writes; foreign claim no-op; own claim continues; re-score skips the claim; artifact error writes `FAILED` outcome and rethrows |
| `fixtures.test.ts` | every fixture produces its expected signals and priorities; at least one fixture per rule |
| `app.test.ts` | stack synthesizes for stable and ephemeral deployments; IAM resource patterns per §13.4; EventBridge wildcard per §4.1 |
| `baseline.test.ts` (Phase 4) | resolution of superseding adjudications; `usable: false` below the minimum; snapshot hash stability; pointer moves only after the load |

A fixture is a reduced `normalized-ocr/v2` artifact with player data replaced, plus `expectedSignals` and `expectedPriorities`.

### 16.2 CI and release

CI runs format, lint, typecheck and tests for affected workspaces, and synthesizes `ocr-quality` with `-c environment=dev -c ephemeral=ci`. Release Please versions the application and `@mcc/contracts`; a contracts change bumps every dependent application.

### 16.3 Live validation

After a change reaches dev, an operator sends a representative screenshot to the dev match-to-csv address, confirms one `ocr-quality` execution succeeded, and checks that the run's `quality/` prefix holds a claim and a quality run with every §5.1 object and a `SUCCEEDED` outcome. Starting a `RESCORE` for the same completion creates a second quality run and leaves the first unchanged.

## 17. Acceptance criteria

v1 (Phases 0 to 3) is complete when:

1. A successful match-to-csv run in dev produces, within one minute, a quality run with every §5.1 object, a `SUCCEEDED` outcome and a `result.json` that validates as `quality-result/v1`.
2. A failed match-to-csv run produces no quality evidence.
3. Delivering the same completion event twice produces one claim and one quality run.
4. A `RESCORE` creates a second quality run and changes nothing in the first.
5. A fixture seeded with `I6` at cell and word confidence 99 in a kills cell yields `INVALID_INTEGER` and `C001_SUSPICIOUS_GLYPH` with candidate `16`, `reviewPriority: HIGH`, and a score of 0.75.
6. A run whose only table is `UNKNOWN` yields `R001_NO_SCOREBOARD_TABLE`, `assessed: false` for the table, and run priority `HIGH`.
7. Every result records `qualityVersion`, the normalized artifact's SHA-256, the source run's stage versions, `gitSha` and `baselineVersion: none`.
8. The three feature files hold exactly one row per cell, table row and table in `normalized/observations.json`, including `UNKNOWN` tables, every row records `textractModelVersion` and `imageSha256`, and no `result.json` cell carries `riskModel`.
9. An ephemeral stack scores only runs under its own `ephemeral/<name>/` namespace.
10. Every §16.1 test passes with the coverage thresholds, and CDK synthesis succeeds.

Phase 4 is complete when a baseline built from at least 200 labeled values per field changes `baselineVersion` in new results, `B001` fires on a seeded out-of-range value, and deleting and rebuilding the cache reproduces the same snapshot hash. Two leakage cases must also hold. A run re-scored after its own adjudications were included in a newer snapshot uses the newest snapshot without its screenshot. A run whose sibling run of the same screenshot was reviewed and included in a snapshot also skips that snapshot. In both cases the recorded `baselineVersion` is one whose `members.jsonl` does not list the screenshot.

## 18. Risks and accepted limitations

1. **Scores are not probabilities.** Severity scores and thresholds are judgment, not fitted to data. Accepted because v1 routes nothing: spec 3 reviews every cell, and the risk model replaces the heuristic for routing (§9.6).
2. **Within-table statistics are weak.** Eight rows make robust z-scores noisy, and kills legitimately vary. Accepted by capping them at `LOW` (§8.2); Phase 4 adds baselines.
3. **The player name pattern is unverified.** `playerNamePattern` is not checked against a labeled corpus and may flag valid names. It is `LOW` severity and configurable.
4. **New quality versions do not backfill.** A `qualityVersion` bump scores new runs only. Operators backfill with `AUTOMATIC` executions (§4.2).
5. **Duplicate source runs are scored separately.** Match-to-csv retries can create two runs of one screenshot (spec 1 §18.6), and each gets its own quality run. Consumers group by screenshot.
6. **The export may lag the score.** Scoring starts at run completion, before match-to-csv writes the CSV, so a quality result can exist for a run whose export later fails. Rows are judged from `normalized-ocr/v2`, which is complete at completion.
7. **The evidence bucket sends every object event to EventBridge.** Only the stack rules match run completions. Accepted because S3 events on the default bus have no delivery charge and the bucket's write rate is low.
8. **Re-scored rows can use older baselines.** Excluding the scored screenshot means a run re-scored after review uses the newest snapshot built before its labels, which can be several builds old. Accepted because a slightly stale baseline is better than one containing the answer.
9. **Baseline builds scan every adjudication.** `BuildBaselines` lists the whole namespace, so build time grows with label count. Accepted at league scale; P5.3 moves baselines to the data platform behind the same port.
10. **Rules know only five fields.** Team totals, placements and medals are not checked until match-to-csv extracts them (P5.4).
11. **Ephemeral pairing is by name.** An ephemeral ocr-quality stack sees only the ephemeral match-to-csv stack of the same name, and nothing enforces that the second one exists.
12. **Feature choice is a guess until a model is trained.** The first schema will miss features that matter. Accepted because every input is stored evidence: re-scoring under a new `featureSchemaVersion` recovers any feature derivable from it for every past run, and those rows are eligible for training (§8.5).
13. **Runs scored before this component exists have no features.** Runs completed before P3.2 deploys are scored only by an `AUTOMATIC` backfill (§4.2). P3.3 includes that backfill in dev and prod.
14. **The SSM parameters live under `match-to-csv`.** The stack reads foundation parameters named for another application. Accepted to avoid duplicating foundation outputs; renaming them is a foundation change for every consumer.

## 19. Reference documentation

- S3 events in EventBridge: https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventBridge.html
- EventBridge content filtering (wildcard matching): https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-pattern-operators.html
- EventBridge dead-letter queues: https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html
- S3 conditional writes: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html
- Step Functions error handling: https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html
- Step Functions redrive: https://docs.aws.amazon.com/step-functions/latest/dg/redrive-executions.html
- Step Functions workflow types: https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html
- DynamoDB conditional writes: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/WorkingWithItems.html#WorkingWithItems.ConditionalUpdate
- Median absolute deviation: https://www.itl.nist.gov/div898/handbook/eda/section3/eda35h.htm

## 20. Delivery plan: phases and slices

This section is the backlog source for building the component. It is written to be turned directly into GitHub issues.

### 20.1 How to file this plan

- Each **phase** becomes one epic, titled with the phase title, with its goal and exit criteria as the body. Create epics only when someone explicitly asks for filing.
- Each **slice** becomes one leaf issue under its phase epic, titled without its code, with `Plan ID: P<n>.<m>` in the body. File with `/mcc-create-github-issue`.
- **Size** is XS, S or M. Split a slice by independently testable behavior when it outgrows one reviewable PR; the original Plan ID becomes the container.
- **Blocked by** lists Plan IDs. Create native blocked-by links after every issue in the batch exists. Blockers in earlier phases still apply.
- **Acceptance** bullets become the issue's acceptance criteria verbatim. Every slice also inherits §20.3.
- **Spec** lists the sections the implementer must read. Link them; this document stays the source of truth.
- Plan IDs are stable. Deferred slices keep their IDs and move to the backlog phase; new slices take the next free number in their phase.
- Phase 4 is filed only after spec 3's adjudication writer merges. Phase 5 is backlog.

### 20.2 Seam contracts

| Contract | Defined in | Main consumers |
| --- | --- | --- |
| `normalized-ocr/v2` read types in `@mcc/contracts` | P0.2 | match-to-csv `extract-text`, this component, spec 3 |
| Quality result types and `ScoreRunInput` (§10.1) | P0.2 | `score-run`, spec 3, later admin features |
| Quality key layout and claim rule (§5.1, §5.2) | P3.1 | `score-run`, spec 3 queue ordering (P5.1) |
| Signal IDs, groups and `messageCode` values (§7, §8) | P2.2, P2.3 | consumers that display reasons |
| `cell-feature-row/v1`, `row-feature-row/v1`, `table-feature-row/v1` and `features-v1` (§8.4) | P2.5 | the risk model specification, its training dataset builder |
| Parser provenance in `normalized-ocr/v2` (selected table, exported field per column, table row per exported row) | P0.3 | this component, spec 3 labels (#158), the stats lakehouse (#159) |
| `adjudicationSetSha256` definition (§8.3) | this specification | `build-baselines`, spec 3's validated-table lineage hash |
| Training example selection and eligibility (§8.5) | this specification | the risk model specification's dataset builder; spec 3 records the shown `qualityRunId` it depends on |
| `baseline-member/v1` and per-screenshot baseline selection (§8.3) | P4.1, P4.2 | `score-run`, the training dataset builder |
| Reserved `riskModel` fields (§9.6) | P0.2 | spec 3, the risk model specification |
| Spec 3 `selectionReason`, shown `qualityRunId`, `priorityShown`, `priorDecisionsShown` and the blind double-review sample | spec 3 (#158) | the risk model specification's gate (§9.6) |
| `BaselineSource` port and `baseline-snapshot/v1` | P4.1 | `score-run`, `build-baselines`, P5.3 |
| Spec 3 `cell-adjudication/v1` and its supersession rules | spec 3 | `build-baselines` |

A change to a contract updates every consumer in the same PR.

### 20.3 Definition of done for every slice

- Handlers keep I/O behind an injected dependencies object; only default dependencies construct SDK clients. Rules, anomalies and scoring stay pure.
- New behavior has `tap` tests that run without AWS, and the workspace stays above its coverage thresholds.
- `npm run check` passes. Slices that touch CDK also pass `npm run app:synth -- ocr-quality --environment dev`. Slices that touch `infrastructure/` pass `npm run tofu:check`.
- Any change to a stage's behavior bumps that stage's version and `qualityVersion` (§5.4).
- No domain, address, account ID or real player data appears in code, fixtures, logs or docs.
- Operator-visible changes update `applications/ocr-quality/TESTING.md` or a README in the workspace.

### Phase 0: Workspace and contracts

**Goal:** a TypeScript workspace with a test gate, and the shared types this component reads and writes.
**Exit criteria:** the workspace builds and tests in CI, and match-to-csv writes `normalized-ocr/v2` through the shared type with parser provenance.

#### P0.1 Workspace and test gate (S)

- **Blocked by:** none
- **Spec:** §3, §12, §16.1
- **Files:** `applications/ocr-quality/{package.json,tsconfig.json,TESTING.md}`, `test/`
- **Provides:** `build`, `typecheck` and `test` scripts with `tap` and coverage thresholds
- **Acceptance:**
  - `npm test --workspace @mcc/ocr-quality` runs every `test/*.test.ts` with `tap` and fails below 80% statements, 65% branches, 80% lines or 60% functions.
  - The workspace depends only on `@mcc/contracts` and `@mcc/cdk-config` from the monorepo.
  - The existing boundary test is converted to TypeScript and still passes.

#### P0.2 Normalized observation and quality contracts (S)

- **Blocked by:** none
- **Spec:** §10.1, §20.2
- **Files:** `packages/contracts/src/index.ts`, `applications/match-to-csv/src/lambdas/extract-text.ts`
- **Provides:** `NormalizedObservations` and related read types; every quality type in §10.1
- **Acceptance:**
  - `extract-text` builds its normalized artifact as `NormalizedObservations`, and its output is unchanged byte for byte on the existing tests and fixtures.
  - The quality types compile and are exported.
  - `npm run release:check` passes.

#### P0.3 Parser provenance in normalized observations (S)

- **Blocked by:** P0.2
- **Spec:** §1, §8.4; spec 1 §7.2, §8
- **Files:** `applications/match-to-csv/src/lib/scoreboard-logic.ts`, `applications/match-to-csv/src/lambdas/extract-text.ts`, `packages/contracts/src/index.ts`
- **Provides:** `parser.provenance` in `normalized-ocr/v2`: `selectedTableIndex`, `columnFields` (column index to exported field, including the column-order fallback) and `rowIndexes` (the table row of each exported row, in CSV order)
- **Acceptance:**
  - A fixture whose kills header is unreadable records the kills column in `columnFields` through the fallback while the normalized cell keeps `semanticLocation.field: UNKNOWN`.
  - `rowIndexes` has one entry per exported row and identifies skipped total and footer rows by their absence.
  - CSV output is unchanged on every existing fixture, and `tableParserVersion` is bumped.

### Phase 1: Foundation

**Goal:** run completions reach EventBridge.
**Exit criteria:** P1.1 is applied in dev and prod.

#### P1.1 Evidence bucket EventBridge notifications (XS)

- **Blocked by:** none
- **Spec:** §4.1, §13.2, §18.7
- **Files:** `infrastructure/modules/foundation/main.tf`
- **Provides:** `Object Created` events from the evidence bucket on the default bus
- **Acceptance:**
  - The evidence bucket has an `aws_s3_bucket_notification` with `eventbridge = true`, and no other bucket setting changes.
  - `npm run tofu:check` passes and the plan shows only the notification resource.
  - The PR states that applying it needs a person's approval.

### Phase 2: Scoring library

**Goal:** pure functions that turn one normalized artifact into a quality result.
**Exit criteria:** every rule, anomaly and score in §7 to §9 is implemented and covered by fixtures.

#### P2.1 Keys, configuration and profiles (S)

- **Blocked by:** P0.1, P0.2
- **Spec:** §4.1, §5.1, §8.1, §13.1
- **Files:** `src/lib/{run-keys,evidence,config,profiles}.ts`, `config/quality-config-v1.json`
- **Provides:** `parseRunCompletionKey`, `loadQualityConfig`, `profileTable`
- **Acceptance:**
  - Key validation accepts stable and ephemeral run completion keys and rejects every other key in `run-keys.test.ts`.
  - Invalid configuration throws `InvalidQualityConfigError`.
  - Profiles match hand-computed medians and MAD, and record `madZero`.

#### P2.2 Rules (M)

- **Blocked by:** P2.1
- **Spec:** §7
- **Files:** `src/lib/rules/{generic,halo}.ts`, `test/fixtures/`
- **Provides:** `evaluateRunRules`, `evaluateTableRules`, `evaluateHaloRules`
- **Acceptance:**
  - Each rule in §7.1 to §7.3 fires on a seeded fixture and stays quiet on a clean one.
  - Imported flags follow the §7.1 scoping, and `UNKNOWN` tables produce no table or cell signals.
  - `C001` reports the candidate value.

#### P2.3 Within-table anomalies (S)

- **Blocked by:** P2.1
- **Spec:** §8.2
- **Files:** `src/lib/anomalies.ts`
- **Provides:** `evaluateAnomalies` with a `none` baseline
- **Acceptance:**
  - `A001` to `A004` fire on seeded outliers and never above `withinTableMaxSeverity`.
  - Zero MAD and samples under `minSampleSize` produce no `A001` or `A002` signal.

#### P2.4 Scoring and result assembly (S)

- **Blocked by:** P2.2, P2.3
- **Spec:** §9, §10.1
- **Files:** `src/lib/scoring.ts`
- **Provides:** `assembleResult`
- **Acceptance:**
  - Cell scores, priorities, row ordering and summaries match §9 on fixtures, including acceptance criterion 5 in §17.
  - Results validate as `quality-result/v1`.

### Phase 3: Workflow and deployment

**Goal:** every successful run in dev and prod is scored automatically.
**Exit criteria:** §17 criteria 1 to 10 hold in dev, and prod deploys.

#### P2.5 Feature rows (M)

- **Blocked by:** P2.4, P0.3
- **Spec:** §8.4, §9.6
- **Files:** `src/lib/features.ts`
- **Provides:** `buildFeatureRows` for cells, rows and tables
- **Acceptance:**
  - Every cell, table row and table, `UNKNOWN` tables included, produces one row in its file with every `features-v1` field, `null` where inapplicable.
  - Lineage fields include `textractModelVersion` from the raw response, `imageSha256`, `submissionId` and `receivedAt`; parser fields come from P0.3 provenance and are `null` without it.
  - Feature values match hand-computed values on fixtures, including word confidence statistics, neighbor confidences, skew, row colour distance and row gaps.
  - A test proves no feature reads spec 3 adjudications or resolutions.

#### P3.1 `ScoreRun` handler (M)

- **Blocked by:** P2.4, P2.5
- **Spec:** §4.3, §5, §6.2, §6.3
- **Files:** `src/lambdas/score-run.ts`, `src/lib/{baseline-source,log}.ts`
- **Provides:** `scoreRun`, `NoBaselineSource`
- **Acceptance:**
  - Every case in the `score-run.test.ts` row of §16.1 passes with injected dependencies.
  - Writes happen in the §6.2 order, and every write is create-only.

#### P3.2 Stack, trigger and IAM (M)

- **Blocked by:** P3.1, P1.1
- **Spec:** §4.1, §6.1, §13.3, §13.4, §13.5
- **Files:** `cdk/lib/{app,ocr-quality-stack}.ts`, `cdk/bin/ocr-quality.ts`
- **Provides:** the deployable stack
- **Acceptance:**
  - Synthesis produces the function, state machine, rule and DLQ in §13.3 with the IAM in §13.4, for stable and ephemeral deployments.
  - The rule's wildcard pattern matches §4.1 for each deployment type.
  - The deploy preflight fails when either SSM parameter is missing.

#### P3.3 Fixture corpus and live validation (S)

- **Blocked by:** P3.2
- **Spec:** §16.1, §16.3, §17
- **Files:** `test/fixtures/`, `applications/ocr-quality/TESTING.md`
- **Provides:** a reduced fixture per rule and the operator validation steps
- **Acceptance:**
  - `fixtures.test.ts` covers every signal ID in §7 and §8.2.
  - `TESTING.md` lists the §16.3 steps, and they pass in dev.
  - Every successful run completed before the stack deployed is scored by an `AUTOMATIC` backfill in dev and prod, and the operator steps are in `TESTING.md`.

### Phase 4: Cross-run baselines

**Goal:** values are compared with every verified value of their field.
**Exit criteria:** the Phase 4 criteria in §17 hold in dev.

#### P4.1 Baseline snapshot builder (M)

- **Blocked by:** P3.2; spec 3's adjudication writer
- **Spec:** §8.3, §5.3, §13.4
- **Files:** `src/lambdas/build-baselines.ts`, `cdk/lib/ocr-quality-stack.ts`
- **Provides:** `baseline-snapshot/v1`, the `BaselineCache` table, `BuildBaselines`
- **Acceptance:**
  - A build over fixture adjudications resolves supersession like spec 3 and counts only `ACCEPTED` and `CORRECTED` cells of mapped fields.
  - Two builds over the same adjudications produce the same `adjudicationSetSha256` and statistics.
  - The `CURRENT` pointer moves only after every field and member item is loaded.
  - `members.jsonl` lists every contributing screenshot, image hash, submission and run, including runs that are siblings of other members, and the manifest records `labelCutoff` and `membersSha256`.

#### P4.2 Baseline signals in scoring (S)

- **Blocked by:** P4.1
- **Spec:** §8.3, §5.4
- **Files:** `src/lib/{baseline-source,anomalies}.ts`, `src/lambdas/score-run.ts`
- **Provides:** `DynamoBaselineSource` with per-screenshot selection, `B001`, `B002`
- **Acceptance:**
  - Results and feature rows record the `baselineVersion` and `baselineLabelCutoff` used.
  - Scoring a run whose screenshot is a member of the newest snapshot uses the newest snapshot without it, both for a re-score after adjudication and for a run whose sibling was reviewed.
  - `B001` and `B002` fire on seeded values and never for fields with `usable: false`.
  - With no `CURRENT` pointer, scoring behaves exactly as in Phase 3 with `baselineVersion: none`.

### Phase 5: Backlog (not filed with v1)

| ID | Slice | Size | Note |
| --- | --- | --- | --- |
| P5.1 | Spec 3's review queue orders runs and cells by the latest `reviewPriority` | S | Blocked by P3.2 and spec 3's queue. Belongs to whichever spec ships second. |
| P5.2 | Publish `OCR Quality Assessed` and `OCR Quality Failed` events | XS | When a consumer needs push notification instead of reading `outcome.json`. |
| P5.3 | Data-platform `BaselineSource` | M | §18.9; needs the data platform. |
| P5.4 | Rules for team totals, placement and medals | M | §18.10; needs match-to-csv to extract those fields. |
| P5.5 | Risk model specification: training dataset builder (feature rows joined with spec 3 labels, split by screenshot), gradient-boosted training, evaluation gate against the heuristic, shadow mode, then routing with an audit sample | M | §9.6. A separate specification; it fills the reserved `riskModel` fields. |
| P5.6 | Alarms for failed executions and DLQ depth | S | Follow [spec 5](5-match-to-csv-observability.md). |
| P5.8 | Retire spec 1's `materialize-training-data` once the risk model's dataset builder exists | XS | §1; one labeled dataset definition. |
| P5.7 | Scheduled baseline rebuild | XS | When manual builds become a chore. |

### 20.4 Dependency order and parallel lanes

P0.1, P0.2 and P1.1 can start together, and P0.3 follows P0.2. P2.2 and P2.3 run in parallel after P2.1. The critical path is P0.1 -> P2.1 -> P2.2 -> P2.4 -> P2.5 -> P3.1 -> P3.2 -> P3.3, with P0.3 joining at P2.5. Feature rows ship with the first deployment, so every run spec 3 labels has features from the start. The first real feedback is P3.2 in dev, when live runs start producing priorities that can be compared with screenshots.
