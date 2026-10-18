# Stats Lakehouse: Technical Specification

**Status:** Draft; not implemented

**Version:** 1.0-draft

**Date:** October 15, 2026

**Component:** `applications/data-pipeline` (ingestion and build Lambdas, pure silver and gold libraries, bundled configuration and CDK stack), with lakehouse and serving types in `packages/contracts`, lifecycle and activation changes in `infrastructure/modules/data-platform` and its two roots, and ephemeral-stack permissions in `scripts/local-cdk-bootstrap.mjs`

**Runtime:** TypeScript, Node.js 22 on AWS Lambda (ARM64)

**Deployment:** one AWS CDK stack per stable environment (`data-pipeline-dev`, `data-pipeline-prod`) from GitHub Actions, plus ephemeral developer stacks in the dev account, through the guarded wrapper in `scripts/cdk-app.mjs`

**Input:** spec 3 validated tables (`validated-table/v1`, [spec 3](3-cell-labeling.md) §8.4), spec 8 session associations (`session-association/v1`) and map catalogs (`map-catalog/v1`), the run manifest and submission record beside each validated table ([spec 1](1-mcc-analytics-engine.md) §5.3), and the spec 6 roster change log

**Persistent state:** bronze, silver and gold objects in the three OpenTofu-owned lakehouse buckets, encrypted with the OpenTofu-owned lakehouse key; table definitions in the OpenTofu-owned Glue database; queries through the OpenTofu-owned Athena workgroup

**External dependencies at runtime:** S3, KMS, EventBridge, EventBridge Scheduler, Lambda, SQS, DynamoDB (read only, the spec 6 roster table), AWS Glue Data Catalog, SSM Parameter Store

**Out of scope:** OCR evidence, quality features and scores, review labels, ML training datasets and risk model evidence (all stay in the evidence bucket, §1), creating or changing matches or sessions (spec 8), resolving OCR readings against the roster (spec 6), the player app's API, interface, authentication and publication policy, and Athena tables over bronze

The stats lakehouse turns reviewed scoreboards into the statistics the player app shows. Bronze keeps a copy of every validated table version and every session association version, silver normalizes them into sessions, matches, players and one statistics row per player per match, and gold aggregates silver into player summaries, match scoreboards, leaderboards and rising players. The player app reads gold serving documents; operators query silver and gold with Athena. Nothing in the lakehouse is evidence: bronze can be rebuilt from the evidence bucket, and silver and gold from bronze and the roster.

**Readiness:** this specification authorizes filing Phases 0 to 4. Spec 3 references hold for validated tables with and without the 2.1-draft fields (§9.1). P0.2 is blocked by spec 3 P0.2 and spec 8 P0.1, P3.2 by spec 6 P0.2, and P4.2 cannot merge until P1.1 here, spec 2 P1.1 and spec 6 P1.1 are applied in dev and prod. The contracts in §5.3 and §10.1 freeze when P0.2 merges, and the gold parameters in §8.6 are initial values until P4.3 records the first live build.

---

## 1. Resolved requirement decisions

