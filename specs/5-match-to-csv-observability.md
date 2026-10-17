# Match-to-CSV observability: Technical Specification

**Status:** Draft

**Version:** 1.3-draft

**Date:** October 15, 2026

**Component:** `applications/match-to-csv` (Lambdas, `src/lib/log.ts`, `src/lib/metrics.ts`, CDK stack), `packages/contracts`, and the local deployer policy template in `docs/self-hosting/policies/`

**Runtime:** TypeScript on the Node.js Lambda runtime the stack already uses, ARM64

**Deployment:** the existing match-to-csv CDK stack, one per environment plus ephemeral developer stacks

**Telemetry services:** CloudWatch Logs with embedded metric format (EMF), CloudWatch Logs Insights, CloudWatch metrics, alarms and one dashboard, and the X-Ray active tracing the stack already enables

**Persistent state:** none added. Log groups and metrics are application resources owned by the CDK stack. The S3 evidence events stay the durable record of what happened to an input.

**External dependencies at runtime:** none added. EMF needs no CloudWatch API call or permission.

**Out of scope:** tail sampling, an OpenTelemetry collector, a state store or status table for uploads, Lambda Insights, CloudWatch Application Signals, high-resolution metrics, log metric filters, anomaly-detection alarms, any user-facing progress UI, and any metric, alarm, saved query or dashboard in an ephemeral stack.

The operator of match-to-csv needs to answer three questions without a full-stack application: what happened to one emailed submission, where each recent upload is now, and whether the pipeline is slow or producing poor OCR. This spec answers them with one structured log record per pipeline stage. In dev and prod the record is also a CloudWatch metric (through EMF). Logs Insights queries join the records by submission and by Step Functions execution. The design adds nine custom metrics and two alarms, so its fixed cost is a few dollars a month. Ephemeral developer stacks only write the log records, and developers read them with a scoped grant on the local deployer permission set.

---

## 1. Resolved requirement decisions

| Requirement | Decision | Reason |
| --- | --- | --- |
| Distributed tracing without tail sampling | Every stage writes one wide event (§6). `submissionId` is the trace ID, `screenshotId` and `runId` are span IDs, `executionId` groups one execution, and Logs Insights reassembles the trace (§8). X-Ray stays on and each event records the X-Ray trace ID. | Tail sampling needs a collector to buffer whole traces. At this volume X-Ray's default sampling records nearly every request within the free tier, so the logs only need a pointer to it. |
| Show the progress of uploads | Computed at query time per Step Functions execution (§8.1, Q2). An execution is complete only when every expected screenshot has a successful export. Step Functions failure records mark executions that ended without one. | A state store would duplicate the S3 evidence events and need its own writes, permissions and consistency rules. |
| One event per stage, including replay | Replay runs the same `extract-text` and `write-extracted-csv` Lambdas, so replay is recorded as `workflow: "REPLAY"` on their events, not as a fourth `Stage` value. | Keeps the `Stage` dimension aligned with the Lambda that emits it. Replays still separate in every query by `workflow`. |
| Metric dimensions | New metrics use the single dimension set `[["Stage"]]`. IDs, reason codes, error names and `workflow` are event fields and never dimensions. | CloudWatch bills each metric name and dimension combination as one custom metric. A high-cardinality dimension creates one billed metric per value. |
| Ephemeral stacks | Log only. They write the same stage events without an `_aws` block, and write no `ExtractedRows` or `ZeroRowExtractions` record. They get no alarms, saved queries or dashboard. | Ephemeral stacks share the dev account and region, so their samples would merge into the stable dev stack's `Stage`-dimensioned metrics and alarms. Developers need the logs, not metrics. |
| Developer access to ephemeral logs | The `MccStatsSuiteLocalCdkDeploy` policy template gains read and query access to `match-to-csv-e-*` log groups only (§8.2). | The template grants no CloudWatch Logs access today, so developers cannot tail or query their own stacks. Scoping to the ephemeral prefix keeps stable dev logs out of reach. |
| Existing `ExtractedRows` and `ZeroRowExtractions` metrics | Unchanged in dev and prod. They keep the `FunctionName` dimension, so the zero-row alarm and its history keep working. | Changing their dimension would break the zero-row alarm for no gain. |
| Step Functions logging | The ingest workflow logs at `ERROR` with `includeExecutionData: false`. The Infrequent Access log class is not used. | `ALL` with execution data logs every transition's payload, including every extracted row, and is the largest log volume in the stack. `ERROR` still records the execution failure, timeout and abort events Q2 reads. The class cannot be changed on an existing log group, and at `ERROR` the volume is too small for its discount to matter. |
| Log format | Lambdas use the JSON log format with application log level `INFO` and system log level `INFO`. | Platform records become structured JSON. `INFO` keeps the `platform.report` record that Q6 reads. |
| End-to-end latency | Measured from the time EventBridge reports the raw email object was created to the time `write-extracted-csv` stores the CSV. | That is the delay the sender sees, apart from SES delivery. `process-email`'s own `receivedAt` excludes EventBridge and Step Functions start-up time. |

**Additional capabilities included:** saved Logs Insights query definitions and a dashboard in dev and prod.

## 2. Goals and non-goals

### 2.1 Goals

1. Given a `submissionId` or an execution ID, one Logs Insights query lists every stage that handled it, in order, with outcome, duration, run IDs, error names and rejection codes.
2. One query gives each recent execution a status of `COMPLETE`, `REJECTED`, `FAILED` or `IN_PROGRESS`. `COMPLETE` requires a successful export for every expected screenshot, whatever order the branches finish in.
3. CloudWatch alarms fire when end-to-end latency or mean OCR confidence degrades, in addition to the existing failure alarms.
4. The design adds at most 10 custom metrics and 2 alarms, and reduces log ingestion compared with the current stack.
5. Ephemeral developer stacks write the same events as logs and nothing else, and a developer with the `mcc-dev` profile can tail and query them.

