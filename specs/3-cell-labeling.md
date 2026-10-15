# Cell Labeling: Technical Specification

**Status:** Draft; not implemented

**Version:** 2.0-draft (rewrites the original cell labeling workflow on the specification template as a review-all workflow; see §1)

**Date:** October 15, 2026

**Component:** `applications/admin` (reviewer API, Lambdas, web application and CDK stack), with review and validated-table types in `packages/contracts`, the reviewer user pool in `infrastructure/modules/foundation`, and ephemeral-stack permissions in `scripts/local-cdk-bootstrap.mjs`

**Runtime:** TypeScript. Node.js 22 on AWS Lambda (ARM64) behind an API Gateway HTTP API; a React application built with Vite and served by CloudFront

**Deployment:** one AWS CDK stack per stable environment (`dev`, `prod`) from GitHub Actions, plus ephemeral developer stacks in the dev account, through the same guarded wrapper as match-to-csv

**Input:** match-to-csv run evidence (the original screenshot and `normalized-ocr/v2` with the parser provenance from [spec 2](2-ocr-quality.md) P0.3) and spec 2 quality results (`quality-result/v1`)

**Persistent state:** adjudications, review plans and validated tables under each processing run in the OpenTofu-owned evidence bucket; reviewer accounts in an OpenTofu-owned Cognito user pool; a rebuildable DynamoDB `ReviewState` table owned by the application stack

**External dependencies at runtime:** CloudFront, API Gateway, Lambda, Cognito, S3, KMS, DynamoDB, EventBridge, SQS, SSM Parameter Store

