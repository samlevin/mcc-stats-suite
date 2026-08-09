# OCR Quality Assessment Pipeline — Revised Implementation Specification

## Scope

This specification covers:

1. **Step 1 — Canonical logging and human-correction capture**
2. **Step 2 — Deterministic rules and unsupervised anomaly detection orchestrated by AWS Step Functions**

The pipeline is designed to support a later supervised-learning stage without changing the storage contracts established here.

---

# 1. Architectural Principles

## 1.1 Authoritative data

Amazon S3 is the immutable system of record for:

- source screenshots
- raw OCR output
- normalized table structure
- extracted CSV
- quality-analysis artifacts
- replay manifests

DynamoDB is the operational index for:

- run status
- UI list and detail queries
- append-only human corrections
- optional reusable table-template baselines

## 1.2 Immutability

Never modify the original OCR output after a reviewer changes a value.

Store:

- the original OCR result
- zero or more correction events
- an optional materialized reviewed table derived from those events

This preserves a trustworthy training history.

## 1.3 Replayability

Every execution must be reproducible from:

- `manifest.json`
- versioned code
- versioned configuration
- referenced S3 artifacts

## 1.4 Version all scoring behavior

Every result must record:

- pipeline version
- ruleset version
- anomaly algorithm version
- configuration version
- code artifact version or Git commit

---

# 2. AWS Resource Inventory

## 2.1 Core resources

| Resource | Purpose |
|---|---|
| Amazon S3 | Store source images, OCR artifacts, manifests, profiles, and quality results |
| Amazon EventBridge | Start the quality workflow when a completed manifest is created |
| AWS Step Functions Standard Workflow | Orchestrate the complete Step 2 quality pipeline |
| AWS Lambda | Perform bounded parsing, profiling, rules, anomaly, merge, and finalization tasks |
| Amazon DynamoDB `OcrRuns` | Operational run metadata and status |
| Amazon DynamoDB `CorrectionEvents` | Append-only human review and correction history |
| Amazon DynamoDB `ColumnBaselines` | Optional reusable cross-run statistics |
| Amazon API Gateway | UI-facing run, result, correction, and verification APIs |
| Amazon CloudWatch | Logs, metrics, alarms, and Step Functions execution visibility |
| AWS KMS | Encrypt S3 objects, DynamoDB tables, logs, and optional SQS queues |
| Amazon SQS DLQ | Capture EventBridge targets that cannot start the workflow |

## 2.2 Workflow type

Use a **Step Functions Standard Workflow** initially.

Reasons:

- durable execution history
- built-in retries and catches
- visual debugging
- execution redrive support
- natural fit for auditable document-processing jobs
- quality analysis is not expected to run at extremely high request rates

An Express Workflow can be reconsidered only if run volume becomes high enough that Standard transition pricing dominates and the reduced execution-history model is acceptable.

---

# 3. Step 1 — Canonical Logging and Human Corrections

## 3.1 Objectives

Step 1 is complete when the system can:

1. reconstruct any OCR run from S3
2. display the original image and extracted table
3. record every correction as an immutable event
4. distinguish unreviewed, corrected, and explicitly verified cells
5. produce reliable labels for future model training

---

## 3.2 Identifiers

### Run ID

Use UUIDv7 or ULID.

Example:

```text
01K1D36JHZ84H7A7GD6F68VY5V
```

### Table ID

```text
{run_id}:t{table_index}
```

Example:

```text
01K1D36JHZ84H7A7GD6F68VY5V:t0
```

### Cell ID

Use a stable coordinate identifier:

```text
r{row_index}_c{column_index}
```

For merged cells:

```text
r2_c3_rs2_cs1
```

### Correction event ID

Use UUIDv7 or ULID so events are naturally sortable.

---

## 3.3 S3 layout

```text
s3://ocr-quality-{account}-{region}-{environment}/
  runs/
    yyyy/
      mm/
        dd/
          {run_id}/
            manifest.json

            input/
              screenshot.png
              screenshot.metadata.json

            ocr/
              raw-output.json
              extracted.csv
              table-structure.json

            quality/
              v1/
                normalized-input.json
                column-profiles.json
                rule-results.json
                anomaly-results.json
                merged-quality.json
                execution-summary.json

            reviewed/
              materialized-table-v1.json
              materialized-table-v1.csv
```

Write `manifest.json` last. Its creation signals that all required OCR artifacts are available.

---

## 3.4 Manifest contract

```json
{
  "schema_version": "1.0",
  "run_id": "01K1D36JHZ84H7A7GD6F68VY5V",
  "created_at": "2026-07-31T03:05:00Z",
  "pipeline_version": "2026.07.1",
  "tenant_id": "league-main",
  "source": {
    "system": "halo-scoreboard-ocr",
    "request_id": "req_123",
    "document_type_hint": "halo3-postgame-carnage-report",
    "template_id_hint": null
  },
  "input": {
    "bucket": "ocr-quality-example-us-east-1-prod",
    "key": "runs/2026/07/31/{run_id}/input/screenshot.png",
    "sha256": "hex-digest",
    "content_type": "image/png",
    "width_px": 1920,
    "height_px": 1080
  },
  "ocr": {
    "engine": "custom",
    "engine_version": "3.4.0",
    "raw_output_key": "runs/.../ocr/raw-output.json",
    "extracted_csv_key": "runs/.../ocr/extracted.csv",
    "table_structure_key": "runs/.../ocr/table-structure.json"
  },
  "quality": {
    "requested_ruleset_version": "rules-v1",
    "requested_anomaly_version": "anomaly-v1",
    "config_version": "quality-config-v1"
  }
}
```

Prefer bucket and key fields over `s3://` strings inside application contracts. They map directly to AWS SDK calls and avoid URI parsing.

---

## 3.5 Screenshot metadata contract