### 2.2 Non-goals

- Request-level sampling decisions. Every invocation logs its event.
- A durable or queryable status API. Logs expire with their retention (§13.3), and the S3 evidence events remain the system of record.
- Telemetry for `compare-runs` and `materialize-training-data`. They are operator tools invoked by hand, and their Lambda `Errors` alarms already exist (§20, backlog).
- Exactly-once events. A retried Lambda attempt emits its own event (§7.2).
- Developer access to metrics, X-Ray, stable dev logs or prod logs.

## 3. Runtime architecture

```text
SES -> raw email bucket -> EventBridge (Object Created, adds receivedAt = $.time)
  |
  v
Step Functions ingest workflow (each task payload adds trace context)
  +-- process-email        -> stage event, Stage=process-email
  +-- Map (concurrency 2)
       +-- extract-text    -> stage event, Stage=extract
       +-- write-csv       -> stage event, Stage=write-csv
  +-- workflow log group (ERROR: ExecutionFailed, ExecutionTimedOut, ExecutionAborted)
  |
  v
Lambda log groups (/aws/lambda/<prefix>-<Function>)
  +-- Logs Insights   -> queries Q1..Q6 (saved in dev and prod)
  +-- EMF extraction, dev and prod only -> MCC/MatchToCsv metrics -> alarms, dashboard

Replay workflow -> extract-text, write-csv (trace.workflow = REPLAY)
X-Ray: Lambda and Step Functions segments, linked from events by xrayTraceId
```

**Ownership rules:** only `src/lib/metrics.ts` builds stage events and EMF blocks, and only `src/lib/log.ts` and `src/lib/metrics.ts` write to stdout. Handlers call them with injected writers, as `publishExtractionMetrics` does today. The CDK stack owns every telemetry resource. OpenTofu owns none.

**Packaging:** `TraceContext` and the new optional fields live in `packages/contracts` (§10). No new workspace or dependency. EMF records are built by hand, as today, rather than with `aws-embedded-metrics`.

### 3.1 Execution policy

- Each Lambda invocation writes exactly one stage event, on success and on failure, before it returns or rethrows. This includes failures before `submissionId` exists, such as a raw email read, MIME parse or SSM read failure.
- Metrics are on unless `EMF_METRICS_ENABLED` is exactly `false`. When it is `false`, the event has no `_aws` block and no metric members, and `publishExtractionMetrics` writes nothing. The CDK stack sets `false` in ephemeral stacks only. Dev and prod leave it unset, so functions deployed before the variable exists keep publishing `ExtractedRows` and `ZeroRowExtractions`, and no slice can silence them on its own.
- A failure to build or write the event never fails the invocation. The handler catches it and logs an `ERROR` line.
- Telemetry never changes evidence. Events are not written to S3, and no evidence write depends on telemetry.
- Events never contain screenshot bytes, OCR text, extracted rows, email bodies, subjects, sender addresses or recipient addresses (§14).

## 4. External interface

### 4.1 Trace context inputs

The CDK stack adds these fields to each Lambda task payload. Direct invocations, such as tests and manual replays, may omit them, and the event then omits the matching fields.

| Field | Set by | Value |
| --- | --- | --- |
| `receivedAt` on the `process-email` input | EventBridge rule input | `$.time` of the `Object Created` event, ISO 8601 |
| `trace.executionId` | each `LambdaInvoke` payload | `$$.Execution.Id`, the execution ARN |
| `trace.retryCount` | each `LambdaInvoke` payload | `$$.State.RetryCount` |
| `trace.workflow` | each `LambdaInvoke` payload | `INGEST` in the ingest workflow, `REPLAY` in the replay workflow |

`process-email` copies `receivedAt` into every `SourceScreenshot` it emits, so later stages and replays carry it.

### 4.2 Outputs

The outputs are log records (§6), metrics (§7), saved queries (§8), alarms (§9.1) and a dashboard (§9.2). Handler return values change only by carrying `trace` through to the next task where §11 says so.

## 5. Identifiers

| Identifier | Created by | Role in the trace |
| --- | --- | --- |
| `submissionId` | `process-email` | Trace ID. Present on every event once `process-email` has assigned it. |
| `executionId` | Step Functions | Groups every event of one ingest execution, including a `process-email` failure before `submissionId` exists. Equals the `execution_arn` field of Step Functions log records. |
| `screenshotId` | `process-email`, one per accepted attachment | Span ID for one screenshot's branch of the `Map`. |
| `runId` | `extract-text`, one per processing run | Attempt ID. A replay creates a new `runId` for the same `screenshotId`. |
| `xrayTraceId` | Lambda runtime (`_X_AMZN_TRACE_ID`, the `Root=` value) | Links to the X-Ray trace map for the invocation. |
| `requestId` | Lambda context (`awsRequestId`) | Links to the invocation's other log lines and its `platform.report` record. |

## 6. Stage event

### 6.1 Fields

Every event is one JSON line. In dev and prod it also carries an `_aws` EMF block (§7.1). Fields that do not apply are omitted, not null.

