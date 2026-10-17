# Matches from Admin Uploads: Technical Specification

**Status:** Draft; not implemented

**Version:** 2.0-draft

**Date:** October 15, 2026

**Component:** match routes, the match record Lambda and admin screens in `applications/admin`; an admin upload intake in `applications/match-to-csv` (`process-upload` and a routing state in the main workflow); match, upload and match record types in `packages/contracts`; the `admin` group and upload staging in `infrastructure/modules/foundation`

**Runtime:** TypeScript. Node.js 22 on AWS Lambda (ARM64) behind spec 3's API Gateway HTTP API, and the existing match-to-csv Step Functions workflow; admin screens in spec 3's React application

**Deployment:** the existing `admin` and `match-to-csv` CDK stacks, one per stable environment from GitHub Actions plus ephemeral developer stacks, through the guarded wrapper in `scripts/cdk-app.mjs`

**Input:** an admin's upload of one match's postgame screenshots, and the admin's later corrections to that match

**Persistent state:** append-only match events, request claims, slug reservations, image index entries, upload slots, upload intents, upload receipts and match record versions under `matches/`, `match-requests/`, `match-slugs/` and `image-index/` in the OpenTofu-owned evidence bucket; uploaded files staged for 30 days in the OpenTofu-owned attachments bucket

**External dependencies at runtime:** CloudFront, API Gateway, Lambda, Cognito, S3, KMS, EventBridge, SQS, Step Functions, SSM Parameter Store