```json
{
  "schema_version": "1.0",
  "sha256": "hex-digest",
  "content_type": "image/png",
  "width_px": 1920,
  "height_px": 1080,
  "orientation_degrees": 0,
  "capture_source": "browser-upload",
  "uploaded_at": "2026-07-31T03:05:00Z"
}
```

---

## 3.6 Normalized table contract

```json
{
  "schema_version": "1.0",
  "run_id": "01K1D36JHZ84H7A7GD6F68VY5V",
  "tables": [
    {
      "table_id": "01K1D36JHZ84H7A7GD6F68VY5V:t0",
      "page_index": 0,
      "table_index": 0,
      "bbox": {
        "x0": 0.10,
        "y0": 0.20,
        "x1": 0.90,
        "y1": 0.85,
        "unit": "relative"
      },
      "row_count": 9,
      "column_count": 8,
      "columns": [
        {
          "column_index": 0,
          "header_text": "Player",
          "header_bbox": {
            "x0": 0.10,
            "y0": 0.20,
            "x1": 0.25,
            "y1": 0.25,
            "unit": "relative"
          }
        }
      ],
      "cells": [
        {
          "cell_id": "r1_c0",
          "row_index": 1,
          "column_index": 0,
          "row_span": 1,
          "column_span": 1,
          "text": "PlayerOne",
          "normalized_text": "PlayerOne",
          "bbox": {
            "x0": 0.10,
            "y0": 0.26,
            "x1": 0.25,
            "y1": 0.31,
            "unit": "relative"
          },
          "ocr_confidence": 0.94,
          "tokens": [
            {
              "text": "PlayerOne",
              "confidence": 0.94
            }
          ]
        }
      ]
    }
  ]
}
```

The OCR system may emit its own format, but the quality pipeline must first normalize it into this stable internal contract.

---

## 3.7 `OcrRuns` DynamoDB table

### Primary key

```text
PK = TENANT#{tenant_id}
SK = RUN#{created_at}#{run_id}
```

### Attributes

```text
run_id
tenant_id
created_at
updated_at
status
manifest_bucket
manifest_key
document_type_hint
template_id
ocr_engine
ocr_engine_version
quality_version
quality_summary
error_code
error_message
execution_arn
```

### GSI1: direct run lookup

```text
GSI1PK = RUN#{run_id}
GSI1SK = RUN
```

### Recommended statuses

```text
OCR_COMPLETED
QUALITY_QUEUED
QUALITY_RUNNING
QUALITY_SUCCEEDED
QUALITY_FAILED_RETRYABLE
QUALITY_FAILED_TERMINAL
REVIEW_IN_PROGRESS
REVIEW_COMPLETED
```

Use conditional updates to prevent an old execution from overwriting a newer terminal status.

---

## 3.8 `CorrectionEvents` DynamoDB table

### Primary key

```text
PK = TABLE#{table_id}
SK = EVENT#{event_timestamp}#{event_id}
```

### Attributes

```text
event_id
tenant_id
run_id
table_id
cell_id
event_type
before_value
after_value
reason_code
reviewer_id
review_session_id
created_at
source_quality_version
source_ocr_version
```

### Event types

```text
CELL_CORRECTED
CELL_VERIFIED
CELL_UNVERIFIED
ROW_VERIFIED
TABLE_VERIFIED
CORRECTION_REVERTED
```

### Reason codes

```text
CHARACTER_SUBSTITUTION
MISSING_VALUE
EXTRA_VALUE
WRONG_ROW
WRONG_COLUMN
ROW_SPLIT
ROW_MERGE
COLUMN_SPLIT
COLUMN_MERGE
BAD_TABLE_BOUNDARY
BAD_CELL_BOUNDARY
FORMAT_NORMALIZATION
OTHER
```

### GSI1: run history

```text
GSI1PK = RUN#{run_id}
GSI1SK = EVENT#{event_timestamp}#{event_id}
```

### Important labeling rule

An unchanged cell is not automatically a positive training label.

A cell becomes a trustworthy positive label only when:

- explicitly verified
- included in a verified row
- included in a verified table
- sampled and independently audited under a defined QA policy

---

## 3.9 Correction API

### Create correction

```http
POST /v1/tables/{table_id}/corrections
```

Request:

```json
{
  "cell_id": "r3_c4",
  "before_value": "15",
  "after_value": "16",
  "reason_code": "CHARACTER_SUBSTITUTION",
  "review_session_id": "review_123",
  "source_quality_version": "quality-v1"
}
```

Requirements:

- authenticate reviewer
- retrieve the current materialized value
- reject stale `before_value` unless the client explicitly requests conflict resolution
- write one immutable correction event
- update or asynchronously rebuild the reviewed materialization

### Verify cell

```http
POST /v1/tables/{table_id}/verifications
```

```json
{
  "scope": "CELL",
  "cell_id": "r3_c4",
  "review_session_id": "review_123"
}
```

---

## 3.10 S3 and DynamoDB retention

Suggested starting policy:

- source screenshot: S3 Standard for 30 days, then Intelligent-Tiering
- raw OCR output: S3 Standard for 30 days, then Intelligent-Tiering
- normalized structure and quality output: retain indefinitely
- correction events: retain indefinitely
- incomplete multipart uploads: abort after 7 days
- noncurrent object versions: expire after a defined recovery window, such as 30–90 days

Do not move frequently viewed screenshots to archival storage while they remain part of the reviewer workflow.

---

# 4. Step 2 — Step Functions Quality State Machine

## 4.1 Objective

For each completed OCR manifest, the workflow must:

1. validate that the run is complete
2. claim the run idempotently
3. load and normalize table data
4. build column profiles
5. evaluate deterministic rules
6. evaluate statistical anomalies
7. merge all evidence into UI-facing cell scores
8. persist artifacts
9. update operational status
10. emit a completion or failure event

---

## 4.2 Trigger

Configure S3 to send object events to EventBridge.

EventBridge rule:

- source: `aws.s3`
- detail type: `Object Created`
- bucket: OCR artifact bucket
- key suffix: `/manifest.json`