| Field | Type | Stages | Meaning |
| --- | --- | --- | --- |
| `event` | `"stage.completed"` | all | Fixed value, the filter every query starts with |
| `schemaVersion` | `"stage-event/v1"` | all | Version of this record |
| `Stage` | `process-email` \| `extract` \| `write-csv` | all | The only metric dimension |
| `workflow` | `INGEST` \| `REPLAY` | all, when `trace` is present | Which state machine invoked the Lambda |
| `outcome` | `OK` \| `REJECTED` \| `ERROR` | all | `REJECTED` only when the whole submission is rejected. A submission with some rejected attachments and at least one accepted screenshot is `OK`. |
| `env` | string | all | `DEPLOYMENT_ENVIRONMENT`, such as `DEV` or `PROD`. Ephemeral stacks are told apart by log group. |
| `gitSha` | string | all | The build SHA already passed to `extract-text`, now passed to every function |
| `submissionId`, `screenshotId`, `runId` | string | where known | §5 |
| `executionId`, `retryCount` | string, number | when `trace` is present | §4.1 |
| `xrayTraceId`, `requestId` | string | all | §5 |
| `durationMs` | number | all | Handler wall-clock time |
| `errorName` | string | `ERROR` only | The error's `name`, such as `ImageTooLargeError` or `ThrottlingException`. Never its message. |
| `rejectionCodes` | string | `process-email`, `REJECTED` | Every `SubmissionRejectionCode`, sorted and joined with `,`, such as `SENDER_NOT_ALLOWED,SPAM_VERDICT_FAILED` |
| `attachmentRejectionCodes` | string | `process-email`, when any attachment was rejected | Every distinct `AttachmentRejectionCode` across rejected attachments, sorted and joined with `,` |
| `attachmentCount`, `screenshotCount`, `rejectedAttachmentCount` | number | `process-email` | Counts only. `screenshotCount` is the number of accepted screenshots and is present on `OK` events. |
| `acquisitionType`, `imageBytes`, `widthPx`, `heightPx` | | `extract` | From `SourceScreenshot` and the image read |
| `rowCount`, `reviewRequiredCells`, `meanConfidence`, `textractMs` | number | `extract` | `meanConfidence` is the mean Textract cell confidence. `reviewRequiredCells` counts cells with `deterministicReviewRequired`. |
| `rowCount`, `endToEndMs` | number | `write-csv` | `endToEndMs` only when `workflow` is `INGEST` and `receivedAt` is present |
| `exportedScreenshotId` | string | `write-csv`, `OK` only | Equals `screenshotId`. Q2 counts its distinct values. |

Codes are joined strings rather than arrays because Logs Insights flattens arrays into numbered fields, and grouping by one numbered field hides the rest.

### 6.2 Example

```json
{
  "_aws": {
    "Timestamp": 1792000000000,
    "CloudWatchMetrics": [
      {
        "Namespace": "MCC/MatchToCsv",
        "Dimensions": [["Stage"]],
        "Metrics": [
          { "Name": "OcrMeanConfidence", "Unit": "Percent" },
          { "Name": "TextractLatency", "Unit": "Milliseconds" }
        ]
      }
    ]
  },
  "event": "stage.completed",
  "schemaVersion": "stage-event/v1",
  "Stage": "extract",
  "workflow": "INGEST",
  "outcome": "OK",
  "env": "DEV",
  "gitSha": "0123abc",
  "submissionId": "<id>",
  "screenshotId": "<id>",
  "runId": "<id>",
  "executionId": "<execution ARN>",
  "retryCount": 0,
  "xrayTraceId": "1-00000000-000000000000000000000000",
  "requestId": "<request id>",
  "durationMs": 2410,
  "acquisitionType": "SCREENSHOT",
  "rowCount": 8,
  "reviewRequiredCells": 3,
  "meanConfidence": 97.4,
  "OcrMeanConfidence": 97.4,
  "textractMs": 1830,
  "TextractLatency": 1830
}
```

Metric values are top-level members named after the metric, as EMF requires, so a value can appear twice under a property name and a metric name. In an ephemeral stack the same event has no `_aws` block and no `OcrMeanConfidence` or `TextractLatency` members. In dev and prod the `extract` stage also writes its existing `ExtractedRows` and `ZeroRowExtractions` record (§7.3) as a separate line.

## 7. Metrics

### 7.1 EMF rules

1. Metrics are published unless `EMF_METRICS_ENABLED` is `false` (§3.1), which only ephemeral stacks set. Every rule below applies to dev and prod.
2. Namespace `MCC/MatchToCsv`, the existing `METRIC_NAMESPACE`.
3. New metrics use `Dimensions: [["Stage"]]` and nothing else.
4. Records are written with `process.stdout.write`, never `console.log`, so the runtime cannot prefix or wrap them (the reason recorded in `src/lib/metrics.ts`).
5. A metric is present in a record only when it has a value for that invocation. Count metrics are written as 1 on the event that counts and are absent otherwise, except `ExtractionFailed`, which is written as 0 on success so its average is a failure rate.

### 7.2 Custom metrics added

| Metric | Unit | Stage | Value |
| --- | --- | --- | --- |
| `SubmissionsAccepted` | Count | `process-email` | 1 when the submission is accepted |
| `SubmissionsRejected` | Count | `process-email` | 1 when the whole submission is rejected |
| `ScreenshotsAccepted` | Count | `process-email` | Number of accepted screenshots |
| `AttachmentsRejected` | Count | `process-email` | Number of rejected attachments, on accepted and rejected submissions |
| `ExtractionFailed` | Count | `extract` | 1 on `ERROR`, 0 on `OK` |
| `OcrMeanConfidence` | Percent | `extract` | `meanConfidence`, only when at least one cell exists |
| `TextractLatency` | Milliseconds | `extract` | Time spent in `AnalyzeDocument`, only when the call returned |
| `CsvWritten` | Count | `write-csv` | 1 when the CSV is stored |
| `EndToEndLatency` | Milliseconds | `write-csv` | `endToEndMs` |

Each retried attempt is its own invocation and its own event, so `ExtractionFailed` counts failed attempts, including attempts a later retry recovered. Final failures come from `AWS/States` `ExecutionsFailed` and from Q2.

### 7.3 Existing metrics kept

In dev and prod, `ExtractedRows` and `ZeroRowExtractions` keep their names, `FunctionName` dimension and record builder (`extractionMetricRecord`). Ephemeral stacks stop publishing them. No ephemeral alarm reads them.

### 7.4 Free AWS metrics relied on

