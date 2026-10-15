# Match-to-CSV observability: Technical Specification

**Status:** Draft

**Version:** 1.0-draft (first version, issue #153)

**Date:** October 14, 2026

**Component:** `applications/match-to-csv` (Lambdas, `src/lib/log.ts`, `src/lib/metrics.ts`, CDK stack) and `packages/contracts`

**Runtime:** TypeScript on the Node.js Lambda runtime the stack already uses, ARM64

**Deployment:** the existing match-to-csv CDK stack, one per environment plus ephemeral developer stacks

**Telemetry services:** CloudWatch Logs with embedded metric format (EMF), CloudWatch Logs Insights, CloudWatch metrics, alarms and one dashboard, and the X-Ray active tracing the stack already enables

**Persistent state:** none added. Log groups and metrics are application resources owned by the CDK stack. The S3 evidence events stay the durable record of what happened to an input.

**External dependencies at runtime:** none added. EMF needs no CloudWatch API call or permission.

**Out of scope:** tail sampling, an OpenTelemetry collector, a state store or status table for uploads, Lambda Insights, CloudWatch Application Signals, high-resolution metrics, log metric filters, anomaly-detection alarms, and any user-facing progress UI.

The operator of match-to-csv needs to answer three questions without a full-stack application: what happened to one emailed submission, where each recent upload is now, and whether the pipeline is slow or producing poor OCR. This spec answers them with one structured log record per pipeline stage. Each record is both a CloudWatch metric (through EMF) and a searchable log line, and Logs Insights queries join the records by submission into a trace. The design adds about nine custom metrics and two alarms, so its fixed cost is a few dollars a month.

---

## 1. Resolved requirement decisions

| Requirement | Decision | Reason |
| --- | --- | --- |
| Distributed tracing without tail sampling | Every stage writes one wide event (§6). `submissionId` is the trace ID, `screenshotId` and `runId` are span IDs, and Logs Insights reassembles the trace (§8). X-Ray stays on and each event records the X-Ray trace ID. | Tail sampling needs a collector to buffer whole traces. At this volume X-Ray's default sampling records nearly every request within the free tier, so the logs only need a pointer to it. |
| Show the progress of uploads | Derived at query time from the latest stage event per submission (§8, query Q2), plus the Step Functions execution history Standard workflows keep for 90 days. | A state store would duplicate the S3 evidence events and need its own writes, permissions and consistency rules. |
| One event per stage, including replay | Replay runs the same `extract-text` and `write-extracted-csv` Lambdas, so replay is recorded as `workflow: "REPLAY"` on their events, not as a fourth `Stage` value. | Keeps the `Stage` dimension aligned with the Lambda that emits it. Replays still separate in every query by `workflow`. |
| Metric dimensions | New metrics use the single dimension set `[["Stage"]]`. IDs, reason codes, error names and `workflow` are EMF properties and never dimensions. | CloudWatch bills each metric name and dimension combination as one custom metric. A high-cardinality dimension creates one billed metric per value. |
| Existing `ExtractedRows` and `ZeroRowExtractions` metrics | Unchanged. They keep the `FunctionName` dimension, so the existing zero-row alarm and its history keep working. | Changing their dimension would break the alarm from #89 for no gain. |
| Step Functions logging | The ingest workflow logs at `ERROR` with `includeExecutionData: false`. The Infrequent Access log class is not used. | `ALL` with execution data logs every transition's payload, including every extracted row, and is the largest log volume in the stack. At `ERROR` the volume is too small for the Infrequent Access discount to matter, and the class cannot be changed on an existing log group. |
| Log format | Lambdas use the JSON log format with application log level `INFO` and system log level `INFO`. | Platform records become structured JSON. `INFO` keeps the `platform.report` record that the cold-start query (§8, Q6) reads. |
| End-to-end latency | Measured from the time EventBridge reports the raw email object was created to the time `write-extracted-csv` stores the CSV. | That is the delay the sender sees, apart from SES delivery. `process-email`'s own `receivedAt` excludes EventBridge and Step Functions start-up time. |

**Additional capabilities included:** saved Logs Insights query definitions and a dashboard, both created only in non-ephemeral stacks.

## 2. Goals and non-goals

### 2.1 Goals

1. Given a `submissionId`, one Logs Insights query lists every stage that handled it, in order, with outcome, duration, run IDs and error names.
2. One query lists the latest stage and outcome of every submission in a time range, so a stuck or failed upload is visible without opening Step Functions.
3. CloudWatch alarms fire when end-to-end latency or mean OCR confidence degrades, in addition to the existing failure alarms.
4. The design adds at most 10 custom metrics and 2 alarms, and reduces log ingestion compared with the current stack.
5. Ephemeral developer stacks emit the same events and metrics, so a developer can run the same queries against their own stack.

### 2.2 Non-goals

- Request-level sampling decisions. Every invocation logs its event.
- A durable or queryable status API. Logs expire with their retention (§13.3), and the S3 evidence events remain the system of record.
- Telemetry for `compare-runs` and `materialize-training-data`. They are operator tools invoked by hand, and their Lambda `Errors` alarms already exist (§20, backlog).
- Exactly-once metrics. A retried Lambda attempt emits its own event (§7.2).

## 3. Runtime architecture

```text
SES -> raw email bucket -> EventBridge (Object Created, adds receivedAt = $.time)
  |
  v
Step Functions ingest workflow (each task payload adds trace context)
  +-- process-email        -> wide event, Stage=process-email
  +-- Map (concurrency 2)
       +-- extract-text    -> wide event, Stage=extract
       +-- write-csv       -> wide event, Stage=write-csv
  |
  v
Lambda log groups (/aws/lambda/<prefix>-<Function>)
  +-- EMF extraction  -> CloudWatch metrics (MCC/MatchToCsv) -> alarms, dashboard
  +-- Logs Insights   -> saved queries Q1..Q6

Replay workflow -> extract-text, write-csv (trace.workflow = REPLAY)
X-Ray: Lambda and Step Functions segments, linked from events by xrayTraceId
```

**Ownership rules:** only `src/lib/metrics.ts` builds EMF records, and only `src/lib/log.ts` and `src/lib/metrics.ts` write to stdout. Handlers call them with injected writers, as `publishExtractionMetrics` does today. The CDK stack owns every telemetry resource. OpenTofu owns none.

**Packaging:** `TraceContext` and the new optional fields live in `packages/contracts` (§10). No new workspace or dependency. EMF records are built by hand, as today, rather than with `aws-embedded-metrics`.

### 3.1 Execution policy

- Each Lambda invocation writes exactly one wide event, on success and on failure, before it returns or rethrows.
- A failure to build or write the event never fails the invocation. The handler catches it and logs an `ERROR` line.
- Telemetry never changes evidence. Events are not written to S3, and no evidence write depends on telemetry.
- Events never contain screenshot bytes, OCR text, extracted rows, email bodies, subjects, sender addresses or recipient addresses (§14).

## 4. External interface

### 4.1 Trace context inputs

The CDK stack adds these fields to each Lambda task payload. Direct invocations, such as tests and manual replays, may omit them, and the event then omits the matching fields.

| Field | Set by | Value |
| --- | --- | --- |
| `receivedAt` on the `process-email` input | EventBridge rule input | `$.time` of the `Object Created` event, ISO 8601 |
| `trace.executionId` | each `LambdaInvoke` payload | `$$.Execution.Id` |
| `trace.retryCount` | each `LambdaInvoke` payload | `$$.State.RetryCount` |
| `trace.workflow` | each `LambdaInvoke` payload | `INGEST` in the ingest workflow, `REPLAY` in the replay workflow |

`process-email` copies `receivedAt` into every `SourceScreenshot` it emits, so later stages and replays carry it.

### 4.2 Outputs

The outputs are log records (§6), metrics (§7), alarms (§9.1), saved queries (§8) and a dashboard (§9.2). Handler return values change only by carrying `trace` through to the next task where §11 says so.

## 5. Identifiers

| Identifier | Created by | Role in the trace |
| --- | --- | --- |
| `submissionId` | `process-email` | Trace ID. Present on every event once `process-email` has assigned it. |
| `screenshotId` | `process-email`, one per accepted attachment | Span ID for one screenshot's branch of the `Map`. |
| `runId` | `extract-text`, one per processing run | Attempt ID. A replay creates a new `runId` for the same `screenshotId`. |
| `trace.executionId` | Step Functions | Links to the execution history and its retries. |
| `xrayTraceId` | Lambda runtime (`_X_AMZN_TRACE_ID`, the `Root=` value) | Links to the X-Ray trace map for the invocation. |
| `requestId` | Lambda context (`awsRequestId`) | Links to the invocation's other log lines and its `platform.report` record. |

## 6. Wide event

### 6.1 Fields

Every event is one JSON line with an `_aws` EMF block (§7.1). Fields that do not apply to a stage are omitted, not null.

| Field | Type | Stages | Meaning |
| --- | --- | --- | --- |
| `event` | `"stage.completed"` | all | Fixed value, the filter every query starts with |
| `schemaVersion` | `"stage-event/v1"` | all | Version of this record |
| `Stage` | `process-email` \| `extract` \| `write-csv` | all | The only metric dimension |
| `workflow` | `INGEST` \| `REPLAY` | all, when `trace` is present | Which state machine invoked the Lambda |
| `outcome` | `OK` \| `REJECTED` \| `ERROR` | all | `REJECTED` only for a screened-out submission |
| `env` | string | all | `DEPLOYMENT_ENVIRONMENT`, such as `DEV` or `PROD`. Ephemeral stacks are told apart by log group. |
| `gitSha` | string | all | The build SHA already passed to `extract-text`, now passed to every function |
| `submissionId`, `screenshotId`, `runId` | string | where known | §5 |
| `executionId`, `retryCount` | string, number | when `trace` is present | §4.1 |
| `xrayTraceId`, `requestId` | string | all | §5 |
| `durationMs` | number | all | Handler wall-clock time |
| `errorName` | string | `ERROR` | The error's `name`, such as `ImageTooLargeError` or `ThrottlingException`. Never its message. |
| `rejectionCodes` | `SubmissionRejectionCode[]` | `process-email`, `REJECTED` | From `packages/contracts` |
| `attachmentCount`, `screenshotCount`, `rejectedAttachmentCount` | number | `process-email` | Counts only |
| `attachmentRejectionCodes` | `AttachmentRejectionCode[]` | `process-email` | Distinct codes across rejected attachments |
| `acquisitionType`, `imageBytes`, `widthPx`, `heightPx` | | `extract` | From `SourceScreenshot` and the image read |
| `rowCount`, `reviewRequiredCells`, `meanConfidence`, `textractMs` | number | `extract` | `meanConfidence` is the mean Textract cell confidence. `reviewRequiredCells` counts cells with `deterministicReviewRequired`. |
| `rowCount`, `endToEndMs` | number | `write-csv` | `endToEndMs` only when `workflow` is `INGEST` and `receivedAt` is present |

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

Metric values are top-level members named after the metric, as EMF requires, so a value can appear twice under a property name and a metric name. The `extract` stage writes its existing `ExtractedRows` and `ZeroRowExtractions` record (§7.3) as a separate line, unchanged.

## 7. Metrics

### 7.1 EMF rules

1. Namespace `MCC/MatchToCsv`, the existing `METRIC_NAMESPACE`.
2. New metrics use `Dimensions: [["Stage"]]` and nothing else.
3. Records are written with `process.stdout.write`, never `console.log`, so the runtime cannot prefix or wrap them (the reason recorded in `src/lib/metrics.ts`).
4. A metric is present in a record only when it has a value for that invocation. Count metrics are written as 1 on the event that counts and are absent otherwise, except `ExtractionFailed`, which is written as 0 on success so its average is a failure rate.

### 7.2 Custom metrics added

| Metric | Unit | Stage | Value |
| --- | --- | --- | --- |
| `SubmissionsAccepted` | Count | `process-email` | 1 when the submission is accepted |
| `SubmissionsRejected` | Count | `process-email` | 1 when screening or attachment checks reject it |
| `ScreenshotsAccepted` | Count | `process-email` | Number of accepted screenshots |
| `AttachmentsRejected` | Count | `process-email` | Number of rejected attachments |
| `ExtractionFailed` | Count | `extract` | 1 on `ERROR`, 0 on `OK` |
| `OcrMeanConfidence` | Percent | `extract` | `meanConfidence`, only when at least one cell exists |
| `TextractLatency` | Milliseconds | `extract` | Time spent in `AnalyzeDocument`, only when the call returned |
| `CsvWritten` | Count | `write-csv` | 1 when the CSV is stored |
| `EndToEndLatency` | Milliseconds | `write-csv` | `endToEndMs` |

Each retried attempt is its own invocation and its own event, so `ExtractionFailed` counts attempts. Q5 separates final failures by `retryCount`.

### 7.3 Existing metrics kept

`ExtractedRows` and `ZeroRowExtractions` keep their names, `FunctionName` dimension and record builder (`extractionMetricRecord`).

### 7.4 Free AWS metrics relied on

| Namespace | Metrics | Used for |
| --- | --- | --- |
| `AWS/States` | `ExecutionsStarted`, `ExecutionsSucceeded`, `ExecutionsFailed`, `ExecutionsTimedOut`, `ExecutionTime` | Workflow volume and failures. The failure and timeout alarms already exist. |
| `AWS/Lambda` | `Errors`, `Duration`, `Throttles`, `ConcurrentExecutions` | Per-function health. The `Errors` alarms already exist. |
| `AWS/Textract` | throttling, error and response-time metrics for `AnalyzeDocument` | Separating provider trouble from code trouble |
| `AWS/SQS` | `ApproximateNumberOfMessagesVisible` on the workflow DLQ | EventBridge start failures. The alarm already exists. |

## 8. Saved Logs Insights queries

Each query runs over the `ProcessEmail`, `ExtractText` and `WriteExtractedCsv` log groups unless stated. The stack saves each as a `logs.QueryDefinition` named `<resourcePrefix>/<id>`.

| ID | Purpose | Query |
| --- | --- | --- |
| Q1 | Trace one submission | `filter event = "stage.completed" and submissionId = "<id>" \| sort @timestamp asc \| fields @timestamp, Stage, workflow, outcome, screenshotId, runId, retryCount, durationMs, errorName, rejectionCodes.0, xrayTraceId` |
| Q2 | Current stage of each submission | `filter event = "stage.completed" and workflow = "INGEST" \| stats latest(Stage) as lastStage, latest(outcome) as lastOutcome, max(@timestamp) as lastSeen, count_distinct(screenshotId) as screenshots by submissionId \| sort lastSeen desc` |
| Q3 | Stage funnel | `filter event = "stage.completed" \| stats count_distinct(submissionId) as submissions, count_distinct(screenshotId) as screenshots by Stage, workflow, outcome` |
| Q4 | Per-stage latency | `filter event = "stage.completed" and outcome = "OK" \| stats pct(durationMs, 50) as p50, pct(durationMs, 95) as p95, max(durationMs) as worst, pct(endToEndMs, 95) as e2eP95 by Stage` |
| Q5 | Errors and rejections | `filter event = "stage.completed" and outcome != "OK" \| stats count() as events, max(retryCount) as maxRetry by Stage, outcome, errorName, rejectionCodes.0 \| sort events desc` |
| Q6 | Cold starts and memory, all five function log groups | `filter type = "platform.report" \| stats count(record.metrics.initDurationMs) as coldStarts, max(record.metrics.maxMemoryUsedMB / record.metrics.memorySizeMB) as memoryPeak, pct(record.metrics.durationMs, 95) as p95 by @log` |

Q2 reads a submission as stuck when `lastStage` is not `write-csv` or `lastOutcome` is not `OK`. A submission with several screenshots counts as finished only when Q1 shows a `write-csv` `OK` event for each `screenshotId`. A submission that `process-email` never logged does not appear, and the workflow DLQ alarm covers that case.

Logs Insights bills by bytes scanned. Queries default to the last 24 hours. Q1 for an older submission should use the narrowest range that covers it.

## 9. Alarms and dashboard

### 9.1 Alarms added

Both alarms are created only in non-ephemeral stacks, publish to the existing alarm topic, and treat missing data as not breaching, like the existing alarms.

| Alarm | Metric and statistic | Period, evaluation | Threshold |
| --- | --- | --- | --- |
| `EndToEndLatencyAlarm` | `EndToEndLatency`, `Stage=write-csv`, p95 | 1 hour, 1 of 1 | greater than 300000 ms (5 minutes). The workflow timeout is 15 minutes. |
| `OcrMeanConfidenceAlarm` | `OcrMeanConfidence`, `Stage=extract`, Average | 6 hours, 1 of 1 | less than 90 percent. Cells under 95 are already flagged for review, so a mean under 90 means most screenshots need review. |

The thresholds are starting values. Tuning them after real traffic is an ordinary code change.

### 9.2 Dashboard

One dashboard named `<resourcePrefix>`, non-ephemeral stacks only, with metric widgets only:

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
  properties: Record<string, string | number | string[]>;
  metrics: Partial<Record<StageMetricName, number>>;
}
```

### 10.2 Relationships

```text
submission 1 -> many screenshot
screenshot 1 -> many run (ingest run plus replays)
invocation 1 -> 1 stage event
```

## 11. Module and class catalog

| File | Public functions | Change |
| --- | --- | --- |
| `src/lib/metrics.ts` | `stageEventRecord(event, context): Record<string, unknown>`, `publishStageEvent(event, write?, environment?, timestamp?)` | New. Builds the §6 record and writes it with `process.stdout.write`. Reads `_X_AMZN_TRACE_ID`, `GIT_SHA` and `DEPLOYMENT_ENVIRONMENT`. |
| `src/lib/log.ts` | `log(level, message, details)` | Drops records below `AWS_LAMBDA_LOG_LEVEL` (default `INFO`). Keeps writing one self-formatted JSON line. |
| `src/lambdas/process-email.ts` | `handler`, `processEmail` | Copies `receivedAt` into each `SourceScreenshot` and publishes one event per invocation. |
| `src/lambdas/extract-text.ts` | `handler`, `runExtraction` | Times the Textract call, computes `meanConfidence` and `reviewRequiredCells`, passes `trace` to its output, and publishes one event. |
| `src/lambdas/write-extracted-csv.ts` | `handler`, `writeExtractedCsv` | Computes `endToEndMs` and publishes one event. |
| `cdk/lib/match-to-csv-stack.ts` | stack | Payload, logging, alarm, query and dashboard changes (§13). |

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
| All five Lambdas | `loggingFormat: JSON`, `applicationLogLevelV2: INFO`, `systemLogLevelV2: INFO`, the existing `buildEnvironment` (`GIT_SHA`, `DEPLOYMENT_ENVIRONMENT`), which today only `extract-text` receives |
| Ingest workflow | `logs.level: ERROR`, `includeExecutionData: false` |
| Replay workflow | unchanged (no logging configured today) |
| `EndToEndLatencyAlarm`, `OcrMeanConfidenceAlarm` | §9.1, non-ephemeral only |
| Six `logs.QueryDefinition` | §8, non-ephemeral only |
| One `cloudwatch.Dashboard` | §9.2, non-ephemeral only |

### 13.3 Retention

Unchanged: three months in prod, two weeks elsewhere, from the stack's `logGroup` helper.

### 13.4 Permissions

None added. EMF extraction needs no IAM permission. Ephemeral stacks skip the alarms, queries and dashboard because the local workload boundary grants no CloudWatch administration, which is the same reason they skip alarms today.

### 13.5 Deployment

Through the existing pipeline. No foundation change. A deployed stack's old Step Functions logs stay in the log group until retention removes them.

### 13.6 Cost

At us-east-1 list prices when this spec was written, and before the free tier: nine custom metrics at $0.30 each per month, two alarms at $0.10 each, and the dashboard free if the account holds three or fewer. That is about $3 a month. Log ingestion is $0.50 per GB and Logs Insights $0.005 per GB scanned. At a few submissions a day, both round to cents and fall compared with today because of the Step Functions change. Check current prices before quoting these figures.

## 14. Security and privacy

1. Events carry identifiers, counts, codes, timings and confidence only. They never contain image bytes, OCR text, extracted rows, email subjects or bodies, sender or recipient addresses, the sender allowlist, or SSM parameter values.
2. `errorName` holds the error's `name` and never its message, because provider and parser messages can echo input.
3. `trace` and `receivedAt` come from the state machine, but handlers still validate them before logging, because a direct invocation can supply any value.
4. The Step Functions change removes execution data, including extracted rows, from logs.

## 15. Observability

This whole spec is the observability design. The audit record for "what happened to this input" stays the S3 evidence events (`SUBMISSION_*`, `RUN_*`). Q1 is the fast index into them.

## 16. Testing, CI and release

### 16.1 Tests

| Layer or file | Covers |
| --- | --- |
| `metrics` unit tests | Record shape matches §6 and §7.1. `Dimensions` is exactly `[["Stage"]]`. No ID, code or `workflow` appears as a dimension. Absent fields are omitted. The line ends in a newline and is written with the injected writer. |
| `log` unit tests | Records below `AWS_LAMBDA_LOG_LEVEL` are dropped. `INFO` is the default. |
| Handler tests | One event per invocation for `OK`, `REJECTED` and `ERROR`, an event written before a rethrow, a publisher failure that does not fail the handler, `endToEndMs` only for `INGEST` with `receivedAt`, and no subject, address or row content in any event. |
| CDK assertion tests | Lambda `LoggingConfig`, Step Functions `LoggingConfiguration.Level` `ERROR` with `IncludeExecutionData` false, task payloads containing `trace`, the EventBridge input containing `receivedAt`, and the alarms, query definitions and dashboard present in a non-ephemeral stack and absent in an ephemeral one. |
| Contract tests | Old `SourceScreenshot` and `ProcessingRunInput` documents without the new fields still parse. |

Tests never call AWS.

### 16.2 CI and release

`npm run check`, `npm run app:synth -- match-to-csv --environment dev`, and `npm run verify:bundle --workspace @mcc/match-to-csv`. Contract changes follow the release-please rules in `AGENTS.md`.

### 16.3 Live validation

In an ephemeral stack, send one email with two screenshots, then:

1. Run Q1 for its `submissionId` and see one `process-email` event and one `extract` and one `write-csv` event per screenshot.
2. See `MCC/MatchToCsv` metrics with `Stage` dimensions in the console within a few minutes. This confirms EMF extraction still works under the JSON log format.
3. Open the `xrayTraceId` from an event in X-Ray and see the same invocation.
4. Run a replay for one screenshot and see `workflow: "REPLAY"` events with a new `runId` and no `endToEndMs`.

## 17. Acceptance criteria

- [ ] Every `process-email`, `extract-text` and `write-extracted-csv` invocation writes exactly one §6 event.
- [ ] The metrics in §7.2 appear with only the `Stage` dimension. `ExtractedRows`, `ZeroRowExtractions` and the zero-row alarm are unchanged.
- [ ] Q1 to Q6 return the results §8 describes against an ephemeral stack (§16.3).
- [ ] The ingest workflow logs at `ERROR` without execution data.
- [ ] Both alarms, the six query definitions and the dashboard exist in non-ephemeral stacks only.
- [ ] No event contains the content §14 excludes.
- [ ] X-Ray active tracing and every existing alarm are unchanged.

## 18. Risks and accepted limitations

1. **EMF under the JSON log format:** if the runtime wraps stdout lines under `loggingFormat: JSON`, metrics stop appearing. Live validation step 2 catches it. The fallback is to keep the text format and drop only the application log level change.
2. **Logs expire:** after retention, Q1 and Q2 return nothing for old submissions. Accepted. The S3 evidence events keep the full history.
3. **Attempts, not outcomes:** `ExtractionFailed` counts failed attempts, including ones a retry later fixed. Accepted. `AWS/States` `ExecutionsFailed` counts final failures.
4. **Sparse data:** at low volume the percentile alarm evaluates few points and can fire on one slow submission. Accepted. A single 5-minute delay is worth knowing about at this scale.
5. **Lost events:** an invocation that times out or runs out of memory writes no event. Q2 then shows the previous stage, and the Lambda `Errors` and Step Functions failure alarms still fire.
6. **No telemetry for operator tools:** `compare-runs` and `materialize-training-data` write no events (P3.1).

## 19. Reference documentation

- CloudWatch embedded metric format specification: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
- Logs Insights query syntax: https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax.html
- Lambda advanced logging controls: https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs-advanced.html
- Step Functions context object: https://docs.aws.amazon.com/step-functions/latest/dg/input-output-contextobject.html
- CloudWatch pricing: https://aws.amazon.com/cloudwatch/pricing/

## 20. Delivery plan: phases and slices

### 20.1 How to file this plan

File each slice as a leaf issue with `/mcc-create-github-issue`, with `Plan ID: P<n>.<m>` in the body and this spec linked. Phases become epics only if someone asks. Acceptance bullets become the issue's acceptance criteria, and every slice inherits §20.3.

### 20.2 Seam contracts

| Contract | Defined in | Main consumers |
| --- | --- | --- |
| `TraceContext`, `receivedAt`, `trace` fields | P0.1 | P1.1, P1.2 |
| `stage-event/v1` record and `publishStageEvent` | P0.2 | P1.2, P2.1 queries |

### 20.3 Definition of done for every slice

- Publishers and clocks are injected. No handler writes to stdout directly.
- Tests from §16.1 for the slice's behavior.
- The `AGENTS.md` checks for the changed paths, including `app:synth` and `verify:bundle` for CDK changes.
- No real addresses, IDs or screenshots in fixtures.

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

- **Blocked by:** none
- **Spec:** §6, §7.1, §7.2, §11
- **Files:** `src/lib/metrics.ts`, `src/lib/log.ts`, their tests
- **Provides:** `stageEventRecord`, `publishStageEvent`, the log level gate
- **Acceptance:**
  - Records match §6, with `[["Stage"]]` as the only dimension set.
  - `log` drops records below `AWS_LAMBDA_LOG_LEVEL`.

### Phase 1: Emit events

**Goal:** every pipeline invocation writes its event with trace context.
**Exit criteria:** live validation steps 1 to 4 pass in an ephemeral stack.

#### P1.1 Pass trace context through the workflows (S)

- **Blocked by:** P0.1
- **Spec:** §13.1
- **Files:** `cdk/lib/match-to-csv-stack.ts` and its tests
- **Provides:** `trace` and `receivedAt` in every task input
- **Acceptance:**
  - Both workflows' task payloads contain `trace` with the right `workflow`.
  - The EventBridge input contains `receivedAt`.

#### P1.2 Emit stage events from the three pipeline Lambdas (M)

- **Blocked by:** P0.2, P1.1
- **Spec:** §3.1, §6, §7.2, §14
- **Files:** `src/lambdas/process-email.ts`, `src/lambdas/extract-text.ts`, `src/lambdas/write-extracted-csv.ts`, their tests
- **Acceptance:**
  - One event per invocation for `OK`, `REJECTED` and `ERROR`.
  - A publisher failure does not fail the invocation.
  - No event contains the content §14 excludes.

#### P1.3 Reduce Step Functions logging and switch Lambdas to JSON logs (XS)

- **Blocked by:** none
- **Spec:** §1, §13.2
- **Files:** `cdk/lib/match-to-csv-stack.ts` and its tests
- **Acceptance:**
  - The ingest workflow logs at `ERROR` without execution data.
  - All five Lambdas use the JSON log format with `INFO` levels.

### Phase 2: Operate

**Goal:** an operator can answer the three questions in the introduction from the console.
**Exit criteria:** P2.1 merged and deployed to dev.

#### P2.1 Add alarms, saved queries and the dashboard (S)

- **Blocked by:** P1.2
- **Spec:** §8, §9
- **Files:** `cdk/lib/match-to-csv-stack.ts` and its tests
- **Acceptance:**
  - Both alarms, six query definitions and the dashboard exist in non-ephemeral stacks and not in ephemeral ones.

### Phase 3: Backlog (not filed with v1)

| ID | Slice | Size | Note |
| --- | --- | --- | --- |
| P3.1 | Stage events for `compare-runs` and `materialize-training-data` | S | §18 item 6 |
| P3.2 | Tune alarm thresholds from a month of real traffic | XS | §9.1 |

### 20.4 Dependency order

P0.1 and P0.2 can run in parallel, and so can P1.3. P1.1 needs P0.1. P1.2 needs P0.2 and P1.1. P2.1 comes last. The first useful milestone is P1.2, when Q1 works.