Target:

- Step Functions state machine
- dead-letter queue: SQS
- retry policy: EventBridge target retry policy

The workflow should receive the S3 event, not the full manifest.

Example execution input:

```json
{
  "version": "0",
  "id": "event-id",
  "detail-type": "Object Created",
  "source": "aws.s3",
  "account": "123456789012",
  "time": "2026-07-31T03:05:01Z",
  "region": "us-east-1",
  "detail": {
    "bucket": {
      "name": "ocr-quality-example-us-east-1-prod"
    },
    "object": {
      "key": "runs/2026/07/31/{run_id}/manifest.json",
      "size": 1488,
      "etag": "etag"
    }
  }
}
```

---

## 4.3 State machine boundary

The state machine orchestrates coarse processing stages.

Lambda functions perform bounded computation.

Recommended Lambdas:

| Lambda | Responsibility |
|---|---|
| `ValidateManifestFn` | Read manifest, validate schema, check required keys and hashes |
| `NormalizeTablesFn` | Convert source-specific OCR structure to canonical table format |
| `BuildProfilesFn` | Infer column types and calculate robust statistics |
| `EvaluateRulesFn` | Run deterministic rules |
| `EvaluateAnomaliesFn` | Run within-table and optional historical anomaly checks |
| `MergeQualityFn` | Combine signals and calculate cell, row, and table review scores |
| `PublishCompletionFn` | Emit domain event or perform final side effects if direct integrations are insufficient |

Use native Step Functions AWS SDK integrations for DynamoDB, S3 metadata checks, and EventBridge publication when they keep the workflow clearer. Do not create Lambda wrappers solely to call one AWS API.

---

## 4.4 State machine flow

```text
EventBridge
   |
   v
ParseTrigger
   |
   v
LoadManifest
   |
   v
ValidateManifest
   |
   v
ClaimRun
   |
   +--> AlreadyCompleted ----------> SucceedNoOp
   |
   +--> Claimed
           |
           v
      MarkQualityRunning
           |
           v
      NormalizeTables
           |
           v
      BuildColumnProfiles
           |
           v
      ParallelQualityChecks
        /                 \
       v                   v
 EvaluateRules       EvaluateAnomalies
        \                 /
           v
      MergeQualityResults
           |
           v
      PersistExecutionSummary
           |
           v
      MarkQualitySucceeded
           |
           v
      EmitQualityCompleted
           |
           v
        Success

Any processing state
           |
           v
      CaptureFailure
           |
           v
      MarkQualityFailed
           |
           v
      EmitQualityFailed
           |
           v
          Fail
```

---

# 5. Detailed State Specification

## 5.1 `ParseTrigger`

Type: `Pass`

Responsibilities:

- extract bucket
- decode object key if necessary
- establish execution metadata
- record Step Functions execution ID
- produce a small workflow context

Output:

```json
{
  "manifest": {
    "bucket": "ocr-quality-example-us-east-1-prod",
    "key": "runs/.../manifest.json"
  },
  "execution": {
    "id": "...",
    "start_time": "..."
  }
}
```

Do not pass large table content through Step Functions state input or output. Pass S3 references.

---

## 5.2 `LoadManifest`

Type: AWS SDK integration or optimized S3 integration where applicable.

Responsibilities:

- retrieve the manifest from S3
- pass the manifest JSON to validation

Guardrail:

- enforce a small manifest size
- fail if the object is unexpectedly large or malformed

---

## 5.3 `ValidateManifest`

Type: Lambda Task

Checks:

- JSON Schema validity
- supported schema version
- run ID consistency with S3 prefix
- allowed tenant ID
- allowed OCR engine/version
- required artifact keys exist
- artifact bucket matches allowed bucket
- input SHA-256 format is valid
- requested quality versions are supported
- table structure object is present
- CSV object is present when required
- screenshot object is present

Output:

```json
{
  "valid": true,
  "run_id": "...",
  "tenant_id": "...",
  "manifest_bucket": "...",
  "manifest_key": "...",
  "table_structure": {
    "bucket": "...",
    "key": "..."
  },
  "quality": {
    "ruleset_version": "rules-v1",
    "anomaly_version": "anomaly-v1",
    "config_version": "quality-config-v1"
  },
  "output_prefix": "runs/.../quality/v1/"
}
```

---

## 5.4 `ClaimRun`

Type: DynamoDB `UpdateItem` AWS SDK integration

Purpose:

Prevent duplicate S3 events or retries from producing competing executions.

Conditional expression concept:

```text
attribute_not_exists(quality_version)
OR quality_version <> :requested_version
OR status IN (:retryable_failed_status)
```

Update:

```text
status = QUALITY_QUEUED
quality_version = quality-v1
execution_arn = current execution ARN
updated_at = now
```

Outcomes:

- condition succeeds: continue
- conditional check fails: route to `DetermineExistingRunState`

---

## 5.5 `DetermineExistingRunState`

Type: DynamoDB `GetItem`

Choice:

- already `QUALITY_SUCCEEDED` for same version → `SucceedNoOp`
- same execution already owns the run → continue safely
- another active execution owns the run → `SucceedNoOp`
- failed retryable → attempt conditional reclaim
- incompatible state → fail with `RunOwnershipConflict`

---

## 5.6 `MarkQualityRunning`

Type: DynamoDB `UpdateItem`

Condition:

- execution ARN equals current execution ARN
- current status equals `QUALITY_QUEUED`

Update:

```text
status = QUALITY_RUNNING
started_at = now
updated_at = now
```

---

## 5.7 `NormalizeTables`

Type: Lambda Task

Inputs:

- table structure S3 reference
- CSV S3 reference
- OCR engine
- OCR engine version
- output S3 reference

Responsibilities:

- normalize source-specific OCR artifacts
- assign stable table and cell IDs
- normalize coordinate system
- normalize null and whitespace handling
- preserve raw text and normalized text separately
- validate row and column indices
- detect duplicate or overlapping cell IDs
- produce a compact summary for the next state