| Namespace | Metrics | Used for |
| --- | --- | --- |
| `AWS/States` | `ExecutionsStarted`, `ExecutionsSucceeded`, `ExecutionsFailed`, `ExecutionsTimedOut`, `ExecutionTime` | Workflow volume and final failures. The failure and timeout alarms already exist. |
| `AWS/Lambda` | `Errors`, `Duration`, `Throttles`, `ConcurrentExecutions` | Per-function health. The `Errors` alarms already exist. |
| `AWS/Textract` | throttling, error and response-time metrics for `AnalyzeDocument` | Separating provider trouble from code trouble |
| `AWS/SQS` | `ApproximateNumberOfMessagesVisible` on the workflow DLQ | EventBridge could not start an execution. An execution that starts and then fails never reaches the DLQ; Q2 and `ExecutionsFailed` cover it. The alarm already exists. |

## 8. Logs Insights queries

Q1 to Q5 run over the `ProcessEmail`, `ExtractText` and `WriteExtractedCsv` log groups, and Q2 also over the ingest workflow log group (`/aws/vendedlogs/states/<resourcePrefix>`). Q6 runs over all five function log groups. In dev and prod the stack saves each as a `logs.QueryDefinition` named `<resourcePrefix>/<id>`. Developers paste them from this section (§8.2).

| ID | Purpose | Query |
| --- | --- | --- |
| Q1 | Trace one submission or execution | `filter event = "stage.completed" and (submissionId = "<id>" or executionId = "<execution ARN>") \| sort @timestamp asc \| fields @timestamp, Stage, workflow, outcome, screenshotId, runId, retryCount, durationMs, errorName, rejectionCodes, attachmentRejectionCodes, xrayTraceId` |
| Q2 | Status of each ingest execution | `filter (event = "stage.completed" and workflow = "INGEST") or type in ["ExecutionFailed", "ExecutionTimedOut", "ExecutionAborted"] \| fields coalesce(executionId, execution_arn) as execution \| stats max(screenshotCount) as expected, count_distinct(exportedScreenshotId) as exported, count(rejectionCodes) as rejected, count(execution_arn) as ended, min(@timestamp) as firstSeen, max(@timestamp) as lastSeen by execution \| sort lastSeen desc` |
| Q3 | Stage funnel | `filter event = "stage.completed" \| stats count_distinct(executionId) as executions, count_distinct(screenshotId) as screenshots by Stage, workflow, outcome` |
| Q4 | Per-stage latency | `filter event = "stage.completed" and outcome = "OK" \| stats pct(durationMs, 50) as p50, pct(durationMs, 95) as p95, max(durationMs) as worst, pct(endToEndMs, 95) as e2eP95 by Stage` |
| Q5 | Failed attempts and rejections | `filter event = "stage.completed" and (outcome != "OK" or ispresent(attachmentRejectionCodes)) \| stats count() as events, count_distinct(executionId) as executions by Stage, outcome, errorName, rejectionCodes, attachmentRejectionCodes \| sort events desc` |
| Q6 | Cold starts and memory | `filter type = "platform.report" \| stats count(record.metrics.initDurationMs) as coldStarts, max(record.metrics.maxMemoryUsedMB / record.metrics.memorySizeMB) as memoryPeak, pct(record.metrics.durationMs, 95) as p95 by @log` |

Q5 counts attempts. An extraction that fails at retry 0 and succeeds at retry 1 still appears once in Q5, and a non-retryable failure appears once at retry 0. Q2 decides whether an execution finally failed. To count one code across combinations, filter on it, for example `filter rejectionCodes like /SENDER_NOT_ALLOWED/`.

Logs Insights bills by bytes scanned. Queries default to the last 24 hours. Q1 for an older submission should use the narrowest range that covers it.

### 8.1 Execution status rules

Q2 aggregates per execution and never uses the order of events, so screenshot branches can finish in any order. Read each row with the first rule that matches:

| Condition | Status | Meaning |
| --- | --- | --- |
| `rejected` > 0 | `REJECTED` | `process-email` rejected the whole submission. The execution then fails, so this rule comes before `FAILED`. |
| `ended` > 0 | `FAILED` | Step Functions recorded a failure, timeout or abort. This includes a `process-email` failure before `submissionId` exists, a branch that exhausted its retries, and an invocation that timed out or ran out of memory without writing an event. |
| `expected` > 0 and `exported` = `expected` | `COMPLETE` | Every accepted screenshot has a successful `write-csv` event. |
| otherwise | `IN_PROGRESS` | At least one branch has not exported yet, and Step Functions has not recorded an end. |

The ingest workflow times out after 15 minutes, which writes an `ExecutionTimedOut` record. A row still `IN_PROGRESS` after `firstSeen` plus 15 minutes means telemetry was lost, and the execution history in the Step Functions console is the fallback. Use Q1 with the row's `execution` to see which branch is missing.

### 8.2 Developer access to ephemeral logs

Ephemeral stacks write logs and nothing else. A developer reads them with the `mcc-dev` profile after P1.4 adds this statement to `docs/self-hosting/policies/local-cdk-deployer-dev.json.template` and an operator updates the `MccStatsSuiteLocalCdkDeploy` inline policy:

```json
{
  "Sid": "ReadEphemeralMatchToCsvLogs",
  "Effect": "Allow",
  "Action": [
    "logs:DescribeLogStreams",
    "logs:FilterLogEvents",
    "logs:GetLogEvents",
    "logs:GetLogGroupFields",
    "logs:GetQueryResults",
    "logs:StartLiveTail",
    "logs:StartQuery"
  ],
  "Resource": [
    "arn:aws:logs:AWS_REGION:DEV_ACCOUNT_ID:log-group:/aws/lambda/match-to-csv-e-*",
    "arn:aws:logs:AWS_REGION:DEV_ACCOUNT_ID:log-group:/aws/lambda/match-to-csv-e-*:*",
    "arn:aws:logs:AWS_REGION:DEV_ACCOUNT_ID:log-group:/aws/vendedlogs/states/match-to-csv-e-*",
    "arn:aws:logs:AWS_REGION:DEV_ACCOUNT_ID:log-group:/aws/vendedlogs/states/match-to-csv-e-*:*"
  ]
}
```

