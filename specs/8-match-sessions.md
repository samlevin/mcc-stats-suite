# Match Sessions and Screenshot Association: Technical Specification

**Status:** Draft; not implemented

**Version:** 1.0-draft (first version)

**Date:** October 15, 2026

**Component:** session routes, the association Lambda and host screens in `applications/admin`; a session upload intake in `applications/match-to-csv` (`process-upload` and a routing state in the main workflow); session, upload, association and map catalog types in `packages/contracts`; the `host` group and upload staging in `infrastructure/modules/foundation`

**Runtime:** TypeScript. Node.js 22 on AWS Lambda (ARM64) behind spec 3's API Gateway HTTP API, and the existing match-to-csv Step Functions workflow; host screens in spec 3's React application

**Deployment:** the existing `admin` and `match-to-csv` CDK stacks, one per stable environment from GitHub Actions plus ephemeral developer stacks, through the guarded wrapper in `scripts/cdk-app.mjs`

**Input:** a host's session actions in the admin application, and the screenshots the host uploads to an ended session

**Persistent state:** append-only session events, upload slots, upload intents, upload receipts, map catalog snapshots and association versions under `sessions/` and `map-catalogs/` in the OpenTofu-owned evidence bucket; uploaded files staged for 30 days in the OpenTofu-owned attachments bucket

**External dependencies at runtime:** CloudFront, API Gateway, Lambda, Cognito, S3, KMS, EventBridge, SQS, Step Functions, SSM Parameter Store