Writes:

```text
quality/v1/normalized-input.json
```

Returns only:

```json
{
  "normalized_input": {
    "bucket": "...",
    "key": "...",
    "sha256": "..."
  },
  "table_count": 1,
  "cell_count": 72
}
```

---

## 5.8 `BuildColumnProfiles`

Type: Lambda Task

Responsibilities:

For each table and column:

- identify header and data rows
- count empty and non-empty values
- calculate parse success rates
- infer data type
- calculate length distribution
- calculate character-class distribution
- calculate robust numeric statistics where applicable
- derive table-level structural statistics

Candidate inferred types:

```text
INTEGER
DECIMAL
CURRENCY
PERCENT
DATE
TIME
DURATION
BOOLEAN
IDENTIFIER
PLAYER_NAME
FREE_TEXT
UNKNOWN
```

Write:

```text
quality/v1/column-profiles.json
```

Example:

```json
{
  "schema_version": "1.0",
  "profile_version": "profile-v1",
  "tables": [
    {
      "table_id": "...:t0",
      "columns": [
        {
          "column_index": 3,
          "header_text": "Kills",
          "inferred_type": "INTEGER",
          "inference_confidence": 0.99,
          "non_empty_count": 8,
          "parse_success_rate": 1.0,
          "length": {
            "median": 2,
            "mad": 0.5
          },
          "numeric": {
            "median": 12,
            "mad": 4,
            "minimum": 3,
            "maximum": 24
          },
          "character_classes": {
            "digit_ratio_median": 1.0,
            "alpha_ratio_median": 0.0
          }
        }
      ]
    }
  ]
}
```

### Type inference rule

Prefer an explicit schema associated with a recognized template.

Fallback inference:

1. evaluate all supported parsers
2. calculate parse success rate
3. apply header hints
4. choose a type only when confidence exceeds threshold
5. otherwise use `UNKNOWN` or `FREE_TEXT`

Do not infer from one or two non-empty cells unless a known template supplies the type.

---

## 5.9 `ParallelQualityChecks`

Type: `Parallel`

Branches:

1. deterministic rules
2. anomaly detection

This shortens elapsed time and preserves independent versioning.

Each branch reads normalized input and profiles from S3 and writes its own result.

---

# 6. Rules Branch

## 6.1 `EvaluateRules`

Type: Lambda Task

### Input

- normalized input S3 reference
- profile S3 reference
- ruleset version
- config version
- optional template schema reference

### Required rule families

#### Structural rules

| Rule ID | Condition | Default severity |
|---|---|---|
| `T001_ROW_COLUMN_COUNT` | Row shape conflicts with expected table width | High |
| `T002_DUPLICATE_CELL_ID` | Duplicate cell identifier | Critical |
| `T003_CELL_OVERLAP` | Bounding boxes overlap beyond tolerance | Medium |
| `T004_CELL_OUTSIDE_TABLE` | Cell box lies outside table boundary | High |
| `T005_MISSING_EXPECTED_COLUMN` | Known template column is absent | Critical |
| `T006_HEADER_DATA_MISALIGNMENT` | Header and data geometry are inconsistent | High |

#### Cell content rules

| Rule ID | Condition | Default severity |
|---|---|---|
| `C001_REQUIRED_EMPTY` | Required cell is empty | High |
| `C002_TYPE_PARSE_FAILURE` | Value cannot be parsed as expected type | High |
| `C003_CHARACTER_CLASS_MISMATCH` | Character composition conflicts with column profile | Medium |
| `C004_LENGTH_OUTLIER` | String length exceeds robust profile bounds | Medium |
| `C005_LOW_OCR_CONFIDENCE` | OCR confidence is below configured threshold | Low or Medium |
| `C006_HEADER_TYPE_CONFLICT` | Header semantics and value type conflict | High |
| `C007_ILLEGAL_VALUE` | Value violates an explicit allowed set | Critical |
| `C008_RANGE_VIOLATION` | Value violates a known business range | High |
| `C009_NORMALIZATION_AMBIGUITY` | Multiple plausible normalized values exist | Medium |
| `C010_SUSPICIOUS_GLYPH` | Likely OCR substitution such as `O/0`, `I/1`, `S/5` | Medium |

#### Halo-oriented business rules

These should live in a configurable template-specific rules module rather than in generic OCR code.

Examples:

| Rule ID | Condition |
|---|---|
| `H001_NEGATIVE_STAT` | Kills, assists, deaths, score, or medals are negative |
| `H002_TEAM_TOTAL_MISMATCH` | Displayed team total conflicts with sum of player values |
| `H003_DUPLICATE_PLAYER_ROW` | Same normalized player appears twice unexpectedly |
| `H004_INVALID_PLACEMENT` | Placement falls outside expected range |
| `H005_IMPOSSIBLE_RATIO` | A derived statistic cannot be reconciled with source values |
| `H006_ROSTER_SIZE_MISMATCH` | Player row count violates playlist or match rules |

### Rule output

Write:

```text
quality/v1/rule-results.json
```

Example:

```json
{
  "schema_version": "1.0",
  "ruleset_version": "rules-v1",
  "config_version": "quality-config-v1",
  "tables": [
    {
      "table_id": "...:t0",
      "cells": {
        "r3_c4": {
          "signals": [
            {
              "rule_id": "C002_TYPE_PARSE_FAILURE",
              "severity": "HIGH",
              "message_code": "EXPECTED_INTEGER",
              "evidence": {
                "raw_value": "I6",
                "expected_type": "INTEGER"
              },
              "score": 0.75
            }
          ]
        }
      },
      "table_signals": []
    }
  ]
}
```

Never put user-facing prose exclusively in stored results. Store a stable `message_code` and structured evidence so the UI can localize messages.

---

# 7. Anomaly Branch

## 7.1 `EvaluateAnomalies`

Type: Lambda Task

### Within-table signals