The `:*` resources cover log streams, which `GetLogEvents` authorizes against. `GetQueryResults` sits in this statement because it authorizes against the queried log groups, so a developer cannot read the results of a query over stable dev logs even with its query ID. `GetLogGroupFields` is what the Logs Insights console calls to list fields, and console queries fail without it.

A second statement allows `logs:DescribeLogGroups` and `logs:StopQuery` on `*`, because those actions support no resource type. `DescribeLogGroups` reveals log group names in the dev account, not their contents. `logs:DescribeQueries` is not granted, because it would list every query ID in the account. The console's query history is unavailable as a result.

With that access, a developer tails one function or runs a query:

```console
aws logs tail /aws/lambda/match-to-csv-e-<name>-ExtractText --follow --profile mcc-dev
aws logs start-query --profile mcc-dev \
  --log-group-names /aws/lambda/match-to-csv-e-<name>-ProcessEmail /aws/lambda/match-to-csv-e-<name>-ExtractText /aws/lambda/match-to-csv-e-<name>-WriteExtractedCsv /aws/vendedlogs/states/match-to-csv-e-<name> \
  --start-time "$(date -v-1H +%s)" --end-time "$(date +%s)" --query-string '<Q2>'
aws logs get-query-results --query-id <id> --profile mcc-dev
```

The CloudWatch console's Logs Insights and Live Tail pages work with the same access.

## 9. Alarms and dashboard

### 9.1 Alarms added

Both alarms are created only in dev and prod, publish to the existing alarm topic, and treat missing data as not breaching, like the existing alarms.

| Alarm | Metric and statistic | Period, evaluation | Threshold |
| --- | --- | --- | --- |
| `EndToEndLatencyAlarm` | `EndToEndLatency`, `Stage=write-csv`, p95 | 1 hour, 1 of 1 | greater than 300000 ms (5 minutes). The workflow timeout is 15 minutes. |
| `OcrMeanConfidenceAlarm` | `OcrMeanConfidence`, `Stage=extract`, Average | 6 hours, 1 of 1 | less than 90 percent. Cells under 95 are already flagged for review, so a mean under 90 means most screenshots need review. |

The thresholds are starting values. Tuning them after real traffic is an ordinary code change.

### 9.2 Dashboard

One dashboard named `<resourcePrefix>`, dev and prod only, with metric widgets only:

- `SubmissionsAccepted`, `SubmissionsRejected`, `ScreenshotsAccepted` and `CsvWritten` sums per hour
- `EndToEndLatency` p50 and p95, and `TextractLatency` p95
- `OcrMeanConfidence` average and `ZeroRowExtractions` sum
- `AWS/States` `ExecutionsFailed` and `ExecutionsTimedOut` for both workflows, and the DLQ depth

The dashboard holds no Logs Insights widget, because every refresh of one is a billed scan. A text widget lists the saved query names.

## 10. Typed domain model

### 10.1 Core types

Added to `packages/contracts`:

```typescript
type WorkflowKind = 'INGEST' | 'REPLAY';

interface TraceContext {
  executionId: string;
  retryCount: number;
  workflow: WorkflowKind;
}

interface ProcessEmailInput extends S3ObjectReference {
  receivedAt?: string;
  trace?: TraceContext;
}

interface SourceScreenshot extends S3ObjectReference {
  // existing fields unchanged
  receivedAt?: string;
}

interface ProcessingRunInput {
  source: SourceScreenshot;
  trace?: TraceContext;
}

interface ExtractTextOutput {
  // existing fields unchanged
  trace?: TraceContext;
}
```

`ProcessEmailInput` changes from a type alias to an interface. The new fields are optional, so stored `source/metadata.json` documents written before this change still replay. Handlers read `trace` and `receivedAt` as untrusted input: a malformed value is dropped from the event, never rejected.

Defined in `src/lib/metrics.ts`, not exported from contracts:

```typescript
type Stage = 'process-email' | 'extract' | 'write-csv';
type StageOutcome = 'OK' | 'REJECTED' | 'ERROR';

interface StageEvent {
  stage: Stage;
  outcome: StageOutcome;
  durationMs: number;
  ids: { submissionId?: string; screenshotId?: string; runId?: string };
  trace?: TraceContext;
  properties: Record<string, string | number>;
  metrics: Partial<Record<StageMetricName, number>>;
}
```

### 10.2 Relationships

```text
execution 1 -> 0..1 submission (none when process-email fails first)
submission 1 -> many screenshot
screenshot 1 -> many run (ingest run plus replays)
invocation 1 -> 1 stage event
```

## 11. Module and class catalog

| File | Public functions | Change |
| --- | --- | --- |
| `src/lib/metrics.ts` | `stageEventRecord(event, context): Record<string, unknown>`, `publishStageEvent(event, write?, environment?, timestamp?)` | New. Builds the §6 record, adds the `_aws` block and metric members unless `EMF_METRICS_ENABLED` is `false`, and writes it with `process.stdout.write`. Reads `_X_AMZN_TRACE_ID`, `GIT_SHA`, `DEPLOYMENT_ENVIRONMENT` and `EMF_METRICS_ENABLED`. `publishExtractionMetrics` writes nothing when `EMF_METRICS_ENABLED` is `false`. |
| `src/lib/log.ts` | `log(level, message, details)` | Drops records below `AWS_LAMBDA_LOG_LEVEL` (default `INFO`). Keeps writing one self-formatted JSON line. |
| `src/lambdas/process-email.ts` | `handler`, `processEmail` | Copies `receivedAt` into each `SourceScreenshot` and publishes one event per invocation, including failures before `submissionId` exists. |
| `src/lambdas/extract-text.ts` | `handler`, `runExtraction` | Times the Textract call, computes `meanConfidence` and `reviewRequiredCells`, passes `trace` to its output, and publishes one event. |
| `src/lambdas/write-extracted-csv.ts` | `handler`, `writeExtractedCsv` | Computes `endToEndMs`, sets `exportedScreenshotId` on success, and publishes one event. |
| `cdk/lib/match-to-csv-stack.ts` | stack | Payload, logging, environment, alarm, query and dashboard changes (§13). |