**Out of scope:** maps, game variants and playlists (§1), player identity and gamertag resolution (spec 6), choosing one screenshot per match for statistics and every lakehouse table (#159), reading OCR content to group screenshots, attaching emailed screenshots to a match, and public access

A match ends. An admin signs in to the admin application, picks that match's postgame scoreboard screenshots and uploads them. The upload request creates the match first: an opaque `matchId`, a slug of one random Halo term and a short random suffix such as `warthog-7k3q`, and the match's metadata. Only then does the admin application issue upload slots, so every screenshot is staged, checked and extracted already knowing its match. Match-to-csv carries the `matchId` from the upload into the screenshot's source and every run's manifest. A versioned match record lists the match's status and its screenshots, and match-to-csv runs, spec 7 and the stats lakehouse (#159) read it.

**Readiness:** this specification authorizes filing Phases 0 to 5. Slices that build on the admin workspace, user pool or stack are blocked by the spec 3 slices named in their **Blocked by** lines. P3.2 cannot merge until P1.2 is applied in dev and prod, and P4.4 until P1.1, P1.2 and spec 2 P1.1 are. The contracts in §5.3 and §10.1 freeze when P0.1 merges. The slug word list in §7.2 is a proposal until P0.2 merges it, and the limits in §7.4 are initial values until P5.3 records the first live matches. Spec 9, the stats lakehouse (#159), reads the session-association contract; §8.4 lists what it must change.

---

## 1. Resolved requirement decisions

Issue #167 states this flow: a match ends, an admin signs in and uploads its screenshots, and the upload creates the match, with its identifier, slug and metadata, before any image processing begins, because statistics are tied to matches. Screenshot metadata is not reliable enough to place a screenshot by comparing its capture time with map selections, so the admin application does not select maps.

| Requirement | Decision | Reason |
| --- | --- | --- |
| Who owns match records | The admin application owns matches and their screenshot membership. Its `MatchWrite` Lambda is the only writer of match events, and its `WriteMatchRecord` Lambda the only writer of match record versions. Match-to-csv writes only upload receipts. The stats lakehouse (#159) reads match records and never creates a match. | The admin creates the match when uploading. A match inferred later from statistics or metadata would be a guess. |
| What creates a match | One `POST /api/v1/matches` request, which carries the descriptions of 1 to 10 screenshot files. It writes the `MATCH_CREATED` event before any upload intent or presigned POST exists (§6.1). A match is never created by intake, by a screenshot or by a metadata rule. | Every staged object is then already under a match, so intake, extraction, review and statistics never handle a screenshot whose match is unknown. |
| How screenshots join a match | By the upload. A screenshot belongs to the match whose upload created it, recorded in its upload intent, its staging key, its `SourceScreenshot.intake.matchId` and its run manifest. EXIF data, file times and upload order are never read to place it. A screenshot never moves between matches: an admin excludes it from the wrong match and uploads it to the right one (§4.2). | The admin knows which match the screenshots show. Explicit membership needs no association rules, has nothing to tune and cannot be wrong silently. Moving would make one screenshot's match depend on event order in two matches. |
| Identifiers | `matchId`, `uploadId` and `eventId` are `evidenceId()` values (spec 1 §5.1), issued by `MatchWrite`. `matchId` is the key in every evidence path, contract, run manifest and lakehouse table. People never see or type it. | One identifier format across evidence, sortable by creation time, with no meaning a person might rely on. |
| Slug | Every match also has a `slug`: one lowercase Halo term from the pool in §7.2, a `-`, and a random suffix of at least 4 Crockford base32 characters, such as `warthog-7k3q` or `killtacular-m2x9`. It is unique across all matches of a namespace, reserved create-only at `match-slugs/{slug}.json` before the match is created, never changed and never reused, even for a voided match. When draws collide, the suffix grows by one character, so the pool cannot run out (§7.2). Admin screens, URLs and later the player app show the slug, and `GET /api/v1/match-slugs/{slug}` resolves it to a `matchId`. | A person can say, type and remember a slug; nobody can do that with an `evidenceId()`. One word keeps slugs short (8 to 17 characters), and the suffix carries the uniqueness, so the word list can stay small. Drawing both at random keeps the slug free of players, time, content and `matchId`. `crypto.randomInt` over a fixed alphabet needs no library; `shortid` is deprecated, and `nanoid` would add a dependency for the same few lines. |
| Match metadata | `MATCH_CREATED` records `matchId`, `slug`, `slugWordsVersion`, `game` (`halo3`), `playedAt`, `playedAtSource`, an optional `note`, `declaredScreenshotCount`, `createdAt` (the event's `occurredAt`), the admin's Cognito `sub` and the build (§4.2, §10.1). The match record adds status, screenshots, uploads, flags and counts (§7.3). | These are the fields the other specs read: spec 7 needs membership and status, spec 3 needs nothing new, and the lakehouse needs a match, its time and its screenshots. A game code keeps the record valid when other MCC games get parser profiles. |
| Maps, game variants and playlists | Not recorded in v1. The admin application has no map catalog and no map picker. Reading a map or game variant printed on a postgame screen is backlog (P6.3). | The admin does not select maps, and screenshot metadata cannot place one. The current captures and parser fixtures carry only the scoreboard table. A field nobody can fill reliably would invite guesses. |
| Play time | `playedAt` defaults to the server time of `MATCH_CREATED` with `playedAtSource: UPLOAD_TIME`. The admin may enter an earlier time instead (`ADMIN_ENTERED`), from `maxPlayedAtAgeDays` before the request up to the request time, and may correct it later with `DETAILS_CORRECTED`. | The flow uploads right after the match ends, so upload time is close. An admin uploading the next morning knows better. Neither source reads image metadata. |
| Match order | Matches are ordered by `playedAt`, then `matchId`. | `playedAt` is the best available time, and `matchId` sorts by creation time, which breaks ties deterministically. |
| Where match events live | Each event is one create-only JSON object at `matches/{matchId}/events/{sequence}.json`, sequence 1 being `MATCH_CREATED`. `If-None-Match: *` refuses a second writer of the same number (§6.3). There is no match table. | The evidence bucket already gives immutable, Object Lock protected, append-only storage (spec 1 §5.2). Create-only sequence keys serialize the writers of one match without a new persistent resource. |
| Corrections | A correction is a new event that names the event it supersedes in `supersedesEventId`. `MatchWrite` refuses it with `409 STALE_SUPERSESSION` when that event is not the current one. No event is ever changed or deleted. The slug, `game` and `createdAt` cannot be corrected. | Every earlier decision stays readable, and two admins cannot both supersede the same decision. |
| Idempotent creation | The client sends a `clientRequestId`. `MatchWrite` claims `match-requests/{clientRequestId}.json` create-only with a new `matchId` before anything else, so a retried request finds the claim and continues or returns the same match (§6.1). | A phone on a poor connection retries. Two matches for one upload would double every player's statistics. |
| Uploading the same image twice | The browser sends each file's SHA-256. `MatchWrite` refuses a file whose SHA-256 is already live in another active match, or in the same match, with `409 IMAGE_ALREADY_UPLOADED` naming the other match's slug (§6.2). `ProcessUpload` rejects a stored image whose SHA-256 differs from the declared one. | One screenshot counted in two matches doubles statistics. The declared hash lets the check run before upload, and intake verifies it, so the index cannot be poisoned by a wrong hash. |
| How uploads reach match-to-csv | The browser posts each file to the attachments bucket under `uploads/{matchId}/{uploadId}/original` with a presigned POST. The bucket's `Object Created` event starts the existing match-to-csv main workflow, where a new first `Choice` state sends it to a new `ProcessUpload` Lambda instead of `ProcessEmail`. `ProcessUpload` applies spec 1's attachment checks, stores the original as a new submission, and returns the same output, so the same `Map`, `ExtractText` and `WriteExtractedCsv` states run unchanged. | One extraction path means every run is comparable, and spec 2, spec 3 and spec 7 need no change to read uploaded runs. Staging in the attachments bucket, which the foundation reserved for later features (spec 1 §13.1), keeps unchecked bytes out of the Object Lock bucket. |
| Which screenshot an upload has when intake runs more than once | Exactly one: the screenshot in the upload's receipt. `ProcessUpload` writes the receipt at a fixed key per upload, create-only and as its last write. Every later intake run for that upload finds the receipt and returns its screenshot without writing anything (§6.4). | Retries are then never a duplicate, and the screenshot the match record lists is always the one sent to extraction. |
| Adding screenshots later | `POST /api/v1/matches/{matchId}/uploads` adds files to an active match, up to `maxUploadsPerMatch` uploads in all. | A forgotten second page of a long scoreboard belongs to the same match. |
| Who may act on a match | Members of a new Cognito group `admin` in spec 3's user pool. Any admin may act on any match. Each event records the caller's `sub`. | A league has a few admins who cover for each other. The record of who did what is enough. |
| Emailed screenshots | Keep running through email intake with no match. They never appear in a match record in v1. | Email carries no match context. Importing an emailed screenshot into a match is backlog (P6.2). |

**Additional capabilities included:** a live match record preview on every match read, slug resolution for URLs, a duplicate-image guard across matches, and an operator rebuild of any match's record.

## 2. Goals and non-goals

### 2.1 Goals

1. An admin can create a match by uploading its screenshots from a phone, and every uploaded screenshot is extracted by the same match-to-csv steps as an emailed one.
2. The match exists, with its `matchId`, slug and metadata, before any of its screenshots is staged or processed, and every run of an uploaded screenshot names its `matchId`.
3. Every match has a unique, readable slug of Halo terms that never changes.
4. Every membership change and correction is explainable from immutable events.
5. The stats lakehouse can join every run of an uploaded screenshot to its match, and learn whether the match and the screenshot count, from evidence alone.

### 2.2 Non-goals

- Recording or suggesting maps, game variants or playlists (§1).
- Deriving match membership from EXIF data, file times, upload order or OCR content.
- Deciding which screenshot of a match is used for statistics, or merging pages. #159 owns that.
- Recording teams, players or results on a match. Those come from validated tables (spec 3 §8.4).
- Attaching emailed screenshots to a match.
- Moving a screenshot between matches (§1).
- Exactly-once submissions. An intake attempt that fails before writing its upload's receipt leaves a submission with no receipt, which no match record lists and no execution extracts (§6.4, §6.6).

## 3. Runtime architecture

```text
Admin browser (spec 3 React application, `admin` group)
  |
  v
CloudFront /api/* -> HTTP API (JWT authorizer)
  +-- GET  /v1/matches..., /v1/match-slugs/{slug}   -> MatchRead Lambda   (reads evidence, live record preview)
  +-- POST /v1/matches, uploads, events             -> MatchWrite Lambda  (request claim, slug, events, intents, POSTs)
                                                          |
                                                          v
Evidence bucket (OpenTofu): match-requests/, match-slugs/, image-index/,
                            matches/{matchId}/events/, upload-slots/, uploads/{uploadId}/intent.json
  |
Admin browser --presigned POST (10 minutes)--> Attachments bucket (OpenTofu): uploads/{matchId}/{uploadId}/original
                                                          |
                                                          |  Object Created (EventBridge, enabled by P1.2)
                                                          v
match-to-csv main workflow <stack>
  Route intake (Choice on $.channel)
    +-- EMAIL        -> ProcessEmail (spec 1, unchanged)
    +-- ADMIN_UPLOAD -> ProcessUpload: returns the existing receipt's screenshot, or checks, stores the original
                        as a new submission with intake.matchId, and writes matches/{matchId}/uploads/{uploadId}/receipt.json last
  Process attachments (Map) -> ExtractText -> WriteExtractedCsv   (spec 1, unchanged; the run manifest carries intake.matchId)

Evidence bucket Object Created under matches/*/events/, intent.json, receipt.json  (EventBridge, spec 2 P1.1)
  |
  v
admin EventBridge rule -> WriteMatchRecord Lambda (reserved concurrency 1) --(failed delivery)--> SQS DLQ
  |
  v
Evidence bucket: matches/{matchId}/record/{matchVersion}.json  -->  spec 7, stats lakehouse (#159)
```

**Ownership rules:** `match-write` owns match events, request claims, slug reservations, image index entries, upload slots and upload intents, and is the only module that signs upload POSTs. `process-upload` in match-to-csv owns upload submissions and upload receipts. `write-match-record` owns match record versions. `match-read` writes nothing. No admin module writes under `submissions/`, and no match-to-csv module writes under `matches/` except `process-upload` at `matches/*/uploads/*/receipt.json`. `match-events`, `match-record` and `slug` are pure and perform no I/O apart from the random source `slug` receives. Only Lambda entry points construct AWS SDK clients; each core function receives an injected dependencies object.

**Packaging:** match, upload and match record types live in `@mcc/contracts`, because match-to-csv writes receipts and spec 7 and the lakehouse read records. The admin Lambdas and pure libraries live in `@mcc/admin` beside spec 3's, and admin screens in its `web/` application. `process-upload` lives in `@mcc/match-to-csv`.

**Orchestration decision:** no new state machine. Match writes are synchronous single-object writes in a fixed order. Uploads reuse the match-to-csv main workflow through one `Choice` state. Record writing is one Lambda invocation per input change, serialized by a reserved concurrency of 1 (§6.5).

### 3.1 Execution policy

- One admin action is one API request. A create request writes at most one match; every other request writes at most one event.
- `MATCH_CREATED` is written before any upload slot, intent or presigned POST of the match, so no staged object exists for a match that does not.
- One uploaded file is one upload intent and one staged attachments bucket object, and has at most one receipt. The receipt names the one submission and screenshot the match record uses, and every main workflow execution for the upload that reaches extraction extracts that screenshot (§6.4).
- Every evidence write uses `If-None-Match: *`. No handler deletes or overwrites an object.
- Match events are numbered from 1 without gaps. A write that loses the race for a number re-reads the match and retries, up to 3 attempts (§6.3).
- The match record is a pure function of the match's input objects and the bundled rules version (§7.3). Writing it twice from the same inputs gives the same document apart from `writtenAt` and `build`.
- Handlers never read or write outside their namespace (`ephemeral/<name>/` for ephemeral stacks). The namespace comes from the deployment, never from a request.

## 4. Admin API and upload interface

### 4.1 Routes

Every route sits behind spec 3's CloudFront `/api/*` behavior and JWT authorizer. Each handler rejects a token whose `cognito:groups` claim lacks `admin` with `403 NOT_AN_ADMIN`. `matchId` and `uploadId` must match spec 3's `evidenceId()` pattern (`^[0-9a-z]+-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$`), and `slug` the slug pattern in §7.2. Request bodies are JSON of at most 16 KiB.

| Method and path | Lambda | Behavior |
| --- | --- | --- |
| `GET /api/v1/matches?before=<matchId>&limit=20` | `MatchRead` | Matches newest first by `matchId`, each with `matchId`, `slug`, `status`, `playedAt`, `screenshotCount` and `flags` from its latest record (or its live preview when no record exists yet), and `nextBefore` when more exist. `limit` is 1 to 50. |
| `GET /api/v1/match-slugs/{slug}` | `MatchRead` | `{ slug, matchId }`, or `404 MATCH_NOT_FOUND` when no reservation exists or its match has no `MATCH_CREATED`. |
| `GET /api/v1/matches/{matchId}` | `MatchRead` | Every event, every upload intent and receipt, a live record preview computed with §7.3, the latest written `matchVersion`, and presigned GET URLs (600 seconds) for each accepted screenshot's `source/original`. |
| `POST /api/v1/matches` | `MatchWrite` | `{ clientRequestId, clientTime, playedAt?, note?, files }`, with 1 to `maxFilesPerRequest` files, each `{ fileName, contentType, sizeBytes, sha256, uploadIndex }`. Creates the match and its uploads (§6.1) and returns `201` with the `MATCH_CREATED` event, the slug and each `uploadId` with its presigned POST. |
| `POST /api/v1/matches/{matchId}/uploads` | `MatchWrite` | `{ uploadBatchId, clientTime, files }`, files as above. Adds uploads to an active match (§6.2) and returns `201` with each `uploadId` and its presigned POST. |
| `POST /api/v1/matches/{matchId}/events` | `MatchWrite` | `{ type, detail, supersedesEventId, clientRequestId, clientTime }` for every type in §4.2 except `MATCH_CREATED`. Returns `201` with the event. |

A create request whose `clientRequestId` already has a claim returns the claimed match with `200` and a fresh presigned POST for each of its uploads that has no receipt (§6.1). An event write whose `clientRequestId` already appears in the match returns the earlier event with `200` and writes nothing. An upload request is idempotent per `(uploadBatchId, uploadIndex)`; the create request uses its `clientRequestId` as its `uploadBatchId`.

### 4.2 Match events

| `type` | `detail` | `supersedesEventId` | Allowed when |
| --- | --- | --- | --- |
| `MATCH_CREATED` | `slug`, `slugWordsVersion`, `game`, `playedAt`, `playedAtSource` (`UPLOAD_TIME` or `ADMIN_ENTERED`), `note` (at most 200 characters, or `null`), `declaredScreenshotCount` | `null` | Through `POST /api/v1/matches` only, always sequence 1. |
| `DETAILS_CORRECTED` | `playedAt`, `note` | the match's current details event | Any time. `playedAtSource` becomes `ADMIN_ENTERED`. |
| `MATCH_VOIDED` | `reason` (`NOT_A_MATCH`, `DUPLICATE_MATCH`, `TEST` or `OTHER`), `comment` (at most 200 characters, or `null`) | the current `MATCH_RESTORED`, or `null` | The match is active. |
| `MATCH_RESTORED` | none | the current `MATCH_VOIDED` | The match is voided. |
| `SCREENSHOT_EXCLUDED` | `uploadId`, `reason` (`NOT_A_SCOREBOARD`, `WRONG_MATCH`, `UNREADABLE` or `OTHER`) | the upload's current membership event, or `null` | The upload has an intent in this match. |
| `SCREENSHOT_RESTORED` | `uploadId` | the upload's current `SCREENSHOT_EXCLUDED` | The upload's current membership event is `SCREENSHOT_EXCLUDED`. Refused with `409 IMAGE_ALREADY_UPLOADED` when its image is live elsewhere (§6.2 step 3). |

A match's current details event is its `MATCH_CREATED`, or the latest `DETAILS_CORRECTED` that superseded it. An upload's current membership event is the latest `SCREENSHOT_EXCLUDED` or `SCREENSHOT_RESTORED` naming it. A voided match keeps its slug, and its screenshots keep their status.

### 4.3 Validation and errors

| Condition | Status and code | Writes |
| --- | --- | --- |
| `cognito:groups` lacks `admin` | `403 NOT_AN_ADMIN` | nothing |
| Body fails the schema; a time is not ISO 8601 UTC; `sha256` is not 64 lowercase hex characters; two files of one request share a `sha256` or an `uploadIndex` | `400 INVALID_REQUEST` | nothing |
| `playedAt` is after the request time, or more than `maxPlayedAtAgeDays` before it | `400 INVALID_PLAYED_AT` | nothing |
| A file is larger than 10 MiB or its `contentType` is not `image/png` or `image/jpeg` | `400 INVALID_FILE`, naming the file | nothing for any file of the request |
| Unknown `matchId`, `uploadId` or `slug` | `404 MATCH_NOT_FOUND`, `404 UPLOAD_NOT_FOUND` | nothing |
| A file's `sha256` is live in this or another match (§6.2 step 3) | `409 IMAGE_ALREADY_UPLOADED`, naming the file and the other match's `slug` | nothing for any file of the request |
| The type is not allowed in the match's state (§4.2), or uploads are added to a voided match | `409 MATCH_VOIDED` or `409 MATCH_ACTIVE` | nothing |
| `supersedesEventId` is not the current event it must name | `409 STALE_SUPERSESSION`, with the current event | nothing |
| The match would exceed `maxUploadsPerMatch` or `maxEventsPerMatch` | `409 MATCH_LIMIT` | nothing |
| The sequence write failed with `412` on 3 attempts in a row | `409 CONCURRENT_CHANGE` | nothing |
| Every slug draw up to `slugMaxSuffixLength` was already reserved (§7.2) | `503 SLUG_UNAVAILABLE` | the request claim only; a retry with the same `clientRequestId` continues |
| Any other storage error after the SDK's retries | `503 UNAVAILABLE` | possibly the objects written before it; the client retries with the same `clientRequestId` or `uploadBatchId`, which continues (§6.6) |

## 5. Match evidence

### 5.1 Layout

```text
[ephemeral/<name>/]match-requests/{clientRequestId}.json          match-request/v1, claims one matchId per create request
[ephemeral/<name>/]match-slugs/{slug}.json                        match-slug/v1, reserves one slug for one matchId
[ephemeral/<name>/]image-index/{sha256}/{uploadId}.json           image-index-entry/v1, one per upload intent
[ephemeral/<name>/]matches/{matchId}/
  events/{sequence}.json                          match-event/v1, sequence zero-padded to 6 digits
  upload-slots/{uploadBatchId}-{uploadIndex}.json  upload-slot/v1, claims one uploadId per slot
  uploads/{uploadId}/intent.json                  upload-intent/v1
  uploads/{uploadId}/receipt.json                 upload-receipt/v1 (written by match-to-csv), at most one per upload
  record/{matchVersion}.json                      match-record/v1, zero-padded to 10 digits
[ephemeral/<name>/]submissions/{submissionId}/...  spec 1 §5.1, for each accepted or rejected upload

Attachments bucket:
[ephemeral/<name>/]uploads/{matchId}/{uploadId}/original  staged upload, expires after 30 days
```

### 5.2 Rules

1. Every evidence object above is written once with `If-None-Match: *`. Match events are never updated or deleted, and a correction is always a new event (§1).
2. Event `sequence` numbers in a match start at 1 and have no gaps. `MATCH_CREATED` is always sequence 1.
3. `MATCH_CREATED` exists before any upload slot, intent or presigned POST of its match. An upload intent exists before its presigned POST is issued, and `process-upload` refuses a staged object without an intent.
4. A slug reservation names exactly one `matchId`, and a match's `MATCH_CREATED` names exactly the slug reserved for it. A reservation whose match has no `MATCH_CREATED` is an orphan: it is never resolved and never reused (§6.6).
5. An upload has at most one receipt, because its key holds no submission or version. `process-upload` writes it after the submission's completion and event, so a receipt always names a submission that finished intake, and the first receipt written for an upload is final.
6. A match record version is written only when its `inputsSha256` differs from the latest version's. Its number is one more than the latest.
7. The staged copy in the attachments bucket is not evidence. The stored original under `submissions/` is, and its SHA-256 is recorded in the receipt.

### 5.3 Document schemas

| Object | `schemaVersion` | Writer | Contents |
| --- | --- | --- | --- |
| `match-requests/{clientRequestId}.json` | `match-request/v1` | `match-write` | `clientRequestId`, `matchId`, `actorSub`, `createdAt` |
| `match-slugs/{slug}.json` | `match-slug/v1` | `match-write` | `slug`, `slugWordsVersion`, `matchId`, `reservedAt` |
| `image-index/{sha256}/{uploadId}.json` | `image-index-entry/v1` | `match-write` | `sha256`, `matchId`, `uploadId`, `createdAt` |
| `events/{sequence}.json` | `match-event/v1` | `match-write` | `MatchEvent` (§10.1) |
| `upload-slots/{uploadBatchId}-{uploadIndex}.json` | `upload-slot/v1` | `match-write` | `uploadBatchId`, `uploadIndex`, `uploadId`, `createdAt` |
| `uploads/{uploadId}/intent.json` | `upload-intent/v1` | `match-write` | `UploadIntent` (§10.1) |
| `uploads/{uploadId}/receipt.json` | `upload-receipt/v1` | `process-upload` | `UploadReceipt` (§10.1) |
| `record/{matchVersion}.json` | `match-record/v1` | `write-match-record` | `MatchRecord` (§10.1) |
| upload submission `ingestion.json` | `upload-submission/v1` | `process-upload` | `submissionId`, `channel: ADMIN_UPLOAD`, `matchId`, `uploadId`, `stagingObject` with `versionId`, `uploadIntakeVersion`, `receivedAt` |
| `source/metadata.json` | `source-screenshot/v1` | `process-email`, `process-upload` | adds an optional `intake` (`channel`, `matchId`, `uploadId`); absent on emailed screenshots |

Submission completion, submission events and every run object keep their spec 1 schemas, except that the run manifest's `inputArtifact` copies the source's `intake`. A `REJECTED` upload completion without an intent carries `error`, which spec 1 sets only on `FAILED` (§6.4 step 4).

### 5.4 Stage versions

| Key | v1 value | Recorded in |
| --- | --- | --- |
| `matchRulesVersion` | `match-record-v1` | every match record version |
| `slugWordsVersion` | `slug-words-v1` | every slug reservation and `MATCH_CREATED` |
| `matchConfigVersion` | `match-config-v1` | every `MATCH_CREATED` |
| `uploadIntakeVersion` | `upload-intake-v1` | upload `ingestion.json`; a change to `process-upload` behavior bumps it |

Any change to §7.3 bumps `matchRulesVersion`, which changes `inputsSha256`, so the next record write of every match writes a new version. A change to the word lists adds `slug-words-v<n>.json`; existing slugs never change (§7.2). A change to a §7.4 limit adds `match-config-v<n>.json`.

## 6. Processes

### 6.1 Match creation

`createMatch(request, dependencies)` in `match-write` performs these steps in order. Each step can be repeated by a retried request with the same `clientRequestId` and finds what an earlier attempt wrote.

1. Read `sub` and require `admin` (§4.3). Validate the body, including `playedAt` and every file.
2. Write `match-requests/{clientRequestId}.json` with a new `matchId` and `If-None-Match: *`. On `412`, read the claim and use its `matchId`. When that match already has `MATCH_CREATED`, continue at step 6.
3. Run the duplicate image check (§6.2 step 3) for every file. On a conflict, return `409 IMAGE_ALREADY_UPLOADED` and write nothing more. The claim stays, and a retry with the same `clientRequestId` checks again.
4. Draw a slug (§7.2) and write `match-slugs/{slug}.json` naming the `matchId`, with `If-None-Match: *`. On `412`, draw again, lengthening the suffix as §7.2 states. When the last draw at `slugMaxSuffixLength` also returns `412`, return `503 SLUG_UNAVAILABLE`.
5. Write `matches/{matchId}/events/000001.json`, `MATCH_CREATED`, with `If-None-Match: *`. `occurredAt` is the handler's clock, `playedAt` is the request's or `occurredAt`, and `declaredScreenshotCount` is the number of files. On `412`, another attempt for this claim created the match first: read it and continue at step 6. The slug this attempt reserved stays an orphan.
6. Request the uploads with `uploadBatchId` equal to `clientRequestId` (§6.2 steps 2 to 5), skipping the duplicate check for files whose slot already exists.
7. Log `Match created` with `matchId`, `fileCount` and `requestId`, and return `201`, or `200` when step 2 found a claim.

### 6.2 Upload request

`requestUploads(matchId, request, dependencies)` in `match-write`, used by match creation and by `POST /api/v1/matches/{matchId}/uploads`:

1. For the add route, validate as §6.1 step 1, read the match's events and require an active match. Refuse with `409 MATCH_LIMIT` when the uploads already requested plus the new files would exceed `maxUploadsPerMatch`.
2. For each file, write `upload-slots/{uploadBatchId}-{uploadIndex}.json` holding a new `uploadId` with `If-None-Match: *`. On `412`, read the slot and use the `uploadId` it holds, so two concurrent requests for one slot share one upload.
3. **Duplicate image check.** For each file whose slot was new, list `image-index/{sha256}/`. An entry for another upload is live unless its match is voided, its upload's current membership event is `SCREENSHOT_EXCLUDED`, or its upload's receipt is `REJECTED`, each read from that match's events and receipts. A live entry refuses the whole request with `409 IMAGE_ALREADY_UPLOADED` before any intent is written. The slots stay, and a later request with the same pair reuses them.
4. For each file, write `image-index/{sha256}/{uploadId}.json` and then `uploads/{uploadId}/intent.json`, both create-only, treating `412` as written.
5. For each intent, create a presigned POST for the attachments bucket key `[ns]uploads/{matchId}/{uploadId}/original` that expires in 600 seconds, with the conditions `key` equal to that key, `Content-Type` equal to the intent's `contentType`, and `content-length-range` from 1 to the intent's `sizeBytes`.
6. Return the intents and their POSTs. The browser posts each file in `uploadIndex` order, at most 3 at a time.

### 6.3 Match event write

`writeMatchEvent(request, dependencies)` in `match-write`:

1. Validate as §6.1 step 1.
2. List `matches/{matchId}/events/` and read every event, giving the latest sequence `n`. When an event has the request's `clientRequestId`, return it with `200`.
3. Fold the events (§7.1) and check the request against the folded state (§4.2, §4.3). For `SCREENSHOT_RESTORED`, run the duplicate image check for the upload's `sha256`, ignoring the upload's own entry.
4. Write `events/{n + 1}.json` with `If-None-Match: *`. On `412`, return to step 2, at most 3 attempts in all, then return `409 CONCURRENT_CHANGE`.
5. Log `Match event written` with `matchId`, `type`, `sequence` and `requestId`, and return `201`.

### 6.4 Upload intake in match-to-csv

The attachments bucket's EventBridge rule (§13.3) starts the main workflow with `{ bucket, key, versionId, channel: "ADMIN_UPLOAD" }`. The raw-email rule's input becomes `{ bucket, key, channel: "EMAIL" }`. The new first state, **Route intake**, is a `Choice` on `$.channel`: `ADMIN_UPLOAD` goes to **Process upload**, and every other value, including a missing field, goes to **Process email and attachments** (spec 1 §6.1). Both replace the state with a `ProcessEmailOutput`, and the workflow continues at **Process attachments**.

`processUpload(event, dependencies)` performs these steps in order:

1. Parse the key as `[ns]uploads/{matchId}/{uploadId}/original`, and require that `[ns]` equals the stack's `OBJECT_PREFIX`.
2. Read `[ns]matches/{matchId}/uploads/{uploadId}/receipt.json`. When it exists, the upload's intake is already decided: log `Upload already received` with `matchId`, `uploadId` and the receipt's `submissionId`, and write nothing. An `ACCEPTED` receipt returns `{ submissionId, screenshots: [screenshot], rejectedAttachments: [] }` from the receipt. A `REJECTED` receipt throws as step 6 does.
3. Create a `submissionId` and write `ingestion.json` (`upload-submission/v1`).
4. Read `[ns]matches/{matchId}/uploads/{uploadId}/intent.json`. When it does not exist, write a `REJECTED` completion with no screenshot, no rejected attachment and `error` `{ name: "UploadIntentMissingError" }`, append `SUBMISSION_REJECTED` with the same `error` in its `detail`, and throw `UploadIntentMissingError`. No source and no receipt are written.
5. Read the staged object at `versionId`, store its bytes as `screenshots/{screenshotId}/source/original`, and run Sharp metadata and spec 1's attachment checks (§4.3) with the intent's normalized `fileName` as `attachmentName`. When the stored bytes' SHA-256 differs from the intent's `sha256`, add the rejection code `SHA256_MISMATCH`. Write `source/metadata.json` with `intake` `{ channel: "ADMIN_UPLOAD", matchId, uploadId }`. No EXIF field or file time is read or recorded for placement.
6. Write the submission completion and event as spec 1 does, then the receipt with `If-None-Match: *` as the last write. With the image rejected, the receipt is `REJECTED`, and the stage throws after writing it, so the execution fails as a rejected email does.
7. When the receipt write returns `412`, another intake run for the upload wrote its receipt first. Read that receipt and finish as step 2 does. This run's submission keeps its completion but has no receipt, so no match record lists it and no execution extracts its screenshot.
8. Return `{ submissionId, screenshots: [source], rejectedAttachments: [] }`.

Errors after step 3 and before the completion is written record `FAILED` and `SUBMISSION_FAILED` on a best-effort basis and rethrow, as spec 1 P2.3 requires of `process-email`. `ExtractText` copies `source.intake` into the run manifest's `inputArtifact.intake`, so every run, including a replay, names its `matchId`.

### 6.5 Match record writing

An EventBridge rule in the admin stack matches evidence bucket `Object Created` events whose key matches `[ns]matches/*/events/*`, `[ns]matches/*/uploads/*/intent.json` or `[ns]matches/*/uploads/*/receipt.json`, and invokes `WriteMatchRecord` asynchronously with the key. An operator may also invoke it with `{ matchId }`.

`writeMatchRecord(matchId, dependencies)`:

1. List and read every event, intent and receipt of the match. When the match has no `MATCH_CREATED`, stop.
2. Compute `inputsSha256`: the SHA-256 of the input object keys sorted bytewise and joined with `\n`, followed by `\n` and `matchRulesVersion`.
3. Read the latest record version. When its `inputsSha256` is equal, stop.
4. Run `buildMatchRecord(events, intents, receipts)` (§7.3) and write version `latest + 1` with `If-None-Match: *`. On `412`, return to step 1, at most 3 attempts in all, then throw `ConcurrentMatchRecordError`.
5. Log `Match record written` with `matchId`, `matchVersion` and the counts in §10.1.

`WriteMatchRecord` has a reserved concurrency of 1, so writes never race in normal operation. Lambda retries a throttled asynchronous event for up to 6 hours and a failed one twice, then sends it to the function's dead-letter queue, `<stack>-match-record-dlq`. The rule sends events it cannot deliver to the same queue.

### 6.6 Retries and failure

- A create request that fails part way leaves a claim, and possibly a slug reservation, `MATCH_CREATED`, slots, index entries and intents. The client retries with the same `clientRequestId`, and §6.1 continues from what exists. A request abandoned after step 4 leaves an orphan slug reservation, which costs one slug from the space of §7.2 and nothing else.
- A request abandoned after step 5 leaves a match that may have fewer intents than `declaredScreenshotCount`. Its record flags `UPLOADS_MISSING` (§7.3), and the admin adds the files or voids the match.
- `MatchWrite` relies on the SDK's default retries and returns `503 UNAVAILABLE` for other storage errors.
- A presigned POST that expires before the browser posts returns `403` from S3. The client repeats the request with the same `clientRequestId` or `(uploadBatchId, uploadIndex)` and receives a fresh POST for the same `uploadId`.
- Intake can run more than once for one upload: a Step Functions retry of `ProcessUpload`, an operator restarting a failed execution with the same input, a duplicate EventBridge delivery, or a second POST of the same key within the 600 seconds. Each run first reads the upload's receipt (§6.4 step 2). Once the receipt exists, every run returns its screenshot and writes nothing.
- A run that fails before the receipt is written leaves its submission with a `FAILED` completion, or a `SUCCEEDED` one when only the receipt write failed, and no receipt. The next run creates a new submission. Two concurrent runs both create submissions, the first receipt write wins, and the other run returns the winner's screenshot. No match record lists a submission without a receipt.
- An execution that fails after its receipt was written leaves an accepted screenshot with no run. An operator recovers it by starting the main workflow again with the execution's input.
- A failed record write leaves the earlier version as the latest. The next input change, or the operator rebuild, writes the missing version.

## 7. Match rules and slugs

### 7.1 Folding events

`foldMatch(events)` in `src/lib/match-events.ts` is pure.

1. Events apply in `sequence` order. Sequence 1 is `MATCH_CREATED`.
2. `slug`, `slugWordsVersion`, `game` and `createdAt` come from `MATCH_CREATED` and never change.
3. `playedAt`, `playedAtSource` and `note` come from the current details event (§4.2).
4. `status` is `VOIDED` after a `MATCH_VOIDED` that no `MATCH_RESTORED` supersedes, otherwise `ACTIVE`. `voidReason` is that event's reason, or `null`.
5. Each upload's membership is `EXCLUDED` with the event's reason when its current membership event is `SCREENSHOT_EXCLUDED`, otherwise `INCLUDED`.

### 7.2 Slugs

A slug is `<word>-<suffix>`. `word` is drawn uniformly from the 176 words below, which form one pool; the groups only show where each word comes from. `suffix` is `n` characters drawn uniformly from the Crockford base32 alphabet in lowercase, `0123456789abcdefghjkmnpqrstvwxyz`, which leaves out `i`, `l`, `o` and `u` so a slug can be read aloud and typed without confusing letters and digits. Both draws use `crypto.randomInt`, and each attempt draws a new word and a new suffix. A slug matches `^[a-z]{3,12}-[0-9a-hjkmnp-tv-z]{4,8}$`.

`n` starts at `slugSuffixLength` (4). After `slugAttemptsPerLength` (4) draws in a row at length `n` are already reserved, the next draws use `n + 1`, up to `slugMaxSuffixLength` (8). Every extra character multiplies the space by 32, so the pool never runs out in practice; the cap only bounds the pattern. The suffix is random and carries no checksum, time or part of `matchId`.

`GET /api/v1/match-slugs/{slug}` lowercases the slug and, in the suffix only, reads `i` and `l` as `1` and `o` as `0`, as Crockford decoding does, so a slug copied by hand with those characters still resolves.

The words are bundled in `applications/admin/config/slug-words-v1.json`, which is immutable once released, and `loadSlugWords` validates them at cold start: every word is 3 to 12 lowercase ASCII letters, no word appears twice, and the pool has at least 64 words.

Words come from Halo terminology: multiplayer maps from every game in the Master Chief Collection, vehicles, weapons, equipment and armor abilities, species and factions, and Halo 3 medals and game types. A word is used only when the term is one word as players write it, so `High Ground`, `The Pit` and `Battle Rifle` are left out rather than joined. Named characters and real people are left out, as are words that read badly out of context.

**Maps (64)**

| Game | Words |
| --- | --- |
| Halo 3 | `assembly`, `avalanche`, `blackout`, `citadel`, `construct`, `epitaph`, `foundry`, `guardian`, `heretic`, `icebox`, `isolation`, `longshore`, `narrows`, `orbital`, `sandbox`, `sandtrap`, `snowbound`, `standoff`, `valhalla`, `waterfall` |
| Halo: Combat Evolved | `derelict`, `infinity`, `sidewinder`, `timberland`, `wizard` |
| Halo 2 | `ascension`, `backwash`, `coagulation`, `colossus`, `containment`, `elongation`, `headlong`, `lockout`, `midship`, `relic`, `sanctuary`, `terminal`, `turf`, `uplift`, `warlock`, `zanzibar` |
| Halo: Reach | `boardwalk`, `breakpoint`, `countdown`, `pinnacle`, `powerhouse`, `reflection`, `tempest`, `zealot` |
| Halo 4 | `adrift`, `haven`, `monolith`, `pitfall`, `ragnarok`, `skyline`, `solace`, `vertigo`, `vortex` |
| Halo 2: Anniversary | `bloodline`, `lockdown`, `remnant`, `shrine`, `stonetown`, `zenith` |

**Vehicles, weapons, equipment and forces (64)**

| Group | Words |
| --- | --- |
| Vehicles | `banshee`, `chopper`, `elephant`, `falcon`, `ghost`, `hornet`, `mantis`, `mongoose`, `pelican`, `phantom`, `prowler`, `revenant`, `scorpion`, `spectre`, `spirit`, `warthog`, `wraith` |
| Weapons | `boltshot`, `carbine`, `chaingun`, `firebomb`, `flamethrower`, `frag`, `gauss`, `hammer`, `magnum`, `mauler`, `needler`, `plasma`, `railgun`, `ravager`, `rocket`, `scattershot`, `shotgun`, `skewer`, `sniper`, `spiker`, `sword`, `turret` |
| Equipment, power-ups and armor abilities | `camo`, `evade`, `flare`, `hologram`, `jammer`, `jetpack`, `overshield`, `regenerator`, `sprint`, `teleporter`, `thruster` |
| Species and factions | `brute`, `covenant`, `drone`, `elite`, `flood`, `forerunner`, `grunt`, `hunter`, `jackal`, `mjolnir`, `monitor`, `sentinel`, `spartan`, `odst` |

**Medals, game types and plays (48)**

| Group | Words |
| --- | --- |
| Halo 3 medals | `assassin`, `bulltrue`, `frenzy`, `highjacker`, `killimanjaro`, `killionaire`, `killjoy`, `killtacular`, `killtrocity`, `invincible`, `overkill`, `perfection`, `rampage`, `sharpshooter`, `skyjacker`, `splatter`, `steaktacular`, `unstoppable`, `untouchable`, `wheelman` |
| Game types | `assault`, `dominion`, `grifball`, `headhunter`, `infection`, `juggernaut`, `oddball`, `regicide`, `ricochet`, `slayer`, `swat`, `territories` |
| Plays and postgame | `beatdown`, `betrayal`, `carnage`, `comeback`, `headshot`, `killcam`, `medal`, `noscope`, `postgame`, `pummel`, `ragdoll`, `rematch`, `respawn`, `spree`, `sticky`, `victory` |

With a 4-character suffix the pool holds 176 x 32^4 = 184,549,376 slugs per namespace. A draw collides with probability `reserved / 184,549,376`, about 0.005% after 10,000 matches, and `match-write` draws again on a collision (§6.1 step 4). Slugs are 8 to 17 characters long. Examples: `warthog-7k3q`, `killtacular-m2x9`, `lockout-b8fn`, `oddball-x04t`.

A later word list is a new file with a new `slugWordsVersion`. It may add words and may stop drawing a word, but a slug already reserved never changes and is never reused, whichever version drew it. Raising `slugSuffixLength` is a new configuration version and changes no existing slug.

### 7.3 Match record

`buildMatchRecord(events, intents, receipts)` in `src/lib/match-record.ts` is pure and deterministic.

1. Fold the events (§7.1).
2. Upload order is the intent's `requestedAt`, then `uploadIndex`, then `uploadId`; `uploadIndex` restarts in every request. An upload is `PENDING` without a receipt, `REJECTED` with a `REJECTED` receipt and `ACCEPTED` with an `ACCEPTED` one. Only an `ACCEPTED` upload has a screenshot, the receipt's.
3. Each accepted screenshot takes the first matching row:

   | Condition | `status` | `reason` |
   | --- | --- | --- |
   | The upload's membership is `EXCLUDED` | `EXCLUDED` | the event's reason |
   | Its `imageSha256` equals that of a screenshot earlier in upload order in this match that is not `EXCLUDED` | `DUPLICATE` | `null`, with `duplicateOf` set to that screenshot |
   | otherwise | `ACTIVE` | `null` |

4. `screenshotIds` lists the `ACTIVE` screenshots in upload order.
5. Flags: `NO_SCREENSHOT` when no screenshot is `ACTIVE` and no upload is `PENDING`; `UPLOADS_PENDING` when an upload is `PENDING`; `UPLOADS_MISSING` when the match has fewer intents than `declaredScreenshotCount`; `MULTIPLE_SCREENSHOTS` when two or more screenshots are `ACTIVE`.
6. The record does not decide that a pending upload is lost, because that would depend on the clock at write time.

A match counts for statistics only when its `status` is `ACTIVE`, and a screenshot only when its `status` is `ACTIVE`. Which `ACTIVE` screenshot feeds statistics, and how pages merge, is the lakehouse's decision.

### 7.4 Parameters

`match-config-v1.json` is bundled with the admin Lambdas, immutable once released, and validated at cold start.

| Parameter | v1 value | Notes |
| --- | --- | --- |
| `maxFilesPerRequest` | 10 | Files in one create or add request. |
| `maxUploadsPerMatch` | 20 | Every upload of a match, including rejected and excluded ones. |
| `maxEventsPerMatch` | 200 | |
| `maxPlayedAtAgeDays` | 14 | §4.3. |
| `slugSuffixLength` | 4 | §7.2. |
| `slugAttemptsPerLength` | 4 | §7.2. |
| `slugMaxSuffixLength` | 8 | §7.2. |

These are initial values. A change is a new configuration version filed as its own issue.

## 8. Contract for consumers and relationship with other specs

### 8.1 The match contract

The admin application owns the contract, and `@mcc/contracts` exports its types (§10.1). Consumers read these evidence objects, all create-only:

| Object | Consumers use it for |
| --- | --- |
| `matches/{matchId}/record/{matchVersion}.json` | The match's `slug`, `status`, `playedAt` and `game`, and the `status` of each of its screenshots. Read the highest version. |
| `matches/{matchId}/events/{sequence}.json` | Audit. |
| `match-slugs/{slug}.json` | Resolving a slug a person typed or a URL holds. |

A run joins its match without the record: its manifest's `inputArtifact.intake.matchId`, or `intake.matchId` in its screenshot's `source/metadata.json`, names the match from the moment the screenshot is stored. A screenshot whose source has no `intake` came by email and has no match. The latest record then says whether the match and the screenshot count: a consumer counts a run only when the match is `ACTIVE` and the record lists the run's `screenshotId` as `ACTIVE`. A consumer treats an uploaded screenshot that no record lists yet as not counted, because the record is written after the receipt.

The contract guarantees:

- **The match exists first.** Every `matchId` in an intake was created by a `MATCH_CREATED` written before the screenshot was staged (§5.2 rule 3).
- **Membership never changes.** A screenshot's `matchId` is fixed at upload. Only its `status` in the match changes, through exclusion and restoration.
- **One screenshot per upload, and it is the extracted one.** A record lists at most one screenshot per upload, the one in the upload's receipt, and every execution that reaches extraction extracts it (§6.4).
- **`DUPLICATE` means a repeated image within the match, never a retry.**
- **The slug is fixed.** A record's `slug` never changes between versions.

The lakehouse (#159) ingests every record version and selects the latest per match. A correction reaches it as a new version.

### 8.2 Maps

No specification covers map suggestions or map selection, because the admin application does not select maps. A map recorded from a postgame screen would be a new specification (P6.3).

### 8.3 Spec 7

Spec 7 reads match membership for `K006` and `K007` peers and for dataset grouping: a screenshot's match is its `intake.matchId`; its peers are the other `ACTIVE` screenshots of the highest record version of an `ACTIVE` match; the record version read is recorded as `matchVersion`; and spec 7's roles read `<ns>matches/*/record/*` and nothing else under `<ns>matches/`. Emailed screenshots still have no match and record `NO_MATCH_IDENTITY`.

### 8.4 Spec 9, the stats lakehouse (#159)

[Spec 9](9-stats-lakehouse.md) reads the session-association contract. Its next revision makes these changes:

| Spec 9 reads | Change |
| --- | --- |
| `session-association/v1` under `sessions/*/association/*` | `match-record/v1` under `matches/*/record/*`, one current record per match. |
| `map-catalog/v1`, `mapId`, `mapName`, `silver_maps` | Removed. v1 matches have no map. |
| `sessionId`, `silver_sessions`, `matchIndex`, `origin`, `selectedAt` | Removed. Matches are ordered by `playedAt`, then `matchId` (§1). |
| `playedAt` from `selectedAt`, capture time or session end | `playedAt` from the record. |
| `runContext.channel` `SESSION_UPLOAD` with `sessionId` | `ADMIN_UPLOAD` with `matchId` and `uploadId`. |
| `matchRole` `NO_SESSION`, `NOT_ASSOCIATED`, `MATCH_MEMBER`, `ASSOCIATION_DUPLICATE` | `NO_MATCH` (emailed), `NOT_COUNTED` (match voided, screenshot excluded or not yet listed), `MATCH_MEMBER` (`ACTIVE`), `MATCH_DUPLICATE`. |
| Statuses `DERIVED`, `HOST_ASSIGNED`, `UNASSIGNED` | `ACTIVE`; there is no unassigned uploaded screenshot. |
| Host fixes by `SCREENSHOT_EXCLUDED` with `OTHER` | Admin fixes by `SCREENSHOT_EXCLUDED`, usually `WRONG_MATCH` or `NOT_A_SCOREBOARD`. |
| Gold shows `matchId` | Gold also shows `slug`, which the player app uses in URLs. |

### 8.5 Spec 1, spec 2, spec 3 and spec 6

- **Spec 1.** Match-to-csv still creates no match (spec 1 §2.2). It gains a second intake channel. P3.1 and P3.2 update spec 1 in the same PR as the behavior: §1 and §2.1 (admin upload beside email), §3 and §6.1 (the **Route intake** state and the upload rule), §4 (upload intake and the `SHA256_MISMATCH` rejection code), §5.1 and §5.3 (`upload-submission/v1`, `upload-receipt/v1`, and `intake` on `source-screenshot/v1` and in the run manifest's `inputArtifact`), §6.3, §10.1, §11, §13.1 (attachments bucket notifications, CORS and `uploads/` expiry), §13.2, §13.4 and §16.1.
- **Spec 2.** §8.5 rule 6 waits for a match identity. It is `intake.matchId`, which spec 7 already adopts for grouping.
- **Spec 3.** The admin screens and match routes live in spec 3's application, API and stack. Spec 3's next revision lists the `admin` group beside `labeler`, adds the attachments bucket's regional endpoint to the Content Security Policy's `connect-src` (spec 3 §13.3), and points "match records" at this spec. Review does not depend on matches.
- **Spec 6.** The roster resolves names per run and has no match entity. Its non-goal "grouping screenshots into matches (#159)" should point to this spec in its next revision.

### 8.6 Recorded dependencies

| Dependency | Owner | Handled by |
| --- | --- | --- |
| Admin workspace and web scaffold; the admin stack, HTTP API and distribution | spec 3 P0.1, P3.4 | P0.2, P2.1, P2.2 and P4.1 are blocked by P0.1, and P4.4 by P3.4. |
| Reviewer user pool, to which P1.1 adds `admin` | spec 3 P1.1 | P1.1 is blocked by it. |
| Local bootstrap permissions for `admin-e-*` stacks | spec 3 P1.2 | P4.4 adds the match statements; whichever merges later keeps the other's. |
| Sign-in and the application shell | spec 3 P4.1 | P5.1 is blocked by it. |
| Content Security Policy `connect-src` for the attachments bucket | spec 3 §13.3 | P4.4 sets it; spec 3's next revision records it. |
| Evidence bucket EventBridge notifications | spec 2 P1.1 | P4.4 cannot deploy until it is applied. |
| Spec 1 sections in §8.5 | spec 1 | P3.1 and P3.2. |
| Spec 7 references in §8.3 | spec 7 | Spec 7 §4.3 reads them. |
| Lakehouse changes in §8.4 | spec 9 | Spec 9's next revision. |

## 9. Admin experience

The admin screens are routes in spec 3's application, shown to users in the `admin` group, and laid out for a phone held in portrait. Every match URL is `/matches/{slug}`; the screen resolves the slug through `GET /api/v1/match-slugs/{slug}`.

- **Matches.** A list newest first with each match's slug, `playedAt`, screenshot count, status and flags, and a **New match** button.
- **New match.** The admin picks the match's screenshots, optionally sets the time it was played and a note, and taps **Create match**. The screen computes each file's SHA-256 with `crypto.subtle.digest`, sends one create request, shows the new slug at once, and then posts the files and shows each file's state until its receipt appears. A retry after a lost response reuses the same `clientRequestId`.
- **Match.** The slug as the heading, the play time and note, thumbnails with each screenshot's status, and the flags. Actions: add screenshots, exclude or restore a screenshot, correct the play time or note, and void or restore the match. Each action writes one event (§4.2). `STALE_SUPERSESSION` and `CONCURRENT_CHANGE` show as "someone else changed this match", with a reload.
- **Duplicate refused.** `IMAGE_ALREADY_UPLOADED` names the other match's slug and links to it, so the admin can exclude it there first when it was uploaded to the wrong match.

## 10. Typed domain model

### 10.1 Shared contracts

`@mcc/contracts` exports:

```typescript
type IntakeChannel = 'EMAIL' | 'ADMIN_UPLOAD';

interface ScreenshotIntake {
  channel: IntakeChannel;
  matchId?: string; // ADMIN_UPLOAD only
  uploadId?: string; // ADMIN_UPLOAD only
}

// Added to spec 1's SourceScreenshot and the run manifest's inputArtifact as an optional field.
interface SourceScreenshot { /* spec 1 fields */ intake?: ScreenshotIntake }

interface ProcessUploadInput extends S3ObjectReference {
  versionId: string;
  channel: 'ADMIN_UPLOAD';
}

type GameCode = 'halo3';

type MatchEventType =
  | 'MATCH_CREATED' | 'DETAILS_CORRECTED' | 'MATCH_VOIDED' | 'MATCH_RESTORED'
  | 'SCREENSHOT_EXCLUDED' | 'SCREENSHOT_RESTORED';

type VoidReason = 'NOT_A_MATCH' | 'DUPLICATE_MATCH' | 'TEST' | 'OTHER';
type ExclusionReason = 'NOT_A_SCOREBOARD' | 'WRONG_MATCH' | 'UNREADABLE' | 'OTHER';
type PlayedAtSource = 'UPLOAD_TIME' | 'ADMIN_ENTERED';

interface MatchEventDetails {
  MATCH_CREATED: {
    slug: string; slugWordsVersion: string; matchConfigVersion: string; game: GameCode;
    playedAt: string; playedAtSource: PlayedAtSource; note: string | null;
    declaredScreenshotCount: number;
  };
  DETAILS_CORRECTED: { playedAt: string; note: string | null };
  MATCH_VOIDED: { reason: VoidReason; comment: string | null };
  MATCH_RESTORED: Record<string, never>;
  SCREENSHOT_EXCLUDED: { uploadId: string; reason: ExclusionReason };
  SCREENSHOT_RESTORED: { uploadId: string };
}

type MatchEvent = {
  [T in MatchEventType]: {
    schemaVersion: 'match-event/v1';
    eventId: string;
    matchId: string;
    sequence: number; // 1-based, no gaps; MATCH_CREATED is 1
    type: T;
    occurredAt: string; // server clock, ISO 8601 UTC with milliseconds
    actorSub: string; // Cognito sub
    clientRequestId: string; // UUID
    clientTime: string | null; // browser clock when the request was sent
    supersedesEventId: string | null;
    detail: MatchEventDetails[T];
    build: { gitSha: string; environment: string };
  };
}[MatchEventType];

interface UploadIntent {
  schemaVersion: 'upload-intent/v1';
  uploadId: string;
  matchId: string;
  uploadBatchId: string; // the create request's clientRequestId, or a UUID from the client
  uploadIndex: number; // 0-based position in the admin's selection
  fileName: string; // normalized as spec 1 §4.3
  contentType: 'image/png' | 'image/jpeg';
  sizeBytes: number;
  sha256: string; // declared by the browser, verified by process-upload
  clientTime: string;
  requestedAt: string;
  actorSub: string;
  stagingObject: S3ObjectReference;
}

interface UploadReceipt {
  schemaVersion: 'upload-receipt/v1';
  matchId: string;
  uploadId: string;
  submissionId: string;
  stagingObject: S3ObjectReference & { versionId: string };
  status: 'ACCEPTED' | 'REJECTED';
  rejectionCodes: AttachmentRejectionCode[]; // spec 1's codes plus SHA256_MISMATCH
  screenshot: SourceScreenshot | null; // set for ACCEPTED
  receivedAt: string;
}

type MatchScreenshotStatus = 'ACTIVE' | 'EXCLUDED' | 'DUPLICATE';
type MatchFlag = 'NO_SCREENSHOT' | 'UPLOADS_PENDING' | 'UPLOADS_MISSING' | 'MULTIPLE_SCREENSHOTS';

interface MatchScreenshot {
  screenshotId: string;
  submissionId: string;
  uploadId: string;
  uploadIndex: number;
  imageSha256: string;
  status: MatchScreenshotStatus;
  reason: ExclusionReason | null;
  duplicateOf: string | null; // screenshotId
  membershipEventId: string | null;
}

interface MatchUpload {
  uploadId: string;
  uploadIndex: number;
  state: 'PENDING' | 'REJECTED' | 'ACCEPTED';
  rejectionCodes: AttachmentRejectionCode[];
  screenshotId: string | null; // the receipt's screenshot when ACCEPTED
}

interface MatchRecord {
  schemaVersion: 'match-record/v1';
  matchId: string;
  slug: string;
  matchVersion: number;
  previousMatchVersion: number | null;
  inputsSha256: string;
  eventsThroughSequence: number;
  writtenAt: string;
  versions: { matchRulesVersion: string; slugWordsVersion: string };
  game: GameCode;
  status: 'ACTIVE' | 'VOIDED';
  voidReason: VoidReason | null;
  createdAt: string;
  playedAt: string;
  playedAtSource: PlayedAtSource;
  note: string | null;
  declaredScreenshotCount: number;
  screenshotIds: string[]; // ACTIVE screenshots in upload order (§7.3)
  screenshots: MatchScreenshot[]; // one per accepted upload
  uploads: MatchUpload[];
  flags: MatchFlag[];
  counts: {
    uploads: number; pendingUploads: number; rejectedUploads: number;
    active: number; excluded: number; duplicate: number;
  };
  build: { gitSha: string; environment: string };
}
```

Handlers validate every request and every object they read against these types with schema validators at the trust boundary. A `MatchEvent`, intent or record never holds an email address, a file path from the admin's device, or image bytes.

### 10.2 Relationships

```text
Match 1 -> 1 slug reservation; 1 -> many MatchEvent (sequence 1..n, MATCH_CREATED first)
Match 1 -> many UploadIntent -> 0..1 UploadReceipt -> 0..1 SourceScreenshot (intake.matchId)
SourceScreenshot 1 -> many processing runs (spec 1), each with inputArtifact.intake.matchId
Match 1 -> many MatchRecord versions; the latest is current
```

## 11. Module and function catalog

### 11.1 Lambda entry points

| File | Public functions | Purpose |
| --- | --- | --- |
| `applications/admin/src/lambdas/match-read.ts` | `handler(event)`; `readMatch(...)`; `listMatches(...)`; `resolveSlug(...)` | Read routes in §4.1, with the live record preview. |
| `applications/admin/src/lambdas/match-write.ts` | `handler(event)`; `createMatch(...)`; `requestUploads(...)`; `writeMatchEvent(...)` | §6.1 to §6.3. |
| `applications/admin/src/lambdas/write-match-record.ts` | `handler(event)`; `writeMatchRecord(matchId, dependencies)` | §6.5. |
| `applications/match-to-csv/src/lambdas/process-upload.ts` | `handler(event)`; `processUpload(event, dependencies)` | §6.4. |

### 11.2 Libraries

| File | Public functions | Purpose |
| --- | --- | --- |
| `applications/admin/src/lib/match-events.ts` | `foldMatch(events)`; `checkMatchEvent(state, request)` | Pure §7.1 and the rules in §4.2 and §4.3. |
| `applications/admin/src/lib/match-record.ts` | `buildMatchRecord(events, intents, receipts)`; `matchRecordInputsSha256(keys, version)` | Pure §7.3. |
| `applications/admin/src/lib/slug.ts` | `loadSlugWords(version?)`; `drawSlug(words, suffixLength, randomInt)`; `isSlug(text)`; `normalizeSlug(text)` | §7.2, with the random source injected. |
| `applications/admin/src/lib/match-store.ts` | `claimRequest`, `reserveSlug`, `listEvents`, `putEvent`, `putSlot`, `putIntent`, `listImageIndex`, `putImageIndex`, `latestRecord`, `putRecord` | Evidence keys and create-only writes. |
| `applications/admin/src/lib/upload-post.ts` | `presignUpload(intent, dependencies)` | Presigned POST with the §6.2 conditions. |
| `applications/match-to-csv/src/lib/image-acceptance.ts` | `attachmentRejectionCodes(...)` | Moved from `process-email.ts` unchanged, so both intake Lambdas share it. |

### 11.3 Web application

| Path | Purpose |
| --- | --- |
| `applications/admin/web/src/matches/` | The screens in §9, the upload queue, SHA-256 hashing, and the match API client. |

### 11.4 Infrastructure code

| File | Change | Purpose |
| --- | --- | --- |
| `infrastructure/modules/foundation/cognito.tf` | `admin` group | §13.2. |
| `infrastructure/modules/foundation/main.tf` | attachments bucket notifications, CORS and `uploads/` lifecycle | §13.2. |
| `applications/admin/cdk/lib/admin-stack.ts` | match Lambdas, routes, rule, DLQ, IAM | §13.3, §13.4. |
| `applications/match-to-csv/cdk/lib/match-to-csv-stack.ts` | `ProcessUpload`, **Route intake**, upload rule, IAM | §13.3, §13.4. |

## 12. Directory structure and ownership

```text
mcc-stats-suite/
  applications/admin/
    config/
      slug-words-v1.json             # Bundled, immutable once released
      match-config-v1.json           # Bundled, immutable once released
    src/
      lambdas/{match-read,match-write,write-match-record}.ts
      lib/{match-events,match-record,slug,match-store,upload-post}.ts
    test/
      matches/*.test.ts
      fixtures/matches/*.fixture.json    # Event, intent and receipt sets with expected records
    web/src/matches/
  applications/match-to-csv/
    src/lambdas/process-upload.ts
    src/lib/image-acceptance.ts
  packages/contracts/src/index.ts    # §10.1
  infrastructure/modules/foundation/{cognito,main}.tf
```

`admin` keeps spec 3's import rule: only `@mcc/contracts`, `@mcc/cdk-config` and `@mcc/roster` from the monorepo. `process-upload` reads admin's intents through `@mcc/contracts` types and imports nothing from `admin`. `web/` imports only `@mcc/contracts` types.

## 13. Configuration and infrastructure

### 13.1 Configuration schema

```json
{
  "matchConfigVersion": "match-config-v1",
  "maxFilesPerRequest": 10,
  "maxUploadsPerMatch": 20,
  "maxEventsPerMatch": 200,
  "maxPlayedAtAgeDays": 14,
  "slugSuffixLength": 4,
  "slugAttemptsPerLength": 4,
  "slugMaxSuffixLength": 8
}
```

`loadMatchConfig` validates every key at cold start: every value is a positive integer `maxFilesPerRequest` is at most `maxUploadsPerMatch`, and `slugSuffixLength` is from 4 to `slugMaxSuffixLength`, which is at most 8. It throws `InvalidMatchConfigError` on any problem. `slug-words-v1.json` holds `{ "slugWordsVersion": "slug-words-v1", "words": [...] }` with the 176 words of §7.2, validated as §7.2 states. Neither file holds a secret.

### 13.2 Persistent resources

| Resource | Owner | Configuration |
| --- | --- | --- |
| Evidence bucket, KMS data key | OpenTofu foundation | Existing (spec 1 §13.1), with EventBridge notifications from spec 2 P1.1. |
| Cognito group `admin` | OpenTofu foundation (P1.1) | On spec 3's user pool. Operators add admins with the Cognito console or CLI. |
| Attachments bucket | OpenTofu foundation (P1.2) | Existing. P1.2 turns on EventBridge notifications; adds a CORS rule allowing `POST` from any origin with no exposed headers and a 3,000-second max age; and adds a lifecycle rule that expires `uploads/` objects after 30 days and their noncurrent versions after 1 day. Ephemeral `ephemeral/<name>/uploads/` objects already expire under the `ephemeral/` rule. |
| SSM parameters | OpenTofu foundation | Existing. Both stacks read `/mcc/<env>/match-to-csv/attachments-bucket-name`. |

The foundation knows nothing about either stack. The CORS rule names no CloudFront domain, because the presigned policy, not the origin, authorizes each POST (§14).

### 13.3 Application resources

| Resource | Stack | Configuration |
| --- | --- | --- |
| `MatchRead` | admin | Node.js 22, ARM64, 1,024 MB, 10-second timeout, X-Ray, env `EVIDENCE_BUCKET`, `OBJECT_PREFIX` |
| `MatchWrite` | admin | Node.js 22, ARM64, 1,024 MB, 25-second timeout, X-Ray, env as `MatchRead` plus `ATTACHMENTS_BUCKET`, `GIT_SHA`, `DEPLOYMENT_ENVIRONMENT` |
| `WriteMatchRecord` | admin | Node.js 22, ARM64, 1,024 MB, 1-minute timeout, reserved concurrency 1, two asynchronous retries, maximum event age 6 hours, X-Ray, env as `MatchRead` plus `GIT_SHA`, `DEPLOYMENT_ENVIRONMENT` |
| HTTP API routes | admin | §4.1, on spec 3's API and authorizer |
| Match record rule and DLQ | admin | Evidence bucket `Object Created` with the three key patterns in §6.5 under the stack's namespace. The rule's failed deliveries and `WriteMatchRecord`'s failed asynchronous events go to `<stack>-match-record-dlq` (SQS-managed encryption, 14 days). |
| Content Security Policy | admin | spec 3's policy with the attachments bucket's regional endpoint added to `connect-src` |
| `ProcessUpload` | match-to-csv | 1,024 MB, 2-minute timeout, Sharp, env `EVIDENCE_BUCKET`, `ATTACHMENTS_BUCKET`, `OBJECT_PREFIX` |
| **Route intake** | match-to-csv | `Choice` state at the start of `<stack>` (§6.4), with spec 1's retries on `ProcessUpload` |
| Upload rule | match-to-csv | Attachments bucket `Object Created` with key prefix `uploads/` (stable) or `ephemeral/<name>/uploads/` (ephemeral), input `{ bucket, key, versionId, channel }`, dead-letter queue `<stack>-events-dlq` |
| Outputs | admin | adds `WriteMatchRecordFunctionName` |

### 13.4 Permissions

| Principal | Evidence bucket | Attachments bucket | KMS data key |
| --- | --- | --- | --- |
| `MatchRead` | `ListBucket` with prefix `<ns>matches/`; `GetObject` on `<ns>matches/*`, `<ns>match-slugs/*` and `<ns>submissions/*/screenshots/*/source/original` | none | decrypt |
| `MatchWrite` | `ListBucket` with prefixes `<ns>matches/` and `<ns>image-index/`; `GetObject` on `<ns>matches/*`, `<ns>match-requests/*`, `<ns>match-slugs/*` and `<ns>image-index/*`; `PutObject` on `<ns>match-requests/*`, `<ns>match-slugs/*`, `<ns>image-index/*`, `<ns>matches/*/events/*`, `<ns>matches/*/upload-slots/*` and `<ns>matches/*/uploads/*/intent.json` | `PutObject` on `<ns>uploads/*`, used only to sign POSTs | encrypt, decrypt |
| `WriteMatchRecord` | `ListBucket` with prefix `<ns>matches/`; `GetObject` on `<ns>matches/*`; `PutObject` on `<ns>matches/*/record/*` | none | encrypt, decrypt |
| `ProcessUpload` | `ListBucket` with prefix `<ns>matches/`, so a missing intent or receipt reads as `404`; `GetObject` on `<ns>matches/*/uploads/*/intent.json` and `<ns>matches/*/uploads/*/receipt.json`; `PutObject` on `<ns>submissions/*` and `<ns>matches/*/uploads/*/receipt.json` | `GetObject` and `GetObjectVersion` on `<ns>uploads/*` | encrypt, decrypt |

`<ns>` is empty for stable stacks and `ephemeral/<name>/` for ephemeral ones. `ListBucket` with prefix `P` means an `s3:prefix` condition (`StringLike`) of `P*`. Every role carries the workload permissions boundary and, for ephemeral stacks, the `/mcc-local/` path. No role has `DeleteObject` or any bucket-configuration permission. No admin role can write under `submissions/` or to a `receipt.json`, and `ProcessUpload` cannot write events, intents, slugs or records. P4.4 extends `infrastructure/modules/foundation/local-cdk-policies.tf` so the local workload boundary allows these actions for `admin-e-*` and `match-to-csv-e-*` roles in their own namespace.

### 13.5 Deployment

Both stacks deploy as they do today (spec 1 §13.6, spec 3 §13.5). The admin preflight also fails when the attachments bucket parameter is missing. P1.1 and P1.2 need a person's approval to apply. P3.2 merges only after P1.2 is applied in dev and prod, and P4.4 only after P1.1, P1.2 and spec 2 P1.1 are, so neither deploys a rule that cannot fire. Post-deploy verification adds `GET /api/v1/matches` through the distribution without a token, which must return `401`.

## 14. Security and privacy

1. Every match route requires a valid token in the `admin` group. The handler takes `matchId`, `uploadId` and `slug` only as identifiers and builds every key itself, so no request names a bucket, key or prefix.
2. The presigned POST fixes the exact key, the content type and the maximum size, and expires in 600 seconds. A leaked POST can write one object of the declared size to one staging key, which `process-upload` checks like any upload. CORS on the attachments bucket allows any origin to send a POST, which grants nothing without a valid signed policy.
3. Uploaded bytes are untrusted. `process-upload` checks them with spec 1's attachment rules and Sharp's `failOn: 'none'` before storing a source, verifies the intent exists and the declared SHA-256 matches, so an object posted outside the API is rejected.
4. Slugs are a random word from a fixed list and a random suffix, so they reveal nothing about players, time, content or `matchId`. The word list holds no player data. A slug is not a secret: every match route still requires an `admin` token.
5. Screenshots contain gamertags and live only in the evidence and attachments buckets under the application data key. Match events hold the admin's Cognito `sub`, not an email address. File names are normalized as spec 1 §4.3 does, and the original path on the admin's device is never sent.
6. Logs never contain file names, notes, gamertags or `sub` values. Handlers log identifiers, slugs, event types, counts and request IDs.
7. Every object this component writes is create-only, and Object Lock protects evidence for 365 days (spec 1 §13.1).

## 15. Observability

- Lambdas log JSON lines through the same `log` helper as spec 3. `MatchWrite` logs each match created and event written, `WriteMatchRecord` each version with its counts, and `ProcessUpload` the same intake record as `process-email` with `channel: ADMIN_UPLOAD`, following spec 5's stage records once they exist.
- X-Ray tracing is active on every function.
- Evidence is the audit record. "What happened to this upload" is answered by its intent, its receipt, the submission the receipt names, and its entry in the latest record. An accepted receipt whose screenshot has no run is the sign of an execution that failed after intake (§6.6).
- Undeliverable record events wait in `<stack>-match-record-dlq` for 14 days. Alarms follow spec 5 (backlog P6.5).

## 16. Testing, CI and release

### 16.1 Tests

Tests never call AWS.

| Layer or file | Covers |
| --- | --- |
| `match-events.test.ts` | every event type allowed and refused in each state of §4.2; `STALE_SUPERSESSION`; idempotent `clientRequestId`; `DETAILS_CORRECTED` changes `playedAt` and `note` and never the slug; voiding and restoring; exclusion and restoration |
| `slug.test.ts` | `slug-words-v1.json` validates; every word is 3 to 12 lowercase letters and none repeats; `drawSlug` with a fixed random source gives the expected slug; every drawn slug passes `isSlug`; no suffix contains `i`, `l`, `o` or `u`; a pool under 64 words fails to load; `normalizeSlug` lowercases and maps `i`, `l` and `o` in the suffix only |
| `match-record.test.ts` | every row of §7.3; each flag; `DUPLICATE` within a match and not after the earlier copy is excluded; `screenshotIds` order; same inputs in any order give the same document; `inputsSha256` changes with a rules version bump |
| `fixtures/matches/*.fixture.json` | Each fixture is a set of events, intents and receipts with the expected record, run by one test per file, including `intake-retry-after-receipt` (one intent, one `ACCEPTED` receipt, one `ACTIVE` screenshot whose `screenshotId` is the one the retry returned) |
| `match-write.test.ts` | create writes the claim, slug reservation and `MATCH_CREATED` before any slot, intent or POST; a slug collision draws again, `slugAttemptsPerLength` collisions in a row lengthen the suffix by one, and collisions through `slugMaxSuffixLength` return `503 SLUG_UNAVAILABLE`; a retried create with the same `clientRequestId` after a failure at each step returns the same `matchId` and slug and creates no second match; `IMAGE_ALREADY_UPLOADED` for a live image in another match, and none after it is excluded there or its match is voided; upload intents and POST conditions; two concurrent requests for one slot share one `uploadId`; uploads refused on a voided match; `MATCH_LIMIT`; event sequence race retried and `CONCURRENT_CHANGE` after 3 attempts |
| `match-read.test.ts` | slug resolution, `404` for an orphan reservation, list order and paging |
| `write-match-record.test.ts` | no write when inputs are unchanged; a new version with `previousMatchVersion`; `412` retry; no write before `MATCH_CREATED` |
| `process-upload.test.ts` | an accepted upload writes the submission, source with `intake.matchId`, completion and event, and the receipt last; a rejected image writes a `REJECTED` receipt and throws; a stored image whose SHA-256 differs from the intent is `REJECTED` with `SHA256_MISMATCH`; a missing intent writes a `REJECTED` completion with `UploadIntentMissingError` and no source or receipt; a namespace mismatch fails; no EXIF is read; a run for an upload with a receipt writes nothing and returns or throws as the receipt says; a failure after receipt persistence followed by a retry leaves exactly one receipt; a receipt write that returns `412` returns the existing receipt's screenshot |
| match-to-csv `extract-text` tests | the run manifest's `inputArtifact.intake` equals the source's, and is absent for an emailed screenshot |
| match-to-csv `app.test.ts` | **Route intake** sends `ADMIN_UPLOAD` to `ProcessUpload` and anything else to `ProcessEmail`; the upload rule's prefix per stack type |
| admin `app.test.ts` | match routes, reserved concurrency, rule patterns, DLQ and the §13.4 grants for stable and ephemeral stacks |
| Web component tests | create shows the slug before uploads finish; a retried create reuses its `clientRequestId`; the upload queue retries an expired POST; correction actions send the current event as `supersedesEventId`; `IMAGE_ALREADY_UPLOADED` links to the other match |
| `infrastructure/modules/foundation/tests/` | the `admin` group; attachments bucket EventBridge, CORS and `uploads/` lifecycle |

The admin and match-to-csv workspaces keep their coverage thresholds. Fixtures use placeholder notes and no real gamertags.

### 16.2 CI and release

CI runs the existing checks for each affected workspace, `npm run tofu:check` for the foundation, and synthesis for both stacks. Release Please versions `@mcc/contracts`, `@mcc/admin` and `@mcc/match-to-csv`; the contract change bumps both applications.

### 16.3 Live validation

In dev, an admin plays two matches. After each, the admin creates a match from a phone with that match's screenshots, one of them two pages. The operator checks that each create returned a slug before any upload finished, that every execution succeeded, that every source and run manifest carries the right `intake.matchId`, and that each match's latest record lists its screenshots as `ACTIVE`. The admin then uploads one screenshot of the first match to the second, sees `IMAGE_ALREADY_UPLOADED` naming the first match's slug, excludes a screenshot from the first match, corrects the second match's play time, and the operator checks for the new events and record versions.

## 17. Acceptance criteria

- [ ] A create request writes the request claim, the slug reservation and `MATCH_CREATED` before any upload slot, intent or presigned POST, and returns the slug.
- [ ] Every screenshot uploaded to a match becomes one submission whose source has `intake.matchId`, one receipt, and one run whose manifest has `inputArtifact.intake.matchId`, through the unchanged extraction steps; an emailed screenshot still runs through `ProcessEmail` with no `intake`.
- [ ] No EXIF field, file time or upload order is read to place a screenshot, and no map is recorded.
- [ ] Every slug is a `slug-words-v1` word and a Crockford base32 suffix of 4 or more characters, is unique in its namespace, never changes, and resolves to its `matchId`; a voided match keeps its slug and no slug is reused.
- [ ] A create request retried with the same `clientRequestId` after a failure at any step returns the same match and slug and never creates a second match.
- [ ] An intake attempt that fails after writing its upload's receipt, followed by a successful retry, leaves exactly one receipt, and the record lists that screenshot once and never as `DUPLICATE`.
- [ ] A file whose SHA-256 is live in another active match is refused with `409 IMAGE_ALREADY_UPLOADED` naming that match's slug, and accepted after the admin excludes it there.
- [ ] `DETAILS_CORRECTED`, `MATCH_VOIDED` and `SCREENSHOT_EXCLUDED` with a stale `supersedesEventId` return `409 STALE_SUPERSESSION`. With the current one they write a new event, the earlier event is unchanged, and the next record version shows the change.
- [ ] Every record change writes a new version with `previousMatchVersion`, and writing unchanged inputs writes nothing.
- [ ] Given a run's manifest and its match's latest record, a consumer obtains the run's `matchId`, slug, `playedAt` and whether it counts, with no other input, for both the first run and a replay.
- [ ] Spec 7 reads match membership from `intake.matchId` and `match-record/v1`.
- [ ] Every §16.1 test passes with the coverage thresholds, both stacks synthesize, and `npm run tofu:check` passes.
- [ ] The §16.3 live validation passes in dev.

## 18. Risks and accepted limitations

1. **No map, game variant or playlist.** Statistics cannot be split by map in v1. Reading what MCC prints on a postgame screen is backlog (P6.3), and it would record evidence beside the match, never replace the admin's grouping.
2. **The admin can put the wrong screenshots in a match.** Membership is whatever the admin uploads. Two games uploaded as one match show as `MULTIPLE_SCREENSHOTS`, the same flag two pages of one board raise; the admin excludes the wrong one and creates the right match. Spec 7's `K007` check fails such a pair and escalates it.
3. **Play time is upload time unless the admin enters it.** A match uploaded the next day without an entered time sorts after matches played later. The New match screen shows the time it will record, and `DETAILS_CORRECTED` fixes it.
4. **Concurrent uploads of one image to two matches both pass the duplicate check.** The check reads the index before writing, so two admins uploading the same file at the same moment both succeed. Both screenshots are `ACTIVE`, and the lakehouse can see equal `imageSha256` across matches. Accepted at league scale; a create-only claim per image is backlog if it happens (P6.4).
5. **Orphan slug reservations.** A create request abandoned between its slug reservation and `MATCH_CREATED` leaves a reserved slug with no match, which is never reused. It costs one slug from a pool that cannot run out (§7.2).
6. **Slugs repeat words.** With 176 words, two matches in one night often share a word, such as `warthog-7k3q` and `warthog-p2mz`. The suffix tells them apart, and the admin screens always show the whole slug. A longer word list is a new `slugWordsVersion`.
7. **CORS allows any origin on the attachments bucket.** A page on another origin can send a POST but cannot sign one, and the bucket serves no reads to browsers. The foundation cannot name the admin distribution's domain without knowing about CDK.
8. **No match index.** Listing matches lists evidence prefixes. At league scale, a few thousand matches a year, that is fast and cheap. A rebuildable projection table is backlog (P6.1).
9. **Record writing is serialized across all matches.** A reserved concurrency of 1 means a burst of receipts can delay another match's record by seconds to minutes. Consumers already treat unlisted screenshots as not counted (§8.1).
10. **Any admin can change any match.** Every event records its author, and nothing is lost, because corrections supersede.
11. **Emailed screenshots have no match.** Players who email screenshots contribute runs that no record lists. Importing them is backlog (P6.2).
12. **Staged uploads expire after 30 days.** An upload with no receipt after 30 days must be uploaded again. An upload with a receipt never needs its staged copy again.
13. **Failed intake attempts leave submissions without receipts.** They cost storage only, and receipts tell consumers which submission counts.
14. **An execution that fails after intake needs an operator.** Nothing restarts it automatically, and alarms are backlog (P6.5).
15. **Spec 9 reads the session-association contract.** §8.4 lists its changes; its slices that read matches must not be filed before its next revision.

## 19. Reference documentation

- S3 presigned uploads: https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html
- S3 POST policy conditions: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html
- S3 CORS: https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html
- S3 events in EventBridge: https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventBridge.html
- S3 conditional writes: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html
- Lambda asynchronous invocation and retries: https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html
- Lambda reserved concurrency: https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html
- Step Functions `Choice` state: https://docs.aws.amazon.com/step-functions/latest/dg/state-choice.html
- Cognito user pool groups: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-user-groups.html
- `SubtleCrypto.digest`: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest
- Node.js `crypto.randomInt`: https://nodejs.org/api/crypto.html#cryptorandomintmin-max-callback
- Halo 3 multiplayer maps (Halopedia): https://www.halopedia.org/Template:Levels/H3
- Halo 3 medals (Halopedia): https://www.halopedia.org/List_of_Halo_3_and_Halo_3:_ODST_medals
- Halo 3 weapons, vehicles, equipment and game types (Halopedia): https://www.halopedia.org/Halo_3
- Halo equipment (Halopedia): https://www.halopedia.org/Equipment

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
| `MatchEvent`, `UploadIntent`, `UploadReceipt`, `MatchRecord`, `SourceScreenshot.intake`, `ProcessUploadInput` (§10.1) | P0.1 | `match-write`, `match-read`, `write-match-record`, `process-upload`, `extract-text`, the web application, spec 7, #159 |
| Match evidence layout (§5.1) | P0.1, P2.1 | every module here, spec 7, #159 |
| Slug format and `slug-words-v1` (§7.2) | P0.2 | `match-write`, `match-read`, the web application, #159 |
| Match record rules (§7.3) | P2.2 | `write-match-record`, `match-read`, spec 7, #159 |
| **Route intake** and `channel` trigger input | P3.2 | the main workflow, both EventBridge rules |

A change to a contract updates every consumer in the same PR.

### 20.3 Definition of done for every slice

- Handlers keep I/O behind an injected dependencies object; only default dependencies construct SDK clients.
- New behavior has tests that run without AWS, and each workspace stays above its coverage thresholds.
- `npm run check` passes. Slices that touch CDK also pass `npm run app:synth -- <app> --environment dev`, and match-to-csv slices `npm run verify:bundle --workspace @mcc/match-to-csv`. Slices that touch `infrastructure/` pass `npm run tofu:check`.
- Any change to §7.3 bumps `matchRulesVersion`, and any change to §7.2 words or §7.4 limits adds a new versioned file (§5.4).
- No domain, address, account ID, real gamertag, real screenshot or admin identity appears in code, fixtures, logs or docs.
- Operator-visible changes update the workspace README.

### Phase 0: Contracts and slugs

**Goal:** the shared types and the slug word list exist.
**Exit criteria:** contracts compile, and the word list loads, validates and draws.

#### P0.1 Match, upload and record contracts (S)

- **Blocked by:** none
- **Spec:** §5.1, §5.3, §10.1
- **Files:** `packages/contracts/src/index.ts`, `packages/contracts/package.json`
- **Provides:** every type in §10.1
- **Acceptance:**
  - The package exports the §10.1 types and builds without runtime code.
  - `SourceScreenshot.intake` is optional, and every existing consumer compiles unchanged.
  - `npm run release:check` passes.

#### P0.2 Slug words and drawing (XS)

- **Blocked by:** P0.1; spec 3 P0.1
- **Spec:** §1 (slug), §7.2, §13.1
- **Files:** `applications/admin/config/slug-words-v1.json`, `src/lib/slug.ts`, `test/matches/slug.test.ts`
- **Provides:** `loadSlugWords`, `drawSlug`, `isSlug`
- **Acceptance:**
  - The word file holds exactly the §7.2 words.
  - The `slug.test.ts` row of §16.1 passes.

### Phase 1: Foundation

**Goal:** admins can sign in and uploads can be staged.
**Exit criteria:** P1.1 and P1.2 are applied in dev and prod.

#### P1.1 Admin group (XS)

- **Blocked by:** spec 3 P1.1
- **Spec:** §1 (who may act), §13.2
- **Files:** `infrastructure/modules/foundation/cognito.tf`, `infrastructure/modules/foundation/tests/`
- **Provides:** the `admin` group
- **Acceptance:**
  - The user pool has an `admin` group, and the module test covers it.
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

### Phase 2: Match library

**Goal:** the pure rules exist and are tested.
**Exit criteria:** every library row of §16.1 passes.

#### P2.1 Match event rules and fold (S)

- **Blocked by:** P0.1; spec 3 P0.1
- **Spec:** §4.2, §4.3, §7.1
- **Files:** `applications/admin/src/lib/match-events.ts`, `test/matches/match-events.test.ts`
- **Provides:** `foldMatch`, `checkMatchEvent`
- **Acceptance:**
  - The `match-events.test.ts` row of §16.1 passes.
  - Each event type is allowed and refused exactly as §4.2 and §4.3 state, with the listed codes.

#### P2.2 Match record (S)

- **Blocked by:** P2.1
- **Spec:** §7.3, §5.4
- **Files:** `applications/admin/src/lib/match-record.ts`, `test/matches/match-record.test.ts`, `test/fixtures/matches/`
- **Provides:** `buildMatchRecord`, `matchRecordInputsSha256`
- **Acceptance:**
  - Every row and flag of §7.3 has a fixture, and the `intake-retry-after-receipt` fixture passes.
  - The output is identical for inputs given in any order, apart from `writtenAt` and `build`.

### Phase 3: Upload intake in match-to-csv

**Goal:** an uploaded file becomes a run that names its match, through the existing workflow.
**Exit criteria:** an ephemeral stack turns a staged object into a submission, a receipt and a run whose manifest has `intake.matchId`.

#### P3.1 Upload intake Lambda (M)

- **Blocked by:** P0.1
- **Spec:** §5.2, §5.3, §6.4, §6.6, §8.5, spec 1 §4.3
- **Files:** `applications/match-to-csv/src/lambdas/process-upload.ts`, `src/lib/image-acceptance.ts`, `src/lambdas/process-email.ts`, `src/lambdas/extract-text.ts`, tests, `specs/1-mcc-analytics-engine.md`
- **Provides:** `processUpload`, `upload-receipt/v1`, `upload-submission/v1`, `inputArtifact.intake`
- **Acceptance:**
  - The `process-upload.test.ts` and `extract-text` rows of §16.1 pass.
  - The receipt is the last write, an upload never has two receipts, and an intake run for an upload with a receipt writes nothing and returns or rejects as the receipt says.
  - `attachmentRejectionCodes` moves to `image-acceptance.ts` and every existing intake test passes unchanged.
  - Spec 1 §4, §5, §6.3 and §10.1 describe the upload intake.

#### P3.2 Intake routing and upload trigger (S)

- **Blocked by:** P3.1, P1.2
- **Spec:** §6.4, §13.3, §13.4, §8.5
- **Files:** `applications/match-to-csv/cdk/lib/match-to-csv-stack.ts`, `test/app.test.ts`, `specs/1-mcc-analytics-engine.md`
- **Provides:** **Route intake**, the upload rule, `ProcessUpload` in the stack
- **Acceptance:**
  - The match-to-csv `app.test.ts` row of §16.1 passes for stable and ephemeral stacks.
  - The raw-email rule sends `channel: EMAIL`, and an email still produces the same evidence as before.
  - `ProcessUpload` has exactly the §13.4 grants.
  - Spec 1 §3, §6.1, §13 and §16.1 describe the routing.

### Phase 4: Admin match API

**Goal:** admins can create matches, upload and correct through the API, and records are written.
**Exit criteria:** an ephemeral admin stack creates a match, accepts uploads and writes record versions.

#### P4.1 Match creation and uploads (M)

- **Blocked by:** P0.2, P2.1; spec 3 P0.1
- **Spec:** §4.1 to §4.3, §6.1, §6.2, §6.6, §14
- **Files:** `applications/admin/src/lambdas/match-write.ts`, `src/lib/{match-store,upload-post}.ts`, `test/matches/match-write.test.ts`
- **Provides:** `createMatch`, `requestUploads`
- **Acceptance:**
  - The create, retry, slug, duplicate image, upload and limit cases of the `match-write.test.ts` row of §16.1 pass.
  - The POST fixes the key, content type and maximum size and expires in 600 seconds.

#### P4.2 Match events and reads (S)

- **Blocked by:** P4.1
- **Spec:** §4.1, §6.3
- **Files:** `applications/admin/src/lambdas/{match-write,match-read}.ts`, `test/matches/{match-write,match-read}.test.ts`
- **Provides:** `writeMatchEvent`, `readMatch`, `listMatches`, `resolveSlug`
- **Acceptance:**
  - Events are written create-only at the next sequence, a lost race retries, and three lost races return `409 CONCURRENT_CHANGE`.
  - The `match-read.test.ts` row of §16.1 passes, and a match read returns the live preview computed with `buildMatchRecord`.

#### P4.3 Match record writer (S)

- **Blocked by:** P2.2, P4.1
- **Spec:** §6.5
- **Files:** `applications/admin/src/lambdas/write-match-record.ts`, `test/matches/write-match-record.test.ts`
- **Provides:** `writeMatchRecord`
- **Acceptance:**
  - The `write-match-record.test.ts` row of §16.1 passes.

#### P4.4 Match resources in the admin stack (M)

- **Blocked by:** P4.2, P4.3, P1.1, P1.2; spec 3 P1.2, P3.4; spec 2 P1.1
- **Spec:** §13.3 to §13.5, §14
- **Files:** `applications/admin/cdk/lib/admin-stack.ts`, `test/app.test.ts`, `infrastructure/modules/foundation/local-cdk-policies.tf` and `tests/local-cdk-policies.tftest.hcl`
- **Provides:** deployable match routes and record writer
- **Acceptance:**
  - The admin `app.test.ts` row of §16.1 passes for stable and ephemeral stacks.
  - The Content Security Policy's `connect-src` includes the attachments bucket's regional endpoint.
  - An ephemeral stack creates a match, issues upload POSTs, and writes a record version after a receipt appears, then destroys cleanly.

### Phase 5: Admin screens

**Goal:** an admin can record a match from a phone.
**Exit criteria:** §16.3 passes in dev.

#### P5.1 Matches list and New match screen (M)

- **Blocked by:** P4.4, P3.2; spec 3 P4.1
- **Spec:** §6.1, §6.2, §9
- **Files:** `applications/admin/web/src/matches/`
- **Provides:** the Matches and New match screens
- **Acceptance:**
  - Creating a match shows its slug before any upload finishes, and a retried create reuses its `clientRequestId`.
  - Files are posted at most 3 at a time, an expired POST is requested again for the same `uploadId`, and each file shows pending, rejected with codes, or accepted.

#### P5.2 Match screen and corrections (S)

- **Blocked by:** P5.1
- **Spec:** §4.2, §7.3, §9
- **Files:** `applications/admin/web/src/matches/`
- **Provides:** the Match screen at `/matches/{slug}`
- **Acceptance:**
  - Every correction in §4.2 is available and writes one event with the current `supersedesEventId`.
  - `IMAGE_ALREADY_UPLOADED` links to the other match by slug.

#### P5.3 Live validation (S)

- **Blocked by:** P5.2
- **Spec:** §16.3, §7.4
- **Files:** none beyond the issue
- **Provides:** the first measured matches
- **Acceptance:**
  - §16.3 passes in dev.
  - The issue records, for at least one real league night, the matches created, their flags and every admin correction, and keeps or changes each §7.4 value.

### Phase 6: Backlog (not filed with v1)

| ID | Slice | Size | Note |
| --- | --- | --- | --- |
| P6.1 | Rebuildable match index table | S | §18.8. Only when listing becomes slow. |
| P6.2 | Import an emailed screenshot into a match | S | §18.11. A `SCREENSHOT_IMPORTED` event naming a `screenshotId`. |
| P6.3 | Read the map and game variant from postgame screens | M | §18.1. Only where MCC prints them; records evidence beside the match and never changes membership. |
| P6.4 | Create-only image claims | S | §18.4. Only if concurrent duplicate uploads happen. |
| P6.5 | Alarms for the match record DLQ and `WriteMatchRecord` errors | S | Follow spec 5. |

### 20.4 Dependency order and parallel lanes

P0.1 and P1.2 can start at once. P3.1 then proceeds in parallel with P2.1 and P0.2, which wait on spec 3 P0.1. The critical path is spec 3 P0.1 -> P2.1 -> P4.1 -> P4.2 -> P4.4 -> P5.1 -> P5.2 -> P5.3, with spec 3 P3.4 and P4.1 joining at P4.4 and P5.1. The first real feedback is P5.3, when an admin records a league night through the screens.