#### Numeric robust z-score

```text
robust_z = 0.6745 * (value - median) / MAD
```

Default flag threshold:

```text
abs(robust_z) >= 4.0
```

Handle `MAD = 0` explicitly:

- do not divide by zero
- compare against distinct-value distribution
- use exact deviation rules or an alternate scale estimate

#### String length anomaly

Calculate robust z-score over normalized string length.

#### Character composition anomaly

Compare:

- digit ratio
- letter ratio
- whitespace ratio
- punctuation ratio
- uppercase ratio

against the column profile.

#### Date anomaly

Examples:

- outside known match date window
- future date beyond tolerance
- one value on a different year or month than all peers
- invalid chronology between related fields

#### Geometry anomaly

Examples:

- unusual cell width or height
- horizontal center far from column center
- baseline offset relative to row peers
- OCR tokens extending beyond the cell box

### Historical baseline signals

When `template_id` is known, optionally compare against `ColumnBaselines`.

Baseline key:

```text
PK = TEMPLATE#{template_id}
SK = COLUMN#{stable_column_key}
```

Store mergeable statistics rather than raw history where possible.

Suggested attributes:

```text
observation_count
empty_rate
parse_success_rate
length_quantiles
numeric_quantiles
character_class_quantiles
bbox_width_quantiles
bbox_height_quantiles
updated_at
baseline_version
```

Do not update historical baselines from unverified OCR output by default. Prefer:

- reviewed tables
- explicitly verified cells
- high-confidence audited samples

### Anomaly output

Write:

```text
quality/v1/anomaly-results.json
```

Example:

```json
{
  "schema_version": "1.0",
  "anomaly_version": "anomaly-v1",
  "tables": [
    {
      "table_id": "...:t0",
      "cells": {
        "r5_c3": {
          "signals": [
            {
              "signal_id": "A001_NUMERIC_ROBUST_Z",
              "score": 0.62,
              "evidence": {
                "value": 98,
                "median": 12,
                "mad": 4,
                "robust_z": 14.5,
                "threshold": 4.0
              }
            }
          ]
        }
      }
    }
  ]
}
```

---

# 8. Merge and Scoring

## 8.1 `MergeQualityResults`

Type: Lambda Task

Inputs:

- normalized input
- profiles
- rule results
- anomaly results
- scoring configuration

Writes:

```text
quality/v1/merged-quality.json
```

---

## 8.2 Distinguish score types

Do not label the initial heuristic output as a statistically calibrated probability.

Expose:

