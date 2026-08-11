# Cell Labeling Workflow

## Purpose

This feature collects trustworthy OCR training labels from the evidence already produced by `match-to-csv`. It operates on screenshots and processing runs. It does not introduce matches, player records, public users, anomaly scoring, model inference, or automated correction.

One authenticated reviewer inspects an OCR cell against the original screenshot and records whether the OCR text was accepted, corrected, unreadable, or skipped. The system keeps every observation and every reviewer decision forever. A derived resolution is allowed to change when a later decision supersedes an earlier one.

## Architecture

The reviewer application is a mobile-first React application built with Vite. It uses TanStack Query for all API reads and mutations. It is hosted as static files in a private S3 origin behind CloudFront. The application shell is the default CloudFront behavior. A second behavior proxies `/api/*` to API Gateway. The browser therefore uses one HTTPS origin for the UI and API.

CORS is prohibited. API Gateway CORS configuration remains disabled. CloudFront does not add `Access-Control-Allow-*` headers. The React application calls relative `/api/v1/...` paths only. Same-origin policy protects browser access, while Cognito JWT authorization protects every API request.

Amazon Cognito provides the user pool and OAuth authorization-code flow with PKCE. The initial deployment creates one `labeler` group. API Gateway HTTP API uses a Cognito JWT authorizer. Every endpoint requires that group. The API obtains the reviewer identity from the JWT `sub` claim, never from a request field.

API Gateway invokes small Lambda handlers. A label submission is synchronous and does not require Step Functions. The handler validates the request, reads the referenced normalized observation, writes an immutable S3 adjudication object, conditionally writes an event index entry, and updates the mutable resolution projection. A Step Functions workflow is not part of this feature. Add one later only when batch replay, training export, or quality scoring needs fan-out and redrive.