Each handler takes the publisher as an injected dependency, like `publishExtractionMetrics` today, so tests capture the written line.

## 12. Directory structure and ownership

No new directories. The spec lives at `specs/5-match-to-csv-observability.md`.

## 13. Configuration and infrastructure

### 13.1 Step Functions payloads

- The EventBridge rule input adds `receivedAt: events.EventField.time`.
- Each `LambdaInvoke` in both workflows sets `payload: sfn.TaskInput.fromObject(...)` listing the state's existing fields explicitly plus `trace` (§4.1). `payloadResponseOnly`, `resultPath` and the retry policy stay unchanged.
- The `Map` `itemSelector` keeps `source.$: $$.Map.Item.Value`.

### 13.2 Application resources

| Resource | Change |
| --- | --- |
| All five Lambdas | `loggingFormat: JSON`, `applicationLogLevelV2: INFO`, `systemLogLevelV2: INFO`, the existing `buildEnvironment` (`GIT_SHA`, `DEPLOYMENT_ENVIRONMENT`), which today only `extract-text` receives, and `EMF_METRICS_ENABLED: 'false'` in ephemeral stacks only (unset in dev and prod) |
| Ingest workflow | `logs.level: ERROR`, `includeExecutionData: false` |
| Replay workflow | unchanged (no logging configured today) |
| `EndToEndLatencyAlarm`, `OcrMeanConfidenceAlarm` | §9.1, dev and prod only |
| Six `logs.QueryDefinition` | §8, dev and prod only |
| One `cloudwatch.Dashboard` | §9.2, dev and prod only |

### 13.3 Retention

Unchanged: three months in prod, two weeks elsewhere, from the stack's `logGroup` helper.

### 13.4 Permissions

No runtime permission is added. EMF extraction needs no IAM permission. The only access change is the developer read grant in §8.2, which lives in the self-hosting policy template and which an operator applies to the IAM Identity Center permission set by hand.

### 13.5 Deployment

Through the existing pipeline. No foundation change. A deployed stack's old Step Functions logs stay in the log group until retention removes them.

### 13.6 Cost

At us-east-1 list prices when this spec was written, and before the free tier: nine custom metrics at $0.30 each per month, two alarms at $0.10 each, and the dashboard free if the account holds three or fewer. That is about $3 a month. Ephemeral stacks add no metric cost. Log ingestion is $0.50 per GB and Logs Insights $0.005 per GB scanned. At a few submissions a day, both round to cents and fall compared with today because of the Step Functions change. Check current prices before quoting these figures.

## 14. Security and privacy

1. Events carry identifiers, counts, codes, timings and confidence only. They never contain image bytes, OCR text, extracted rows, email subjects or bodies, sender or recipient addresses, the sender allowlist, or SSM parameter values.
2. `errorName` holds the error's `name` and never its message, because provider and parser messages can echo input.
3. `trace` and `receivedAt` come from the state machine, but handlers still validate them before logging, because a direct invocation can supply any value.
4. The Step Functions change removes execution data, including extracted rows, from logs.
5. The developer grant (§8.2) reads only `match-to-csv-e-*` log groups in the dev account. It never covers stable dev log groups, prod, metrics or X-Ray, and the permission set stays assigned to the dev account only.

## 15. Observability

This whole spec is the observability design. The audit record for "what happened to this input" stays the S3 evidence events (`SUBMISSION_*`, `RUN_*`). Q1 is the fast index into them.

## 16. Testing, CI and release

### 16.1 Tests

| Layer or file | Covers |
| --- | --- |
| `metrics` unit tests | Record shape matches §6 and §7.1. `Dimensions` is exactly `[["Stage"]]`. No ID, code or `workflow` appears as a dimension. Absent fields are omitted. Codes are sorted and comma-joined. With `EMF_METRICS_ENABLED` unset, both records carry their metrics as today. With it `false`, the event has no `_aws` block or metric members and `publishExtractionMetrics` writes nothing. The line ends in a newline and is written with the injected writer. |
| `log` unit tests | Records below `AWS_LAMBDA_LOG_LEVEL` are dropped. `INFO` is the default. |
| Handler tests | One event per invocation for `OK`, `REJECTED` and `ERROR`. `process-email` writes an `ERROR` event with `executionId` and without `submissionId` when the raw email read, the MIME parse or the SSM read fails. An accepted submission with rejected attachments is `OK` with `attachmentRejectionCodes`. A submission with several rejection codes lists all of them. The event is written before a rethrow, a publisher failure does not fail the handler, `endToEndMs` appears only for `INGEST` with `receivedAt`, `exportedScreenshotId` appears only on a `write-csv` `OK`, and no event holds subject, address or row content. |
| CDK assertion tests | Lambda `LoggingConfig`, `EMF_METRICS_ENABLED` absent in a non-ephemeral stack and `false` in an ephemeral one, Step Functions `LoggingConfiguration.Level` `ERROR` with `IncludeExecutionData` false, task payloads containing `trace`, the EventBridge input containing `receivedAt`, and the alarms, query definitions and dashboard present in a non-ephemeral stack and absent in an ephemeral one. |
| Policy template test | The template parses as JSON. Every logs action except `DescribeLogGroups` and `StopQuery` names only `match-to-csv-e-*` log groups, `GetQueryResults` and `GetLogGroupFields` are among them, and `DescribeQueries` appears nowhere. |
| Contract tests | Old `SourceScreenshot` and `ProcessingRunInput` documents without the new fields still parse. |

Tests never call AWS.

### 16.2 CI and release