- `suspicion_score`: deterministic composite from 0 to 1
- `review_priority`: `NONE`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`
- `needs_review`: Boolean
- `reasons`: structured signals

Reserve names such as `p_correct` and `confidence_interval` for the later calibrated supervised model.

---

## 8.3 Suggested v1 scoring

Convert independent evidence into a combined suspicion score:

```text
combined = 1 - product(1 - signal_score_i)
```

This behaves better than simple addition:

- multiple weak signals increase concern
- the score never exceeds 1
- one high signal remains high
- signals retain independent explanations

Suggested default signal scores:

| Severity | Score |
|---|---:|
| Critical | 0.98 |
| High | 0.75 |
| Medium | 0.40 |
| Low | 0.15 |

Avoid counting strongly correlated signals twice. Define correlation groups such as:

```text
TYPE_PARSE
CHARACTER_COMPOSITION
LENGTH
OCR_CONFIDENCE
NUMERIC_DISTRIBUTION
GEOMETRY
BUSINESS_CONSTRAINT
```

Within a group, use the maximum signal score. Across groups, use the combined formula.

---

## 8.4 Review priority

```text
CRITICAL: any critical rule
HIGH: suspicion_score >= 0.75
MEDIUM: suspicion_score >= 0.45
LOW: suspicion_score >= 0.20
NONE: otherwise
```

`needs_review` defaults to true for `MEDIUM`, `HIGH`, and `CRITICAL`.

Thresholds must be configuration, not hard-coded constants.

---

## 8.5 Row score

Two useful row measures:

```text
row_max_suspicion = max(cell suspicion)
row_expected_issue_count = sum(cell suspicion)
```

For v1 UI ranking, sort rows by:

1. critical signal presence
2. maximum cell suspicion
3. expected issue count

---

## 8.6 Table score

Expose:

```json
{
  "flagged_cell_count": 4,
  "critical_cell_count": 1,
  "mean_suspicion": 0.13,
  "max_suspicion": 0.98,
  "estimated_issue_count": 2.41,
  "review_priority": "CRITICAL"
}
```

`estimated_issue_count` is a heuristic until probabilities are calibrated. Label it accordingly in the UI.

---

## 8.7 UI result contract

```json
{
  "schema_version": "1.0",
  "quality_version": "quality-v1",
  "run_id": "...",
  "generated_at": "2026-07-31T03:05:10Z",
  "tables": [
    {
      "table_id": "...:t0",
      "summary": {
        "cell_count": 72,
        "flagged_cell_count": 4,
        "critical_cell_count": 1,
        "max_suspicion": 0.98,
        "review_priority": "CRITICAL"
      },
      "cells": {
        "r3_c4": {
          "raw_value": "I6",
          "normalized_value": "I6",
          "suspicion_score": 0.91,
          "review_priority": "HIGH",
          "needs_review": true,
          "signals": [
            {
              "source": "RULE",
              "id": "C002_TYPE_PARSE_FAILURE",
              "severity": "HIGH",
              "message_code": "EXPECTED_INTEGER",
              "evidence": {
                "expected_type": "INTEGER"
              }
            },
            {
              "source": "RULE",
              "id": "C010_SUSPICIOUS_GLYPH",
              "severity": "MEDIUM",
              "message_code": "LIKELY_I_TO_ONE"
            }
          ]
        }
      }
    }
  ]
}
```

---

# 9. Finalization States

## 9.1 `PersistExecutionSummary`

Type: S3 integration or Lambda Task

Write:

```text
quality/v1/execution-summary.json
```

Include:

```text
execution ARN
execution start and end timestamps
run ID
quality version
input artifact hashes
output artifact hashes
table count
cell count
flag counts
ruleset version
anomaly version
config version
code version
```

---

## 9.2 `MarkQualitySucceeded`

Type: DynamoDB `UpdateItem`

Condition:

- current execution owns the run

Update:

```text
status = QUALITY_SUCCEEDED
quality_result_bucket
quality_result_key
quality_summary
completed_at
updated_at
```

---

## 9.3 `EmitQualityCompleted`

Type: EventBridge `PutEvents` AWS SDK integration

Event detail type:

```text
OCR Quality Assessment Completed
```

Detail:

```json
{
  "tenant_id": "league-main",
  "run_id": "...",
  "quality_version": "quality-v1",
  "result": {
    "bucket": "...",
    "key": "runs/.../quality/v1/merged-quality.json"
  },
  "summary": {
    "flagged_cell_count": 4,
    "review_priority": "HIGH"
  }
}
```

Potential consumers:

- WebSocket/SSE notification service
- UI cache projector
- analytics ingestion
- later ML training dataset builder

---

# 10. Failure Handling

## 10.1 Retry policy

For Lambda Tasks:

```json
{
  "ErrorEquals": [
    "Lambda.ServiceException",
    "Lambda.AWSLambdaException",
    "Lambda.SdkClientException",
    "States.TaskFailed"
  ],
  "IntervalSeconds": 2,
  "BackoffRate": 2.0,
  "MaxAttempts": 4
}
```

Do not retry known validation errors.

Classify errors:

```text
VALIDATION_ERROR
UNSUPPORTED_SCHEMA
MISSING_ARTIFACT
CORRUPT_ARTIFACT
TRANSIENT_AWS_ERROR
QUALITY_PROCESSING_ERROR
OUTPUT_WRITE_ERROR
RUN_OWNERSHIP_CONFLICT
```

---

## 10.2 Catch behavior

Every processing state routes terminal errors to a common `CaptureFailure` state.

Capture:

- failed state name
- error type
- sanitized cause
- execution ARN
- run ID
- retryability
- timestamp

Avoid storing secrets, signed URLs, or full sensitive payloads in the cause.

---

## 10.3 `MarkQualityFailed`

Type: DynamoDB `UpdateItem`

Update to:

- `QUALITY_FAILED_RETRYABLE`, or
- `QUALITY_FAILED_TERMINAL`

Include:

```text
error_code
error_message
failed_state
execution_arn
failed_at
```

---

## 10.4 `EmitQualityFailed`

Type: EventBridge `PutEvents`

Event detail type:

```text
OCR Quality Assessment Failed
```

Use this event for:

- alarms
- operational dashboards
- optional manual replay tools

---

# 11. State Machine Skeleton

The following is an illustrative Amazon States Language skeleton. Exact paths should be adapted to the implementation language and selected JSONPath or JSONata conventions.

```json
{
  "Comment": "OCR deterministic quality assessment",
  "StartAt": "ParseTrigger",
  "States": {
    "ParseTrigger": {
      "Type": "Pass",
      "Next": "LoadManifest"
    },
    "LoadManifest": {
      "Type": "Task",
      "Resource": "arn:aws:states:::aws-sdk:s3:getObject",
      "Next": "ValidateManifest",
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.failure",
          "Next": "CaptureFailure"
        }
      ]
    },
    "ValidateManifest": {
      "Type": "Task",
      "Resource": "${ValidateManifestFunctionArn}",
      "Retry": [
        {
          "ErrorEquals": [
            "Lambda.ServiceException",
            "Lambda.AWSLambdaException",
            "Lambda.SdkClientException"
          ],
          "IntervalSeconds": 2,
          "BackoffRate": 2,
          "MaxAttempts": 4
        }
      ],
      "Next": "ClaimRun",
      "Catch": [
        {
          "ErrorEquals": ["ValidationError", "States.ALL"],
          "ResultPath": "$.failure",
          "Next": "CaptureFailure"
        }
      ]
    },
    "ClaimRun": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:updateItem",
      "Next": "MarkQualityRunning",
      "Catch": [
        {
          "ErrorEquals": ["DynamoDB.ConditionalCheckFailedException"],
          "Next": "DetermineExistingRunState"
        },
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.failure",
          "Next": "CaptureFailure"
        }
      ]
    },
    "DetermineExistingRunState": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:getItem",
      "Next": "ExistingRunChoice"
    },
    "ExistingRunChoice": {
      "Type": "Choice",
      "Choices": [
        {
          "Variable": "$.existing.status",
          "StringEquals": "QUALITY_SUCCEEDED",
          "Next": "SucceedNoOp"
        }
      ],
      "Default": "CaptureOwnershipConflict"
    },
    "MarkQualityRunning": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:updateItem",
      "Next": "NormalizeTables"
    },
    "NormalizeTables": {
      "Type": "Task",
      "Resource": "${NormalizeTablesFunctionArn}",
      "Next": "BuildColumnProfiles",
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.failure",
          "Next": "CaptureFailure"
        }
      ]
    },
    "BuildColumnProfiles": {
      "Type": "Task",
      "Resource": "${BuildProfilesFunctionArn}",
      "Next": "ParallelQualityChecks",
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.failure",
          "Next": "CaptureFailure"
        }
      ]
    },
    "ParallelQualityChecks": {
      "Type": "Parallel",
      "Branches": [
        {
          "StartAt": "EvaluateRules",
          "States": {
            "EvaluateRules": {
              "Type": "Task",
              "Resource": "${EvaluateRulesFunctionArn}",
              "End": true
            }
          }
        },
        {
          "StartAt": "EvaluateAnomalies",
          "States": {
            "EvaluateAnomalies": {
              "Type": "Task",
              "Resource": "${EvaluateAnomaliesFunctionArn}",
              "End": true
            }
          }
        }
      ],
      "Next": "MergeQualityResults",
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.failure",
          "Next": "CaptureFailure"
        }
      ]
    },
    "MergeQualityResults": {
      "Type": "Task",
      "Resource": "${MergeQualityFunctionArn}",
      "Next": "PersistExecutionSummary",
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.failure",
          "Next": "CaptureFailure"
        }
      ]
    },
    "PersistExecutionSummary": {
      "Type": "Task",
      "Resource": "${PersistSummaryFunctionArn}",
      "Next": "MarkQualitySucceeded"
    },
    "MarkQualitySucceeded": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:updateItem",
      "Next": "EmitQualityCompleted"
    },
    "EmitQualityCompleted": {
      "Type": "Task",
      "Resource": "arn:aws:states:::events:putEvents",
      "Next": "Success"
    },
    "CaptureOwnershipConflict": {
      "Type": "Pass",
      "Next": "CaptureFailure"
    },
    "CaptureFailure": {
      "Type": "Pass",
      "Next": "MarkQualityFailed"
    },
    "MarkQualityFailed": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:updateItem",
      "Next": "EmitQualityFailed"
    },
    "EmitQualityFailed": {
      "Type": "Task",
      "Resource": "arn:aws:states:::events:putEvents",
      "Next": "Failure"
    },
    "SucceedNoOp": {
      "Type": "Succeed"
    },
    "Success": {
      "Type": "Succeed"
    },
    "Failure": {
      "Type": "Fail",
      "Error": "OcrQualityAssessmentFailed"
    }
  }
}
```

---

# 12. Large-Table Strategy

Start with one invocation per pipeline stage for ordinary screenshots.

Use a Step Functions `Map` state only when profiling shows that a single Lambda is no longer adequate.

Possible evolution:

```text
NormalizeTables
   |
   v