**Out of scope:** computing features or scores, training datasets and training example selection (spec 2 §8.4, §8.5), training or serving a risk model and routing review by it (a later specification), match records and player identity (the stats lakehouse, #159), public access and self-service sign-up

Reviewers in the Cognito `labeler` group open each scored run on a phone, compare every OCR cell, scoreboard row and table with the original screenshot, and confirm or correct each one. Every decision is stored as immutable evidence. When every required decision of a run exists, the system writes a validated table: the reviewed version of the run's scoreboard, with lineage back to the evidence. The stats lakehouse (#159) ingests validated tables into bronze. Spec 2 reads the adjudications to build cross-run baselines, and a later risk model trains and is evaluated on them under spec 2 §8.5 and §9.6.

**Changes in 2.0-draft:** the original text predates the specification template and spec 2. It collected decisions only for cells a reviewer chose to open, recorded nothing about what the reviewer was shown, defined its own JSONL training export and used UUIDv7 or ULID identifiers. This revision requires an explicit decision on every cell, row and table in scope (§7), adds row and table decisions for errors no cell can express, records error types, the selection reason, the `qualityRunId` reviewed against and whether a priority was visible, adds runs reviewed with priorities hidden and a blind double-review sample, and keys labels to both the semantic and the exported field. It removes the training export in favor of spec 2 §8.5, replaces the event index table with create-only adjudication chains (§8.1), moves the user pool to OpenTofu, and adds the validated table (§8.4) as the seam contract with the stats lakehouse. It keeps immutable adjudications in the evidence bucket, the rebuildable `CellResolution` projection and its supersession rule, Cognito group authorization with the reviewer identity taken from the JWT, the same-origin CloudFront and API layout without CORS, the mobile-first reviewer, and short-lived image URLs. §1 records each decision.

**Readiness:** this revision authorizes filing Phases 0 to 4. P3.4 cannot deploy until P1.1 here and spec 2 P1.1 are applied, and P4.4 needs spec 2's stack (spec 2 P3.2) deployed. Contracts in §5.3 and §10.1 freeze when P0.2 merges.

---

## 1. Resolved requirement decisions

| Original requirement | Decision | Reason |
| --- | --- | --- |
| A reviewer labels the cells they choose; `SKIPPED` is one of the decisions | Review-all: every cell, row and table in a run's review scope (§7.1) needs an explicit decision before the run is complete. `SKIPPED` is recorded but resolves nothing. An untouched cell is never a label. | Spec 2 §9.6 trains and evaluates the first risk model on complete labels. Labels only for cells a reviewer chose to open carry that choice as selection bias. |
| One decision per cell | Row decisions (§7.4) for missing row, extra row, wrong team and wrong win or loss, and table decisions (§7.5) for wrong table, wrong column mapping and rows Textract never detected. The reviewer confirms team and win or loss on every player row. | The parser derives team from row colour and win or loss from row order (spec 1 §8.4, §8.5). No cell holds those values, so no cell decision can correct them. |
| `CORRECTED` records only the new value | `CORRECTED` also records one or more error types (§7.3). | Glyph substitutions and shifted or merged cells need different fixes and different model features, and the two strings alone do not always tell them apart. |
| `adjudicationId` is a UUIDv7 or ULID | Every new identifier, including `adjudicationId`, `bulkActionId` and `validatedTableId`, is an `evidenceId()` value (spec 1 §5.1): base-36 milliseconds, a hyphen and a random UUID. | One identifier format across evidence. Identifiers sort by creation time like `runId` and `qualityRunId`. |
| `GET /v1/runs/{runId}/training-export` writes `CellTrainingExampleV1` JSONL | Removed. Spec 3 defines no labeled training export and writes nothing under `exports/`. | Spec 2 §8.5 owns training example selection and spec 2 §1 allows one labeled dataset definition. |
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
| The queue lists completed processing runs with unresolved cells | A run enters the queue when it has a `SUCCEEDED` spec 2 quality result and parser provenance (§6.1), and is listed oldest first. | Every adjudication names the quality run it was reviewed against, and the validated table needs provenance to know which table rows the parser exported. |
| Header cells are not mentioned | Header cells are reviewed like data cells. | Header OCR errors cause column mapping errors, and spec 2 writes feature rows for them. |
| No component named | `applications/admin`, the workspace the repository README assigns to the reviewer API and mobile review interface. | `ocr-quality` has no API or interface (spec 2 §2.2). |

**Additional capabilities included:** a bulk action that accepts the rest of a row as one adjudication per cell, disagreement resolution for blind pairs, an operator rebuild that also enqueues runs scored before this component existed, and a per-run review plan that records sampling decisions as evidence.

## 2. Goals and non-goals

### 2.1 Goals

1. A reviewer can confirm or correct every cell, row and table of a scored run on a 320-pixel-wide phone with touch alone.
2. Every label records what spec 2 §8.5 and §9.6 need: an explicit decision on every item in scope, error types, `selectionReason`, the `qualityRunId` reviewed against, whether a priority was shown, the semantic and exported field, and a blind double-review sample.
3. Every decision is immutable evidence, and every projection can be rebuilt from it.
4. Each review-complete run has an immutable, versioned validated table with lineage, and a later correction adds a version without changing earlier ones.
5. Two reviewers, or two tabs, can never silently overwrite each other.
6. Each developer can deploy an isolated copy that reads and writes only its own ephemeral namespace.

### 2.2 Non-goals

- Computing features, scores or priorities. Spec 2 owns them, and this component only displays spec 2 results.
- Defining training data. Spec 2 §8.5 owns training example selection; the risk model specification owns datasets.
- Routing review by a model, auto-accepting cells, or writing `MODEL_FLAGGED` or `AUDIT_SAMPLE` adjudications. §7.7 reserves the contract; a later specification owns the routing.
- Changing OCR evidence, normalized observations, CSVs or quality results.
- Match records, screenshot-to-match association, player identity across gamertags, and writing to lakehouse buckets. #159 reads validated tables.
- Blind double review of rows and tables (backlog P5.3).
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
                            +-- POST routes -> ReviewWrite Lambda
                                                 |
                                                 v
Evidence bucket (OpenTofu)  <-- read run evidence and quality results; write adjudications and validated tables
  |  runs/{runId}/review/plan.json, adjudications/, blind-adjudications/, validated/
  |
  |  Object Created: runs/*/quality/*/outcome.json (bucket notifications from spec 2 P1.1)
  v
EventBridge rule --> EnqueueRun Lambda --> review plan (S3) and ReviewState table (DynamoDB)
       |                                         ^
       +--(failed delivery)--> SQS DLQ           |
RebuildReviewState Lambda (operator-invoked) ----+  evidence -> projections, missing plans and validated versions

Evidence bucket source/original --(presigned GET, 10 minutes)--> browser
```

**Ownership rules:** `review-write` owns adjudications and validated tables. `enqueue-run` owns review plans and also writes validated versions through `evaluateRun`. `rebuild-review-state` writes plans and validated versions through the same library functions, create-only. All three own the `ReviewState` table, which is a cache. No module writes under `quality/`, `textract/`, `normalized/`, `export/` or any object match-to-csv or spec 2 owns. `scope`, `chains`, `decisions`, `completion`, `sampling` and `validated-table` are pure and perform no I/O. Only Lambda entry points construct AWS SDK clients; each core function receives an injected dependencies object.

**Packaging:** the `@mcc/admin` workspace with Lambda sources under `src/lambdas/`, pure libraries under `src/lib/`, the web application under `web/`, bundled configuration under `config/` and the CDK app under `cdk/`. Review contracts and the validated table type live in `@mcc/contracts`, because spec 2's baseline builder reads adjudications and the stats lakehouse reads validated tables.

**Orchestration decision:** no Step Functions. Every API write is synchronous and touches one run. The only fan-out is the operator rebuild, which fits in one 15-minute Lambda at league scale. A workflow is justified when the rebuild outgrows that limit (§18.9).

### 3.1 Execution policy

- One API request writes at most one adjudication, except a bulk accept, which writes one per cell of one row (at most `maxBulkCells`).
- Every evidence write uses `If-None-Match: *`. No handler deletes or overwrites an object.
- Supersession is enforced by adjudication keys (§8.1). The `ReviewState` table never decides which adjudication is current.
- A run is reviewable only after `enqueue-run` has written its review plan (§6.1).
- Handlers never read or write outside their namespace (`ephemeral/<name>/` for ephemeral stacks).
- This component never computes features, scores or priorities, and never passes a value to spec 2 scoring (§8.6).

## 4. Reviewer API and queue trigger

### 4.1 Routes

Every route sits behind the CloudFront `/api/*` behavior and the JWT authorizer, and requires the `labeler` group (§1). `runId` must match `^[0-9a-z]+-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$` and name a run in the `ReviewState` table; the table stores the run's evidence prefix, so no route accepts a key or prefix from the browser.

| Method and route | Lambda | Behavior |
| --- | --- | --- |
| `GET /api/v1/queue?pass=PRIMARY\|BLIND_DOUBLE\|DISAGREEMENT&limit=25&cursor=` | `ReviewRead` | `PRIMARY`: runs that are not complete, oldest enqueue first. `BLIND_DOUBLE`: sampled cells waiting for a blind review, excluding cells the caller has adjudicated in the primary track. `DISAGREEMENT`: runs with an open disagreement. Returns run and cell summaries only, never OCR text or priorities. `limit` is 1 to 100. |
| `GET /api/v1/runs/{runId}` | `ReviewRead` | The run view: tables, cells (observed text, geometry, `semanticField`, `exportedField`, row role), rows with the parser's output (exported, team, win and loss), current resolutions, required and resolved counts, open disagreements, `qualityRunId` (the latest `SUCCEEDED` quality run, spec 2 §5.2 rule 5), the latest validated version, and, only in `PRIORITY_SHOWN` runs, each cell's and table's `reviewPriority`, the run priority and each signal's `messageCode` and `evidence`. |
| `GET /api/v1/runs/{runId}/blind-cells/{cellObservationId}` | `ReviewRead` | The blind view of one sampled cell: observed text, geometry, `semanticField` and `exportedField`. Never a decision, priority, signal or parser team. `404 TARGET_NOT_FOUND` when the cell is not in the run's blind sample. |
| `GET /api/v1/runs/{runId}/image` | `ReviewRead` | A presigned `GetObject` URL for the run's `source/original`, valid for `imageUrlTtlSeconds` (600), with `response-content-type` from the screenshot metadata and `response-cache-control: private, no-store`. Never a bucket name or permanent URL. |
| `POST /api/v1/runs/{runId}/adjudications` | `ReviewWrite` | Writes one cell, row or table adjudication (§4.2, §6.2). |
| `POST /api/v1/runs/{runId}/adjudications/bulk-accept` | `ReviewWrite` | Accepts the remaining unresolved cells of one table row, one adjudication per cell (§7.2). |

### 4.2 Adjudication requests

```json
{
  "kind": "CELL",
  "target": { "cellObservationId": "<runId>:cell:<providerBlockId>" },
  "reviewPass": "PRIMARY",
  "qualityRunId": "<qualityRunId from the run view>",
  "supersedesAdjudicationId": null,
  "clientRequestId": "<UUID generated per submit>",
  "decision": { "decision": "CORRECTED", "submittedValue": "16", "errorTypes": ["GLYPH_SUBSTITUTION"] },
  "telemetry": { "reviewStartedAt": "2026-10-15T12:00:00Z", "reviewDurationMs": 5400, "openedFullImage": false, "imageZoomUsed": true, "reviewToolVersion": "reviewer-1.0.0" }
}
```

A row request has `kind: ROW`, `target: { tableObservationId, rowIndex }` and `decision: { isPlayerRow, team, outcome }`. A table request has `kind: TABLE`, `target: { tableObservationId }` and `decision: { role, columnFields, undetectedRows }`. A bulk accept has `target: { tableObservationId, rowIndex }`, `cells: [{ cellObservationId, supersedesAdjudicationId }]`, `qualityRunId`, `clientRequestId` and `telemetry`.

The browser supplies only the decision, the target, `reviewPass`, `qualityRunId`, `supersedesAdjudicationId`, `clientRequestId` and telemetry. The server owns every other field:

| Field | Source |
| --- | --- |
| `adjudicationId`, `bulkActionId` | `evidenceId()` |
| `reviewerId` | the access token's `sub` claim |
| `runId`, `screenshotId`, `cellObservationId`, `tableObservationId`, indexes, `observedTextAtReview`, `semanticField`, `exportedField`, `rowRole`, `classification` and every `parser` field | the run's evidence (`normalized/observations.json` and its P0.3 provenance) |
| `selectionReason` | the review plan (`REVIEW_ALL` in v1) |
| `priorityShown`, `shownPriority` | the review plan's display mode and the quality result named by `qualityRunId` (§7.6) |
| `priorDecisionsShown` | `true` for every `DISAGREEMENT_RESOLUTION`, and for any adjudication that supersedes one whose decision is not `SKIPPED`, because the reviewer saw the decision being replaced; `false` otherwise |
| `bulk` | `true` only on the bulk route |
| `decision` and `errorTypes` of rows and tables | derived from the reviewer's answers and the parser output (§7.4, §7.5) |
| `reviewedAt`, `build`, `reviewPolicyVersion`, `reviewConfigVersion` | server clock and deployment |

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
| `supersedesAdjudicationId` is not the head of the target's chain in its track, read from S3 as in §6.2 step 3, and the request is not a replay | `409 STALE_RESOLUTION`, with the current resolution | nothing |
| `SKIPPED`, or a bulk accept, on a cell whose current decision is `ACCEPTED`, `CORRECTED` or `UNREADABLE`, when the request is not a replay | `409 ALREADY_RESOLVED` | nothing |
| `BLIND_DOUBLE` on a cell outside the blind sample, or by a reviewer with a primary-track adjudication of that cell | `409 NOT_SAMPLED`, `409 SAME_REVIEWER` | nothing |
| `DISAGREEMENT_RESOLUTION` on a cell without an open disagreement, or by the blind reviewer | `409 NO_DISAGREEMENT`, `409 SAME_REVIEWER` | nothing |
| A decision breaks a rule in §7.2, §7.4 or §7.5 | `422 INVALID_DECISION`, with the rule's code | nothing |

### 4.4 Queue trigger

The stack's EventBridge rule matches `aws.s3` `Object Created` events from the evidence bucket whose key matches:

| Deployment | Key pattern (EventBridge `wildcard`) |
| --- | --- |
| Stable `dev` or `prod` | `submissions/*/screenshots/*/runs/*/quality/*/outcome.json` |
| Ephemeral `<name>` | `ephemeral/<name>/submissions/*/screenshots/*/runs/*/quality/*/outcome.json` |

The rule invokes `EnqueueRun` asynchronously with a retry policy of 3 attempts within 2 hours, and sends undeliverable events to `<stack>-events-dlq` (SQS-managed encryption, 14-day retention). The function's asynchronous invocation allows 2 retries and sends failed events to the same queue. `EnqueueRun` re-checks the key against `^(ephemeral/[a-z0-9][a-z0-9-]{0,19}/)?submissions/[^/]+/screenshots/[^/]+/runs/[^/]+/quality/[^/]+/outcome\.json$` and its own namespace, and fails with `InvalidQualityOutcomeKeyError` otherwise.

## 5. Review evidence

### 5.1 Layout

```text
[ephemeral/<name>/]submissions/{submissionId}/screenshots/{screenshotId}/runs/{runId}/
  review/
    plan.json
  adjudications/
    cells/{cellBlockId}/{predecessor}.json
    rows/{tableBlockId}/{rowIndex}/{predecessor}.json
    tables/{tableBlockId}/{predecessor}.json
  blind-adjudications/
    cells/{cellBlockId}/{predecessor}.json
  validated/
    {validatedVersion}.json
```

`cellBlockId` and `tableBlockId` are the Textract block IDs at the end of `cellObservationId` and `tableObservationId` (`<runId>:cell:<blockId>`, spec 1 §7.2). `{predecessor}` is `root` for an item's first adjudication and the superseded `adjudicationId` for every later one. `{validatedVersion}` is the version number zero-padded to six digits, so keys sort in version order.

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
| `review/plan.json` | `review-plan/v1` | `enqueue-run` | `ReviewPlan` (§10.1): `runId`, `screenshotId`, `selectionReason`, `displayMode`, `blindSampleCellIds`, `reviewConfigVersion`, the triggering `qualityRunId`, `createdAt` |
| `adjudications/cells/...` | `cell-adjudication/v1` | `review-write` | `CellAdjudication` with `reviewPass` `PRIMARY` or `DISAGREEMENT_RESOLUTION` |
| `adjudications/rows/...` | `row-adjudication/v1` | `review-write` | `RowAdjudication` |
| `adjudications/tables/...` | `table-adjudication/v1` | `review-write` | `TableAdjudication` |
| `blind-adjudications/cells/...` | `cell-adjudication/v1` | `review-write` | `CellAdjudication` with `reviewPass: BLIND_DOUBLE` |
| `validated/{validatedVersion}.json` | `validated-table/v1` | `review-write`, `enqueue-run`, `rebuild-review-state` | `ValidatedTable` (§8.4) |

### 5.4 Stage versions

Any change to a stage's behavior bumps its version in the same delivery.

| Key | v1 value |
| --- | --- |
| `reviewPolicyVersion` | `review-all-v1` |
| `reviewConfigVersion` | `review-config-v1` |
| `validatedTableBuilderVersion` | `validated-table-v1` |
| `reviewToolVersion` | `reviewer-<web package version>`, reported by the client and checked against `^reviewer-[0-9]+\.[0-9]+\.[0-9]+$` |

## 6. Review workflow

### 6.1 Enqueue

`enqueueRun(event, dependencies)`:

1. Validate the key (§4.4). Read the quality `outcome.json`. Stop with `skipped: QUALITY_NOT_SUCCEEDED` unless its status is `SUCCEEDED`.
2. Read the run `manifest.json` and `normalized/observations.json`. Stop with `skipped: MISSING_PARSER_PROVENANCE` when `parser.provenance` (spec 2 P0.3) is absent. An operator replays such a run (spec 1 §6.2); the replay is scored and enqueued like any run.
3. Build the review plan (§7.6) and write it create-only. On 412, read the existing plan and continue with it.
4. Put the run's `META` item if it does not exist (status `OPEN`, run prefix, `screenshotId`, `enqueuedAt`, the plan's display mode, primary queue keys). Otherwise update `latestQualityRunId` when the new `qualityRunId` is greater.
5. Evaluate the run once (§6.3). A run in which Textract found no table has no required item, so this evaluation completes it and writes its validated table with no rows.
6. Log `Run enqueued` with `runId`, `qualityRunId` and the outcome of each step.

A re-score therefore never re-enqueues or resets a run. It only moves `latestQualityRunId`, which the next page load shows.

### 6.2 Adjudication write

`writeAdjudication(input, dependencies)`:

1. Read `reviewerId` from `sub` and require `labeler` (§4.3). Validate the body.
2. Load the run's `META` item and its evidence: manifest, normalized observations, review plan, and the quality result and outcome named by `qualityRunId`. Evidence objects are immutable, so the handler caches parsed objects by key for the life of the execution environment, up to 64 MB.
3. List the item's chain prefix in its track (§5.1) and resolve the chain (§8.1). The chain read from S3, never the projection, decides what is current. Let the successor key be the key named after `supersedesAdjudicationId`, or `root` when it is `null`:
   1. When the successor key exists and its object has the request's `clientRequestId`, the request is a replay. Skip every other check and the write, run steps 5 and 6 with that object so a failed projection update or evaluation is repaired, and return it with `200`.
   2. When the successor key exists with another `clientRequestId`, or a non-null `supersedesAdjudicationId` is not an adjudication in the chain, return `409 STALE_RESOLUTION` with the current resolution.
   3. Otherwise check the pass rules (§4.3, §6.4) and the decision rules (§7) against the chain's head, and derive server-owned fields (§4.2).
4. Write the adjudication to the successor key with `If-None-Match: *`. On 412, another request wrote the key after the listing: apply step 3.1 or 3.2 to the object it wrote.
5. Update the item's projection (§8.2).
6. For a `BLIND_DOUBLE` write, evaluate the disagreement (§6.4) and stop. Otherwise evaluate the run (§6.3) and, for a cell with a blind adjudication, the disagreement.
7. Return `201` with the adjudication, the item's resolution, the run's counts and the latest validated version.

A bulk accept performs steps 1 to 5 for each listed cell in column order, with one `bulkActionId`, `bulk: true` and the per-cell `clientRequestId` `<clientRequestId>:<cellObservationId>`, then step 6 once. Every listed cell must belong to the target row and be unresolved, unless step 3.1 finds that its write is a replay. A failure on one cell does not undo earlier ones. The response lists each cell's result, and a retry with the same `clientRequestId` returns the cells already written as replays instead of `409 ALREADY_RESOLVED`.

### 6.3 Run evaluation and validated tables

`evaluateRun(runPrefix, dependencies)` runs after every primary-track write, once at enqueue (§6.1), and in every rebuild:

1. List the run's `adjudications/` prefix and resolve every chain (§8.1). S3 listings are strongly consistent, so the listing includes the write that triggered the evaluation.
2. Compute the review scope and completion (§7.1, §8.3). Update the `META` counts, status and `evaluatedAdjudicationCount` (the number of listed keys) with the condition that `evaluatedAdjudicationCount` does not decrease, so an evaluation with an older listing never overwrites a newer one. When the condition fails, a newer evaluation has run and this one stops. When the run is incomplete, stop.
3. Add every sampled cell in scope (§7.6) that has neither a blind adjudication nor a blind queue entry to the blind queue, with a conditional put on its `CELL` item. The step is idempotent and runs on every evaluation of a complete run, so cells of a table added to the scope later, and cells missed by an evaluation that stopped early, are queued by the next evaluation.
4. Compute `adjudicationSetSha256` over the listed keys (§8.5). List `validated/` and read the latest version. Adjudication keys are only ever added, so two listings of one run differ only by keys added between them. When the latest version's `lineage.adjudicationCount` is at least the number of listed keys, it was built from this listing's set or a later one, and the evaluation stops.
5. Build the validated table (§8.4) as version `n + 1` and write it create-only. On 412, another writer has written that version: return to step 1, at most 3 times, then log `VALIDATED_WRITE_CONTENDED` at `WARN` and leave the write to the next evaluation.

A table decision that adds a table to the scope can make a complete run incomplete again (§8.3). Its earlier validated versions stay, and the next version is written when the run is complete again.

### 6.4 Blind double review and disagreements

A blind reviewer takes cells from the `BLIND_DOUBLE` queue and sees only the blind view (§4.1). Their adjudication goes to `blind-adjudications/` with `reviewPass: BLIND_DOUBLE` and `priorityShown: false`, and it never supersedes or changes the primary track. Its `priorDecisionsShown` is `false` unless it replaces the blind reviewer's own earlier decision (§4.2).

A primary and a blind resolution agree when both decisions are the same and, for `ACCEPTED` and `CORRECTED`, their resolved texts are identical. Error types are not compared. A cell has an open disagreement when its current primary and blind resolutions disagree and the primary chain has no `DISAGREEMENT_RESOLUTION` adjudication with a `reviewedAt` later than the current blind adjudication's. The rule is a pure function of the two chains, so writes and rebuilds compute the same answer. The server evaluates it after a blind write and after any primary-track write to a cell with a blind adjudication, and records the result on the cell's projection item and the run's `DISAGREEMENT` queue entry (§8.2).

Any labeler other than the blind reviewer opens an open disagreement, sees both decisions without reviewer identities, and writes a `DISAGREEMENT_RESOLUTION` adjudication that supersedes the current primary adjudication. The disagreement closes whatever the resolver decides, including when the resolver keeps the first decision or chooses a third value. A later blind adjudication of the same cell can open it again. Because the resolution changes the primary set, the run gets a new validated version (§6.3).

### 6.5 Rebuild

`RebuildReviewState` is invoked by an operator with `{ "scope": "RUN", "runPrefix": <prefix> }` or `{ "scope": "NAMESPACE" }`. For each run in scope with a `SUCCEEDED` quality outcome, it writes the plan and `META` item when missing (§6.1 steps 2 to 4), resolves every chain and writes each item's projection, recomputes blind and disagreement queue entries, and runs §6.3. `NAMESPACE` lists every key under `<ns>submissions/`. It is the backfill path for runs scored before this component was deployed, and the recovery path after the table is deleted. A rebuild writes the same projections as incremental writes (§16.1) and is idempotent.

### 6.6 Retries and failure

API handlers rely on the SDK's default retries and return `503 UNAVAILABLE` for any other storage error, after which the browser retries the request with the same `clientRequestId`. An adjudication whose projection update failed is still the chain's head. A replay, the next write to the item or a rebuild repairs the projection (§8.2). A validated version missed because a handler stopped after step 4 of §6.2 is written by the browser's replay of the same request, the next primary write to the run, or a rebuild (§18.4). `EnqueueRun` errors are retried as in §4.4 and are safe to repeat.

## 7. Review policy

### 7.1 Review scope

A table is in the run's review scope when any of these holds: spec 2 assesses it (classification `SCOREBOARD`, spec 2 §7.4), the parser selected it (`parser.provenance.selectedTableIndex`), or its current table decision has `role: SCOREBOARD`. The required items of a run are:

- a table decision for every table of the run, in scope or not;
- a cell decision for every cell, header cells included, of every table in scope;
- a row decision for every row, header row included, of every table in scope.

Reviewers may also adjudicate cells of tables outside the scope. Those adjudications are labels, but the run does not wait for them.

### 7.2 Cell decisions

| Decision | Meaning | Rules | Resolved text |
| --- | --- | --- | --- |
| `ACCEPTED` | The observed text is exactly what the screenshot shows. | No `submittedValue`; `errorTypes` empty. | `observedTextAtReview` |
| `CORRECTED` | The screenshot shows different text. | `submittedValue` required, different from `observedTextAtReview`, at most 256 characters; `errorTypes` non-empty (§7.3). | `submittedValue` |
| `UNREADABLE` | The reviewer cannot read the cell in the screenshot. | No `submittedValue`; `errorTypes` empty. | none |
| `SKIPPED` | The reviewer moved on without deciding. Primary track only. | Only when the cell's current decision is none or `SKIPPED`. | none; the cell stays unresolved |

An empty observed text is accepted when the screenshot cell is empty. Corrections are free text: the API does not require digits in integer columns, the reviewer interface warns when a correction in an integer column is not all digits, and the validated table keeps the text (§8.4).

"Accept the rest of this row" accepts every unresolved cell of one table row as separate `ACCEPTED` adjudications marked `bulk: true` with a shared `bulkActionId` (§6.2). Each is a full adjudication with its own observed text and fields, and analysis can tell bulk decisions from individual ones.

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

The reviewer answers three questions for a table row: whether it is a player row (`isPlayerRow`), the player's team (`team`), and the outcome (`outcome`, `WIN` or `LOSS`). `team` is one of the MCC colour names in spec 1 §8.4, optionally followed by a space and a digit from 2 to 9, or an empty string in a free-for-all. `team` and `outcome` are required when `isPlayerRow` is true and must be `null` otherwise.

The server copies the parser's output for the row (whether `parser.provenance.rowIndexes` lists it, and the team, win and loss of its exported row) and derives the error types:

| Error type | Condition |
| --- | --- |
| `MISSING_ROW` | `isPlayerRow` and the parser did not export the row |
| `EXTRA_ROW` | the parser exported the row and `isPlayerRow` is false |
| `WRONG_TEAM` | `isPlayerRow`, exported, and `team` differs from the parser's team |
| `WRONG_OUTCOME` | `isPlayerRow`, exported, and `outcome` differs from the parser's win and loss |

`decision` is `CONFIRMED` when the list is empty and `CORRECTED` otherwise. The reviewer confirms team and outcome on every player row, including rows the parser got right, because the parser derives both (spec 1 §8.4, §8.5).

### 7.5 Table decisions

The reviewer states the table's `role` (`SCOREBOARD` or `NOT_SCOREBOARD`). For a `SCOREBOARD` table they also confirm `columnFields`, a field for every column index (`PLAYER`, `SCORE`, `KILLS`, `ASSISTS`, `DEATHS` or `NONE`), with exactly one `PLAYER` column and at most one column per other field, and list `undetectedRows`: player rows the screenshot shows but Textract never detected. Each undetected row holds `insertAfterRowIndex`, `team`, `player`, `score`, `kills`, `assists`, `deaths` and `outcome`, entered by the reviewer. Adding or editing an undetected row writes a new table adjudication that supersedes the previous one with the complete list.

The server copies whether the parser selected the table and the parser's `columnFields`, and derives the error types:

| Error type | Condition |
| --- | --- |
| `WRONG_TABLE` | the parser selected the table and `role` is `NOT_SCOREBOARD`, or the parser did not select it and `role` is `SCOREBOARD` |
| `WRONG_COLUMN_MAPPING` | the parser selected the table, `role` is `SCOREBOARD`, and `columnFields` differs from the parser's mapping, reading an unmapped column as `NONE` |
| `MISSING_ROW` | `undetectedRows` is not empty |

`decision` follows the same rule as rows. A scoreboard that Textract split into two tables (spec 1 §18.4) is two `SCOREBOARD` tables, and the second carries `WRONG_TABLE`.

### 7.6 Display modes and blind sampling

`enqueue-run` decides both samples once per run and records them in the review plan. With `h(x)` the first four bytes of `sha256(x)` read as an unsigned big-endian integer:

- **Display mode.** The run is `PRIORITY_HIDDEN` when `h(samplingSeed + "\0hidden\0" + runId) mod 10000 < priorityHiddenShare * 10000`, otherwise `PRIORITY_SHOWN`. In a hidden run the API returns no priority, score or signal for any item (§4.1), and every adjudication records `priorityShown: false`.
- **Blind sample.** A cell is sampled when `h(samplingSeed + "\0blind\0" + cellObservationId) mod 10000 < blindDoubleReviewShare * 10000`. The plan lists the sampled cells of every table, and those in scope enter the blind queue once the run is complete (§6.3 step 3).

In a shown run, `priorityShown` is `true` on every `PRIMARY` adjudication. `BLIND_DOUBLE` and `DISAGREEMENT_RESOLUTION` adjudications always record `priorityShown: false`, because their screens never show a priority (§9.3). `shownPriority` is the item's own priority from the quality result named by `qualityRunId`: the cell's `reviewPriority`, the table's `summary.reviewPriority`, or for a row the highest `reviewPriority` of its cells, which is what the reviewer interface displays on a row. It is `null` when the item has no priority, such as a cell of an unassessed table, and always `null` when `priorityShown` is false.

Labels with `priorityShown: false` and `priorDecisionsShown: false`, from hidden runs and from the blind sample, are the blind labels spec 2 §9.6 measures its automation gate on. A label that replaces an earlier decision records `priorDecisionsShown: true` (§4.2) and is not blind, even in a hidden run.

### 7.7 Selection reasons and later stages

`selectionReason` records why an item was put in front of a reviewer. Spec 2 §9.6 defines the stages.

| Value | Stage | Written by v1 | Rule |
| --- | --- | --- | --- |
| `REVIEW_ALL` | 1 and 2 | yes, on every adjudication | every item in scope is reviewed |
| `MODEL_FLAGGED` | 3 | no | the risk model flagged the item; the item may show the model's decision |
| `AUDIT_SAMPLE` | 3 | no | a random sample of auto-accepted items; always `priorityShown: false` with no model decision or score |

v1 rejects any other value than `REVIEW_ALL` in a plan. The optional `shownRiskModel` field on adjudications is reserved for stage 3 and never written in v1. Stage 2 runs the model in shadow and changes nothing here. Stage 3 also needs a validated table value source for auto-accepted cells, reserved as `AUTO_ACCEPTED` (§8.4). The later specification that routes review owns how plans select items and how completion counts auto-accepted items.

## 8. Resolution and the validated table

### 8.1 Chains and supersession

An item is a cell in the primary track, a cell in the blind track, a row, or a table. Its adjudications form a chain: the first has `supersedesAdjudicationId: null` and the key `.../root.json`, and each later one names the current head and has the key `.../<head adjudicationId>.json`. Because the key is create-only, two submissions naming the same predecessor cannot both be written, and the second gets `409 STALE_RESOLUTION`. This keeps the original rule that a replacement supersedes the current resolution only when it names it, and enforces it in storage instead of in the projection.

The current adjudication of an item is the chain's last element. `reviewedAt` increases along a chain, because each successor is written after its predecessor exists. The resolution as of a cutoff (spec 2 §8.5 rule 1) is the last element whose `reviewedAt` is at or before the cutoff. A chain with a missing link, which create-only writes cannot produce, fails resolution with `BrokenChainError` and is logged at `ERROR`.

### 8.2 Resolutions and the `CellResolution` projection

`CellResolution` (§10.1) is the current state of one cell in the primary track: the current adjudication, its decision and its resolved text (§7.2). Rows and tables have the same projection with their own fields. Projections live in the `ReviewState` table and are never evidence.

Each projection item stores `chainLength`, the number of adjudications in its chain. An update writes the new head with the condition `attribute_not_exists(chainLength) OR chainLength < :newLength`, so a late or repeated update never moves a projection backwards, and any writer that knows a longer chain can repair it. Deleting the table and running a `NAMESPACE` rebuild reproduces every projection exactly.

The read routes use only these attributes and never list the bucket:

| Item | Attributes | Written by |
| --- | --- | --- |
| `META` | `runPrefix`, `screenshotId`, `displayMode`, `latestQualityRunId`, `status` (`OPEN` or `COMPLETE`), required and resolved counts per item kind, `evaluatedAdjudicationCount`, `latestValidatedVersion` and `latestValidatedTableId`, `openDisagreementCount`, queue keys | `enqueue-run` (§6.1), `evaluateRun` (§6.3), the disagreement check (§6.4), `rebuild-review-state` |
| `CELL#<blockId>` | the `CellResolution` fields, `primaryReviewerIds` (the `sub` of every reviewer with an adjudication in the cell's primary chain), `blindSampled`, the blind chain's head and `chainLength`, `blindReviewerId`, `disagreementOpen`, blind queue keys | `review-write`, `evaluateRun`, `rebuild-review-state` |
| `ROW#...`, `TABLE#...` | the row or table resolution and `chainLength` | `review-write`, `rebuild-review-state` |

`latestValidatedVersion` is updated with the condition that it only grows. The `BLIND_DOUBLE` queue omits cells whose `primaryReviewerIds` contain the caller, and a write checks the same rule against the S3 chain (§4.3).

### 8.3 Review completion

A run is review-complete when all of these hold:

1. every table of the run has a current table decision;
2. every cell of every table in scope (§7.1) has a current primary decision of `ACCEPTED`, `CORRECTED` or `UNREADABLE`;
3. every row of every table in scope has a current row decision;
4. every row with `isPlayerRow: true` belongs to a table whose current role is `SCOREBOARD`.

Completion is a function of the resolved chains, so it is computed the same way after a write and in a rebuild. Open disagreements and blind reviews do not block completion. A later table decision can grow the scope and make the run incomplete again (§6.3).

### 8.4 Validated table

The validated table is the reviewed scoreboard of one run. It is the seam contract with the stats lakehouse (#159), which ingests every version into bronze.

**Rows.** The builder visits every table whose current role is `SCOREBOARD`, in `tableIndex` order. Within a table it emits each row with `isPlayerRow: true` in `rowIndex` order and inserts each undetected row after the row named by its `insertAfterRowIndex`, keeping list order between undetected rows with the same anchor. `rowKey` is `<tableIndex>:<rowIndex>` for a detected row and `<tableIndex>:added:<position in undetectedRows>` for an undetected one.

**Values.** For each field the table's confirmed `columnFields` maps to a column, the value comes from the cell at that row and column, or from the cell whose span covers them:

| Cell resolution | `source` | `text` |
| --- | --- | --- |
| `ACCEPTED` | `OCR_ACCEPTED` | the observed text |
| `CORRECTED` | `OCR_CORRECTED` | the submitted value |
| `UNREADABLE` | `UNREADABLE` | `null` |
| no column mapped to the field, or no cell at that position | `NOT_PRESENT` | `null` |
| undetected row | `REVIEWER_ENTERED` | the entered value |
| reserved for stage 3 (§7.7) | `AUTO_ACCEPTED` | never written in v1 |

Each value also records `cellObservationId`, `adjudicationId` (the cell adjudication, or the table adjudication for entered values), `observedText`, `semanticField`, `exportedField` and `confirmedField`. The row's typed fields are derived from the values: `score`, `kills`, `assists` and `deaths` are the integer when the trimmed text is all digits and `null` otherwise; `player` is the text tidied with spec 1 §8.2 step 4 (trim, remove one leading clan tag in square brackets, collapse whitespace), or `null`; `team` comes from the row decision; `win` and `loss` are `1, 0` for `WIN` and `0, 1` for `LOSS`.

**Table fields.** `hasScoreboard` is true when any table has role `SCOREBOARD`. `isFreeForAll` is true when there is at least one row and every row's team is empty. `contentSha256` is the SHA-256 of `rows` serialized as JSON with object keys sorted bytewise and no whitespace, so the lakehouse can tell versions with identical rows apart from changed ones. A run with no scoreboard still gets a validated table, with no rows and `hasScoreboard: false`.

### 8.5 Versions and lineage

The first validated version of a run is written when it first becomes review-complete. After that a new version is written whenever the run is complete and its primary adjudication set differs from the latest version's (§6.3). Earlier versions are never changed, and each version records `previousValidatedTableId`. The lakehouse selects the latest version per run (#159).

Each version's `lineage` records:

- `adjudicationSetSha256`: spec 2 §8.3's definition, the SHA-256 of the UTF-8 adjudication object keys, sorted bytewise and joined with `\n`, over every key under the run's `adjudications/` prefix at build time. The set includes superseded adjudications and excludes `blind-adjudications/`, because resolution depends on the whole chain and the blind track never changes values. A spec 2 baseline built from exactly the same keys carries the same value.
- `adjudicationCount`, the number of keys in that same set, and `qualityRunIds`, the sorted distinct quality runs the adjudications were reviewed against. §6.3 step 4 compares `adjudicationCount` with a new listing, so it counts exactly the keys hashed.
- `normalizedSha256`, the run manifest's `versions` as `sourceVersions`, and its `build` as `sourceBuild`.
- `reviewVersions`: `reviewPolicyVersion`, `reviewConfigVersion`, `validatedTableBuilderVersion` and the sorted distinct `reviewToolVersion` values of the adjudications.
- `build`: the writer's `gitSha` and `environment`.

The table also records `runId`, `screenshotId`, `submissionId` and `imageSha256`, so the lakehouse can group duplicate runs and resent images without reading other evidence.

### 8.6 Boundary with spec 2

- Spec 2 owns features, scores, priorities and training example selection (spec 2 §8.4, §8.5). This component only displays a quality result and records which one it displayed.
- Spec 3 defines no labeled export. The risk model specification's dataset builder joins spec 2 feature rows with these adjudications: cells by `(qualityRunId, cellObservationId)`, rows by `(qualityRunId, tableObservationId, rowIndex)` and tables by `(qualityRunId, tableObservationId)` (spec 2 §8.5 rules 3 and 5).
- No value this component writes reaches the features of the run it describes. Spec 2 reads adjudications only to build cross-run baselines, and a baseline never contains a label of the screenshot being scored (spec 2 §8.3, §8.4 rule 2). Validated tables, review plans, resolutions, telemetry and reviewer IDs are never inputs to spec 2.
- Adjudications attach to the reviewed run's observations and never label a sibling run (spec 2 §8.5 rule 7).

## 9. Reviewer experience

### 9.1 Layout

The reviewer is built for a phone held in portrait orientation and works at 320 CSS pixels wide with no horizontal page scrolling. The screenshot fills the upper part of the viewport at its own aspect ratio. The selected cell, row or table is outlined by a high-contrast SVG overlay drawn from the evidence geometry, so the page never reads image pixels. Pinch zoom and pan are required, and a full-screen toggle keeps the selection. A fixed bottom panel holds the item's evidence (observed text, `semanticField` and `exportedField`, row and column, the parser's team and outcome for rows), the decision controls and the correction input. In a `PRIORITY_SHOWN` run the panel also shows the item's priority and its signals' messages. It shows neither in a hidden run, in the blind view or in the disagreement view. Controls have a hit area of at least 44 by 44 CSS pixels and stay reachable above mobile browser chrome and the on-screen keyboard. At 960 CSS pixels and wider the same controls may use two panes; desktop is an enhancement, not a separate workflow.

OCR text and entered values are rendered as text, never as HTML. The interface never edits its copy of observed text; after each write, TanStack Query invalidates the run and queue queries and reloads them. Submit is disabled while a write is pending. On `409 STALE_RESOLUTION` the item reloads and the reviewer must decide again against the current resolution.

### 9.2 Run review steps

The reviewer suggests an order; the API accepts any.

1. **Tables.** Each table is outlined in turn. The reviewer sets its role and, for a scoreboard, confirms a field for each column, prefilled with the parser's mapping for the selected table and the semantic fields for others.
2. **Cells.** Cells of tables in scope, in table, row and column order, header row first. The reviewer accepts, corrects with at least one error type, marks unreadable, or skips. "Accept the rest of this row" is offered from the second cell of a row.
3. **Rows.** Each row of a table in scope is highlighted as a band. The reviewer confirms whether it is a player row and, for a player row, its team and outcome, prefilled with the parser's values. "Add a missing row" opens a form for an undetected row.
4. **Summary.** Required and resolved counts per step, open items, and the latest validated version.

### 9.3 Blind and disagreement screens

The blind screen shows one cell from the blind queue with the screenshot and the blind view only, and offers accept, correct and unreadable. The disagreement screen shows the cell and the two decisions, labelled "first" and "second" without reviewer identities, and no priority. It writes the resolution as a new primary adjudication.

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
type SelectionReason = 'REVIEW_ALL' | 'MODEL_FLAGGED' | 'AUDIT_SAMPLE'; // v1 writes REVIEW_ALL only
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
  qualityRunId: string;                  // the quality run whose outcome enqueued the run
  createdAt: string;
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
  reviewerId: string;                   // access token sub
  reviewPass: ReviewPass;
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
  telemetry: ReviewTelemetry;
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
| `src/lambdas/review-write.ts` | `handler(event)`; `writeAdjudication(input, dependencies)`; `bulkAccept(input, dependencies)` | The POST routes (§6.2, §6.3, §6.4). Records `GIT_SHA` and `DEPLOYMENT_ENVIRONMENT`. |
| `src/lambdas/enqueue-run.ts` | `handler(event)`; `enqueueRun(event, dependencies)` | §6.1. |
| `src/lambdas/rebuild-review-state.ts` | `handler(event)`; `rebuildReviewState(input, dependencies)` | §6.5. |

### 11.2 Libraries

| File | Public functions | Purpose |
| --- | --- | --- |
| `src/lib/keys.ts` | `parseQualityOutcomeKey(key, objectPrefix)`; `adjudicationKey(runPrefix, item, track, predecessor)`; `validatedKey(runPrefix, version)`; `planKey(runPrefix)` | Key validation and construction (§4.4, §5.1). |
| `src/lib/evidence.ts` | `evidenceId()`; `sha256(bytes)`; `putJsonOnce(bucket, key, value)`; `now()` | Identifiers in the spec 1 format and create-only writes. |
| `src/lib/auth.ts` | `requireLabeler(event)` | Returns `reviewerId` or throws `NotALabelerError`. |
| `src/lib/run-evidence.ts` | `loadRunEvidence(runPrefix, qualityRunId, dependencies)` | Reads and caches immutable run evidence. |
| `src/lib/chains.ts` | `resolveChain(adjudications, cutoff?)` | §8.1. Pure. |
| `src/lib/decisions.ts` | `validateCellDecision`; `deriveRowDecision`; `deriveTableDecision`; `openDisagreement(primaryChain, blindChain)` | §6.4, §7.2 to §7.5. Pure. |
| `src/lib/scope.ts` | `reviewScope(observations, tableResolutions)` | §7.1. Pure. |
| `src/lib/completion.ts` | `evaluateCompletion(scope, resolutions)` | §8.3. Pure. |
| `src/lib/sampling.ts` | `buildReviewPlan(observations, qualityRunId, config)` | §7.6. Pure. |
| `src/lib/run-evaluation.ts` | `evaluateRun(runPrefix, dependencies)` | §6.3. Shared by `review-write`, `enqueue-run` and `rebuild-review-state`, so no Lambda imports another. |
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
| `web/src/review/` | Table, cell, row and summary steps (§9.2), blind and disagreement screens (§9.3), keyboard bindings (§9.4). |

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
      lambdas/{review-read,review-write,enqueue-run,rebuild-review-state}.ts
      lib/{keys,evidence,auth,run-evidence,run-evaluation,chains,decisions,scope,completion,sampling,validated-table,review-state,config,log}.ts
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
  scripts/local-cdk-bootstrap.mjs      # Ephemeral permissions for admin stacks
```

`admin` imports only `@mcc/contracts` and `@mcc/cdk-config` from the monorepo and never imports `match-to-csv` or `ocr-quality` code. `web/` imports only `@mcc/contracts` types and never AWS SDK packages.

## 13. Configuration and infrastructure

### 13.1 Configuration schema

```json
{
  "reviewConfigVersion": "review-config-v1",
  "samplingSeed": "review-v1",
  "priorityHiddenShare": 0.2,
  "blindDoubleReviewShare": 0.05,
  "imageUrlTtlSeconds": 600,
  "maxTextLength": 256,
  "maxBulkCells": 32,
  "queuePageSize": 25,
  "teamNames": ["Red", "Blue", "Green", "Orange", "Purple", "Gold", "Brown", "Pink"]
}
```

The file is bundled into the Lambdas. `loadReviewConfig` validates every key at cold start: both shares between 0 and 1, `imageUrlTtlSeconds` between 60 and 900, `maxBulkCells` between 1 and 64. It throws `InvalidReviewConfigError` on any problem. A released file is never edited; a change adds `review-config-v2.json` and bumps `reviewConfigVersion`. Plans record the version they were sampled under, so a new share applies only to runs enqueued afterwards.

### 13.2 Persistent resources

| Resource | Owner | Configuration |
| --- | --- | --- |
| Evidence bucket | OpenTofu foundation | Existing (spec 1 §13.1), with EventBridge notifications from spec 2 P1.1. |
| KMS data key and SSM parameters | OpenTofu foundation | Existing. The stack reads `/mcc/<env>/match-to-csv/evidence-bucket-name` and `/mcc/<env>/match-to-csv/data-key-arn`. |
| Cognito user pool `<project>-<env>-reviewers` | OpenTofu foundation (P1.1) | Self-service sign-up disabled, TOTP MFA required, deletion protection on, `prevent_destroy`. Group `labeler`. A Cognito prefix domain from a variable, never committed. SSM parameters `/mcc/<env>/review/user-pool-id`, `/mcc/<env>/review/user-pool-arn` and `/mcc/<env>/review/user-pool-domain`. |

Operators create reviewer accounts and add them to `labeler` with the Cognito console or CLI. Ephemeral stacks use the dev pool.

### 13.3 Application resources

| Resource | Configuration |
| --- | --- |
| `ReviewRead` | Node.js 22, ARM64, 1,024 MB, 10-second timeout, X-Ray, env `EVIDENCE_BUCKET`, `OBJECT_PREFIX`, `REVIEW_TABLE` |
| `ReviewWrite` | Node.js 22, ARM64, 1,024 MB, 25-second timeout, X-Ray, env as `ReviewRead` plus `GIT_SHA`, `DEPLOYMENT_ENVIRONMENT` |
| `EnqueueRun` | Node.js 22, ARM64, 512 MB, 1-minute timeout, env as `ReviewRead` |
| `RebuildReviewState` | Node.js 22, ARM64, 2,048 MB, 15-minute timeout, env as `ReviewWrite` |
| HTTP API `<stack>` | Routes in §4.1 only, JWT authorizer (issuer the user pool, audience the stack's app client), no CORS configuration, `$default` stage with throttling of 20 requests per second and a burst of 40, JSON access logs |
| User pool client | On the foundation pool, no secret, authorization-code grant with PKCE, scopes `openid`, callback and sign-out URLs on the distribution's domain, access token valid 60 minutes |
| CloudFront distribution | Default behavior: site bucket through Origin Access Control, a CloudFront Function that serves `/index.html` for paths without a file extension, caching optimized. `/api/*`: HTTP API origin, caching disabled, origin request policy `AllViewerExceptHostHeader`, all methods. HTTPS only, default CloudFront certificate. Response headers policy: HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a Content Security Policy of `default-src 'self'`, `img-src 'self'` plus the evidence bucket's regional endpoint, `connect-src 'self'` plus the Cognito domain, `frame-ancestors 'none'`. No custom error responses, so API errors pass through. |
| Site bucket | Public access blocked, SSE-S3, read only through Origin Access Control, removed with the stack; deployed from `web/dist` plus a generated `config.json` |
| `ReviewState` table | On-demand; partition key `pk` (`RUN#<runId>`), sort key `sk` (`META`, `CELL#<blockId>`, `ROW#<tableBlockId>#<rowIndex>`, `TABLE#<tableBlockId>`); sparse GSI `queue` on `queuePk` (`QUEUE#PRIMARY`, `QUEUE#BLIND`, `QUEUE#DISAGREEMENT`) and `queueSk` (`<enqueuedAt>#<runId>` or `<completedAt>#<cellObservationId>`); encrypted with the foundation data key; removed with the stack because it is rebuildable (§6.5) |
| EventBridge rule and DLQ | §4.4 |
| Outputs | `DistributionDomainName`, `UserPoolClientId`, `RebuildFunctionName`, `ObjectPrefix` |

Log groups follow match-to-csv: three months in prod, two weeks otherwise, retained for stable stacks and destroyed with ephemeral ones.

### 13.4 Permissions

| Principal | Evidence bucket | KMS data key | `ReviewState` |
| --- | --- | --- | --- |
| `ReviewRead` | `GetObject` on `<ns>submissions/*` | decrypt | `GetItem`, `Query` |
| `ReviewWrite` | `ListBucket` with prefix `<ns>submissions/`; `GetObject` on `<ns>submissions/*`; `PutObject` on `<ns>submissions/*/runs/*/adjudications/*`, `.../blind-adjudications/*` and `.../validated/*` | decrypt, encrypt | `GetItem`, `Query`, `PutItem`, `UpdateItem` |
| `EnqueueRun` | `ListBucket` with prefix `<ns>submissions/`; `GetObject` on `<ns>submissions/*`; `PutObject` on `<ns>submissions/*/runs/*/review/*` and `.../validated/*` | decrypt, encrypt | `GetItem`, `PutItem`, `UpdateItem` |
| `RebuildReviewState` | `ListBucket` with prefix `<ns>submissions/`; `GetObject` on `<ns>submissions/*`; `PutObject` on `<ns>submissions/*/runs/*/review/*` and `.../validated/*`, never on adjudication prefixes | decrypt, encrypt | `GetItem`, `Query`, `PutItem`, `UpdateItem`, `BatchWriteItem` |

`<ns>` is empty for stable stacks and `ephemeral/<name>/` for ephemeral ones. `ReviewRead` signs image URLs with its own role, so a URL can read only what that role can. Every role carries the workload permissions boundary and, for ephemeral stacks, the `/mcc-local/` path. No role has `DeleteObject`, any bucket-configuration permission, or `PutObject` under `quality/`, `textract/`, `normalized/`, `export/` or `source/`.

P1.2 extends `scripts/local-cdk-bootstrap.mjs` so ephemeral `admin-e-*` stacks can create and delete their HTTP API, distribution, CloudFront Function, Origin Access Control, response headers policy, site bucket, table and user pool client, and so the local workload boundary allows the table actions above on `admin-e-*` tables and KMS use through DynamoDB.

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

## 15. Observability

- Lambdas log JSON lines with `level`, `message` and context fields: `requestId`, `runId`, `qualityRunId`, item kind, `adjudicationId`, decision, `reviewPass`, counts, durations and error codes. Logs never contain observed text, submitted or entered values, tokens, presigned URLs or email addresses.
- API Gateway access logs record request ID, route key, status, latency, integration error and the caller's `sub`, and never headers or query strings.
- X-Ray tracing is active on every function.
- The audit record for "who decided what about this run" is its `adjudications/` and `blind-adjudications/` chains, and for "what did the lakehouse receive" its `validated/` versions.
- Undeliverable queue events wait in the DLQ for 14 days. Alarms follow match-to-csv's observability specification ([spec 5](5-match-to-csv-observability.md); backlog P5.4).

## 16. Testing, CI and release

### 16.1 Tests

Lambda and library tests use `tap`, run from `applications/admin/test/*.test.ts`, and never call AWS. The command fails below 80% statements, 65% branches, 80% lines or 60% functions. Web tests use Vitest with Testing Library and the same thresholds for `web/src/`, and Playwright end-to-end tests run the built application against a mocked API.

| File | Covers |
| --- | --- |
| `keys.test.ts` | chain keys for every item and track; `root` keys; six-digit validated keys; stable and ephemeral outcome keys accepted, claims, deeper keys and other namespaces rejected |
| `chains.test.ts` | head of a chain; resolution at a cutoff; `BrokenChainError` on a missing link |
| `decisions.test.ts` | the open-disagreement rule in §6.4, including a resolution that keeps the first decision, a resolution with a third value and a later blind adjudication; every rule in §7.2 with each failure code; every row and table error type derived on seeded cases and absent on clean ones; team name pattern |
| `scope.test.ts`, `completion.test.ts` | the scope union in §7.1; scope growth after a table decision; `SKIPPED` leaves a cell unresolved; each completion condition in §8.3 |
| `sampling.test.ts` | plans are deterministic; over 10,000 generated IDs both shares are within 1 percentage point of configuration |
| `validated-table.test.ts` | row order with undetected rows; every value source; `semanticField`, `exportedField` and `confirmedField` on a fixture whose kills header is unreadable; player tidying; FFA; `contentSha256` stability; `adjudicationSetSha256` of keys `b` and `a` equals the SHA-256 of `a\nb`, as spec 2 §8.3 defines it |
| `review-write.test.ts` | create-only chain writes; `STALE_RESOLUTION` on a second successor and on a predecessor that is not in the chain; replay by `clientRequestId`, including a retry after a write that succeeded but returned `503`; bulk accept with partial failure and replay of the written cells; the current adjudication taken from the S3 chain when the projection lags; server-owned fields ignore body values, including `priorityShown`, `selectionReason` and `reviewerId`; `shownPriority` for cells, rows and tables; blind and disagreement rules; validated version written on completion, not rewritten for an unchanged set, retried on 412; no write outside the permitted prefixes |
| `review-read.test.ts` | hidden runs and blind views omit every priority, score, signal and decision; image URL key and TTL; `NOT_A_LABELER`; `RUN_NOT_FOUND`; queue filtering of the caller's own cells |
| `enqueue-run.test.ts` | a `SUCCEEDED` outcome writes a plan and `META`; failed outcomes and runs without provenance are skipped; a re-score moves `latestQualityRunId` without a new plan; a run with no table is completed with a validated table that has no rows |
| `validated-race.test.ts` | an evaluation that listed fewer keys than the latest version's `adjudicationCount` writes nothing, so an older set never becomes the latest version; an evaluation with an older listing never overwrites newer `META` counts or status; sampled cells of a table added to the scope after version 1, and cells missed by an evaluation that stopped after its validated write, are queued for blind review by the next evaluation |
| `rebuild.test.ts` | a rebuild after deleting the table equals the incremental projections; a missing validated version is written; runs without a plan are enqueued; resolved disagreements stay closed and open ones are restored |
| `app.test.ts` | stable and ephemeral synthesis; no CORS configuration on the API; CloudFront behaviors and headers in §13.3; IAM resource patterns in §13.4; the EventBridge pattern in §4.4 |
| `web/test/*.test.tsx` | each step renders evidence as text; correction requires an error type; hidden mode renders no priority; stale resolution reloads the item |
| `web/test/e2e/*.spec.ts` | at 320 by 640 CSS pixels with touch emulation, a reviewer completes a fixture run, including a bulk accept, a correction, a row correction and an undetected row, with no horizontal scrolling |

A fixture is a reduced run (normalized observations with P0.3 provenance, a quality result, adjudications) with player data replaced, plus the expected scope, completion and validated table.

### 16.2 CI and release

CI runs format, lint, typecheck, `tap`, Vitest and Playwright for the `admin` workspace on affecting changes, and synthesizes `admin` with `-c environment=dev -c ephemeral=ci` after building the web application. Release Please versions the application and `@mcc/contracts`; a contracts change bumps every dependent application.

### 16.3 Live validation

After a change reaches dev, an operator signs in as a dev reviewer on a phone, completes one run from the queue, checks that the run's `adjudications/` prefix holds one chain per item and that `validated/000001.json` exists with the expected rows, corrects one cell and checks that `validated/000002.json` appears beside the unchanged first version, and completes one blind review that disagrees and its resolution.

## 17. Acceptance criteria

v1 (Phases 0 to 4) is complete when:

1. A reviewer in the `labeler` group completes a scored dev run on a 320-pixel-wide phone with touch alone, and a user outside the group gets `403 NOT_A_LABELER` from every route.
2. The run stays incomplete while any required table, cell or row in §7.1 lacks a decision, and a `SKIPPED` cell keeps it incomplete.
3. "Accept the rest of this row" on a row with four unresolved cells writes four `cell-adjudication/v1` objects with `bulk: true` and one `bulkActionId`.
4. Every adjudication records `selectionReason: REVIEW_ALL`, a `qualityRunId` with a `SUCCEEDED` outcome, `priorityShown` and `shownPriority`. Every cell adjudication also records `semanticField` and `exportedField`, and a `CORRECTED` cell records at least one error type.
5. In a run whose plan says `PRIORITY_HIDDEN`, no API response contains a priority, score or signal, and every adjudication has `priorityShown: false`.
6. A fixture run whose parser exported a total row, dropped a player row and swapped two teams yields `EXTRA_ROW`, `MISSING_ROW` and `WRONG_TEAM` row adjudications, and the validated table has the reviewer's rows and teams.
7. Completing a run writes `validated/000001.json` with `adjudicationSetSha256` per spec 2 §8.3, `runId`, `screenshotId` and stage versions. A later correction writes `validated/000002.json` and leaves version 1 byte-for-byte unchanged.
8. A sampled cell is reviewed blind by a second reviewer, both adjudications are kept in separate tracks, and a disagreement is resolved by a third adjudication that supersedes the primary decision.
9. Two tabs superseding the same adjudication produce one write and one `409 STALE_RESOLUTION`, and the evidence holds no fork.
10. Deleting the `ReviewState` table and running a `NAMESPACE` rebuild restores every projection and queue entry.
11. The app calls only relative `/api/v1` routes, API responses carry no CORS headers, and image URLs expire after 10 minutes.
12. Existing OCR evidence and quality results are byte-for-byte unchanged after every review action, and no object exists under `exports/`.
13. An ephemeral stack reviews only runs under its own `ephemeral/<name>/` namespace.
14. Every §16.1 test passes with the coverage thresholds, and CDK synthesis succeeds.

## 18. Risks and accepted limitations

1. **Shown priorities bias labels.** Reviewers who see a priority look harder at flagged cells and less at others. Accepted because hidden runs and the blind sample give unbiased labels for spec 2 §9.6, and `priorityShown` lets analysis separate the two.
2. **The blind sample may be too small at first.** At 5% of cells and 20% hidden runs, the gate's tens of thousands of blind labels (spec 2 §9.6) take many runs to collect. The shares are configuration (§13.1) and can grow when the risk model specification sets a target.
3. **Blindness relies on the interface.** Any labeler can open the full run view of a cell they later review blind. The blind queue excludes their own primary decisions, and reviewers are trusted members of the league.
4. **Validated versions can lag.** A handler that stops between its adjudication write and the validated write leaves a complete run without its newest version until the browser replays the request, the run is written to again, or an operator runs a rebuild (§6.6). Accepted because the evidence is complete and the lakehouse sees the version when it appears.
5. **Duplicate runs are reviewed separately.** Retries and replays create sibling runs of one screenshot (spec 1 §18.6), and each is enqueued. Validated tables carry `screenshotId` and `imageSha256`, so the lakehouse can choose between them (#159).
6. **Runs without parser provenance cannot be reviewed.** Runs written before spec 2 P0.3 are skipped until an operator replays them (§6.1).
7. **Non-scoreboard screenshots still cost review.** The parser's selected table is in scope even when it is not a scoreboard, so its cells need decisions. Accepted because players rarely send other screenshots and those labels still describe OCR accuracy.
8. **No ties or undetermined outcomes.** `outcome` is `WIN` or `LOSS`, as in the CSV, and spec 1 §18.2 already trusts the top row. A tie needs a contract change.
9. **Rebuilds scan the namespace.** `NAMESPACE` lists every evidence key, so its time grows with evidence. Accepted at league scale; a Step Functions fan-out is the fix when it nears 15 minutes.
10. **The API endpoint is reachable without CloudFront.** The default `execute-api` endpoint accepts requests directly. Every route still needs a valid token, and browsers cannot call it cross-origin. A WAF or a header check is backlog P5.5.
11. **Telemetry is client-reported.** Durations and zoom flags can be wrong or forged. They are used only for review analysis, never as features or for authorization.
12. **Team names are a colour judgment.** Reviewers can disagree on colour names, as the parser can (spec 1 §18.3), and row decisions are not double-reviewed in v1 (P5.3).
13. **Any labeler can supersede any decision.** Every supersession is evidence with the reviewer's `sub`, so mistakes and abuse are traceable rather than prevented.
14. **Ephemeral stacks are slow to create.** CloudFront distributions take minutes to deploy and delete (§13.5).
15. **The stack reads SSM parameters under `match-to-csv`.** As spec 2 §18.14 records, foundation parameters for the evidence bucket and key carry another application's name. New review parameters use `/mcc/<env>/review/`.

## 19. Reference documentation

- Cognito authorization endpoint: https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html
- Cognito token endpoint: https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html
- Cognito tokens: https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-with-identity-providers.html
- Cognito user pool groups: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-user-groups.html
- PKCE (RFC 7636): https://datatracker.ietf.org/doc/html/rfc7636
- HTTP API JWT authorizers: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html
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
| `validated-table/v1`, its key layout `runs/{runId}/validated/{validatedVersion}.json` and the version rule (§5.1, §8.4, §8.5) | P0.2, P2.3 | `review-write`, `enqueue-run`, `rebuild-review-state`, the stats lakehouse bronze ingestion (#159) |
| `cell-adjudication/v1`, `row-adjudication/v1`, `table-adjudication/v1` and the chain keys and supersession rule (§5.1, §8.1) | P0.2, P2.1 | `review-write`, spec 2 `build-baselines` (spec 2 §8.3), the risk model specification's dataset builder (spec 2 §8.5) |
| `selectionReason`, `qualityRunId`, `priorityShown`, `shownPriority`, `priorDecisionsShown` and the blind double-review sample (§7.6, §7.7) | P0.2, P2.2 | spec 2 §8.5 and §9.6, the risk model specification's gate |
| `adjudicationSetSha256` (spec 2 §8.3) | spec 2 | validated-table lineage here, spec 2 baselines |
| Parser provenance in `normalized-ocr/v2` | spec 2 P0.3 | `enqueue-run`, `semanticField` and `exportedField` on labels, validated values |
| Quality result types and key layout (spec 2 §5.1, §10.1) | spec 2 P0.2, P3.1 | `review-read`, `review-write`, `enqueue-run` |
| `review-plan/v1` (§7.6) | P0.2, P2.2 | `enqueue-run`, `review-write`, `rebuild-review-state` |
| Reviewer user pool SSM parameters (§13.2) | P1.1 | the stack, the deploy preflight |
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
- **Spec:** §4.2, §5.3, §10.1, §20.2
- **Files:** `packages/contracts/src/index.ts`
- **Provides:** every type in §10.1 and the request body types in §4.2
- **Acceptance:**
  - The types compile and are exported, and `ValidatedTable` matches §8.4 field for field.
  - Reserved values (`MODEL_FLAGGED`, `AUDIT_SAMPLE`, `AUTO_ACCEPTED`, `shownRiskModel`) are present and commented as never written in v1.
  - `npm run release:check` passes.

### Phase 1: Foundation and ephemeral permissions

**Goal:** a persistent reviewer user pool, and ephemeral stacks that can deploy the reviewer.
**Exit criteria:** P1.1 is applied in dev and prod, and an ephemeral `admin` stack deploys and destroys.

#### P1.1 Reviewer user pool (S)

- **Blocked by:** none
- **Spec:** §1, §13.2, §14
- **Files:** `infrastructure/modules/foundation/{cognito,variables,outputs}.tf`, `infrastructure/{dev,prod}/foundation/`, `infrastructure/modules/foundation/tests/`
- **Provides:** the user pool, its domain, the `labeler` group and the `/mcc/<env>/review/` SSM parameters
- **Acceptance:**
  - Sign-up is admin-only, TOTP MFA is required, deletion protection is on, and the pool has `prevent_destroy`.
  - The domain prefix comes from a variable and no value is committed.
  - `npm run tofu:check` passes, and the PR states that applying it needs a person's approval.

#### P1.2 Local bootstrap permissions for admin stacks (S)

- **Blocked by:** none
- **Spec:** §13.3, §13.4
- **Files:** `scripts/local-cdk-bootstrap.mjs` and its tests
- **Provides:** ephemeral permissions in §13.4 for `admin-e-*` resources
- **Acceptance:**
  - The local execution role can create, update and delete the resource types in §13.3 only when they are named `admin-e-*`, and can create user pool clients only on the dev pool.
  - The local workload boundary allows the `ReviewState` actions in §13.4 on `admin-e-*` tables and KMS use through DynamoDB, and nothing on shared tables.
  - Existing bootstrap tests pass, and new tests cover each added statement.

### Phase 2: Review library

**Goal:** pure functions that turn evidence and adjudications into scope, completion, plans and validated tables.
**Exit criteria:** every rule in §7 and §8 is implemented and covered by fixtures.

#### P2.1 Chains, decisions, scope and completion (M)

- **Blocked by:** P0.1, P0.2; spec 2 P0.3
- **Spec:** §5.1, §7.1 to §7.5, §8.1 to §8.3
- **Files:** `src/lib/{keys,evidence,chains,decisions,scope,completion}.ts`, `test/fixtures/`
- **Provides:** `resolveChain`, `validateCellDecision`, `deriveRowDecision`, `deriveTableDecision`, `reviewScope`, `evaluateCompletion`, `adjudicationKey`
- **Acceptance:**
  - The `keys`, `chains`, `decisions`, `scope` and `completion` rows of §16.1 pass.
  - Row and table error types are derived from parser provenance, never taken from input.
  - `evidenceId()` output matches the spec 1 format.

#### P2.2 Review plans and sampling (S)

- **Blocked by:** P0.2
- **Spec:** §7.6, §7.7, §13.1
- **Files:** `src/lib/{sampling,config}.ts`, `config/review-config-v1.json`
- **Provides:** `buildReviewPlan`, `loadReviewConfig`
- **Acceptance:**
  - The `sampling.test.ts` row of §16.1 passes.
  - Invalid configuration throws `InvalidReviewConfigError`.
  - A plan with any `selectionReason` other than `REVIEW_ALL` cannot be built.

#### P2.3 Validated table builder (M)

- **Blocked by:** P2.1
- **Spec:** §8.4, §8.5, §8.6
- **Files:** `src/lib/validated-table.ts`
- **Provides:** `buildValidatedTable`, `adjudicationSetSha256`
- **Acceptance:**
  - The `validated-table.test.ts` row of §16.1 passes, including the spec 2 §8.3 hash vector.
  - Values carry `semanticField`, `exportedField` and `confirmedField`, and an unreadable cell yields a `null` value with source `UNREADABLE`.
  - The builder reads no feature row, score or quality signal.

### Phase 3: API and stack

**Goal:** the reviewer API, queue and stack, deployed in dev and prod.
**Exit criteria:** §17 criteria 2 to 10, 12 and 13 hold in dev through direct API calls, and prod deploys.

#### P3.1 Adjudication writer (M)

- **Blocked by:** P2.1, P2.2, P2.3
- **Spec:** §4.2, §4.3, §6.2 to §6.4, §8.2
- **Files:** `src/lambdas/review-write.ts`, `src/lib/{auth,run-evidence,run-evaluation,review-state,log}.ts`
- **Provides:** `writeAdjudication`, `bulkAccept`, `evaluateRun`, `DynamoReviewStateStore`
- **Acceptance:**
  - Every case in the `review-write.test.ts` and `validated-race.test.ts` rows of §16.1 passes with injected dependencies.
  - Server-owned fields in §4.2 are never read from the body.
  - The writer creates objects only under `adjudications/`, `blind-adjudications/` and `validated/`.

#### P3.2 Read API, queue and image URLs (S)

- **Blocked by:** P2.1, P2.2
- **Spec:** §4.1, §7.6, §14
- **Files:** `src/lambdas/review-read.ts`
- **Provides:** the GET routes
- **Acceptance:**
  - Every case in the `review-read.test.ts` row of §16.1 passes.
  - Image URLs expire after `imageUrlTtlSeconds` and name only the run's `source/original`.

#### P3.3 Enqueue and rebuild (S)

- **Blocked by:** P3.1
- **Spec:** §4.4, §6.1, §6.5
- **Files:** `src/lambdas/{enqueue-run,rebuild-review-state}.ts`
- **Provides:** `enqueueRun`, `rebuildReviewState`
- **Acceptance:**
  - The `enqueue-run.test.ts` and `rebuild.test.ts` rows of §16.1 pass.
  - Enqueueing the same outcome twice writes one plan and one `META` item.

#### P3.4 Stack, edge and IAM (M)

- **Blocked by:** P3.1, P3.2, P3.3, P1.1, P1.2; spec 2 P1.1
- **Spec:** §3, §4.1, §4.4, §13.3 to §13.5, §14
- **Files:** `cdk/lib/{app,admin-stack}.ts`, `cdk/bin/admin.ts`
- **Provides:** the deployable stack
- **Acceptance:**
  - The `app.test.ts` row of §16.1 passes for stable and ephemeral deployments.
  - The deploy preflight fails when a §13.2 parameter is missing, and post-deploy verification performs the checks in §13.5.
  - An ephemeral stack deploys, enqueues a run from its own namespace and destroys cleanly.

### Phase 4: Reviewer application

**Goal:** the mobile reviewer for run, blind and disagreement review.
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

#### P4.2 Table, cell and row review steps (M)

- **Blocked by:** P4.1
- **Spec:** §7.2 to §7.5, §9.2, §9.4
- **Files:** `web/src/review/`
- **Provides:** the four run review steps and keyboard bindings
- **Acceptance:**
  - The e2e test in §16.1 completes a fixture run with touch only, including a bulk accept, a correction with an error type, a row correction and an undetected row.
  - A `409 STALE_RESOLUTION` reloads the item and requires a new decision.

#### P4.3 Blind and disagreement screens (S)

- **Blocked by:** P4.2
- **Spec:** §6.4, §9.3
- **Files:** `web/src/review/`
- **Provides:** the blind and disagreement screens
- **Acceptance:**
  - The blind screen shows no decision, priority, signal or parser team.
  - The disagreement screen shows both decisions without reviewer identities and writes a `DISAGREEMENT_RESOLUTION`.

#### P4.4 Live validation (S)

- **Blocked by:** P3.4, P4.3; spec 2 P3.2
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
| P5.2 | Stage 3 routing: `MODEL_FLAGGED` and `AUDIT_SAMPLE` plans, completion with auto-accepted items, `AUTO_ACCEPTED` values | M | §7.7. Needs the risk model specification (spec 2 P5.5). |
| P5.3 | Blind double review of rows and tables | S | §18.12. |
| P5.4 | Alarms for DLQ depth, Lambda errors and 5xx rates | S | Follow [spec 5](5-match-to-csv-observability.md). |
| P5.5 | Restrict the API to CloudFront with a WAF or an origin header check | S | §18.10. |
| P5.6 | Reviewer agreement report over blind pairs | S | When reviewer quality needs tracking beyond spec 2's gate. |
| P5.7 | Step Functions fan-out for `NAMESPACE` rebuilds | S | §18.9. |

### 20.4 Dependency order and parallel lanes

P0.1, P0.2 (after spec 2 P0.2), P1.1 and P1.2 can start together. P2.2 runs beside P2.1, and P2.3 follows P2.1. P4.1 needs only the contracts, so the web lane (P4.1 -> P4.2 -> P4.3) runs beside the API lane (P2.1 -> P2.3 -> P3.1 -> P3.3 -> P3.4). The critical path is P0.2 -> P2.1 -> P2.3 -> P3.1 -> P3.3 -> P3.4 -> P4.4, gated by spec 2 P0.3 at P2.1 and by the applies of P1.1 and spec 2 P1.1 at P3.4. The first real feedback is P4.4 in dev, when reviewers complete live runs and the first validated tables exist for #159 to ingest.