The issue (#159) asks for bronze from review-complete runs, silver players, matches and statistics, and gold for the player app. Spec 3 hands the validated table to this spec, spec 8 hands it match records, and spec 6 hands it player identity across gamertags and consent.

| Requirement | Decision | Reason |
| --- | --- | --- |
| Bronze holds validated match data from review-complete runs | Bronze ingests spec 3 `validated-table/v1` objects only. Spec 3 writes a validated version only when a run is review-complete (spec 3 §8.5), so every bronze table comes from a complete run. Bronze also ingests spec 8 association versions and map catalogs, which silver needs to place a run in a match. | The validated table is the only reviewed form of a run. OCR output, parser rows, roster resolutions and `reviewFlags` (#161) describe readings before review. |
| Which validated versions bronze keeps | Every version, as its own create-only object keyed by `runId` and `validatedVersion` (§5.1). Bronze never deletes or replaces an object. | A correction is a new version in spec 3 (spec 3 §8.5). Keeping every version keeps every gold build reproducible and every correction auditable. |
| Lineage | Each bronze object records the evidence key, S3 version ID, SHA-256 and size of the object it copied, and the validated table inside it keeps `runId`, `screenshotId`, `submissionId`, `imageSha256` and `lineage.adjudicationSetSha256`. Silver rows carry `runId`, `screenshotId`, `validatedTableId`, `validatedVersion` and `adjudicationSetSha256` (§7.6). | Any gold number traces to a silver row, a bronze object, an evidence object and the adjudication set behind it, without a second lineage store. |
| How bronze learns of a new version | An EventBridge rule on evidence bucket `Object Created` events for validated tables, associations and map catalogs (§4.1) invokes `IngestBronze`. An operator backfill lists the evidence namespace and ingests whatever bronze lacks (§6.2). | The evidence bucket already emits events once spec 2 P1.1 is applied, and spec 3 uses the same pattern. A backfill covers runs validated before this stack existed and any event that reached the DLQ. |
| How a correction reaches silver and gold | Silver selects the latest version per run, and every build recomputes silver and gold in full from bronze and the roster (§6.3). A build runs every 15 minutes and does nothing when its inputs are unchanged. | At league scale all of bronze fits in one Lambda's memory, so a full rebuild is simpler and easier to test than incremental merges, and a correction cannot leave a stale aggregate behind. |
| Table format | Silver and gold tables are gzip-compressed JSON Lines files read by Athena through the OpenX JSON SerDe. Each build writes new files under its own prefix and then points each Glue table at them (§6.3). | The whole league history is a few megabytes. JSON Lines needs no native writer in the Lambda bundle, its content is byte-deterministic and easy to compare in tests, and a new prefix per build makes publication atomic per table. Parquet or Iceberg is backlog for when a build outgrows one Lambda (P5.2). |
| Who owns the Glue tables | `BuildLakehouse` creates each Glue table when it is missing and updates its location after each build, from definitions in code (§7.6, §8.2). Neither OpenTofu nor CloudFormation manages them. Stable stacks use the OpenTofu Glue database; each ephemeral stack creates its own database, which CloudFormation deletes with the stack. | A table definition is derived metadata that one function can recreate at any time, like spec 3's `ReviewState` table. A CloudFormation table whose location a Lambda changes would drift on every build. Deleting a Glue database removes its tables, so ephemeral tables leave nothing behind. |
| Who owns match records | The admin application (spec 8 §1). The lakehouse reads spec 8 association versions, selects the latest per session in silver, and never creates, changes or voids a match. | Spec 8 §1 assigns match ownership to the admin application. The host records each match while it happens, with its map and time. |
| Screenshots of the same match | Silver groups a match's screenshots by board content: identical boards count once, disjoint pages of one team board merge, and anything else marks the match `CONFLICTING_SCREENSHOTS` and keeps it out of gold until the host or a reviewer fixes it (§7.4). Spec 8 `DUPLICATE` screenshots are never counted. In v1 a page merges only when it passed review on its own, which spec 3 allows only for a page that shows the winner, so pages without a winning-team row cannot be counted (§7.4, §18.13). | Spec 8 leaves the choice of screenshot to this spec (spec 8 §8.1). Two captures of one board and two pages of a long board are both legitimate, and they can be told apart from content alone. A conflicting pair is a host or review error that guessing would hide. Spec 3 §8.3 condition 5 requires every review-complete table to have exactly one winner, and a page-level outcome rule would be a spec 3 contract change (P5.8). |
| Emailed screenshots | Silver keeps their validated runs and screenshots with `matchRole: NO_SESSION`, and no match. Gold counts only session matches. A screenshot a host imports into a session (spec 8 backlog P6.2) is counted through the association with no change here. | An emailed screenshot has no match identity, map or play time. Grouping emailed boards into matches by content would guess, and one missed duplicate counts a game twice for every player in it. |
| Same player across gamertag variants | A validated name links to a roster entry when it equals the entry's gamertag after NFKC normalization, lowercasing and whitespace collapse, active or inactive (§7.5). The player is the roster entry. An unlinked name is its own player. Silver applies no near matching to validated names. | A validated name was checked against the screenshot by a reviewer or the LLM reviewer, so OCR misreads are already corrected, and spec 1's tidy step has removed clan tags and collapsed whitespace. Xbox gamertags are unique ignoring case (spec 6 §1). Near matching on reviewed text would merge distinct real players, the risk spec 6 §18.1 accepts only for unreviewed CSVs. |
| Renamed gamertags | Two players in v1. The roster records a rename as a deactivation and an add, and does not link them (spec 6 §1). Linking gamertags to one person is backlog P5.1. | Nothing records that two gamertags belong to one person yet. A guessed link would merge two people's statistics. |
| Consent to publish statistics (spec 6 §1 hands it here) | The lakehouse records no consent. Gold holds every player's statistics in a private bucket, marks each player `rostered`, ranks only rostered players in leaderboards and rising players (§8.4, §8.5), and serves nothing publicly. Whether the player app shows statistics publicly, and any opt-out, is the player app specification's decision, and an opt-out list is backlog P5.4. | Only the player app knows its audience. Gold can carry the flag the app needs without deciding publication for it. |
| Reviewer kind | Gold counts validated tables decided by people, by the LLM reviewer and by stage 3 auto-acceptance alike (spec 7 §8.8). Silver rows record the reviewer kinds of their values and rows when the validated table carries them (spec 3 2.1-draft), and whether any value was auto-accepted. | Spec 7 makes the LLM the primary reviewer and measures the error bound of accepted data monthly. Excluding LLM-decided tables would hide most of the league, and the recorded kinds let the player app or an analyst separate them. |
| Where OCR evidence, quality features and training data live | They stay in the evidence bucket, and nothing in this component reads or copies them. `IngestBronze` reads only validated tables, run manifests, submission records, associations and map catalogs (§13.4). ML datasets (spec 1 §9.3, spec 2 §8.5, spec 7 `risk/datasets/`) and spec 2 baselines read the evidence bucket, never the lakehouse. | Spec 2 §2.2 already keeps features, scores and training data out of the lakehouse. Training data must join features and labels at the observation level, which only the evidence bucket holds, and copying it would create a second store to keep in sync. |
| Ownership | OpenTofu (`infrastructure/modules/data-platform`) owns the three buckets, the lakehouse key, the Glue database, the Athena workgroup and their SSM parameters. The `data-pipeline` stack owns its Lambdas, rules, schedule, queue, log groups and, for ephemeral stacks, their Glue databases. | The repository rule: OpenTofu owns persistent shared resources and CDK owns application compute (`AGENTS.md`). Bronze, silver and gold outlive every stack. |
| Play time and order of a match | `playedAt` is the match's `selectedAt` (spec 8 §7.1). An `ADDED` match uses the earliest `effectiveAt` of its screenshots, then the session's `endedAt` (§7.3). Matches are ordered by their session's start and then `matchIndex`, never by `playedAt` or an event time (§7.3). | The host selects the map just before play. `ADDED` matches have no selection time. Spec 8 fixes `matchIndex` as the chronological position, which no correction changes, while an `ADDED` match's `playedAt` can fall after matches it preceded. |

**Additional capabilities included:** ingest rejection records for operators, a per-build manifest with input and output hashes, Athena tables for every silver and gold dataset, and `rosterKeyMatches` on unlinked players so an operator can see names that look like a roster gamertag.

## 2. Goals and non-goals

### 2.1 Goals

1. Every validated table version and association version in the evidence namespace has a bronze copy within 5 minutes of its write, or a rejection record that says why not.
2. Gold reflects every bronze object and the current roster within 20 minutes, including corrections, and every gold number traces to the bronze objects and evidence it came from.
3. A match is counted once, with one statistics row per player, whether its board arrived as one screenshot, several captures, or several pages that each passed review on their own (§7.4).
4. A build with the same inputs and versions produces byte-identical silver and gold tables and serving documents, whatever its `buildId`.
5. The player app reads one consistent snapshot of gold, never a half-published build.
6. Each developer can deploy an isolated copy that reads only its own evidence namespace and writes only its own lakehouse namespace.

### 2.2 Non-goals

- Copying OCR observations, quality results, feature rows, adjudications, escalations, LLM invocations or training datasets into the lakehouse (§1).
- Creating or correcting matches, sessions or maps. Spec 8 owns them; a correction there reaches gold as a new association version.
- Counting emailed screenshots that no session lists (§1).
- Linking renamed gamertags to one person (P5.1).
- Deciding who may see the player app or which players it names (§1).
- Incremental builds, Parquet or Iceberg tables (P5.2).
- Athena tables over bronze. Bronze is queried through silver.

## 3. Runtime architecture

```text
Evidence bucket (OpenTofu, spec 1)
  [ns]submissions/*/screenshots/*/runs/*/validated/*.json     (spec 3)
  [ns]sessions/*/association/*.json                            (spec 8)
  [ns]map-catalogs/*.json                                      (spec 8)
  |  Object Created (EventBridge, spec 2 P1.1)
  v
EventBridge rule --> IngestBronze Lambda --(failed delivery)--> SQS DLQ
  |  reads the run manifest.json and the submission ingestion.json beside a validated table
  v
Bronze bucket (OpenTofu): validated-tables/, session-associations/, map-catalogs/, ingest-rejections/
  ^
  |  operator: BackfillBronze Lambda lists the evidence namespace and ingests what bronze lacks
  |
EventBridge Scheduler (every 15 minutes) or operator --> BuildLakehouse Lambda (reserved concurrency 1)
  |  reads all of bronze, and the roster change log (spec 6 roster table, read only)
  |  pure silver rules (§7) and gold rules (§8)
  v
Silver bucket (OpenTofu): builds/{buildId}/tables/{table}/, builds/{buildId}/manifest.json
Gold bucket (OpenTofu):   builds/{buildId}/tables/{table}/, builds/{buildId}/serving/, serving/current.json
  |
  +--> Glue Data Catalog: each silver and gold table points at its latest build
  |      Athena workgroup (OpenTofu) --> operators and analysts
  +--> player app (its own stack) reads serving/current.json, then serving documents
```

**Ownership rules:** `ingest-bronze` and `backfill-bronze` own every bronze object and are the only writers to the bronze bucket. `build-lakehouse` owns every silver and gold object, the Glue tables and the serving pointer, and is the only writer to the silver and gold buckets apart from Athena query results under `athena-results/`. No module writes to the evidence bucket or the roster table. `bronze-keys`, `bronze-documents`, `silver`, `players`, `gold` and `serving` are pure and perform no I/O. Only Lambda entry points construct AWS SDK clients; each core function receives an injected dependencies object.

**Packaging:** the `@mcc/data-pipeline` workspace with Lambda sources under `src/lambdas/`, pure libraries under `src/lib/`, bundled configuration under `config/` and the CDK app under `cdk/`. Bronze, silver, gold and serving types live in `@mcc/contracts`, because the player app reads serving documents. The workspace imports `@mcc/contracts`, `@mcc/cdk-config` and `@mcc/roster` (spec 6) from the monorepo.

**Orchestration decision:** no Step Functions and no Glue jobs. Ingestion touches one object per event. A build reads a few thousand small objects and computes everything in memory well inside one 15-minute Lambda at league scale. Glue jobs or a Step Functions fan-out are justified when a build nears that limit (§18.4, P5.2).

### 3.1 Execution policy

- One evidence event is one `IngestBronze` invocation and at most one bronze object.
- Every bronze write uses `If-None-Match: *`. No role has `DeleteObject` on any lakehouse bucket.
- One build reads a fixed set of bronze keys and one roster version, and writes every output under a new `buildId` prefix before it publishes anything (§6.3).
- `BuildLakehouse` has a reserved concurrency of 1, so two builds never publish at once.
- Silver and gold tables and serving documents are pure functions of the bronze key set, the roster version and the stage versions (§5.4). `buildId` and the build's own timestamps live only in the build manifest, the serving pointer and object keys, never in a table file or serving document.
- Handlers never read or write outside their namespace (`ephemeral/<name>/` for ephemeral stacks). The namespace comes from the deployment, never from an event or request.

## 4. Interfaces

### 4.1 Ingestion trigger

The stack's EventBridge rule matches `aws.s3` `Object Created` events from the evidence bucket whose key matches one of these `wildcard` patterns, with `<ns>` empty for stable stacks and `ephemeral/<name>/` for ephemeral ones:

| Source | Key pattern | Writer |
| --- | --- | --- |
| Validated table | `<ns>submissions/*/screenshots/*/runs/*/validated/*.json` | spec 3 |
| Session association | `<ns>sessions/*/association/*.json` | spec 8 `derive-association` |
| Map catalog | `<ns>map-catalogs/*.json` | spec 8 `session-write` |

The rule invokes `IngestBronze` asynchronously with a retry policy of 3 attempts within 2 hours and sends undeliverable events to `<stack>-ingest-dlq` (SQS-managed encryption, 14-day retention). The function allows 2 asynchronous retries and sends failed events to the same queue. `IngestBronze` re-checks each key against the regular expressions in §4.2 and its own namespace, and fails with `InvalidEvidenceKeyError` otherwise.

### 4.2 Accepted evidence keys

| Source | Regular expression (after removing `<ns>`) | Captures |
| --- | --- | --- |
| Validated table | `^submissions/([^/]+)/screenshots/([^/]+)/runs/([^/]+)/validated/([0-9]{6})\.json$` | `submissionId`, `screenshotId`, `runId`, `validatedVersion` |
| Session association | `^sessions/([^/]+)/association/([0-9]{10})\.json$` | `sessionId`, `associationVersion` |
| Map catalog | `^map-catalogs/(map-catalog-v[0-9]+)\.json$` | `mapCatalogVersion` |

The captured `submissionId`, `screenshotId`, `runId` and `sessionId` must also match spec 3's `evidenceId()` pattern, `^[0-9a-z]+-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$`.

### 4.3 Ingest validation

Each check runs after the key is accepted. A failed check writes a rejection record (§5.3) and returns without error, so the event is not retried, because the evidence object will never change.

| Check | Rejection code |
| --- | --- |
| The object is not valid JSON, or is larger than 4 MiB | `UNPARSEABLE` |
| `schemaVersion` is not `validated-table/v1`, `session-association/v1` or `map-catalog/v1` for its source | `UNSUPPORTED_SCHEMA` |
| A validated table's `runId`, `screenshotId`, `submissionId` or `validatedVersion` differs from its key, or a field that spec 3 §10.1 requires is missing | `KEY_MISMATCH`, `MISSING_FIELD` |
| An association's `sessionId` or `associationVersion` differs from its key | `KEY_MISMATCH` |
| A map catalog's `mapCatalogVersion` differs from its key | `KEY_MISMATCH` |
| A validated table's run has no `manifest.json`, or the manifest's `screenshotId` differs | `RUN_CONTEXT_MISSING`, `KEY_MISMATCH` |
| The submission has no `ingestion.json` | `RUN_CONTEXT_MISSING` |

Storage errors other than `404` and `412` are thrown, so the asynchronous retries in §4.1 apply.

### 4.4 Build invocation

`BuildLakehouse` takes `{}` from the schedule, or `{ "force": true }` from an operator. `force` builds even when the inputs are unchanged, which an operator uses after recovering a deleted Glue table. It returns `{ status, buildId, inputsSha256 }` with `status` `PUBLISHED` or `UNCHANGED`.

`BackfillBronze` takes `{ "scope": "NAMESPACE" }` or `{ "scope": "RUN", "runPrefix": <run prefix> }` or `{ "scope": "SESSION", "sessionId": <id> }`, and returns counts of keys listed, already in bronze, ingested and rejected.

### 4.5 Player app interface

The player app reads gold serving documents (§8.3) and nothing else. It reads `<ns>serving/current.json` in the gold bucket, then the documents under the `servingPrefix` the pointer names. Documents under a build prefix never change, so the app may cache them for as long as it shows that build. It should re-read the pointer at least every 5 minutes. Its role needs `s3:GetObject` on those two key patterns and `kms:Decrypt` on the lakehouse key, granted in the player app's own stack from the SSM parameters in §13.2.

## 5. Storage

### 5.1 Layout

```text
Bronze bucket:
[ephemeral/<name>/]validated-tables/{runId}/{validatedVersion}.json            bronze-validated-table/v1
[ephemeral/<name>/]session-associations/{sessionId}/{associationVersion}.json  bronze-session-association/v1
[ephemeral/<name>/]map-catalogs/{mapCatalogVersion}.json                       bronze-map-catalog/v1
[ephemeral/<name>/]ingest-rejections/{sourceKeySha256}-{sourceSha256}.json     bronze-rejection/v1

Silver bucket:
[ephemeral/<name>/]builds/{buildId}/manifest.json                              lakehouse-build/v1
[ephemeral/<name>/]builds/{buildId}/tables/{silverTable}/part-00000.json.gz

Gold bucket:
[ephemeral/<name>/]builds/{buildId}/tables/{goldTable}/part-00000.json.gz
[ephemeral/<name>/]builds/{buildId}/serving/...                                §8.3
[ephemeral/<name>/]serving/current.json                                        gold-serving-pointer/v1
athena-results/                                                                Athena workgroup output (OpenTofu)
```

`{validatedVersion}` keeps spec 3's six-digit padding and `{associationVersion}` spec 8's ten-digit padding, so bronze keys sort in version order. `{sourceKeySha256}` is the SHA-256 of the evidence key and `{sourceSha256}` the SHA-256 of the object bytes. `{buildId}` is an `evidenceId()` value, so builds sort by creation time.

### 5.2 Rules

1. Bronze objects are written once with `If-None-Match: *` and never deleted. A bronze key exists for exactly one evidence object.
2. Bronze holds a parsed copy of each evidence document and the SHA-256 of the original bytes. The evidence object stays the record (spec 1 §5.2); bronze can be rebuilt from it with a backfill.
3. Every silver and gold object of a build is written once under that build's prefix. A build's files are never changed after its manifest exists.
4. A build publishes in this order: every table file and serving document, then the build manifest, then the Glue table locations, then the serving pointer. A reader of the pointer therefore sees only complete builds.
5. The serving pointer is the only object any role overwrites. Bucket versioning keeps every earlier pointer.
6. No lakehouse object holds OCR text other than the validated values in bronze, and no object holds a quality signal, feature, adjudication, LLM prompt or training example.

### 5.3 Document schemas

Every bronze document is one line of JSON, so the files stay readable by line-oriented tools.

| Object | `schemaVersion` | Writer | Contents |
| --- | --- | --- | --- |
| `validated-tables/...` | `bronze-validated-table/v1` | `ingest-bronze`, `backfill-bronze` | `BronzeValidatedTable` (§10.1): `source`, `runContext` (channel, `sessionId`, `uploadId`, `receivedAt`, run `versions`), `ingest`, and `document`, the validated table as parsed |
| `session-associations/...` | `bronze-session-association/v1` | same | `source`, `ingest`, and `document`, the association as parsed |
| `map-catalogs/...` | `bronze-map-catalog/v1` | same | `source`, `ingest`, and `document`, the catalog as parsed |
| `ingest-rejections/...` | `bronze-rejection/v1` | same | `source`, `ingest`, `code` (§4.3), `detail` (a field name or expected value, never document content) |
| `builds/{buildId}/manifest.json` | `lakehouse-build/v1` | `build-lakehouse` | `LakehouseBuild` (§10.1): `buildId`, `inputsSha256`, bronze key counts per source, rejection count, roster reference, versions, per-table row counts and `contentSha256`, the serving document count and `servingContentSha256`, `asOf`, `startedAt`, `completedAt`, `build` |
| table `part-00000.json.gz` | none; the Glue definition in §7.6 or §8.2 | `build-lakehouse` | one JSON object per line, keys sorted bytewise, gzip-compressed |
| serving documents | §8.3 | `build-lakehouse` | §8.3 |
| `serving/current.json` | `gold-serving-pointer/v1` | `build-lakehouse` | `buildId`, `inputsSha256`, `servingPrefix`, `asOf`, `publishedAt` |

`source` is `{ key, versionId, sha256, sizeBytes }` for the evidence object, with `key` relative to the bucket and never the bucket name. `ingest` is `{ ingestedAt, bronzeIngestVersion, build: { gitSha, environment } }`.

### 5.4 Stage versions

Any change to a stage's behavior bumps its version in the same delivery.

| Key | v1 value | Recorded in |
| --- | --- | --- |
| `bronzeIngestVersion` | `bronze-ingest-v1` | every bronze object |
| `lakehouseRulesVersion` | `lakehouse-rules-v1` | every build manifest and serving index; covers §7 and §8 |
| `lakehouseConfigVersion` | `lakehouse-config-v1` | every build manifest and serving index |

A change to `lakehouseRulesVersion` or `lakehouseConfigVersion` changes `inputsSha256` (§6.3), so the next scheduled build rebuilds everything.

## 6. Processes

### 6.1 Bronze ingestion

`ingestBronze(event, dependencies)`:

1. Validate the key (§4.1, §4.2).
2. Build the bronze key (§5.1). When it exists, stop with `ALREADY_INGESTED`.
3. Read the evidence object, recording its `versionId`, SHA-256 and size. Apply the checks in §4.3 that need only the document.
4. For a validated table, read the run's `manifest.json` and the submission's `ingestion.json` (the parent prefixes of the key). `runContext.channel` is `SESSION_UPLOAD` when the manifest's `inputArtifact.intake.channel` is `SESSION_UPLOAD` (spec 8 §5.3), with its `sessionId` and `uploadId`, and `EMAIL` with `null` identifiers otherwise. `receivedAt` comes from `ingestion.json`; nothing else from that file is copied. `versions` is the manifest's `versions`.
5. On a failed check, write the rejection record create-only, log `Ingest rejected` at `WARN` with the code and key, and stop.
6. Write the bronze object with `If-None-Match: *`. On `412`, read the existing object: when its `source.sha256` equals this one, stop with `ALREADY_INGESTED`; otherwise throw `BronzeConflictError`, which create-only evidence cannot cause.
7. Log `Bronze ingested` with the source kind, the identifiers from the key and `bronzeIngestVersion`.

### 6.2 Backfill

`backfillBronze(input, dependencies)` lists the evidence prefixes in scope (`<ns>submissions/`, `<ns>sessions/` and `<ns>map-catalogs/` for `NAMESPACE`), keeps the keys that match §4.2, lists the bronze keys they map to, and runs `ingestBronze` for each missing one with a concurrency of 16. It is idempotent, and it is the recovery path for events in the DLQ and for evidence written before the stack existed. It stops listing at 13 minutes and returns `incomplete: true` with a continuation token, which the operator passes back as `startAfter`.

### 6.3 Build

`buildLakehouse(input, dependencies)`:

1. List every key under `<ns>validated-tables/`, `<ns>session-associations/` and `<ns>map-catalogs/` in the bronze bucket, and count `<ns>ingest-rejections/`.
2. Read the roster: `HEAD` of `ROSTER#<namespace>` with a consistent read, and every change item up to its version (spec 6 §5.1). Fold them with `foldRoster` from `@mcc/roster`, keeping inactive entries, and check the fold's hash against `HEAD.rosterSha256`; a mismatch fails the build with `RosterIntegrityError`. A namespace without `HEAD` is version 0 with no entries.
3. Compute `inputsSha256`: the SHA-256 of the bronze keys sorted bytewise and joined with `\n`, followed by `\n` and `<namespace>:<rosterVersion>:<rosterSha256>`, then `\n`, `lakehouseRulesVersion`, `\n` and `lakehouseConfigVersion`. Bronze keys are create-only, so the key set identifies the content.
4. Read `<ns>serving/current.json`. When its `inputsSha256` equals this one and `force` is not set, return `UNCHANGED`.
5. Read every bronze object, `bronzeReadConcurrency` at a time (§13.1), and parse it against §10.1.
6. Run `buildSilver(bronze, roster, config)` (§7) and `buildGold(silver, config)` (§8). Both are pure.
7. Create `buildId`. Write each silver and gold table file and each serving document under the build prefix with `If-None-Match: *`.
8. Write the build manifest create-only.
9. For each table in §7.6 and §8.2, create the Glue table when it does not exist, otherwise update its `StorageDescriptor.Location` to the new build prefix and its columns to the definition in code.
10. Write `<ns>serving/current.json`.
11. Log `Lakehouse built` with `buildId`, `inputsSha256`, row counts and durations, and return `PUBLISHED`.

A build logs `BUILD_INPUT_LARGE` at `WARN` when bronze holds more than `largeInputWarningObjects` objects (§13.1), which is the signal for P5.2.

### 6.4 Corrections

Every correction upstream becomes a new create-only object, so it reaches gold the same way:

| Upstream change | Evidence written | Effect here |
| --- | --- | --- |
| A reviewer or the LLM reviewer changes a complete run's decision (spec 3 §6.3) | the run's next `validated/{validatedVersion}.json` | A new bronze key. Silver uses the new version for the run (§7.1), and the next build recomputes every silver and gold row from it. |
| A host corrects a map, voids or restores a match, or reassigns or excludes a screenshot (spec 8 §4.2) | a new `association/{v}.json` | A new bronze key. Silver uses the new association for the session (§7.3). |
| An operator adds, deactivates or reactivates a roster gamertag (spec 6 §6.1) | a new roster change item | A new roster version in `inputsSha256`. Silver relinks players (§7.5). |
| A replay produces a new run of a screenshot that is then validated | a new run's `validated/000001.json` | A new bronze key. Silver may choose the new run for the screenshot (§7.2). |

Earlier bronze objects and earlier builds stay. Gold is recomputed in full on the next scheduled build after the bronze write, so a correction reaches the player app within the 20 minutes of goal 2.

### 6.5 Retries and failure

- `IngestBronze` errors are retried as in §4.1 and are safe to repeat, because every write is create-only and step 2 skips ingested keys. Events that exhaust their retries wait 14 days in the DLQ; a `NAMESPACE` backfill ingests the objects they named.
- A build that fails before step 10 leaves the previous build published. Its partial files stay under an unpublished build prefix that nothing reads (§18.6), and the next scheduled build starts again from step 1 because the pointer still holds the old `inputsSha256`.
- A build that fails between steps 9 and 10 leaves Athena on the new build and the player app on the old one until the next build, which publishes the same content under another `buildId`.
- The schedule invokes `BuildLakehouse` asynchronously with no retries and a maximum event age of 15 minutes, so an invocation throttled by a running build is dropped and the next schedule tick runs it.

## 7. Silver rules

`buildSilver(bronze, roster, config)` in `src/lib/silver.ts` is pure and deterministic. Every sort in this section is bytewise on the named key unless it says otherwise, and every list it emits is in that order.

### 7.1 Latest validated version per run

For each `runId` with bronze validated tables, the run's current table is the one with the highest `validatedVersion`. `versionCount` is the number of versions in bronze, and `versionGap` is true when bronze lacks a version between 1 and the highest; the build still uses the highest and logs `BRONZE_VERSION_GAP` at `WARN`, because the highest version is the latest truth and a backfill fills the gap. A run that spec 3 reopened after a validated version (spec 3 §6.3) keeps that version as current until spec 3 writes the next.

For each current table, `gameFingerprint` is the SHA-256 of the JSON array of one tuple per row, `[playerKey, score, kills, assists, deaths, win]`, with `playerKey` from §7.5 (`null` for an unreadable name), tuples serialized without whitespace and sorted bytewise by that serialization. Team names are left out because they are a reviewer's colour judgment (spec 3 §18.12). A table with no rows has the fingerprint of `[]`.

### 7.2 Representative run per screenshot

A screenshot can have several validated runs, from replays and retries (spec 1 §6.3, spec 3 §18.5). Its representative run is the one whose current table has the latest `createdAt`, then the greatest `runId`. `runsAgree` is true when every validated run of the screenshot has the same `gameFingerprint`. Silver keeps every run in `silver_validated_runs`, and only the representative run supplies statistics.

### 7.3 Sessions and matches

For each session with bronze associations, the session's current association is the one with the highest `associationVersion` (spec 8 §8.1). Silver copies the session and each match from it: `matchId`, `matchIndex`, `origin`, `status`, `mapId`, `mapCatalogVersion`, `selectedAt`, `screenshotIds` and `flags`. `mapName` is the `displayName` of the map in the bronze map catalog of that `mapCatalogVersion`, or `null` when bronze lacks the catalog.

`playedAt` is `selectedAt` for a `LIVE` match (`playedAtSource: MAP_SELECTED`). For an `ADDED` match it is the earliest `effectiveAt` among its screenshots in the association (`CAPTURE_TIME`), and otherwise the session's `endedAt` (`SESSION_END`). A match with none of these, which only an open session can have, has `playedAt: null` and is never countable. `playedAt` places a match in time windows (§8.1, §8.5) and is never used to order matches.

**Match order.** Matches are ordered by their session's `startedAt`, then `sessionId`, then `matchIndex`. Spec 8 makes `matchIndex` each match's chronological position in its session, set only by `MAP_SELECTED` and `MATCH_ADDED`, so a map correction, a void or a restore never moves a match, and an `ADDED` match sits where the host placed it even when its `playedAt` comes from `endedAt` (spec 8 §7.1, §8.1). Every "latest", "newest first" and "last" over matches in §7 and §8 uses this order. Silver keys every match on `matchId` and reads `matchIndex` from the current association, because an added match moves the later ones.

Each screenshot with a representative run gets a `matchRole`:

| Condition | `matchRole` | `matchId` |
| --- | --- | --- |
| `runContext.channel` is `EMAIL` | `NO_SESSION` | `null` |
| The session has no bronze association, or its current association does not list the screenshot | `NOT_ASSOCIATED` | `null` |
| The current association lists it as `DERIVED` or `HOST_ASSIGNED` | `MATCH_MEMBER` | the association's `matchId` |
| It is listed as `DUPLICATE`, a repeated image of an earlier upload's screenshot | `ASSOCIATION_DUPLICATE` | the association's `matchId`, which is that of the screenshot it repeats; never counted (spec 8 §8.1) |
| It is listed as `UNASSIGNED` or `EXCLUDED` | `UNASSIGNED` or `EXCLUDED` | `null` |

### 7.4 Statistics source of a match

The members of a match are its `screenshotIds` in the current association, in that order, which excludes `DUPLICATE` screenshots. Silver decides `statsStatus` with the first row that applies:

| Condition | `statsStatus` |
| --- | --- |
| The match has no members | `NO_SCREENSHOT` |
| A member has no bronze validated run | `PENDING_REVIEW` |
| No member's representative table has `hasScoreboard: true` and at least one row | `NO_SCOREBOARD` |
| The boards fail the merge rule below | `CONFLICTING_SCREENSHOTS` |
| The merged rows hold one non-null `playerKey` twice | `DUPLICATE_PLAYER` |
| otherwise | `OK` |

**Boards.** A board is a member whose representative table has `hasScoreboard: true` and at least one row. Boards with the same `gameFingerprint` are captures of one board; the first in member order is the board's source and the rest are recorded in `captureScreenshotIds`.

**Merge rule.** With one distinct board, its rows are the match's rows. With several distinct boards, they are pages of one board and their rows are merged in member order when all of these hold: no row of any board has a `null` `playerKey`, no `playerKey` appears on two boards, and the merged rows meet spec 3's team and outcome rule (spec 3 §8.3 condition 5). `pageMerged` is then true. Otherwise the match is `CONFLICTING_SCREENSHOTS`, which a host fixes by excluding the wrong screenshot (spec 8 `SCREENSHOT_EXCLUDED`) and a reviewer by correcting the run, each of which writes new evidence.

**Which pages can merge in v1.** Every board is a validated table, and spec 3 writes one only for a review-complete run, whose own rows must meet condition 5: exactly one winning team. A page therefore reaches silver only when it shows the winner, and the merge rule then sees one winner per page:

| Pages of one board | Result |
| --- | --- |
| Team board, every page holding at least one row of the winning team | Each page can become review-complete with the same winning team, and the validated pages merge (`OK`). |
| Team board with a page that holds only losing-team rows | That page never becomes review-complete, so the match stays `PENDING_REVIEW`. |

A host can count such a match by excluding the page that cannot complete (spec 8 `SCREENSHOT_EXCLUDED` with `OTHER`), and the match then holds only the other page's players. Counting every page needs a spec 3 outcome rule for partial pages, which is backlog P5.8 (§18.13).

A match is `countable` when its `status` is `ACTIVE`, its `statsStatus` is `OK` and its `playedAt` is set. Only countable matches reach gold.

### 7.5 Player identity

`nameKey(text)` applies Unicode NFKC normalization, lowercases, collapses every run of whitespace to one space and trims. A validated row's `player` is already tidied by spec 1 §8.2 step 4 (spec 3 §8.4), which removes one leading clan tag.

| Row | `identity` | `playerKey` |
| --- | --- | --- |
| `player` is `null` (the name was unreadable) | `UNREADABLE` | `null` |
| `nameKey(player)` equals `nameKey(gamertag)` of a roster entry, active or inactive | `ROSTER` | the entry's `gamertagId` |
| otherwise | `UNROSTERED` | `name-` followed by the first 32 hexadecimal characters of the SHA-256 of `nameKey(player)` |

When several roster entries share a `nameKey`, which spec 6 refuses for entries equal ignoring case, the row links to an active entry before an inactive one, then to the greatest `gamertagId`. Unrostered keys are hashes so that no gamertag appears in an S3 key, a Glue partition or a log line.

Every `UNROSTERED` player records `rosterKeyMatches`, the `gamertagId` of every roster entry whose `rosterKey` (spec 6 §7.1) equals `rosterKey` of the player's latest name. Silver never links on it. It shows an operator a name that looks like a roster gamertag, which is usually a player the operator should add, or a validated value a reviewer should correct.

A player's `gamertag` is the roster entry's gamertag for `ROSTER` players, and for `UNROSTERED` players the `player` text of their latest countable row in match order (§7.3), or of their latest row in that order when none is countable.

### 7.6 Silver tables

Each table is one JSON Lines file per build with the columns below in snake case. Athena types follow the column: `string`, `bigint`, `double`, `boolean` or `array<string>`. Timestamps are ISO 8601 UTC strings.

| Table | One row per | Columns |
| --- | --- | --- |
| `silver_validated_runs` | run with a bronze validated table | `run_id`, `screenshot_id`, `submission_id`, `image_sha256`, `validated_table_id`, `validated_version`, `version_count`, `version_gap`, `validated_at` (`createdAt`), `adjudication_set_sha256`, `content_sha256`, `game_fingerprint`, `has_scoreboard`, `row_count`, `human_decisions` and `llm_decisions` (sums of spec 3 2.1-draft `currentDecisionCounts`, `null` when absent), `llm_reviewers` (`<modelId>@<promptVersion>`), `channel`, `session_id`, `upload_id`, `received_at`, `representative`, `source_key`, `bronze_key` |
| `silver_screenshots` | screenshot with a validated run | `screenshot_id`, `submission_id`, `image_sha256`, `channel`, `session_id`, `upload_id`, `received_at`, `representative_run_id`, `run_count`, `runs_agree`, `association_version`, `association_status`, `match_role`, `match_id`, `duplicate_of`, `captured_at`, `effective_at` |
| `silver_sessions` | session with a bronze association | `session_id`, `association_version`, `status`, `started_at`, `ended_at`, `host_time_zone`, `match_count`, `voided_match_count`, `countable_match_count` |
| `silver_matches` | match in a current association | `match_id`, `session_id`, `association_version`, `match_index`, `origin`, `status`, `map_id`, `map_name`, `map_catalog_version`, `selected_at`, `played_at`, `played_at_source`, `association_flags`, `member_screenshot_ids`, `board_screenshot_ids`, `capture_screenshot_ids`, `page_merged`, `stats_status`, `countable`, `player_row_count` |
| `silver_players` | `playerKey` that appears on a row of an `OK` match | `player_key`, `identity`, `gamertag_id`, `gamertag`, `roster_status` (`ACTIVE`, `INACTIVE` or `null`), `roster_key_matches`, `first_played_at`, `last_played_at`, `countable_matches` |
| `silver_player_match_stats` | row of a match whose `stats_status` is `OK` | `match_id`, `session_id`, `map_id`, `played_at`, `countable`, `player_key`, `identity`, `player_text`, `team`, `score`, `kills`, `assists`, `deaths`, `win`, `loss`, `unreadable_fields`, `screenshot_id`, `run_id`, `validated_table_id`, `validated_version`, `adjudication_set_sha256`, `row_key`, `row_origin`, `reviewer_kinds`, `auto_accepted` |
| `silver_maps` | `mapId` in any bronze catalog | `map_id`, `game`, `display_name`, `selectable`, `map_catalog_version` (the highest catalog version listing it) |

In `silver_player_match_stats`, `score`, `kills`, `assists` and `deaths` are the validated table's integers or `null` (spec 3 §8.4), and `unreadable_fields` lists the fields whose value source is `UNREADABLE` or `NOT_PRESENT`. `reviewer_kinds` is the sorted distinct set of the row's `rowReviewerKind` and its values' `reviewerKind`, empty for a validated table without them. `auto_accepted` is true when any value's source is `AUTO_ACCEPTED`. An `UNREADABLE` row stays in the table with a `null` `player_key`, so a match's scoreboard keeps every player.

## 8. Gold datasets

`buildGold(silver, config)` in `src/lib/gold.ts` is pure and reads only silver. It uses only rows of countable matches. Match scoreboards keep `UNREADABLE` rows, whose `player_key` is `null`; player summaries, player documents, leaderboards and rising players use only rows with a non-null `player_key`.

### 8.1 Definitions

| Term | Definition |
| --- | --- |
| `asOf` | The latest `played_at` of any countable match. Every time window ends at `asOf`, never at the build's clock, so the same inputs give the same gold. |
| `matches`, `wins`, `losses` | Count of the player's rows, and the sums of `win` and `loss`. |
| `winRate` | `wins / matches`. |
| `kills`, `assists`, `deaths`, `score` | Sums over the rows where the value is not `null`. |
| `killsPerMatch`, `assistsPerMatch` | The sum divided by the number of rows where that value is not `null`; `null` when there are none. |
| `kdRatio` | Over rows where both `kills` and `deaths` are not `null`: summed kills divided by the greater of summed deaths and 1; `null` when there are none. |

Values are JSON numbers as computed, without rounding. Rounding for display is the player app's choice.

### 8.2 Gold tables

| Table | One row per | Columns |
| --- | --- | --- |
| `gold_player_summaries` | player with a countable row | `player_key`, `identity`, `gamertag`, `rostered`, `matches`, `wins`, `losses`, `win_rate`, `kills`, `assists`, `deaths`, `score`, `kills_per_match`, `assists_per_match`, `kd_ratio`, `first_played_at`, `last_played_at`, `last_match_id` |
| `gold_match_scoreboards` | row of a countable match, including `UNREADABLE` rows | `match_id`, `session_id`, `played_at`, `map_id`, `map_name`, `team`, `player_key`, `gamertag`, `rostered`, `score`, `kills`, `assists`, `deaths`, `win`, `loss`, `reviewer_kinds` |
| `gold_recent_matches` | one of the `recentMatchesSize` latest countable matches in match order (§7.3) | `rank`, `match_id`, `session_id`, `played_at`, `map_id`, `map_name`, `player_count`, `winning_team` |
| `gold_leaderboards` | ranked player per metric | `metric`, `rank`, `player_key`, `gamertag`, `value`, `matches` |
| `gold_rising_players` | ranked rising player | `rank`, `player_key`, `gamertag`, `recent_matches`, `baseline_matches`, `recent_kd_ratio`, `baseline_kd_ratio`, `kd_ratio_delta`, `recent_win_rate`, `baseline_win_rate`, `win_rate_delta`, `as_of` |

`gamertag` is the silver player's `gamertag`, or `null` for an `UNREADABLE` row. `winning_team` is the team of the `WIN` rows. `last_match_id` is the player's last countable match in match order (§7.3), and `rank` 1 in `gold_recent_matches` is the latest match.

### 8.3 Serving documents

The player app reads these documents under `<ns>builds/{buildId}/serving/` in the gold bucket. Each is a JSON object with `schemaVersion` and `asOf`, serialized like a table line (object keys sorted bytewise, no whitespace), and is written once. No serving document holds `buildId`, the namespace, a timestamp of the build, or any other value that differs between two builds of the same inputs, so their bytes depend only on the build's inputs (§3.1). The pointer names the build that serves them.

| Key, relative to the serving prefix | `schemaVersion` | Contents |
| --- | --- | --- |
| `index.json` | `gold-serving-index/v1` | `lakehouseRulesVersion`, `lakehouseConfigVersion`, counts of players, rostered players and countable matches, and the keys of every other document relative to the serving prefix |
| `players/index.json` | `gold-players-index/v1` | every player from `gold_player_summaries`: `playerKey`, `gamertag`, `rostered`, `matches`, `lastPlayedAt`, sorted by `playerKey` |
| `players/{playerKey}.json` | `gold-player/v1` | the player's summary and every countable match they played, newest first in match order (§7.3): `matchId`, `playedAt`, `mapId`, `mapName`, `team`, `score`, `kills`, `assists`, `deaths`, `win` |
| `matches/{matchId}.json` | `gold-match/v1` | the match's `sessionId`, `playedAt`, `mapId`, `mapName`, and its scoreboard rows from `gold_match_scoreboards` in validated row order |
| `matches/recent.json` | `gold-recent-matches/v1` | `gold_recent_matches` |
| `leaderboards.json` | `gold-leaderboards/v1` | each metric's ranked list from `gold_leaderboards` |
| `rising-players.json` | `gold-rising-players/v1` | `gold_rising_players` and the window bounds |

`<ns>serving/current.json` names the current build (§5.3). The player app never lists the bucket.

`servingContentSha256` in the build manifest is the SHA-256 of one line per serving document, `<relative key> <SHA-256 of its bytes>`, sorted bytewise by key and joined with `\n`. Two builds of the same inputs have the same value, as each table has the same `contentSha256`.

### 8.4 Leaderboards

Each metric ranks rostered players with at least `leaderboardMinMatches` countable matches and a non-null value, by value descending, then `matches` descending, then `playerKey`. The first `leaderboardSize` are kept.

| `metric` | Value |
| --- | --- |
| `WIN_RATE` | `winRate` |
| `KD_RATIO` | `kdRatio` |
| `KILLS_PER_MATCH` | `killsPerMatch` |
| `ASSISTS_PER_MATCH` | `assistsPerMatch` |
| `MATCHES_PLAYED` | `matches` |

### 8.5 Rising players

The recent window is `[asOf - risingRecentDays, asOf]` and the baseline window is `[asOf - risingRecentDays - risingBaselineDays, asOf - risingRecentDays)`. A rostered player qualifies with at least `risingMinRecentMatches` countable matches in the recent window and `risingMinBaselineMatches` in the baseline window, a non-null `kdRatio` in both, and `kdRatioDelta = recentKdRatio - baselineKdRatio` above 0. Qualifying players are ranked by `kdRatioDelta` descending, then `winRateDelta` descending, then recent matches descending, then `playerKey`, and the first `risingSize` are kept.

### 8.6 Parameters and refresh

| Parameter | v1 value | Notes |
| --- | --- | --- |
| `recentMatchesSize` | 50 | §8.2 |
| `leaderboardMinMatches` | 10 | §8.4 |
| `leaderboardSize` | 25 | §8.4 |
| `risingRecentDays` | 30 | §8.5 |
| `risingBaselineDays` | 90 | §8.5 |
| `risingMinRecentMatches` | 5 | §8.5 |
| `risingMinBaselineMatches` | 5 | §8.5 |
| `risingSize` | 10 | §8.5 |

Every gold table and serving document is recomputed in full by every build that publishes (§6.3). The schedule runs every 15 minutes, a build that finds unchanged inputs publishes nothing, and a published build replaces every document at once through the pointer. These values are initial; P4.3 records a live build, and a change is a new configuration version filed as its own issue.

## 9. Relationship with other specifications

### 9.1 Spec 3

Bronze reads `validated-table/v1` as spec 3 §8.4 and §8.5 define it. It requires the fields every validated table carries and reads the 2.1-draft fields `reviewerKind`, `rowReviewerKind`, `currentDecisionCounts` and `llmReviewers` when present, and bronze stores each document whole, so they are kept either way. Spec 3 §8.5's rule that "the lakehouse selects the latest version per run" is §7.1 here. Spec 3 §18.5 leaves the choice between sibling runs to this spec, which makes it in §7.2. Spec 3 §8.3 condition 5 applies to each run on its own, which limits the pages of one board that silver can merge in v1 (§7.4, §18.13).

### 9.2 Spec 8

Spec 8 §8.1 is the match input. Bronze ingests every association version and map catalog, silver uses the latest association per session (§7.3), joins a run to its match by `screenshotId` and its session by `intake.sessionId` in the run manifest, treats a screenshot no association lists as unassigned, and never counts a `DUPLICATE`. Spec 8 leaves the choice of screenshot per match and the handling of `MULTIPLE_SCREENSHOTS` and `NO_SCREENSHOT` to this spec, which makes it in §7.4.

Silver relies on the three guarantees of spec 8 §8.1. An association lists at most one screenshot per upload, the one its receipt names, so a retried intake never adds a member, and a submission without a receipt has no run silver could count. `DUPLICATE` means only a repeated image across uploads, so §7.4 treats every member as a distinct screenshot and uses board content only to tell captures from pages. `matchIndex` is a match's chronological position, which corrections never change, so match order (§7.3) comes from the association and never from event times.

### 9.3 Spec 6

Spec 6 hands player identity across gamertags and consent to this spec. §7.5 links validated names to roster entries by gamertag, as spec 6 §8.3 suggests, and §1 records the consent decision. The build reads the roster change log through the same table and `LeadingKeys` rule as `extract-text`, and never writes it. Roster resolutions on parser rows (`playerResolution`) and the CSV `PlayerMatch` column are not lakehouse inputs, because validated tables replace the readings they describe.

### 9.4 Spec 2, spec 7 and #161

Spec 2 §2.2 keeps features, scores and training data out of the lakehouse, and this spec never reads them. Spec 2 §8.5 rule 6 and spec 7 §8.1 group datasets by match once a match identity exists; that identity is spec 8's `matchId`, read from the evidence bucket, and this spec defines no other. Spec 7's autonomy report and audit bounds stay in the evidence bucket. Row `reviewFlags` (#161) stay on parser rows.

### 9.5 Recorded dependencies

This spec edits no other specification. The slice named in each row records the change where it applies when it merges, or the owning spec's next revision does.

| Dependency | Owner | Handled by |
| --- | --- | --- |
| `ValidatedTable` and its value and row types in `@mcc/contracts` | spec 3 P0.2 | P0.2 is blocked by it. |
| `SessionAssociation`, `MapCatalog` and `SourceScreenshot.intake` in `@mcc/contracts` | spec 8 P0.1 | P0.2 is blocked by it. |
| `foldRoster`, `rosterKey` and the roster types | spec 6 P0.1, P0.2 | P3.2 is blocked by spec 6 P0.2. |
| Roster table and `/mcc/<env>/roster/` parameters | spec 6 P1.1 | P4.2 cannot merge until it is applied. |
| Evidence bucket EventBridge notifications | spec 2 P1.1 | P4.2 cannot merge until it is applied. |
| Roster gamertags copied into silver and gold under the lakehouse key, while spec 6 §14 item 2 says roster contents live only under the application data key | spec 6 | Spec 6's next revision extends §14 item 2 to the lakehouse buckets under the lakehouse key. |
| Out-of-scope lines naming #159 for match records, player identity or consent | spec 3, spec 6, spec 7 | Each spec's next revision points player identity and consent to this spec and match records to spec 8. |
| An outcome rule for partial scoreboard pages, so pages without the winner can become review-complete (§7.4, §18.13) | spec 3 | Not needed for v1. P5.8 is blocked by spec 3's revision. |
| The player app's read access, audience and any opt-out (§1, §4.5) | the player app specification (none yet) | That specification reads §4.5 and §8.3 as its data contract. |
| Data platform roots inactive in Terrateam | `infrastructure/`, `.terrateam/config.yml` | P1.1 activates them. |

## 10. Typed domain model

### 10.1 Shared contracts

`@mcc/contracts` exports the following, next to spec 3's `ValidatedTable`, spec 8's `SessionAssociation` and `MapCatalog`, and spec 6's `RosterReference`:

```typescript
interface EvidenceSource {
  key: string;                          // relative to the evidence bucket
  versionId: string | null;
  sha256: string;                       // of the object bytes
  sizeBytes: number;
}

interface IngestRecord {
  ingestedAt: string;
  bronzeIngestVersion: string;
  build: { gitSha: string; environment: string };
}

interface RunContext {
  channel: 'EMAIL' | 'SESSION_UPLOAD';
  sessionId: string | null;
  uploadId: string | null;
  receivedAt: string;                   // submission ingestion.json
  versions: Readonly<Record<string, string>>; // run manifest versions
}

interface BronzeValidatedTable {
  schemaVersion: 'bronze-validated-table/v1';
  source: EvidenceSource;
  ingest: IngestRecord;
  runContext: RunContext;
  document: ValidatedTable;             // spec 3 §10.1, 2.1-draft fields optional
}

interface BronzeSessionAssociation {
  schemaVersion: 'bronze-session-association/v1';
  source: EvidenceSource;
  ingest: IngestRecord;
  document: SessionAssociation;         // spec 8 §10.1
}

interface BronzeMapCatalog {
  schemaVersion: 'bronze-map-catalog/v1';
  source: EvidenceSource;
  ingest: IngestRecord;
  document: MapCatalog;                 // spec 8 §10.1
}

type BronzeRejectionCode =
  | 'UNPARSEABLE' | 'UNSUPPORTED_SCHEMA' | 'KEY_MISMATCH' | 'MISSING_FIELD' | 'RUN_CONTEXT_MISSING';

interface BronzeRejection {
  schemaVersion: 'bronze-rejection/v1';
  source: EvidenceSource;
  ingest: IngestRecord;
  code: BronzeRejectionCode;
  detail: string | null;                // a field name or expected value; never document content
}

type MatchRole =
  | 'NO_SESSION' | 'NOT_ASSOCIATED' | 'MATCH_MEMBER' | 'ASSOCIATION_DUPLICATE' | 'UNASSIGNED' | 'EXCLUDED';
type StatsStatus =
  | 'NO_SCREENSHOT' | 'PENDING_REVIEW' | 'NO_SCOREBOARD' | 'CONFLICTING_SCREENSHOTS' | 'DUPLICATE_PLAYER' | 'OK';
type PlayerIdentity = 'ROSTER' | 'UNROSTERED' | 'UNREADABLE';
type PlayedAtSource = 'MAP_SELECTED' | 'CAPTURE_TIME' | 'SESSION_END';
type LeaderboardMetric = 'WIN_RATE' | 'KD_RATIO' | 'KILLS_PER_MATCH' | 'ASSISTS_PER_MATCH' | 'MATCHES_PLAYED';

interface LakehouseBuild {
  schemaVersion: 'lakehouse-build/v1';
  buildId: string;                      // evidenceId()
  namespace: string;                    // 'stable' or 'ephemeral/<name>'
  inputsSha256: string;
  inputs: { validatedTables: number; sessionAssociations: number; mapCatalogs: number; rejections: number };
  roster: { rosterVersion: number; rosterSha256: string };
  versions: { lakehouseRulesVersion: string; lakehouseConfigVersion: string };
  tables: readonly { name: string; bucket: 'silver' | 'gold'; key: string; rows: number; contentSha256: string }[];
  servingDocuments: number;
  servingContentSha256: string;         // §8.3; equal for two builds of the same inputs
  asOf: string | null;
  startedAt: string;
  completedAt: string;
  build: { gitSha: string; environment: string };
}

interface GoldServingPointer {
  schemaVersion: 'gold-serving-pointer/v1';
  buildId: string;
  inputsSha256: string;
  servingPrefix: string;                // '<ns>builds/<buildId>/serving/'
  asOf: string | null;
  publishedAt: string;
}
```

Each silver and gold table has a row interface with the columns in §7.6 and §8.2, named after the table in Pascal case (`SilverPlayerMatchStatsRow`, `GoldPlayerSummaryRow`), and each serving document in §8.3 has an interface named after its `schemaVersion` (`GoldPlayerDocument`). `contentSha256` of a table is the SHA-256 of its uncompressed JSON Lines bytes. Bronze documents are validated against these types with schema validators when read, and evidence documents when ingested.

### 10.2 Relationships

```text
Validated table version (evidence) 1 -> 0..1 bronze validated table (or 1 rejection)
Processing run 1 -> many bronze validated tables (versions); the highest is current
Screenshot 1 -> many runs; 1 representative run
Session 1 -> many bronze associations; the highest is current
Match 1 -> many member screenshots -> 0..many boards -> 0..many player rows
Player row many -> 0..1 player (roster entry or unrostered name)
Build 1 -> 1 manifest, 1 file per silver and gold table, many serving documents
Serving pointer 1 -> 1 published build
```

## 11. Module and function catalog

Every handler exports `handler` for Lambda and a core function that takes an injected dependencies object. Only the default dependencies construct SDK clients.

### 11.1 Lambda entry points

| File | Public functions | Purpose |
| --- | --- | --- |
| `src/lambdas/ingest-bronze.ts` | `handler(event)`; `ingestBronze(event, dependencies)` | §6.1. |
| `src/lambdas/backfill-bronze.ts` | `handler(event)`; `backfillBronze(input, dependencies)` | §6.2. |
| `src/lambdas/build-lakehouse.ts` | `handler(event)`; `buildLakehouse(input, dependencies)` | §6.3. |

### 11.2 Libraries

| File | Public functions | Purpose |
| --- | --- | --- |
| `src/lib/bronze-keys.ts` | `parseEvidenceKey(key, objectPrefix)`; `bronzeKey(source)`; `rejectionKey(source)` | §4.2, §5.1. Pure. |
| `src/lib/bronze-documents.ts` | `checkDocument(kind, parsedKey, document)`; `runContext(manifest, ingestion)`; `bronzeDocument(...)` | §4.3, §5.3. Pure. |
| `src/lib/silver.ts` | `buildSilver(bronze, roster, config)`; `gameFingerprint(rows)`; `matchStats(match, members)`; `outcomeConsistent(rows)` | §7.1 to §7.4, §7.6. Pure. |
| `src/lib/players.ts` | `nameKey(text)`; `linkPlayer(text, rosterIndex)`; `rosterIndex(entries)` | §7.5. Pure; uses `rosterKey` from `@mcc/roster`. |
| `src/lib/gold.ts` | `buildGold(silver, config)`; `summaries`; `leaderboards`; `risingPlayers` | §8.1 to §8.5. Pure. |
| `src/lib/serving.ts` | `servingDocuments(gold, versions)`; `servingContentSha256(documents)`; `jsonLines(rows)`; `inputsSha256(keys, roster, versions)` | §6.3, §8.3. Pure; never receives `buildId`. |
| `src/lib/catalog.ts` | `TABLES`; `GlueCatalogPublisher` | Glue table definitions and the create-or-update call (§6.3 step 9). |
| `src/lib/roster-source.ts` | `readRoster(namespace, dependencies)` | §6.3 step 2. |
| `src/lib/storage.ts` | `listKeys`, `readJson`, `putOnce`, `putPointer` | S3 access for all handlers. |
| `src/lib/config.ts` | `loadLakehouseConfig()` | Read and validate the bundled configuration. |
| `src/lib/log.ts` | `log(level, message, details?)` | One JSON log line per call. |

### 11.3 Infrastructure code

| File | Public API | Purpose |
| --- | --- | --- |
| `cdk/lib/app.ts` | `createDataPipelineApp(props?, environmentVariables?)` | Build the stack exactly as deployment does. |
| `cdk/lib/data-pipeline-stack.ts` | `DataPipelineStack` | All application resources (§13.3). |
| `infrastructure/modules/data-platform/*.tf` | lifecycle, bucket policies, workgroup parameter | §13.2. |

## 12. Directory structure and ownership

```text
mcc-stats-suite/
  applications/data-pipeline/
    cdk.json
    package.json                        # @mcc/data-pipeline; build, typecheck, test
    TESTING.md
    config/lakehouse-config-v1.json     # Bundled, immutable once released
    cdk/
      bin/data-pipeline.ts
      lib/{app,data-pipeline-stack}.ts
    src/
      lambdas/{ingest-bronze,backfill-bronze,build-lakehouse}.ts
      lib/{bronze-keys,bronze-documents,silver,players,gold,serving,catalog,roster-source,storage,config,log}.ts
    test/
      *.test.ts
      fixtures/*.fixture.json           # Bronze sets with an expected silver and gold
  packages/contracts/src/index.ts       # §10.1
  infrastructure/modules/data-platform/
  infrastructure/{dev,prod}/data-platform/
  scripts/local-cdk-bootstrap.mjs       # Ephemeral permissions for data-pipeline stacks
```

`data-pipeline` imports only `@mcc/contracts`, `@mcc/cdk-config` and `@mcc/roster` from the monorepo, never `match-to-csv`, `admin` or `ocr-quality` code, and the workspace boundary test enforces it (P0.1).

## 13. Configuration and infrastructure

### 13.1 Configuration schema

```json
{
  "lakehouseConfigVersion": "lakehouse-config-v1",
  "recentMatchesSize": 50,
  "leaderboardMinMatches": 10,
  "leaderboardSize": 25,
  "risingRecentDays": 30,
  "risingBaselineDays": 90,
  "risingMinRecentMatches": 5,
  "risingMinBaselineMatches": 5,
  "risingSize": 10,
  "bronzeReadConcurrency": 32,
  "largeInputWarningObjects": 20000
}
```

The file is bundled into the Lambdas and holds no secret. `loadLakehouseConfig` validates every key at cold start: every value other than `lakehouseConfigVersion` is a positive integer, `leaderboardSize` and `risingSize` are at most 100, and `bronzeReadConcurrency` is at most 64. It throws `InvalidLakehouseConfigError` on any problem. A released file is never edited; a change adds `lakehouse-config-v2.json` and bumps `lakehouseConfigVersion`.

### 13.2 Persistent resources

| Resource | Owner | Configuration |
| --- | --- | --- |
| Bronze, silver and gold buckets `<project>-<env>-<account>-{bronze,silver,gold}` | OpenTofu `data-platform` | Existing: versioned, public access blocked, SSE-KMS with the lakehouse key and Bucket Keys. P1.1 adds a bucket policy that denies requests without TLS, and a lifecycle rule that expires `ephemeral/` objects after 30 days and their noncurrent versions after 1 day, aborts incomplete uploads after 7 days, and removes expired delete markers. Objects outside `ephemeral/` never expire. |
| Lakehouse KMS key `alias/<project>-<env>-lakehouse` | OpenTofu `data-platform` | Existing, with rotation. |
| Glue database `<project>_<env>_lakehouse` | OpenTofu `data-platform` | Existing. Holds the stable stack's tables. |
| Athena workgroup `<project>-<env>-analytics` | OpenTofu `data-platform` | Existing; results under `athena-results/` in the gold bucket, encrypted with the lakehouse key. |
| SSM parameters under `/mcc/<env>/data-platform/` | OpenTofu `data-platform` | Existing `bronze-bucket-name`, `silver-bucket-name`, `gold-bucket-name`, `catalog-database-name`, `kms-key-arn`. P1.1 adds `athena-workgroup-name`. |
| Evidence bucket, foundation data key, roster table | OpenTofu foundation | Existing (spec 1 §13.1) and spec 6 P1.1. The stack reads `/mcc/<env>/match-to-csv/evidence-bucket-name`, `/mcc/<env>/match-to-csv/data-key-arn` and `/mcc/<env>/roster/table-name`. |

The data-platform roots are inactive today: Terrateam runs neither, and the self-hosting guide tells operators to skip them. P1.1 gives both roots Terrateam `dirs` entries with the tags `[aws, dev, data-platform]` and `[aws, prod, data-platform]`, `'${DIR}/*.tf'`, `'${DIR}/*.tfvars'`, `'${DIR}/*.hcl'`, `'infrastructure/modules/data-platform/*.tf'` and `'.terrateam/config.yml'`, keeps the module's own `autoplan: false` entry, and updates the guides that call the roots inactive. Applying it needs a person's approval. The data platform knows nothing about the stack.

### 13.3 Application resources

| Resource | Configuration |
| --- | --- |
| `IngestBronze` | Node.js 22, ARM64, 512 MB, 1-minute timeout, X-Ray, env `EVIDENCE_BUCKET`, `BRONZE_BUCKET`, `OBJECT_PREFIX`, `GIT_SHA`, `DEPLOYMENT_ENVIRONMENT` |
| `BackfillBronze` | as `IngestBronze`, with 1,024 MB and a 15-minute timeout |
| `BuildLakehouse` | Node.js 22, ARM64, 2,048 MB, 15-minute timeout, reserved concurrency 1, asynchronous retries 0 and maximum event age 15 minutes, X-Ray, env `BRONZE_BUCKET`, `SILVER_BUCKET`, `GOLD_BUCKET`, `GLUE_DATABASE`, `ROSTER_TABLE`, `ROSTER_NAMESPACE`, `OBJECT_PREFIX`, `GIT_SHA`, `DEPLOYMENT_ENVIRONMENT` |
| EventBridge rule and DLQ | §4.1 |
| Build schedule | EventBridge Scheduler, `rate(15 minutes)`, target `BuildLakehouse` with input `{}`, retry policy of 0 attempts |
| Ephemeral Glue database | Ephemeral stacks only: `<project>_dev_e_<name>_lakehouse` with hyphens as underscores, removed with the stack. `GLUE_DATABASE` names it; stable stacks name the OpenTofu database. |
| Outputs | `BuildFunctionName`, `BackfillFunctionName`, `GlueDatabaseName`, `ObjectPrefix` |

`ROSTER_NAMESPACE` is `stable` or `ephemeral/<name>`, as in spec 6 §13.3. Log groups follow match-to-csv: three months in prod, two weeks otherwise, retained for stable stacks and destroyed with ephemeral ones.

### 13.4 Permissions

| Principal | Evidence bucket | Bronze bucket | Silver and gold buckets | Other |
| --- | --- | --- | --- | --- |
| `IngestBronze` | `GetObject` on `<ns>submissions/*/runs/*/validated/*`, `<ns>submissions/*/runs/*/manifest.json`, `<ns>submissions/*/ingestion.json`, `<ns>sessions/*/association/*` and `<ns>map-catalogs/*` | `GetObject`, `PutObject` on `<ns>validated-tables/*`, `<ns>session-associations/*`, `<ns>map-catalogs/*` and `<ns>ingest-rejections/*`; `ListBucket` with those prefixes | none | decrypt with the foundation data key; encrypt and decrypt with the lakehouse key |
| `BackfillBronze` | as `IngestBronze`, plus `ListBucket` with prefixes `<ns>submissions/`, `<ns>sessions/` and `<ns>map-catalogs/` | as `IngestBronze` | none | as `IngestBronze` |
| `BuildLakehouse` | none | `GetObject` on `<ns>validated-tables/*`, `<ns>session-associations/*` and `<ns>map-catalogs/*`; `ListBucket` with those prefixes and `<ns>ingest-rejections/` | `GetObject`, `PutObject` on `<ns>builds/*`; gold also on `<ns>serving/current.json` | roster table `GetItem` and `Query` with `dynamodb:LeadingKeys` `ROSTER#<namespace>`; decrypt with the foundation data key through DynamoDB; encrypt and decrypt with the lakehouse key; Glue `GetTable`, `CreateTable`, `UpdateTable` on the regional catalog `arn:aws:glue:<region>:<account>:catalog`, its database `arn:aws:glue:<region>:<account>:database/<database>` and its tables `arn:aws:glue:<region>:<account>:table/<database>/*` |

`<ns>` is empty for stable stacks and `ephemeral/<name>/` for ephemeral ones. An IAM `*` matches across `/`, so the allowed patterns above also match deeper keys, such as a spec 2 quality run's `manifest.json`. Each role that reads the evidence bucket therefore also has an explicit `Deny` of `s3:GetObject` on `<ns>submissions/*/runs/*/textract/*`, `.../normalized/*`, `.../quality/*`, `.../adjudications/*`, `.../blind-adjudications/*`, `.../review/*`, `.../llm-review/*` and `.../export/*`, on `<ns>submissions/*/screenshots/*/source/*`, and on `<ns>datasets/*` and `<ns>risk/*`. With those denies, no role can read OCR, quality, review, LLM review, export, source, dataset or risk evidence. No role can write to the evidence bucket, or call `DeleteObject`, `DeleteTable` or any bucket-configuration action.

Glue authorizes a call against the resource it names and every ancestor of it, so a table action needs the table, its database and the catalog, and the build fails before the serving pointer without the catalog ARN ([Glue resource ARNs](https://docs.aws.amazon.com/glue/latest/dg/glue-specifying-resource-arns.html)). The catalog ARN grants nothing on other databases' tables, because each call is also checked against the table and database ARNs, which name only `<database>`, the database `GLUE_DATABASE` names. Every role carries the workload permissions boundary and, for ephemeral stacks, the `/mcc-local/` path. Operators query with Athena through their existing administrator roles.

P1.2 extends `scripts/local-cdk-bootstrap.mjs` so ephemeral `data-pipeline-e-*` stacks can create and delete their functions, rule, schedule, queue and Glue database, and so the local workload boundary allows the actions above only under `ephemeral/<name>/` in the evidence and lakehouse buckets, only on the roster partition `ROSTER#ephemeral/<name>`, and only on Glue databases named for the stack. Each Glue statement, in the execution role and in the boundary, lists the regional catalog ARN beside the database and table ARNs named for the stack. Deleting the database with the stack also needs its children, so the execution role's `DeleteDatabase` statement lists the catalog, the database, `table/<database>/*` and `userDefinedFunction/<database>/*`.

### 13.5 Deployment

The stack deploys through `scripts/cdk-app.mjs` like match-to-csv: stable stacks from GitHub Actions on `main`, dev then prod with a required reviewer; ephemeral stacks from a local shell with `--environment dev --ephemeral <name>`. The deploy preflight fails when any SSM parameter in §13.2 is missing. Post-deploy verification checks that the stack is complete, every Lambda is `Active` and the schedule is `ENABLED`, then invokes `BuildLakehouse` with `{}` and expects `PUBLISHED` or `UNCHANGED`. P1.1 must be applied, and spec 2 P1.1 and spec 6 P1.1 applied, before a stack can receive events or read the roster.

## 14. Security and privacy

1. Evidence keys are untrusted input. Every key is checked against §4.2 and the stack namespace before any read, and bronze keys are built only from validated identifiers.
2. Evidence documents are parsed as data, size-capped at 4 MiB and validated against their schemas before use. No document field becomes a key, path, SQL fragment or Glue identifier.
3. Gamertags live only in the bronze, silver and gold buckets, all encrypted with the lakehouse key and closed to public access, and in the evidence bucket and roster table they came from. Unrostered players are keyed by a hash (§7.5), so S3 keys, Glue metadata and logs never hold a gamertag.
4. Logs never contain gamertags, validated values or document content. Handlers log keys, identifiers, codes, counts and durations.
5. No role can delete a lakehouse object, change a bucket, read OCR or quality evidence, or write evidence (§13.4).
6. Ephemeral stacks read only their own evidence namespace and roster partition and write only under their own lakehouse prefix and Glue database, enforced by key checks and IAM resource patterns.
7. The gold bucket is private. Exposing any gold document to people outside AWS is the player app's decision and needs its own review (§1).

## 15. Observability

- Lambdas log JSON lines with `level`, `message` and context fields: `requestId`, source kind, identifiers from the key, `buildId`, `inputsSha256`, counts, durations and codes.
- X-Ray tracing is active on every function.
- The audit record for "what did the lakehouse receive" is bronze and its rejection records; for "what did the player app show" it is the build manifests and the serving pointer's version history.
- Undeliverable events wait 14 days in the DLQ. Alarms for DLQ depth, Lambda errors and builds that stop publishing follow spec 5 (backlog P5.3).

## 16. Testing, CI and release

### 16.1 Tests

Tests use `tap`, run from `applications/data-pipeline/test/*.test.ts`, and never call AWS. The command fails below 80% statements, 65% branches, 80% lines or 60% functions.

| File | Covers |
| --- | --- |
| `bronze-keys.test.ts` | every accepted key form for stable and ephemeral namespaces; other namespaces, deeper keys, unpadded versions and malformed identifiers rejected; bronze and rejection keys |
| `bronze-documents.test.ts` | each §4.3 check with its code; `runContext` for an emailed run and an uploaded run; 2.0-draft and 2.1-draft validated tables both accepted, with the 2.1-draft fields kept |
| `ingest-bronze.test.ts` | a validated table writes one bronze object with `source.sha256` of the evidence bytes; a repeated event writes nothing; `412` with the same hash succeeds and with another throws `BronzeConflictError`; a rejection writes a record and does not throw; no read outside the §13.4 patterns |
| `backfill-bronze.test.ts` | ingests only missing keys; `RUN` and `SESSION` scopes; continuation after the time limit |
| `silver.test.ts` | latest version per run, including a version gap; representative run by `createdAt` and `runId`; `runsAgree`; every `matchRole`; every `statsStatus` row in §7.4, including two captures of one board, two disjoint team pages that each hold a winning-team row, two pages that share a player, pages whose union has two winning teams, an unreadable name on a page, and a duplicate player; each row of the v1 page table in §7.4: a team page with only losing-team rows and no validated run leaves the match `PENDING_REVIEW`, and excluding the page that cannot complete gives `OK` with the other page's players only; `playedAt` for `LIVE` and `ADDED` matches; match order by session `startedAt`, `sessionId` and `matchIndex`, with an `ADDED` match anchored before the first `LIVE` match ordered first although its `playedAt` is `endedAt`, and a map correction leaving the order and `matchIndex` unchanged; voided matches not countable; `DUPLICATE` screenshots never counted |
| `players.test.ts` | `nameKey` with NFKC input, case and whitespace; links to active and inactive entries; tie rule for entries sharing a `nameKey`; unrostered keys are hashes with no gamertag text; `rosterKeyMatches` |
| `gold.test.ts` | every §8.1 definition with `null` values; leaderboards exclude unrostered players and players under `leaderboardMinMatches`, with the tie order; rising players on a fixture with windows that end at `asOf`, not the clock; recent matches order |
| `serving.test.ts` | JSON Lines keys sorted, `contentSha256` stable; the same inputs built under two `buildId` values give byte-identical table files and serving documents, equal `contentSha256` and `servingContentSha256`, and no serving document containing either `buildId` or the namespace; `index.json` keys are relative to the serving prefix; recent matches and player documents follow match order; `inputsSha256` changes with a new key, a roster version or a version bump |
| `build-lakehouse.test.ts` | unchanged inputs write nothing; `force` builds; publish order of §5.2 rule 4; a failure before the pointer leaves the old pointer; Glue tables created when missing and updated after; `RosterIntegrityError`; a correction (a second validated version) changes gold on the next build while bronze keeps version 1 |
| `app.test.ts` | stable and ephemeral synthesis; the §4.1 patterns; schedule and reserved concurrency; IAM resource patterns in §13.4, including every explicit `Deny` on evidence subprefixes and a Glue statement whose resources are exactly the regional catalog ARN, the stack's database ARN and its `table/<database>/*` ARN; the ephemeral Glue database |

A fixture is a set of bronze documents and a roster with player data replaced by placeholders, plus the expected silver and gold rows.

### 16.2 CI and release

CI runs format, lint, typecheck and `tap` for the `data-pipeline` workspace on affecting changes, and synthesizes it with `-c environment=dev -c ephemeral=ci`. Infrastructure changes run `npm run tofu:check`. Release Please versions the application and `@mcc/contracts`; a contracts change bumps every dependent application.

### 16.3 Live validation

After a change reaches dev, an operator runs a `NAMESPACE` backfill, invokes `BuildLakehouse`, and checks that `silver_validated_runs` in Athena lists every validated run in the namespace, that one test session's matches appear in `gold_match_scoreboards` with their map names, and that the player app pointer names the build. They then correct one validated cell through spec 3, wait for the next scheduled build, and check that bronze holds both versions, `silver_validated_runs` shows the new version, and the player's document under the new build shows the corrected value.

## 17. Acceptance criteria

v1 (Phases 0 to 4) is complete when:

1. Every `validated/{n}.json` written in a dev namespace has a bronze object within 5 minutes, holding the document, the evidence key, version ID and SHA-256, and the run's channel, session and `receivedAt`.
2. An evidence object that fails §4.3 gets a rejection record with its code and no bronze object.
3. A correction that writes `validated/000002.json` leaves the version 1 bronze object unchanged, and the next build's silver and gold use version 2.
4. Silver links each run to its session and match through the latest association, and a host correction in spec 8 changes the match's map or membership in the next build without changing its `matchIndex` or its place in match order (§7.3).
5. A match with two captures of one board, or two disjoint pages of a team board that each hold a winning-team row, yields one statistics row per player; a match with conflicting screenshots yields none and reports `CONFLICTING_SCREENSHOTS`; and a match with a page that cannot become review-complete under spec 3 §8.3 condition 5 (a team page with only losing-team rows) yields none and stays `PENDING_REVIEW` until the host excludes that page (§7.4).
6. A validated name that differs from a roster gamertag only by case, Unicode normalization form or repeated whitespace links to that entry, and an unrostered name produces a hashed `player_key` with no gamertag in any S3 key or log line.
7. Gold serving documents for players, matches, recent matches, leaderboards and rising players exist under the build the pointer names, no serving document contains a `buildId`, and two builds of the same inputs have byte-identical table files and serving documents, with equal `contentSha256` per table and equal `servingContentSha256`.
8. A build with unchanged inputs publishes nothing, and a failed build leaves the previous pointer in place.
9. No data-pipeline role can read OCR, quality, review, LLM review, dataset or risk evidence, write evidence, or delete a lakehouse object, and `app.test.ts` checks the allowed patterns, the explicit denies, and the Glue grant on the catalog, database and table ARNs in §13.4.
10. The data-platform roots plan and apply through Terrateam, and the lakehouse buckets expire `ephemeral/` objects.
11. An ephemeral stack ingests and builds only its own namespace, and destroying it removes its Glue database and tables.
12. Every §16.1 test passes with the coverage thresholds, and CDK synthesis succeeds.

## 18. Risks and accepted limitations

1. **Renamed gamertags split a player.** A player who changes gamertag has two `playerKey` values and two summaries. Accepted until P5.1 adds operator-maintained links, because a guessed link would merge two people.
2. **Emailed screenshots are not counted.** Players who email instead of uploading to a session contribute no statistics. Accepted because emailed screenshots have no match identity (§1); spec 8 P6.2 imports them into a session.
3. **Unrostered name variants split a player.** Two validated spellings of one unrostered player, such as with and without a space, are two players. `rosterKeyMatches` shows the case where one spelling looks like a roster gamertag, and adding the player to the roster fixes the rest.
4. **Full rebuilds have a ceiling.** Each build reads all of bronze. At a few thousand runs a year this takes seconds; `BUILD_INPUT_LARGE` warns long before the 15-minute limit, and P5.2 adds incremental builds.
5. **The representative run is the latest validated one.** When two runs of a screenshot disagree, the most recently validated wins, even if a person reviewed the other. `runsAgree` makes such screenshots visible.
6. **Unpublished build files accumulate.** Failed builds leave files nothing reads, and every published build stays. At a few megabytes a build the cost is negligible; pruning is backlog P5.7, because no role may delete today.
7. **Glue tables are not infrastructure-managed.** A table deleted by hand disappears from Athena until the next build that publishes; an operator recovers it with `{ "force": true }`.
8. **Page merges trust disjoint player sets.** Two different games with disjoint players under one map selection, whose union happens to be consistent, are merged into one match. Spec 8 flags `MULTIPLE_SCREENSHOTS` for the host, and such games are rare in a league that plays the same people.
9. **A reopened run keeps its last version.** While spec 3 has a run incomplete again, gold shows its previous validated version (spec 3 §6.3).
10. **Rising players depend on recent play.** With fewer than 5 matches in either window nobody qualifies, and the dataset is empty. The thresholds are configuration.
11. **LLM-decided statistics count.** Most validated tables are decided by the LLM reviewer (spec 7), and their errors reach gold. Spec 7's audit bounds (spec 7 §9.2) measure the rate, and `reviewer_kinds` lets consumers separate them.
12. **The stack reads SSM parameters under `match-to-csv`.** As spec 2 §18.14 records, the evidence bucket and data key parameters carry another application's name.
13. **Some multi-page boards cannot be counted in v1.** Spec 3 §8.3 condition 5 makes a run review-complete only when its own rows have exactly one winner, so a team page that shows only the losing team never gets a validated table, and its match stays `PENDING_REVIEW` (§7.4). The host can count the match by excluding that page, which leaves its players out of the match. Accepted for v1 because a page-level outcome rule is a spec 3 contract change, and the match stays visible in `silver_matches` with its `stats_status`. P5.8 adds the rule.

## 19. Reference documentation

- S3 conditional writes: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html
- S3 events in EventBridge: https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventBridge.html
- Lambda asynchronous invocation: https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html
- Lambda reserved concurrency: https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html
- EventBridge Scheduler: https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html
- Athena OpenX JSON SerDe: https://docs.aws.amazon.com/athena/latest/ug/openx-json-serde.html
- Athena compression formats: https://docs.aws.amazon.com/athena/latest/ug/compression-formats.html
- Athena workgroups: https://docs.aws.amazon.com/athena/latest/ug/workgroups-manage-queries-control-costs.html
- Glue `UpdateTable`: https://docs.aws.amazon.com/glue/latest/webapi/API_UpdateTable.html
- Glue `DeleteDatabase`: https://docs.aws.amazon.com/glue/latest/webapi/API_DeleteDatabase.html

## 20. Delivery plan: phases and slices

This section is the backlog source for building the component. It is written to be turned directly into GitHub issues.

### 20.1 How to file this plan

- Each **phase** becomes one epic, titled with the phase title, with its goal and exit criteria as the body. Create epics only when someone explicitly asks for filing.
- Each **slice** becomes one leaf issue under its phase epic, titled without its code, with `Plan ID: P<n>.<m>` in the body. File with `/mcc-create-github-issue`.
- **Size** is XS, S or M. Split a slice by independently testable behavior when it outgrows one reviewable PR; the original Plan ID becomes the container.
- **Blocked by** lists Plan IDs. "Spec <n> P<n>.<m>" names a slice of another specification. Create native blocked-by links after every issue in the batch exists. Blockers in earlier phases still apply.
- **Acceptance** bullets become the issue's acceptance criteria verbatim. Every slice also inherits §20.3.
- **Spec** lists the sections the implementer must read. Link them; this document stays the source of truth.
- Plan IDs are stable. Deferred slices keep their IDs and move to the backlog phase; new slices take the next free number in their phase.
- Phase 5 is backlog.

### 20.2 Seam contracts

| Contract | Defined in | Main consumers |
| --- | --- | --- |
| Bronze key layout and `bronze-*/v1` documents (§5.1, §5.3, §10.1) | P0.2, P2.1 | `ingest-bronze`, `backfill-bronze`, `build-lakehouse` |
| Silver and gold table definitions (§7.6, §8.2) | P0.2, P3.1, P3.3 | `build-lakehouse`, Athena users |
| Serving documents, pointer and their keys (§4.5, §8.3) | P0.2, P3.3 | the player app |
| `lakehouse-build/v1` and `inputsSha256` (§6.3) | P0.2, P4.1 | `build-lakehouse`, operators |
| `validated-table/v1` | spec 3 P0.2 | bronze ingestion, silver |
| `session-association/v1`, `map-catalog/v1`, `SourceScreenshot.intake` | spec 8 P0.1 | bronze ingestion, silver |
| `foldRoster`, `rosterKey`, roster table layout | spec 6 P0.1, P0.2, P1.1 | `build-lakehouse`, `players` |
| Data platform SSM parameters (§13.2) | P1.1 | the stack, the deploy preflight, the player app |

A change to a contract updates every consumer in the same PR.

### 20.3 Definition of done for every slice

- Handlers keep I/O behind an injected dependencies object; only default dependencies construct SDK clients. Key, document, silver, player, gold and serving code stays pure.
- New behavior has `tap` tests that run without AWS, and the workspace stays above its coverage thresholds.
- `npm run check` passes. Slices that touch CDK also pass `npm run app:synth -- data-pipeline --environment dev`. Slices that touch `infrastructure/` pass `npm run tofu:check`.
- Any change to a stage's behavior bumps that stage's version (§5.4).
- No domain, address, account ID or real player data appears in code, fixtures, logs or docs.
- Operator-visible changes update `applications/data-pipeline/TESTING.md`.

### Phase 0: Workspace and contracts

**Goal:** a TypeScript workspace with a test gate, and the shared lakehouse and serving types.
**Exit criteria:** the workspace builds and tests in CI, and every type in §10.1 is exported from `@mcc/contracts`.

#### P0.1 Data pipeline workspace and test gate (S)

- **Blocked by:** none
- **Spec:** §3, §11, §12, §16.1
- **Files:** `applications/data-pipeline/{package.json,tsconfig.json,TESTING.md}`, `test/`
- **Provides:** `build`, `typecheck` and `test` scripts with `tap`
- **Acceptance:**
  - `npm test --workspace @mcc/data-pipeline` runs every `test/*.test.ts` with `tap` and fails below 80% statements, 65% branches, 80% lines or 60% functions.
  - The workspace depends only on `@mcc/contracts`, `@mcc/cdk-config` and, once spec 6 P0.2 merges, `@mcc/roster` from the monorepo, and the boundary test enforces it.

#### P0.2 Lakehouse and serving contracts (S)

- **Blocked by:** spec 3 P0.2, spec 8 P0.1
- **Spec:** §5.3, §7.6, §8.2, §8.3, §10.1, §20.2
- **Files:** `packages/contracts/src/index.ts`
- **Provides:** every type in §10.1, the silver and gold row types and the serving document types
- **Acceptance:**
  - The types compile and are exported, and the row types match §7.6 and §8.2 column for column.
  - `BronzeValidatedTable.document` accepts a validated table with and without the spec 3 2.1-draft fields.
  - `npm run release:check` passes.

### Phase 1: Platform activation and ephemeral permissions

**Goal:** applied lakehouse infrastructure, and ephemeral stacks that can deploy the pipeline.
**Exit criteria:** P1.1 is applied in dev and prod, and an ephemeral `data-pipeline` stack deploys and destroys.

#### P1.1 Activate the data platform roots (S)

- **Blocked by:** none
- **Spec:** §1, §13.2, §14
- **Files:** `infrastructure/modules/data-platform/*.tf`, `infrastructure/{dev,prod}/data-platform/`, `.terrateam/config.yml`, `infrastructure/README.md`, `docs/self-hosting/`
- **Provides:** TLS-only bucket policies, the `ephemeral/` lifecycle rule, `/mcc/<env>/data-platform/athena-workgroup-name`, and Terrateam plans for both roots
- **Acceptance:**
  - Each lakehouse bucket denies requests without TLS and expires `ephemeral/` objects as §13.2 states; objects outside `ephemeral/` have no expiry.
  - Both roots have Terrateam `dirs` entries with environment tags and the module pattern (§13.2), and no doc still calls them inactive.
  - `npm run tofu:check` passes, and the PR states that applying it needs a person's approval.

#### P1.2 Local bootstrap permissions for data pipeline stacks (S)

- **Blocked by:** none
- **Spec:** §13.3, §13.4
- **Files:** `scripts/local-cdk-bootstrap.mjs` and its tests
- **Provides:** ephemeral permissions in §13.4 for `data-pipeline-e-*` resources
- **Acceptance:**
  - The local execution role can create, update and delete the resource types in §13.3 only when they are named for a `data-pipeline-e-*` stack, including its Glue database.
  - The local workload boundary allows lakehouse bucket access only under `ephemeral/<name>/`, roster reads only on `ROSTER#ephemeral/<name>`, and Glue table actions only in the stack's database.
  - Every Glue statement in the execution role and the boundary lists the regional catalog ARN beside the stack's database and table ARNs, and the `DeleteDatabase` statement also lists the database's tables and user-defined functions (§13.4).
  - Existing bootstrap tests pass, and new tests cover each added statement, including the catalog ARN in each Glue statement.

### Phase 2: Bronze

**Goal:** every validated table, association and map catalog in a namespace has a bronze copy or a rejection record.
**Exit criteria:** §17 criteria 1 and 2 hold against fixtures with injected dependencies.

#### P2.1 Bronze ingestion (M)

- **Blocked by:** P0.1, P0.2
- **Spec:** §4.1 to §4.3, §5, §6.1
- **Files:** `src/lib/{bronze-keys,bronze-documents,storage,log}.ts`, `src/lambdas/ingest-bronze.ts`
- **Provides:** `ingestBronze`, `parseEvidenceKey`, `bronzeKey`
- **Acceptance:**
  - The `bronze-keys`, `bronze-documents` and `ingest-bronze` rows of §16.1 pass.
  - Ingestion reads only the evidence keys in §13.4 and copies nothing from `ingestion.json` but `receivedAt`.

#### P2.2 Bronze backfill (S)

- **Blocked by:** P2.1
- **Spec:** §4.4, §6.2
- **Files:** `src/lambdas/backfill-bronze.ts`
- **Provides:** `backfillBronze`
- **Acceptance:**
  - The `backfill-bronze` row of §16.1 passes.
  - A second backfill of the same namespace ingests nothing.

### Phase 3: Silver and gold

**Goal:** pure functions that turn bronze and a roster into silver tables, gold tables and serving documents.
**Exit criteria:** every rule in §7 and §8 is implemented and covered by fixtures.

#### P3.1 Runs, screenshots, sessions and match statistics (M)

- **Blocked by:** P0.1, P0.2
- **Spec:** §7.1 to §7.4, §7.6
- **Files:** `src/lib/silver.ts`, `test/fixtures/`
- **Provides:** `buildSilver` without roster linking (every name `UNROSTERED`), `gameFingerprint`, `matchStats`, `outcomeConsistent`
- **Acceptance:**
  - The `silver.test.ts` row of §16.1 passes.
  - Silver reads only bronze documents and never a build clock.

#### P3.2 Player identity (S)

- **Blocked by:** P3.1; spec 6 P0.2
- **Spec:** §7.5
- **Files:** `src/lib/players.ts`, `src/lib/silver.ts`
- **Provides:** roster linking in `buildSilver`
- **Acceptance:**
  - The `players.test.ts` row of §16.1 passes.
  - No silver row, key or log line holds a gamertag outside the `gamertag` and `player_text` columns.

#### P3.3 Gold datasets and serving documents (M)

- **Blocked by:** P3.1
- **Spec:** §8, §10.1
- **Files:** `src/lib/{gold,serving,config}.ts`, `config/lakehouse-config-v1.json`
- **Provides:** `buildGold`, `servingDocuments`, `servingContentSha256`, `jsonLines`, `inputsSha256`, `loadLakehouseConfig`
- **Acceptance:**
  - The `gold.test.ts` and `serving.test.ts` rows of §16.1 pass.
  - Invalid configuration throws `InvalidLakehouseConfigError`.

### Phase 4: Build, stack and validation

**Goal:** the deployed pipeline publishes gold in dev and prod.
**Exit criteria:** §17 holds in dev, and prod deploys.

#### P4.1 Build handler and catalog publisher (M)

- **Blocked by:** P3.2, P3.3
- **Spec:** §5.2, §6.3, §6.5, §7.6, §8.2
- **Files:** `src/lambdas/build-lakehouse.ts`, `src/lib/{catalog,roster-source}.ts`
- **Provides:** `buildLakehouse`, `GlueCatalogPublisher`, `readRoster`
- **Acceptance:**
  - The `build-lakehouse.test.ts` row of §16.1 passes with injected dependencies.
  - The build writes only under `<ns>builds/` and `<ns>serving/current.json`, in the order of §5.2 rule 4.

#### P4.2 Stack, trigger, schedule and IAM (M)

- **Blocked by:** P2.2, P4.1, P1.1, P1.2; spec 2 P1.1; spec 6 P1.1
- **Spec:** §3, §4.1, §13.3 to §13.5, §14
- **Files:** `cdk/lib/{app,data-pipeline-stack}.ts`, `cdk/bin/data-pipeline.ts`
- **Provides:** the deployable stack
- **Acceptance:**
  - The `app.test.ts` row of §16.1 passes for stable and ephemeral deployments.
  - The deploy preflight fails when a §13.2 parameter is missing, and post-deploy verification performs the checks in §13.5.
  - An ephemeral stack deploys, ingests and builds its own namespace, and destroys cleanly with its Glue database.

#### P4.3 Live validation (S)

- **Blocked by:** P4.2
- **Spec:** §16.3, §17
- **Files:** `applications/data-pipeline/TESTING.md`
- **Provides:** the operator validation steps and the first dev and prod builds
- **Acceptance:**
  - `TESTING.md` lists the §16.3 steps, and they pass in dev.
  - A `NAMESPACE` backfill and a build run in prod, and the build manifest is linked from the issue.

### Phase 5: Backlog (not filed with v1)

| ID | Slice | Size | Note |
| --- | --- | --- | --- |
| P5.1 | Player links for renamed gamertags | M | §18.1. An append-only, operator-written link from several `gamertagId` values to one player. |
| P5.2 | Incremental builds, or Parquet or Iceberg tables | M | §18.4. When `BUILD_INPUT_LARGE` appears. |
| P5.3 | Alarms for DLQ depth, Lambda errors and a stale serving pointer | S | Follow [spec 5](5-match-to-csv-observability.md). |
| P5.4 | Player opt-out list applied to gold | S | §1. When the player app specification decides its audience. |
| P5.5 | Per-map gold dataset | S | Matches and results per map, from `silver_matches`. |
| P5.6 | Athena tables over bronze | S | Only if audits need SQL over bronze. |
| P5.7 | Pruning of unpublished and old builds | S | §18.6. Needs a reviewed deletion grant. |
| P5.8 | Partial scoreboard pages | M | §18.13. Blocked by a spec 3 revision that lets a reviewer mark a run as a partial page, requires of such a page only that each team's rows share one outcome and at most one team wins, and records the page role in the validated table. This spec's merge rule already applies condition 5 to the merged pages, so it then counts pages without a winner. |

### 20.4 Dependency order and parallel lanes

P0.1, P1.1 and P1.2 can start together, and P0.2 follows spec 3 P0.2 and spec 8 P0.1. The bronze lane (P2.1 -> P2.2) runs beside the silver lane (P3.1 -> P3.2 and P3.3). The critical path is P0.2 -> P3.1 -> P3.3 -> P4.1 -> P4.2 -> P4.3, gated by spec 6 P0.2 at P3.2 and by the applies of P1.1, spec 2 P1.1 and spec 6 P1.1 at P4.2. The first real feedback is P4.3 in dev, once spec 3 and spec 8 have written validated tables and associations for a live session.