Map tables
   |
   +--> Build profile
   +--> Evaluate rules
   +--> Evaluate anomalies
   +--> Merge table result
   |
   v
Merge document result
```

Use Inline Map for modest table counts.

Use Distributed Map only for genuinely large datasets or bulk backfills because it adds operational and pricing complexity.

Do not create one state transition per cell for normal OCR tables.

---

# 13. Configuration

Store versioned configuration in S3:

```text
config/
  quality-config-v1.json
  templates/
    halo3-postgame-carnage-report-v1.json
```

Example:

```json
{
  "schema_version": "1.0",
  "quality_version": "quality-v1",
  "thresholds": {
    "ocr_confidence_low": 0.70,
    "numeric_robust_z": 4.0,
    "length_robust_z": 4.0,
    "review_medium": 0.45,
    "review_high": 0.75
  },
  "severity_scores": {
    "CRITICAL": 0.98,
    "HIGH": 0.75,
    "MEDIUM": 0.40,
    "LOW": 0.15
  }
}
```

Configuration changes require a new immutable config version.

Do not mutate `quality-config-v1.json` after it has been used. Publish `quality-config-v2.json`.

---

# 14. UI Integration

## 14.1 Run detail API

```http
GET /v1/runs/{run_id}
```

Returns:

- signed screenshot URL or CloudFront-authenticated asset URL
- original extracted table
- quality result
- correction materialization
- review status

## 14.2 Recommended comparison UI

For each cell:

- original OCR value
- current reviewed value
- suspicion heat indicator
- review priority
- structured reasons
- image bounding-box highlight on hover
- correction control
- verify control

Views:

- all cells
- flagged only
- critical/high only
- unverified only
- corrected only

## 14.3 Reviewer behavior capture

Track:

- correction
- explicit verification
- correction reversion
- reviewer session
- source quality version

Do not infer verification merely because the user opened the page.

---

# 15. Observability

## 15.1 Metrics

Emit custom metrics:

```text
QualityRunsStarted
QualityRunsSucceeded
QualityRunsFailed
QualityRunDuration
TablesProcessed
CellsProcessed
CellsFlagged
CriticalCellsFlagged
ManifestValidationFailures
DuplicateExecutionsSuppressed
CorrectionEventsCreated
VerificationEventsCreated
```

Dimensions:

```text
Environment
DocumentType
QualityVersion
OCRVersion
```

Avoid high-cardinality dimensions such as run ID or tenant ID in CloudWatch metrics.

## 15.2 Alarms

Create alarms for:

- workflow failure rate
- p95 execution duration
- EventBridge DLQ depth
- Lambda throttles
- Lambda error rate
- DynamoDB throttles
- manifest validation failure spike
- quality completion event delivery failure

## 15.3 Logging

Use structured JSON logs with:

```text
run_id
tenant_id
execution_arn
state_name
function_name
quality_version
duration_ms
error_code
```

Never log full screenshots, raw tables, credentials, signed URLs, or personal data unnecessarily.

---

# 16. Security

## 16.1 S3

- block public access
- use KMS encryption
- require TLS
- scope IAM to relevant prefixes
- use CloudFront signed URLs or short-lived S3 presigned URLs for UI images
- validate object keys to prevent cross-tenant access

## 16.2 Step Functions role

Grant only:

- read manifest and required OCR keys
- read immutable config
- write designated quality prefix
- update specific DynamoDB tables and attributes
- invoke specific Lambda functions
- publish specific EventBridge event sources
- use the designated KMS keys

## 16.3 Lambda roles

Each function gets only the S3 prefixes and DynamoDB operations it needs.

Do not share one broad execution role across every Lambda.

## 16.4 Tenant isolation

Every API request must derive tenant identity from authentication, not from a client-provided tenant field.

Validate that:

- run belongs to tenant
- table belongs to run
- S3 prefix belongs to tenant or authorized league boundary
- correction event uses the authenticated reviewer identity

---

# 17. AWS CDK Implementation Structure

Use AWS CDK v2 with typed Python.

Suggested repository:

```text
infra/
  app.py
  stacks/
    storage_stack.py
    data_stack.py
    quality_compute_stack.py
    api_stack.py
    observability_stack.py
  constructs/
    encrypted_bucket.py
    quality_state_machine.py
    lambda_function.py
    alarms.py

