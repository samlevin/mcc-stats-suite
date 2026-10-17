# Cell Labeling: Technical Specification

**Status:** Draft; not implemented

**Version:** 2.1-draft

**Date:** October 15, 2026

**Component:** `applications/admin` (reviewer API, LLM adjudication writer, Lambdas, web application and CDK stack), with review and validated-table types in `packages/contracts`, the reviewer user pool in `infrastructure/modules/foundation`, and ephemeral-stack permissions in `infrastructure/modules/foundation/local-cdk-policies.tf`

**Runtime:** TypeScript. Node.js 22 on AWS Lambda (ARM64) behind an API Gateway HTTP API; a React application built with Vite and served by CloudFront

**Deployment:** one AWS CDK stack per stable environment (`dev`, `prod`) from GitHub Actions, plus ephemeral developer stacks in the dev account, through the same guarded wrapper as match-to-csv

**Input:** match-to-csv run evidence (the original screenshot and `normalized-ocr/v2` with the parser provenance from [spec 2](2-ocr-quality.md) P0.3), spec 2 quality results (`quality-result/v1`), and LLM reviewer decisions and escalations from the OCR risk model specification (#165)

**Persistent state:** adjudications, review plans, escalations and validated tables under each processing run in the OpenTofu-owned evidence bucket; reviewer accounts in an OpenTofu-owned Cognito user pool; a rebuildable DynamoDB `ReviewState` table owned by the application stack

**External dependencies at runtime:** CloudFront, API Gateway, Lambda, Cognito, S3, KMS, DynamoDB, EventBridge, SQS, SSM Parameter Store

**Out of scope:** computing features or scores, training datasets and training example selection (spec 2 §8.4, §8.5), training or serving a risk model and routing review by it, and calling the LLM reviewer, its prompts, inputs, outputs and cost limits (the OCR risk model specification, #165), match records and player identity (the stats lakehouse, #159), public access and self-service sign-up

Every OCR cell, scoreboard row and table of a scored run is compared with the original screenshot and confirmed or corrected. The primary reviewer is an LLM: the OCR risk model specification (#165) calls a vision model and hands each decision to this component, which stores it as an adjudication in the same vocabulary as a person's. People in the Cognito `labeler` group review on a phone only what the LLM reviewer escalates to them and a blind audit sample. Every decision, from either kind of reviewer, is stored as immutable evidence. When every required decision of a run exists, the system writes a validated table: the reviewed version of the run's scoreboard, with lineage back to the evidence. The stats lakehouse (#159) ingests validated tables into bronze. Spec 2 reads the adjudications to build cross-run baselines, and the risk model (#165) trains and is evaluated on them under spec 2 §8.5 and §9.6.

**Readiness:** this specification authorizes filing Phases 0 to 4. P3.4 cannot deploy until P1.1 here and spec 2 P1.1 are applied, and P4.4 needs spec 2's stack (spec 2 P3.2) and the LLM reviewer of the OCR risk model specification (#165) deployed, because people review only what that reviewer escalates and the audit sample of complete runs. Contracts in §4.5, §5.3 and §10.1 freeze when P0.2 merges.

---

## 1. Resolved requirement decisions

| Requirement | Decision | Reason |
| --- | --- | --- |
| A reviewer labels the cells they choose; `SKIPPED` is one of the decisions | Review-all: every cell, row and table in a run's review scope (§7.1) needs an explicit decision before the run is complete. `SKIPPED` is recorded but resolves nothing. An untouched cell is never a label. | Spec 2 §9.6 trains and evaluates the first risk model on complete labels. Labels only for cells a reviewer chose to open carry that choice as selection bias. |
| One decision per cell | Row decisions (§7.4) for missing row, extra row, wrong team and wrong win or loss, and table decisions (§7.5) for wrong table, wrong column mapping and rows Textract never detected. The reviewer confirms team and win or loss on every player row. | The parser derives team from row colour and win or loss from row order (spec 1 §8.4, §8.5). No cell holds those values, so no cell decision can correct them. |
| `CORRECTED` records only the new value | `CORRECTED` also records one or more error types (§7.3). | Glyph substitutions and shifted or merged cells need different fixes and different model features, and the two strings alone do not always tell them apart. |
| `adjudicationId` is a UUIDv7 or ULID | Every new identifier, including `adjudicationId`, `bulkActionId` and `validatedTableId`, is an `evidenceId()` value (spec 1 §5.1): base-36 milliseconds, a hyphen and a random UUID. | One identifier format across evidence. Identifiers sort by creation time like `runId` and `qualityRunId`. |
| `GET /v1/runs/{runId}/training-export` writes `CellTrainingExampleV1` JSONL | No training export route. Spec 3 defines no labeled training export and writes nothing under `exports/`. | Spec 2 §8.5 owns training example selection and spec 2 §1 allows one labeled dataset definition. |
| No record of what the reviewer saw | Every adjudication records `selectionReason`, the `qualityRunId` it was reviewed against, `priorityShown`, `shownPriority` and `priorDecisionsShown`. The server sets all of them (§4.2). | Spec 2 §8.5 picks the feature row of the quality run the reviewer was shown, and spec 2 §9.6 measures its gate on labels collected without a visible priority. |
| No independent check of reviewer decisions | A configured share of runs is reviewed with priorities hidden, and a configured share of cells is reviewed a second time blind (§7.6). Both decisions are kept. | Reviewers who see a priority miss more errors in `NONE` and `LOW` cells, which are the cells a model would auto-accept (spec 2 §9.6). |
| Review produces labels only | A complete run gets an immutable, versioned validated table with lineage (§8.4, §8.5). | The stats lakehouse needs reviewed match data, not OCR output or raw labels (#159). |
| Labels name the cell's semantic field | Cell adjudications record `semanticField` and `exportedField` (spec 2 P0.3), and validated values also record the field the reviewer confirmed for the column. | When the normalizer cannot map a header, the cell's field is `UNKNOWN` while the parser exports the column by position. Features, labels and lakehouse values must describe a cell the same way (spec 2 §1). |
| Adjudications at `runs/{runId}/adjudications/{adjudicationId}.json`; the supersession check is a conditional update of the projection | Each item's adjudications form a chain of create-only keys, each named after the adjudication it supersedes (§5.1, §8.1). A second successor of one adjudication cannot be written. Keys stay under `adjudications/`, where spec 2 §8.3 reads them. | With the S3 write first and the projection update second, two browser tabs could both write evidence naming the same predecessor, leaving a fork no rebuild can resolve. A create-only key makes the S3 write the concurrency check, so the projection is only a cache. |
| `OcrLabelEvents` index table and `OcrCellResolutions` table | One `ReviewState` table (§13.3) holds the queue and the resolution projections, and is rebuilt from evidence (§6.5). There is no event index. | A run has about 60 cells, rows and tables, so listing its adjudication prefix is cheap, and create-only keys already reject duplicates. |
| CDK creates the user pool, its domain and the `labeler` group | The OpenTofu foundation owns the user pool, its domain and the `labeler` group (P1.1). Each stack creates only its own app client. | Adjudications record the reviewer's `sub` forever. A pool recreated with an application stack issues new `sub` values and orphans every recorded reviewer. Persistent shared resources belong to OpenTofu. |
| Every endpoint requires the `labeler` group through the JWT authorizer | The HTTP API JWT authorizer validates the access token. Each handler then rejects a token whose `cognito:groups` claim lacks `labeler` with `403 NOT_A_LABELER`. | HTTP API JWT authorizers check issuer, audience and scopes, not group claims. |
| API routes `/v1/...` while the browser calls `/api/v1/...` | API Gateway routes include the `/api/v1` prefix, so CloudFront forwards paths unchanged (§4.1). | No path rewriting at the edge, and one path in logs, tests and the browser. |
| No workflow depends on a cross-origin request | This stack's API is same-origin and never emits CORS headers. The browser makes two cross-origin requests that need nothing from this stack: the PKCE token call to the Cognito domain, which Cognito answers, and screenshot image loads from presigned S3 URLs, which are not CORS requests. | The authorization-code flow with PKCE requires a browser call to the token endpoint. Screenshots of up to 10 MiB exceed the 6 MB Lambda response limit, so the API cannot proxy them. |
| The queue lists completed processing runs with unresolved cells | A run becomes reviewable when it has a `SUCCEEDED` spec 2 quality result and parser provenance (§6.1). The people's queue lists only runs with an open escalation, oldest escalation first (§7.8). | Every adjudication names the quality run it was reviewed against, and the validated table needs provenance to know which table rows the parser exported. |
| Header cells are not mentioned | Header cells are reviewed like data cells. | Header OCR errors cause column mapping errors, and spec 2 writes feature rows for them. |
| No component named | `applications/admin`, the workspace the repository README assigns to the reviewer API and mobile review interface. | `ocr-quality` has no API or interface (spec 2 §2.2). |
| The sampling seed is not mentioned; a configured seed would sit in bundled configuration | `samplingSeed` is a `SecureString` at `/mcc/<env>/review/sampling-seed`, created by the OpenTofu foundation (P1.1) and readable only by `EnqueueRun` and `RebuildReviewState`. Plans record its SHA-256, never the seed (§7.6, §13.2). | The repository is public. With a committed seed anyone, reviewers included, could compute which cells will be double-reviewed and which runs hide priorities. A reviewer who looks harder at known blind cells biases the sample that spec 2 §9.6 relies on. |
| A row has no priority of its own | Spec 2 §9.4 defines a row `reviewPriority`, and spec 3 displays and records it (§7.6). | Spec 2 owns every priority. Spec 3 only shows and records what spec 2 computed. |
| Reviewer identity and kind | Every adjudication records `reviewerKind`, `HUMAN` or `LLM`. A human adjudication records `reviewerId` from the JWT. An LLM adjudication has no `reviewerId` and records `llmReviewer`: the model ID, the prompt version, and the key and SHA-256 of the stored prompt and response (§10.1). | The OCR risk model specification (#165) makes an LLM the primary reviewer. Its decisions must be adjudications in the same vocabulary, so labels never split across two designs, and the risk model and the lakehouse must be able to tell the two kinds apart and trace an LLM decision to its evidence. |
| Which path writes each kind of adjudication | LLM adjudications and escalations are written only by the `LlmReviewWrite` Lambda, which has no API route, function URL or event source. A principal calls it with `lambda:InvokeFunction`, which IAM grants only to the LLM reviewer's execution role (§4.5, §13.4). The reviewer API writes only `HUMAN` adjudications. | A Cognito group cannot authorize a service, and a decision that a browser could label `LLM` would make the reviewer kind meaningless. |
| Which items people review | People review only escalated items (§7.8) and the blind audit sample (§6.4). The LLM reviewer reviews every item in scope. | #165 performs spec 2's stage 1 with the LLM reviewer, so complete labels exist without human labor, and the audit sample measures the LLM's error rate. |
| `selectionReason` values | Five values, each with a defined reviewer kind and pass (§7.7): `REVIEW_ALL`, `MODEL_FLAGGED` and `CONSTRAINT_FAILED` for the LLM, `ESCALATION` and `AUDIT_SAMPLE` for people. `AUDIT_SAMPLE` widens spec 2 §9.6's meaning: it covers the blind audit of every primary decision, LLM or human, and keeps a reserved `PRIMARY` use for spec 2's stage 3 audit of auto-accepted items. v1 writes all of them except `MODEL_FLAGGED`, `CONSTRAINT_FAILED` and `AUDIT_SAMPLE` on `PRIMARY`, which need the routing stage. | The risk model gate (spec 2 §9.6) needs to know why each item reached a reviewer, and a label chosen by a model or a failed constraint is a biased sample. |
| Who may supersede a decision | A human adjudication may supersede an LLM one. An LLM adjudication never supersedes a human one (§8.1). | A person who corrects the model must not be overruled by the next automated pass. |
| What the blind audit view and write responses hide | The blind audit view never shows a decision, value, reviewer kind or rationale from either kind of reviewer, and blind-label rules apply to LLM adjudications as to human ones (§7.6). A write checks the caller's pass and escalation rules before any response carries a resolution (§4.3, §6.2), so an error response cannot show a decision the run view hides. The blind view returns the run's `qualityRunId`, because a run the LLM reviewer completed without an escalation has no run view (§4.1). | A person who sees the LLM's answer anchors on it, and the audit then overstates the LLM's accuracy. Most sampled runs have no escalation, and a blind label must still name the quality run it was reviewed against. |

**Additional capabilities included:** a bulk action that accepts the rest of a row as one adjudication per cell, disagreement resolution for blind pairs, an operator rebuild that also enqueues runs scored before this component existed, and a per-run review plan that records sampling decisions as evidence.

## 2. Goals and non-goals

### 2.1 Goals

1. The LLM reviewer (#165) can decide every cell, row and table of a scored run, and a person can confirm or correct every escalated item on a 320-pixel-wide phone with touch alone.
2. Every label records what spec 2 §8.5 and §9.6 need: an explicit decision on every item in scope, error types, `selectionReason`, the reviewer kind, the `qualityRunId` reviewed against, whether a priority was shown, the semantic and exported field, and a blind audit sample reviewed by people.
3. Every decision is immutable evidence, and every projection can be rebuilt from it.
4. Each review-complete run has an immutable, versioned validated table with lineage, and a later correction adds a version without changing earlier ones.
5. Two reviewers, or two tabs, can never silently overwrite each other, and an LLM decision never replaces a human one.
6. Each developer can deploy an isolated copy that reads and writes only its own ephemeral namespace.

### 2.2 Non-goals

- Computing features, scores or priorities. Spec 2 owns them, and this component only displays spec 2 results.
- Defining training data. Spec 2 §8.5 owns training example selection; the risk model specification owns datasets.
- Calling the LLM reviewer: its prompts, inputs, outputs, retries, cost limits and the rules for when it escalates. The OCR risk model specification (#165) owns them; this component accepts and records its decisions and escalations (§4.5).
- Routing review by a model, auto-accepting cells, or writing `MODEL_FLAGGED` or `CONSTRAINT_FAILED` adjudications. §7.7 reserves the contract; the OCR risk model specification (#165) owns the routing.
- Changing OCR evidence, normalized observations, CSVs or quality results.
- Match records, screenshot-to-match association, player identity across gamertags, and writing to lakehouse buckets. #159 reads validated tables.
- A blind audit of rows and tables (backlog P5.3).
- Public access or self-service sign-up.

## 3. Runtime architecture

```text
Reviewer browser (React, Vite, TanStack Query)
  |  managed login, authorization code with PKCE  -->  Cognito user pool (OpenTofu)
  v
CloudFront distribution <stack>
  +-- default behavior -> static site bucket (Origin Access Control): index.html, assets, config.json
  +-- /api/*           -> API Gateway HTTP API (JWT authorizer)
                            +-- GET  routes -> ReviewRead Lambda
                            +-- POST routes -> ReviewWrite Lambda (HUMAN adjudications)
                                                 |
LLM reviewer (#165) --lambda:InvokeFunction--> LlmReviewWrite Lambda (LLM adjudications, escalations)
                                                 |
                                                 v
Evidence bucket (OpenTofu)  <-- read run evidence and quality results; write adjudications, escalations and validated tables
  |  runs/{runId}/review/plan.json, review/escalations/, adjudications/, blind-adjudications/, validated/
  |
  |  Object Created: runs/*/quality/*/outcome.json (bucket notifications from spec 2 P1.1)
  v
EventBridge rule --> EnqueueRun Lambda --> review plan (S3) and ReviewState table (DynamoDB)
       |                                         ^
       +--(failed delivery)--> SQS DLQ           |
RebuildReviewState Lambda (operator-invoked) ----+  evidence -> projections, missing plans and validated versions

Evidence bucket source/original --(presigned GET, 10 minutes)--> browser
```

**Ownership rules:** `review-write` owns human adjudications and validated tables. `llm-review-write` owns LLM adjudications and LLM-raised escalations, and also writes validated versions through `evaluateRun`. Both writers create escalations through the shared `writeEscalation` (§6.7); `review-write` writes those that people raise. `enqueue-run` owns review plans and also writes validated versions through `evaluateRun`. `rebuild-review-state` writes plans and validated versions through the same library functions, create-only. All four own the `ReviewState` table, which is a cache. No module of this component calls Bedrock; the LLM reviewer (#165) does, and stores its prompts and responses itself. No module writes under `quality/`, `textract/`, `normalized/`, `export/` or any object match-to-csv or spec 2 owns. `scope`, `chains`, `decisions`, `escalations`, `completion`, `sampling` and `validated-table` are pure and perform no I/O. Only Lambda entry points construct AWS SDK clients; each core function receives an injected dependencies object.

**Packaging:** the `@mcc/admin` workspace with Lambda sources under `src/lambdas/`, pure libraries under `src/lib/`, the web application under `web/`, bundled configuration under `config/` and the CDK app under `cdk/`. Review contracts and the validated table type live in `@mcc/contracts`, because spec 2's baseline builder reads adjudications and the stats lakehouse reads validated tables.

**Orchestration decision:** no Step Functions. Every API write is synchronous and touches one run. The only fan-out is the operator rebuild, which fits in one 15-minute Lambda at league scale. A workflow is justified when the rebuild outgrows that limit (§18.9).

### 3.1 Execution policy

- One API request writes at most one adjudication, except a bulk accept, which writes one per cell of one row (at most `maxBulkCells`). One `LlmReviewWrite` invocation writes at most one adjudication or one escalation.
- Every evidence write uses `If-None-Match: *`. No handler deletes or overwrites an object.
- Supersession is enforced by adjudication keys (§8.1). The `ReviewState` table never decides which adjudication is current.
- A run is reviewable only after `enqueue-run` has written its review plan (§6.1).
- Handlers never read or write outside their namespace (`ephemeral/<name>/` for ephemeral stacks).
- This component never computes features, scores or priorities, and never passes a value to spec 2 scoring (§8.6).

## 4. Reviewer API, LLM writer and queue trigger

### 4.1 Routes

Every route sits behind the CloudFront `/api/*` behavior and the JWT authorizer, and requires the `labeler` group (§1). The routes serve people only: they write `HUMAN` adjudications and never accept an LLM decision (§4.5). `runId` must match `^[0-9a-z]+-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$` and name a run in the `ReviewState` table; the table stores the run's evidence prefix, so no route accepts a key or prefix from the browser.

| Method and route | Lambda | Behavior |
| --- | --- | --- |
| `GET /api/v1/queue?pass=PRIMARY\|BLIND_DOUBLE\|DISAGREEMENT&limit=25&cursor=` | `ReviewRead` | `PRIMARY`: runs with an open escalation (§7.8), oldest open escalation first. `BLIND_DOUBLE`: sampled cells waiting for a blind audit review, excluding cells the caller has adjudicated in the primary track. `DISAGREEMENT`: cells with an open disagreement, grouped by run. Returns run and cell summaries only, never OCR text, priorities or whether a cell is blind-sampled. `limit` is 1 to 100. |
| `GET /api/v1/runs/{runId}` | `ReviewRead` | `404 RUN_NOT_FOUND` unless the run has an escalation or an open disagreement. The run view: tables, cells (observed text, geometry, `semanticField`, `exportedField`, row role), rows with the parser's output (exported, team, win and loss), the run's escalations with their items and `reasonCodes`, the current resolution and reviewer kind of each escalated item, required and resolved counts, open disagreements, the rows that break §8.3 condition 5 with `OUTCOME_INCONSISTENT`, `qualityRunId` (the latest `SUCCEEDED` quality run, spec 2 §5.2 rule 5), the latest validated version, and, only in `PRIORITY_SHOWN` runs, each cell's, row's and table's `reviewPriority`, the run priority and each signal's `messageCode` and `evidence`. It never returns the resolution of an item that is neither escalated nor in an open disagreement, an LLM rationale, or LLM invocation evidence. |
| `GET /api/v1/runs/{runId}/blind-cells/{cellObservationId}` | `ReviewRead` | The blind audit view of one sampled cell: observed text, geometry, `semanticField`, `exportedField` and `qualityRunId` (the run's `latestQualityRunId`, as in the run view), which the blind write submits. A run the LLM reviewer completed without an escalation has no run view, so this is where a blind reviewer gets it. Never a decision, value, reviewer kind, rationale, priority, signal or parser team, from either kind of reviewer. `404 TARGET_NOT_FOUND` unless the caller wrote the cell's current blind adjudication, or the cell is in the blind queue and has no open escalation, so the route cannot be used to probe which cells are sampled. |
| `GET /api/v1/runs/{runId}/image` | `ReviewRead` | A presigned `GetObject` URL for the run's `source/original`, valid for `imageUrlTtlSeconds` (600), with `response-content-type` from the screenshot metadata and `response-cache-control: private, no-store`. Never a bucket name or permanent URL. |
| `POST /api/v1/runs/{runId}/adjudications` | `ReviewWrite` | Writes one cell, row or table adjudication (§4.2, §6.2). |
| `POST /api/v1/runs/{runId}/adjudications/bulk-accept` | `ReviewWrite` | Accepts the cells of one table row that have an open escalation, one adjudication per cell (§7.2). |
| `POST /api/v1/runs/{runId}/escalations` | `ReviewWrite` | Escalates more items of a run that already has an escalation, when a reviewer needs to decide them (§7.8). |

### 4.2 Adjudication requests

```json
{
  "kind": "CELL",
  "target": { "cellObservationId": "<runId>:cell:<providerBlockId>" },
  "reviewPass": "PRIMARY",
  "qualityRunId": "<qualityRunId from the run view, or from the blind view for BLIND_DOUBLE>",
  "supersedesAdjudicationId": null,
  "clientRequestId": "<UUID generated per submit>",
  "decision": { "decision": "CORRECTED", "submittedValue": "16", "errorTypes": ["GLYPH_SUBSTITUTION"] },
  "telemetry": { "reviewStartedAt": "2026-10-15T12:00:00Z", "reviewDurationMs": 5400, "openedFullImage": false, "imageZoomUsed": true, "reviewToolVersion": "reviewer-1.0.0" }
}
```

A row request has `kind: ROW`, `target: { tableObservationId, rowIndex }` and `decision: { isPlayerRow, team, outcome }`. A table request has `kind: TABLE`, `target: { tableObservationId }` and `decision: { role, columnFields, undetectedRows }`. A bulk accept has `target: { tableObservationId, rowIndex }`, `cells: [{ cellObservationId, supersedesAdjudicationId }]`, `qualityRunId`, `clientRequestId` and `telemetry`. An escalation request has `items` (at most `maxEscalationItems` targets in the forms above, each with its `kind`), `qualityRunId` and `clientRequestId`.

The browser supplies only the decision, the target, `reviewPass`, `qualityRunId`, `supersedesAdjudicationId`, `clientRequestId` and telemetry. The server owns every other field:

| Field | Source |
| --- | --- |
| `adjudicationId`, `bulkActionId` | `evidenceId()` |
| `reviewerKind`, `reviewerId`, `llmReviewer` | `HUMAN`, the access token's `sub` claim, and `null`, on every write through this API |
| `runId`, `screenshotId`, `cellObservationId`, `tableObservationId`, indexes, `observedTextAtReview`, `semanticField`, `exportedField`, `rowRole`, `classification` and every `parser` field | the run's evidence (`normalized/observations.json` and its P0.3 provenance) |
| `selectionReason` | the pass (§7.7): `ESCALATION` for `PRIMARY`, `AUDIT_SAMPLE` for `BLIND_DOUBLE` and `DISAGREEMENT_RESOLUTION` |
| `priorityShown`, `shownPriority` | the review plan's display mode and the quality result named by `qualityRunId` (§7.6) |
| `priorDecisionsShown` | `true` for every `DISAGREEMENT_RESOLUTION`, and for any adjudication that supersedes one whose decision is not `SKIPPED`, because the reviewer saw the decision being replaced; `false` otherwise |
| `bulk` | `true` only on the bulk route |
| `decision` and `errorTypes` of rows and tables | derived from the reviewer's answers and the parser output (§7.4, §7.5) |
| `reviewedAt` | `max(now, predecessor.reviewedAt + 1 ms)`, for a `DISAGREEMENT_RESOLUTION` at least the current blind adjudication's `reviewedAt + 1 ms`, and for a `PRIMARY` write at least the item's latest escalation's `createdAt + 1 ms` (§7.8, §8.1) |
| `build`, `reviewPolicyVersion`, `reviewConfigVersion` | deployment |

Telemetry is client-reported and recorded as such. It is used for review analysis only and never becomes a feature (§8.6).

### 4.3 Validation and errors

Every request is validated against a schema before any read. Text fields are at most `maxTextLength` (256) characters.

| Condition | Status and code | Writes |
| --- | --- | --- |
| Missing or invalid token | `401` from the authorizer | nothing |
| `cognito:groups` lacks `labeler` | `403 NOT_A_LABELER` | nothing |
| Body fails the schema, or a target ID does not start with `<runId>:` | `400 INVALID_REQUEST` | nothing |
| Run not in `ReviewState`, or target not in the run's normalized observations | `404 RUN_NOT_FOUND`, `404 TARGET_NOT_FOUND` | nothing |
| Original screenshot, normalized observations or review plan missing | `409 EVIDENCE_INCOMPLETE` | nothing |
| `qualityRunId` is not a quality run of this run with a `SUCCEEDED` outcome | `409 QUALITY_RUN_MISMATCH` | nothing |
| An escalation request in a run that has never had an escalation, or a `PRIMARY` write, bulk accepts included, on an item that has never been escalated (§7.8) | `409 NOT_ESCALATED` | nothing |
| `BLIND_DOUBLE` on a cell with an open escalation, or on a cell that is not in the blind queue unless the caller wrote its blind chain, so nobody else can see or supersede another reviewer's blind adjudication | `409 NOT_IN_BLIND_QUEUE` | nothing |
| `BLIND_DOUBLE` by a reviewer with a primary-track adjudication of that cell | `409 SAME_REVIEWER` | nothing |
| `DISAGREEMENT_RESOLUTION` on a cell without an open disagreement, or by the blind reviewer | `409 NO_DISAGREEMENT`, `409 SAME_REVIEWER` | nothing |
| `supersedesAdjudicationId` is not the head of the target's chain in its track, read from S3 as in §6.2 step 3, and the request is not a replay | `409 STALE_RESOLUTION`, with the target's current resolution in that track | nothing |
| `SKIPPED` on a cell whose current decision is `ACCEPTED`, `CORRECTED` or `UNREADABLE`, or a bulk accept of an escalated cell whose escalation is no longer open, when the request is not a replay | `409 ALREADY_RESOLVED` | nothing |
| A bulk accept in which at least one cell failed | `409 BULK_PARTIAL`, with each cell's result (§6.2) | the cells that succeeded |
| A decision breaks a rule in §7.2, §7.4 or §7.5, such as `INVALID_TEAM` or `INVALID_ANCHOR` | `422 INVALID_DECISION`, with the rule's code | nothing |
| The run's player rows have inconsistent teams or outcomes (§8.3 condition 5) | not rejected; the run view and the write response report `OUTCOME_INCONSISTENT` for the rows involved | the adjudication |

An adjudication write checks these conditions in the order of §6.2 step 3: replay detection first, then the pass and escalation rules (`NOT_ESCALATED`, `NOT_IN_BLIND_QUEUE`, `SAME_REVIEWER`, `NO_DISAGREEMENT`), then `STALE_RESOLUTION`, then the decision rules (`ALREADY_RESOLVED`, `INVALID_DECISION`). A response carries a resolution only after the request has passed the pass and escalation rules, so the only resolution it can show is one the caller may see in that pass: an escalated item's or a disagreement's primary resolution, or the caller's own blind adjudication. The pass and escalation codes carry no resolution, decision, value or reviewer kind, and `NOT_IN_BLIND_QUEUE` is the same for a cell that is not sampled and a sampled cell that is not queued.

### 4.4 Queue trigger

The stack's EventBridge rule matches `aws.s3` `Object Created` events from the evidence bucket whose key matches:

| Deployment | Key pattern (EventBridge `wildcard`) |
| --- | --- |
| Stable `dev` or `prod` | `submissions/*/screenshots/*/runs/*/quality/*/outcome.json` |
| Ephemeral `<name>` | `ephemeral/<name>/submissions/*/screenshots/*/runs/*/quality/*/outcome.json` |

The rule invokes `EnqueueRun` asynchronously with a retry policy of 3 attempts within 2 hours, and sends undeliverable events to `<stack>-events-dlq` (SQS-managed encryption, 14-day retention). The function's asynchronous invocation allows 2 retries and sends failed events to the same queue. `EnqueueRun` re-checks the key against `^(ephemeral/[a-z0-9][a-z0-9-]{0,19}/)?submissions/[^/]+/screenshots/[^/]+/runs/[^/]+/quality/[^/]+/outcome\.json$` and its own namespace, and fails with `InvalidQualityOutcomeKeyError` otherwise.

### 4.5 LLM reviewer writes

`LlmReviewWrite` is the only writer of LLM adjudications and of escalations raised by the LLM reviewer. It has no API Gateway route, function URL, CloudFront behavior or event source, so no browser, Cognito token or reviewer API request can reach it. A caller invokes it synchronously with `lambda:InvokeFunction`. Lambda does not pass the caller's identity to the function, so IAM is the whole authorization. The only workload role allowed to invoke it is the LLM reviewer's execution role, which the OCR risk model specification (#165) defines, and no role this stack creates may invoke it (§13.4). The function's own execution role is the service role that writes LLM decisions. The reviewer API never writes an `LLM` adjudication, and `LlmReviewWrite` never writes a `HUMAN` one. An ephemeral stack's writer accepts only runs in its own namespace.

The payload is one of two operations:

```json
{
  "operation": "ADJUDICATE",
  "runId": "<runId>",
  "kind": "CELL",
  "target": { "cellObservationId": "<runId>:cell:<providerBlockId>" },
  "qualityRunId": "<qualityRunId>",
  "selectionReason": "REVIEW_ALL",
  "supersedesAdjudicationId": null,
  "clientRequestId": "<UUID generated per decision>",
  "decision": { "decision": "CORRECTED", "submittedValue": "16", "errorTypes": ["GLYPH_SUBSTITUTION"] },
  "llmReviewer": { "modelId": "<Bedrock model ID as invoked>", "promptVersion": "<prompt version>", "invocationKey": "<key of the stored prompt and response>" },
  "inputsShown": { "priority": false, "priorDecisions": false }
}
```

`kind`, `target` and `decision` take the cell, row and table forms of §4.2. An `ESCALATE` payload has `runId`, `qualityRunId`, `clientRequestId`, `items` as in §4.2, `reasonCodes` and `llmReviewer`. A reason code matches `^[A-Z][A-Z0-9_]{0,63}$`; #165 defines the codes and when the LLM reviewer escalates, and this component stores them without interpreting them.

The writer derives every other field as §4.2 does, with these differences:

| Field | Source |
| --- | --- |
| `reviewerKind`, `reviewerId` | `LLM`, `null` |
| `llmReviewer` | `modelId`, `promptVersion` and `invocationKey` from the payload, and `invocationSha256`, the SHA-256 of the object the writer reads at `invocationKey` |
| `selectionReason` | the payload, checked against §7.7 |
| `priorityShown` | `inputsShown.priority`: whether the prompt contained any spec 2 priority, score, signal or constraint result for the run |
| `shownPriority` | as §4.2 when `priorityShown` is true, otherwise `null` |
| `priorDecisionsShown` | `true` when `inputsShown.priorDecisions` is true or the adjudication supersedes one whose decision is not `SKIPPED`, as for people (§4.2) |
| `telemetry` | `null` |
| `bulk`, `bulkActionId` | `false`, `null` |

The response body carries a `status` and `code` with the meanings of §4.3, the adjudication or escalation, the item's resolution, the run's counts, the rows that break §8.3 condition 5 with `OUTCOME_INCONSISTENT`, and the latest validated version. A rejected request is a response, not a function error, so the caller can read the code. A storage error is a function error, and the caller retries with the same `clientRequestId`. Besides the §4.3 checks that apply to it, the writer rejects:

| Condition | Status and code |
| --- | --- |
| `invocationKey` not under the run's prefix, or under a prefix this component, match-to-csv or spec 2 writes | `400 INVALID_REQUEST` |
| No object at `invocationKey` | `409 INVOCATION_EVIDENCE_MISSING` |
| A `selectionReason` the LLM may not write, or one the run's plan does not allow (§7.7) | `422 INVALID_DECISION` with `SELECTION_REASON_NOT_ALLOWED` |
| A `SKIPPED` decision; the LLM reviewer escalates an item it cannot decide | `422 INVALID_DECISION` with `LLM_CANNOT_SKIP` |
| `inputsShown.priority` true in a `PRIORITY_HIDDEN` run (§7.6) | `409 PRIORITY_HIDDEN` |
| The head of the item's primary chain is a `HUMAN` adjudication (§8.1) | `409 HUMAN_DECIDED` |
| The item has an open escalation (§7.8) | `409 ESCALATED` |

## 5. Review evidence

### 5.1 Layout

```text
[ephemeral/<name>/]submissions/{submissionId}/screenshots/{screenshotId}/runs/{runId}/
  review/
    plan.json
    escalations/{escalationId}.json
  adjudications/
    cells/{cellBlockId}/{predecessor}.json
    rows/{tableBlockId}/{rowIndex}/{predecessor}.json
    tables/{tableBlockId}/{predecessor}.json
  blind-adjudications/
    cells/{cellBlockId}/{predecessor}.json
  validated/
    {validatedVersion}.json
```

`cellBlockId` and `tableBlockId` are the Textract block IDs at the end of `cellObservationId` and `tableObservationId` (`<runId>:cell:<blockId>`, spec 1 §7.2). `{predecessor}` is `root` for an item's first adjudication and the superseded `adjudicationId` for every later one. `{validatedVersion}` is the version number zero-padded to six digits, so keys sort in version order. `{escalationId}` is an `evidenceId()` value. The LLM reviewer's stored prompts and responses are under the run's prefix at keys the OCR risk model specification (#165) defines; adjudications refer to them by key and hash and this component never writes them.

### 5.2 Rules

1. Review evidence is immutable. Every object is written once with `If-None-Match: *`.
2. An item has at most one adjudication per predecessor, so each item's adjudications form one chain in each track (§8.1).
3. A run's review plan is written once, before any adjudication of the run is accepted. Rebuilds read it and never recompute it.
4. Validated versions are numbered from 1 without gaps. Each records the previous version's ID.
5. Every adjudication records the server time, the deployed commit and every review stage version (§5.4).
6. Adjudications never change observed text. Evidence that match-to-csv or spec 2 wrote is never modified.

### 5.3 Document schemas

| Object | `schemaVersion` | Writer | Contents |
| --- | --- | --- | --- |
| `review/plan.json` | `review-plan/v1` | `enqueue-run` | `ReviewPlan` (§10.1): `runId`, `screenshotId`, `selectionReason`, `displayMode`, `blindSampleCellIds`, `reviewConfigVersion`, `samplingSeedSha256`, the triggering `qualityRunId`, `createdAt` |
| `review/escalations/{escalationId}.json` | `review-escalation/v1` | `llm-review-write` (LLM reviewer), `review-write` (people) | `ReviewEscalation` (§7.8, §10.1) |
| `adjudications/cells/...` | `cell-adjudication/v1` | `review-write` (`HUMAN`), `llm-review-write` (`LLM`) | `CellAdjudication` with `reviewPass` `PRIMARY` or `DISAGREEMENT_RESOLUTION` |
| `adjudications/rows/...` | `row-adjudication/v1` | `review-write` (`HUMAN`), `llm-review-write` (`LLM`) | `RowAdjudication` |
| `adjudications/tables/...` | `table-adjudication/v1` | `review-write` (`HUMAN`), `llm-review-write` (`LLM`) | `TableAdjudication` |
| `blind-adjudications/cells/...` | `cell-adjudication/v1` | `review-write` | `CellAdjudication` with `reviewPass: BLIND_DOUBLE`, always `HUMAN` |
| `validated/{validatedVersion}.json` | `validated-table/v1` | `review-write`, `llm-review-write`, `enqueue-run`, `rebuild-review-state` | `ValidatedTable` (§8.4) |

### 5.4 Stage versions

Any change to a stage's behavior bumps its version in the same delivery.

| Key | v1 value |
| --- | --- |
| `reviewPolicyVersion` | `review-all-v1` |
| `reviewConfigVersion` | `review-config-v1` |
| `validatedTableBuilderVersion` | `validated-table-v1` |
| `reviewToolVersion` | `reviewer-<web package version>`, reported by the client on human adjudications and checked against `^reviewer-[0-9]+\.[0-9]+\.[0-9]+$`. An LLM adjudication records `llmReviewer.promptVersion` and `modelId` instead (§4.5). |

## 6. Review workflow

### 6.1 Enqueue

`enqueueRun(event, dependencies)`:

1. Validate the key (§4.4). Read the quality `outcome.json`. Stop with `skipped: QUALITY_NOT_SUCCEEDED` unless its status is `SUCCEEDED`.
2. Read the run `manifest.json` and `normalized/observations.json`. Stop with `skipped: MISSING_PARSER_PROVENANCE` when `parser.provenance` (spec 2 P0.3) is absent. An operator replays such a run (spec 1 §6.2); the replay is scored and enqueued like any run.
3. Build the review plan (§7.6) and write it create-only. On 412, read the existing plan and continue with it.
4. Put the run's `META` item if it does not exist (§8.2). `META` holds status `OPEN`, run prefix, `screenshotId`, `enqueuedAt` and the plan's display mode. Otherwise update `latestQualityRunId` when the new `qualityRunId` is greater. The run is not in any human queue until it is escalated (§7.8). The LLM reviewer (#165) reviews the run once its plan exists; how it finds new plans is #165's design.
5. Evaluate the run once (§6.3). A run in which Textract found no table has no required item, so this evaluation completes it and writes its validated table with no rows.
6. Log `Run enqueued` with `runId`, `qualityRunId` and the outcome of each step.

A re-score therefore never re-enqueues or resets a run. It only moves `latestQualityRunId`, which the next page load shows.

### 6.2 Adjudication write

`writeAdjudication(input, dependencies)`:

1. Read `reviewerId` from `sub` and require `labeler` (§4.3). Validate the body. The adjudication is `HUMAN`.
2. Load the run's `META` item and its evidence: manifest, normalized observations, review plan, the run's escalations, and the quality result and outcome named by `qualityRunId`. Evidence objects are immutable, so the handler caches parsed objects by key for the life of the execution environment, up to 64 MB.
3. List the item's chain prefix in its track (§5.1), and for a `BLIND_DOUBLE` or `DISAGREEMENT_RESOLUTION` write also the cell's other track, and resolve the chains (§8.1). The chains read from S3, never the projection, decide what is current. Let the successor key be the key named after `supersedesAdjudicationId`, or `root` when it is `null`. Apply these in order and stop at the first that returns:
   1. When the successor key exists and its object has the request's `clientRequestId` and the caller's `reviewerId`, the request is a replay. Skip every other check and the write, run steps 5 and 6 with that object so a failed projection update or evaluation is repaired, and return it with `200`.
   2. Check the pass rules (§4.3, §6.4) and, for a `PRIMARY` write, the escalation rule (§7.8). A failure returns its code with no resolution, so a caller who may not review the item in this pass never sees its decision, value or reviewer kind, whatever `supersedesAdjudicationId` it sent.
   3. When the successor key exists with another `clientRequestId` or another reviewer, or a non-null `supersedesAdjudicationId` is not an adjudication in the chain, return `409 STALE_RESOLUTION` with the current resolution in the request's track.
   4. Check the decision rules (§7) against the chain's head, and derive server-owned fields (§4.2).
4. Write the adjudication to the successor key with `If-None-Match: *`. On 412, another request wrote the key after the listing: apply step 3.1 or 3.3 to the object it wrote. Step 3.2 has already passed, so the response may carry the resolution.
5. Update the item's projection (§8.2). A `BLIND_DOUBLE` write also removes the cell's blind queue keys in the same update, so the cell leaves the blind queue.
6. For a `BLIND_DOUBLE` write, evaluate the disagreement (§6.4) and stop. Otherwise evaluate the run (§6.3) and, for a cell with a blind adjudication, the disagreement.
7. Return `201` with the adjudication, the item's resolution, the run's counts and the latest validated version.

A bulk accept performs steps 1 to 5 for each listed cell in column order, with one `bulkActionId`, `bulk: true` and the per-cell `clientRequestId` `<clientRequestId>:<cellObservationId>`, then step 6 once. Every listed cell must belong to the target row and have an open escalation, unless step 3.1 finds that its write is a replay. A listed cell that has never been escalated fails with `NOT_ESCALATED` and no resolution (step 3.2). A failure on one cell does not undo earlier ones. The response lists each cell's result (`201` written, `200` replayed, or the error code). Its status is `200` when every listed cell was written or replayed, and `409 BULK_PARTIAL` otherwise, so a client that reads only the status still sees the failure. A retry with the same `clientRequestId` returns the cells already written as replays instead of `409 ALREADY_RESOLVED`.

### 6.3 Run evaluation and validated tables

`evaluateRun(runPrefix, dependencies)` runs after every primary-track write and every escalation, from either writer, once at enqueue (§6.1), and in every rebuild:

1. List the run's `adjudications/` and `review/escalations/` prefixes, resolve every chain (§8.1) and find the open escalations (§7.8). S3 listings are strongly consistent, so the listing includes the write that triggered the evaluation.
2. Compute the review scope and completion (§7.1, §8.3). In one `TransactWriteItems`, update the `META` counts, counts per reviewer kind, status and `evaluatedAdjudicationCount` (the number of listed adjudication and escalation keys) with the condition that `evaluatedAdjudicationCount` does not decrease, and put the run's `QUEUE#PRIMARY` item when the run has an open escalation or delete it when it has none (§8.2). The condition keeps an evaluation with an older listing from overwriting a newer one's status or queue membership. When the condition fails, a newer evaluation has run and this one stops. Otherwise set `escalationOpen` on the `CELL` item of each escalated cell whose state changed, storing this evaluation's `evaluatedAdjudicationCount` with it and on the condition that the stored count is not greater, so an older listing never overwrites a newer state. When the run is incomplete, stop.
3. Add every sampled cell in scope (§7.6) that has neither a blind adjudication nor blind queue keys to the blind queue, with a conditional update of its `CELL` item that sets only the blind queue keys, on the condition that the item has no queue keys and no blind chain head. The update never replaces the item, so the cell's projection and reviewer sets stay intact. The step is idempotent and runs on every evaluation of a complete run, so cells of a table added to the scope later, and cells missed by an evaluation that stopped early, are queued by the next evaluation.
4. Compute `adjudicationSetSha256` over the listed adjudication keys (§8.5). List `validated/` and read the latest version. Adjudication keys are only ever added, so two listings of one run differ only by keys added between them. When the latest version's `lineage.adjudicationCount` is at least the number of listed adjudication keys, it was built from this listing's set or a later one, and the evaluation stops.
5. Build the validated table (§8.4) as version `n + 1` and write it create-only. On 412, another writer has written that version: return to step 1, at most 3 times, then log `VALIDATED_WRITE_CONTENDED` at `WARN` and leave the write to the next evaluation.

A table decision that adds a table to the scope can make a complete run incomplete again (§8.3). Its earlier validated versions stay, and the next version is written when the run is complete again.

### 6.4 Blind audit sample and disagreements

The blind audit sample is the blind double-review sample of §7.6. It audits the primary decision of each sampled cell, whichever kind of reviewer made it, with the same rules for both kinds. A person, the blind reviewer, takes cells from the `BLIND_DOUBLE` queue and sees only the blind view (§4.1), which never shows the primary decision, its value, its reviewer kind or an LLM rationale. No write response shows them either, because every write checks the pass rules before it returns a resolution (§4.3). The blind view also returns the `qualityRunId` the blind write submits, so the audit works in a run that never had an escalation and has no run view. Their adjudication goes to `blind-adjudications/` with `reviewPass: BLIND_DOUBLE`, `selectionReason: AUDIT_SAMPLE` and `priorityShown: false`, and it never supersedes or changes the primary track. Its `priorDecisionsShown` is `false` unless it replaces the blind reviewer's own earlier decision (§4.2). The blind track holds only `HUMAN` adjudications; the LLM reviewer never writes it.

A primary and a blind resolution agree when both decisions are the same and, for `ACCEPTED` and `CORRECTED`, their resolved texts are identical. Error types are not compared. A cell has an open disagreement when its current primary and blind resolutions disagree and the primary chain has no `DISAGREEMENT_RESOLUTION` adjudication with a `reviewedAt` later than the current blind adjudication's. The rule is a pure function of the two chains, so writes and rebuilds compute the same answer. The server evaluates it after a blind write and after any primary-track write to a cell with a blind adjudication. It records the result as `disagreementOpen` on the cell's `CELL` item, and sets or removes the cell's `DISAGREEMENT` queue keys in the same update (§8.2). The update carries the primary and blind chain lengths it was computed from, and is conditional on neither length being lower than the stored ones, so an evaluation from older chains never overwrites a newer result.

Any labeler other than the blind reviewer opens an open disagreement, sees both decisions without reviewer identities or reviewer kinds, and writes a `DISAGREEMENT_RESOLUTION` adjudication that supersedes the current primary adjudication, `LLM` or `HUMAN`. The disagreement closes whatever the resolver decides, including when the resolver keeps the first decision or chooses a third value. A later blind adjudication of the same cell can open it again. Because the resolution changes the primary set, the run gets a new validated version (§6.3).

### 6.5 Rebuild

`RebuildReviewState` is invoked by an operator with `{ "scope": "RUN", "runPrefix": <prefix> }` or `{ "scope": "NAMESPACE" }`. For each run in scope with a `SUCCEEDED` quality outcome, it writes the plan and `META` item when missing (§6.1 steps 2 to 4), resolves every chain and writes each item's projection, recomputes each cell's blind or disagreement queue keys, and runs §6.3, which restores the run's `QUEUE#PRIMARY` item from its open escalations. `NAMESPACE` lists every key under `<ns>submissions/`. It is the backfill path for runs scored before this component was deployed, and the recovery path after the table is deleted. A rebuild writes the same projections as incremental writes (§16.1) and is idempotent.

### 6.6 Retries and failure

API handlers rely on the SDK's default retries and return `503 UNAVAILABLE` for any other storage error, after which the browser retries the request with the same `clientRequestId`. An adjudication whose projection update failed is still the chain's head. A replay, the next write to the item or a rebuild repairs the projection (§8.2). A validated version missed because a handler stopped after step 4 of §6.2 is written by the browser's replay of the same request, the next primary write to the run, or a rebuild (§18.4). `EnqueueRun` errors are retried as in §4.4 and are safe to repeat. `LlmReviewWrite` returns storage errors as function errors, and the LLM reviewer retries with the same `clientRequestId` (§6.7).

### 6.7 LLM adjudication and escalation writes

`writeLlmAdjudication(payload, dependencies)` follows §6.2 with these changes:

1. Validate the payload (§4.5). There is no token; the adjudication is `LLM`, its pass is always `PRIMARY`, and it is never a bulk write.
2. Load the run's evidence as in §6.2 step 2, and read the object at `invocationKey` to compute `invocationSha256`.
3. Resolve the chain and detect a replay as in §6.2 step 3.1, matching `clientRequestId` on an `LLM` object, because the writer has no caller identity. Before the other checks, reject the write when the head is a `HUMAN` adjudication (`409 HUMAN_DECIDED`) or the item has an open escalation (`409 ESCALATED`), then apply §4.3, §4.5 and §7.
4. Continue with §6.2 steps 4 to 7, and return the §4.5 body.

`writeEscalation(input, dependencies)` serves both the `ESCALATE` operation and the reviewer API's escalation route:

1. Validate the payload or body. From `LlmReviewWrite` the escalation records `raisedBy: LLM_REVIEWER`, the payload's `reasonCodes` and `llmReviewer` with its `invocationSha256`. From the reviewer API it records `raisedBy: HUMAN`, the caller's `reviewerId` and `reasonCodes: ["REVIEWER_REQUESTED"]`, and requires that the run already has an escalation (§4.3).
2. List the run's `review/escalations/` prefix. When an escalation with the same `clientRequestId` exists, the request is a replay: evaluate the run as in step 5 and return that escalation with `200`.
3. Check that every item exists in the run's normalized observations. Read each item's primary chain head from S3 and set `createdAt` to `max(now, latest head reviewedAt + 1 ms)`, so a person's decision written before the escalation can never count as answering it (§7.8).
4. Write the escalation to `review/escalations/{escalationId}.json` with `If-None-Match: *`. Two concurrent requests with one `clientRequestId` can both write. The duplicate names the same items, so at worst a person confirms them once more.
5. Evaluate the run (§6.3), which puts its `QUEUE#PRIMARY` item, and return `201` with the escalation and the run's counts.

## 7. Review policy

### 7.1 Review scope

A table is in the run's review scope when any of these holds: spec 2 assesses it (classification `SCOREBOARD`, spec 2 §7.4), the parser selected it (`parser.provenance.selectedTableIndex`), or its current table decision has `role: SCOREBOARD`. The required items of a run are:

- a table decision for every table of the run, in scope or not;
- a cell decision for every cell, header cells included, of every table in scope;
- a row decision for every row, header row included, of every table in scope.

The LLM reviewer may also adjudicate items of tables outside the scope, and people may when those items are escalated. Those adjudications are labels, but the run waits for them only while they are escalated (§8.3 condition 6).

### 7.2 Cell decisions

| Decision | Meaning | Rules | Resolved text |
| --- | --- | --- | --- |
| `ACCEPTED` | The observed text is exactly what the screenshot shows. | No `submittedValue`; `errorTypes` empty. | `observedTextAtReview` |
| `CORRECTED` | The screenshot shows different text. | `submittedValue` required, different from `observedTextAtReview`, at most 256 characters; `errorTypes` non-empty (§7.3). | `submittedValue` |
| `UNREADABLE` | The reviewer cannot read the cell in the screenshot. | No `submittedValue`; `errorTypes` empty. | none |
| `SKIPPED` | A person moved on without deciding. Primary track only; the LLM reviewer escalates instead (§4.5). | Only when the cell's current decision is none or `SKIPPED`. | none; the cell stays unresolved |

An empty observed text is accepted when the screenshot cell is empty. Corrections are free text: the API does not require digits in integer columns, the reviewer interface warns when a correction in an integer column is not all digits, and the validated table keeps the text (§8.4).

"Accept the rest of this row" accepts every cell of one table row that has an open escalation as separate `ACCEPTED` adjudications marked `bulk: true` with a shared `bulkActionId` (§6.2). Each is a full adjudication with its own observed text and fields, and analysis can tell bulk decisions from individual ones.

### 7.3 Cell error types

| Error type | Meaning |
| --- | --- |
| `GLYPH_SUBSTITUTION` | One or more characters were read as other characters, such as `I6` for `16`. |
| `MISSING_CHARACTERS` | Characters on screen are absent from the observed text, including an empty observation of a non-empty cell. |
| `EXTRA_CHARACTERS` | The observed text has characters the cell does not show, such as noise or a border read as `1`. |
| `SHIFTED_CELL` | The observed text belongs to a neighboring cell. |
| `MERGED_CELL` | The observed text joins this cell's text with a neighbor's. |
| `OTHER` | An error none of the above describes. |

A correction can carry several types, sorted and without duplicates.

### 7.4 Row decisions

The reviewer answers three questions for a table row: whether it is a player row (`isPlayerRow`), the player's team (`team`), and the outcome (`outcome`, `WIN` or `LOSS`). `team` is one of the MCC colour names in spec 1 §8.4, optionally followed by a space and a digit from 2 to 9, or an empty string in a free-for-all (`422 INVALID_DECISION` with `INVALID_TEAM` otherwise). `team` and `outcome` are required when `isPlayerRow` is true and must be `null` otherwise.

The server copies the parser's output for the row (whether `parser.provenance.rowIndexes` lists it, and the team, win and loss of its exported row) and derives the error types:

| Error type | Condition |
| --- | --- |
| `MISSING_ROW` | `isPlayerRow` and the parser did not export the row |
| `EXTRA_ROW` | the parser exported the row and `isPlayerRow` is false |
| `WRONG_TEAM` | `isPlayerRow`, exported, and `team` differs from the parser's team |
| `WRONG_OUTCOME` | `isPlayerRow`, exported, and `outcome` differs from the parser's win and loss |

`decision` is `CONFIRMED` when the list is empty and `CORRECTED` otherwise. The reviewer confirms team and outcome on every player row, including rows the parser got right, because the parser derives both (spec 1 §8.4, §8.5).

### 7.5 Table decisions

The reviewer states the table's `role` (`SCOREBOARD` or `NOT_SCOREBOARD`). For a `SCOREBOARD` table they also confirm `columnFields`, a field for every column index (`PLAYER`, `SCORE`, `KILLS`, `ASSISTS`, `DEATHS` or `NONE`), with exactly one `PLAYER` column and at most one column per other field, and list `undetectedRows`: player rows the screenshot shows but Textract never detected. Each undetected row holds `insertAfterRowIndex`, `team`, `player`, `score`, `kills`, `assists`, `deaths` and `outcome`, entered by the reviewer. `insertAfterRowIndex` is `0` for the top of the table or the `rowIndex` of a row in the same table, so it lies between `0` and the table's largest `rowIndex` (`422 INVALID_DECISION` with `INVALID_ANCHOR` otherwise). `team` follows the §7.4 pattern (`INVALID_TEAM` otherwise), and `outcome` is `WIN` or `LOSS`. Adding or editing an undetected row writes a new table adjudication that supersedes the previous one with the complete list.

The server copies whether the parser selected the table and the parser's `columnFields`, and derives the error types:

| Error type | Condition |
| --- | --- |
| `WRONG_TABLE` | the parser selected the table and `role` is `NOT_SCOREBOARD`, or the parser did not select it and `role` is `SCOREBOARD` |
| `WRONG_COLUMN_MAPPING` | the parser selected the table, `role` is `SCOREBOARD`, and `columnFields` differs from the parser's mapping, reading an unmapped column as `NONE` |
| `MISSING_ROW` | `undetectedRows` is not empty |

`decision` follows the same rule as rows. A scoreboard that Textract split into two tables (spec 1 §18.4) is two `SCOREBOARD` tables, and the second carries `WRONG_TABLE`.

### 7.6 Display modes and blind sampling

`samplingSeed` is a secret read from SSM (§13.2), never from configuration or source, so nobody can compute in advance which runs will hide priorities or which cells will be double-reviewed. The plan records `samplingSeedSha256`, never the seed.

`enqueue-run` decides both samples once per run and records them in the review plan. With `h(x)` the first four bytes of `sha256(x)` read as an unsigned big-endian integer:

- **Display mode.** The run is `PRIORITY_HIDDEN` when `h(samplingSeed + "\0hidden\0" + runId) mod 10000 < priorityHiddenShare * 10000`, otherwise `PRIORITY_SHOWN`. In a hidden run the API returns no priority, score or signal for any item (§4.1), and every adjudication records `priorityShown: false`.
- **Blind sample.** A cell is sampled when `h(samplingSeed + "\0blind\0" + cellObservationId) mod 10000 < blindDoubleReviewShare * 10000`. The plan lists the sampled cells of every table, and those in scope enter the blind queue once the run is complete (§6.3 step 3).

In a shown run, `priorityShown` is `true` on every human `PRIMARY` adjudication. `BLIND_DOUBLE` and `DISAGREEMENT_RESOLUTION` adjudications always record `priorityShown: false`, because their screens never show a priority (§9.3). `shownPriority` is the item's own priority from the quality result named by `qualityRunId`: the cell's `reviewPriority`, the table's `summary.reviewPriority`, or the row's `reviewPriority` from spec 2 §9.4. The reviewer interface displays the same value on each item. It is `null` when the item has no priority, such as a cell of an unassessed table, and always `null` when `priorityShown` is false.

Labels with `priorityShown: false` and `priorDecisionsShown: false`, from hidden runs and from the blind sample, are the blind labels spec 2 §9.6 measures its automation gate on. A label that replaces an earlier decision records `priorDecisionsShown: true` (§4.2) and is not blind, even in a hidden run.

These rules apply to LLM adjudications as they do to human ones (§4.5). An LLM adjudication records `priorityShown: true` when its prompt contained any spec 2 priority, score, signal or constraint result for the run, and the writer rejects that in a `PRIORITY_HIDDEN` run, so every adjudication of a hidden run is still written without a priority. It records `priorDecisionsShown: true` when its prompt contained an earlier decision of the item or it supersedes a decision that is not `SKIPPED`. An LLM label with both flags false is a blind label. `reviewerKind` lets the risk model gate separate blind LLM labels from blind human ones; which of them a gate may use is the OCR risk model specification's decision (#165). A person in the blind audit never sees the LLM's decision, value or rationale, from the blind view or from any write response (§4.3, §6.4).

### 7.7 Selection reasons and later stages

`selectionReason` records why an item was put in front of a reviewer. Spec 2 §9.6 defines the stages, and the OCR risk model specification (#165) performs them with the LLM reviewer. Each value belongs to one reviewer kind, and the writers reject a value from the other kind.

| Value | Reviewer kind and pass | Stage | Written by v1 | Meaning |
| --- | --- | --- | --- | --- |
| `REVIEW_ALL` | `LLM`, `PRIMARY` | 1 and 2 | yes | The LLM reviewer reviews every item in scope, whatever its priority or constraints. The run's plan has `selectionReason: REVIEW_ALL`. |
| `MODEL_FLAGGED` | `LLM`, `PRIMARY` | 3 | no | The risk model flagged the item, so the LLM reviewer reviews it. The item may show the model's decision (`shownRiskModel`). |
| `CONSTRAINT_FAILED` | `LLM`, `PRIMARY` | 3 | no | A scoreboard constraint check (#165) failed for the item or its table, so the LLM reviewer reviews it. |
| `ESCALATION` | `HUMAN`, `PRIMARY` | all | yes | The item is escalated (§7.8), so a person reviews it. The person may see the item's current decision, its reviewer kind and the escalation's reason codes, and the label records `priorDecisionsShown: true` when they replace a decision. |
| `AUDIT_SAMPLE` | `HUMAN`, `BLIND_DOUBLE` and `DISAGREEMENT_RESOLUTION`; `PRIMARY` reserved | all; `PRIMARY` in 3 | yes, except on `PRIMARY` | The item was drawn at random for a person to audit, without seeing the decision under audit. On `BLIND_DOUBLE` the cell is in the run's blind sample (§7.6), and the person sees no primary decision, value, reviewer kind, LLM rationale or priority. A disagreement resolution of an audited cell keeps the reason that brought the cell to a person. On `PRIMARY`, reserved for stage 3 (P5.2), a person reviews an auto-accepted item from spec 2 §9.6's audit sample, without the model's decision or score. |

Spec 2 §9.6 names `AUDIT_SAMPLE` only for the stage 3 audit of auto-accepted cells. This specification uses it for every blind audit by a person, because the blind sample audits LLM decisions from stage 1 onwards, and keeps the stage 3 use as the reserved `PRIMARY` form. v1 rejects any other plan `selectionReason` than `REVIEW_ALL`, and `LlmReviewWrite` rejects `MODEL_FLAGGED` and `CONSTRAINT_FAILED` until a plan can select items (`SELECTION_REASON_NOT_ALLOWED`, §4.5). The optional `shownRiskModel` field on adjudications is reserved for stage 3 and never written in v1. Stage 2 runs the model in shadow and changes nothing here. Stage 3 also needs a validated table value source for auto-accepted cells, reserved as `AUTO_ACCEPTED` (§8.4), and an audit of auto-accepted items. The OCR risk model specification (#165) owns how plans select items and how completion counts auto-accepted items (P5.2).

### 7.8 Escalations

An escalation hands items to people. The LLM reviewer raises one through `LlmReviewWrite` when the OCR risk model specification's rules say a person must decide (#165), for example a correction that leaves the table failing its constraints. A person reviewing an escalated run raises one through the reviewer API when they need to decide an item that is not yet escalated, such as another row of a table whose outcomes are inconsistent (§8.3 condition 5). Each escalation is an immutable `review-escalation/v1` object listing its items, reason codes, who raised it and `createdAt` (§6.7, §10.1).

An item's escalation is open until the item's primary chain has a `HUMAN` adjudication, with a decision other than `SKIPPED`, whose `reviewedAt` is later than the item's latest escalation's `createdAt`. A run has an open escalation when any of its items has one. The rule is a pure function of the chains and escalations, so writes and rebuilds compute the same answer.

- People write `PRIMARY` adjudications only on items that have been escalated, open or answered, so a person can correct an earlier human answer. A `DISAGREEMENT_RESOLUTION` needs no escalation.
- The LLM reviewer cannot write an item while its escalation is open (`409 ESCALATED`), and once a person has answered it the head is `HUMAN` (`409 HUMAN_DECIDED`, §8.1).
- An escalation does not change any resolution. An escalated item keeps its current decision, from either kind of reviewer, until a person supersedes it.
- A run with an open escalation is in the `PRIMARY` queue and is not complete (§8.3).

## 8. Resolution and the validated table

### 8.1 Chains and supersession

An item is a cell in the primary track, a cell in the blind track, a row, or a table. Its adjudications form a chain: the first has `supersedesAdjudicationId: null` and the key `.../root.json`, and each later one names the current head and has the key `.../<head adjudicationId>.json`. Because the key is create-only, two submissions naming the same predecessor cannot both be written, and the second gets `409 STALE_RESOLUTION`. So a replacement supersedes the current resolution only when it names it, and storage enforces that rule, not the projection.

Supersession across reviewer kinds follows one rule: a `HUMAN` adjudication may supersede an `LLM` or `HUMAN` one, and an `LLM` adjudication may supersede only an `LLM` one. `LlmReviewWrite` checks the head it read from S3 and rejects the write with `409 HUMAN_DECIDED` when the head is `HUMAN`. Because only people can supersede a person, a chain never returns to `LLM` once it has a `HUMAN` element, and no automated pass overrules a person. A person who agrees with an earlier LLM decision records it as their own adjudication. Blind chains are `HUMAN` only (§6.4).

The current adjudication of an item is the chain's last element. `reviewedAt` strictly increases along a chain: the writer sets it to `max(now, predecessor.reviewedAt + 1 ms)`, so clock differences between Lambda execution environments can never order a successor before its predecessor. A `DISAGREEMENT_RESOLUTION` also takes at least the current blind adjudication's `reviewedAt` plus 1 ms, so the open-disagreement rule (§6.4) always sees it as later than the blind decision it resolves. The resolution as of a cutoff (spec 2 §8.5 rule 1) is the last element whose `reviewedAt` is at or before the cutoff. A chain with a missing link, which create-only writes cannot produce, fails resolution with `BrokenChainError` and is logged at `ERROR`.

### 8.2 Resolutions and the `CellResolution` projection

`CellResolution` (§10.1) is the current state of one cell in the primary track: the current adjudication, its reviewer kind, its decision and its resolved text (§7.2). Rows and tables have the same projection with their own fields. Projections live in the `ReviewState` table and are never evidence.

Each projection item stores `chainLength`, the number of adjudications in its chain. An update writes the new head with the condition `attribute_not_exists(chainLength) OR chainLength < :newLength`, so a late or repeated update never moves a projection backwards, and any writer that knows a longer chain can repair it. Deleting the table and running a `NAMESPACE` rebuild reproduces every projection exactly.

The read routes use only these attributes and never list the bucket:

| Item | Attributes | Written by |
| --- | --- | --- |
| `META` | `runPrefix`, `screenshotId`, `displayMode`, `latestQualityRunId`, `status` (`OPEN` or `COMPLETE`), required and resolved counts per item kind, resolved counts per item kind and reviewer kind of the current decision, `openEscalationItemCount`, `evaluatedAdjudicationCount`, `latestValidatedVersion` and `latestValidatedTableId`; no queue keys | `enqueue-run` (§6.1), `evaluateRun` (§6.3), `rebuild-review-state` |
| `QUEUE#PRIMARY` | queue keys `QUEUE#PRIMARY` and `<escalatedAt>#<runId>`, where `escalatedAt` is the `createdAt` of the run's oldest escalation with an open item; present exactly while the run has an open escalation (§7.8) | `evaluateRun`, `rebuild-review-state`, always in a transaction with the `META` status update |
| `CELL#<blockId>` | the `CellResolution` fields, `primaryReviewerIds` (the `sub` of every person with an adjudication in the cell's primary chain; `LLM` adjudications have none), `blindSampled`, `escalationOpen` (whether the cell has an open escalation, §7.8), the blind chain's head and `chainLength`, `blindReviewerId`, `disagreementOpen` with the chain lengths it was computed from, and at most one pair of queue keys: `QUEUE#BLIND` while the cell waits for a blind review, or `QUEUE#DISAGREEMENT` while its disagreement is open | `review-write`, `llm-review-write`, `evaluateRun`, the disagreement check (§6.4), `rebuild-review-state` |
| `ROW#...`, `TABLE#...` | the row or table resolution, its reviewer kind and `chainLength` | `review-write`, `llm-review-write`, `rebuild-review-state` |

A run can be in the primary queue and have cells in the disagreement queue at the same time, because the run's queue membership lives on its own `QUEUE#PRIMARY` item and each cell's on its `CELL` item. A cell never needs two queues at once: a disagreement needs a blind adjudication, and the blind write removes the cell's blind queue keys (§6.2 step 5).

`latestValidatedVersion` is updated with the condition that it only grows. The `BLIND_DOUBLE` queue omits cells whose `primaryReviewerIds` contain the caller and cells with `escalationOpen`, and a write checks the same rules against the S3 chain and escalations (§4.3). A cell therefore cannot be audited while a person may be looking at its current decision in an escalated run; once a person answers the escalation, the decision under audit is that answer. No route returns `blindSampled`; a reviewer learns that a cell is sampled only when it appears in the blind queue.

### 8.3 Review completion

A run is review-complete when all of these hold:

1. every table of the run has a current table decision;
2. every cell of every table in scope (§7.1) has a current primary decision of `ACCEPTED`, `CORRECTED` or `UNREADABLE`;
3. every row of every table in scope has a current row decision;
4. every row with `isPlayerRow: true` belongs to a table whose current role is `SCOREBOARD`;
5. the run's player rows have consistent teams and outcomes (rule code `OUTCOME_INCONSISTENT`). The player rows are the detected rows with `isPlayerRow: true` in `SCOREBOARD` tables plus the undetected rows of those tables. A run with no player rows meets the condition. Otherwise either every team is empty and exactly one row is `WIN` (a free-for-all), or no team is empty, all rows of each team share one outcome, and exactly one team is `WIN`.
6. the run has no open escalation (§7.8).

Decisions of either reviewer kind count toward conditions 1 to 5. No single row write can be checked against condition 5, because changing which team won takes one write per row and every state in between breaks it. Neither writer therefore rejects a write for `OUTCOME_INCONSISTENT`. The run view and every write response, including `LlmReviewWrite`'s, list the rows that break condition 5 with that code, and the run stays incomplete until the LLM reviewer fixes them or escalates them to a person. Completion is a function of the resolved chains and the escalations, so it is computed the same way after a write and in a rebuild. Open disagreements and blind reviews do not block completion. A later table decision can grow the scope and make the run incomplete again (§6.3), and so can a later escalation.

Completion records which decisions came from an LLM. `META` keeps resolved counts per item kind and reviewer kind of the current decision, and every validated version records the reviewer kind behind each value and row, and in its lineage the counts per item kind and reviewer kind and the LLM models and prompt versions involved (§8.4, §8.5).

### 8.4 Validated table

The validated table is the reviewed scoreboard of one run. It is the seam contract with the stats lakehouse (#159), which ingests every version into bronze.

**Rows.** The builder visits every table whose current role is `SCOREBOARD`, in `tableIndex` order. Within a table it emits each row with `isPlayerRow: true` in `rowIndex` order. It then inserts the undetected rows in order of `insertAfterRowIndex` and then list position. Each goes after the last emitted detected row whose `rowIndex` is at or below its anchor, and after any undetected rows already placed there. When no emitted detected row is at or below the anchor, the row goes before every detected row of the table. An anchor on a header or non-player row therefore places the row after the nearest player row above it. `rowKey` is `<tableIndex>:<rowIndex>` for a detected row and `<tableIndex>:added:<position in undetectedRows>` for an undetected one.

**Values.** For each field the table's confirmed `columnFields` maps to a column, the value comes from the cell at that row and column, or from the cell whose span covers them:

| Cell resolution | `source` | `text` |
| --- | --- | --- |
| `ACCEPTED` | `OCR_ACCEPTED` | the observed text |
| `CORRECTED` | `OCR_CORRECTED` | the submitted value |
| `UNREADABLE` | `UNREADABLE` | `null` |
| no column mapped to the field, or no cell at that position | `NOT_PRESENT` | `null` |
| undetected row | `REVIEWER_ENTERED` | the entered value |
| reserved for stage 3 (§7.7) | `AUTO_ACCEPTED` | never written in v1 |

Each value also records `cellObservationId`, `adjudicationId` (the cell adjudication, or the table adjudication for entered values), `reviewerKind` (that adjudication's, or `null` for `NOT_PRESENT`), `observedText`, `semanticField`, `exportedField` and `confirmedField`. Each row records `rowReviewerKind`, the reviewer kind of its row decision, or of the table decision that entered it for a `REVIEWER_ADDED` row. An `LLM` value keeps its ordinary `source`, so `OCR_ACCEPTED` with `reviewerKind: LLM` is an OCR reading the LLM reviewer accepted. The row's typed fields are derived from the values: `score`, `kills`, `assists` and `deaths` are the integer when the trimmed text is all digits and `null` otherwise; `player` is the text tidied with spec 1 §8.2 step 4 (trim, remove one leading clan tag in square brackets, collapse whitespace), or `null`; `team` comes from the row decision; `win` and `loss` are `1, 0` for `WIN` and `0, 1` for `LOSS`.

**Table fields.** `hasScoreboard` is true when any table has role `SCOREBOARD`. `isFreeForAll` is true when there is at least one row and every row's team is empty. `contentSha256` is the SHA-256 of `rows` serialized as JSON with object keys sorted bytewise and no whitespace, so the lakehouse can tell versions with identical rows apart from changed ones. A run with no scoreboard still gets a validated table, with no rows and `hasScoreboard: false`.

### 8.5 Versions and lineage

The first validated version of a run is written when it first becomes review-complete. After that a new version is written whenever the run is complete and its primary adjudication set differs from the latest version's (§6.3). Earlier versions are never changed, and each version records `previousValidatedTableId`. The lakehouse selects the latest version per run (#159).

Each version's `lineage` records:

- `adjudicationSetSha256`: spec 2 §8.3's definition, the SHA-256 of the UTF-8 adjudication object keys, sorted bytewise and joined with `\n`, over every key under the run's `adjudications/` prefix at build time. The set includes superseded adjudications and excludes `blind-adjudications/`, because resolution depends on the whole chain and the blind track never changes values. A spec 2 baseline built from exactly the same keys carries the same value.
- `adjudicationCount`, the number of keys in that same set, and `qualityRunIds`, the sorted distinct quality runs the adjudications were reviewed against. §6.3 step 4 compares `adjudicationCount` with a new listing, so it counts exactly the keys hashed.
- `normalizedSha256`, the run manifest's `versions` as `sourceVersions`, and its `build` as `sourceBuild`.
- `reviewVersions`: `reviewPolicyVersion`, `reviewConfigVersion`, `validatedTableBuilderVersion` and the sorted distinct `reviewToolVersion` values of the human adjudications.
- `currentDecisionCounts`: for cells, rows and tables, the number of required items whose current decision is `HUMAN` and the number whose current decision is `LLM`. A version whose `HUMAN` counts are all zero was decided without a person.
- `llmReviewers`: the distinct `modelId` and `promptVersion` pairs of the `LLM` adjudications in the set, sorted bytewise by model ID and then prompt version.
- `build`: the writer's `gitSha` and `environment`.

The table also records `runId`, `screenshotId`, `submissionId` and `imageSha256`, so the lakehouse can group duplicate runs and resent images without reading other evidence.

### 8.6 Boundary with spec 2

- Spec 2 owns features, scores, priorities and training example selection (spec 2 §8.4, §8.5). This component only displays a quality result and records which one it displayed.
- Spec 3 defines no labeled export. The risk model specification's dataset builder joins spec 2 feature rows with these adjudications: cells by `(qualityRunId, cellObservationId)`, rows by `(qualityRunId, tableObservationId, rowIndex)` and tables by `(qualityRunId, tableObservationId)` (spec 2 §8.5 rules 3 and 5). Every label carries `reviewerKind` and, for an LLM, `llmReviewer`, so the dataset builder and the gate can separate LLM labels from human ones.
- No value this component writes reaches the features of the run it describes. Spec 2 reads adjudications only to build cross-run baselines, and a baseline never contains a label of the screenshot being scored (spec 2 §8.3, §8.4 rule 2). Validated tables, review plans, escalations, resolutions, telemetry, reviewer IDs and LLM invocation evidence are never inputs to spec 2.
- Adjudications attach to the reviewed run's observations and never label a sibling run (spec 2 §8.5 rule 7).

## 9. Reviewer experience

### 9.1 Layout

The reviewer application serves people, who see two kinds of work: escalated runs and the blind audit queue, plus disagreements from that audit. It never shows a run that has neither an escalation nor an open disagreement. The reviewer is built for a phone held in portrait orientation and works at 320 CSS pixels wide with no horizontal page scrolling. The screenshot fills the upper part of the viewport at its own aspect ratio. The selected cell, row or table is outlined by a high-contrast SVG overlay drawn from the evidence geometry, so the page never reads image pixels. Pinch zoom and pan are required, and a full-screen toggle keeps the selection. A fixed bottom panel holds the item's evidence (observed text, `semanticField` and `exportedField`, row and column, the parser's team and outcome for rows), the decision controls and the correction input. In a `PRIORITY_SHOWN` run the panel also shows the item's priority and its signals' messages. It shows neither in a hidden run, in the blind view or in the disagreement view. Controls have a hit area of at least 44 by 44 CSS pixels and stay reachable above mobile browser chrome and the on-screen keyboard. At 960 CSS pixels and wider the same controls may use two panes; desktop is an enhancement, not a separate workflow.

OCR text and entered values are rendered as text, never as HTML. The interface never edits its copy of observed text; after each write, TanStack Query invalidates the run and queue queries and reloads them. Submit is disabled while a write is pending. On `409 STALE_RESOLUTION` the item reloads and the reviewer must decide again against the current resolution.

### 9.2 Escalation review steps

A person opens an escalated run from the `PRIMARY` queue. The steps below visit only escalated items; the others are shown as context, with their evidence and without their decisions (§4.1). Each escalated item shows its current decision, its reviewer kind and the escalation's reason codes, and never an LLM rationale. "Escalate another item" lets the person add an item of the same run that they need to decide (§7.8). The reviewer suggests an order; the API accepts any.

1. **Tables.** Each escalated table is outlined in turn. The reviewer sets its role and, for a scoreboard, confirms a field for each column, prefilled with the parser's mapping for the selected table and the semantic fields for others.
2. **Cells.** Escalated cells, in table, row and column order, header row first. The reviewer accepts, corrects with at least one error type, marks unreadable, or skips. "Accept the rest of this row" is offered from the second cell of a row.
3. **Rows.** Each escalated row is highlighted as a band. The reviewer confirms whether it is a player row and, for a player row, its team and outcome, prefilled with the parser's values. "Add a missing row" on an escalated table opens a form for an undetected row.
4. **Summary.** Required and resolved counts per step, open escalated items, and the latest validated version.

### 9.3 Blind audit and disagreement screens

The blind audit screen shows one cell from the blind queue with the screenshot and the blind view only, and offers accept, correct and unreadable. It shows no decision, value, reviewer kind or rationale from the LLM reviewer or any person, and submits the `qualityRunId` from the blind view. The disagreement screen shows the cell and the two decisions, labelled "first" and "second" without reviewer identities or reviewer kinds, and no priority. It writes the resolution as a new primary adjudication.

### 9.4 Keyboard

Keyboard shortcuts work on hardware keyboards and never replace touch controls:

| Key | Action |
| --- | --- |
| `a` | Accept the observed text |
| `Shift+A` | Accept the rest of this row |
| `c` | Focus the correction input |
| `u` | Mark unreadable |
| `s` | Skip without deciding |
| `Enter` | Submit the selected decision |
| `j` / `k` | Next / previous unresolved item |

### 9.5 Sign-in and tokens

The application reads its user pool client ID, Cognito domain and Region from `/config.json`, which the stack writes at deploy. Sign-in uses Cognito managed login with the authorization-code flow and PKCE. Tokens are kept in memory only. A reload or an expired access token sends the reviewer through managed login again, which returns without a prompt while the Cognito session is valid. API calls use relative `/api/v1/...` paths with the access token in the `Authorization` header.

## 10. Typed domain model

### 10.1 Shared contracts

`@mcc/contracts` exports the following, next to the `normalized-ocr/v2` read types and quality types from spec 2 P0.2 (`SemanticField`, `ReviewPriority`):

```typescript
type ReviewPass = 'PRIMARY' | 'BLIND_DOUBLE' | 'DISAGREEMENT_RESOLUTION';
type ReviewerKind = 'HUMAN' | 'LLM';
type SelectionReason =
  | 'REVIEW_ALL' | 'MODEL_FLAGGED' | 'CONSTRAINT_FAILED' // LLM; v1 writes REVIEW_ALL only (§7.7)
  | 'ESCALATION' | 'AUDIT_SAMPLE';                     // HUMAN
type DisplayMode = 'PRIORITY_SHOWN' | 'PRIORITY_HIDDEN';
type ExportField = 'PLAYER' | 'SCORE' | 'KILLS' | 'ASSISTS' | 'DEATHS';
type ConfirmedField = ExportField | 'NONE';
type CellDecision = 'ACCEPTED' | 'CORRECTED' | 'UNREADABLE' | 'SKIPPED';
type CellErrorType =
  | 'GLYPH_SUBSTITUTION' | 'MISSING_CHARACTERS' | 'EXTRA_CHARACTERS'
  | 'SHIFTED_CELL' | 'MERGED_CELL' | 'OTHER';
type StructuralDecision = 'CONFIRMED' | 'CORRECTED';
type RowErrorType = 'MISSING_ROW' | 'EXTRA_ROW' | 'WRONG_TEAM' | 'WRONG_OUTCOME';
type TableErrorType = 'WRONG_TABLE' | 'WRONG_COLUMN_MAPPING' | 'MISSING_ROW';
type Outcome = 'WIN' | 'LOSS';

interface ReviewPlan {
  schemaVersion: 'review-plan/v1';
  runId: string;
  screenshotId: string;
  selectionReason: SelectionReason;
  displayMode: DisplayMode;
  blindSampleCellIds: readonly string[]; // sorted
  reviewConfigVersion: string;
  samplingSeedSha256: string;            // SHA-256 of the SSM seed; never the seed
  qualityRunId: string;                  // the quality run whose outcome enqueued the run
  createdAt: string;
}

interface LlmReviewer {                 // LLM adjudications and escalations only (§4.5)
  modelId: string;                      // Bedrock model ID as invoked
  promptVersion: string;
  invocationKey: string;                // stored prompt and response, under the run's prefix (#165)
  invocationSha256: string;             // computed by the writer
}

type ReviewItem =
  | { kind: 'CELL'; cellObservationId: string }
  | { kind: 'ROW'; tableObservationId: string; rowIndex: number }
  | { kind: 'TABLE'; tableObservationId: string };

interface ReviewEscalation {
  schemaVersion: 'review-escalation/v1';
  escalationId: string;                 // evidenceId()
  runId: string;
  screenshotId: string;
  qualityRunId: string;
  items: readonly ReviewItem[];
  reasonCodes: readonly string[];       // sorted; defined by #165, or REVIEWER_REQUESTED
  raisedBy: 'LLM_REVIEWER' | 'HUMAN';
  reviewerId: string | null;            // HUMAN only: access token sub
  llmReviewer: LlmReviewer | null;      // LLM_REVIEWER only
  clientRequestId: string;
  createdAt: string;                    // server time, after every named item's head (§6.7)
  build: { gitSha: string; environment: string };
}

interface ReviewTelemetry {             // client-reported
  reviewStartedAt: string;
  reviewDurationMs: number;
  openedFullImage: boolean;
  imageZoomUsed: boolean;
  reviewToolVersion: string;
}

interface AdjudicationBase {
  adjudicationId: string;               // evidenceId()
  runId: string;
  screenshotId: string;
  reviewerKind: ReviewerKind;
  reviewerId: string | null;            // HUMAN: access token sub; LLM: null
  llmReviewer: LlmReviewer | null;      // LLM only
  reviewPass: ReviewPass;               // always PRIMARY for LLM
  selectionReason: SelectionReason;
  qualityRunId: string;
  priorityShown: boolean;
  shownPriority: ReviewPriority | null;
  priorDecisionsShown: boolean;
  shownRiskModel?: { modelVersion: string; decision: 'AUTO_ACCEPT' | 'REVIEW_REQUIRED' }; // reserved (§7.7)
  supersedesAdjudicationId: string | null;
  bulk: boolean;
  bulkActionId: string | null;
  clientRequestId: string;
  reviewedAt: string;                   // server time
  telemetry: ReviewTelemetry | null;    // HUMAN only
  reviewPolicyVersion: string;
  reviewConfigVersion: string;
  build: { gitSha: string; environment: string };
}

interface CellAdjudication extends AdjudicationBase {
  schemaVersion: 'cell-adjudication/v1';
  cellObservationId: string;
  tableObservationId: string;
  tableIndex: number;
  rowIndex: number;
  columnIndex: number;
  rowRole: 'HEADER' | 'DATA';
  semanticField: SemanticField;         // normalized semanticLocation.field
  exportedField: ExportField | null;    // parser.provenance.columnFields; null outside the selected table
  observedTextAtReview: string;
  decision: CellDecision;
  submittedValue: string | null;        // CORRECTED only
  errorTypes: readonly CellErrorType[]; // non-empty for CORRECTED only
}

interface RowAdjudication extends AdjudicationBase {
  schemaVersion: 'row-adjudication/v1';
  tableObservationId: string;
  tableIndex: number;
  rowIndex: number;
  parser: { exported: boolean; team: string | null; win: 0 | 1 | null; loss: 0 | 1 | null };
  isPlayerRow: boolean;
  team: string | null;                  // '' in a free-for-all
  outcome: Outcome | null;
  decision: StructuralDecision;         // derived (§7.4)
  errorTypes: readonly RowErrorType[];  // derived (§7.4)
}

interface UndetectedRow {
  insertAfterRowIndex: number;
  team: string; player: string; score: string; kills: string; assists: string; deaths: string;
  outcome: Outcome;
}

interface TableAdjudication extends AdjudicationBase {
  schemaVersion: 'table-adjudication/v1';
  tableObservationId: string;
  tableIndex: number;
  classification: 'SCOREBOARD' | 'UNKNOWN';
  parser: { selected: boolean; columnFields: Readonly<Record<string, ExportField>> | null };
  role: 'SCOREBOARD' | 'NOT_SCOREBOARD';
  columnFields: Readonly<Record<string, ConfirmedField>> | null; // every column index when SCOREBOARD
  undetectedRows: readonly UndetectedRow[];
  decision: StructuralDecision;         // derived (§7.5)
  errorTypes: readonly TableErrorType[]; // derived (§7.5)
}

// Rebuildable projection in ReviewState; never evidence.
interface CellResolution {
  cellObservationId: string;
  runId: string;
  screenshotId: string;
  currentAdjudicationId: string;
  chainLength: number;
  reviewerKind: ReviewerKind;           // of the current adjudication
  decision: CellDecision;
  resolvedText: string | null;          // ACCEPTED: observedTextAtReview; CORRECTED: submittedValue
  resolutionVersion: 'cell-resolution-v1';
  resolvedAt: string;
}
// RowResolution and TableResolution follow the same pattern with their decisions.

type ValueSource =
  | 'OCR_ACCEPTED' | 'OCR_CORRECTED' | 'REVIEWER_ENTERED' | 'UNREADABLE' | 'NOT_PRESENT'
  | 'AUTO_ACCEPTED';                    // reserved (§7.7)

interface ValidatedValue {
  text: string | null;
  source: ValueSource;
  cellObservationId: string | null;
  adjudicationId: string | null;
  reviewerKind: ReviewerKind | null;    // null for NOT_PRESENT
  observedText: string | null;
  semanticField: SemanticField | null;
  exportedField: ExportField | null;
  confirmedField: ExportField;
}

interface ValidatedRow {
  rowKey: string;
  origin: 'DETECTED' | 'REVIEWER_ADDED';
  tableObservationId: string;
  rowIndex: number | null;              // null for REVIEWER_ADDED
  rowAdjudicationId: string | null;
  rowReviewerKind: ReviewerKind;        // row decision, or the table decision for REVIEWER_ADDED
  team: string;
  player: string | null;
  score: number | null; kills: number | null; assists: number | null; deaths: number | null;
  win: 0 | 1;
  loss: 0 | 1;
  values: Readonly<Record<'player' | 'score' | 'kills' | 'assists' | 'deaths', ValidatedValue>>;
}

interface ValidatedTable {
  schemaVersion: 'validated-table/v1';
  validatedTableId: string;             // evidenceId()
  validatedVersion: number;             // 1-based per run
  previousValidatedTableId: string | null;
  runId: string;
  screenshotId: string;
  submissionId: string;
  imageSha256: string;
  createdAt: string;
  hasScoreboard: boolean;
  isFreeForAll: boolean;
  rows: readonly ValidatedRow[];
  contentSha256: string;
  lineage: {
    adjudicationSetSha256: string;
    adjudicationCount: number;
    qualityRunIds: readonly string[];
    normalizedSha256: string;
    sourceVersions: Readonly<Record<string, string>>;
    sourceBuild: { gitSha: string; environment: string };
    reviewVersions: {
      reviewPolicyVersion: string;
      reviewConfigVersion: string;
      validatedTableBuilderVersion: string;
      reviewToolVersions: readonly string[];
    };
    currentDecisionCounts: Readonly<Record<'CELL' | 'ROW' | 'TABLE', { HUMAN: number; LLM: number }>>;
    llmReviewers: readonly { modelId: string; promptVersion: string }[];
    build: { gitSha: string; environment: string };
  };
}
```

Request bodies are validated at the API boundary with a schema per kind before any read. Persisted review types hold OCR text and gamertags, so they never appear in logs (§14).

### 10.2 Relationships

```text
Processing run 1 -> 0..1 review plan
Processing run 1 -> many items (tables, rows, cells) -> 0..1 chain per track -> many adjudications
Adjudication 0..1 -> 1 superseded adjudication (same item, same track)
Adjudication many -> 1 quality run (by qualityRunId)
LLM adjudication 1 -> 1 stored prompt and response (by llmReviewer.invocationKey, #165)
Processing run 1 -> 0..many escalations -> many items
Processing run 1 -> 0..many validated tables (versions 1..n)
Validated table 1 -> many adjudications (by adjudicationSetSha256)
Validated table 1 -> many bronze records in the stats lakehouse (#159)
```

## 11. Module and function catalog

Every handler exports `handler` for Lambda and a core function that takes an injected dependencies object. Only the default dependencies construct SDK clients.

### 11.1 Lambda entry points

| File | Public functions | Purpose |
| --- | --- | --- |
| `src/lambdas/review-read.ts` | `handler(event)`; `readQueue`, `readRun`, `readBlindCell`, `issueImageUrl` (each `(input, dependencies)`) | The GET routes (§4.1). |
| `src/lambdas/review-write.ts` | `handler(event)`; `writeAdjudication(input, dependencies)`; `bulkAccept(input, dependencies)` | The POST routes (§6.2, §6.3, §6.4), including human escalations through `writeEscalation` (§6.7). Records `GIT_SHA` and `DEPLOYMENT_ENVIRONMENT`. |
| `src/lambdas/llm-review-write.ts` | `handler(event)`; `writeLlmAdjudication(payload, dependencies)` | The `ADJUDICATE` and `ESCALATE` operations (§4.5, §6.7). Records `GIT_SHA` and `DEPLOYMENT_ENVIRONMENT`. |
| `src/lambdas/enqueue-run.ts` | `handler(event)`; `enqueueRun(event, dependencies)` | §6.1. |
| `src/lambdas/rebuild-review-state.ts` | `handler(event)`; `rebuildReviewState(input, dependencies)` | §6.5. |

### 11.2 Libraries

| File | Public functions | Purpose |
| --- | --- | --- |
| `src/lib/keys.ts` | `parseQualityOutcomeKey(key, objectPrefix)`; `adjudicationKey(runPrefix, item, track, predecessor)`; `validatedKey(runPrefix, version)`; `planKey(runPrefix)`; `escalationKey(runPrefix, escalationId)`; `checkInvocationKey(runPrefix, key)` | Key validation and construction (§4.4, §5.1). |
| `src/lib/evidence.ts` | `evidenceId()`; `sha256(bytes)`; `putJsonOnce(bucket, key, value)`; `now()` | Identifiers in the spec 1 format and create-only writes. |
| `src/lib/auth.ts` | `requireLabeler(event)` | Returns `reviewerId` or throws `NotALabelerError`. |
| `src/lib/run-evidence.ts` | `loadRunEvidence(runPrefix, qualityRunId, dependencies)` | Reads and caches immutable run evidence. |
| `src/lib/chains.ts` | `resolveChain(adjudications, cutoff?)` | §8.1. Pure. |
| `src/lib/decisions.ts` | `validateCellDecision`; `deriveRowDecision`; `deriveTableDecision`; `openDisagreement(primaryChain, blindChain)`; `checkReviewerKind(head, reviewerKind)` | §6.4, §7.2 to §7.5, §8.1. Pure. |
| `src/lib/escalations.ts` | `openEscalations(escalations, chains)`; `escalationCreatedAt(now, heads)` | §7.8. Pure. |
| `src/lib/escalation-write.ts` | `writeEscalation(input, dependencies)` | §6.7. Shared by `review-write` and `llm-review-write`. |
| `src/lib/scope.ts` | `reviewScope(observations, tableResolutions)` | §7.1. Pure. |
| `src/lib/completion.ts` | `evaluateCompletion(scope, resolutions)` | §8.3. Pure. |
| `src/lib/sampling.ts` | `buildReviewPlan(observations, qualityRunId, config, samplingSeed)` | §7.6. Pure; the caller reads the seed from SSM. |
| `src/lib/run-evaluation.ts` | `evaluateRun(runPrefix, dependencies)` | §6.3. Shared by `review-write`, `llm-review-write`, `enqueue-run` and `rebuild-review-state`, so no Lambda imports another. |
| `src/lib/validated-table.ts` | `buildValidatedTable(evidence, resolutions, previous, versions)`; `adjudicationSetSha256(keys)` | §8.4, §8.5. Pure. |
| `src/lib/review-state.ts` | `DynamoReviewStateStore` | Projections and queues (§8.2, §13.3). |
| `src/lib/config.ts` | `loadReviewConfig()` | Read and validate the bundled configuration. |
| `src/lib/log.ts` | `log(level, message, details?)` | One JSON log line per call. |

### 11.3 Web application

| File | Purpose |
| --- | --- |
| `web/src/auth/pkce.ts` | Managed login redirect, code exchange and in-memory tokens (§9.5). |
| `web/src/api/` | TanStack Query hooks for every route; the only module that calls `fetch`. |
| `web/src/components/ScreenshotViewer.tsx` | Image, SVG overlay, pinch zoom, pan and full screen (§9.1). |
| `web/src/review/` | Escalation review steps (§9.2), blind audit and disagreement screens (§9.3), keyboard bindings (§9.4). |

### 11.4 Infrastructure code

| File | Public API | Purpose |
| --- | --- | --- |
| `cdk/lib/app.ts` | `createAdminApp(props?, environmentVariables?)` | Build the stack exactly as deployment does. |
| `cdk/lib/admin-stack.ts` | `AdminStack` | All application resources (§13.3). |
| `infrastructure/modules/foundation/cognito.tf` | user pool, domain, `labeler` group, SSM parameters | §13.2. |

## 12. Directory structure and ownership

```text
mcc-stats-suite/
  applications/admin/
    cdk.json
    package.json                       # @mcc/admin; build, build:web, typecheck, test, test:web, test:e2e
    TESTING.md
    config/review-config-v1.json       # Bundled, immutable once released
    cdk/
      bin/admin.ts
      lib/{app,admin-stack}.ts
    src/
      lambdas/{review-read,review-write,llm-review-write,enqueue-run,rebuild-review-state}.ts
      lib/{keys,evidence,auth,run-evidence,run-evaluation,chains,decisions,escalations,escalation-write,scope,completion,sampling,validated-table,review-state,config,log}.ts
    test/
      *.test.ts
      fixtures/*.fixture.json          # Reduced runs with quality results, adjudications and expected outcomes
    web/
      index.html
      vite.config.ts
      src/{auth,api,components,review}/
      test/                            # Vitest component tests and Playwright end-to-end tests
  packages/contracts/src/index.ts      # Review contracts and ValidatedTable
  infrastructure/modules/foundation/cognito.tf
  infrastructure/modules/foundation/local-cdk-policies.tf  # Ephemeral permissions for admin stacks
```

`admin` imports only `@mcc/contracts` and `@mcc/cdk-config` from the monorepo and never imports `match-to-csv` or `ocr-quality` code. `web/` imports only `@mcc/contracts` types and never AWS SDK packages.

## 13. Configuration and infrastructure

### 13.1 Configuration schema

```json
{
  "reviewConfigVersion": "review-config-v1",
  "priorityHiddenShare": 0.2,
  "blindDoubleReviewShare": 0.05,
  "imageUrlTtlSeconds": 600,
  "maxTextLength": 256,
  "maxBulkCells": 32,
  "maxEscalationItems": 256,
  "queuePageSize": 25,
  "teamNames": ["Red", "Blue", "Green", "Orange", "Purple", "Gold", "Brown", "Pink"]
}
```

The file is bundled into the Lambdas and holds no secret. The sampling seed lives in SSM (§13.2). `EnqueueRun` and `RebuildReviewState` read it at cold start and fail with `MissingSamplingSeedError` when it is absent. `loadReviewConfig` validates every key at cold start: both shares between 0 and 1, `imageUrlTtlSeconds` between 60 and 900, `maxBulkCells` between 1 and 64, `maxEscalationItems` between 1 and 1,024. It throws `InvalidReviewConfigError` on any problem. A released file is never edited; a change adds `review-config-v2.json` and bumps `reviewConfigVersion`. Plans record the configuration version and the seed's SHA-256 they were sampled under, so a new share or a new seed applies only to runs enqueued afterwards.

### 13.2 Persistent resources

| Resource | Owner | Configuration |
| --- | --- | --- |
| Evidence bucket | OpenTofu foundation | Existing (spec 1 §13.1), with EventBridge notifications from spec 2 P1.1. |
| KMS data key and SSM parameters | OpenTofu foundation | Existing. The stack reads `/mcc/<env>/match-to-csv/evidence-bucket-name` and `/mcc/<env>/match-to-csv/data-key-arn`. |
| Cognito user pool `<project>-<env>-reviewers` | OpenTofu foundation (P1.1) | Self-service sign-up disabled, TOTP MFA required, deletion protection on, `prevent_destroy`. Group `labeler`. A Cognito prefix domain from a variable, never committed. SSM parameters `/mcc/<env>/review/user-pool-id`, `/mcc/<env>/review/user-pool-arn` and `/mcc/<env>/review/user-pool-domain`. |
| Sampling seed `/mcc/<env>/review/sampling-seed` | OpenTofu foundation (P1.1) | SSM `SecureString` encrypted with the AWS managed `aws/ssm` key, holding 32 random bytes generated by OpenTofu. The value exists only in SSM and the encrypted OpenTofu state, never in source, posted plans, logs or evidence. |

Operators create reviewer accounts and add them to `labeler` with the Cognito console or CLI. Ephemeral stacks use the dev pool.

### 13.3 Application resources

| Resource | Configuration |
| --- | --- |
| `ReviewRead` | Node.js 22, ARM64, 1,024 MB, 10-second timeout, X-Ray, env `EVIDENCE_BUCKET`, `OBJECT_PREFIX`, `REVIEW_TABLE` |
| `ReviewWrite` | Node.js 22, ARM64, 1,024 MB, 25-second timeout, X-Ray, env as `ReviewRead` plus `GIT_SHA`, `DEPLOYMENT_ENVIRONMENT` |
| `EnqueueRun` | Node.js 22, ARM64, 512 MB, 1-minute timeout, env as `ReviewRead` plus `SAMPLING_SEED_PARAMETER` |
| `LlmReviewWrite` | Node.js 22, ARM64, 1,024 MB, 25-second timeout, X-Ray, env as `ReviewWrite`. No API route, function URL, event source or resource-based policy (§4.5). |
| `RebuildReviewState` | Node.js 22, ARM64, 2,048 MB, 15-minute timeout, env as `ReviewWrite` plus `SAMPLING_SEED_PARAMETER` |
| HTTP API `<stack>` | Routes in §4.1 only, JWT authorizer (issuer the user pool, audience the stack's app client), no CORS configuration, `$default` stage with throttling of 20 requests per second and a burst of 40, JSON access logs |
| User pool client | On the foundation pool, no secret, authorization-code grant with PKCE, scopes `openid`, callback and sign-out URLs on the distribution's domain, access token valid 60 minutes |
| CloudFront distribution | Default behavior: site bucket through Origin Access Control, a CloudFront Function that serves `/index.html` for paths without a file extension, caching optimized. `/api/*`: HTTP API origin, caching disabled, origin request policy `AllViewerExceptHostHeader`, all methods. HTTPS only, default CloudFront certificate. Response headers policy: HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a Content Security Policy of `default-src 'self'`, `img-src 'self'` plus the evidence bucket's regional endpoint, `connect-src 'self'` plus the Cognito domain, `frame-ancestors 'none'`. No custom error responses, so API errors pass through. |
| Site bucket | Public access blocked, SSE-S3, read only through Origin Access Control, removed with the stack; deployed from `web/dist` plus a generated `config.json` |
| `ReviewState` table | On-demand; partition key `pk` (`RUN#<runId>`), sort key `sk` (`META`, `QUEUE#PRIMARY`, `CELL#<blockId>`, `ROW#<tableBlockId>#<rowIndex>`, `TABLE#<tableBlockId>`); sparse GSI `queue` on `queuePk` and `queueSk`, set only on `QUEUE#PRIMARY` items (`QUEUE#PRIMARY`, `<escalatedAt>#<runId>`) and on `CELL` items (`QUEUE#BLIND` or `QUEUE#DISAGREEMENT`, `<queuedAt>#<cellObservationId>`); encrypted with the foundation data key; removed with the stack because it is rebuildable (§6.5) |
| EventBridge rule and DLQ | §4.4 |
| Outputs | `DistributionDomainName`, `UserPoolClientId`, `RebuildFunctionName`, `LlmReviewWriteFunctionName`, `ObjectPrefix` |

Log groups follow match-to-csv: three months in prod, two weeks otherwise, retained for stable stacks and destroyed with ephemeral ones.

### 13.4 Permissions

| Principal | Evidence bucket | KMS data key | `ReviewState` |
| --- | --- | --- | --- |
| `ReviewRead` | `GetObject` on `<ns>submissions/*` | decrypt | `GetItem`, `Query` |
| `ReviewWrite` | `ListBucket` with prefix `<ns>submissions/`; `GetObject` on `<ns>submissions/*`; `PutObject` on `<ns>submissions/*/runs/*/adjudications/*`, `.../blind-adjudications/*`, `.../review/escalations/*` and `.../validated/*` | decrypt, encrypt | `GetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`, `ConditionCheckItem` |
| `LlmReviewWrite` | `ListBucket` with prefix `<ns>submissions/`; `GetObject` on `<ns>submissions/*`; `PutObject` on `<ns>submissions/*/runs/*/adjudications/*`, `.../review/escalations/*` and `.../validated/*`, never on `blind-adjudications/` | decrypt, encrypt | `GetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`, `ConditionCheckItem` |
| `EnqueueRun` | `ListBucket` with prefix `<ns>submissions/`; `GetObject` on `<ns>submissions/*`; `PutObject` on `<ns>submissions/*/runs/*/review/plan.json` and `.../validated/*` | decrypt, encrypt | `GetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`, `ConditionCheckItem` |
| `RebuildReviewState` | `ListBucket` with prefix `<ns>submissions/`; `GetObject` on `<ns>submissions/*`; `PutObject` on `<ns>submissions/*/runs/*/review/plan.json` and `.../validated/*`, never on adjudication or escalation prefixes | decrypt, encrypt | `GetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`, `ConditionCheckItem`, `BatchWriteItem` |

`EnqueueRun` and `RebuildReviewState` also have `ssm:GetParameter` with decryption on `/mcc/<env>/review/sampling-seed`; no other role can read it. `<ns>` is empty for stable stacks and `ephemeral/<name>/` for ephemeral ones. `ReviewRead` signs image URLs with its own role, so a URL can read only what that role can.

No role this stack creates has `lambda:InvokeFunction` on `LlmReviewWrite`, and the function has no resource-based policy, so only a same-account principal whose own IAM policy allows the call can invoke it. The OCR risk model specification (#165) grants that to the LLM reviewer's execution role and to no other workload role. `LlmReviewWrite`'s execution role is the only role that writes `LLM` adjudications; `ReviewWrite` can also write under `adjudications/`, but its code writes only `HUMAN` adjudications with the caller's verified `sub` (§4.2). Every role carries the workload permissions boundary and, for ephemeral stacks, the `/mcc-local/` path. No role has `DeleteObject`, any bucket-configuration permission, or `PutObject` under `quality/`, `textract/`, `normalized/`, `export/` or `source/`.

P1.2 extends `infrastructure/modules/foundation/local-cdk-policies.tf` so ephemeral `admin-e-*` stacks can create and delete their HTTP API, distribution, CloudFront Function, Origin Access Control, response headers policy, site bucket, table and user pool client, and so the local workload boundary allows the table actions above on `admin-e-*` tables and KMS use through DynamoDB.

### 13.5 Deployment

The stack deploys through `scripts/cdk-app.mjs` like match-to-csv: stable stacks from GitHub Actions on `main`, dev then prod with a required reviewer; ephemeral stacks from a local shell with `--environment dev --ephemeral <name>`. `npm run build:web` runs before synthesis. The deploy preflight fails when any SSM parameter in §13.2 is missing. Post-deploy verification checks that the stack is complete, every Lambda is `Active`, the distribution is `Deployed`, and `GET /api/v1/queue` through the distribution without a token returns `401` with no `Access-Control-Allow-Origin` header. P1.1 must be applied, and spec 2 P1.1 applied, before a stack can sign reviewers in or receive events. Creating or deleting a distribution takes several minutes, so ephemeral stacks deploy and destroy more slowly than other applications.

## 14. Security and privacy

1. Every API request carries a Cognito access token validated by the authorizer, and every handler requires the `labeler` group. The reviewer identity is the token's `sub`, never a request field.
2. The browser is untrusted. Run, screenshot, observed text, fields, parser output, the display mode, priorities and selection reasons come from evidence on the server. Client fields are limited to §4.2 and validated by schema and length.
3. Identifiers are checked against their patterns and the run's `META` item and evidence before any read. Keys are built only from validated IDs and block IDs read from evidence, and every key is checked against the stack namespace.
4. Presigned image URLs expire after 10 minutes, reach only the run's `source/original`, are never logged, and never leak through `Referer` because of `Referrer-Policy: no-referrer`.
5. The API emits no CORS headers, so another origin cannot call it with a token. Tokens are kept in memory only. The Content Security Policy limits scripts to the site and connections to the site and the Cognito domain.
6. OCR text, corrections and entered values contain gamertags. They live only in the evidence bucket and the `ReviewState` table, both encrypted with the foundation key, and are rendered as text.
7. Create-only writes, Object Lock and the absence of `DeleteObject` stop this component from changing any evidence, including its own.
8. Ephemeral stacks read and write only under `ephemeral/<name>/`, enforced by key checks and IAM resource patterns. Their app clients sign in dev reviewers, who see only that namespace's runs.
9. Self-service sign-up is disabled and MFA is required.
10. The sampling seed is a secret (§7.6, §13.2). Only `EnqueueRun` and `RebuildReviewState` can read it, plans store only its hash, and no route reveals whether a cell is blind-sampled before it appears in the blind queue.
11. LLM adjudications enter only through `LlmReviewWrite`, which nothing on the network can reach and only principals granted `lambda:InvokeFunction` can call (§4.5, §13.4). No reviewer API request can write an `LLM` adjudication or set `reviewerKind`, and `LlmReviewWrite` applies the same schema, key, decision and supersession checks as the reviewer API. It accepts an invocation key only under the run's own prefix, outside every prefix this component, match-to-csv or spec 2 writes.
12. The reviewer API returns no LLM rationale or invocation evidence, and no decision of an item that is neither escalated nor in an open disagreement, in a read or in an error response, because a write checks the pass and escalation rules before it returns a resolution (§4.3). The blind audit skips a cell while its escalation is open (§8.2). A person in the blind audit therefore never sees the decision they audit through this application, though they may have seen an earlier, superseded LLM decision of the same cell in an escalated run (§18.3).

## 15. Observability

- Lambdas log JSON lines with `level`, `message` and context fields: `requestId`, `runId`, `qualityRunId`, item kind, `adjudicationId`, `escalationId`, decision, `reviewPass`, `reviewerKind`, `modelId` and `promptVersion` for LLM writes, counts, durations and error codes. Logs never contain observed text, submitted or entered values, tokens, presigned URLs or email addresses.
- API Gateway access logs record request ID, route key, status, latency, integration error and the caller's `sub`, and never headers or query strings.
- X-Ray tracing is active on every function.
- The audit record for "who decided what about this run" is its `adjudications/` and `blind-adjudications/` chains and its `review/escalations/`, with each LLM decision traced to its stored prompt and response, and for "what did the lakehouse receive" its `validated/` versions.
- Undeliverable queue events wait in the DLQ for 14 days. Alarms follow match-to-csv's observability specification ([spec 5](5-match-to-csv-observability.md); backlog P5.4).

## 16. Testing, CI and release

### 16.1 Tests

Lambda and library tests use `tap`, run from `applications/admin/test/*.test.ts`, and never call AWS. The command fails below 80% statements, 65% branches, 80% lines or 60% functions. Web tests use Vitest with Testing Library and the same thresholds for `web/src/`, and Playwright end-to-end tests run the built application against a mocked API.

| File | Covers |
| --- | --- |
| `keys.test.ts` | chain keys for every item and track; `root` keys; six-digit validated keys; escalation keys; stable and ephemeral outcome keys accepted, claims, deeper keys and other namespaces rejected; invocation keys accepted under the run's prefix and rejected under another run, another namespace, or a prefix this component, match-to-csv or spec 2 writes |
| `chains.test.ts` | head of a chain; resolution at a cutoff; `BrokenChainError` on a missing link; `reviewedAt` set to the predecessor's plus 1 ms when the writer's clock is behind, and a `DISAGREEMENT_RESOLUTION` later than the blind adjudication it resolves; `HUMAN` superseding `LLM` and `HUMAN` allowed, `LLM` superseding `LLM` allowed, `LLM` superseding `HUMAN` rejected |
| `escalations.test.ts` | an escalation stays open after an `LLM` write, a human `SKIPPED` and a human decision with an earlier `reviewedAt`, and closes on a later human decision; a second escalation of an answered item reopens it; `createdAt` is later than every named item's head when the writer's clock is behind; a run is open while any item is |
| `decisions.test.ts` | `INVALID_TEAM` and `INVALID_ANCHOR` on row and table decisions, including undetected rows; the open-disagreement rule in §6.4, including a resolution that keeps the first decision, a resolution with a third value and a later blind adjudication; every rule in §7.2 with each failure code; every row and table error type derived on seeded cases and absent on clean ones; team name pattern |
| `scope.test.ts`, `completion.test.ts` | the scope union in §7.1; scope growth after a table decision; `SKIPPED` leaves a cell unresolved; decisions of either reviewer kind count; an open escalation keeps an otherwise complete run incomplete; each completion condition in §8.3, including `OUTCOME_INCONSISTENT` for a team with both outcomes, two winning teams, no winner, and a free-for-all with two winners |
| `sampling.test.ts` | plans are deterministic for a given seed and change with the seed; the plan holds the seed's SHA-256 and never the seed; over 10,000 generated IDs both shares are within 1 percentage point of configuration |
| `validated-table.test.ts` | row order with undetected rows, including anchors `0`, on the header, on a non-player row and shared by several rows; every value source; `semanticField`, `exportedField` and `confirmedField` on a fixture whose kills header is unreadable; player tidying; FFA; `contentSha256` stability; `adjudicationSetSha256` of keys `b` and `a` equals the SHA-256 of `a\nb`, as spec 2 §8.3 defines it; `reviewerKind` on values and `rowReviewerKind` on rows of a run decided partly by the LLM and partly by people, `currentDecisionCounts`, and `llmReviewers` with two prompt versions |
| `review-write.test.ts` | create-only chain writes; `STALE_RESOLUTION` on a second successor and on a predecessor that is not in the chain; replay by `clientRequestId`, including a retry after a write that succeeded but returned `503`; bulk accept with partial failure and replay of the written cells; the current adjudication taken from the S3 chain when the projection lags; `409 BULK_PARTIAL` with per-cell results; a run in the primary queue with a cell in the disagreement queue at the same time; the blind write removes the cell's blind queue keys; a disagreement evaluation from older chains does not overwrite a newer one; server-owned fields ignore body values, including `priorityShown`, `selectionReason`, `reviewerId`, `reviewerKind` and `llmReviewer`; every write is `HUMAN` with `selectionReason` `ESCALATION` or `AUDIT_SAMPLE` by pass; `NOT_ESCALATED` on a `PRIMARY` write to an item never escalated; a human write supersedes an `LLM` head and closes its escalation; `reviewedAt` later than the escalation's `createdAt`; escalation requests, their replay, and `NOT_ESCALATED` in a run never escalated; a `PRIMARY` write with `supersedesAdjudicationId: null` to a never-escalated cell whose primary chain has an `LLM` root returns `409 NOT_ESCALATED` with no resolution, decision, value or reviewer kind, and the same caller's later blind view and blind write of that cell succeed with `priorDecisionsShown: false`; a stale `supersedesAdjudicationId` gets the pass code, not `STALE_RESOLUTION`, on a never-escalated item, on a `BLIND_DOUBLE` cell whose blind chain another reviewer wrote (`NOT_IN_BLIND_QUEUE`) and on a cell without an open disagreement (`NO_DISAGREEMENT`); a bulk accept that lists a never-escalated cell reports `NOT_ESCALATED` for it with no resolution; an object with the request's `clientRequestId` but another reviewer's `sub` is not a replay; `shownPriority` for cells, rows and tables; blind and disagreement rules, including `NOT_IN_BLIND_QUEUE` for a sampled cell that is not yet queued and for a queued cell with an open escalation; validated version written on completion, not rewritten for an unchanged set, retried on 412; no write outside the permitted prefixes |
| `review-read.test.ts` | hidden runs and blind views omit every priority, score, signal and decision; the blind view returns the run's `latestQualityRunId` as `qualityRunId`, including in a run with no escalation; blind views omit reviewer kind and value of an `LLM` primary decision; the run view is `404` for a run with neither an escalation nor an open disagreement, and omits the resolution of every other item, every LLM rationale and every invocation key; the `PRIMARY` queue lists only runs with an open escalation; the `BLIND_DOUBLE` queue and blind view skip a cell with an open escalation; no route returns `blindSampled` or the review plan, and the blind view returns `404` for a sampled cell that is not in the blind queue; image URL key and TTL; `NOT_A_LABELER`; `RUN_NOT_FOUND`; queue filtering of the caller's own cells |
| `llm-review-write.test.ts` | every write is `LLM` with `llmReviewer` and `invocationSha256` and no `reviewerId`; a missing invocation object, an invocation key outside the run, `SKIPPED`, `ESCALATION`, `AUDIT_SAMPLE`, and in v1 `MODEL_FLAGGED` and `CONSTRAINT_FAILED` are rejected with the §4.5 codes; `HUMAN_DECIDED` on a human head; `ESCALATED` on an item with an open escalation; `PRIORITY_HIDDEN` in a hidden run; `priorDecisionsShown` set when superseding an `LLM` decision; replay by `clientRequestId`; a rejection is a response and a storage error is a function error; an `ESCALATE` puts the run in the `PRIMARY` queue; the response lists `OUTCOME_INCONSISTENT` rows; no write outside the permitted prefixes and never under `blind-adjudications/` |
| `enqueue-run.test.ts` | a `SUCCEEDED` outcome writes a plan and `META` and no `QUEUE#PRIMARY` item; a missing seed parameter fails with `MissingSamplingSeedError`; failed outcomes and runs without provenance are skipped; a re-score moves `latestQualityRunId` without a new plan; a run with no table is completed with a validated table that has no rows |
| `validated-race.test.ts` | an evaluation that listed fewer keys than the latest version's `adjudicationCount` writes nothing, so an older set never becomes the latest version; an evaluation with an older listing never overwrites newer `META` counts or status; sampled cells of a table added to the scope after version 1, and cells missed by an evaluation that stopped before finishing step 3 followed by one that stops at step 4, are queued for blind review; the blind queue update leaves the cell's projection and reviewer sets intact |
| `rebuild.test.ts` | a rebuild after deleting the table equals the incremental projections, including reviewer kinds and the `QUEUE#PRIMARY` items of runs with open escalations; a missing validated version is written; runs without a plan are enqueued; resolved disagreements stay closed and open ones are restored; a run reopened by a table decision is in the primary queue while one of its cells is in the disagreement queue |
| `blind-audit.test.ts` | end to end through the core functions with injected dependencies: `enqueueRun` plans a fixture run with a sampled cell, fixture `LLM` adjudications in the evidence decide every required item with no escalation, and `evaluateRun` completes the run with `validated/000001.json`. Its run view is `404`, the `BLIND_DOUBLE` queue lists the sampled cell, and the blind view returns `qualityRunId`. A blind write with that `qualityRunId` succeeds with `selectionReason: AUDIT_SAMPLE`, `priorityShown: false` and `priorDecisionsShown: false`. A blind decision that disagrees opens a disagreement, the run view then returns `200` with it, and another labeler's `DISAGREEMENT_RESOLUTION` supersedes the `LLM` decision and writes `validated/000002.json` |
| `app.test.ts` | stable and ephemeral synthesis; no CORS configuration on the API; CloudFront behaviors and headers in §13.3; IAM resource patterns in §13.4; the EventBridge pattern in §4.4; `LlmReviewWrite` has no route, function URL, event source or resource-based policy, and no role in the stack can invoke it |
| `web/test/*.test.tsx` | each step renders evidence as text; correction requires an error type; hidden mode renders no priority; stale resolution reloads the item; escalated items show their current decision and reviewer kind and other items show none; the blind audit screen shows no decision or reviewer kind and submits the blind view's `qualityRunId` |
| `web/test/e2e/*.spec.ts` | at 320 by 640 CSS pixels with touch emulation, a reviewer completes the escalations of a fixture run whose other items have `LLM` decisions, including a bulk accept, a correction of an `LLM` decision, a row correction, an undetected row and escalating another row, with no horizontal scrolling; a reviewer completes a blind audit of a cell in a fixture run that has no escalation and no run view |

A fixture is a reduced run (normalized observations with P0.3 provenance, a quality result, `LLM` and `HUMAN` adjudications, escalations, and stand-in invocation objects) with player data replaced, plus the expected scope, completion and validated table.

### 16.2 CI and release

CI runs format, lint, typecheck, `tap`, Vitest and Playwright for the `admin` workspace on affecting changes, and synthesizes `admin` with `-c environment=dev -c ephemeral=ci` after building the web application. Release Please versions the application and `@mcc/contracts`; a contracts change bumps every dependent application.

### 16.3 Live validation

After a change reaches dev, with the LLM reviewer (#165) deployed there, an operator checks one run the LLM reviewer completed alone: its adjudications are all `LLM`, each with an invocation key that exists, and its `validated/000001.json` has no `HUMAN` decisions in `currentDecisionCounts`. The operator then signs in as a dev reviewer on a phone, answers the escalations of one escalated run, and checks that the run's `adjudications/` prefix holds one chain per item, with each human answer superseding the `LLM` head, and that `validated/000001.json` exists with the expected rows and reviewer kinds. They correct one escalated cell again and check that `validated/000002.json` appears beside the unchanged first version. Last, in a run the LLM reviewer completed with no escalation, they complete one blind audit review that disagrees with an `LLM` decision, and its resolution.

## 17. Acceptance criteria

v1 (Phases 0 to 4) is complete when:

1. A reviewer in the `labeler` group answers every escalation of a scored dev run on a 320-pixel-wide phone with touch alone, and a user outside the group gets `403 NOT_A_LABELER` from every route.
2. The run stays incomplete while any required table, cell or row in §7.1 lacks a decision, and a `SKIPPED` cell keeps it incomplete.
3. "Accept the rest of this row" on a row with four escalated cells writes four `cell-adjudication/v1` objects with `bulk: true` and one `bulkActionId`.
4. Every adjudication records `reviewerKind`, a `selectionReason` allowed for its kind and pass (§7.7), a `qualityRunId` with a `SUCCEEDED` outcome, `priorityShown`, `shownPriority` and `priorDecisionsShown`. A `HUMAN` adjudication records the token's `sub` as `reviewerId`, and an `LLM` adjudication records the model ID, prompt version, invocation key and its SHA-256. Every cell adjudication also records `semanticField` and `exportedField`, and a `CORRECTED` cell records at least one error type.
5. In a run whose plan says `PRIORITY_HIDDEN`, no API response contains a priority, score or signal, and every adjudication has `priorityShown: false`.
6. A fixture run whose parser exported a total row, dropped a player row and swapped two teams yields `EXTRA_ROW`, `MISSING_ROW` and `WRONG_TEAM` row adjudications, and the validated table has the reviewer's rows and teams. While one team has both `WIN` and `LOSS` rows, the run stays incomplete and reports `OUTCOME_INCONSISTENT`.
7. Completing a run writes `validated/000001.json` with `adjudicationSetSha256` per spec 2 §8.3, `runId`, `screenshotId` and stage versions. A later correction writes `validated/000002.json` and leaves version 1 byte-for-byte unchanged.
8. A sampled cell decided by the LLM reviewer in a run that never had an escalation is audited blind by a person who sees no decision, value or reviewer kind and submits the `qualityRunId` from the blind view, both adjudications are kept in separate tracks, and a disagreement is resolved by a person's adjudication that supersedes the `LLM` decision.
9. Two tabs superseding the same adjudication produce one write and one `409 STALE_RESOLUTION`, and the evidence holds no fork.
10. Deleting the `ReviewState` table and running a `NAMESPACE` rebuild restores every projection and queue entry.
11. The app calls only relative `/api/v1` routes, API responses carry no CORS headers, and image URLs expire after 10 minutes.
12. Existing OCR evidence and quality results are byte-for-byte unchanged after every review action, and no object exists under `exports/`.
13. An ephemeral stack reviews only runs under its own `ephemeral/<name>/` namespace.
14. Every §16.1 test passes with the coverage thresholds, and CDK synthesis succeeds.
15. An `LLM` adjudication can be written only by invoking `LlmReviewWrite`, no reviewer API request can write one, and `LlmReviewWrite` rejects a write to an item whose head is `HUMAN` or whose escalation is open.
16. People see only escalated runs, the blind audit queue and its disagreements: the run view of a run with neither an escalation nor an open disagreement is `404`, and no route returns the decision of an item that is neither escalated nor in an open disagreement, or any LLM rationale, including in the error response to a write with a stale or `null` `supersedesAdjudicationId`.
17. A run the LLM reviewer completes alone gets a validated table whose values and rows record `reviewerKind: LLM` and whose lineage counts no `HUMAN` decision, and a run with an open escalation stays incomplete until a person answers it.

## 18. Risks and accepted limitations

1. **Shown priorities bias labels.** Reviewers who see a priority look harder at flagged cells and less at others. Accepted because hidden runs and the blind sample give unbiased labels for spec 2 §9.6, and `priorityShown` lets analysis separate the two.
2. **The blind sample may be too small at first.** At 5% of cells and 20% hidden runs, the gate's tens of thousands of blind labels (spec 2 §9.6) take many runs to collect. The shares are configuration (§13.1) and can grow when the risk model specification sets a target.
3. **Blindness relies on the interface.** A labeler who opens an escalated run sees the current decisions of its escalated items, which may be `LLM` decisions. The blind audit skips those cells until a person answers them, but a labeler who looked without answering may later audit the person's answer having seen the superseded LLM decision. The blind queue excludes their own primary decisions, neither the run view nor any write response shows a decision of an item that is neither escalated nor in an open disagreement (§4.3), and reviewers are trusted members of the league. The secret sampling seed (§7.6) keeps reviewers from knowing in advance which cells will be double-reviewed.
4. **Validated versions can lag.** A handler that stops between its adjudication write and the validated write leaves a complete run without its newest version until the browser replays the request, the run is written to again, or an operator runs a rebuild (§6.6). Accepted because the evidence is complete and the lakehouse sees the version when it appears.
5. **Duplicate runs are reviewed separately.** Retries and replays create sibling runs of one screenshot (spec 1 §18.6), and each is enqueued. Validated tables carry `screenshotId` and `imageSha256`, so the lakehouse can choose between them (#159).
6. **Runs without parser provenance cannot be reviewed.** Runs written before spec 2 P0.3 are skipped until an operator replays them (§6.1).
7. **Non-scoreboard screenshots still cost review.** The parser's selected table is in scope even when it is not a scoreboard, so its cells need decisions. Accepted because players rarely send other screenshots and those labels still describe OCR accuracy.
8. **No ties or undetermined outcomes.** `outcome` is `WIN` or `LOSS`, as in the CSV, and spec 1 §18.2 already trusts the top row. A tie needs a contract change.
9. **Rebuilds scan the namespace.** `NAMESPACE` lists every evidence key, so its time grows with evidence. Accepted at league scale; a Step Functions fan-out is the fix when it nears 15 minutes.
10. **The API endpoint is reachable without CloudFront.** The default `execute-api` endpoint accepts requests directly. Every route still needs a valid token, and browsers cannot call it cross-origin. A WAF or a header check is backlog P5.5.
11. **Telemetry is client-reported.** Durations and zoom flags can be wrong or forged. They are used only for review analysis, never as features or for authorization.
12. **Team names are a colour judgment.** Reviewers can disagree on colour names, as the parser can (spec 1 §18.3), and row decisions are not double-reviewed in v1 (P5.3).
13. **Any labeler can supersede any escalated decision.** Every supersession is evidence with the reviewer's `sub`, so mistakes and abuse are traceable rather than prevented.
14. **Ephemeral stacks are slow to create.** CloudFront distributions take minutes to deploy and delete (§13.5).
15. **The stack reads SSM parameters under `match-to-csv`.** As spec 2 §18.14 records, foundation parameters for the evidence bucket and key carry another application's name. New review parameters use `/mcc/<env>/review/`.
16. **`LlmReviewWrite` cannot see its caller.** Lambda passes no caller identity to the function, so any principal IAM allows to invoke it can write `LLM` adjudications, including a person with administrative access. Accepted because only the LLM reviewer's workload role is granted the call, every adjudication names its invocation evidence, and an `LLM` decision never overrules a person (§8.1).
17. **LLM errors can be correlated.** One model and prompt version can make the same mistake on every screenshot of a layout, so `LLM` labels are not independent samples. The blind audit and `llmReviewers` in lineage let the OCR risk model specification (#165) measure the error rate per model and prompt version and decide which labels a gate may use.
18. **Runs wait without the LLM reviewer.** People review only escalations and the audit sample, so a run the LLM reviewer has not reviewed, for example during a Bedrock outage, waits in `OPEN` and reaches no human queue. Accepted because #165 holds runs instead of accepting them and owns monitoring of held runs.

## 19. Reference documentation

- Cognito authorization endpoint: https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html
- Cognito token endpoint: https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html
- Cognito tokens: https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-with-identity-providers.html
- Cognito user pool groups: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-user-groups.html
- PKCE (RFC 7636): https://datatracker.ietf.org/doc/html/rfc7636
- HTTP API JWT authorizers: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html
- Lambda permissions for invoking a function: https://docs.aws.amazon.com/lambda/latest/dg/lambda-permissions.html
- CloudFront Origin Access Control for S3: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html
- CloudFront managed origin request policies: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html
- CloudFront response headers policies: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/adding-response-headers.html
- S3 presigned URLs: https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html
- S3 conditional writes: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html
- S3 events in EventBridge: https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventBridge.html
- DynamoDB global secondary indexes: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html
- Content Security Policy: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP
- TanStack Query: https://tanstack.com/query/latest/docs/framework/react/overview
- Vite: https://vite.dev/guide/
- Playwright device emulation: https://playwright.dev/docs/emulation

## 20. Delivery plan: phases and slices

This section is the backlog source for building the component. It is written to be turned directly into GitHub issues.

### 20.1 How to file this plan

- Each **phase** becomes one epic, titled with the phase title, with its goal and exit criteria as the body. Create epics only when someone explicitly asks for filing.
- Each **slice** becomes one leaf issue under its phase epic, titled without its code, with `Plan ID: P<n>.<m>` in the body. File with `/mcc-create-github-issue`.
- **Size** is XS, S or M. Split a slice by independently testable behavior when it outgrows one reviewable PR; the original Plan ID becomes the container.
- **Blocked by** lists Plan IDs. "Spec 2 P<n>.<m>" names a slice of [spec 2](2-ocr-quality.md). Create native blocked-by links after every issue in the batch exists. Blockers in earlier phases still apply.
- **Acceptance** bullets become the issue's acceptance criteria verbatim. Every slice also inherits §20.3.
- **Spec** lists the sections the implementer must read. Link them; this document stays the source of truth.
- Plan IDs are stable. Deferred slices keep their IDs and move to the backlog phase; new slices take the next free number in their phase.
- Phase 5 is backlog.

### 20.2 Seam contracts

| Contract | Defined in | Main consumers |
| --- | --- | --- |
| `validated-table/v1`, its key layout `runs/{runId}/validated/{validatedVersion}.json` and the version rule (§5.1, §8.4, §8.5) | P0.2, P2.3 | `review-write`, `llm-review-write`, `enqueue-run`, `rebuild-review-state`, the stats lakehouse bronze ingestion (#159), the autonomy metric of #165 |
| `cell-adjudication/v1`, `row-adjudication/v1`, `table-adjudication/v1`, the chain keys under `adjudications/` and `blind-adjudications/` (`runs/{runId}/adjudications/{cells,rows,tables}/...` and `runs/{runId}/blind-adjudications/cells/{cellBlockId}/{predecessor}.json`) and the supersession rule (§5.1, §8.1) | P0.2, P2.1 | `review-write`, `llm-review-write`, spec 2 `build-baselines` (spec 2 §8.3), the risk model specification's dataset builder (spec 2 §8.5) |
| `selectionReason`, `reviewerKind`, `llmReviewer`, `qualityRunId`, `priorityShown`, `shownPriority`, `priorDecisionsShown` and the blind audit sample (§7.6, §7.7) | P0.2, P2.2 | spec 2 §8.5 and §9.6, the OCR risk model specification's gate (#165) |
| `LlmReviewWrite` payloads, responses and codes, and its invocation authorization (§4.5, §13.4) | P0.2, P3.5 | the LLM reviewer (#165) |
| `review-escalation/v1`, its key layout `runs/{runId}/review/escalations/{escalationId}.json` and the open-escalation rule (§5.1, §7.8) | P0.2, P2.1 | `review-write`, `llm-review-write`, `review-read`, the LLM reviewer (#165) |
| `adjudicationSetSha256` (spec 2 §8.3) | spec 2 | validated-table lineage here, spec 2 baselines |
| Parser provenance in `normalized-ocr/v2` | spec 2 P0.3 | `enqueue-run`, `semanticField` and `exportedField` on labels, validated values |
| Quality result types and key layout (spec 2 §5.1, §10.1) | spec 2 P0.2, P3.1 | `review-read`, `review-write`, `llm-review-write`, `enqueue-run` |
| `review-plan/v1` (§7.6) | P0.2, P2.2 | `enqueue-run`, `review-write`, `rebuild-review-state` |
| Reviewer user pool and sampling seed SSM parameters (§13.2) | P1.1 | the stack, the deploy preflight, `enqueue-run`, `rebuild-review-state` |
| Reviewer API routes and bodies (§4) | P0.2 | the web application, API tests |

A change to a contract updates every consumer in the same PR.

### 20.3 Definition of done for every slice

- Handlers keep I/O behind an injected dependencies object; only default dependencies construct SDK clients. Scope, chain, decision, completion, sampling and validated-table code stays pure.
- New behavior has tests that run without AWS (`tap` for Lambdas and libraries, Vitest or Playwright for the web application), and the workspace stays above its coverage thresholds.
- `npm run check` passes. Slices that touch CDK also pass `npm run app:synth -- admin --environment dev`. Slices that touch `infrastructure/` pass `npm run tofu:check`.
- Any change to a stage's behavior bumps that stage's version (§5.4).
- No domain, address, account ID or real player data appears in code, fixtures, logs or docs.
- Operator-visible changes update `applications/admin/TESTING.md` or a README in the workspace.

### Phase 0: Workspace and contracts

**Goal:** a TypeScript workspace with test gates for Lambdas and the web application, and the shared review types.
**Exit criteria:** the workspace builds and tests in CI, and every type in §10.1 is exported from `@mcc/contracts`.

#### P0.1 Admin workspace, test gates and web scaffold (S)

- **Blocked by:** none
- **Spec:** §3, §11, §12, §16.1
- **Files:** `applications/admin/{package.json,tsconfig.json,TESTING.md}`, `test/`, `web/{index.html,vite.config.ts,src/,test/}`
- **Provides:** `build`, `build:web`, `typecheck`, `test`, `test:web` and `test:e2e` scripts
- **Acceptance:**
  - `npm test --workspace @mcc/admin` runs every `test/*.test.ts` with `tap` and fails below 80% statements, 65% branches, 80% lines or 60% functions.
  - `test:web` runs Vitest with the same thresholds for `web/src/`, and `test:e2e` runs one Playwright test of the empty shell at 320 by 640 CSS pixels.
  - The workspace depends only on `@mcc/contracts` and `@mcc/cdk-config` from the monorepo, and the existing boundary test still passes.

#### P0.2 Review and validated-table contracts (S)

- **Blocked by:** spec 2 P0.2
- **Spec:** §4.2, §4.5, §5.3, §10.1, §20.2
- **Files:** `packages/contracts/src/index.ts`
- **Provides:** every type in §10.1, the request body types in §4.2 and the `LlmReviewWrite` payload and response types in §4.5
- **Acceptance:**
  - The types compile and are exported, and `ValidatedTable` matches §8.4 field for field.
  - Reserved values (`MODEL_FLAGGED`, `CONSTRAINT_FAILED`, `AUTO_ACCEPTED`, `shownRiskModel`) are present and commented as never written in v1.
  - `npm run release:check` passes.

### Phase 1: Foundation and ephemeral permissions

**Goal:** a persistent reviewer user pool, and ephemeral stacks that can deploy the reviewer.
**Exit criteria:** P1.1 is applied in dev and prod, and an ephemeral `admin` stack deploys and destroys.

#### P1.1 Reviewer user pool (S)

- **Blocked by:** none
- **Spec:** §1, §7.6, §13.2, §14
- **Files:** `infrastructure/modules/foundation/{cognito,variables,outputs}.tf`, `infrastructure/{dev,prod}/foundation/`, `infrastructure/modules/foundation/tests/`
- **Provides:** the user pool, its domain, the `labeler` group, the `/mcc/<env>/review/` SSM parameters and the `sampling-seed` SecureString
- **Acceptance:**
  - Sign-up is admin-only, TOTP MFA is required, deletion protection is on, and the pool has `prevent_destroy`.
  - The domain prefix comes from a variable and no value is committed.
  - `/mcc/<env>/review/sampling-seed` is a `SecureString` with 32 random bytes generated by OpenTofu, and no plan output shows its value.
  - `npm run tofu:check` passes, and the PR states that applying it needs a person's approval.

#### P1.2 Local bootstrap permissions for admin stacks (S)

- **Blocked by:** none
- **Spec:** §13.3, §13.4
- **Files:** `infrastructure/modules/foundation/local-cdk-policies.tf` and `tests/local-cdk-policies.tftest.hcl`
- **Provides:** ephemeral permissions in §13.4 for `admin-e-*` resources
- **Acceptance:**
  - The local execution role can create, update and delete the resource types in §13.3 only when they are named `admin-e-*`, and can create user pool clients only on the dev pool.
  - The local workload boundary allows the `ReviewState` actions in §13.4 on `admin-e-*` tables and KMS use through DynamoDB, and nothing on shared tables.
  - Existing local CDK policy tests pass, and new tests cover each added statement.

### Phase 2: Review library

**Goal:** pure functions that turn evidence and adjudications into scope, completion, plans and validated tables.
**Exit criteria:** every rule in §7 and §8 is implemented and covered by fixtures.

#### P2.1 Chains, decisions, scope and completion (M)

- **Blocked by:** P0.1, P0.2; spec 2 P0.3
- **Spec:** §5.1, §7.1 to §7.5, §7.8, §8.1 to §8.3
- **Files:** `src/lib/{keys,evidence,chains,decisions,escalations,scope,completion}.ts`, `test/fixtures/`
- **Provides:** `resolveChain`, `validateCellDecision`, `deriveRowDecision`, `deriveTableDecision`, `checkReviewerKind`, `openEscalations`, `reviewScope`, `evaluateCompletion`, `adjudicationKey`, `escalationKey`
- **Acceptance:**
  - The `keys`, `chains`, `decisions`, `escalations`, `scope` and `completion` rows of §16.1 pass.
  - Row and table error types are derived from parser provenance, never taken from input.
  - `evidenceId()` output matches the spec 1 format.

#### P2.2 Review plans and sampling (S)

- **Blocked by:** P0.2
- **Spec:** §7.6, §7.7, §13.1, §13.2
- **Files:** `src/lib/{sampling,config}.ts`, `config/review-config-v1.json`
- **Provides:** `buildReviewPlan`, `loadReviewConfig`
- **Acceptance:**
  - The `sampling.test.ts` row of §16.1 passes.
  - Invalid configuration throws `InvalidReviewConfigError`, and the bundled configuration holds no seed.
  - `buildReviewPlan` takes the seed as an argument and records only `samplingSeedSha256`.
  - A plan with any `selectionReason` other than `REVIEW_ALL` cannot be built.

#### P2.3 Validated table builder (M)

- **Blocked by:** P2.1
- **Spec:** §8.4, §8.5, §8.6
- **Files:** `src/lib/validated-table.ts`
- **Provides:** `buildValidatedTable`, `adjudicationSetSha256`
- **Acceptance:**
  - The `validated-table.test.ts` row of §16.1 passes, including the spec 2 §8.3 hash vector.
  - Values carry `semanticField`, `exportedField`, `confirmedField` and `reviewerKind`, and an unreadable cell yields a `null` value with source `UNREADABLE`.
  - Lineage records `currentDecisionCounts` and `llmReviewers`.
  - The builder reads no feature row, score or quality signal.

### Phase 3: API and stack

**Goal:** the reviewer API, queue and stack, deployed in dev and prod.
**Exit criteria:** §17 criteria 2 to 10, 12, 13 and 15 hold in dev through direct API calls and `LlmReviewWrite` invocations, and prod deploys.

#### P3.1 Adjudication writer (M)

- **Blocked by:** P2.1, P2.2, P2.3
- **Spec:** §4.2, §4.3, §6.2 to §6.4, §6.7, §7.8, §8.2
- **Files:** `src/lambdas/review-write.ts`, `src/lib/{auth,run-evidence,run-evaluation,escalation-write,review-state,log}.ts`
- **Provides:** `writeAdjudication`, `bulkAccept`, `writeEscalation`, `evaluateRun`, `DynamoReviewStateStore`
- **Acceptance:**
  - Every case in the `review-write.test.ts` and `validated-race.test.ts` rows of §16.1 passes with injected dependencies.
  - Server-owned fields in §4.2 are never read from the body, and every adjudication it writes is `HUMAN`.
  - The writer creates objects only under `adjudications/`, `blind-adjudications/`, `review/escalations/` and `validated/`.

#### P3.2 Read API, queue and image URLs (S)

- **Blocked by:** P2.1, P2.2
- **Spec:** §4.1, §7.6, §14
- **Files:** `src/lambdas/review-read.ts`
- **Provides:** the GET routes
- **Acceptance:**
  - Every case in the `review-read.test.ts` row of §16.1 passes.
  - Image URLs expire after `imageUrlTtlSeconds` and name only the run's `source/original`.

#### P3.3 Enqueue and rebuild (S)

- **Blocked by:** P3.1, P3.2
- **Spec:** §4.4, §6.1, §6.4, §6.5
- **Files:** `src/lambdas/{enqueue-run,rebuild-review-state}.ts`, `test/blind-audit.test.ts`
- **Provides:** `enqueueRun`, `rebuildReviewState`
- **Acceptance:**
  - The `enqueue-run.test.ts`, `rebuild.test.ts` and `blind-audit.test.ts` rows of §16.1 pass, so a run without escalations can be audited blind from enqueue to a resolved disagreement.
  - Enqueueing the same outcome twice writes one plan and one `META` item.

#### P3.4 Stack, edge and IAM (M)

- **Blocked by:** P3.1, P3.2, P3.3, P3.5, P1.1, P1.2; spec 2 P1.1
- **Spec:** §3, §4.1, §4.4, §13.3 to §13.5, §14
- **Files:** `cdk/lib/{app,admin-stack}.ts`, `cdk/bin/admin.ts`
- **Provides:** the deployable stack
- **Acceptance:**
  - The `app.test.ts` row of §16.1 passes for stable and ephemeral deployments, including the `LlmReviewWrite` invocation rules.
  - The deploy preflight fails when a §13.2 parameter is missing, and post-deploy verification performs the checks in §13.5.
  - An ephemeral stack deploys, enqueues a run from its own namespace and destroys cleanly.

#### P3.5 LLM adjudication writer (S)

- **Blocked by:** P3.1
- **Spec:** §4.5, §6.7, §7.6 to §7.8, §8.1, §13.4, §14
- **Files:** `src/lambdas/llm-review-write.ts`
- **Provides:** `writeLlmAdjudication` and the `ESCALATE` operation, the only write path for `LLM` adjudications
- **Acceptance:**
  - Every case in the `llm-review-write.test.ts` row of §16.1 passes with injected dependencies.
  - Every adjudication it writes is `LLM`, records `llmReviewer` with `invocationSha256`, and never supersedes a `HUMAN` head.
  - The writer creates objects only under `adjudications/`, `review/escalations/` and `validated/`.

### Phase 4: Reviewer application

**Goal:** the mobile reviewer for escalation, blind audit and disagreement review.
**Exit criteria:** §17 holds in dev, and prod deploys.

#### P4.1 Sign-in, queue and run view (S)

- **Blocked by:** P0.1, P0.2
- **Spec:** §9.1, §9.5, §11.3
- **Files:** `web/src/{auth,api,components}/`
- **Provides:** PKCE sign-in, API hooks, `ScreenshotViewer`
- **Acceptance:**
  - Tokens are held in memory only, and every API call uses a relative `/api/v1` path.
  - The viewer supports pinch zoom, pan and full screen at 320 CSS pixels with no horizontal scrolling.
  - Hidden-mode responses render no priority.

#### P4.2 Escalation review steps (M)

- **Blocked by:** P4.1
- **Spec:** §7.2 to §7.5, §7.8, §9.2, §9.4
- **Files:** `web/src/review/`
- **Provides:** the four escalation review steps, "Escalate another item" and keyboard bindings
- **Acceptance:**
  - The e2e test in §16.1 completes the escalations of a fixture run with touch only, including a bulk accept, a correction of an `LLM` decision with an error type, a row correction, an undetected row and escalating another row.
  - Items that are not escalated show no decision.
  - A `409 STALE_RESOLUTION` reloads the item and requires a new decision.

#### P4.3 Blind audit and disagreement screens (S)

- **Blocked by:** P4.2
- **Spec:** §6.4, §9.3
- **Files:** `web/src/review/`
- **Provides:** the blind audit and disagreement screens
- **Acceptance:**
  - The blind audit screen shows no decision, value, reviewer kind, rationale, priority, signal or parser team, and submits the blind view's `qualityRunId`.
  - The e2e test in §16.1 completes a blind audit of a fixture run that has no escalation.
  - The disagreement screen shows both decisions without reviewer identities or reviewer kinds and writes a `DISAGREEMENT_RESOLUTION`.

#### P4.4 Live validation (S)

- **Blocked by:** P3.4, P4.3; spec 2 P3.2; the LLM reviewer slice of the OCR risk model specification (#165)
- **Spec:** §16.3, §17
- **Files:** `applications/admin/TESTING.md`
- **Provides:** the operator validation steps and a `NAMESPACE` rebuild that enqueues runs scored before deployment
- **Acceptance:**
  - `TESTING.md` lists the §16.3 steps, and they pass in dev.
  - A `NAMESPACE` rebuild in dev and prod enqueues every scored run that has parser provenance.

### Phase 5: Backlog (not filed with v1)

| ID | Slice | Size | Note |
| --- | --- | --- | --- |
| P5.1 | Order the primary queue by the latest `reviewPriority` in `PRIORITY_SHOWN` runs only | S | Spec 2 P5.1. Hidden runs keep enqueue order, because ordering would reveal their priority. |
| P5.2 | Stage 3 routing: plans that select items, `MODEL_FLAGGED` and `CONSTRAINT_FAILED` adjudications, an audit sample of auto-accepted items, completion with auto-accepted items, `AUTO_ACCEPTED` values | M | §7.7. Needs the OCR risk model specification (#165, spec 2 P5.5). |
| P5.3 | Blind audit of rows and tables | S | §18.12. |
| P5.4 | Alarms for DLQ depth, Lambda errors and 5xx rates | S | Follow [spec 5](5-match-to-csv-observability.md). |
| P5.5 | Restrict the API to CloudFront with a WAF or an origin header check | S | §18.10. |
| P5.6 | Reviewer agreement report over blind pairs, per reviewer kind and LLM prompt version | S | When reviewer quality needs tracking beyond spec 2's gate and #165's audit. |
| P5.7 | Step Functions fan-out for `NAMESPACE` rebuilds | S | §18.9. |

### 20.4 Dependency order and parallel lanes

P0.1, P0.2 (after spec 2 P0.2), P1.1 and P1.2 can start together. P2.2 runs beside P2.1, and P2.3 follows P2.1. P4.1 needs only the contracts, so the web lane (P4.1 -> P4.2 -> P4.3) runs beside the API lane (P2.1 -> P2.3 -> P3.1 -> P3.3 and P3.5 -> P3.4). P3.2 runs beside P3.1 and must merge before P3.3. The critical path is P0.2 -> P2.1 -> P2.3 -> P3.1 -> P3.3 -> P3.4 -> P4.4, gated by spec 2 P0.3 at P2.1, by the applies of P1.1 and spec 2 P1.1 at P3.4, and by the LLM reviewer of #165 at P4.4. P3.5 is the seam #165's LLM reviewer builds against, so it should merge before that reviewer's slices start. The first real feedback is P4.4 in dev, when the LLM reviewer completes live runs, people answer its escalations and audit its decisions, and the first validated tables exist for #159 to ingest.