**Out of scope:** the map suggestion ranker ([spec 4](4-map-suggestions.md)), player identity and gamertag resolution (spec 6, #163), choosing one screenshot per match for statistics and every lakehouse table (#159), game variants and score limits, reading OCR content to place a screenshot, associating emailed screenshots with a session, and public access

A host runs a league night in the admin application. The host starts a session, selects each map before it is played, and ends the session afterwards. Then the host uploads the night's postgame scoreboard screenshots to that session. Each screenshot belongs to the session because the host uploaded it there, and the admin application places it in a match by comparing its capture time with the times the host selected each map. The result is a versioned association document that names the `sessionId`, `matchId` and `mapId` of every uploaded screenshot. Match-to-csv runs and the stats lakehouse (#159) join to matches through it.

**Readiness:** this revision authorizes filing Phases 0 to 5. Slices that build on the admin workspace, user pool or stack are blocked by the spec 3 slices named in their **Blocked by** lines. P3.2 cannot merge until P1.2 is applied in dev and prod, and P4.4 until P1.1, P1.2 and spec 2 P1.1 are. The contracts in §5.3 and §10.1 freeze when P0.1 merges. The association parameters in §7.6 are initial values until P5.4 records the first live session. Spec 3 references hold for both its 2.0-draft on `main` and its 2.1-draft (#166, PR #171). Spec 6 is the gamertag roster specification (#163, PR #170) and spec 7 the OCR risk model specification (#165, PR #172); both are unmerged.

---

## 1. Resolved requirement decisions

The issue (#167) states the intended flow: a host starts a session, selects a map, the map is played and a screenshot taken, the host selects the next map or ends the session, and afterwards uploads every screenshot to the session. No earlier spec records matches. Spec 1 §2.2 leaves match records and association out of match-to-csv, spec 3 and spec 7 point match records at #159, and spec 4 assumes a reporter who creates each match after the game.

| Requirement | Decision | Reason |
| --- | --- | --- |
| Who owns match records | The admin application owns sessions, matches and the association of screenshots with them. Its `SessionWrite` Lambda is the only writer of session events, and its `DeriveAssociation` Lambda the only writer of association versions. The stats lakehouse (#159) reads them and never creates a match. This settles the ownership question #159 left open. | The host records a match in the admin application while it happens. A match created later from statistics would have no map and no time. |
| Identifiers | `sessionId`, `matchId` and `uploadId` are `evidenceId()` values (spec 1 §5.1), issued by `SessionWrite`. `mapId` is a slug from the map catalog (the map catalog row below), `<game>-<map slug>`, such as `halo3-guardian`. Every session event has an `eventId` (also `evidenceId()`) and a `sequence` number. | One identifier format across evidence, sortable by creation time. A game prefix keeps map slugs unique when maps from other MCC games join the catalog. |
| What a match is | A match is created by the host's `MAP_SELECTED` event, before the map is played, or by a later `MATCH_ADDED` correction. Each `MAP_SELECTED` creates exactly one match. | The host selects the map before play, so the selection is the earliest record of the match, and its time starts the match's window (§7.3). |
| Where session events live | Each event is one create-only JSON object in the evidence bucket at `sessions/{sessionId}/events/{sequence}.json`. The sequence number is the next free number in the session, and `If-None-Match: *` refuses a second writer of the same number (§6.1). There is no session table. | The evidence bucket already gives immutable, Object Lock protected, append-only storage (spec 1 §5.2). Create-only sequence keys serialize the writers of one session without a new persistent resource. At league scale, listing a session's events is cheap (§18.6). |
| Corrections | A correction is a new event that names the event it supersedes in `supersedesEventId`. `SessionWrite` refuses it with `409 STALE_SUPERSESSION` when that event is not the current one (§6.1). No event is ever changed or deleted. Corrections are allowed while the session is open and after it ends. A correction never moves a match: a match's position comes only from the event that created it (§7.1), and a correction's time is kept for audit. | Every earlier decision stays readable, and two hosts cannot both supersede the same decision. Spec 4's map correction route already requires the prior event ID. Fixing a map label must not reorder the games around it. |
| Spec 4's `MapSelectionEvent` | Not adopted as written. `MAP_SELECTED` carries spec 4's suggestion fields (`suggestionModelVersion`, `suggestedMapIds`, `selectedSuggestionRank`), so spec 4 needs no second event. Spec 4 must change where its match is created, its time field, its sequence number and its routes (§8.2). | Spec 4's event is written after the game, has no session, and needs a global transactional counter. The host selects the map before the game, and the session sequence orders it. |
| The map catalog | A bundled, immutable file in `applications/admin/config/map-catalog-v<n>.json`. v1 holds every Halo 3 multiplayer map MCC offers. A map is never removed or renamed; a later version marks it `selectable: false`. `SessionWrite` writes each catalog version it uses to `map-catalogs/{mapCatalogVersion}.json` create-only, so consumers read map names from evidence. This is spec 4's "predefined map catalog". | Every current capture and parser profile is Halo 3 (spec 7 §4.1, §4.4). A released file pins what a `mapId` meant when it was chosen. |
| How uploads reach match-to-csv | The browser posts each file to the attachments bucket under `uploads/{sessionId}/{uploadId}/original` with a presigned POST (§6.2). The bucket's `Object Created` event starts the existing match-to-csv main workflow, where a new first `Choice` state sends it to a new `ProcessUpload` Lambda instead of `ProcessEmail`. `ProcessUpload` applies spec 1's attachment checks, stores the original as a new submission, and returns the same output, so the same `Map`, `ExtractText` and `WriteExtractedCsv` states run unchanged. Email intake runs beside it, unchanged apart from a `channel` field in its trigger input. | One extraction path means every run is comparable, and spec 2, spec 3 and spec 7 need no change to read uploaded runs. Staging in the attachments bucket, which the foundation reserved for later features (spec 1 §13.1), keeps unchecked bytes out of the Object Lock bucket, as the raw-email bucket does for mail. |
| Which screenshot an upload has when intake runs more than once | Exactly one: the screenshot in the upload's receipt. `ProcessUpload` writes the receipt at a fixed key per upload, `uploads/{uploadId}/receipt.json`, create-only and as its last write, after the submission's completion. Every later intake run for that upload, whether a retry, a restarted execution, a duplicate delivery or a second POST, finds the receipt and returns its screenshot without writing anything (§6.3). | Retries are then never a duplicate. The screenshot the association lists is always the one sent to extraction, even when the attempt that wrote the receipt failed before extraction began. |
| When the host may upload | Only to an ended session. An upload request for an open session is refused with `409 SESSION_OPEN`. | The last match's window ends at `SESSION_ENDED` (§7.3). Uploading after the night also matches the issue's flow. |
| Capture-time sources | In order: EXIF `DateTimeOriginal` with `OffsetTimeOriginal`; EXIF `DateTimeOriginal` without an offset, read in the session's `hostTimeZone`; the browser's `File.lastModified`, corrected for the browser clock's offset from the server. The first usable source wins, and every candidate is recorded (§7.2). | EXIF is written by the capturing device when the image is made. A file time is often the time of the last copy, so it comes last, and a file time equal to the moment the host picked the file is discarded. |
| Upload order | Recorded as `uploadIndex` and used only to order screenshots on host screens. It is never a capture time and never assigns a screenshot. | One missing or extra screenshot would shift every later assignment by one match without any visible sign. |
| A screenshot with no capture time | `UNASSIGNED` with `NO_CAPTURE_TIME`. The host assigns it or excludes it. | Guessing from neighbors fails silently. |
| A device clock that is skewed from the admin application | Session times come from the server clock. Three rules absorb skew: file times are corrected by the browser's measured offset; window edges are shifted 120 seconds late so a screenshot taken just after the next selection still counts for the earlier match; and the host may set one session clock offset with `CLOCK_OFFSET_SET`. The association suggests an offset when one would place screenshots in more matches, and never applies it on its own (§7.5). | Console and phone clocks are set by hand and can be minutes or whole time zones off. A suggestion the host confirms keeps every assignment explainable from events. |
| Two screenshots in one match window | Both are assigned to the match, which is flagged `MULTIPLE_SCREENSHOTS`. A byte-identical image (same SHA-256) is `DUPLICATE` of the earliest upload. | Two pages of one long scoreboard are legitimate (spec 7 `K006`), and so are two captures of the same board. Which screenshot feeds statistics is a lakehouse decision (#159). Two games under one selection are a host error the flag shows (§18.3). |
| A match with no screenshot | The match stays in the association with `screenshotCount: 0` and the flag `NO_SCREENSHOT`. The host may void it if it was never played. | The host recorded the game. A missing screenshot is a fact the lakehouse needs, and deleting the match would hide it. |
| A screenshot outside every match window | `UNASSIGNED` with `BEFORE_FIRST_MATCH`, `BETWEEN_WINDOWS` or `AFTER_SESSION_END`. It is never moved to the nearest match. | A capture outside every window means a clock or a host step is wrong, and the host is the only one who knows which. |
| Inputs to the association | Session events, upload intents and upload receipts only. The association never reads OCR text, parser rows, roster resolutions or `reviewFlags`. | Association then cannot change when OCR or review changes, and the lakehouse join never depends on the data it joins. Checking a map against scoreboard text is backlog (P6.3). |
| How a run joins its match | By `screenshotId`. A run's manifest records its `screenshotId` (spec 1 §5.3), and the association records each screenshot's `matchId` and `mapId`. An uploaded screenshot's `SourceScreenshot` also carries `intake.sessionId`, so a run names its session without the association. The association never names a run. | Every replay of a screenshot is a new run (spec 1 §9.1) and inherits the association with no new record. |
| Association versions | `DeriveAssociation` writes `sessions/{sessionId}/association/{associationVersion}.json` create-only whenever the set of input objects changes. Earlier versions stay. Consumers read the highest version. | The same pattern as spec 3's validated table versions: corrections reach consumers as new versions, and every earlier answer stays reproducible. |
| Who may act on a session | Members of a new Cognito group `host` in spec 3's user pool. Any host may act on any session. Each event records the caller's `sub`. | A league has a few hosts who cover for each other. The record of who did what is enough. |
| Emailed screenshots | Keep running through email intake with no session. They never appear in an association in v1. | Email has no session context. Importing an emailed screenshot into a session is backlog (P6.2). |

**Additional capabilities included:** idempotent session writes through a client request ID, a live association preview on every session read, near-boundary flags for screenshots close to a window edge, map catalog snapshots in evidence, and an operator rebuild of any session's association.

## 2. Goals and non-goals

### 2.1 Goals

1. A host can start a session, select maps, end the session, and upload its screenshots from a phone, and every uploaded screenshot is extracted by the same match-to-csv steps as an emailed one.
2. Every uploaded screenshot that has a usable capture time inside a match window is assigned to that match and map without a host step.
3. Every assignment, refusal and correction is explainable from immutable events and the recorded capture-time candidates.
4. A host can correct any match's map and any screenshot's assignment, and the correction reaches consumers as a new association version.
5. The stats lakehouse can join every run of an uploaded screenshot to its `sessionId`, `matchId` and `mapId` from evidence alone.

### 2.2 Non-goals

- Ranking or suggesting maps. Spec 4 owns that; `MAP_SELECTED` records its fields (§8.2).
- Deciding which screenshot of a match is used for statistics, or merging pages. #159 owns that.
- Recording teams, players, game variants or results on a match. Those come from validated tables (spec 3 §8.4).
- Associating emailed screenshots, or screenshots uploaded to an open session.
- Exactly-once submissions. An intake attempt that fails before writing its upload's receipt leaves a submission with no receipt, which no association lists and no execution extracts. Each upload still has at most one receipt and one screenshot (§6.3, §6.5).
- Real-time screenshot upload during play.

## 3. Runtime architecture

```text
Host browser (spec 3 React application, `host` group)
  |
  v
CloudFront /api/* -> HTTP API (JWT authorizer)
  +-- GET  /v1/sessions..., /v1/map-catalog  -> SessionRead Lambda   (reads evidence, live association preview)
  +-- POST /v1/sessions..., events, uploads  -> SessionWrite Lambda  (session events, upload intents, presigned POSTs)
                                                   |
                                                   v
Evidence bucket (OpenTofu): sessions/{sessionId}/events/, uploads/{uploadId}/intent.json, map-catalogs/
  |
Host browser --presigned POST (10 minutes)--> Attachments bucket (OpenTofu): uploads/{sessionId}/{uploadId}/original
                                                   |
                                                   |  Object Created (EventBridge, enabled by P1.2)
                                                   v
match-to-csv main workflow <stack>
  Route intake (Choice on $.channel)
    +-- EMAIL          -> ProcessEmail (spec 1, unchanged)
    +-- SESSION_UPLOAD -> ProcessUpload: returns the existing receipt's screenshot, or checks, stores the
                          original as a new submission, and writes sessions/{sessionId}/uploads/{uploadId}/receipt.json last
  Process attachments (Map) -> ExtractText -> WriteExtractedCsv   (spec 1, unchanged)

Evidence bucket Object Created under sessions/*/events/, intent.json, receipt.json  (EventBridge, spec 2 P1.1)
  |
  v
admin EventBridge rule -> DeriveAssociation Lambda (reserved concurrency 1) --(failed delivery)--> SQS DLQ
  |
  v
Evidence bucket: sessions/{sessionId}/association/{associationVersion}.json  -->  stats lakehouse (#159)
```

**Ownership rules:** `session-write` owns session events, upload slots, upload intents and map catalog snapshots, and is the only module that signs upload POSTs. `process-upload` in match-to-csv owns upload submissions and upload receipts. `derive-association` owns association versions. `session-read` writes nothing. No admin module writes under `submissions/`, and no match-to-csv module writes under `sessions/` except `process-upload` at `sessions/*/uploads/*/receipt.json`. `session-events`, `capture-time` and `association` are pure and perform no I/O. Only Lambda entry points construct AWS SDK clients; each core function receives an injected dependencies object.

**Packaging:** session, upload, association and map catalog types live in `@mcc/contracts`, because match-to-csv writes receipts and the lakehouse reads associations. The admin Lambdas and pure libraries live in `@mcc/admin` beside spec 3's, and host screens in its `web/` application. `process-upload` lives in `@mcc/match-to-csv`.

**Orchestration decision:** no new state machine. Session writes are synchronous single-object writes. Uploads reuse the match-to-csv main workflow through one `Choice` state. Derivation is one Lambda invocation per input change, serialized by a reserved concurrency of 1 (§6.4).

### 3.1 Execution policy

- One host action is one API request and at most one session event.
- One uploaded file is one upload intent and one staged attachments bucket object, and has at most one receipt. The receipt names the one submission and screenshot the association uses, and every main workflow execution for the upload that reaches extraction extracts that screenshot (§6.3).
- Every evidence write uses `If-None-Match: *`. No handler deletes or overwrites an object.
- Session events are numbered from 1 without gaps. A write that loses the race for a number re-reads the session and retries, up to 3 attempts (§6.1).
- The association is a pure function of the session's input objects and the bundled configuration (§7.6). Deriving it twice from the same inputs gives the same document apart from `derivedAt` and `build`.
- Handlers never read or write outside their namespace (`ephemeral/<name>/` for ephemeral stacks). The namespace comes from the deployment, never from a request.

## 4. Host API and upload interface

### 4.1 Routes

Every route sits behind spec 3's CloudFront `/api/*` behavior and JWT authorizer. Each handler rejects a token whose `cognito:groups` claim lacks `host` with `403 NOT_A_HOST`. `sessionId` and `uploadId` must match spec 3's `evidenceId()` pattern (`^[0-9a-z]+-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$`). Request bodies are JSON of at most 16 KiB.

| Method and path | Lambda | Behavior |
| --- | --- | --- |
| `GET /api/v1/map-catalog` | `SessionRead` | The current catalog version with its selectable maps. |
| `GET /api/v1/sessions?before=<sessionId>&limit=20` | `SessionRead` | Sessions newest first, with `sessionId`, `status`, `startedAt`, `endedAt`, `label` and `matchCount`, and `nextBefore` when more exist. `limit` is 1 to 50. |
| `GET /api/v1/sessions/{sessionId}` | `SessionRead` | Every event, every upload intent and receipt, a live association preview computed with §7, the latest written `associationVersion`, and presigned GET URLs (600 seconds) for each accepted screenshot's `source/original`. |
| `POST /api/v1/sessions` | `SessionWrite` | `{ hostTimeZone, label?, clientRequestId, clientTime }`. Writes `SESSION_STARTED` and returns `201` with the event. |
| `POST /api/v1/sessions/{sessionId}/events` | `SessionWrite` | `{ type, detail, supersedesEventId, clientRequestId, clientTime }` for every type in §4.2 except `SESSION_STARTED`. Returns `201` with the event. |
| `POST /api/v1/sessions/{sessionId}/uploads` | `SessionWrite` | `{ uploadBatchId, clientTime, files: [{ fileName, contentType, sizeBytes, lastModified, uploadIndex }] }` with 1 to 25 files. Writes one intent per file and returns `201` with each `uploadId` and its presigned POST (§6.2). |

A write whose `clientRequestId` already appears in the session returns the earlier event with `200` and writes nothing. An upload request is idempotent per `(uploadBatchId, uploadIndex)`: a repeated pair returns the existing intent with a fresh presigned POST.

### 4.2 Session events

| `type` | `detail` | `supersedesEventId` | Allowed when |
| --- | --- | --- | --- |
| `SESSION_STARTED` | `hostTimeZone` (IANA name), `label` (at most 80 characters, or `null`) | `null` | Through `POST /api/v1/sessions` only. |
| `MAP_SELECTED` | `matchId` (issued by the handler), `mapId`, `mapCatalogVersion`, `suggestionModelVersion`, `suggestedMapIds`, `selectedSuggestionRank` | `null` | The session is open, was started less than `maxOpenHours` ago, and the map is selectable in the current catalog. |
| `SESSION_ENDED` | none | `null` | The session is open. |
| `MAP_CORRECTED` | `matchId`, `mapId`, `mapCatalogVersion` | the match's current map event | The match exists. The map need not be selectable, so an older session can be corrected to a retired map. |
| `MATCH_VOIDED` | `matchId`, `reason` (at most 200 characters, or `null`) | the match's current `MATCH_RESTORED`, or `null` | The match is active. |
| `MATCH_RESTORED` | `matchId` | the match's current `MATCH_VOIDED` | The match is voided. |
| `MATCH_ADDED` | `matchId` (issued by the handler), `mapId`, `mapCatalogVersion`, `afterMatchId` (or `null` for first) | `null` | The session is ended. `afterMatchId`, when set, names a match of the session. |
| `SCREENSHOT_ASSIGNED` | `uploadId`, `matchId` | the upload's current assignment event, or `null` | The upload has an intent, and the match exists and is active. |
| `SCREENSHOT_EXCLUDED` | `uploadId`, `reason` (`NOT_A_SCOREBOARD`, `NOT_FROM_SESSION` or `OTHER`) | the upload's current assignment event, or `null` | The upload has an intent. |
| `SCREENSHOT_ASSIGNMENT_CLEARED` | `uploadId` | the upload's current assignment event | The upload has a current assignment event. |
| `CLOCK_OFFSET_SET` | `offsetSeconds`, an integer from -86,400 to 86,400 | the current `CLOCK_OFFSET_SET`, or `null` | Any time. |

The suggestion fields of `MAP_SELECTED` keep spec 4's meaning, with the type changes listed in §8.2. Until spec 4 ships, the client sends `suggestionModelVersion: null`, `suggestedMapIds: []` and `selectedSuggestionRank: null`. A match's current map event is its `MAP_SELECTED` or `MATCH_ADDED` event, or the latest `MAP_CORRECTED` that superseded it. An upload's current assignment event is the latest `SCREENSHOT_ASSIGNED`, `SCREENSHOT_EXCLUDED` or `SCREENSHOT_ASSIGNMENT_CLEARED` naming it.

### 4.3 Validation and errors

| Condition | Status and code | Writes |
| --- | --- | --- |
| `cognito:groups` lacks `host` | `403 NOT_A_HOST` | nothing |
| Body fails the schema; `hostTimeZone` is not in `Intl.supportedValuesOf('timeZone')`; a time is not ISO 8601 UTC | `400 INVALID_REQUEST` | nothing |
| Unknown `sessionId`, `matchId` or `uploadId` | `404 SESSION_NOT_FOUND`, `404 MATCH_NOT_FOUND`, `404 UPLOAD_NOT_FOUND` | nothing |
| `mapId` not in the named catalog version, or not selectable for `MAP_SELECTED` | `400 UNKNOWN_MAP` | nothing |
| The type is not allowed in the session's state (§4.2) | `409 SESSION_OPEN`, `409 SESSION_ENDED`, `409 SESSION_EXPIRED`, `409 MATCH_VOIDED` or `409 MATCH_ACTIVE` | nothing |
| `supersedesEventId` is not the current event it must name | `409 STALE_SUPERSESSION`, with the current event | nothing |
| The session would exceed `maxMatchesPerSession`, `maxUploadsPerSession` or `maxEventsPerSession` | `409 SESSION_LIMIT` | nothing |
| A file is larger than 10 MiB or its `contentType` is not `image/png` or `image/jpeg` | `400 INVALID_FILE`, naming the file | nothing for any file of the request |
| The sequence write failed with `412` on 3 attempts in a row | `409 CONCURRENT_CHANGE` | nothing |
| Any other storage error after the SDK's retries | `503 UNAVAILABLE` | nothing; the client retries with the same `clientRequestId` |

## 5. Session evidence

### 5.1 Layout

```text
[ephemeral/<name>/]sessions/{sessionId}/
  events/{sequence}.json                          session-event/v1, sequence zero-padded to 6 digits
  upload-slots/{uploadBatchId}-{uploadIndex}.json  upload-slot/v1, claims one uploadId per slot
  uploads/{uploadId}/intent.json                  upload-intent/v1
  uploads/{uploadId}/receipt.json                 upload-receipt/v1 (written by match-to-csv), at most one per upload
  association/{associationVersion}.json           session-association/v1, zero-padded to 10 digits
[ephemeral/<name>/]map-catalogs/{mapCatalogVersion}.json   map-catalog/v1
[ephemeral/<name>/]submissions/{submissionId}/...           spec 1 §5.1, for each accepted or rejected upload

Attachments bucket:
[ephemeral/<name>/]uploads/{sessionId}/{uploadId}/original  staged upload, expires after 30 days
```

### 5.2 Rules

1. Every evidence object above is written once with `If-None-Match: *`. Session events are never updated or deleted, and a correction is always a new event (§1).
2. Event `sequence` numbers in a session start at 1 and have no gaps. `SESSION_STARTED` is always sequence 1.
3. An upload intent exists before its presigned POST is issued, and `process-upload` refuses a staged object without an intent.
4. An upload has at most one receipt, because its key holds no submission or version. `process-upload` writes it after the submission's completion and event, so a receipt always names a submission that finished intake, and the first receipt written for an upload is final.
5. A map catalog snapshot's bytes are the bundled file's bytes, so every writer of a version produces the same object.
6. An association version is written only when its `inputsSha256` differs from the latest version's. Its number is one more than the latest.
7. The staged copy in the attachments bucket is not evidence. The stored original under `submissions/` is, and its SHA-256 is recorded in the receipt.

### 5.3 Document schemas

| Object | `schemaVersion` | Writer | Contents |
| --- | --- | --- | --- |
| `events/{sequence}.json` | `session-event/v1` | `session-write` | `SessionEvent` (§10.1) |
| `upload-slots/{uploadBatchId}-{uploadIndex}.json` | `upload-slot/v1` | `session-write` | `uploadBatchId`, `uploadIndex`, `uploadId`, `createdAt` |
| `uploads/{uploadId}/intent.json` | `upload-intent/v1` | `session-write` | `UploadIntent`: `uploadId`, `sessionId`, `uploadBatchId`, `uploadIndex`, `fileName` (normalized as spec 1 §4.3), `contentType`, `sizeBytes`, `fileLastModified`, `clientTime`, `requestedAt`, `actorSub`, `stagingObject` |
| `uploads/{uploadId}/receipt.json` | `upload-receipt/v1` | `process-upload` | `UploadReceipt`: `sessionId`, `uploadId`, `submissionId`, `stagingObject` with `versionId`, `status` (`ACCEPTED` or `REJECTED`), `rejectionCodes`, `screenshot` (`SourceScreenshot` or `null`), `exif` (`dateTimeOriginal`, `offsetTimeOriginal`, `error`), `receivedAt` |
| `association/{associationVersion}.json` | `session-association/v1` | `derive-association` | `SessionAssociation` (§10.1) |
| `map-catalogs/{mapCatalogVersion}.json` | `map-catalog/v1` | `session-write` | `MapCatalog`: `mapCatalogVersion` and `maps` with `mapId`, `game`, `displayName`, `selectable` |
| upload submission `ingestion.json` | `upload-submission/v1` | `process-upload` | `submissionId`, `channel: SESSION_UPLOAD`, `sessionId`, `uploadId`, `stagingObject` with `versionId`, `receivedAt` |
| `source/metadata.json` | `source-screenshot/v1` | `process-email`, `process-upload` | adds an optional `intake` (`channel`, `sessionId`, `uploadId`); absent on emailed screenshots |

Submission completion, submission events and every run object keep their spec 1 schemas. The one addition is that a `REJECTED` upload completion without an intent carries `error`, which spec 1 sets only on `FAILED` (§6.3 step 4).

### 5.4 Stage versions

| Key | v1 value | Recorded in |
| --- | --- | --- |
| `associationRulesVersion` | `session-association-v1` | every association version |
| `associationConfigVersion` | `association-config-v1` | every association version |
| `mapCatalogVersion` | `map-catalog-v1` | every `MAP_SELECTED`, `MAP_CORRECTED` and `MATCH_ADDED` |
| `uploadIntakeVersion` | `upload-intake-v1` | upload `ingestion.json`; a change to `process-upload` behavior bumps it |

Any change to §7 bumps `associationRulesVersion`. Any change to a §7.6 value adds `association-config-v<n>.json` and bumps `associationConfigVersion`. A bump changes `inputsSha256`, so the next derivation of every session writes a new version (§6.4).

## 6. Processes

### 6.1 Session event write

`writeSessionEvent(request, dependencies)` in `session-write`:

1. Read `sub` and require `host` (§4.3). Validate the body.
2. List `sessions/{sessionId}/events/` and read every event, giving the latest sequence `n`. When an event has the request's `clientRequestId`, return it with `200`.
3. Fold the events (§7.1) and check the request against the folded state (§4.2, §4.3).
4. Build event `n + 1`. `occurredAt` is the handler's clock. Issue `matchId` for `MAP_SELECTED` and `MATCH_ADDED`. When the event names a catalog version with no snapshot yet confirmed in this execution environment, write the snapshot with `If-None-Match: *`, treating `412` as written.
5. Write `events/{n + 1}.json` with `If-None-Match: *`. On `412`, return to step 2, at most 3 attempts in all, then return `409 CONCURRENT_CHANGE`.
6. Log `Session event written` with `sessionId`, `type`, `sequence` and `requestId`, and return `201`.

### 6.2 Upload request

`requestUploads(request, dependencies)` in `session-write`:

1. Validate as §6.1 step 1, read the events, and require an ended session.
2. For each file, write `upload-slots/{uploadBatchId}-{uploadIndex}.json` holding a new `uploadId` with `If-None-Match: *`. On `412`, read the slot and use the `uploadId` it holds, so two concurrent requests for one slot share one upload. Then write that upload's `intent.json` create-only, treating `412` as written.
3. For each intent, create a presigned POST for the attachments bucket key `[ns]uploads/{sessionId}/{uploadId}/original` that expires in 600 seconds, with the conditions `key` equal to that key, `Content-Type` equal to the intent's `contentType`, and `content-length-range` from 1 to the intent's `sizeBytes`.
4. Return the intents and their POSTs. The browser posts each file in `uploadIndex` order, at most 3 at a time.

### 6.3 Upload intake in match-to-csv

The attachments bucket's EventBridge rule (§13.3) starts the main workflow with `{ bucket, key, versionId, channel: "SESSION_UPLOAD" }`. The raw-email rule's input becomes `{ bucket, key, channel: "EMAIL" }`. The new first state, **Route intake**, is a `Choice` on `$.channel`: `SESSION_UPLOAD` goes to **Process upload**, and every other value, including a missing field, goes to **Process email and attachments** (spec 1 §6.1). Both replace the state with a `ProcessEmailOutput`, and the workflow continues at **Process attachments**.

`processUpload(event, dependencies)` performs these steps in order:

1. Parse the key as `[ns]uploads/{sessionId}/{uploadId}/original`, and require that `[ns]` equals the stack's `OBJECT_PREFIX`.
2. Read `[ns]sessions/{sessionId}/uploads/{uploadId}/receipt.json`. When it exists, the upload's intake is already decided: log `Upload already received` with `sessionId`, `uploadId` and the receipt's `submissionId`, and write nothing. An `ACCEPTED` receipt returns `{ submissionId, screenshots: [screenshot], rejectedAttachments: [] }` from the receipt, so this execution extracts the receipt's screenshot. A `REJECTED` receipt throws as step 7 does.
3. Create a `submissionId` and write `ingestion.json` (`upload-submission/v1`).
4. Read `[ns]sessions/{sessionId}/uploads/{uploadId}/intent.json`. When it does not exist, write a `REJECTED` completion with no screenshot, no rejected attachment and `error` `{ name: "UploadIntentMissingError" }`, append `SUBMISSION_REJECTED` with the same `error` in its `detail`, and throw `UploadIntentMissingError`. No source and no receipt are written, because there is no session to write them under.
5. Read the staged object at `versionId`, store its bytes as `screenshots/{screenshotId}/source/original`, and run Sharp metadata and spec 1's attachment checks (§4.3) with the intent's normalized `fileName` as `attachmentName`. Write `source/metadata.json` with `intake`.
6. Read EXIF `DateTimeOriginal` and `OffsetTimeOriginal` from Sharp's `exif` buffer as raw strings. A missing buffer gives `null` for both; an unparseable one records `error` and `null` for both.
7. Write the submission completion and event as spec 1 does, then the receipt with `If-None-Match: *` as the last write. With the image rejected, the receipt is `REJECTED`, and the stage throws after writing it, so the execution fails as a rejected email does.
8. When the receipt write returns `412`, another intake run for the upload wrote its receipt first. Read that receipt and finish as step 2 does. This run's submission keeps its completion but has no receipt, so no association lists it and no execution extracts its screenshot.
9. Return `{ submissionId, screenshots: [source], rejectedAttachments: [] }`.

Errors after step 3 and before the completion is written record `FAILED` and `SUBMISSION_FAILED` on a best-effort basis and rethrow, as spec 1 P2.3 requires of `process-email`. Any other error writing the receipt rethrows. The next intake run for the upload then finds the receipt if the write took effect, and otherwise starts a new submission.

### 6.4 Association derivation

An EventBridge rule in the admin stack matches evidence bucket `Object Created` events whose key matches `[ns]sessions/*/events/*`, `[ns]sessions/*/uploads/*/intent.json` or `[ns]sessions/*/uploads/*/receipt.json`, and invokes `DeriveAssociation` asynchronously with the key. An operator may also invoke it with `{ sessionId }`.

`deriveAssociation(sessionId, dependencies)`:

1. List and read every event, intent and receipt of the session, and load the bundled configuration.
2. Compute `inputsSha256`: the SHA-256 of the input object keys sorted bytewise and joined with `\n`, followed by `\n`, `associationRulesVersion`, `\n` and `associationConfigVersion`.
3. Read the latest association version. When its `inputsSha256` is equal, stop.
4. Run `associate(events, intents, receipts, config)` (§7) and write version `latest + 1` with `If-None-Match: *`. On `412`, return to step 1, at most 3 attempts in all, then throw `ConcurrentAssociationError`.
5. Log `Association written` with `sessionId`, `associationVersion` and the counts in §10.1.

`DeriveAssociation` has a reserved concurrency of 1, so derivations never race in normal operation. Lambda retries a throttled asynchronous event for up to 6 hours and a failed one twice, then sends it to the function's dead-letter queue, `<stack>-association-dlq`. The rule sends events it cannot deliver to the same queue.

### 6.5 Retries and failure

- `SessionWrite` relies on the SDK's default retries and returns `503 UNAVAILABLE` for other storage errors. The client retries with the same `clientRequestId`, so an event written before the response was lost returns with `200`.
- A presigned POST that expires before the browser posts returns `403` from S3. The client repeats the upload request with the same `uploadBatchId` and `uploadIndex` and receives a fresh POST for the same `uploadId`.
- Intake can run more than once for one upload: a Step Functions retry of `ProcessUpload`, an operator restarting a failed execution with the same input, a duplicate EventBridge delivery, or a second POST of the same key within the 600 seconds, which creates a new staged version and a second execution. Each run first reads the upload's receipt (§6.3 step 2). Once the receipt exists, every run returns its screenshot and writes nothing, so a run that follows a failure after the receipt was written extracts the screenshot the association lists. A staged version whose run starts after the receipt exists is never stored.
- A run that fails before the receipt is written leaves its submission with a `FAILED` completion, or a `SUCCEEDED` one when only the receipt write failed, and no receipt. As spec 1 §6.3 does for email, the next run creates a new submission. Two concurrent runs both create submissions, the first receipt write wins, and the other run returns the winner's screenshot (§6.3 step 8). No association lists a submission without a receipt, and no execution extracts its screenshot.
- An execution that fails after its receipt was written, for example when the Lambda's response is lost, leaves an accepted screenshot with no run. An operator recovers it by starting the main workflow again with the execution's input. Intake returns the receipt's screenshot, and extraction runs on it.
- A failed derivation leaves the earlier version as the latest. The next input change, or the operator rebuild, writes the missing version.

## 7. Association rules

`associate(events, intents, receipts, config)` in `src/lib/association.ts` is pure and deterministic.

### 7.1 Folding events into matches

1. Events apply in `sequence` order.
2. `MAP_SELECTED` creates a `LIVE` match with `selectedAt` equal to its `occurredAt` and `liveIndex` equal to the number of `MAP_SELECTED` events so far. `MATCH_ADDED` creates an `ADDED` match with no `selectedAt` and no window.
3. A match's `mapId` and `mapCatalogVersion` come from its current map event (§4.2). Its `status` is `VOIDED` after a `MATCH_VOIDED` that no `MATCH_RESTORED` supersedes, otherwise `ACTIVE`.
4. `matchIndex` is each match's chronological position in the session, 1-based, active and voided matches alike. `LIVE` matches take `liveIndex` order. Each `ADDED` match follows its `afterMatchId` match, and a `null` `afterMatchId` anchors it at the start of the session, before the first `LIVE` match. The `ADDED` matches that share one anchor follow it in the `sequence` order of their `MATCH_ADDED` events, and each of them is followed by the `ADDED` matches anchored on it before the next one starts. `MATCH_ADDED` is refused until the session ends, so every `LIVE` match exists before any `ADDED` match is placed.
5. Only `MAP_SELECTED` and `MATCH_ADDED` place a match. `MAP_CORRECTED`, `MATCH_VOIDED` and `MATCH_RESTORED` never change any match's `matchIndex` or `selectedAt`, whenever they are written, and no event changes the relative order of two existing matches. A correction's `occurredAt` records when the label changed and is used only for audit. An added match moves the matches after it one place later, so `matchIndex` is recomputed in every version and consumers key on `matchId`.
6. `clockOffsetSeconds` is the `offsetSeconds` of the current `CLOCK_OFFSET_SET`, or 0.
7. The session is `OPEN` until `SESSION_ENDED`, then `ENDED` with `endedAt` equal to that event's `occurredAt`.

### 7.2 Capture time

Each accepted screenshot has up to three candidates, evaluated in this order. The first usable candidate is the screenshot's `captureSource` and `capturedAt`.

| Source | Value | Usable when |
| --- | --- | --- |
| `EXIF_WITH_OFFSET` | `dateTimeOriginal` (`YYYY:MM:DD HH:MM:SS`) at `offsetTimeOriginal` (`+HH:MM` or `-HH:MM`) | both parse |
| `EXIF_LOCAL` | `dateTimeOriginal` read as local time in the session's `hostTimeZone`. In a repeated hour the earlier instant is taken; in a skipped hour the time moves forward by the gap. | `dateTimeOriginal` parses and `offsetTimeOriginal` is absent |
| `FILE_LAST_MODIFIED` | the intent's `fileLastModified` plus `browserSkewSeconds`, which is the intent's `requestedAt` minus its `clientTime` | `fileLastModified` is set and the corrected value is more than `pickTimeSeconds` before `requestedAt`. A value closer than that is the moment the browser read the file, which some mobile browsers report, and is discarded with `PICK_TIME`. |

`effectiveAt` is `capturedAt` plus `clockOffsetSeconds`. A screenshot with no usable candidate has `effectiveAt: null`. Every candidate is recorded with its raw value, its instant and why it was unusable (`MISSING`, `UNPARSEABLE` or `PICK_TIME`).

### 7.3 Match windows

Let the active and voided `LIVE` matches in `liveIndex` order be `1` to `n`, `g` be `boundaryShiftSeconds` and `cap` be `maxMatchWindowSeconds`. Match `k`'s window is the half-open interval `[start_k, end_k)`:

- `start_k = selectedAt_k + g`
- `end_k = min(next_k + g, selectedAt_k + cap)`, where `next_k` is `selectedAt_(k+1)`, or `endedAt` for the last match. While the session is open, the last match has no `next_k` and `end_n = selectedAt_n + cap`.

The shift `g` credits a screenshot taken just after the host selected the next map to the earlier match, and keeps a screenshot within `g` of a selection out of the new match, which cannot have finished yet. The cap makes a gap after a window that ran long, which is usually a forgotten selection (§18.3). `ADDED` matches have no window and receive screenshots only by `SCREENSHOT_ASSIGNED`.

### 7.4 Assignment

An upload has at most one receipt (§5.2), and when that receipt is `ACCEPTED`, its screenshot is the upload's screenshot. Intake retries never add a screenshot (§6.5), so `DUPLICATE` means only a repeated image: a screenshot whose `sha256` equals that of the screenshot of an earlier `uploadId` in the session is `DUPLICATE` of it, with `duplicateOf` set to that screenshot. A `DUPLICATE` screenshot carries the `matchId` and `mapId` of the screenshot it duplicates.

Every other accepted screenshot takes the first matching row:

| Condition | `status` | `matchId` | `reason` |
| --- | --- | --- | --- |
| The upload's current assignment event is `SCREENSHOT_EXCLUDED` | `EXCLUDED` | `null` | the event's reason |
| It is `SCREENSHOT_ASSIGNED` and the match is `ACTIVE` | `HOST_ASSIGNED` | the event's match | `null` |
| It is `SCREENSHOT_ASSIGNED` and the match is `VOIDED` | `UNASSIGNED` | `null` | `MATCH_VOIDED` |
| `effectiveAt` is `null` | `UNASSIGNED` | `null` | `NO_CAPTURE_TIME` |
| The session has no `LIVE` match | `UNASSIGNED` | `null` | `NO_MATCHES` |
| `effectiveAt` is in match `k`'s window and `k` is `ACTIVE` | `DERIVED` | match `k` | `null` |
| `effectiveAt` is in match `k`'s window and `k` is `VOIDED` | `UNASSIGNED` | `null` | `MATCH_VOIDED` |
| `effectiveAt` is before `start_1` | `UNASSIGNED` | `null` | `BEFORE_FIRST_MATCH` |
| The session is ended and `effectiveAt` is at or after `endedAt + g` | `UNASSIGNED` | `null` | `AFTER_SESSION_END` |
| otherwise, including a time after a capped last window but before `endedAt + g` | `UNASSIGNED` | `null` | `BETWEEN_WINDOWS` |

A `DERIVED` screenshot is `nearBoundary` when `effectiveAt` is within `boundaryMarginSeconds` of either edge of its window. Every assigned screenshot records its match's `mapId`. Uploads without an `ACCEPTED` receipt appear in `uploads` as `PENDING` (no receipt) or `REJECTED` with the receipt's codes, and their `screenshotId` is `null`. The association does not decide that a pending upload is lost, because that would depend on the clock at derivation time.

A match records `screenshotIds` (`DERIVED` and `HOST_ASSIGNED` screenshots, by `uploadIndex` and then `uploadId`), `screenshotCount`, and the flags `NO_SCREENSHOT` (count 0) and `MULTIPLE_SCREENSHOTS` (count 2 or more). `DUPLICATE` screenshots are not counted.

### 7.5 Clock offset suggestion

When the session is ended and has at least one `LIVE` match and two screenshots with a capture time, the association computes `suggestedClockOffsetSeconds`. For each candidate offset `d` from -50,400 to 50,400 seconds in steps of 60, it re-runs §7.4 for screenshots without a current assignment event, with `effectiveAt = capturedAt + d`. The best `d` covers the most distinct active `LIVE` matches. Ties go, in order, to the most screenshots inside windows; to a whole multiple of 900 seconds, because time-zone errors are whole quarter hours; to the largest smallest distance from a placed screenshot to an edge of its window, which centers `d` in the range of offsets that place the same screenshots; to the smallest `|d - clockOffsetSeconds|`; and to the smaller `d`. The suggestion is set only when the best `d` covers more matches than the current offset does, otherwise it is `null`. It never changes an assignment. The host applies it with `CLOCK_OFFSET_SET`.

### 7.6 Parameters

`association-config-v1.json` is bundled with the admin Lambdas, immutable once released, and validated at cold start.

| Parameter | v1 value | Notes |
| --- | --- | --- |
| `boundaryShiftSeconds` | 120 | `g` in §7.3. |
| `maxMatchWindowSeconds` | 5,400 | `cap` in §7.3. A Halo 3 Slayer game plus its postgame fits well inside 90 minutes. |
| `boundaryMarginSeconds` | 60 | Near-boundary flag. |
| `pickTimeSeconds` | 120 | §7.2. |
| `maxOpenHours` | 24 | §4.2. A session open longer can only be ended. |
| `maxMatchesPerSession` | 100 | |
| `maxUploadsPerSession` | 300 | |
| `maxEventsPerSession` | 2,000 | |

These are initial values. P5.4 records a live session's assignments and the host's corrections, and a change is a new configuration version filed as its own issue.

## 8. Contract for consumers and relationship with other specs

### 8.1 The match association contract

The admin application owns the contract, and `@mcc/contracts` exports its types (§10.1). Consumers read three kinds of evidence object, all create-only:

| Object | Consumers use it for |
| --- | --- |
| `sessions/{sessionId}/association/{associationVersion}.json` | The current `sessionId`, `matchId`, `mapId`, `status` and `matchIndex` of every uploaded screenshot, and every match with its screenshots. Read the highest version per session. |
| `sessions/{sessionId}/events/{sequence}.json` | Audit, and spec 4's map selection history (§8.2). |
| `map-catalogs/{mapCatalogVersion}.json` | Map names and games for a `mapId`. |

A run joins its match in two steps. Its manifest's `screenshotId` (spec 1 §5.3), or a validated table's `screenshotId` (spec 3 §8.5), selects the screenshot entry in the latest association of its session. Its session is `inputArtifact.intake.sessionId` in the manifest, or `intake.sessionId` in `source/metadata.json`. A screenshot whose source has no `intake` came by email and has no session. A screenshot that the latest association lists as `UNASSIGNED` or `EXCLUDED` has no match. A consumer must treat an uploaded screenshot that no association lists yet as unassigned, because derivation runs after the receipt is written.

The contract guarantees three things about what an association lists:

- **One screenshot per upload, and it is the extracted one.** An association lists at most one screenshot per upload, the one in the upload's receipt. Every main workflow execution for the upload that reaches extraction extracts that screenshot, including one that retries or restarts intake after an earlier attempt failed (§6.3, §6.5). A submission left without a receipt by a failed or losing intake attempt is never listed and never extracted, and consumers ignore it as they ignore any screenshot no association lists.
- **`DUPLICATE` means a repeated image, never a retry.** A `DUPLICATE` is the screenshot of a later upload whose bytes equal those of an earlier upload's screenshot in the session (§7.4). It carries the `matchId` of the screenshot it repeats and names it in `duplicateOf`. Matches do not count it, and consumers should not either.
- **`matchIndex` is the match's chronological position.** A map correction, a void or a restore never changes any `matchIndex` or `selectedAt`, and no event changes the relative order of two existing matches. Only `MATCH_ADDED` inserts a match, at the deterministic place §7.1 defines, and moves the later matches one place on.

The lakehouse (#159) ingests every association version, as it does every validated table version, and selects the latest per session in silver. A correction reaches it as a new version. Choosing one screenshot per match, and what to do with `MULTIPLE_SCREENSHOTS` and `NO_SCREENSHOT` matches, is the lakehouse's decision.

### 8.2 Spec 4

Spec 4 assumed a reporter who creates a match after the game. This spec records the host's selection before the game instead, and keeps every field spec 4's ranker needs. Spec 4 must make these changes in its next revision. This spec does not edit it.

| Spec 4 today | Change |
| --- | --- |
| "When a game ends, the reporter creates a match record and selects the map that was just played." | The host selects the map before the game in a session, and that selection creates the match (§1). "Reporter" becomes "host", and the match-entry form becomes the session's map selection screen. |
| `MapSelectionEvent` (`map-selection-event/v1`) | Replaced by `MAP_SELECTED`, `MAP_CORRECTED` and `MATCH_ADDED` session events. `eventId`, `matchId`, `mapId`, `suggestionModelVersion`, `suggestedMapIds` and `selectedSuggestionRank` keep their meaning. |
| `suggestionModelVersion: string`, `selectedSuggestionRank?: number` | `suggestionModelVersion: string \| null`, `null` when no suggestion was shown, including before spec 4 ships. `selectedSuggestionRank: number \| null`, always present. |
| `concludedAt` | The match's `selectedAt`, the `occurredAt` of its `MAP_SELECTED` event, which is when the map was selected, before play. An `ADDED` match has no `selectedAt`. A `MAP_CORRECTED` event's `occurredAt` records when the label changed, for audit, and never times or orders a label. |
| `sequenceNumber`, a global counter assigned transactionally | Removed. Spec 4 orders matches, not map events: sessions by `(startedAt, sessionId)`, and the matches of a session by the `matchIndex` of §7.1, which only `MAP_SELECTED` and `MATCH_ADDED` set. A correction therefore changes a match's label and never its position, and an `ADDED` match sits after its anchor as §7.1 places it. `previousMapIds` comes from that order, and spec 4 decides whether history crosses sessions. |
| "Every confirmed match creates one immutable `MapSelectionEvent`" | Every `ACTIVE` match is one training label at its position: the `mapId` of the match's current map event. Voided matches are excluded, and excluding one never reorders the others. |
| `POST /v1/matches` | `POST /api/v1/sessions/{sessionId}/events` with `MAP_SELECTED`. The match and its selection are one event, so the atomicity spec 4's integration test checks holds by construction. |
| `POST /v1/matches/{matchId}/map-corrections` | The same route with `MAP_CORRECTED`, whose `supersedesEventId` is spec 4's required prior event ID. |
| `GET /v1/maps/suggestions` | Kept, under `/api/v1/` on the admin API, for the `host` group. The map selection screen calls it once spec 4 ships, and falls back to the full catalog. Its `basedOnSequenceNumber` becomes `basedOnEventId`, the `eventId` of the latest effective map event the ranker read. |
| "the predefined map catalog", examples `guardian`, `the-pit` | The map catalog decided in §1, with IDs such as `halo3-guardian` and `halo3-the-pit`. |
| An operational DynamoDB projection of events | Spec 4 builds its own projection from session events if it needs one. This spec writes none. |

Spec 4's rule that training never reads a screenshot's associated map holds: the association never changes a map event (§7).

### 8.3 Spec 1

Match-to-csv still creates no match and associates nothing (spec 1 §2.2). It gains a second intake channel. P3.1 and P3.2 update spec 1 in the same PR as the behavior: §1 and §2.1 (session upload beside email), §3 and §6.1 (the **Route intake** state and the upload rule), §4 (a new subsection for upload intake), §5.1 and §5.3 (`upload-submission/v1`, `upload-receipt/v1`, and `intake` on `source-screenshot/v1` and in the run manifest's `inputArtifact`), §6.3 (a retried upload intake returns the upload's receipt instead of creating a second screenshot), §10.1 (`SourceScreenshot.intake`, `ProcessUploadInput`), §11, §13.1 (attachments bucket notifications, CORS and `uploads/` expiry), §13.2 and §13.4 (`ProcessUpload`), and §16.1. The statement in spec 1 §13.1 that objects outside `ephemeral/` never expire stops being true for the attachments bucket's `uploads/` prefix.

### 8.4 Spec 7

Spec 7 groups runs for its cross-run constraints without a match: `K006_PAGE_AGREEMENT` pairs screenshots of one submission, and `K007_SUBMISSION_AGREEMENT` pairs runs with the same `gameKey` within 7 days (spec 7 §4.3), until "#159 defines a match ID". This spec defines it. Each uploaded file is its own submission, so `K006` as written never pairs two pages uploaded to a session. Spec 7 should, in its next revision:

- treat two screenshots with the same `matchId` in the latest association as `K006` candidates, in addition to screenshots of one submission;
- use a shared `matchId` only to narrow `K007` candidates for uploaded screenshots, in place of the 7-day window, and keep `K007`'s equal-player-set test (`gameKey`), so two pages of one board, whose player sets differ, are `K006` candidates and never `K007` pairs; emailed screenshots keep the `gameKey` window;
- add `matchId` to its dataset grouping beside `gameKey` (spec 7 §8.1);
- read the association at evaluation time and record `NOT_EVALUATED` when it does not list the screenshot yet, which its `NO_PEER` rule already allows.

### 8.5 Spec 3, spec 6 and #169

- **Spec 3.** The host screens and session routes live in spec 3's application, API and stack. Spec 3's next revision lists the `host` group beside `labeler`, adds the attachments bucket's regional endpoint to the Content Security Policy's `connect-src` (spec 3 §13.3), and moves "match records" out of its out-of-scope line to this spec. Validated tables already carry `screenshotId` and `submissionId` (spec 3 §8.5), so the join needs no change to them. Review does not depend on association, and association does not depend on review.
- **Spec 6.** The roster resolves names per run and has no match entity (spec 6 §1). Its non-goal "grouping screenshots into matches (#159)" should point to this spec in its next revision. The association records no gamertag, and player identity across a match's screenshots stays with spec 6 and #159.
- **#169.** `reviewFlags` describe readings and stay on parser rows. The association never reads them (§1).

### 8.6 Recorded dependencies

This spec edits no other spec. The slice named in each row records the change in the spec it touches when it merges, or the owning spec's next revision does.

| Dependency | Owner | Handled by |
| --- | --- | --- |
| Admin workspace and web scaffold; the admin stack, HTTP API and distribution | spec 3 P0.1, P3.4 | P0.2, P2.1, P2.2 and P4.1 are blocked by P0.1, and P4.4 by P3.4. |
| Reviewer user pool, to which P1.1 adds `host` | spec 3 P1.1 | P1.1 is blocked by it. |
| Local bootstrap permissions for `admin-e-*` stacks | spec 3 P1.2 | P4.4 adds the session statements; whichever merges later keeps the other's. |
| Sign-in and the application shell | spec 3 P4.1 | P5.1 is blocked by it. |
| Content Security Policy `connect-src` for the attachments bucket | spec 3 §13.3 | P4.4 sets it; spec 3's next revision records it. |
| Evidence bucket EventBridge notifications | spec 2 P1.1 | P4.4 cannot deploy until it is applied. |
| Spec 1 sections in §8.3 | spec 1 | P3.1 and P3.2. |
| Spec 4 changes in §8.2 | spec 4 | Spec 4's next revision, before any spec 4 slice is filed. |
| Spec 7 grouping by `matchId` (§8.4) | spec 7 | Spec 7's next revision. |
| Spec 6 non-goal pointer (§8.5) | spec 6 | Spec 6's next revision. |
| Match records owned by the admin application | #159 | #159's specification reads §8.1 as its match input. |

## 9. Host experience

The host screens are routes in spec 3's application, shown to users in the `host` group, and laid out for a phone held in portrait.

- **Sessions.** A list newest first, and a button that starts a session with the browser's `Intl.DateTimeFormat().resolvedOptions().timeZone` and an optional label.
- **Live session.** The current match's map and selection time, a map picker with search over the catalog (spec 4's suggestions first once it ships, never preselected), and an **End session** button that asks for confirmation. The screen re-reads the session after every write and shows `STALE_SUPERSESSION` and `CONCURRENT_CHANGE` as "someone else changed this session".
- **Upload.** Opens on an ended session. The host picks any number of files. The screen requests intents in batches of 25, posts the files, and shows each file's state until its receipt appears.
- **Review.** Matches in `matchIndex` order with their map and thumbnails, flagged `NO_SCREENSHOT`, `MULTIPLE_SCREENSHOTS` and near-boundary screenshots, and a tray of `UNASSIGNED` screenshots with their reasons and capture-time candidates. Actions: assign, exclude, clear an assignment, correct a map, void or restore a match, add a match, and apply the suggested clock offset. Each action writes one event (§4.2).

## 10. Typed domain model

### 10.1 Shared contracts

`@mcc/contracts` exports:

```typescript
type IntakeChannel = 'EMAIL' | 'SESSION_UPLOAD';

interface ScreenshotIntake {
  channel: IntakeChannel;
  sessionId?: string; // SESSION_UPLOAD only
  uploadId?: string; // SESSION_UPLOAD only
}

// Added to spec 1's SourceScreenshot as an optional field.
interface SourceScreenshot { /* spec 1 fields */ intake?: ScreenshotIntake }

interface ProcessUploadInput extends S3ObjectReference {
  versionId: string;
  channel: 'SESSION_UPLOAD';
}

type GameCode = 'halo3';

interface MapCatalogEntry {
  mapId: string; // ^halo3-[a-z0-9]+(-[a-z0-9]+)*$, at most 48 characters
  game: GameCode;
  displayName: string;
  selectable: boolean;
}

interface MapCatalog {
  schemaVersion: 'map-catalog/v1';
  mapCatalogVersion: string; // map-catalog-v1
  maps: readonly MapCatalogEntry[];
}

type SessionEventType =
  | 'SESSION_STARTED' | 'MAP_SELECTED' | 'SESSION_ENDED'
  | 'MAP_CORRECTED' | 'MATCH_VOIDED' | 'MATCH_RESTORED' | 'MATCH_ADDED'
  | 'SCREENSHOT_ASSIGNED' | 'SCREENSHOT_EXCLUDED' | 'SCREENSHOT_ASSIGNMENT_CLEARED'
  | 'CLOCK_OFFSET_SET';

type ExclusionReason = 'NOT_A_SCOREBOARD' | 'NOT_FROM_SESSION' | 'OTHER';

interface SessionEventDetails {
  SESSION_STARTED: { hostTimeZone: string; label: string | null };
  MAP_SELECTED: {
    matchId: string; mapId: string; mapCatalogVersion: string;
    suggestionModelVersion: string | null; suggestedMapIds: string[];
    selectedSuggestionRank: number | null;
  };
  SESSION_ENDED: Record<string, never>;
  MAP_CORRECTED: { matchId: string; mapId: string; mapCatalogVersion: string };
  MATCH_VOIDED: { matchId: string; reason: string | null };
  MATCH_RESTORED: { matchId: string };
  MATCH_ADDED: { matchId: string; mapId: string; mapCatalogVersion: string; afterMatchId: string | null };
  SCREENSHOT_ASSIGNED: { uploadId: string; matchId: string };
  SCREENSHOT_EXCLUDED: { uploadId: string; reason: ExclusionReason };
  SCREENSHOT_ASSIGNMENT_CLEARED: { uploadId: string };
  CLOCK_OFFSET_SET: { offsetSeconds: number };
}

type SessionEvent = {
  [T in SessionEventType]: {
    schemaVersion: 'session-event/v1';
    eventId: string;
    sessionId: string;
    sequence: number; // 1-based, no gaps
    type: T;
    occurredAt: string; // server clock, ISO 8601 UTC with milliseconds
    actorSub: string; // Cognito sub
    clientRequestId: string; // UUID
    clientTime: string | null; // browser clock when the request was sent
    supersedesEventId: string | null;
    detail: SessionEventDetails[T];
    build: { gitSha: string; environment: string };
  };
}[SessionEventType];

interface UploadIntent {
  schemaVersion: 'upload-intent/v1';
  uploadId: string;
  sessionId: string;
  uploadBatchId: string; // UUID from the client
  uploadIndex: number; // 0-based position in the host's selection
  fileName: string;
  contentType: 'image/png' | 'image/jpeg';
  sizeBytes: number;
  fileLastModified: string | null;
  clientTime: string;
  requestedAt: string;
  actorSub: string;
  stagingObject: S3ObjectReference;
}

interface UploadReceipt {
  schemaVersion: 'upload-receipt/v1';
  sessionId: string;
  uploadId: string;
  submissionId: string;
  stagingObject: S3ObjectReference & { versionId: string };
  status: 'ACCEPTED' | 'REJECTED';
  rejectionCodes: AttachmentRejectionCode[];
  screenshot: SourceScreenshot | null; // set for ACCEPTED
  exif: { dateTimeOriginal: string | null; offsetTimeOriginal: string | null; error: string | null };
  receivedAt: string;
}

type CaptureSource = 'EXIF_WITH_OFFSET' | 'EXIF_LOCAL' | 'FILE_LAST_MODIFIED';

interface CaptureCandidate {
  source: CaptureSource;
  raw: string | null;
  instant: string | null;
  unusableReason: 'MISSING' | 'UNPARSEABLE' | 'PICK_TIME' | null;
}

type ScreenshotAssociationStatus = 'DERIVED' | 'HOST_ASSIGNED' | 'UNASSIGNED' | 'EXCLUDED' | 'DUPLICATE';

type UnassignedReason =
  | 'NO_CAPTURE_TIME' | 'NO_MATCHES' | 'MATCH_VOIDED'
  | 'BEFORE_FIRST_MATCH' | 'BETWEEN_WINDOWS' | 'AFTER_SESSION_END';

interface AssociatedScreenshot {
  screenshotId: string;
  submissionId: string;
  uploadId: string;
  uploadIndex: number;
  imageSha256: string;
  status: ScreenshotAssociationStatus;
  matchId: string | null;
  mapId: string | null;
  reason: UnassignedReason | ExclusionReason | null;
  duplicateOf: string | null; // screenshotId
  assignmentEventId: string | null;
  captureSource: CaptureSource | null;
  capturedAt: string | null;
  effectiveAt: string | null;
  nearBoundary: boolean;
  candidates: CaptureCandidate[];
}

interface AssociatedMatch {
  matchId: string;
  matchIndex: number; // 1-based chronological position (§7.1); corrections never change it
  origin: 'LIVE' | 'ADDED';
  status: 'ACTIVE' | 'VOIDED';
  mapId: string;
  mapCatalogVersion: string;
  mapEventId: string; // the current map event
  selectedAt: string | null; // LIVE only
  window: { start: string; end: string } | null;
  screenshotIds: string[];
  screenshotCount: number;
  flags: ('NO_SCREENSHOT' | 'MULTIPLE_SCREENSHOTS')[];
}

interface AssociatedUpload {
  uploadId: string;
  uploadIndex: number;
  state: 'PENDING' | 'REJECTED' | 'ACCEPTED';
  rejectionCodes: AttachmentRejectionCode[];
  screenshotId: string | null; // the receipt's screenshot when ACCEPTED; an upload has at most one receipt
}

interface SessionAssociation {
  schemaVersion: 'session-association/v1';
  sessionId: string;
  associationVersion: number;
  previousAssociationVersion: number | null;
  inputsSha256: string;
  eventsThroughSequence: number;
  derivedAt: string;
  versions: { associationRulesVersion: string; associationConfigVersion: string };
  session: {
    status: 'OPEN' | 'ENDED';
    startedAt: string;
    endedAt: string | null;
    hostTimeZone: string;
    clockOffsetSeconds: number;
    suggestedClockOffsetSeconds: number | null;
  };
  matches: AssociatedMatch[]; // matchIndex order
  screenshots: AssociatedScreenshot[]; // uploadIndex, then uploadId order; one per accepted upload
  uploads: AssociatedUpload[];
  counts: {
    matches: number; voidedMatches: number; uploads: number; pendingUploads: number;
    rejectedUploads: number; derived: number; hostAssigned: number; unassigned: number;
    excluded: number; duplicate: number;
  };
  build: { gitSha: string; environment: string };
}
```

Handlers validate every request and every object they read against these types with schema validators at the trust boundary. A `SessionEvent`, intent or association never holds an email address, a file path from the host's device, or image bytes.

### 10.2 Relationships

```text
Session 1 -> many SessionEvent (sequence 1..n)
Session 1 -> many Match (LIVE from MAP_SELECTED, ADDED from MATCH_ADDED)
Match 1 -> 1 current map event -> 1 mapId in 1 map catalog version
Session 1 -> many UploadIntent -> 0..1 UploadReceipt -> 0..1 SourceScreenshot
SourceScreenshot 1 -> many processing runs (spec 1)
Session 1 -> many SessionAssociation versions; the latest is current
SessionAssociation 1 -> many AssociatedScreenshot -> 0..1 Match
```

## 11. Module and function catalog

### 11.1 Lambda entry points

| File | Public functions | Purpose |
| --- | --- | --- |
| `applications/admin/src/lambdas/session-read.ts` | `handler(event)`; `readSession(request, dependencies)`; `listSessions(request, dependencies)`; `readMapCatalog()` | Read routes in §4.1, with the live association preview. |
| `applications/admin/src/lambdas/session-write.ts` | `handler(event)`; `startSession(...)`; `writeSessionEvent(...)`; `requestUploads(...)` | §6.1 and §6.2. |
| `applications/admin/src/lambdas/derive-association.ts` | `handler(event)`; `deriveAssociation(sessionId, dependencies)` | §6.4. |
| `applications/match-to-csv/src/lambdas/process-upload.ts` | `handler(event)`; `processUpload(event, dependencies)` | §6.3. |

### 11.2 Libraries

| File | Public functions | Purpose |
| --- | --- | --- |
| `applications/admin/src/lib/session-events.ts` | `foldSession(events)`; `checkSessionEvent(state, request)` | Pure fold (§7.1) and the rules in §4.2 and §4.3. |
| `applications/admin/src/lib/capture-time.ts` | `captureCandidates(intent, receipt, hostTimeZone, config)`; `resolveCaptureTime(candidates)` | Pure §7.2. |
| `applications/admin/src/lib/association.ts` | `associate(events, intents, receipts, config)`; `matchWindows(state, config)`; `suggestClockOffset(...)`; `associationInputsSha256(keys, versions)` | Pure §7.3 to §7.5. |
| `applications/admin/src/lib/session-store.ts` | `listEvents`, `putEvent`, `listUploads`, `putIntent`, `latestAssociation`, `putAssociation`, `putCatalogSnapshot` | Evidence keys and create-only writes for sessions. |
| `applications/admin/src/lib/upload-post.ts` | `presignUpload(intent, dependencies)` | Presigned POST with the §6.2 conditions. |
| `applications/admin/src/lib/map-catalog.ts` | `loadMapCatalog(version?)` | Loads and validates bundled catalogs. |
| `applications/match-to-csv/src/lib/image-acceptance.ts` | `attachmentRejectionCodes(...)` | Moved from `process-email.ts` unchanged, so both intake Lambdas share it. |
| `applications/match-to-csv/src/lib/exif.ts` | `readCaptureExif(exifBuffer)` | Raw `DateTimeOriginal` and `OffsetTimeOriginal` strings. |

### 11.3 Web application

| Path | Purpose |
| --- | --- |
| `applications/admin/web/src/sessions/` | The four screens in §9, the upload queue, and the session API client. |

### 11.4 Infrastructure code

| File | Change | Purpose |
| --- | --- | --- |
| `infrastructure/modules/foundation/cognito.tf` | `host` group | §13.2. |
| `infrastructure/modules/foundation/main.tf` | attachments bucket notifications, CORS and `uploads/` lifecycle | §13.2. |
| `applications/admin/cdk/lib/admin-stack.ts` | session Lambdas, routes, rule, DLQ, IAM | §13.3, §13.4. |
| `applications/match-to-csv/cdk/lib/match-to-csv-stack.ts` | `ProcessUpload`, **Route intake**, upload rule, IAM | §13.3, §13.4. |

## 12. Directory structure and ownership

```text
mcc-stats-suite/
  applications/admin/
    config/
      map-catalog-v1.json            # Bundled, immutable once released
      association-config-v1.json     # Bundled, immutable once released
    src/
      lambdas/{session-read,session-write,derive-association}.ts
      lib/{session-events,capture-time,association,session-store,upload-post,map-catalog}.ts
    test/
      sessions/*.test.ts
      fixtures/sessions/*.fixture.json   # Event, intent and receipt sets with expected associations
    web/src/sessions/
  applications/match-to-csv/
    src/lambdas/process-upload.ts
    src/lib/{image-acceptance,exif}.ts
  packages/contracts/src/index.ts    # §10.1
  infrastructure/modules/foundation/{cognito,main}.tf
```

`admin` keeps spec 3's import rule: only `@mcc/contracts` and `@mcc/cdk-config` from the monorepo, plus `@mcc/roster` if spec 6 merges first. `process-upload` reads admin's intents through `@mcc/contracts` types and imports nothing from `admin`. `web/` imports only `@mcc/contracts` types.

## 13. Configuration and infrastructure

### 13.1 Configuration schema

```json
{
  "associationConfigVersion": "association-config-v1",
  "boundaryShiftSeconds": 120,
  "maxMatchWindowSeconds": 5400,
  "boundaryMarginSeconds": 60,
  "pickTimeSeconds": 120,
  "maxOpenHours": 24,
  "maxMatchesPerSession": 100,
  "maxUploadsPerSession": 300,
  "maxEventsPerSession": 2000
}
```

`loadAssociationConfig` validates every key at cold start: every value is a positive integer, `boundaryMarginSeconds` is below `boundaryShiftSeconds`, and `boundaryShiftSeconds` is below `maxMatchWindowSeconds`. It throws `InvalidAssociationConfigError` on any problem. The map catalog is validated the same way: unique `mapId` values matching the pattern in §10.1, and at least one selectable map. Neither file holds a secret.

### 13.2 Persistent resources

| Resource | Owner | Configuration |
| --- | --- | --- |
| Evidence bucket, KMS data key | OpenTofu foundation | Existing (spec 1 §13.1), with EventBridge notifications from spec 2 P1.1. |
| Cognito group `host` | OpenTofu foundation (P1.1) | On spec 3's user pool. Operators add hosts with the Cognito console or CLI. |
| Attachments bucket | OpenTofu foundation (P1.2) | Existing. P1.2 turns on EventBridge notifications; adds a CORS rule allowing `POST` from any origin with no exposed headers and a 3,000-second max age; and adds a lifecycle rule that expires `uploads/` objects after 30 days and their noncurrent versions after 1 day. Ephemeral `ephemeral/<name>/uploads/` objects already expire under the `ephemeral/` rule. |
| SSM parameters | OpenTofu foundation | Existing. Both stacks read `/mcc/<env>/match-to-csv/attachments-bucket-name`. |

The foundation knows nothing about either stack. The CORS rule names no CloudFront domain, because the presigned policy, not the origin, authorizes each POST (§14).

### 13.3 Application resources

| Resource | Stack | Configuration |
| --- | --- | --- |
| `SessionRead` | admin | Node.js 22, ARM64, 1,024 MB, 10-second timeout, X-Ray, env `EVIDENCE_BUCKET`, `OBJECT_PREFIX` |
| `SessionWrite` | admin | Node.js 22, ARM64, 1,024 MB, 25-second timeout, X-Ray, env as `SessionRead` plus `ATTACHMENTS_BUCKET`, `GIT_SHA`, `DEPLOYMENT_ENVIRONMENT` |
| `DeriveAssociation` | admin | Node.js 22, ARM64, 1,024 MB, 1-minute timeout, reserved concurrency 1, two asynchronous retries, maximum event age 6 hours, X-Ray, env as `SessionRead` plus `GIT_SHA`, `DEPLOYMENT_ENVIRONMENT` |
| HTTP API routes | admin | §4.1, on spec 3's API and authorizer |
| Association rule and DLQ | admin | Evidence bucket `Object Created` with the three key patterns in §6.4 under the stack's namespace. The rule's failed deliveries and `DeriveAssociation`'s failed asynchronous events go to `<stack>-association-dlq` (SQS-managed encryption, 14 days). |
| Content Security Policy | admin | spec 3's policy with the attachments bucket's regional endpoint added to `connect-src` |
| `ProcessUpload` | match-to-csv | 1,024 MB, 2-minute timeout, Sharp, env `EVIDENCE_BUCKET`, `ATTACHMENTS_BUCKET`, `OBJECT_PREFIX` |
| **Route intake** | match-to-csv | `Choice` state at the start of `<stack>` (§6.3), with spec 1's retries on `ProcessUpload` |
| Upload rule | match-to-csv | Attachments bucket `Object Created` with key prefix `uploads/` (stable) or `ephemeral/<name>/uploads/` (ephemeral), input `{ bucket, key, versionId, channel }`, dead-letter queue `<stack>-events-dlq` |
| Outputs | admin | adds `DeriveAssociationFunctionName` |

### 13.4 Permissions

| Principal | Evidence bucket | Attachments bucket | KMS data key |
| --- | --- | --- | --- |
| `SessionRead` | `ListBucket` with prefix `<ns>sessions/`; `GetObject` on `<ns>sessions/*`, `<ns>map-catalogs/*` and `<ns>submissions/*/screenshots/*/source/original` | none | decrypt |
| `SessionWrite` | `ListBucket` with prefix `<ns>sessions/`; `GetObject` on `<ns>sessions/*`; `PutObject` on `<ns>sessions/*/events/*`, `<ns>sessions/*/upload-slots/*`, `<ns>sessions/*/uploads/*/intent.json` and `<ns>map-catalogs/*` | `PutObject` on `<ns>uploads/*`, used only to sign POSTs | encrypt, decrypt |
| `DeriveAssociation` | `ListBucket` with prefix `<ns>sessions/`; `GetObject` on `<ns>sessions/*`; `PutObject` on `<ns>sessions/*/association/*` | none | encrypt, decrypt |
| `ProcessUpload` | `ListBucket` with prefix `<ns>sessions/`, so a missing intent or receipt reads as `404`; `GetObject` on `<ns>sessions/*/uploads/*/intent.json` and `<ns>sessions/*/uploads/*/receipt.json`; `PutObject` on `<ns>submissions/*` and `<ns>sessions/*/uploads/*/receipt.json` | `GetObject` and `GetObjectVersion` on `<ns>uploads/*` | encrypt, decrypt |

`<ns>` is empty for stable stacks and `ephemeral/<name>/` for ephemeral ones. Every role carries the workload permissions boundary and, for ephemeral stacks, the `/mcc-local/` path. No role has `DeleteObject` or any bucket-configuration permission. No admin role can write under `submissions/` or to a `receipt.json`, and `ProcessUpload` cannot write events, intents or associations. P4.4 extends `scripts/local-cdk-bootstrap.mjs` so the local workload boundary allows these actions for `admin-e-*` and `match-to-csv-e-*` roles in their own namespace.

### 13.5 Deployment

Both stacks deploy as they do today (spec 1 §13.6, spec 3 §13.5). The admin preflight also fails when the attachments bucket parameter is missing. P1.1 and P1.2 need a person's approval to apply. P3.2 merges only after P1.2 is applied in dev and prod, and P4.4 only after P1.1, P1.2 and spec 2 P1.1 are, so neither deploys a rule that cannot fire. Post-deploy verification adds `GET /api/v1/map-catalog` through the distribution without a token, which must return `401`.

## 14. Security and privacy

1. Every session route requires a valid token in the `host` group. The handler takes `sessionId`, `uploadId` and `matchId` only as identifiers and builds every key itself, so no request names a bucket, key or prefix.
2. The presigned POST fixes the exact key, the content type and the maximum size, and expires in 600 seconds. A leaked POST can write one object of the declared size to one staging key, which `process-upload` checks like any upload. CORS on the attachments bucket allows any origin to send a POST, which grants nothing without a valid signed policy.
3. Uploaded bytes are untrusted. `process-upload` checks them with spec 1's attachment rules and Sharp's `failOn: 'none'` before storing a source, and verifies the intent exists, so an object posted outside the API is rejected.
4. Screenshots contain gamertags and live only in the evidence and attachments buckets under the application data key. Session events hold the host's Cognito `sub`, not an email address. File names are normalized as spec 1 §4.3 does, and the original path on the host's device is never sent.
5. Logs never contain file names, labels, gamertags or `sub` values. Handlers log identifiers, event types, counts and request IDs.
6. Every object this component writes is create-only, and Object Lock protects evidence for 365 days (spec 1 §13.1).

## 15. Observability

- Lambdas log JSON lines through the same `log` helper as spec 3. `SessionWrite` logs each event written, `DeriveAssociation` each version with its counts, and `ProcessUpload` the same intake record as `process-email` with `channel: SESSION_UPLOAD`, following spec 5's stage records once they exist.
- X-Ray tracing is active on every function.
- Evidence is the audit record. "What happened to this upload" is answered by its intent, its receipt, the submission the receipt names, and its entry in the latest association. An accepted receipt whose screenshot has no run is the sign of an execution that failed after intake (§6.5).
- Undeliverable association events wait in `<stack>-association-dlq` for 14 days. Alarms follow spec 5 (backlog P6.6).

## 16. Testing, CI and release

### 16.1 Tests

Tests never call AWS.

| Layer or file | Covers |
| --- | --- |
| `session-events.test.ts` | every event type allowed and refused in each state of §4.2; `STALE_SUPERSESSION`; idempotent `clientRequestId`; `matchIndex` with `ADDED` matches, including a `null` anchor, two `ADDED` matches on one anchor and an `ADDED` match anchored on another; a `MAP_CORRECTED` of the first of three `LIVE` matches A, B, C written after `SESSION_ENDED` leaves the order A, B, C and every `matchIndex` and `selectedAt` unchanged and changes only A's `mapId` and current map event; voiding and restoring change no `matchIndex` |
| `capture-time.test.ts` | each source; precedence; `EXIF_LOCAL` in a repeated and a skipped daylight-saving hour; browser skew correction; `PICK_TIME`; unparseable EXIF |
| `association.test.ts` | every row of §7.4; window edges at exactly `start` and `end`; the cap gap; the open-session window; near-boundary flags; duplicates by hash across uploads; `NO_SCREENSHOT` and `MULTIPLE_SCREENSHOTS`; clock offset suggestion of exactly 3,600 for a one-hour skew, a centered offset for a skew of a few minutes, and none when the current offset is best; same inputs in any order give the same document; `inputsSha256` changes with a version bump |
| `fixtures/sessions/*.fixture.json` | Each fixture is a set of events, intents and receipts with the expected association, run by one test per file. They include `map-corrected-after-end`, in which the first of three matches is corrected after the session ends and the expected matches keep the order, `matchIndex`, `selectedAt` and windows of the uncorrected session, and `intake-retry-after-receipt`, an ended session with one match and the upload evidence that `process-upload.test.ts`'s failure after receipt persistence and successful retry leave (one intent and one `ACCEPTED` receipt), giving one `DERIVED` screenshot whose `screenshotId` is the one the retry returned for extraction and `counts.duplicate` of 0 |
| `session-write.test.ts` | sequence race retried and `CONCURRENT_CHANGE` after 3 attempts; catalog snapshot written once; upload intents and POST conditions; two concurrent requests for one upload slot share one `uploadId`; uploads refused on an open session |
| `derive-association.test.ts` | no write when inputs are unchanged; a new version with `previousAssociationVersion`; `412` retry |
| `process-upload.test.ts` | an accepted upload writes the submission, source with `intake`, completion and event, and the receipt last; a rejected image writes a `REJECTED` receipt and throws; a missing intent writes a `REJECTED` completion with `UploadIntentMissingError` and no source or receipt; a namespace mismatch fails; EXIF strings recorded; a run for an upload with an `ACCEPTED` receipt writes nothing and returns the receipt's `submissionId` and screenshot, and with a `REJECTED` receipt writes nothing and throws; a failure after receipt persistence (the first attempt writes the receipt and then throws) followed by a retry with the same input leaves exactly one receipt, and the retry returns the first attempt's screenshot for extraction; a failure before the receipt followed by a retry gives the retry's submission the receipt; a receipt write that returns `412` returns the existing receipt's screenshot and leaves its own submission without a receipt |
| match-to-csv `app.test.ts` | **Route intake** sends `SESSION_UPLOAD` to `ProcessUpload` and anything else to `ProcessEmail`; the upload rule's prefix per stack type |
| admin `app.test.ts` | session routes, reserved concurrency, rule patterns, DLQ and the §13.4 grants for stable and ephemeral stacks |
| Web component tests | map picker never preselects; upload queue retries an expired POST; review actions send the current event as `supersedesEventId` |
| `infrastructure/modules/foundation/tests/` | the `host` group; attachments bucket EventBridge, CORS and `uploads/` lifecycle |

The admin and match-to-csv workspaces keep their coverage thresholds. Fixtures use placeholder labels and no real gamertags.

### 16.2 CI and release

CI runs the existing checks for each affected workspace, `npm run tofu:check` for the foundation, and synthesis for both stacks. Release Please versions `@mcc/contracts`, `@mcc/admin` and `@mcc/match-to-csv`; the contract change bumps both applications.

### 16.3 Live validation

In dev, a host starts a session, selects three maps a few minutes apart, takes a screenshot with a device whose clock is correct at the end of each game before the next selection or the end of the session, takes one screenshot before the first selection, and ends the session. The host uploads the four screenshots from a phone. The operator checks four executions succeeded, three screenshots are `DERIVED` to the right matches, one is `UNASSIGNED` with `BEFORE_FIRST_MATCH`, and the run manifests carry `intake.sessionId`. The host then assigns the fourth screenshot and corrects one map, and the operator checks for two new events and a new association version in which both changes appear.

## 17. Acceptance criteria

- [ ] A session with three `MAP_SELECTED` events and `SESSION_ENDED` produces three `LIVE` matches whose windows follow §7.3, and every event has a gapless `sequence`.
- [ ] Two concurrent writes to one session produce two events with consecutive sequences, or one event and `409 CONCURRENT_CHANGE`; never two events with one sequence.
- [ ] A screenshot uploaded to an ended session becomes one submission whose source has `intake.sessionId`, one receipt, and one run through the unchanged extraction steps; an emailed screenshot still runs through `ProcessEmail`.
- [ ] An intake attempt that fails after writing its upload's receipt, followed by a successful retry, leaves exactly one receipt; the retry extracts the receipt's screenshot, and the association lists that screenshot with its match and never as `DUPLICATE`.
- [ ] An upload request for an open session returns `409 SESSION_OPEN` and writes nothing.
- [ ] A screenshot with `EXIF_WITH_OFFSET` inside match 2's window is `DERIVED` to match 2 with match 2's `mapId`; one with no usable capture time is `UNASSIGNED` with `NO_CAPTURE_TIME`.
- [ ] Two different screenshots inside one window are both assigned and the match is flagged `MULTIPLE_SCREENSHOTS`; a byte-identical second upload is `DUPLICATE`.
- [ ] A match with no screenshot appears with `NO_SCREENSHOT`, and a screenshot outside every window is `UNASSIGNED` with the §7.4 reason and no match.
- [ ] Screenshots from a device whose clock is one hour behind produce a `suggestedClockOffsetSeconds` of 3,600 and no assignment change until the host writes `CLOCK_OFFSET_SET`, and the right assignments after it.
- [ ] `MAP_CORRECTED` with a stale `supersedesEventId` returns `409 STALE_SUPERSESSION`. With the current one it writes a new event, the earlier event is unchanged, and the next association version shows the new `mapId` for the match and its screenshots.
- [ ] Correcting the map of the first of three matches after the session ends leaves the match order, every `matchIndex` and every `selectedAt` unchanged; a `MATCH_ADDED` places its match as §7.1 defines without changing the relative order of the other matches.
- [ ] Every association change writes a new version with `previousAssociationVersion`, and deriving unchanged inputs writes nothing.
- [ ] Given a run's manifest and the latest association, a consumer obtains the run's `sessionId`, `matchId` and `mapId` with no other input, for both the first run and a replay of the screenshot.
- [ ] Every §16.1 test passes with the coverage thresholds, both stacks synthesize, and `npm run tofu:check` passes.
- [ ] The §16.3 live validation passes in dev.

## 18. Risks and accepted limitations

1. **File times can be copy times.** When a screenshot reaches the host's device by a transfer that resets the file time, and has no EXIF, `FILE_LAST_MODIFIED` is the transfer time. If that time falls inside some window, the screenshot is `DERIVED` to the wrong match with no flag. Most transfers happen after the session, so the result is usually `AFTER_SESSION_END`, which the host sees. The review screen shows every screenshot's source so the host can check `FILE_LAST_MODIFIED` assignments. Accepted for v1; P5.4 measures how often it happens.
2. **One clock offset per session.** Screenshots from two devices with different clock errors cannot both be corrected by one offset. The host assigns the others by hand. A per-device offset needs a device identity the upload does not have (P6.4).
3. **A forgotten map selection.** When the host plays two games under one selection, both screenshots fall in one window and the match is flagged `MULTIPLE_SCREENSHOTS`, the same flag two pages of one board raise. The host tells them apart from the thumbnails, adds a match and assigns the second screenshot. When the gap exceeds `maxMatchWindowSeconds`, the second screenshot is `BETWEEN_WINDOWS` instead.
4. **A late selection.** When the host selects the next map more than `boundaryShiftSeconds` before taking the previous match's screenshot, the screenshot goes to the next match. The near-boundary flag marks some of these; the rest need a host to notice. The issue's flow puts the screenshot first.
5. **CORS allows any origin on the attachments bucket.** A page on another origin can send a POST but cannot sign one, and the bucket serves no reads to browsers. The foundation cannot name the admin distribution's domain without knowing about CDK.
6. **No session index.** Listing sessions and reading one session list and read evidence objects. At league scale, a few hundred sessions a year and a few dozen objects a session, that is fast and cheap. A rebuildable projection table is backlog (P6.1).
7. **Derivation is serialized across all sessions.** A reserved concurrency of 1 means one session's burst of receipts can delay another session's version by seconds to minutes. Throttled events are retried for up to 6 hours. Consumers already treat missing screenshots as unassigned (§8.1).
8. **Uploads only after the session ends.** A host who wants to upload during a long night must end the session and start another. The issue's flow uploads afterwards.
9. **Any host can change any session.** Every event records its author, and nothing is lost, because corrections supersede. Per-session ownership is backlog if hosts ask for it (P6.5).
10. **`EXIF_LOCAL` assumes the device is in the host's time zone.** A console set to another zone produces whole-hour skews, which the offset suggestion detects.
11. **Spec 4 and spec 7 are not yet revised.** Until they are, spec 4 describes a different match flow and spec 7 groups uploaded pages only by `gameKey`. §8.2 and §8.4 list the changes, and spec 4 must be revised before any of its slices is filed.
12. **Emailed screenshots have no session.** Players who email screenshots during a session contribute runs that no association lists. Importing them is backlog (P6.2).
13. **Staged uploads expire after 30 days.** The stored original in the evidence bucket is kept, so nothing is lost after a successful intake. An upload with no receipt after 30 days must be uploaded again. An upload with a receipt never needs its staged copy again, because a restarted intake reads the receipt (§6.3 step 2).
14. **The map catalog is Halo 3 only.** Sessions of other MCC games need a new catalog version and new parser profiles first.
15. **Failed intake attempts leave submissions without receipts.** An attempt that fails before its receipt, or loses the receipt write to a concurrent run, keeps its stored original and completion, which no association lists and no execution extracts (§6.5). They cost storage only, and receipts are what tell consumers which submission counts.
16. **An execution that fails after intake needs an operator.** When the receipt exists but the execution failed before extraction, the screenshot is listed with no run until an operator restarts the execution (§6.5). Nothing restarts it automatically, and alarms are backlog (P6.6).

## 19. Reference documentation

- S3 presigned uploads: https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html
- S3 POST policy conditions: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html
- S3 CORS: https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html
- S3 events in EventBridge: https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventBridge.html
- EventBridge content filtering, including wildcards: https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pattern-content-based-filtering.html
- S3 conditional writes: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html
- Lambda asynchronous invocation and retries: https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html
- Lambda reserved concurrency: https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html
- Step Functions `Choice` state: https://docs.aws.amazon.com/step-functions/latest/dg/state-choice.html
- Cognito user pool groups: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-user-groups.html
- `File.lastModified`: https://developer.mozilla.org/en-US/docs/Web/API/File/lastModified
- `Intl.DateTimeFormat.prototype.resolvedOptions`: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/resolvedOptions
- EXIF tags, including `OffsetTimeOriginal`: https://exiftool.org/TagNames/EXIF.html
- Sharp metadata: https://sharp.pixelplumbing.com/api-input

## 20. Delivery plan: phases and slices

This section is the backlog source for building the component. It is written to be turned directly into GitHub issues.

### 20.1 How to file this plan

- Each **phase** becomes one epic, titled with the phase title, with its goal and exit criteria as the body. Create epics only when someone explicitly asks for filing.
- Each **slice** becomes one leaf issue under its phase epic, titled without its code, with `Plan ID: P<n>.<m>` in the body. File with `/mcc-create-github-issue`.
- **Size** is XS, S or M. Split a slice by independently testable behavior when it outgrows one reviewable PR; the original Plan ID becomes the container.
- **Blocked by** lists Plan IDs, with other specs' slices named by spec. Create native blocked-by links after every issue in the batch exists, and to other specs' issues once they are filed.
- **Acceptance** bullets become the issue's acceptance criteria verbatim. Every slice also inherits §20.3.
- **Spec** lists the sections the implementer must read. Link them; this document stays the source of truth.
- Plan IDs are stable. Deferred slices keep their IDs and move to the backlog phase; new slices take the next free number in their phase.

### 20.2 Seam contracts

| Contract | Defined in | Main consumers |
| --- | --- | --- |
| `SessionEvent`, `UploadIntent`, `UploadReceipt`, `MapCatalog`, `SessionAssociation`, `SourceScreenshot.intake`, `ProcessUploadInput` (§10.1) | P0.1 | `session-write`, `session-read`, `derive-association`, `process-upload`, the web application, spec 4, spec 7, #159 |
| Session evidence layout (§5.1) | P0.1, P2.1 | every module here, #159 |
| Map catalog and `mapId` format | P0.2 | `session-write`, spec 4, #159 |
| Association rules and configuration (§7) | P2.3 | `derive-association`, `session-read`, #159 |
| **Route intake** and `channel` trigger input | P3.2 | the main workflow, both EventBridge rules |

A change to a contract updates every consumer in the same PR.

### 20.3 Definition of done for every slice

- Handlers keep I/O behind an injected dependencies object; only default dependencies construct SDK clients.
- New behavior has tests that run without AWS, and each workspace stays above its coverage thresholds.
- `npm run check` passes. Slices that touch CDK also pass `npm run app:synth -- <app> --environment dev`, and match-to-csv slices `npm run verify:bundle --workspace @mcc/match-to-csv`. Slices that touch `infrastructure/` pass `npm run tofu:check`.
- Any change to §7 or a §7.6 value bumps its version (§5.4).
- No domain, address, account ID, real gamertag, real screenshot or host identity appears in code, fixtures, logs or docs.
- Operator-visible changes update the workspace README.

### Phase 0: Contracts and catalog

**Goal:** the shared types and the map catalog exist.
**Exit criteria:** contracts compile, and the catalog loads and validates.

#### P0.1 Session, upload and association contracts (S)

- **Blocked by:** none
- **Spec:** §5.1, §5.3, §10.1
- **Files:** `packages/contracts/src/index.ts`, `packages/contracts/package.json`
- **Provides:** every type in §10.1
- **Acceptance:**
  - The package exports the §10.1 types and builds without runtime code.
  - `SourceScreenshot.intake` is optional, and every existing consumer compiles unchanged.
  - `npm run release:check` passes.

#### P0.2 Map catalog v1 (XS)

- **Blocked by:** P0.1; spec 3 P0.1
- **Spec:** §1 (map catalog), §10.1, §13.1
- **Files:** `applications/admin/config/map-catalog-v1.json`, `src/lib/map-catalog.ts`, `test/sessions/map-catalog.test.ts`
- **Provides:** `loadMapCatalog`
- **Acceptance:**
  - The catalog lists every Halo 3 multiplayer map MCC offers, each with a `halo3-` `mapId` and its in-game name.
  - Loading fails on a duplicate `mapId`, a malformed `mapId` or a catalog with no selectable map.

### Phase 1: Foundation

**Goal:** hosts can sign in and uploads can be staged.
**Exit criteria:** P1.1 and P1.2 are applied in dev and prod.

#### P1.1 Host group (XS)

- **Blocked by:** spec 3 P1.1
- **Spec:** §1 (who may act), §13.2
- **Files:** `infrastructure/modules/foundation/cognito.tf`, `infrastructure/modules/foundation/tests/`
- **Provides:** the `host` group
- **Acceptance:**
  - The user pool has a `host` group, and the module test covers it.
  - `npm run tofu:check` passes, and the PR states that applying it needs a person's approval.

#### P1.2 Upload staging on the attachments bucket (S)

- **Blocked by:** none
- **Spec:** §5.1, §13.2, §14
- **Files:** `infrastructure/modules/foundation/main.tf`, `infrastructure/modules/foundation/tests/`
- **Provides:** EventBridge notifications, CORS and `uploads/` expiry on the attachments bucket
- **Acceptance:**
  - The attachments bucket sends EventBridge notifications.
  - Its CORS rule allows only `POST`, from any origin, with no exposed headers.
  - Objects under `uploads/` expire after 30 days and noncurrent versions after 1 day; the `ephemeral/` rules are unchanged.
  - `npm run tofu:check` passes, and the PR states that applying it needs a person's approval.

### Phase 2: Session and association library

**Goal:** the pure rules exist and are tested.
**Exit criteria:** every library row of §16.1 passes.

#### P2.1 Session event rules and fold (M)

- **Blocked by:** P0.1; spec 3 P0.1
- **Spec:** §4.2, §4.3, §7.1
- **Files:** `applications/admin/src/lib/session-events.ts`, `test/sessions/session-events.test.ts`
- **Provides:** `foldSession`, `checkSessionEvent`
- **Acceptance:**
  - Each event type is allowed and refused exactly as §4.2 and §4.3 state, with the listed codes.
  - The fold gives each match's current map event, status and `matchIndex`, and the session's clock offset.
  - `matchIndex` follows §7.1 for `ADDED` matches, and correcting the map of the first of three matches after the session ends, or voiding or restoring a match, leaves every `matchIndex` and `selectedAt` unchanged.

#### P2.2 Capture time (S)

- **Blocked by:** P0.1; spec 3 P0.1
- **Spec:** §7.2
- **Files:** `applications/admin/src/lib/capture-time.ts`, `test/sessions/capture-time.test.ts`
- **Provides:** `captureCandidates`, `resolveCaptureTime`
- **Acceptance:**
  - Sources apply in §7.2 order, and every candidate records its raw value, instant and unusable reason.
  - `EXIF_LOCAL` follows the repeated-hour and skipped-hour rules, and `PICK_TIME` discards a file time within `pickTimeSeconds` of the request.

#### P2.3 Association derivation (M)

- **Blocked by:** P2.1, P2.2
- **Spec:** §7.1 to §7.6, §13.1
- **Files:** `applications/admin/src/lib/association.ts`, `config/association-config-v1.json`, `test/sessions/association.test.ts`, `test/fixtures/sessions/`
- **Provides:** `associate`, `associationInputsSha256`
- **Acceptance:**
  - Every row of §7.4 and every window rule of §7.3 has a fixture, and the `map-corrected-after-end` and `intake-retry-after-receipt` fixtures of §16.1 pass.
  - The clock offset suggestion follows §7.5 and never changes an assignment.
  - The output is identical for inputs given in any order, apart from `derivedAt` and `build`.

### Phase 3: Upload intake in match-to-csv

**Goal:** an uploaded file becomes a run through the existing workflow.
**Exit criteria:** an ephemeral stack turns a staged object into a submission, a receipt and a run.

#### P3.1 Upload intake Lambda (M)

- **Blocked by:** P0.1
- **Spec:** §5.2, §5.3, §6.3, §6.5, §8.3, spec 1 §4.3
- **Files:** `applications/match-to-csv/src/lambdas/process-upload.ts`, `src/lib/{image-acceptance,exif}.ts`, `src/lambdas/process-email.ts`, `test/process-upload.test.ts`, `specs/1-mcc-analytics-engine.md`
- **Provides:** `processUpload`, `upload-receipt/v1`, `upload-submission/v1`
- **Acceptance:**
  - The `process-upload.test.ts` row of §16.1 passes.
  - The receipt is the last write, an upload never has two receipts, and an intake run for an upload with a receipt writes nothing and returns or rejects as the receipt says, including the retry after a failure after receipt persistence.
  - `attachmentRejectionCodes` moves to `image-acceptance.ts` and every existing intake test passes unchanged.
  - Spec 1 §4, §5, §6.3 and §10.1 describe the upload intake.

#### P3.2 Intake routing and upload trigger (S)

- **Blocked by:** P3.1, P1.2
- **Spec:** §6.3, §13.3, §13.4, §8.3
- **Files:** `applications/match-to-csv/cdk/lib/match-to-csv-stack.ts`, `test/app.test.ts`, `specs/1-mcc-analytics-engine.md`
- **Provides:** **Route intake**, the upload rule, `ProcessUpload` in the stack
- **Acceptance:**
  - The match-to-csv `app.test.ts` row of §16.1 passes for stable and ephemeral stacks.
  - The raw-email rule sends `channel: EMAIL`, and an email still produces the same evidence as before.
  - `ProcessUpload` has exactly the §13.4 grants.
  - Spec 1 §3, §6.1, §13 and §16.1 describe the routing.

### Phase 4: Admin session API

**Goal:** hosts can record sessions and upload through the API, and associations are written.
**Exit criteria:** an ephemeral admin stack records a session, accepts uploads and writes association versions.

#### P4.1 Session writes (M)

- **Blocked by:** P0.2, P2.1; spec 3 P0.1
- **Spec:** §4.1 to §4.3, §6.1, §6.5
- **Files:** `applications/admin/src/lambdas/session-write.ts`, `src/lib/session-store.ts`, `test/sessions/session-write.test.ts`
- **Provides:** `startSession`, `writeSessionEvent`
- **Acceptance:**
  - Events are written create-only at the next sequence, a lost race retries, and three lost races return `409 CONCURRENT_CHANGE`.
  - A repeated `clientRequestId` returns the earlier event with `200`.
  - A catalog snapshot is written once per version.

#### P4.2 Upload requests (S)

- **Blocked by:** P4.1
- **Spec:** §4.1, §6.2, §14
- **Files:** `applications/admin/src/lambdas/session-write.ts`, `src/lib/upload-post.ts`, `test/sessions/session-write.test.ts`
- **Provides:** `requestUploads`
- **Acceptance:**
  - Each file gets one intent, and a repeated or concurrent `(uploadBatchId, uploadIndex)` returns the same intent with a fresh POST.
  - The POST fixes the key, content type and maximum size and expires in 600 seconds.
  - An open session is refused with `409 SESSION_OPEN`.

#### P4.3 Session reads and association writer (S)

- **Blocked by:** P2.3, P4.1
- **Spec:** §4.1, §6.4
- **Files:** `applications/admin/src/lambdas/{session-read,derive-association}.ts`, `test/sessions/derive-association.test.ts`
- **Provides:** `readSession`, `listSessions`, `deriveAssociation`
- **Acceptance:**
  - The `derive-association.test.ts` row of §16.1 passes.
  - A session read returns the live preview computed with `associate` and the latest written version number.

#### P4.4 Session resources in the admin stack (M)

- **Blocked by:** P4.2, P4.3, P1.1, P1.2; spec 3 P1.2, P3.4; spec 2 P1.1
- **Spec:** §13.3 to §13.5, §14
- **Files:** `applications/admin/cdk/lib/admin-stack.ts`, `test/app.test.ts`, `scripts/local-cdk-bootstrap.mjs` and its tests
- **Provides:** deployable session routes and association writer
- **Acceptance:**
  - The admin `app.test.ts` row of §16.1 passes for stable and ephemeral stacks.
  - The Content Security Policy's `connect-src` includes the attachments bucket's regional endpoint.
  - An ephemeral stack records a session, issues upload POSTs, and writes an association version after a receipt appears, then destroys cleanly.

### Phase 5: Host screens

**Goal:** a host can run a session from a phone.
**Exit criteria:** §16.3 passes in dev.

#### P5.1 Session and map selection screens (M)

- **Blocked by:** P4.4; spec 3 P4.1
- **Spec:** §9
- **Files:** `applications/admin/web/src/sessions/`
- **Provides:** the Sessions and Live session screens
- **Acceptance:**
  - A host starts a session, selects maps with search, and ends it, and no map is preselected.
  - Conflicts show a message and a reload, and nothing is retried with a stale `supersedesEventId`.

#### P5.2 Upload screen (S)

- **Blocked by:** P5.1, P3.2
- **Spec:** §6.2, §9
- **Files:** `applications/admin/web/src/sessions/`
- **Provides:** the Upload screen
- **Acceptance:**
  - Files are requested in batches of 25 and posted at most 3 at a time, and an expired POST is requested again for the same `uploadId`.
  - Each file shows pending, rejected with codes, or accepted.

#### P5.3 Review and correction screen (M)

- **Blocked by:** P5.1
- **Spec:** §7.4, §7.5, §9
- **Files:** `applications/admin/web/src/sessions/`
- **Provides:** the Review screen
- **Acceptance:**
  - Every correction in §4.2 is available and writes one event with the current `supersedesEventId`.
  - Unassigned screenshots show their reason and capture-time candidates, and the suggested offset is applied only by a host action.

#### P5.4 Live validation (S)

- **Blocked by:** P5.2, P5.3
- **Spec:** §16.3, §7.6
- **Files:** none beyond the issue
- **Provides:** the first measured session
- **Acceptance:**
  - §16.3 passes in dev.
  - The issue records, for at least one real league session, the counts by status and capture source and every host correction, and keeps or changes each §7.6 value.

### Phase 6: Backlog (not filed with v1)

| ID | Slice | Size | Note |
| --- | --- | --- | --- |
| P6.1 | Rebuildable session index table | S | §18.6. Only when listing becomes slow. |
| P6.2 | Import an emailed screenshot into a session | S | §18.12. A `SCREENSHOT_IMPORTED` event naming a `screenshotId`. |
| P6.3 | Check a match's map against scoreboard text | M | Only where MCC prints the map on the board; flags, never assigns. |
| P6.4 | Per-device clock offsets | M | §18.2. Needs a device hint at upload. |
| P6.5 | Per-session host ownership | XS | §18.9. |
| P6.6 | Alarms for the association DLQ and `DeriveAssociation` errors | S | Follow spec 5. |

### 20.4 Dependency order and parallel lanes

P0.1 and P1.2 can start at once. P3.1 then proceeds in parallel with P2.1 and P2.2, which wait on spec 3 P0.1. The critical path is spec 3 P0.1 -> P2.1 -> P2.3 -> P4.3 -> P4.4 -> P5.1 -> P5.3 -> P5.4, with spec 3 P3.4 and P4.1 joining at P4.4 and P5.1. The first real feedback is P5.4, when a host runs a league night through the screens and the association meets real clocks.