services/
  quality/
    common/
      contracts.py
      errors.py
      s3_io.py
      scoring.py
    validate_manifest/
      handler.py
    normalize_tables/
      handler.py
    build_profiles/
      handler.py
    evaluate_rules/
      handler.py
    evaluate_anomalies/
      handler.py
    merge_quality/
      handler.py
    persist_summary/
      handler.py

schemas/
  manifest.schema.json
  normalized-table.schema.json
  rule-results.schema.json
  anomaly-results.schema.json
  merged-quality.schema.json

config/
  quality-config-v1.json
  templates/
    halo3-postgame-carnage-report-v1.json

tests/
  unit/
  contract/
  integration/
  fixtures/
```

---

# 18. Testing Strategy

## 18.1 Unit tests

Test:

- each parser
- type inference
- MAD zero handling
- every rule
- scoring correlation groups
- correction materialization
- idempotency conditions
- malformed bounding boxes
- missing and empty values
- suspicious glyph detection

## 18.2 Golden-file tests

Maintain representative fixtures:

```text
screenshot
raw OCR output
expected normalized table
expected profiles
expected rule results
expected anomaly results
expected merged result
```

Golden tests are especially important because OCR quality logic can regress subtly.

## 18.3 State machine integration tests

Test:

- successful execution
- duplicate manifest event
- missing artifact
- unsupported schema
- Lambda transient failure and retry
- terminal rule-processing failure
- DynamoDB ownership conflict
- EventBridge completion event
- failure status update
- execution redrive

## 18.4 UI acceptance tests

Verify:

- hovering a cell highlights the correct screenshot area
- flagged-only filtering works
- correction writes an immutable event
- verification writes an immutable event
- stale edit conflicts are handled
- reloading reconstructs the reviewed value correctly

---

# 19. Delivery Phases

## Phase 1 — Contracts and storage

Deliver:

- S3 bucket and lifecycle
- KMS keys
- DynamoDB tables and GSIs
- JSON Schemas
- manifest writer
- correction and verification APIs
- basic run-detail API

Acceptance:

- any OCR run can be reconstructed
- corrections are append-only
- verified cells are distinguishable from merely untouched cells

## Phase 2 — Workflow skeleton

Deliver:

- EventBridge S3 rule
- Step Functions Standard Workflow
- idempotent run claiming
- status transitions
- common retry and failure path
- completion and failure events

Acceptance:

- duplicate S3 events do not create duplicate outputs
- execution history clearly shows every stage
- failures update the run record

## Phase 3 — Normalization and profiles

Deliver:

- normalizer Lambda
- canonical table output
- column profiler
- golden fixtures

Acceptance:

- every supported OCR result maps to the canonical contract
- profiling is deterministic for identical inputs

## Phase 4 — Rules

Deliver:

- generic rules engine
- configuration loading
- first Halo-specific template rules
- rule result schema

Acceptance:

- seeded OCR errors produce expected rule IDs
- UI can display structured reasons

## Phase 5 — Anomaly detection

Deliver:

- within-table robust statistics
- string and geometry anomalies
- optional verified historical baseline read
- anomaly output schema

Acceptance:

- known numeric, length, character, and geometry outliers are flagged
- zero-MAD and small-sample cases are safe

## Phase 6 — Merge and UI integration

Deliver:

- merged scoring
- row/table summaries
- result API
- screenshot overlays and filters
- correction/verification feedback loop

Acceptance:

- reviewer can move from flag to screenshot evidence to correction in one interaction
- every reviewer action is auditable

## Phase 7 — Operational hardening

Deliver:

- alarms
- dashboards
- DLQ handling
- replay tooling
- load tests
- security review
- cost dashboard

Acceptance:

- failed runs can be safely replayed
- operational alerts identify actionable failure modes
- IAM policies pass least-privilege review

---

# 20. Definition of Done

## Step 1

Step 1 is done when:

- every completed OCR run has an immutable manifest
- required OCR and input artifacts are addressable from the manifest
- every table and cell has a stable ID
- corrections and verification actions are append-only
- reviewed output can be rebuilt entirely from original OCR plus events
- untouched and explicitly verified values are not conflated

## Step 2

Step 2 is done when:

- manifest creation starts a Standard Step Functions execution
- duplicate triggers are idempotently suppressed
- normalization, profiling, rules, anomalies, merge, and finalization are separate visible workflow stages
- rules and anomalies execute in parallel
- every output is versioned and written to S3
- the UI receives per-cell suspicion, priority, and reasons
- failures update run status and emit a failure event
- retries occur only for retryable failures
- representative golden and integration tests pass
- the system does not claim that heuristic suspicion is a calibrated probability

---

# 21. Later ML Compatibility

This design intentionally creates the future supervised-learning record:

```text
image crop
OCR text
OCR confidence
geometry
column profile
rule signals
anomaly signals
template
human correction
explicit verification
reviewer metadata
```

The later model can train on verified examples, calibrate `P(correct)`, and replace or augment the heuristic `suspicion_score` without changing the OCR ingestion, correction event, or UI artifact contracts.

---

# 22. Official AWS References

- AWS Step Functions service integrations: https://docs.aws.amazon.com/step-functions/latest/dg/integrate-services.html
- AWS SDK integrations in Step Functions: https://docs.aws.amazon.com/step-functions/latest/dg/supported-services-awssdk.html
- Starting Step Functions from S3 events through EventBridge: https://docs.aws.amazon.com/step-functions/latest/dg/tutorial-cloudwatch-events-s3.html
- Amazon S3 EventBridge integration: https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventBridge.html
- Step Functions error handling: https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html
- Step Functions workflow types: https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html
- Step Functions Map state: https://docs.aws.amazon.com/step-functions/latest/dg/state-map.html