`npm run check`, `npm run app:synth -- match-to-csv --environment dev`, and `npm run verify:bundle --workspace @mcc/match-to-csv`. Contract changes follow the release-please rules in `AGENTS.md`.

### 16.3 Live validation

A developer, with the §8.2 access and an ephemeral stack, sends emails and checks the results with Q1, Q2 and Q5:

| Case | Expected |
| --- | --- |
| One email, two screenshots | Q1 shows one `process-email` event and one `extract` and one `write-csv` event per screenshot. Q2 shows `expected` 2, `exported` 2, `COMPLETE`. |
| One valid screenshot plus one non-image attachment | Q2 `COMPLETE` with `expected` 1. Q5 lists the `process-email` `OK` event with `attachmentRejectionCodes` `NOT_AN_IMAGE`. |
| Sender not on the allowlist | Q2 `REJECTED`. Q5 shows the full `rejectionCodes` value. |
| Replay of one screenshot | Q1 shows `workflow` `REPLAY` events with a new `runId` and no `endToEndMs`. Q2 is unchanged because it reads `INGEST` only. |
| Any case | The stack's log lines carry no `_aws` block, and `MCC/MatchToCsv` shows no new samples from it. |

After the first deploy to dev, an operator checks that `MCC/MatchToCsv` metrics with the `Stage` dimension appear within a few minutes. This confirms EMF extraction works under the JSON log format. Cases that cannot be produced by email, such as an unfinished branch, a timed-out invocation, a pre-ID failure and recovered or exhausted retries, follow from field presence. The handler tests prove each event carries the fields Q2 counts, and §8.1 states the result for each combination.

## 17. Acceptance criteria

- [ ] Every `process-email`, `extract-text` and `write-extracted-csv` invocation writes exactly one §6 event, including `process-email` failures before `submissionId` exists.
- [ ] In dev and prod the metrics in §7.2 appear with only the `Stage` dimension, and `ExtractedRows`, `ZeroRowExtractions` and the zero-row alarm are unchanged.
- [ ] Ephemeral stacks publish no EMF metrics and create no alarms, query definitions or dashboard.
- [ ] A developer with the `mcc-dev` profile can tail and query an ephemeral stack's log groups from the CLI and the console, and cannot read stable dev log groups or the results of queries over them.
- [ ] Deploying any single slice to dev or prod keeps `ExtractedRows` and `ZeroRowExtractions` publishing.
- [ ] Q2 reports each §16.3 case with the status §8.1 gives it.
- [ ] The ingest workflow logs at `ERROR` without execution data.
- [ ] No event contains the content §14 excludes.
- [ ] X-Ray active tracing and every existing alarm are unchanged.

## 18. Risks and accepted limitations

1. **EMF under the JSON log format:** if the runtime wraps stdout lines under `loggingFormat: JSON`, metrics stop appearing. Ephemeral stacks cannot show this, because they publish no metrics, so the operator check after the first dev deploy (§16.3) catches it. The fallback is to keep the text format and drop only the application log level change.
2. **Logs expire:** after retention, Q1 and Q2 return nothing for old submissions. Accepted. The S3 evidence events keep the full history.
3. **Attempts, not outcomes:** `ExtractionFailed` and Q5 count failed attempts, including ones a retry later fixed. Accepted. Q2 and `AWS/States` `ExecutionsFailed` report final failures.
4. **Sparse data:** at low volume the percentile alarm evaluates few points and can fire on one slow submission. Accepted. A single 5-minute delay is worth knowing about at this scale.
5. **Lost events:** an invocation that times out or runs out of memory writes no event. Q2 still marks the execution `FAILED` from the Step Functions record, and Q1 shows the last event that was written.
6. **Manual permission update:** the §8.2 grant takes effect only after an operator updates the permission set in IAM Identity Center. Until then developers cannot read ephemeral logs.
7. **No developer metrics or X-Ray:** developers see logs only. Accepted. Metric behavior is checked in dev, and `xrayTraceId` is for operators.
8. **No telemetry for operator tools:** `compare-runs` and `materialize-training-data` write no events (P3.1).

## 19. Reference documentation

- CloudWatch embedded metric format specification: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
- CloudWatch metric identity (namespace, name and dimensions): https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_concepts.html
- Logs Insights query syntax: https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax.html
- CloudWatch Logs actions and resource types: https://docs.aws.amazon.com/service-authorization/latest/reference/list_logs.html
- Lambda advanced logging controls: https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs-advanced.html
- Step Functions context object: https://docs.aws.amazon.com/step-functions/latest/dg/input-output-contextobject.html
- Step Functions log levels: https://docs.aws.amazon.com/step-functions/latest/dg/cw-logs.html
- CloudWatch pricing: https://aws.amazon.com/cloudwatch/pricing/

## 20. Delivery plan: phases and slices

### 20.1 How to file this plan

File each slice as a leaf issue with `/mcc-create-github-issue`, with `Plan ID: P<n>.<m>` in the body and this spec linked. Phases become epics only if someone asks. Acceptance bullets become the issue's acceptance criteria, and every slice inherits §20.3.

### 20.2 Seam contracts

| Contract | Defined in | Main consumers |
| --- | --- | --- |
| `TraceContext`, `receivedAt`, `trace` fields | P0.1 | P0.2, P1.1, P1.2 |
| `stage-event/v1` record, `publishStageEvent` and `EMF_METRICS_ENABLED` | P0.2 | P1.2, P1.3, P2.1 queries |

### 20.3 Definition of done for every slice

- Publishers and clocks are injected. No handler writes to stdout directly.
- Tests from §16.1 for the slice's behavior.
- The `AGENTS.md` checks for the changed paths, including `app:synth` and `verify:bundle` for CDK changes.
- No real addresses, IDs or screenshots in fixtures.
- Deployed alone to dev or prod, the slice keeps `ExtractedRows` and `ZeroRowExtractions` publishing. Every slice that touches `src/lib/metrics.ts` or Lambda environment variables has a test with `EMF_METRICS_ENABLED` unset that asserts both metrics are still written.