```text
React/Vite reviewer
  -> Cognito login
  -> CloudFront `/api/*` behavior -> API Gateway HTTP API
       -> read evidence and issue short-lived image URL
       -> append CellAdjudication to S3 and DynamoDB event index
       -> update CellResolution projection
```

## Evidence and Models

The existing evidence bucket remains the authoritative record. Add these objects below the processing-run prefix:

```text
submissions/{submissionId}/screenshots/{screenshotId}/
  runs/{runId}/
    adjudications/{adjudicationId}.json
    exports/training/cell-examples-v1.jsonl
```

`CellAdjudication` is immutable and uses this contract:

```ts
type CellAdjudication = {
  schemaVersion: 'cell-adjudication/v1'
  adjudicationId: string // UUIDv7 or ULID
  cellObservationId: string
  runId: string
  screenshotId: string
  reviewerId: string // Cognito sub
  decision: 'ACCEPTED' | 'CORRECTED' | 'UNREADABLE' | 'SKIPPED'
  observedTextAtReview: string
  submittedValue?: string
  supersedesAdjudicationId?: string
  reviewedAt: string
  reviewStartedAt: string
  reviewDurationMs: number
  openedFullImage: boolean
  imageZoomUsed: boolean
  reviewToolVersion: 'cell-labeler-v1'
  reviewPolicyVersion: 'cell-label-v1'
}
```

`ACCEPTED` requires no `submittedValue`; its ground truth is `observedTextAtReview`. `CORRECTED` requires a non-empty `submittedValue`. `UNREADABLE` and `SKIPPED` reject `submittedValue`. A replacement decision must name the decision it supersedes. The API rejects a supersession that belongs to another cell or run.

`CellResolution` is a mutable DynamoDB projection, not evidence:

```ts
type CellResolution = {
  cellObservationId: string
  runId: string
  screenshotId: string
  currentAdjudicationId: string
  decision: 'ACCEPTED' | 'CORRECTED' | 'UNREADABLE' | 'SKIPPED'
  resolvedText?: string
  resolutionVersion: 'cell-resolution-v1'
  resolvedAt: string
}
```

The projection is rebuilt entirely from ordered adjudication objects. A submitted replacement supersedes the previous resolution only when its `supersedesAdjudicationId` equals the current resolution. This prevents silent overwrites from two open browser tabs.

Add two DynamoDB tables, encrypted with the existing application KMS key:

| Table | Key | Purpose |
|---|---|---|
| `OcrLabelEvents` | `PK=CELL#{cellObservationId}`, `SK=EVENT#{reviewedAt}#{adjudicationId}` | Queryable append-only index of S3 adjudications. Conditional put prevents duplicate IDs. GSI by `RUN#{runId}` lists labels for export. |
| `OcrCellResolutions` | `PK=CELL#{cellObservationId}` | Current derived resolution and optimistic-concurrency source. GSI by `RUN#{runId}` lists resolved and unresolved cells. |

Do not duplicate raw OCR blocks or source images in DynamoDB. The normalized observation JSON and evidence image remain in S3.

## API

All routes require the Cognito `labeler` group. IDs are path parameters and must be validated against the run metadata before any response is returned.

| Method and route | Behavior |
|---|---|
| `GET /v1/runs?status=unlabeled&limit=25&cursor=` | Lists completed processing runs that contain at least one unresolved cell. Returns screenshot and run summaries only. |
| `GET /v1/runs/{runId}` | Returns run manifest, normalized tables/cells, current resolutions, and counts by status. |
| `GET /v1/runs/{runId}/image` | Returns a 10-minute signed URL for the original screenshot. It does not return a bucket name or permanent object URL. |
| `POST /v1/cells/{cellObservationId}/adjudications` | Creates one immutable adjudication and updates the resolution projection. |
| `GET /v1/runs/{runId}/training-export` | Starts or returns a generated JSONL training export for the run. It contains only adjudicated `ACCEPTED` and `CORRECTED` cells. |

The label request contains only client-observable review telemetry and the decision:

```json
{
  "decision": "CORRECTED",
  "submittedValue": "19",
  "supersedesAdjudicationId": null,
  "reviewStartedAt": "2026-08-11T12:00:00Z",
  "openedFullImage": false,
  "imageZoomUsed": true
}
```

The API reads `observedText`, `runId`, `screenshotId`, and geometry from S3. It never trusts those values from the browser.

## Reviewer Experience

The reviewer is optimized for a phone held in portrait orientation. It must work at 320 CSS pixels wide with no horizontal page scrolling. The landing page shows a paginated list of runs with unresolved cells. Selecting a run opens a single-column reviewer.

The screenshot occupies the upper portion of the viewport and preserves its aspect ratio. The selected cell geometry is highlighted with a high-contrast overlay. Pinch zoom and pan are required. The reviewer can toggle a full-screen image view without losing the selected cell. The fixed bottom action area contains observed OCR text, field when available, row and column position, confidence, validation flags, decision controls, and correction input. Controls have a minimum 44 by 44 CSS pixel hit area and remain reachable above mobile browser chrome and the on-screen keyboard.

On viewports at least 960 CSS pixels wide, the same controls may use a two-pane layout. Desktop is an enhancement, not a separate workflow.

Keyboard controls are available on hardware keyboards but do not replace touch controls:

| Key | Action |
|---|---|
| `a` | Accept observed OCR text |
| `c` | Focus correction input |
| `u` | Mark unreadable |
| `s` | Skip without label |
| `Enter` | Submit the selected decision |
| `j` / `k` | Next / previous unresolved cell |

The UI disables duplicate submit while a mutation is pending. After success, TanStack Query invalidates the run and queue queries. It does not edit the local OCR observation. A reviewer can replace their own or another reviewer’s resolution only by submitting an explicit superseding adjudication.

## Training Export

The export Lambda reads normalized observations, token observations, validation results, and current resolutions for a run. It writes immutable JSONL at the run export path. It emits one row per accepted or corrected cell:

```ts
type CellTrainingExampleV1 = {
  cellObservationId: string
  runId: string
  screenshotId: string
  image: { artifactId: string; geometry: unknown }
  ocr: { text: string; confidence: number; tokenTexts: string[]; tokenConfidences: number[] }
  parser: { expectedType: string; parseSucceeded: boolean; normalizedText?: string }
  validation: { valid: boolean; flagCodes: string[] }
  domain: { field: string; rowIndex?: number; columnIndex?: number }
  label: { ocrWasCorrect: boolean; groundTruthText: string; adjudicationId: string }
  versions: Record<string, string>
}
```

`UNREADABLE` and `SKIPPED` records remain evidence but are excluded from `CellTrainingExampleV1`. The export process is idempotent for the pair `(runId, resolutionVersion)`. A later superseding adjudication creates a new export object; it never replaces an earlier export.

## Infrastructure and Security

CDK creates the user pool, user-pool client, Cognito domain, API Gateway HTTP API, Lambda functions, DynamoDB tables, CloudFront distribution, and static-site S3 bucket. CloudFront uses Origin Access Control for the static S3 origin and a dedicated API Gateway origin for `/api/*`. It forwards Authorization headers and required query strings only to the API behavior. OpenTofu continues to own the shared evidence bucket and KMS key.

The reviewer API Lambdas receive read access only to evidence artifacts except the adjudication writer. That writer may create objects only under `runs/*/adjudications/*` and `runs/*/exports/training/*`; it cannot update or delete originals, raw Textract output, manifests, normalized observations, or prior adjudications. No browser credentials may access S3 directly.

CloudWatch records request IDs, run IDs, cell IDs, adjudication IDs, and failure codes. It must not log screenshot bytes, OCR text, corrected values, access tokens, or signed URLs. API Gateway enables access logs with the same restriction.

## Failure Handling

The write path uses this order: validate source observation, write immutable S3 adjudication, conditionally insert the event index, then conditionally update the resolution projection. If the final two writes fail, a retry reconciles from the S3 adjudication ID. The operation is idempotent by `adjudicationId`.

If the source image or normalized observation is missing, the API returns `409 EVIDENCE_INCOMPLETE` and writes no label. If the current resolution changed after the reviewer opened the page, the API returns `409 STALE_RESOLUTION` with the current resolution. The UI reloads the cell and requires an explicit superseding decision.

## Acceptance Criteria

- An authenticated labeler can open a completed OCR run, inspect the original screenshot, and label every cell without using an AWS console.
- The reviewer completes accept, correct, unreadable, and skip actions on a 320-pixel-wide phone viewport using touch controls alone.
- The app calls only relative `/api` routes. API Gateway emits no CORS headers, and no workflow depends on a cross-origin request.
- Each accepted image attachment remains independent. The feature never creates or requires a match record.
- A submitted label creates one S3 adjudication object, one append-only event-index item, and one resolution projection.
- Existing OCR evidence remains byte-for-byte unchanged after every label action.
- Reloading a run reconstructs current cell resolutions from the projection and can rebuild them from adjudication events.
- A corrected cell exports `ocrWasCorrect=false`; an accepted cell exports `ocrWasCorrect=true`; unreadable and skipped cells do not appear in the training export.
- Concurrent submissions cannot silently replace a resolution.
- API and browser tests cover authorization, signed-image access, accept, correct, unreadable, skip, supersession, duplicate submission, stale resolution, and training export.