### Phase 0: Contracts and helpers

**Goal:** the types and the event builder exist and are tested.
**Exit criteria:** P0.1 and P0.2 merged.

#### P0.1 Add trace context and receivedAt to the contracts (S)

- **Blocked by:** none
- **Spec:** §4.1, §10.1
- **Files:** `packages/contracts/src/index.ts`, match-to-csv consumers that construct these types
- **Provides:** `TraceContext`, `WorkflowKind`, the optional fields
- **Acceptance:**
  - Documents without the new fields still type-check and replay.
  - `process-email` copies `receivedAt` from its input into every `SourceScreenshot`.

#### P0.2 Build and publish stage events (S)

- **Blocked by:** P0.1
- **Spec:** §3.1, §6, §7.1, §7.2, §11
- **Files:** `src/lib/metrics.ts`, `src/lib/log.ts`, their tests
- **Provides:** `stageEventRecord`, `publishStageEvent`, the `EMF_METRICS_ENABLED` switch, the log level gate
- **Acceptance:**
  - Records match §6, with `[["Stage"]]` as the only dimension set.
  - With `EMF_METRICS_ENABLED` unset, `ExtractedRows` and `ZeroRowExtractions` are published exactly as before.
  - With `EMF_METRICS_ENABLED` set to `false`, no record carries an `_aws` block and `publishExtractionMetrics` writes nothing.
  - `log` drops records below `AWS_LAMBDA_LOG_LEVEL`.

### Phase 1: Emit events

**Goal:** every pipeline invocation writes its event with trace context, and developers can read it.
**Exit criteria:** the §16.3 developer cases pass in an ephemeral stack.

#### P1.1 Pass trace context through the workflows (S)

- **Blocked by:** P0.1
- **Spec:** §13.1
- **Files:** `cdk/lib/match-to-csv-stack.ts` and its tests
- **Provides:** `trace` and `receivedAt` in every task input
- **Acceptance:**
  - Both workflows' task payloads contain `trace` with the right `workflow`.
  - The EventBridge input contains `receivedAt`.

#### P1.2 Emit stage events from the three pipeline Lambdas (M)

- **Blocked by:** P0.2, P1.1, P1.3
- **Spec:** §3.1, §6, §7.2, §14
- **Files:** `src/lambdas/process-email.ts`, `src/lambdas/extract-text.ts`, `src/lambdas/write-extracted-csv.ts`, their tests
- **Acceptance:**
  - One event per invocation for `OK`, `REJECTED` and `ERROR`, including `process-email` failures before `submissionId` exists.
  - Partial attachment rejections and multiple rejection codes appear in full.
  - In an ephemeral stack, no stage event carries an `_aws` block, while a non-ephemeral synth still publishes `ExtractedRows` and `ZeroRowExtractions`.
  - A publisher failure does not fail the invocation.
  - No event contains the content §14 excludes.

#### P1.3 Set logging levels and the metrics switch in the stack (XS)

- **Blocked by:** P0.2
- **Spec:** §1, §13.2
- **Files:** `cdk/lib/match-to-csv-stack.ts` and its tests
- **Acceptance:**
  - The ingest workflow logs at `ERROR` without execution data.
  - All five Lambdas use the JSON log format with `INFO` levels and receive `GIT_SHA` and `DEPLOYMENT_ENVIRONMENT`.
  - `EMF_METRICS_ENABLED` is `false` in ephemeral stacks and absent in non-ephemeral ones.

#### P1.4 Let developers read ephemeral match-to-csv logs (XS)

- **Blocked by:** none
- **Spec:** §8.2, §14
- **Files:** `docs/self-hosting/policies/local-cdk-deployer-dev.json.template`, the "Grant local deploy access" step in `docs/self-hosting/20-bootstrap-cdk.md`
- **Acceptance:**
  - The template holds the two §8.2 statements. Every logs action that supports a resource type, including `GetQueryResults` and `GetLogGroupFields`, is scoped to `match-to-csv-e-*` log groups, and `DescribeQueries` is not granted.
  - The bootstrap guide's description of the policy names the new access.
  - After an operator applies the policy, a developer with `mcc-dev` runs Q1 from the Logs Insights console and from the CLI against an ephemeral stack and gets results.
  - `aws logs get-query-results` with `mcc-dev`, given the ID of a query an operator ran over a stable dev log group, is denied.
  - Needs independent review, because it changes a permission set.

### Phase 2: Operate

**Goal:** an operator can answer the three questions in the introduction from the console.
**Exit criteria:** P2.1 merged and deployed to dev.

#### P2.1 Add alarms, saved queries and the dashboard (S)

- **Blocked by:** P1.2, P1.3
- **Spec:** §8, §9
- **Files:** `cdk/lib/match-to-csv-stack.ts` and its tests
- **Acceptance:**
  - Both alarms, six query definitions and the dashboard exist in non-ephemeral stacks and not in ephemeral ones.
  - Every query runs without a syntax error against an ephemeral stack's logs, and Q2 gives each §16.3 case its §8.1 status.

### Phase 3: Backlog (not filed with v1)

| ID | Slice | Size | Note |
| --- | --- | --- | --- |
| P3.1 | Stage events for `compare-runs` and `materialize-training-data` | S | §18 item 8 |
| P3.2 | Tune alarm thresholds from a month of real traffic | XS | §9.1 |

### 20.4 Dependency order

P0.1 comes first, and P1.4 can run at any time. P0.2 and P1.1 need P0.1. P1.3 needs P0.2. P1.2 needs P0.2, P1.1 and P1.3, so ephemeral stacks have metrics turned off before any of them emits a stage event. P2.1 needs P1.2 and P1.3 and comes last. The first useful milestone is P1.2 with P1.4, when a developer can run Q1 and Q2 against their own stack.
