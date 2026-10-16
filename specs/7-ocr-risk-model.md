# OCR Risk Model and Autonomous Review: Technical Specification

**Status:** Draft; not implemented

**Version:** 1.0-draft (first version)

**Date:** October 15, 2026

**Component:** `applications/ocr-quality`: scoreboard constraint rules and risk model inference inside spec 2's `ScoreRun` Lambda, the LLM review workflow, the dataset, training, maintenance and report Lambdas, and the Python training image under `training/`; constraint, LLM review and risk model types in `packages/contracts`

**Runtime:** TypeScript, Node.js 22 on AWS Lambda (ARM64), orchestrated by AWS Step Functions Standard workflows; training in Python 3.12 with LightGBM in a container image Lambda (ARM64)

**Deployment:** the existing `ocr-quality` CDK stack ([spec 2](2-ocr-quality.md) §13.5), one per stable environment plus ephemeral developer stacks, through the guarded wrapper in `scripts/cdk-app.mjs`

**LLM reviewer:** a vision model on Amazon Bedrock, called with the `Converse` API in the stack's own Region. The initial model is Claude Sonnet 5.5 (`anthropic.claude-sonnet-5-5`), confirmed or replaced by the measured spike (P0.4).

**Persistent state:** LLM review, dataset, model, evaluation, gate and report evidence in the OpenTofu-owned evidence bucket under the foundation application data key; two rebuildable DynamoDB tables owned by the application stack (`LlmReviewState` and `GameIndex`)

**External dependencies at runtime:** S3, EventBridge, EventBridge Scheduler, Step Functions, Lambda, KMS, DynamoDB, Amazon Bedrock Runtime, and spec 3's `LlmReviewWrite` function

**Out of scope:** changing OCR text or any existing evidence, fine-tuning or replacing Textract, roster resolution (spec 6, #163), storing and resolving adjudications and the reviewer application ([spec 3](3-cell-labeling.md) as amended by #166), player identity and match records (#159), SageMaker (§8.9), any user interface

Match-to-csv reads every scoreboard cell with Textract, spec 2 scores and records features for every cell, and spec 3 stores a decision for every cell, row and table. This specification decides who makes those decisions and when a run needs a person. Deterministic scoreboard constraints check each table, a vision model on Bedrock reviews every run from the first screenshot and writes spec 3 adjudications, people answer only escalations and a blind audit sample, and a shallow gradient-boosted model trained on the resulting labels later lets well-read runs skip the LLM. The goal is that no run waits on a person, with a measured upper bound on the error rate of the accepted data. This is the risk model specification that spec 2 §9.6 hands stages 2 and 3 to.

**Readiness:** this revision authorizes filing Phases 0 and 1 now, and Phases 2 to 4 once P0.4 records a go decision. Phase 5 is filed when spec 3 P5.2 is filed. The per-screenshot LLM cost in §9.5 is an estimate until P0.4 measures it. Contracts in §5.3 and §10.1 freeze when P0.1 merges. Section references to spec 3 are to its 2.1-draft (#166, PR #171), and spec 6 is the gamertag roster specification (#163, PR #170); both are unmerged.

---

## 1. Resolved requirement decisions

| Requirement | Decision | Reason |
| --- | --- | --- |
| Where the risk model and LLM reviewer live | In `applications/ocr-quality`, beside spec 2's scoring. Constraint rules and model inference run in `ScoreRun`; the LLM review, training and report workflows are new resources in the same stack. | The constraints are spec 2 signals and the model fills spec 2's reserved `riskModel` fields. A separate application would duplicate the evidence readers and the feature contract. |
| How runs become autonomous | Three layers in order: deterministic constraints (§4), an LLM reviewer for every run (§6, §7), and a learned model that later lets runs skip the LLM (§8). | The first real captures (#91) read every stat cell correctly. Their one serious failure was deterministic code, and Halo 3 team boards satisfy checkable sums. Most of the autonomy comes from checks and the LLM; the model only removes LLM calls. |
| Which tables the constraints apply to | Only tables matched to a validated layout and game type, a profile (§4.1). The first profile is Halo 3 Team Slayer. Every other table is `NOT_EVALUATED` with reason `NO_PROFILE`, so unknown layouts stay `UNKNOWN`. | A Slayer sum is false for Capture the Flag or Oddball scores. A rule applied to the wrong game type would escalate correct tables or, worse, pass wrong ones. |
| How much evidence a constraint needs | Each constraint is `PROVISIONAL` or `VALIDATED` per profile (§4.5). A provisional constraint can add review and escalation but never lets a value skip review. It becomes validated after holding on at least 30 verified captures from at least 5 sessions. | Two captures support the rules but cannot rule out exceptions. A wrong rule that only adds review costs a person's time; one that auto-accepts costs data quality. |
| Who performs spec 2 stage 1 (review every cell) | The LLM reviewer, with `selectionReason: REVIEW_ALL` on every item (§8.8). | Complete labels exist from the first screenshot without human labor, which the risk model needs (spec 2 §9.6). |
| Unit of one LLM review | One Bedrock call per run, covering every required table, row and cell (spec 3 §7.1), with a crop of each table and a downscaled view of the whole screenshot (§7.2). | One scoreboard has about 60 items, and image tokens dominate the cost. One call per item would send the image 60 times. |
| Structured output | The model answers through one tool whose input schema is the output contract (§7.4), with `toolChoice` `auto`. The handler validates the input against the schema and the rules in §7.4 and never trusts it otherwise. An `ACCEPT` must repeat the observed text. | Current Claude models reject forced tool choice. Requiring the accepted value to equal the OCR text catches an answer that drifted from the cell it names. |
| What the prompt shows | Two modes tied to spec 3's display mode (§7.1). `PRIORITY_HIDDEN` runs get a `BLIND` prompt: images, OCR text and cell positions only. `PRIORITY_SHOWN` runs get an `ASSISTED` prompt that also has the parser's teams and outcomes, failed constraints and roster candidates. | Spec 3 rejects a prompt with constraint results in a hidden run (spec 3 §4.5), and blind LLM labels are needed to measure the LLM and the roster matcher without anchoring. |
| When an LLM correction is accepted | Only when the reviewed table passes every applicable hard constraint, breaks no soft constraint the OCR table passed, and has no duplicate player (§7.6). Otherwise the corrected and involved items are escalated to a person. | The issue requires it, and it is the check that a correction made the table more consistent rather than less. |
| Bedrock outage, throttling and errors | Retried, then the run is held (`HELD` with a reason) and resumed hourly (§6.5, §6.6). A held run gets no adjudication, so spec 3 keeps it incomplete. | A run must never be accepted because the reviewer was unavailable. |
| Cost limit | A monthly ceiling per stack in bundled configuration, enforced with a reservation in DynamoDB before every call (§6.5). When a call does not fit, the run is held with `BUDGET_EXHAUSTED` until the next UTC month or a higher ceiling. | A ceiling that holds instead of accepting keeps the error bound intact. Reserving before the call bounds the overshoot to zero. |
| Human work | People answer escalations and review spec 3's blind audit sample, nothing else (§9.1). | The issue's definition of autonomy. Spec 3 2.1 already routes people this way. |
| The automation gate and LLM labels | The release gate is never measured on LLM labels alone. Its error bound comes from human blind audit labels of cells the model would auto-accept (§8.6 G5). LLM labels train, calibrate and choose the threshold. | LLM errors are correlated across screenshots of one layout (spec 3 §18.17). A gate measured on its own reviewer's labels cannot see the errors that reviewer makes. |
| The error target | `acceptedErrorTarget` is 0.1% of cells: the one-sided 95% upper bound of the error rate among accepted cells (§9.2). | Spec 2 §9.6 names 0.1% as its example. At about 60 cells per screenshot it allows roughly one wrong value per 17 screenshots. |
| `UNREADABLE` labels (spec 2 §8.5 rule 1) | A positive label: the cell needs a reviewer. Every dataset manifest records `unreadablePolicy: POSITIVE`. | An auto-accepted value for a cell a reviewer could not read would enter the validated table unchecked. |
| The learned model | A LightGBM binary classifier of each cell's probability of error, at most 4 levels deep, calibrated with isotonic regression (§8.3, §8.4). | Shallow trees fit flat, mixed feature rows with little data, train in seconds on a CPU, and export to a small JSON evaluator. |
| Training | One container image Lambda (Python 3.12, LightGBM), on demand or weekly (§8.3). | The dataset is tens of thousands of rows at league scale. A Lambda costs nothing between runs. |
| Serving | The exported trees are evaluated in TypeScript inside `ScoreRun`, which fills the reserved `riskModel` fields (§8.7). | No endpoint, no network hop, and features are exactly the ones `ScoreRun` writes. |
| Model registry and promotion | Datasets, model versions, evaluations and gate results are immutable S3 objects with manifests. The deployed model and its mode are named in a bundled configuration file, so promotion is a reviewed pull request. `ROUTING` refuses to load without a `PASS` gate result (§8.7). | Git review is the approval step, and the evidence bucket is the record. |
| SageMaker | Endpoints, Pipelines, Feature Store and Model Registry are not used. §8.9 records why and what would justify each. | Each duplicates something this design already has for less. |
| When the model starts routing | Only when its gate passes and LLM review of every run has cost at least `routingMinMonthlySpendUsd` (20 USD) in each of the last two months (§8.8). Until then the model runs in `SHADOW`. | At current volume, LLM review of everything costs a few dollars a month. Routing adds the risk of auto-accepted errors and pays off only when the LLM bill is worth reducing. |
| Data residency | Every Bedrock call goes to the stack's Region with an in-Region model ID. IAM allows only that foundation model ARN, so a cross-Region inference profile is denied (§14). | The issue requires screenshots and gamertags to stay in the account and Region. |
| Cost evidence | §9.5 records an estimate from image and token sizing and published per-token prices. P0.3 and P0.4 measure the real cost on the #91 captures before Phase 2 starts. | The raw captures and Bedrock access are outside the repository and its tests. |

**Additional capabilities included:** an operator re-review that supersedes earlier LLM decisions after a prompt or model change, a backfill for runs enqueued before the reviewer existed, an offline constraint evaluation script that prints counts only, and a monthly autonomy report with a recommendation for the audit share.

## 2. Goals and non-goals

### 2.1 Goals

1. Every scored run with a review plan gets an LLM decision on every required table, row and cell within 5 minutes, or a recorded hold.
2. No run waits on a person unless the LLM reviewer escalates it, and every escalation records why.
3. No run is accepted while Bedrock is unavailable or the monthly ceiling is reached.
4. Every LLM decision traces to its stored prompt, images and response, with model ID, prompt version, token usage and cost.
5. A monthly report states the share of runs finalized without a person and the measured upper bound of the error rate of the accepted data.
6. A risk model version moves from `SHADOW` to `ROUTING` only after a gate that includes human audit labels, and every model version is reproducible from its dataset.

### 2.2 Non-goals

- Changing OCR text, normalized observations, CSVs, quality results or adjudications written by others.
- Choosing which person reviews what, or the reviewer application. Spec 3 owns both.
- Resolving gamertags against the roster. Spec 6 owns it; this spec only shows its candidates to the LLM.
- Checking constraints on layouts or game types without a profile.
- Exactly-once LLM review. A re-review is a new LLM review run beside the earlier one.
- A guarantee that no person ever audits. "Fully autonomous" means no run waits on a person (§9.4).
- Deep learning, GPU training or a hosted inference endpoint.

## 3. Runtime architecture

```text
match-to-csv run completion
  |
  v
spec 2 ScoreRun (Lambda)
  profile -> constraints K001-K007 -> signals and features-v2     reads sibling runs, GameIndex (K006, K007)
  risk model inference (SHADOW, later ROUTING)                    reads risk/models/ (exported trees)
  writes runs/{runId}/quality/{qualityRunId}/ (spec 2 §5.1)
  |
  v
spec 3 EnqueueRun writes runs/{runId}/review/plan.json
  |  Object Created (evidence bucket EventBridge notifications, spec 2 P1.1)
  v
EventBridge rule --> Step Functions <stack>-llm-review --(failed delivery)--> SQS DLQ
  +-- PrepareLlmReview    claim, scope, crops, prompt                      --> runs/{runId}/llm-review/{llmReviewRunId}/
  +-- InvokeLlmReviewer   budget reservation, Bedrock Converse, in-Region  --> .../invocations/{invocationId}.json
  +-- ApplyLlmReview      reviewed-table checks, adjudications, escalation --lambda:InvokeFunction--> spec 3 LlmReviewWrite
  |
  +-- (held) LlmReviewState hold item <-- LlmReviewMaintenance (hourly: RESUME; operator: BACKFILL, REBUILD, REREVIEW)

EventBridge Scheduler (weekly) or operator
  v
Step Functions <stack>-risk-training
  +-- BuildRiskDataset    feature rows + spec 3 adjudications --> risk/datasets/{datasetId}/
  +-- TrainRiskModel      container, Python, LightGBM         --> risk/models/{modelVersion}/, risk/evaluations/, risk/gates/

EventBridge Scheduler (monthly) or operator
  v
ReportAutonomy --> risk/reports/{reportId}.json
```

**Ownership rules:** `score-run` owns constraint signals, features and `riskModel` fields inside spec 2's quality evidence, and the `GameIndex` table. `prepare-llm-review`, `invoke-llm-reviewer` and `apply-llm-review` own `runs/{runId}/llm-review/`. `apply-llm-review` is the only module that calls `LlmReviewWrite`, and its execution role is the LLM reviewer's execution role that spec 3 §4.5 and §13.4 refer to. `invoke-llm-reviewer` is the only module that calls Bedrock. `invoke-llm-reviewer`, `apply-llm-review` and `llm-review-maintenance` own the `LlmReviewState` table, which is a cache of evidence. `build-risk-dataset` owns `risk/datasets/`, `train-risk-model` owns `risk/models/`, `risk/evaluations/` and `risk/gates/`, and `report-autonomy` owns `risk/reports/`. No module writes under `quality/` except `score-run`, and no module writes anything spec 1, spec 3 or spec 6 owns. `constraints`, `llm-prompt`, `llm-output`, `reviewed-table`, `risk-model` and `audit-bounds` are pure. Only Lambda entry points construct AWS SDK clients; each core function receives an injected dependencies object.

**Packaging:** TypeScript sources follow spec 2 §12: Lambdas under `src/lambdas/`, pure libraries under `src/lib/`, bundled configuration and prompts under `config/`. The training image lives under `applications/ocr-quality/training/` with its own `Dockerfile`, pinned `requirements.txt` and `pytest` tests; CDK builds it as a container image asset. Shared types live in `@mcc/contracts`, because spec 3 and the stats lakehouse read the constraint results, the escalation reason codes and the `riskModel` fields. `ocr-quality` also imports `@mcc/roster` for `rosterKey` (§9.6).

**Orchestration decision:** the LLM review is three Step Functions tasks so that the Bedrock call has its own retry policy and the only role with Bedrock access writes nothing else, and so that a held or failed run is visible in execution history. Training is two tasks because the dataset builder is TypeScript and training is Python. A workflow engine beyond Step Functions is not needed.

### 3.1 Execution policy

- One review plan object is one automatic LLM review execution. Each attempt creates a new `llmReviewRunId`.
- An automatic execution claims the run for its `llmReviewerVersion` (§5.4) with a create-only claim, like spec 2 §5.2. A second execution for the same run and version finds the claim and succeeds without calling Bedrock, unless the latest attempt under the claim is `HELD` and the execution is a `RESUME` (§6.5).
- A run gets at most `maxInvocationsPerReview` (2) Bedrock calls per LLM review run: the first and one retry after invalid output.
- Every S3 write uses `If-None-Match: *`. Nothing deletes or rewrites evidence.
- No adjudication is written for a held run, and no value is ever accepted without an adjudication from the LLM or a person, or, in stage 3, an auto-acceptance (§8.8).
- Every Bedrock call goes to the stack's Region with the configured in-Region model ID (§14).
- Ephemeral stacks read and write only under `ephemeral/<name>/`, have their own tables and budget, and review only runs of the ephemeral `admin` and `match-to-csv` stacks of the same name.

## 4. Deterministic constraints

### 4.1 Profiles

A profile names a layout and game type on which a set of constraints is checked. `classifyProfile(observations, provenance)` returns the first profile whose predicates all hold for the parser's selected table, or `NONE`. Tables other than the selected table, and every table of a run with profile `NONE`, are not checked.

| Profile | Predicates |
| --- | --- |
| `halo3-team-slayer-v1` | **Columns:** the selected table's `parser.provenance.columnFields` (spec 2 P0.3) puts `PLAYER`, `SCORE`, `KILLS`, `ASSISTS` and `DEATHS` on five columns in that left-to-right order, and at least 4 of those 5 header cells match their field: the header text, uppercased with every non-letter removed, starts with the field name (`PLAYERS`, or `SCORE` read with a stray trailing symbol) or is a prefix of it of at least 4 letters (`ASSI`). **Game variant:** a `LINE` block in the normalized observations whose bounding box lies above the table's top edge contains, uppercased with non-letters removed, both `TEAM` and `SLAYER`. |

The header rule comes from the #91 captures: capture 2 reads all five headers, and capture 1 reads `PLAYERS`, `SCORE` with a stray trailing symbol, `KILLS` and `ASSI` and leaves the deaths header empty, so the parser exported deaths by column order. Neither capture's reduced fixture keeps `LINE` blocks, so the game variant predicate is unverified. P0.4 checks it on the raw captures, with one of two recorded outcomes:

- **Variant text found in both captures:** the profile is as above.
- **Variant text not found:** the game variant predicate is removed, and every constraint of the profile stays `PROVISIONAL` whatever the evidence (§4.5), because nothing then tells Team Slayer from other team game types. The profile can add review and escalations but never auto-accept.

A profile is versioned. Changing a predicate creates a new profile ID and bumps `constraintsVersion` (§5.4).

### 4.2 Constraint checks

All checks use the parser's rows of the selected table (spec 1 §8), or the reviewed table in §4.7. Integer fields are read as the integer of the trimmed text when it is all digits. A check whose inputs include a value that is not all digits is `NOT_EVALUATED` with `MISSING_VALUE`; spec 2's `INVALID_INTEGER` already flags that cell. "Team" is the parser's team name; the winning team is the team of the top player row (spec 1 §8.5).

| ID | Scope | Check | Tolerance | Strength |
| --- | --- | --- | --- | --- |
| `K001_TEAM_SCORE_LIMIT` | table | The winning team's summed `SCORE` equals the profile's `scoreLimit`. | exact; `scoreLimit` 50 for `halo3-team-slayer-v1` | soft |
| `K002_KILLS_WITHIN_OPPONENT_DEATHS` | team pair, each direction | Team A's summed `KILLS` is at most team B's summed `DEATHS`. | `K_A <= D_B` | hard |
| `K003_DEATH_GAP_EXPLAINED` | team pair, each direction | Team B's deaths beyond team A's kills are explained by B's own suicides and betrayals, which Slayer subtracts from score: `D_B - K_A <= sum over B of max(0, kills - score)`. | `killDeathSlack` 0 | soft |
| `K004_SCORE_NOT_ABOVE_KILLS` | row | A player's `SCORE` is at most their `KILLS`. | `score <= kills` | hard |
| `K005_TEAM_STRUCTURE` | table | Roster size: exactly 2 teams, each with 1 to 8 player rows, and at most 16 player rows in total. A Team Slayer table the parser read as free-for-all fails. | exact | hard |
| `K006_PAGE_AGREEMENT` | screenshot pair | Two screenshots of one submission that are pages of one post-game summary (§4.3) agree on every field both carry for each shared player. | exact string match after trimming | hard |
| `K007_SUBMISSION_AGREEMENT` | run pair | Two runs from different submissions that are the same game (§4.3) agree on every field for every player, and on the team partition and the winning team. | exact | hard |

A hard constraint holds on every correct table of the profile. A soft constraint holds on most correct tables but has known legitimate exceptions: a game ended by the time limit or by a player leaving ends below the score limit (`K001`), and a death with no killer that Slayer does not charge to a player, such as a fall after a teammate's push, can break `K003`. Soft failures route review and are features; on their own they never escalate (§7.6).

Each failed check records `observed`, `expectedMin`, `expectedMax` and `miss`, the distance from `observed` to the nearest end of the allowed interval, so a model can learn from how far a table misses. Each check also lists its involved items: the cells whose values it read, and for `K005` the table and every row.

### 4.3 Grouping for cross-run checks

**Pages of one summary (`K006`).** Two screenshots of the same submission are pages of one summary when both selected tables have profile `halo3-team-slayer-v1`, their images differ (`imageSha256`), and they share at least `minSharedPlayers` (4) player keys. A player key is spec 6's `rosterKey` of the tidied player name. Shared players are compared on team, score, kills, assists and deaths where both pages read the field. A player on one page only is not a failure, because a long board can need two pages.

**Same game (`K007`).** Two runs from different submissions are the same game when both have the profile, the sorted multisets of their player keys are equal, and their `receivedAt` values are at most `sameGameWindowDays` (7) apart. The `GameIndex` table holds one item per scored run under the SHA-256 of the sorted player keys (`gameKey`), so `ScoreRun` finds candidates with one query. A disagreement compares this run against the other run's latest validated version (spec 3 §8.4) when one exists, otherwise against its parser rows.

`ScoreRun` evaluates `K006` and `K007` against runs that completed before it. The first page or submission of a game to be scored finds no peer and records `NOT_EVALUATED` with `NO_PEER`; the second sees the first. `ApplyLlmReview` evaluates them again on the reviewed table (§7.6), when more peers may exist. `K007` defines a candidate group, not match identity, which #159 owns; when #159 defines a match ID, the grouping uses it.

### 4.4 Evidence from the #91 captures

The two Halo 3 two-team captures (fixtures `halo3-two-team-capture-1` and `-2`) give, from their transcribed rows:

| Check | Capture 1 | Capture 2 |
| --- | --- | --- |
| `K001` winning team score | Red 50 (Blue 47) | Red 50 (Blue 41) |
| `K002` Red kills against Blue deaths | 50 against 51 | 50 against 50 |
| `K002` Blue kills against Red deaths | 48 against 48 | 41 against 41 |
| `K003` death gap against self-inflicted | Blue: gap 1, one player with score 11 and kills 12; Red: 0 and 0 | 0 and 0 for both teams |
| `K004` rows | 8 rows: 7 with score equal to kills, 1 one below | 8 rows, all equal |
| `K005` teams | 2 teams of 4 | 2 teams of 4 |
| `K006`, `K007` | the captures are different games and share 2 player keys, below `minSharedPlayers` | none |

Every check passes on both captures, and `K003` holds with equality in all four directions. The one serious failure on these captures before #162 was row colours sampled wrong, which turned both team games into free-for-all. With the game variant predicate in force, `K005` would have failed on both. Two captures are not enough to validate any constraint (§4.5), so all seven start `PROVISIONAL`.

### 4.5 Results and validation status

Each constraint result carries one of `PASS`, `FAIL` or `NOT_EVALUATED` (with `NO_PROFILE`, `NO_PEER` or `MISSING_VALUE`), and the constraint's `validation` for the profile:

| Validation | Evaluated and recorded | Shown to the LLM, routes review, escalates | Allows auto-acceptance (stage 3, §8.8) |
| --- | --- | --- | --- |
| `PROVISIONAL` | yes | yes | no |
| `VALIDATED` | yes | yes | yes, when `PASS` |

A constraint becomes `VALIDATED` for a profile when the offline evaluation (P1.3) over at least 30 verified captures from at least 5 sessions finds no correct table that fails it, and for `K006` and `K007` at least 10 verified page or game pairs. "Verified" means rows transcribed from the screenshot by a person, or, once spec 3 writes them, a validated table whose decisions include a person's or whose run's audit found no disagreement. Promotion is a new bundled constraint configuration (`constraints-config-v<n>`) that bumps `constraintsVersion`. From then on, every validated table with the profile is a further test: P3.1 reports each validated table that fails a constraint, and one failure of a correct table demotes the constraint to `PROVISIONAL` in the next configuration.

### 4.6 Signals and features

Constraints become spec 2 signals and features through a change to spec 2's rules and feature schema (§9.6):

- A `FAIL` becomes a `QualitySignal` with `source: RULE`, its constraint ID as `id`, a new group `CONSTRAINT`, and `evidence` holding `observed`, `expectedMin`, `expectedMax`, `miss` and `validation`. Severity is `HIGH` for a hard constraint and `MEDIUM` for a soft one. Table-scope failures are table signals and are also attached to every involved cell; row-scope failures attach to the row's involved cells.
- `QualityResult.tables[]` gains optional `profileId` and `constraints` (`ConstraintResult[]`, §10.1).
- `featureSchemaVersion` becomes `features-v2`, adding to table rows `profileId`, `constraintFailCountHard`, `constraintFailCountSoft`, `constraintNotEvaluatedCount`, `k001Miss`, `k002MissMax`, `k003MissMax`, `k004FailRowCount`, `k005Status`, `k006Status` and `k007Status`; to row rows `k004Margin` (kills minus score) and `rowConstraintFailCount`; and to cell rows `cellConstraintFailCountHard`, `cellConstraintFailCountSoft`, `cellConstraintMissMax`, and, for `PLAYER` cells, spec 6's `playerMatchStatus`, `playerKeyDistance` and `playerRunnerUpDistance` (`null` elsewhere and on runs without a roster).

`NOT_EVALUATED` produces no signal. Feature values for a constraint that was not evaluated are `null`.

### 4.7 Reviewed-table checks

`checkReviewedTable(reviewedTable, ocrTable, peers, profile)` evaluates the applicable constraints on the reviewed table: the rows, teams, outcomes and values the LLM decided, built with spec 3 §8.4's row and value rules from the LLM's table, row and cell decisions. It also evaluates them on the OCR table built from the parser's rows, and runs spec 2's `H001_DUPLICATE_PLAYER` on the reviewed table. `ApplyLlmReview` uses the result in §7.6. The function is the same library `ScoreRun` uses, so a table passes or fails identically in both places.

## 5. Evidence and state

### 5.1 Layout

```text
[ephemeral/<name>/]submissions/{submissionId}/screenshots/{screenshotId}/runs/{runId}/
  llm-review/
    claims/{llmReviewerVersion}.json
    {llmReviewRunId}/
      manifest.json
      inputs/{imageName}.png
      request.json
      invocations/{invocationId}.request.json
      invocations/{invocationId}.json
      decisions.json
      outcome.json
[ephemeral/<name>/]risk/
  datasets/{datasetId}/
    manifest.json
    train.jsonl.gz
    validation.jsonl.gz
    test.jsonl.gz
    audit.jsonl.gz
  models/{modelVersion}/
    manifest.json
    model.json
    parity.jsonl
    lightgbm-model.txt
  evaluations/{evaluationId}.json
  gates/{gateId}.json
  reports/{reportId}.json
```

`llmReviewRunId`, `invocationId`, `datasetId`, `modelVersion`, `evaluationId`, `gateId` and `reportId` are `evidenceId()` values (spec 1 §5.1). `{imageName}` is `table-{tableIndex}` for a table crop and `context` for the downscaled screenshot.

### 5.2 Rules

1. Evidence is immutable. Every object is written once with `If-None-Match: *`.
2. An LLM review run writes `manifest.json` first and `outcome.json` last. A run without an outcome is incomplete, and consumers ignore it.
3. The invocation request record is written before the Bedrock call, so a timed-out or failed call still leaves a record of the attempt. The invocation record, with request and response, is written after it.
4. The invocation record is the object spec 3 hashes as `invocationSha256`. Its key is the `invocationKey` on every adjudication and escalation written from it.
5. Images sent to Bedrock are stored under `inputs/` before the call, and the invocation record names each image's key and SHA-256 instead of embedding its bytes.
6. Every LLM review run records the configuration, prompt version, model ID, constraint version and build (§5.4).
7. Every model version records the dataset it was trained on, its training configuration and the library versions in the image, so it can be retrained.

### 5.3 Document schemas

| Object | `schemaVersion` | Writer | Contents |
| --- | --- | --- | --- |
| `llm-review/claims/{llmReviewerVersion}.json` | `llm-review-claim/v1` | `prepare-llm-review` | `runId`, `llmReviewerVersion`, `executionArn`, `claimedAt` |
| `manifest.json` | `llm-review-run/v1` | `prepare-llm-review` | `llmReviewRunId`, `runId`, `screenshotId`, `trigger` (`mode`: `AUTOMATIC`, `RESUME`, `BACKFILL` or `REREVIEW`; `executionArn`), `planKey`, `qualityRunId`, `displayMode`, `promptMode`, `stage`, `versions` (§5.4), `modelId`, `build`, `startedAt` |
| `inputs/{imageName}.png` | none | `prepare-llm-review` | the PNG sent to Bedrock |
| `request.json` | `llm-review-request/v1` | `prepare-llm-review` | `LlmReviewRequest` (§10.1): items with their short references, images, text inputs, the rendered prompt and the estimated maximum cost of one call |
| `invocations/{invocationId}.request.json` | `llm-invocation-request/v1` | `invoke-llm-reviewer` | `invocationId`, `attempt`, `modelId`, `requestSha256` (of the Converse request with image bytes replaced by image keys), `invokedAt` |
| `invocations/{invocationId}.json` | `llm-invocation/v1` | `invoke-llm-reviewer`, `apply-llm-review` (`NOT_CALLED` only) | `LlmInvocationRecord` (§10.1): status, the Converse request with image references, the full response, `stopReason`, `usage`, `costMicroUsd`, `latencyMs`, `validation` |
| `decisions.json` | `llm-review-decisions/v1` | `apply-llm-review` | the validated decisions mapped to spec 3 items, the OCR and reviewed constraint results, each item's escalation reasons |
| `outcome.json` | `llm-review-outcome/v1` | the three review Lambdas, `llm-review-maintenance` (`HOLD`) | `status` (`COMPLETED`, `ESCALATED`, `HELD`, `SKIPPED` or `FAILED`), `holdReason`, `skipReason`, counts of adjudications written, replayed and rejected by code, `escalationId`, `costMicroUsd`, `completedAt`, `error` |
| dataset `manifest.json` | `risk-dataset/v1` | `build-risk-dataset` | §8.1 |
| dataset JSONL lines | `risk-example/v1` | `build-risk-dataset` | §8.1 |
| model `manifest.json` | `risk-model/v1` | `train-risk-model` | `modelId`, `modelVersion`, `datasetId`, `featureSchemaVersion`, `features` (ordered allowlist), training configuration, `seed`, library versions, image digest, `modelSha256`, `paritySha256`, calibration summary, `threshold`, `thresholdVersion`, `evaluationId`, `build` |
| `model.json` | `risk-tree-ensemble/v1` | `train-risk-model` | §8.7 |
| `parity.jsonl` | `risk-parity-row/v1` | `train-risk-model` | 1,000 test rows' feature values with LightGBM's raw and calibrated outputs |
| `evaluations/{evaluationId}.json` | `risk-evaluation/v1` | `train-risk-model` | §8.5 |
| `gates/{gateId}.json` | `risk-gate/v1` | `train-risk-model` | §8.6 |
| `reports/{reportId}.json` | `risk-autonomy-report/v1` | `report-autonomy` | §9.4 |

### 5.4 Stage versions

| Key | v1 value | Recorded in |
| --- | --- | --- |
| `constraintsVersion` | `constraints-v1` | spec 2 quality manifest `versions`, LLM review runs |
| `constraintsConfigVersion` | `constraints-config-v1` | as `constraintsVersion` |
| `llmReviewerVersion` | `llm-reviewer-v1` | claims, LLM review runs |
| `llmReviewConfigVersion` | `llm-review-config-v1` | LLM review runs |
| `promptVersion` | `llm-review-prompt-v1` | LLM review runs, spec 3 `llmReviewer.promptVersion` |
| `riskModelConfigVersion` | `risk-model-config-v1` | spec 2 quality manifest `versions` |
| `datasetBuilderVersion` | `risk-dataset-v1` | dataset manifests |
| `trainerVersion` | `risk-trainer-v1` | model manifests |

`constraintsVersion`, `constraintsConfigVersion` and `riskModelConfigVersion` are spec 2 stage versions, so a change to any of them bumps spec 2's `qualityVersion` (spec 2 §5.4). A change to the prompt, the output contract, the crops or the acceptance rules bumps `llmReviewerVersion`, so the next plan of each run is reviewed under the new version and earlier claims do not block it.

## 6. LLM review workflow

### 6.1 Trigger and modes

The stack's EventBridge rule matches `aws.s3` `Object Created` events from the evidence bucket whose key matches `submissions/*/screenshots/*/runs/*/review/plan.json` (stable) or `ephemeral/<name>/submissions/*/screenshots/*/runs/*/review/plan.json` (ephemeral). It starts `<stack>-llm-review` with `{ "plan": { "bucket", "key" }, "mode": "AUTOMATIC" }`, retries delivery up to three times within two hours, and sends undeliverable events to `<stack>-events-dlq` (spec 2 §4.1). `PrepareLlmReview` re-checks the key against `^(ephemeral/[a-z0-9][a-z0-9-]{0,19}/)?submissions/[^/]+/screenshots/[^/]+/runs/[^/]+/review/plan\.json$` and its own namespace, and fails with `InvalidPlanKeyError` otherwise.

| Mode | Started by | Claim | Supersedes |
| --- | --- | --- | --- |
| `AUTOMATIC` | the plan event | create-only; an existing claim from another execution is a no-op | nothing; first decisions |
| `RESUME` | `LlmReviewMaintenance` for a held run (§6.5) | requires the claim's latest LLM review run to be `HELD` | nothing |
| `BACKFILL` | operator, for plans written before the stack existed | create-only, as `AUTOMATIC` | nothing |
| `REREVIEW` | operator, after a prompt or model change | skipped | the current `LLM` head of each item; `HUMAN` heads are left alone |

### 6.2 Prepare

`prepareLlmReview(input, dependencies)`:

1. Validate the plan key. Read `review/plan.json`. Claim the run (§6.1) or return `skipped`.
2. Create an `llmReviewRunId` and write `manifest.json`.
3. Read the run `manifest.json`, `normalized/observations.json`, the latest `SUCCEEDED` quality result (spec 2 §5.2 rule 5) and, when the normalized observations carry spec 6's roster reference, the roster snapshot. Fail with `MissingArtifactError` when the parser provenance is absent.
4. Compute the required items with spec 3 §7.1's scope: a table decision for every table, and a cell and row decision for every cell and row of every table in scope. With no required item, write a `SKIPPED` outcome with `NO_REQUIRED_ITEMS` and stop. With more than `maxCellsPerRun` (300) cells, return `RUN_TOO_LARGE`, and the workflow goes straight to Apply (§6.4) without calling Bedrock.
5. Choose the prompt mode from the plan's `displayMode` (§7.1). Evaluate the constraints on the OCR table (§4.7) for the `ASSISTED` prompt.
6. Build the images (§7.2) and write them under `inputs/`. Build the text input (§7.3), the rendered prompt and the call's estimated maximum cost (§6.5), and write `request.json`.
7. Return the `request.json` reference.

### 6.3 Invoke

`invokeLlmReviewer(input, dependencies)`:

1. Read `request.json` and its images. Reserve the call's maximum cost (§6.5); when the reservation fails, throw `LlmBudgetExhaustedError`, which the workflow catches to hold the run. Create an `invocationId` and write the invocation request record.
2. Call `Converse` with the system prompt, one user message holding the images and the text input, the output tool (§7.4) with `toolChoice` `auto`, `maxTokens` `maxOutputTokens` (8,000) and `additionalModelRequestFields` from configuration. The client's request timeout is `requestTimeoutSeconds` (120), and the SDK makes one attempt; Step Functions retries (§6.6).
3. On a response, compute the cost from `usage` and the configured prices, settle the reservation (§6.5), validate the output (§7.4) and write the invocation record with status `VALID`, `INVALID` or `REFUSED`.
4. On a provider error, write the invocation record with status `ERROR` and the error name, release the reservation, and throw the mapped error (§6.6).
5. When the output is `INVALID` and fewer than `maxInvocationsPerReview` calls have been made, repeat from step 1 with the same prompt, including the reservation.
6. Return the latest invocation record's reference.

### 6.4 Apply

`applyLlmReview(input, dependencies)`:

1. Read `request.json` and the latest invocation record. When its status is not `VALID`, or Prepare stopped with `RUN_TOO_LARGE`, escalate every required item (§7.6 rules 7 and 8) and go to step 6. For `RUN_TOO_LARGE`, first write an invocation record with status `NOT_CALLED`, because every escalation names one.
2. Map each decision to a spec 3 `ADJUDICATE` payload (§7.5). In `REREVIEW` mode, list each item's primary chain under `adjudications/` and resolve its head (spec 3 §8.1) to set `supersedesAdjudicationId`. Invoke `LlmReviewWrite` for tables, then rows, then cells, each with a `clientRequestId` that is UUID version 5 of `<llmReviewRunId>:<item key>` under a fixed namespace, so a retried Apply replays instead of duplicating.
3. Record each response. `409 HUMAN_DECIDED`, `409 ESCALATED` and `409 PRIORITY_HIDDEN` are recorded and skipped; `PRIORITY_HIDDEN` also logs at `ERROR`, because Prepare chose the wrong mode. Any other rejection fails the task with `LlmReviewWriteRejectedError`. A function error is retried (§6.6).
4. Build the reviewed table, run `checkReviewedTable` (§4.7) and decide the escalations (§7.6), including rows the last write response listed as `OUTCOME_INCONSISTENT`.
5. Write `decisions.json`. When any item is escalated, send one `ESCALATE` payload with every escalated item and the sorted reason codes.
6. Write `outcome.json` (`COMPLETED` or `ESCALATED`) and delete the run's hold item if one exists.

### 6.5 Budget, holds and resumption

**Ceiling.** `monthlyBudgetUsd` is set per deployment type in bundled configuration: 50 USD for `prod`, 10 for `dev` and 2 for each ephemeral stack. A month is a UTC calendar month.

**Reservation.** The `LlmReviewState` item `BUDGET#<yyyy-mm>` holds `committedMicroUsd`, the settled cost of finished calls plus outstanding reservations. Prepare computes the maximum cost `r` of one call: the estimated input tokens (§9.5's image formula plus one token per 3 characters of text) at the input price plus `maxOutputTokens` at the output price. Before each call, Invoke adds `r` with a conditional update whose condition is `committedMicroUsd <= :ceilingMinusR` (or the item does not exist and `r` fits). After the call, Invoke adds `actual - r`. A Lambda that dies between the two leaves the reservation counted, which can only hold runs early. `REBUILD` recomputes every month's item from invocation records.

**Holds.** A hold writes a `HELD` outcome with one reason and puts the item `HOLD` / `<runId>` with the reason, `heldAt`, the plan key and the claim key. Holds come from Invoke's errors, through the workflow's `Catch` to `LlmReviewMaintenance`'s `HOLD` operation:

| Reason | Cause | Resumed |
| --- | --- | --- |
| `BUDGET_EXHAUSTED` | the reservation before a call did not fit | when the current month's headroom fits the run's estimated cost, which happens at the next UTC month or after a deploy raises the ceiling |
| `PROVIDER_UNAVAILABLE` | Bedrock throttling, server or timeout errors after the retries in §6.6 | on the next hourly pass |
| `PROVIDER_REJECTED` | `AccessDeniedException`, `ValidationException` or `ResourceNotFoundException` from Bedrock, which are configuration or permission faults | on the next hourly pass, so a fixed deploy releases them; `ProviderRejected` alarms (§15) |

A held run has no LLM adjudication, so spec 3 keeps it `OPEN` and in no human queue (spec 3 §18.18). Nothing accepts a value on its behalf.

**Resumption.** EventBridge Scheduler invokes `LlmReviewMaintenance` with `RESUME` every hour. It lists hold items in run order, which is creation order, and starts at most `resumeBatchSize` (20) `RESUME` executions, skipping `BUDGET_EXHAUSTED` holds while the month's headroom is below the run's estimated cost. A `RESUME` execution that is held again writes a new `HELD` outcome and keeps the hold item.

### 6.6 Retries and timeouts

| Task | Lambda timeout | Retried errors | Policy | After the last attempt |
| --- | --- | --- | --- | --- |
| Prepare | 2 minutes | `Lambda.*` service errors, `InternalError`, `SlowDown`, `ServiceUnavailable`, `ProvisionedThroughputExceededException`, `ThrottlingException` | 2 s, backoff 2, 3 attempts | `FAILED` outcome, execution fails, `LlmReviewFailed` metric |
| Invoke | 5 minutes, enough for two 120-second calls | as Prepare, plus `LlmProviderThrottledError`, `LlmProviderUnavailableError`, `LlmProviderTimeoutError` | 10 s, backoff 2, 4 attempts (10, 20, 40 s) | provider errors: `HELD` with `PROVIDER_UNAVAILABLE`; `LlmProviderRejectedError` (not retried): `HELD` with `PROVIDER_REJECTED`; `LlmBudgetExhaustedError` (not retried): `HELD` with `BUDGET_EXHAUSTED`; others: `FAILED` |
| Apply | 5 minutes | as Prepare, plus `Lambda.ServiceException`, `Lambda.TooManyRequestsException` from `LlmReviewWrite` | 2 s, backoff 2, 3 attempts | `FAILED` outcome; the next `REREVIEW` or a re-sent plan event repairs it, and replays are safe |

Bedrock `ThrottlingException` maps to `LlmProviderThrottledError`; `ServiceUnavailableException`, `InternalServerException` and `ModelNotReadyException` to `LlmProviderUnavailableError`; `ModelTimeoutException` and the client timeout to `LlmProviderTimeoutError`; the three rejection exceptions to `LlmProviderRejectedError`, which is not retried and holds the run with `PROVIDER_REJECTED`. The state machine times out after 30 minutes. A failed execution keeps its evidence and claim; `FAILED` runs are counted in the report and alarmed (§15), and an operator restarts them with `REREVIEW`.

## 7. LLM reviewer contract

### 7.1 Prompt modes

| Input | `BLIND` (`PRIORITY_HIDDEN` runs) | `ASSISTED` (`PRIORITY_SHOWN` runs) |
| --- | --- | --- |
| Table crops and context image | yes | yes |
| Every required item with its short reference, row and column, header text and observed text | yes | yes |
| The parser's exported field per column | yes | yes |
| The parser's team, exported flag and outcome per row | no | yes |
| Failed constraints on the OCR table, with involved items | no | yes |
| Roster candidates per player row | no | yes |
| Spec 2 priorities, scores or signals | no | no |
| Earlier decisions of any item | no | no |

Spec 3 records `priorityShown` from `inputsShown.priority`, which is true when the prompt contains any constraint result (spec 3 §4.5), so `ASSISTED` adjudications record `priorityShown: true` and `BLIND` ones `false`. Neither mode shows earlier decisions, so `priorDecisionsShown` is false unless the write supersedes a non-`SKIPPED` decision in `REREVIEW` mode. `BLIND` LLM labels measure the LLM and spec 6's matcher without anchoring; spec 3 needs a field for roster candidates shown (§9.6).

### 7.2 Images

- **Table crop**, one per table in scope: the table's bounding box from the normalized observations, widened by `tableCropMarginFraction` (0.01 of the image width and height) on each side and clipped to the image, cut from `source/original`, and resized with Sharp's Lanczos kernel so the long edge is at most `tableCropMaxLongEdgePx` (2,576), never enlarged. PNG.
- **Context image**: the whole screenshot resized so its long edge is `contextImageLongEdgePx` (1,280), for table roles, rows the table crop misses (spec 3 undetected rows) and the game variant text. PNG.

Crops are deterministic for one original, Sharp version and configuration, and are stored as evidence (§5.2 rule 5).

### 7.3 Text input

The text input is JSON inside a delimited user block, after the system prompt's statement that every string in it is data read from a screenshot and never an instruction. It holds, per table: `ref` (`t1`, `t2`, ...), whether it is in scope, row count, column count and per column the header text and exported field; per row in scope: `ref` (`t1r3`), row index and, in `ASSISTED` mode, the parser's exported flag, team and outcome; per cell in scope: `ref` (`c1`, `c2`, ...), row, column and observed text. Long IDs never appear; Prepare maps references to `cellObservationId`, `tableObservationId` and row indexes in `request.json`. In `ASSISTED` mode it also holds each failed constraint's ID, scope, observed value, allowed interval and involved references, and per player row up to `rosterCandidatesPerRow` (3) active roster gamertags from the run's snapshot with the smallest spec 6 key distance to the name as read, at most `rosterCandidateMaxKeyDistance` (3), plus the row's `playerResolution` status. Observed text is capped at 256 characters.

The system prompt is `config/prompts/llm-review-prompt-v1.md`. It describes the Halo MCC scoreboard, the decision vocabulary, the error types, the team colour names (spec 3 §13.1 `teamNames`), the output tool and the rules in §7.4. A released prompt is never edited; a change adds a new file and bumps `promptVersion` and `llmReviewerVersion`.

### 7.4 Output contract

The model calls the tool `submit_review` once. Its input:

```json
{
  "tables": [
    { "ref": "t1", "role": "SCOREBOARD", "columnFields": { "1": "PLAYER", "2": "SCORE", "3": "KILLS", "4": "ASSISTS", "5": "DEATHS", "6": "NONE" }, "undetectedRows": [] }
  ],
  "rows": [{ "ref": "t1r2", "isPlayerRow": true, "team": "Red", "outcome": "WIN" }],
  "cells": [
    { "ref": "c7", "verdict": "ACCEPT", "value": "22" },
    { "ref": "c8", "verdict": "CORRECT", "value": "16", "errorTypes": ["GLYPH_SUBSTITUTION"] },
    { "ref": "c9", "verdict": "UNREADABLE", "value": null }
  ],
  "escalations": [{ "ref": "c9", "reasonCode": "LLM_REQUESTED", "note": "glare over the digits" }]
}
```

`validateLlmOutput(request, toolInput, stopReason)` accepts the output only when all of these hold, and otherwise returns `INVALID` with every violation:

1. `stopReason` is `tool_use` and the response has exactly one `submit_review` call. `content_filtered` or `guardrail_intervened` makes the output `REFUSED`; any other stop reason is `INVALID`.
2. The input matches the JSON schema, with no additional properties.
3. Every requested table, row and cell reference appears exactly once, and no other reference appears.
4. `ACCEPT` has `value` equal to the cell's observed text, byte for byte, and no `errorTypes`.
5. `CORRECT` has a `value` that differs from the observed text, at most 256 characters, and one or more spec 3 cell error types (spec 3 §7.3), sorted and unique.
6. `UNREADABLE` has `value: null` and no `errorTypes`.
7. Row and table decisions follow spec 3 §7.4 and §7.5, including the team pattern, `INVALID_ANCHOR` and exactly one `PLAYER` column.
8. `escalations` reference requested items, use `LLM_REQUESTED`, and `note` is at most 200 characters.

An optional `note` on any item is allowed by the schema and stored only in the invocation record. Spec 3 never shows LLM rationale to people.

### 7.5 Mapping to spec 3

| Output | `LlmReviewWrite` `ADJUDICATE` payload |
| --- | --- |
| table | `kind: TABLE`, `decision: { role, columnFields, undetectedRows }` |
| row | `kind: ROW`, `decision: { isPlayerRow, team, outcome }` |
| `ACCEPT` | `kind: CELL`, `decision: { decision: ACCEPTED }` |
| `CORRECT` | `decision: { decision: CORRECTED, submittedValue, errorTypes }` |
| `UNREADABLE` | `decision: { decision: UNREADABLE }` |
| every payload | `qualityRunId` from Prepare; `selectionReason` `REVIEW_ALL` in stages 1 and 2 (§8.8); `inputsShown: { priority: promptMode == ASSISTED, priorDecisions: false }`; `supersedesAdjudicationId` null, or in `REREVIEW` the current `LLM` head; `llmReviewer: { modelId, promptVersion, invocationKey }` |

### 7.6 Correction acceptance and escalation

A correction is a `CORRECT` cell, a row decision whose derived spec 3 error types are not empty, or a table decision with `WRONG_TABLE`, `WRONG_COLUMN_MAPPING` or `MISSING_ROW`. A table's applicable constraints are those of its profile whose result is not `NOT_EVALUATED`, whether `PROVISIONAL` or `VALIDATED`.

| Rule | Condition | Escalated items | Reason code |
| --- | --- | --- | --- |
| 1 | The LLM made no correction in a profiled table, and an applicable hard constraint fails on the reviewed table. | the failing constraints' involved items | `CONSTRAINT_UNRESOLVED` |
| 2 | The LLM made corrections in a profiled table, and the reviewed table fails an applicable hard constraint, fails a soft constraint that the OCR table passed, or has a duplicate player. | the corrected items and the failing checks' involved items | `CORRECTION_FAILS_CONSTRAINTS` |
| 3 | The LLM made corrections in a table it marked `SCOREBOARD` that has no profile. | the corrected items | `CORRECTION_UNCHECKED` |
| 4 | A cell of a mapped field in a table the LLM marked `SCOREBOARD` is `UNREADABLE`. | the cell | `LLM_UNREADABLE` |
| 5 | The model listed the item under `escalations`. | the item | `LLM_REQUESTED` |
| 6 | The last write response lists rows with `OUTCOME_INCONSISTENT` (spec 3 §8.3). | those rows | `OUTCOME_INCONSISTENT` |
| 7 | Both invocations returned `INVALID`, or one returned `REFUSED`. | every required item | `LLM_OUTPUT_INVALID` or `LLM_REFUSED` |
| 8 | The run has more than `maxCellsPerRun` cells. | every required item | `RUN_TOO_LARGE` |

Soft constraint failures that the OCR table already had, and that the LLM did not change, never escalate on their own: a game that ended on time is not an error. Corrections in tables the LLM marked `NOT_SCOREBOARD` are accepted, because they never reach a validated table.

The LLM's adjudications are written before the escalation under rules 1 to 6, so every item keeps an LLM label and the person sees the LLM's decision (spec 3 §9.2). Under rules 7 and 8 no adjudication is written. When the escalated items exceed spec 3's `maxEscalationItems` (256), the escalation lists every table item, then every row item, then cells in table, row and column order up to the limit; people can escalate the rest from the run view (spec 3 §7.8).

An escalation makes the run incomplete until a person answers it (spec 3 §7.8, §8.3). A run with no escalation is complete once the LLM's writes are in, and spec 3 writes its validated table.

## 8. Risk model

### 8.1 Dataset

`buildRiskDataset(input, dependencies)` turns spec 2 feature rows and spec 3 adjudications into one example per labeled cell, following spec 2 §8.5 in full:

1. **Label cutoff.** The input names `labelCutoff`, default the build time. Each cell's label is its spec 3 primary resolution as of the cutoff (spec 3 §8.1), resolved with the same chain resolver as spec 2's baseline builder (spec 2 P4.1). `ACCEPTED` is 0; `CORRECTED` and `UNREADABLE` are 1 (`unreadablePolicy: POSITIVE`). `SKIPPED` and unresolved cells have no example.
2. **Eligibility and selection.** Spec 2 §8.5 rules 2 to 4: `featureSchemaVersion` as requested, a `SUCCEEDED` quality run, a baseline without the screenshot, the `SHOWN` row when eligible and otherwise `LATEST_ELIGIBLE`.
3. **Grouping and splits.** Groups join screenshots that share an `imageSha256`, a `submissionId` or a `gameKey` (§4.3), transitively. A group's split is `train`, `validation` or `test` by the first four bytes of `sha256(seed + "\0" + smallest screenshotId in the group)` against the fractions 0.6, 0.2 and 0.2. The seed is a build input recorded in the manifest.
4. **Audit file.** `audit.jsonl.gz` holds every cell with a human blind audit adjudication (`reviewPass: BLIND_DOUBLE`) at or before the cutoff, with its truth (§9.1) and, when the cell's `SHOWN` or latest eligible quality run recorded a `riskModel` assessment, that assessment. Audit cells also appear in their split; the audit file is for the gate (§8.6 G5) and the report.
5. **Record.** Each `risk-example/v1` line has `cellObservationId`, `runId`, `screenshotId`, `qualityRunId`, `selectionRule`, `split`, `groupKey`, `label`, `labelDecision`, `labelReviewerKind`, `labelBlind` (`priorityShown` and `priorDecisionsShown` both false), `labelSelectionReason`, `labelModelId` and `labelPromptVersion` for `LLM` labels, `heuristicSuspicionScore`, the recorded `riskModel` assessment or `null`, and `features`, the allowlisted feature values (§8.2).

The manifest records `datasetId`, `datasetBuilderVersion`, `featureSchemaVersion`, `labelCutoff`, `unreadablePolicy`, `grouping` (`imageSha256`, `submissionId`, `gameKey`), `seed`, the split fractions, counts of eligible and skipped rows by reason, examples and positives per split and per label reviewer kind, `adjudicationSetSha256` over the adjudication keys used (spec 2 §8.3's definition), the SHA-256 of each file, and `build`. The builder reads no validated table, review plan or telemetry. It reads human and LLM labels alike and records which is which.

### 8.2 Features

The model's inputs are the allowlisted fields of `features-v2` cell rows (§4.6), listed in the training configuration in a fixed order. The allowlist excludes identity and lineage IDs, timestamps, and every free-text field (`observedText`, `headerText`, `headerTexts`, `playerText`), so no gamertag reaches a model artifact. Categorical fields (`semanticField`, `exportedField`, `rowRole`, `tableClassification`, `imageFormat`, `acquisitionType`, `contentType`, `textractModelVersion`, `profileId`, `playerMatchStatus`, `heuristicReviewPriority`, `parserTeam`) are encoded with a vocabulary fixed at training time, unseen values map to an `OTHER` code, and the vocabulary is part of the export. `signalIds` becomes one boolean per signal ID in the training vocabulary. The constraint fields carry how far the table misses each constraint, as the issue requires.

### 8.3 Training

`TrainRiskModel` is a container image Lambda built from `training/Dockerfile` on the AWS Lambda Python 3.12 ARM64 base image, with LightGBM, NumPy and scikit-learn pinned by hash in `requirements.txt`. Its event names an `operation`:

- `TRAIN` with a `datasetId`: train, calibrate, choose the threshold, evaluate on the test split and run the gate checks that need no shadow data, writing the model version, an evaluation and a gate result.
- `GATE` with a `modelVersion` and a newer `datasetId`: evaluate the model's recorded shadow decisions and the audit file, writing a gate result (§8.6).

Training uses LightGBM's binary objective with `max_depth` 4, `num_leaves` 15, `learning_rate` 0.05, at most 500 rounds with early stopping after 50 rounds without improvement in validation log loss, `min_data_in_leaf` 50, `feature_fraction` 0.8, `bagging_fraction` 0.8 with `bagging_freq` 1, `lambda_l2` 1.0, `deterministic` true, `num_threads` 1 and the dataset seed. These are `training-config-v1` in `training/config/`; a change adds a new file and bumps `trainerVersion`. With fewer than 1,000 training examples or 30 positives, `TRAIN` writes no model and records `INSUFFICIENT_DATA` in the evaluation.

### 8.4 Calibration and the routing threshold

**Calibration.** Isotonic regression maps the model's raw validation-split scores to probabilities, fitted with scikit-learn and exported as a step function of thresholds and values. `predictedErrorProbability` is the calibrated value.

**Threshold.** On the validation split, the trainer considers each distinct calibrated probability `t` and the set of cells with probability below `t`, the cells the model would auto-accept. It picks the largest `t` for which the one-sided 95% Clopper-Pearson upper bound of the error rate in that set is at most `acceptedErrorTarget` (0.001). A cell is auto-accepted when its probability is strictly below the threshold. When no `t` qualifies, the model has `threshold: null` and fails the gate. `thresholdVersion` is the `evaluationId` that chose it.

### 8.5 Evaluation report

Each `risk-evaluation/v1` holds, for the test split: example and positive counts; ROC AUC, average precision, log loss, Brier score and expected calibration error over 10 equal-count bins with the reliability table; at the threshold, the auto-accept rate, the error count and rate among auto-accepted cells with their Clopper-Pearson 95% upper bound, and the recall of errors; the heuristic baseline, which auto-accepts the same share of cells with the lowest `heuristicSuspicionScore`, with the same statistics; the same metrics broken down by `semanticField`, `profileId`, `textractModelVersion` and `labelReviewerKind`; and feature importance by gain. It names the model version, dataset, threshold and `trainerVersion`.

### 8.6 Release gate

A model version moves from `SHADOW` to `ROUTING` only with a `risk-gate/v1` result of `PASS` for that version and threshold. Every check records its value and result:

| Check | Passes when |
| --- | --- |
| G1 data | the training split has at least 20,000 examples and 100 positives |
| G2 calibration | test expected calibration error is at most 0.02 |
| G3 test bound | the Clopper-Pearson 95% upper bound of the error rate among auto-accepted test cells is at most `acceptedErrorTarget`, and the auto-accept rate is at least `minAutoAcceptRate` (0.5) |
| G4 baseline | at the model's auto-accept rate, the model's test error rate among auto-accepted cells is at most the heuristic's |
| G5 human audit | among audit-file cells whose recorded shadow decision from this model version is `AUTO_ACCEPT`, at least 2,995 cells, and the upper bound of their error rate against human truth (§9.1) is at most `acceptedErrorTarget` |
| G6 shadow period | the version ran in `SHADOW` in the target environment for at least 30 days and 500 scored runs, and its parity check passed at load (§8.7), shown by `riskModel` assessments in that period |
| G7 constraints | at least one profile has every hard constraint `VALIDATED` (§4.5), because stage 3 auto-finalizes only such runs |

G5 is the check that uses only human labels, with the same one-sided 95% Clopper-Pearson bound as G3. With zero errors, 2,995 cells is the smallest sample whose Clopper-Pearson bound is at or below 0.1%. At a 5% audit share, about 50 cells per run and a 70% auto-accept rate, that is roughly 1,700 runs. G1 to G4 count labels of either reviewer kind. A `GATE` result is `PASS` only when every check passes; `TRAIN` writes a provisional gate result without G5 and G6, which is always `PENDING`.

### 8.7 Export and inference

`model.json` (`risk-tree-ensemble/v1`) holds the feature list with types and categorical vocabularies, every tree as arrays of split feature index, threshold, missing-value direction, categorical bitsets, children and leaf values, the base score, the isotonic step function, the threshold and the model's identifiers. `TrainRiskModel` converts LightGBM's `dump_model()` output into this format and writes `parity.jsonl` from 1,000 test rows.

`src/lib/risk-model.ts` evaluates the ensemble: it walks each tree, sums leaf values with the base score, applies the logistic function and the isotonic map, and compares with the threshold. It is pure and has no dependency on LightGBM.

`config/risk-model-config-v<n>.json` names `mode` (`OFF`, `SHADOW` or `ROUTING`), `modelVersion`, `modelKey`, `modelSha256`, `threshold`, `thresholdVersion` and, for `ROUTING`, `gateKey`. v1 is `OFF`. At cold start `ScoreRun` reads the model from its namespace's `risk/models/`, checks `modelSha256`, and evaluates every parity row, which must match LightGBM's calibrated output within 1e-9. For `ROUTING` it reads the gate result and requires `PASS` for the same version and threshold. Any failure logs at `ERROR`, emits `RiskModelLoadFailed` and falls back: a parity or hash failure writes no `riskModel`, and a missing `PASS` runs in `SHADOW`. Routing never starts without a passing gate.

`ScoreRun` fills `CellQuality.riskModel` (spec 2 §9.6) for every cell of every table with `modelId` `ocr-cell-risk`, the version, `featureSchemaVersion`, the probability, `thresholdVersion`, `threshold`, `decision` (`AUTO_ACCEPT` below the threshold, otherwise `REVIEW_REQUIRED`) and `mode`. Routing still requires a profile (§8.8).

### 8.8 Stages and when routing starts

| Stage | Risk model | Who reviews | `selectionReason` |
| --- | --- | --- | --- |
| 1 | `OFF` | the LLM reviews every required item; people answer escalations and audit | `REVIEW_ALL` |
| 2 | `SHADOW`: assessments recorded, not used | as stage 1 | `REVIEW_ALL` |
| 3 | `ROUTING` | auto-finalized runs: nobody, plus the audit of auto-accepted cells; other runs: the LLM, then people for escalations | `MODEL_FLAGGED`, `CONSTRAINT_FAILED`; people `ESCALATION`, `AUDIT_SAMPLE` |

**Routing rule.** In stage 3 `ScoreRun` writes `QualityResult.routing` (§10.1). A run is auto-finalized when its selected table has a profile with every hard constraint `VALIDATED` and `PASS`, every soft constraint `PASS`, no spec 2 `STRUCTURE` signal, every in-scope cell `AUTO_ACCEPT`, and exactly one table is in spec 3's scope. Its cells, rows and tables are accepted as `AUTO_ACCEPTED` values by spec 3 (spec 3 P5.2). Any other run goes to the LLM reviewer with only the selected items: cells with `REVIEW_REQUIRED` and every item involved in a failed or unevaluated constraint, plus every row and table of the run, since the model scores cells only. An item involved in a failed constraint has `CONSTRAINT_FAILED`; every other selected item has `MODEL_FLAGGED`. Unselected cells of a routed run are auto-accepted.

**When routing starts.** The maintainer promotes a model to `ROUTING` only when its gate is `PASS` and the autonomy report shows LLM review spend of at least `routingMinMonthlySpendUsd` (20 USD) in each of the last two full months. Below that, a gate `PASS` keeps the model in `SHADOW`, where it costs nothing and keeps being measured. The promotion pull request links the gate result and both reports.

### 8.9 Why not SageMaker

| SageMaker feature | Not used because | Justified when |
| --- | --- | --- |
| Real-time or serverless endpoints | A tree ensemble of at most 500 shallow trees evaluates in microseconds inside `ScoreRun`, with the features `ScoreRun` has just computed. An endpoint adds a network call, a second IAM boundary, and for real-time endpoints an always-on instance. | the model needs a GPU or a runtime that cannot run in Node.js, such as a neural vision model |
| Training jobs and Pipelines | Two steps on a dataset of tens of thousands of rows fit in one 15-minute, 10 GB Lambda and a two-state workflow. | the dataset exceeds 2 million rows or 8 GB in memory, or training exceeds 10 minutes |
| Feature Store | Spec 2's immutable feature rows are the offline store, keyed and versioned for training, and online features are computed in the process that uses them. | a second consumer needs the same features online at low latency |
| Model Registry | Immutable S3 manifests are the record, and a reviewed pull request that changes `risk-model-config` is the approval. | several models need separate approvers, or approvals must happen outside Git |

## 9. Audit, autonomy and cost

### 9.1 Human audit

People review two things: escalations, and spec 3's blind audit sample (`blindDoubleReviewShare` of cells, spec 3 §7.6). From stage 3 they also review a blind audit sample of auto-accepted cells (spec 3's reserved `AUDIT_SAMPLE` on `PRIMARY`, spec 3 P5.2).

**Truth for an audited cell** is the human blind adjudication, unless a `DISAGREEMENT_RESOLUTION` with a later `reviewedAt` exists, in which case it is that resolution. Spec 3 §6.4 has a third person resolve every disagreement.

**An error** for a decision under audit is a decision class or resolved text that differs from the truth. For an auto-accepted cell, or for the OCR reading in the gate (§8.6 G5), it is a truth of `CORRECTED` or `UNREADABLE`.

### 9.2 Error bounds

`audit-bounds.ts` computes, for each population, the error count `x`, the sample size `n` and the one-sided upper confidence bound of the error rate with the Clopper-Pearson method (the `1 - alpha` quantile of the Beta(`x + 1`, `n - x`) distribution, which is `1 - alpha^(1/n)` when `x` is 0):

| Population | Sample | Bound |
| --- | --- | --- |
| LLM decisions, per `modelId` and `promptVersion` | audited cells whose primary decision under audit is `LLM` | `U_LLM` |
| Human decisions | audited cells whose primary decision under audit is `HUMAN`, which are escalation answers | `U_HUMAN` |
| Auto-accepted cells (stage 3) | the audit sample of auto-accepted cells | `U_AUTO` |

**Accepted data.** Let `s_LLM`, `s_HUMAN` and `s_AUTO` be the shares of current cell decisions of each kind in the latest validated versions of runs in the report window. The accepted-data bound is `U_ACCEPTED = s_LLM * U_LLM + s_HUMAN * U_HUMAN + s_AUTO * U_AUTO`, with each bound computed at confidence `1 - 0.05 / k` for the `k` populations with a non-zero share (Bonferroni), so the combined statement holds at 95%. A population with a non-zero share and `n` of 0 makes `U_ACCEPTED` undefined and the report status `INSUFFICIENT_SAMPLE`.

The audit sample is drawn by a hash of a secret seed (spec 3 §7.6), independent of the decision and the reviewer, so each sample is uniform over its population and the bound applies to the whole population. The bound cannot see an error the LLM and the blind person both make (§18.4).

### 9.3 Audit share

The blind share is spec 3 configuration, changed only by a new `review-config` version in a reviewed pull request. This spec sets the rule that pull request follows, and the autonomy report recommends `SHRINK`, `HOLD` or `RESTORE`:

- **Window.** Bounds use every audit since the last reset. A reset happens when the current `modelId` or `promptVersion` changes, which starts new LLM populations at the initial share.
- **Shrink.** When `U_ACCEPTED` is at most half of `acceptedErrorTarget` and every population with a non-zero share has `n` of at least 2,995, the share may halve, to no less than `minAuditShare` (0.01), at most once per 90 days.
- **Restore.** When `U_ACCEPTED` exceeds `acceptedErrorTarget`, or a reset happens, the share returns to the initial 0.05 in the next configuration.

A smaller share collects fewer audits, so the bound tightens more slowly but does not loosen, because it uses every audit since the reset.

### 9.4 Autonomy metric

A run is **finalized without a person** when its first validated version (spec 3 §8.5) has no `HUMAN` count in `currentDecisionCounts` and the run had no escalation before that version's `createdAt`. A run **waits on a person** while it has an open escalation. **Fully autonomous** means no run waits on a person. It does not mean that no person ever audits: the audit sample is how the error bound is measured.

`ReportAutonomy` runs on the first day of each UTC month for the previous month, or when an operator invokes it with a window. It lists review plans, LLM review outcomes, escalations, adjudications and validated versions under the namespace, and writes `risk-autonomy-report/v1`:

- runs enqueued; finalized without a person; finalized after a person; waiting on a person; held, by reason; failed; not yet reviewed;
- `autonomyRate` = finalized without a person / (finalized + waiting on a person);
- time from plan to first validated version, median and 95th percentile;
- escalations by reason code;
- `U_LLM` per model and prompt version, `U_HUMAN`, `U_AUTO` and `U_ACCEPTED`, each with `x` and `n`, next to the autonomy rate;
- validated tables that fail a constraint (§4.5);
- LLM spend for the month and the ceiling;
- the audit share recommendation (§9.3);
- `status`: `OK`, `BOUND_EXCEEDED` when `U_ACCEPTED` exceeds the target, or `INSUFFICIENT_SAMPLE`.

`BOUND_EXCEEDED` raises an alarm (§15). In `ROUTING` mode the maintainer's response is a configuration pull request back to `SHADOW`.

### 9.5 Cost estimate and ceiling

This is an estimate, not a measurement. P0.3 and P0.4 measure it on the #91 captures before Phase 2 starts, and P0.4 replaces this table with the measured values.

**Image tokens.** Claude models with high-resolution vision accept up to 2,576 pixels on the long edge and use about `width * height / 750` tokens per image, up to about 4,784. In the #91 captures the table spans 0.90 of the image width and 0.42 of its height, and median word height is 0.0154 of the image height.

| Input for one 3840 x 2160 capture | Size | Estimated tokens |
| --- | --- | --- |
| Table crop, 0.92 x 0.44 of the image with margins | 3,533 x 950 px, resized to 2,576 x 693; word height about 24 px | 2,380 |
| Context image | 1,280 x 720 | 1,230 |
| System prompt and tool schema | | 1,800 |
| OCR table: 54 cells, 9 rows, 6 columns (capture 1) | | 1,400 |
| Failed constraints and roster candidates (`ASSISTED` only) | | 400 |
| **Input** | | **about 7,200** |
| Decisions for 64 items | | 900 |
| Thinking at effort `medium` (assumed) | | 2,000 |
| **Output** | | **about 2,900** |

**Prices.** The estimate uses Anthropic's published list prices per million tokens: Claude Sonnet 5.5 at 2 USD input and 10 USD output, Claude Opus 5.5 at 4 USD and 20 USD. It assumes Bedrock's on-demand price for the same model in the deployment Region is equal; P0.4 records the Bedrock price from the Bedrock pricing page and from billed usage.

| Model | One call | Worst case per screenshot (one invalid-output retry) |
| --- | --- | --- |
| Claude Sonnet 5.5 | about 0.043 USD | about 0.087 USD |
| Claude Opus 5.5 | about 0.087 USD | about 0.17 USD |

**Ceiling.** At about 0.05 USD per screenshot, the 50 USD `prod` ceiling covers about 1,000 screenshots a month, and the 10 USD `dev` ceiling about 200. When the ceiling is reached, LLM review pauses and runs are held with `BUDGET_EXHAUSTED` (§6.5); no run is accepted without review. `BudgetUsedFraction` alarms at 0.8 (§15). The ceiling is raised by a configuration change and a deploy, and held runs resume within an hour.

### 9.6 Recorded dependencies

This spec edits no other spec. Each dependency below is recorded in the spec it touches by the slice named, in the same pull request as the behavior.

| Dependency | Owner | Handled by |
| --- | --- | --- |
| Signal group `CONSTRAINT`, rules `K001` to `K007`, `rulesetVersion` and `scoringVersion` bumps (spec 2 §7, §9.2) | spec 2 | P1.2 |
| `QualityResult.tables[].profileId` and `constraints`, `QualityResult.routing`, `riskModel` filled (spec 2 §9.6, §10.1) | spec 2 | P1.2, P4.3, P5.2 |
| `features-v2` (spec 2 §8.4) and `constraintsVersion`, `constraintsConfigVersion`, `riskModelConfigVersion` as spec 2 stage versions (spec 2 §5.4) | spec 2 | P1.2, P4.3 |
| `ScoreRun` reads sibling runs, `GameIndex`, roster snapshots and `risk/models/` (spec 2 §6.2, §13.3, §13.4) | spec 2 | P1.4, P4.3 |
| `UNREADABLE` is a positive label, and splits group by `gameKey` (spec 2 §8.5 rules 1 and 6) | spec 2 | P4.1 |
| Spec 2 P5.5 is this specification; spec 2 P5.8 retires spec 1's materializer once P4.1 merges | spec 2 | P4.1 |
| `ocr-quality` imports `@mcc/roster` (spec 2 §12 allows only `@mcc/contracts` and `@mcc/cdk-config`) | spec 2, spec 6 P0.2 | P1.4 |
| The admin stack publishes `LlmReviewWrite`'s ARN as SSM parameter `/mcc/<env>/review/llm-review-write-function-arn` (ephemeral: `/mcc/dev/review/ephemeral/<name>/llm-review-write-function-arn`), so the `ocr-quality` stack can grant `lambda:InvokeFunction` on it | spec 3 P3.4 | P2.5 |
| An adjudication field recording that roster candidates were shown (`inputsShown.rosterCandidates`), as spec 6 P5.7 proposes for people | spec 3 | P2.4 records the gap; until spec 3 adds it, the invocation record holds `promptMode` and the candidates |
| Plans that select items, `MODEL_FLAGGED` and `CONSTRAINT_FAILED` adjudications, `AUTO_ACCEPTED` values and the audit of auto-accepted cells | spec 3 P5.2 | P5.2 |
| Escalation reason codes in §7.6 | spec 3 stores them uninterpreted (spec 3 §4.5) | P2.4 |
| The shared account check in `scripts/lib/account-guard.mjs` | spec 6 P2.3 | P0.3: whichever merges first creates the module unchanged from `scripts/cdk-app.mjs` |
| Evidence bucket EventBridge notifications | spec 2 P1.1 | P2.5 |

## 10. Typed domain model

### 10.1 Shared contracts

`@mcc/contracts` exports, next to spec 2's quality types and spec 3's review types:

```typescript
type ProfileId = 'halo3-team-slayer-v1';
type ConstraintId =
  | 'K001_TEAM_SCORE_LIMIT' | 'K002_KILLS_WITHIN_OPPONENT_DEATHS' | 'K003_DEATH_GAP_EXPLAINED'
  | 'K004_SCORE_NOT_ABOVE_KILLS' | 'K005_TEAM_STRUCTURE' | 'K006_PAGE_AGREEMENT'
  | 'K007_SUBMISSION_AGREEMENT';

interface ConstraintResult {
  id: ConstraintId;
  profileId: ProfileId | null;               // null with NO_PROFILE
  strength: 'HARD' | 'SOFT';
  validation: 'PROVISIONAL' | 'VALIDATED';
  status: 'PASS' | 'FAIL' | 'NOT_EVALUATED';
  notEvaluatedReason: 'NO_PROFILE' | 'NO_PEER' | 'MISSING_VALUE' | null;
  subject: { team?: string; opponentTeam?: string; rowIndex?: number; peerRunId?: string };
  observed: number | null;
  expectedMin: number | null;
  expectedMax: number | null;
  miss: number | null;                       // 0 when PASS
  involvedCellIds: readonly string[];
  involvedRowIndexes: readonly number[];
}

interface RunRouting {                       // QualityResult.routing; stage 3 only (§8.8)
  mode: 'ROUTING';
  autoFinalize: boolean;
  reasons: readonly string[];                // e.g. 'CELL_REVIEW_REQUIRED', 'CONSTRAINT_FAILED', 'NO_PROFILE'
  selectedItems: readonly { item: ReviewItem; selectionReason: 'MODEL_FLAGGED' | 'CONSTRAINT_FAILED' }[];
}

type PromptMode = 'BLIND' | 'ASSISTED';
type LlmReviewMode = 'AUTOMATIC' | 'RESUME' | 'BACKFILL' | 'REREVIEW';
type HoldReason = 'BUDGET_EXHAUSTED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REJECTED';
type EscalationReasonCode =
  | 'CONSTRAINT_UNRESOLVED' | 'CORRECTION_FAILS_CONSTRAINTS' | 'CORRECTION_UNCHECKED'
  | 'LLM_UNREADABLE' | 'LLM_REQUESTED' | 'OUTCOME_INCONSISTENT'
  | 'LLM_OUTPUT_INVALID' | 'LLM_REFUSED' | 'RUN_TOO_LARGE';

type CellVerdict = 'ACCEPT' | 'CORRECT' | 'UNREADABLE';
interface LlmCellDecision { ref: string; verdict: CellVerdict; value: string | null; errorTypes?: readonly CellErrorType[]; note?: string }
interface LlmRowDecision { ref: string; isPlayerRow: boolean; team: string | null; outcome: Outcome | null; note?: string }
interface LlmTableDecision {
  ref: string; role: 'SCOREBOARD' | 'NOT_SCOREBOARD';
  columnFields: Readonly<Record<string, ConfirmedField>> | null;
  undetectedRows: readonly UndetectedRow[]; note?: string;
}
interface LlmReviewOutput {
  tables: readonly LlmTableDecision[];
  rows: readonly LlmRowDecision[];
  cells: readonly LlmCellDecision[];
  escalations: readonly { ref: string; reasonCode: 'LLM_REQUESTED'; note?: string }[];
}

interface LlmReviewRequest {
  schemaVersion: 'llm-review-request/v1';
  llmReviewRunId: string;
  runId: string;
  qualityRunId: string;
  promptMode: PromptMode;
  stage: 1 | 2 | 3;
  items: readonly { ref: string; item: ReviewItem; selectionReason: SelectionReason }[];
  images: readonly { name: string; key: string; sha256: string; widthPx: number; heightPx: number }[];
  textInputSha256: string;
  promptVersion: string;
  modelId: string;
  estimatedMaxCostMicroUsd: number;
}

interface LlmInvocationRecord {
  schemaVersion: 'llm-invocation/v1';
  invocationId: string;
  llmReviewRunId: string;
  attempt: number;
  status: 'VALID' | 'INVALID' | 'REFUSED' | 'ERROR' | 'NOT_CALLED';
  modelId: string;
  promptVersion: string;
  promptMode: PromptMode;
  request: unknown;                          // Converse request; image bytes replaced by { key, sha256 }
  response: unknown | null;                  // full Converse response
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheWriteInputTokens: number } | null;
  costMicroUsd: number;
  pricesUsdPerMillionTokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  latencyMs: number | null;
  validation: { violations: readonly string[] } | null;
  error: { name: string; message: string } | null;
  notCalledReason: 'RUN_TOO_LARGE' | null;
  invokedAt: string;
}

// RiskModelAssessment is spec 2's reserved type (spec 2 §10.1); this spec fills it.
```

`ReviewItem`, `SelectionReason`, `CellErrorType`, `ConfirmedField`, `Outcome` and `UndetectedRow` are spec 3's (spec 3 §10.1). The dataset, model, evaluation, gate and report documents are Python and TypeScript records defined by the schemas in §5.3 and §8; their TypeScript types live in `src/lib/` because only `ocr-quality` reads them. Tool input from the model is validated against a JSON schema generated from `LlmReviewOutput` before any other use, and model text is never interpreted beyond §7.4.

### 10.2 Relationships

```text
Review plan 1 -> 0..many LLM review runs (automatic, resume, backfill, re-review)
LLM review run 1 -> 1 request -> 0..2 invocations -> 0..1 decisions -> 0..1 outcome
Invocation 1 -> many spec 3 LLM adjudications and 0..1 escalation (by invocationKey)
Quality result table 1 -> 0..1 profile -> many constraint results
Run 0..1 -> GameIndex item (by gameKey)
Dataset 1 -> many examples -> 1 spec 2 feature row and 1 spec 3 resolution each
Model version 1 -> 1 dataset, 1..many evaluations, 0..many gate results
Quality run many -> 0..1 model version (riskModel.modelVersion)
```

## 11. Module and function catalog

Every handler exports `handler` for Lambda and a core function that takes an injected dependencies object. Only default dependencies construct SDK clients.

### 11.1 Lambda entry points

| File | Public functions | Purpose |
| --- | --- | --- |
| `src/lambdas/score-run.ts` | existing | Adds profile and constraint evaluation, `GameIndex` writes, model loading and inference (§4, §8.7, §8.8). |
| `src/lambdas/prepare-llm-review.ts` | `handler(event)`; `prepareLlmReview(input, dependencies)` | §6.2. |
| `src/lambdas/invoke-llm-reviewer.ts` | `handler(event)`; `invokeLlmReviewer(input, dependencies)` | §6.3. The only Bedrock caller. |
| `src/lambdas/apply-llm-review.ts` | `handler(event)`; `applyLlmReview(input, dependencies)` | §6.4. The only `LlmReviewWrite` caller. |
| `src/lambdas/llm-review-maintenance.ts` | `handler(event)`; `hold`, `resumeHeld`, `backfill`, `rebuild`, `rereview` (each `(input, dependencies)`) | §6.1, §6.5. |
| `src/lambdas/build-risk-dataset.ts` | `handler(event)`; `buildRiskDataset(input, dependencies)` | §8.1. |
| `src/lambdas/report-autonomy.ts` | `handler(event)`; `reportAutonomy(input, dependencies)` | §9.4. |
| `training/src/risk_training/handler.py` | `handler(event, context)`; `train(dataset, config)`; `gate(model, dataset, config)` | §8.3 to §8.6. |

### 11.2 Libraries

| File | Public functions | Purpose |
| --- | --- | --- |
| `src/lib/constraints/profiles.ts` | `classifyProfile(observations, provenance, config)` | §4.1. Pure. |
| `src/lib/constraints/checks.ts` | `evaluateConstraints(table, profile, peers, config)` | §4.2. Pure. |
| `src/lib/constraints/peers.ts` | `findPagePeers(...)`; `findGamePeers(...)`; `gameKey(playerKeys)` | §4.3, with injected readers. |
| `src/lib/constraints/reviewed-table.ts` | `buildReviewedTable(observations, decisions)`; `checkReviewedTable(reviewed, ocr, peers, profile)` | §4.7. Pure. |
| `src/lib/llm-prompt.ts` | `buildReviewItems(observations, plan, resolutions)`; `buildTextInput(...)`; `renderPrompt(...)` | §7.1, §7.3. Pure. |
| `src/lib/llm-images.ts` | `cropTable(image, bbox, config)`; `contextImage(image, config)` | §7.2. Sharp only. |
| `src/lib/llm-output.ts` | `validateLlmOutput(request, toolInput, stopReason)`; `toAdjudicationPayloads(request, output, mode)` | §7.4, §7.5. Pure. |
| `src/lib/llm-escalation.ts` | `decideEscalations(request, output, checks, writeResults)` | §7.6. Pure. |
| `src/lib/bedrock-reviewer.ts` | `BedrockReviewer.converse(request)` | Converse call and error mapping (§6.6). |
| `src/lib/llm-budget.ts` | `estimateCost(request, config)`; `reserve`; `settle`; `release`; `putHold`; `listHolds` | §6.5, against `LlmReviewState`. |
| `src/lib/risk-model.ts` | `loadRiskModel(config, dependencies)`; `assessCell(model, featureRow)` | §8.7. Evaluation is pure. |
| `src/lib/audit-bounds.ts` | `clopperPearsonUpper(x, n, alpha)`; `acceptedBound(populations)`; `auditShareRecommendation(...)` | §9.2, §9.3. Pure. |
| `src/lib/adjudications.ts` | `resolveChain(adjudications, cutoff?)` | Spec 3 §8.1 resolution, shared with spec 2's baseline builder (spec 2 P4.1). |
| `training/src/risk_training/export.py` | `export_ensemble(booster, calibrator, vocabularies)` | §8.7. |
| `training/src/risk_training/calibration.py` | `fit_isotonic(scores, labels)`; `choose_threshold(probabilities, labels, target)` | §8.4. |

### 11.3 Scripts

| File | Purpose |
| --- | --- |
| `scripts/llm-review-spike.ts` | P0.3. Runs the LLM review on capture files outside the repository and prints counts, tokens, latency and cost only. |
| `scripts/evaluate-constraints.ts` | P1.3. Runs profiles and constraints on capture files and a truth file outside the repository and prints counts only. |

### 11.4 Infrastructure code

| File | Public API | Purpose |
| --- | --- | --- |
| `cdk/lib/ocr-quality-stack.ts` | `OcrQualityStack` | Adds the resources in §13.3 and permissions in §13.4. |
| `training/Dockerfile` | container image | `TrainRiskModel`. |

## 12. Directory structure and ownership

```text
mcc-stats-suite/
  applications/ocr-quality/
    config/
      constraints-config-v1.json       # profiles, tolerances, validation status
      llm-review-config-v1.json        # §13.1
      risk-model-config-v1.json        # mode OFF
      prompts/llm-review-prompt-v1.md  # system prompt; immutable once released
    scripts/{llm-review-spike,evaluate-constraints}.ts
    src/
      lambdas/{prepare-llm-review,invoke-llm-reviewer,apply-llm-review,llm-review-maintenance,build-risk-dataset,report-autonomy}.ts
      lib/constraints/{profiles,checks,peers,reviewed-table}.ts
      lib/{llm-prompt,llm-images,llm-output,llm-escalation,bedrock-reviewer,llm-budget,risk-model,audit-bounds,adjudications}.ts
    test/
      fixtures/llm/*.json              # synthetic model outputs with placeholder gamertags
      fixtures/risk/*.json             # synthetic datasets and a fixture model with parity rows
    training/
      Dockerfile
      requirements.txt                 # pinned with hashes
      config/training-config-v1.json
      src/risk_training/
      tests/                           # pytest, synthetic data only
  packages/contracts/src/index.ts      # §10.1 types
```

`ocr-quality` imports only `@mcc/contracts`, `@mcc/cdk-config` and `@mcc/roster` from the monorepo. `training/` imports nothing from the monorepo; its contract with TypeScript is the dataset and model formats in §5.3 and §8, tested from both sides with the same fixtures.

## 13. Configuration and infrastructure

### 13.1 Configuration schema

```json
{
  "llmReviewConfigVersion": "llm-review-config-v1",
  "modelId": "anthropic.claude-sonnet-5-5",
  "promptVersion": "llm-review-prompt-v1",
  "additionalModelRequestFields": { "output_config": { "effort": "medium" } },
  "maxOutputTokens": 8000,
  "requestTimeoutSeconds": 120,
  "maxInvocationsPerReview": 2,
  "maxCellsPerRun": 300,
  "tableCropMarginFraction": 0.01,
  "tableCropMaxLongEdgePx": 2576,
  "contextImageLongEdgePx": 1280,
  "rosterCandidatesPerRow": 3,
  "rosterCandidateMaxKeyDistance": 3,
  "teamNames": ["Red", "Blue", "Green", "Orange", "Purple", "Gold", "Brown", "Pink"],
  "pricesUsdPerMillionTokens": {
    "anthropic.claude-sonnet-5-5": { "input": 2.0, "output": 10.0, "cacheRead": 0.2, "cacheWrite": 2.5 }
  },
  "monthlyBudgetUsd": { "prod": 50, "dev": 10, "ephemeral": 2 },
  "budgetAlarmFraction": 0.8,
  "resumeBatchSize": 20,
  "acceptedErrorTarget": 0.001,
  "minAutoAcceptRate": 0.5,
  "minAuditShare": 0.01,
  "routingMinMonthlySpendUsd": 20
}
```

`constraints-config-v1.json` holds, per profile, the predicates' parameters, `scoreLimit` (50), `killDeathSlack` (0), `minSharedPlayers` (4), `sameGameWindowDays` (7) and each constraint's `validation` (all `PROVISIONAL` in v1). `risk-model-config-v1.json` is `{ "riskModelConfigVersion": "risk-model-config-v1", "mode": "OFF" }`.

Every file is bundled into the Lambdas and validated at cold start; an invalid file throws `InvalidLlmReviewConfigError`, `InvalidConstraintsConfigError` or `InvalidRiskModelConfigError`. `modelId` must have an entry in `pricesUsdPerMillionTokens`, so every call can be costed. `teamNames` must equal spec 3's `teamNames`, and `training-config-v1` repeats `acceptedErrorTarget` and `minAutoAcceptRate` for the gate; tests compare each copy with its source. A released file is never edited; a change adds a new version and bumps the matching stage version (§5.4). P0.4 sets `modelId`, `additionalModelRequestFields` and prices from its measurements in `llm-review-config-v2`.

### 13.2 Persistent resources

| Resource | Owner | Configuration |
| --- | --- | --- |
| Evidence bucket, KMS data key, SSM parameters | OpenTofu foundation | Existing (spec 2 §13.2). No change. |
| Bedrock model access for `modelId` in the Region | account setting | Enabled once per account by a person in the Bedrock console. Not managed by OpenTofu or CDK. |
| `LlmReviewWrite` ARN parameter | spec 3 admin stack | §9.6 |

### 13.3 Application resources

| Resource | Configuration |
| --- | --- |
| `PrepareLlmReview` | Node.js 22, ARM64, 2,048 MB, 2-minute timeout, X-Ray, env `EVIDENCE_BUCKET`, `OBJECT_PREFIX`, `DEPLOYMENT_ENVIRONMENT`, `GIT_SHA` |
| `InvokeLlmReviewer` | Node.js 22, ARM64, 1,024 MB, 5-minute timeout, X-Ray, env as Prepare plus `LLM_REVIEW_TABLE` |
| `ApplyLlmReview` | Node.js 22, ARM64, 1,024 MB, 5-minute timeout, X-Ray, env as Invoke plus `LLM_REVIEW_WRITE_FUNCTION_ARN` from the §9.6 parameter |
| `LlmReviewMaintenance` | Node.js 22, ARM64, 1,024 MB, 15-minute timeout, env as Invoke plus `LLM_REVIEW_STATE_MACHINE_ARN` |
| `BuildRiskDataset` | Node.js 22, ARM64, 4,096 MB, 15-minute timeout, env `EVIDENCE_BUCKET`, `OBJECT_PREFIX`, `GIT_SHA` |
| `TrainRiskModel` | container image, ARM64, 10,240 MB, 15-minute timeout, 10 GB ephemeral storage, env `EVIDENCE_BUCKET`, `OBJECT_PREFIX`, `GIT_SHA` |
| `ReportAutonomy` | Node.js 22, ARM64, 2,048 MB, 15-minute timeout, env `EVIDENCE_BUCKET`, `OBJECT_PREFIX`, `LLM_REVIEW_TABLE` |
| `ScoreRun` (changed) | memory 1,536 MB; env adds `GAME_INDEX_TABLE` |
| State machine `<stack>-llm-review` | Standard, 30-minute timeout, X-Ray, `ALL` logging with execution data (payloads hold keys, counts and reasons only); Prepare, Choice, Invoke, Choice, Apply, with the §6.6 retries and a `Catch` on Invoke's provider errors to a hold step in `LlmReviewMaintenance` |
| State machine `<stack>-risk-training` | Standard, 40-minute timeout; `BuildRiskDataset` then `TrainRiskModel` |
| EventBridge rule and DLQ | §6.1; the DLQ is spec 2's `<stack>-events-dlq` |
| Schedules (EventBridge Scheduler) | hourly `RESUME`; weekly `<stack>-risk-training`, disabled until P4.5 enables it; monthly `ReportAutonomy`. Ephemeral stacks create none. |
| `LlmReviewState` table | on-demand; `pk` `BUDGET#<yyyy-mm>` with `sk` `TOTAL`, or `HOLD` with `sk` `<runId>`; encrypted with the foundation data key; removed with the stack; rebuilt by `REBUILD` from LLM review outcomes and invocation records |
| `GameIndex` table | on-demand; `pk` `GAME#<gameKey>`, `sk` `<receivedAt>#<runId>`, attributes run prefix, `submissionId`, `profileId`; encrypted with the foundation data key; removed with the stack; rebuilt by an `AUTOMATIC` backfill of spec 2 |
| Outputs | adds `LlmReviewStateMachineArn`, `RiskTrainingStateMachineArn`, `LlmReviewMaintenanceFunctionName`, `ReportAutonomyFunctionName` |

### 13.4 Permissions

| Principal | Evidence bucket | Other |
| --- | --- | --- |
| `ScoreRun` (added) | `ListBucket` with prefix `<ns>submissions/`, for sibling runs; `GetObject` on `<ns>risk/models/*` and `<ns>roster/versions/*` | `GameIndex` `GetItem`, `Query`, `PutItem` |
| `PrepareLlmReview` | `ListBucket` with prefix `<ns>submissions/`; `GetObject` on `<ns>submissions/*` and `<ns>roster/versions/*`; `PutObject` on `<ns>submissions/*/runs/*/llm-review/*` | none |
| `InvokeLlmReviewer` | `GetObject` on `<ns>submissions/*/runs/*/llm-review/*`; `PutObject` on `<ns>submissions/*/runs/*/llm-review/*/invocations/*` | `bedrock:InvokeModel` on `arn:aws:bedrock:<region>::foundation-model/<modelId>` only; `LlmReviewState` `UpdateItem` |
| `ApplyLlmReview` | `ListBucket` with prefix `<ns>submissions/`; `GetObject` on `<ns>submissions/*`; `PutObject` on `<ns>submissions/*/runs/*/llm-review/*` | `lambda:InvokeFunction` on the `LlmReviewWrite` ARN only; `LlmReviewState` `DeleteItem` on hold items |
| `LlmReviewMaintenance` | `ListBucket` with prefix `<ns>submissions/`; `GetObject` on `<ns>submissions/*`; `PutObject` on `<ns>submissions/*/runs/*/llm-review/*` | `states:StartExecution` on `<stack>-llm-review`; `LlmReviewState` read and write |
| `BuildRiskDataset` | `ListBucket` with prefix `<ns>submissions/`; `GetObject` on `<ns>submissions/*`; `PutObject` on `<ns>risk/datasets/*` | none |
| `TrainRiskModel` | `GetObject` on `<ns>risk/*`; `PutObject` on `<ns>risk/models/*`, `<ns>risk/evaluations/*` and `<ns>risk/gates/*` | none |
| `ReportAutonomy` | `ListBucket` with prefixes `<ns>submissions/` and `<ns>risk/`; `GetObject` on both; `PutObject` on `<ns>risk/reports/*` | `LlmReviewState` `Query` |
| State machine roles | none | `lambda:InvokeFunction` on their own tasks only |

Every role has KMS decrypt and encrypt on the data key, the workload permissions boundary and, for ephemeral stacks, the `/mcc-local/` path. No role has `DeleteObject`, any bucket-configuration permission, any Bedrock action other than `InvokeModel`, any inference profile ARN, or `PutObject` under `quality/` except `ScoreRun`. `ApplyLlmReview` is the only role in the stack with `lambda:InvokeFunction` on `LlmReviewWrite`. P1.5 extends `scripts/local-cdk-bootstrap.mjs` so ephemeral `ocr-quality-e-*` stacks can create and delete their DynamoDB tables, and so the local workload boundary allows `bedrock:InvokeModel` on foundation models in the Region and `lambda:InvokeFunction` on `admin-e-*` functions. Container image assets already use the bootstrap ECR repository it permits.

### 13.5 Deployment

The stack deploys as spec 2 §13.5 describes. The deploy preflight also fails when the `LlmReviewWrite` ARN parameter (§9.6) is missing, once Phase 2 resources exist. Before the first stable deploy with Phase 2, a person enables Bedrock model access for `modelId` in the Region and confirms that Bedrock model invocation logging is either disabled or delivers to an in-account, encrypted destination (§14). Post-deploy verification checks that every new Lambda is `Active`, both state machines are `ACTIVE`, and the hourly schedule exists. CDK builds the training image during asset publishing, so synthesis in CI needs no Docker build.

## 14. Security and privacy

1. Screenshots, OCR text and gamertags go to Bedrock only through `InvokeLlmReviewer`, to the Bedrock Runtime endpoint of the stack's Region, with an in-Region foundation model ID. IAM allows `InvokeModel` only on that model's ARN in that Region, so a cross-Region or global inference profile is denied.
2. Bedrock does not store prompts or responses or use them to train models (AWS Bedrock data protection). Model invocation logging is an account setting this stack never enables; §13.5 makes a person confirm it before Phase 2 deploys.
3. Every prompt, image and response is stored as evidence in the evidence bucket under the foundation data key (§5). Datasets, model artifacts, evaluations, gates and reports are stored the same way.
4. OCR text and anything in a screenshot are untrusted and may contain instructions. The prompt marks them as data, the model has one tool and no other capability, its output is schema-validated and limited to the decision vocabulary and 256-character values, and corrections pass the checks in §7.6. A manipulated answer can at worst label one run's items wrongly, which the audit measures.
5. Model artifacts hold no free text: the feature allowlist excludes every text field (§8.2), so trees split only on numbers and fixed vocabularies.
6. No real gamertag enters the repository. Prompts, test fixtures, evaluation fixtures and model fixtures use placeholders such as `Player05`. The spike and constraint scripts read captures, truth files and outputs only outside a Git working tree and print counts, tokens and costs, never names.
7. Logs and Step Functions payloads carry keys, IDs, counts, reason codes, token counts and costs, never observed text, decisions' values, prompts or responses.
8. Only `ApplyLlmReview` can invoke `LlmReviewWrite`, so only this workflow writes `LLM` adjudications (spec 3 §14 item 11).
9. Ephemeral stacks read and write only under `ephemeral/<name>/`, enforced by key validation and IAM resource patterns, and invoke only their own namespace's `LlmReviewWrite`.

## 15. Observability

- Lambdas log JSON lines with `level`, `message` and context: `runId`, `llmReviewRunId`, `invocationId`, `mode`, `promptMode`, `modelId`, `promptVersion`, token counts, `costMicroUsd`, latency, item counts, reason codes, hold reasons and error names.
- In stable stacks, Lambdas emit EMF metrics with the single dimension `Stage`, following [spec 5](5-match-to-csv-observability.md): `LlmReviewCompleted`, `LlmReviewEscalated`, `LlmReviewHeld`, `LlmReviewFailed`, `LlmInvalidOutput`, `LlmCostMicroUsd`, `BudgetUsedFraction`, `HeldRuns` (from the hourly pass), `ProviderRejected`, `RiskModelLoadFailed` and `AutonomyBoundExceeded`.
- Alarms: `HeldRuns` above 0 for 24 hours, `BudgetUsedFraction` at or above `budgetAlarmFraction`, `ProviderRejected` above 0, `LlmReviewFailed` above 0, `RiskModelLoadFailed` above 0, and `AutonomyBoundExceeded` above 0. Ephemeral stacks create none.
- X-Ray tracing is active on every function and state machine.
- The audit record for "why did this run wait or get this value" is its `llm-review/` prefix: the claim, each run's manifest, request, images, invocations, decisions and outcome, next to spec 3's adjudications and escalations that name the invocation.

## 16. Testing, CI and release

### 16.1 Tests

TypeScript tests use `tap` under `applications/ocr-quality/test/`, Python tests use `pytest` under `training/tests/`, and none calls AWS or Bedrock. The TypeScript thresholds are spec 2's; the Python suite fails below 80% line coverage.

| File | Covers |
| --- | --- |
| `constraints.test.ts` | every check in §4.2 passes on the two #91 fixtures, with a synthetic game variant `LINE` added because the reduced fixtures drop `LINE` blocks, with the numbers in §4.4; each fails on a seeded case with the right `miss` and involved items; `MISSING_VALUE` on a non-integer; `NO_PROFILE` on the FFA and `UNKNOWN` fixtures; `K005` fails on a Team Slayer table parsed as free-for-all |
| `profiles.test.ts` | capture 1 headers (`SCORE` with a trailing symbol, `ASSI`, empty deaths) and capture 2 headers match; three matching headers do not; the game variant predicate with and without a `LINE` above the table |
| `peers.test.ts` | page grouping needs 4 shared keys and different image hashes; game grouping needs equal key multisets within 7 days and different submissions; comparison with a peer's validated version when one exists |
| `features-v2.test.ts` | every new feature present, `null` when not evaluated; roster fields `null` without a roster reference |
| `llm-prompt.test.ts` | `BLIND` text has no parser team, outcome, constraint or roster field; `ASSISTED` has all; references map back to IDs; observed text over 256 characters is cut; prompt text is stable for a fixed input |
| `llm-images.test.ts` | crop box with margins and clipping; long edge capped at 2,576 and never enlarged; context image at 1,280 |
| `llm-output.test.ts` | every rule in §7.4 with a violating case; `ACCEPT` with a different value is invalid; refusal stop reasons; mapping to spec 3 payloads in §7.5, including `REREVIEW` supersession and deterministic `clientRequestId` |
| `llm-escalation.test.ts` | each rule in §7.6 on seeded cases, including a correction that fixes a `K001` miss (accepted), one that breaks `K002` (escalated), a soft failure present before review (not escalated), a correction in an unprofiled scoreboard, and the 256-item cap order |
| `llm-budget.test.ts` | reservation fits and fails at the ceiling; settle with actual cost; release on error; month rollover; rebuild from invocation records |
| `prepare-llm-review.test.ts`, `invoke-llm-reviewer.test.ts`, `apply-llm-review.test.ts` | write order and create-only writes; claim and `RESUME` rules; reservation and request record before the call; a failed reservation throws `LlmBudgetExhaustedError` without a call; each Bedrock error mapped as §6.6; invalid output retried once, then escalated; held runs write no adjudication; spec 3 rejections handled as §6.4; replay after a partial Apply writes nothing new |
| `llm-review-maintenance.test.ts` | resume skips budget holds without headroom and respects the batch size; backfill finds plans without a claim; rebuild equals incremental state |
| `risk-model.test.ts` | the fixture model's parity rows match within 1e-9; categorical `OTHER` codes; missing values follow the exported direction; hash or parity failure writes no `riskModel`; `ROUTING` without a `PASS` gate runs in `SHADOW` |
| `build-risk-dataset.test.ts` | spec 2 §8.5 selection rules; `UNREADABLE` positive; `SKIPPED` excluded; grouping by image, submission and game key; split determinism for a seed; audit file truth with and without a disagreement resolution; no feature from adjudications |
| `audit-bounds.test.ts` | Clopper-Pearson upper bounds against published values, including `x = 0` and `n = 2,995` at 0.1%; Bonferroni combination; share recommendations |
| `report-autonomy.test.ts` | the autonomy definitions in §9.4 on a fixture namespace, including a run finalized by the LLM, one after an escalation, one held and one waiting |
| `app.test.ts` | stack resources and IAM in §13.3 and §13.4, including the single Bedrock model ARN, no inference profile, and `lambda:InvokeFunction` on `LlmReviewWrite` for `ApplyLlmReview` only |
| `training/tests/test_*.py` | training on a synthetic dataset is deterministic for a seed; isotonic export; threshold choice against a target; export round-trips the fixture model and its parity rows; every gate check passes and fails on seeded inputs; `INSUFFICIENT_DATA` |

Fixtures are synthetic or reduced from the existing placeholder fixtures. Recorded Bedrock responses in fixtures are written by hand from the placeholder data, never copied from a real call.

### 16.2 Evaluations

P0.4 and P2.6 measure the LLM reviewer on real captures outside the repository: per model and prompt mode, valid-output rate, agreement with transcribed truth per item kind, tokens, latency and cost. P1.3 measures the constraints. The risk model's evaluation is §8.5 and its gate §8.6. A passing evaluation on two captures proves the pipeline runs and states its cost; it does not prove an error rate, which only the audit in §9 measures.

### 16.3 CI and release

CI runs format, lint, typecheck and `tap` for `ocr-quality`, and synthesizes it as spec 2 §16.2 describes. P4.2 adds a CI job that runs `pytest` in `training/` when files under it change, and updates `scripts/ci-scope.mjs` and `.github/workflows/` in the same pull request. Release Please versions the application and `@mcc/contracts`.

### 16.4 Live validation

After Phase 2 reaches dev, an operator sends the #91 screenshots to the dev address and checks that each run has an LLM review run with a `VALID` invocation, `LLM` adjudications for every required item that name the invocation, and either a validated version with no `HUMAN` decisions or an escalation with reason codes. They lower the dev ceiling below one call in a configuration change, send a screenshot, check that it is `HELD` with `BUDGET_EXHAUSTED` and has no adjudication, restore the ceiling and check that the next hourly pass reviews it. With the model ID changed to one without access, a run is `HELD` with `PROVIDER_REJECTED` and alarms.

## 17. Acceptance criteria

1. A scored dev run gets an LLM review run with every §5.1 object and `LLM` adjudications for every required table, row and cell, each naming its invocation key, within 5 minutes of its review plan.
2. A run of the `halo3-team-slayer-v1` profile with every evaluated constraint passing and only `ACCEPT` decisions completes with a validated version whose lineage has no `HUMAN` decision.
3. A fixture run whose LLM output corrects a kills value so that `K002` fails is escalated with `CORRECTION_FAILS_CONSTRAINTS` naming the corrected cell and the involved cells, and the LLM adjudications exist.
4. A run of a `PRIORITY_HIDDEN` plan is reviewed with a `BLIND` prompt and its adjudications record `priorityShown: false`.
5. A Bedrock throttling or outage error after the retries holds the run with `PROVIDER_UNAVAILABLE`, writes no adjudication, and the next hourly pass reviews it once Bedrock answers.
6. A call that does not fit the monthly ceiling holds the run with `BUDGET_EXHAUSTED` before Bedrock is called, and the month's committed cost never exceeds the ceiling.
7. Two invalid outputs escalate every required item with `LLM_OUTPUT_INVALID`, and no adjudication is written.
8. Every quality result of a profiled table records its constraint results, and `features-v2` rows carry the constraint and roster fields.
9. A model trained on a synthetic dataset exports trees that `ScoreRun` evaluates within 1e-9 of LightGBM on the parity rows, and `SHADOW` mode fills `riskModel` without changing review.
10. A gate result without at least 2,995 human-audited auto-accept cells is not `PASS`, and `ROUTING` without a `PASS` gate runs in `SHADOW`.
11. The monthly report states the autonomy rate and `U_ACCEPTED` with their counts.
12. No Bedrock call leaves the stack's Region, and the IAM policy names one foundation model ARN.
13. No file in the repository contains a real gamertag.
14. Every §16.1 test passes with the coverage thresholds, and CDK synthesis succeeds.

## 18. Risks and accepted limitations

1. **The cost is an estimate.** §9.5 assumes token counts, thinking length and Bedrock prices. P0.3 and P0.4 measure them before Phase 2; until then the ceilings are the protection.
2. **The model may not be available in the Region.** Recent Anthropic models on Bedrock are sometimes offered only through cross-Region inference profiles, which §14 forbids. P0.4 checks on-demand availability in the deployment Region. With no candidate available, Phases 2 to 4 are not filed, and the outcome is recorded on P0.4's issue.
3. **Constraints rest on two captures.** All seven start `PROVISIONAL` and cannot auto-accept anything until P5.1 validates them on 30 captures. The game variant predicate is unverified until P0.4 (§4.1).
4. **LLM and person can agree on a wrong value.** The audit bound measures disagreement with a blind person; a misreading both make is invisible to it. Accepted because the two read the image independently and the person never sees the LLM's answer; the risk is highest for glyphs both find ambiguous, such as `I` and `l` in names, which spec 6's roster key also folds.
5. **LLM errors are correlated.** One prompt and model can repeat a mistake on every screenshot of a layout (spec 3 §18.17). Bounds are per model and prompt version, and a change resets them (§9.3).
6. **The learned model learns from LLM labels.** Training on LLM labels can teach the model the LLM's blind spots. Accepted because the gate's error bound uses human labels only (G5).
7. **The audit takes months to reach the gate.** About 1,700 runs at the initial share (§8.6). Accepted; the model stays in `SHADOW` meanwhile at no cost.
8. **Held runs wait.** A long outage or an exhausted budget delays every run. They are never accepted, and `HeldRuns` alarms after 24 hours.
9. **Only Halo 3 Team Slayer is profiled.** Corrections in other scoreboards escalate (`CORRECTION_UNCHECKED`), and those runs cannot auto-finalize in stage 3. New profiles are backlog (P6.3).
10. **A same-game disagreement escalates only the later run.** `K007` compares with the earlier run's validated values, and if the earlier run is the wrong one, it keeps its value until a person sees the later run. P6.1 escalates both.
11. **`ASSISTED` prompts can anchor the LLM.** Showing the parser's teams, failed constraints and roster candidates can make the LLM agree with them. Hidden runs get `BLIND` prompts, and the report can compare the two populations.
12. **Spec 3 cannot yet record roster candidates shown.** Until spec 3 adds the field (§9.6), consumers read it from the invocation record.
13. **Cross-run constraints depend on order.** The first page or submission of a game is scored with `NO_PEER`. `ApplyLlmReview` re-evaluates later, but spec 2's features for the first run keep `NO_PEER`.
14. **Prompt injection.** A screenshot could carry text aimed at the model. The damage is bounded to wrong labels for one run (§14 item 4), which the audit measures and the constraint checks partly catch.
15. **Training is bounded by Lambda.** 15 minutes and 10 GB. §8.9 names the trigger for moving to SageMaker training jobs.
16. **Price changes are manual.** Prices are configuration, so the budget is wrong if Bedrock changes them until a new configuration ships. The report compares computed cost with the month's billed Bedrock cost in the backlog (P6.5).

## 19. Reference documentation

- Amazon Bedrock Converse API: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
- Amazon Bedrock conversation inference and tool use: https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html
- Amazon Bedrock pricing: https://aws.amazon.com/bedrock/pricing/
- Amazon Bedrock data protection: https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html
- Amazon Bedrock model invocation logging: https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html
- Amazon Bedrock cross-Region inference: https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html
- Claude vision, image sizes and token cost: https://platform.claude.com/docs/en/build-with-claude/vision
- Lambda container images: https://docs.aws.amazon.com/lambda/latest/dg/images-create.html
- EventBridge Scheduler: https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html
- LightGBM parameters: https://lightgbm.readthedocs.io/en/latest/Parameters.html
- scikit-learn probability calibration: https://scikit-learn.org/stable/modules/calibration.html
- S3 conditional writes: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html

## 20. Delivery plan: phases and slices

This section is the backlog source for building the component. It is written to be turned directly into GitHub issues.

### 20.1 How to file this plan

- Each **phase** becomes one epic, titled with the phase title, with its goal and exit criteria as the body. Create epics only when someone explicitly asks for filing.
- Each **slice** becomes one leaf issue under its phase epic, titled without its code, with `Plan ID: P<n>.<m>` in the body. File with `/mcc-create-github-issue`.
- **Size** is XS, S or M. Split a slice by independently testable behavior when it outgrows one reviewable PR; the original Plan ID becomes the container.
- **Blocked by** lists Plan IDs. "Spec 2 P<n>.<m>", "spec 3 P<n>.<m>" and "spec 6 P<n>.<m>" name slices of those specifications. Create native blocked-by links after every issue in the batch exists. Blockers in earlier phases still apply.
- **Acceptance** bullets become the issue's acceptance criteria verbatim. Every slice also inherits §20.3.
- **Spec** lists the sections the implementer must read. Link them; this document stays the source of truth.
- Plan IDs are stable. Deferred slices keep their IDs and move to the backlog phase; new slices take the next free number in their phase.
- P0.4 and P5.1 are run by the maintainer, who has the captures and AWS access. Phases 2 to 4 are filed only after P0.4 records a go decision, because they build on it. Phase 5 is filed when spec 3 P5.2 is filed. Phase 6 is backlog.

### 20.2 Seam contracts

| Contract | Defined in | Main consumers |
| --- | --- | --- |
| `ConstraintResult`, profile IDs and constraint IDs (§4, §10.1) | P0.1 | `score-run`, `apply-llm-review`, spec 3 displays, the dataset builder |
| `LlmReviewOutput` and the `submit_review` tool schema (§7.4) | P0.1, P0.2 | `invoke-llm-reviewer`, `apply-llm-review`, the spike |
| `llm-review/` key layout, `llm-invocation/v1` and the invocation key rule (§5) | P0.1, P2.2 | spec 3 `LlmReviewWrite` (hashes the invocation), `report-autonomy` |
| Escalation reason codes (§7.6) | P0.1 | spec 3 stores them, `report-autonomy` |
| `LlmReviewWrite` payloads and codes, and its ARN parameter | spec 3 P3.5, P3.4 | `apply-llm-review` |
| Profiles and constraint configuration (§4.1, §4.5, §13.1) | P1.1 | `score-run`, `apply-llm-review`, P1.3 |
| `features-v2` (§4.6) | P1.2 | the dataset builder, training |
| `risk-dataset/v1`, `risk-example/v1` (§8.1) | P4.1 | `TrainRiskModel` |
| `risk-tree-ensemble/v1` and parity rows (§8.7) | P4.2, P4.3 | `ScoreRun` |
| `risk-gate/v1` and `risk-model-config` (§8.6, §8.7) | P4.4, P4.3 | `ScoreRun`, promotion pull requests |
| `QualityResult.routing` (§8.8, §10.1) | P5.2 | spec 3 P5.2 plans, `prepare-llm-review` |
| `risk-autonomy-report/v1` (§9.4) | P3.1 | the maintainer, audit share changes in spec 3 configuration |

A change to a contract updates every consumer in the same PR.

### 20.3 Definition of done for every slice

- Handlers keep I/O behind an injected dependencies object; only default dependencies construct SDK clients. Constraint, prompt, output, escalation, risk-model and audit-bound code stays pure.
- New behavior has tests that run without AWS or Bedrock (`tap` for TypeScript, `pytest` for `training/`), and the workspace stays above its coverage thresholds.
- `npm run check` passes. Slices that touch CDK also pass `npm run app:synth -- ocr-quality --environment dev`.
- Any change to a stage's behavior bumps that stage's version (§5.4).
- A slice that changes behavior another spec describes records it in that spec in the same PR (§9.6).
- No domain, address, account ID or real gamertag appears in code, prompts, fixtures, logs or docs. Scripts that read real captures refuse paths inside a Git working tree and print counts only.
- Operator-visible changes update `applications/ocr-quality/TESTING.md`.

### Phase 0: Contracts and measured feasibility

**Goal:** the shared types, the prompt and output library, and a measured LLM review of the #91 captures.
**Exit criteria:** P0.4 records the measured cost per screenshot, the chosen model, its in-Region availability, and the game variant predicate outcome, with a go or no-go for Phase 2.

#### P0.1 Constraint, LLM review and risk model contracts (S)

- **Blocked by:** spec 2 P0.2; spec 3 P0.2
- **Spec:** §4.2, §5.3, §7.4, §7.6, §10.1
- **Files:** `packages/contracts/src/index.ts`
- **Provides:** every type in §10.1
- **Acceptance:**
  - The types compile and are exported, and reuse spec 3's `ReviewItem`, `SelectionReason`, `CellErrorType` and `UndetectedRow` without redefining them.
  - `npm run release:check` passes.

#### P0.2 Prompt, image and output library (M)

- **Blocked by:** P0.1; spec 2 P0.1
- **Spec:** §7.1 to §7.5, §13.1
- **Files:** `src/lib/{llm-prompt,llm-images,llm-output}.ts`, `config/prompts/llm-review-prompt-v1.md`, `config/llm-review-config-v1.json`, `test/fixtures/llm/`
- **Provides:** `buildReviewItems`, `buildTextInput`, `renderPrompt`, `cropTable`, `contextImage`, `validateLlmOutput`, `toAdjudicationPayloads`, the `submit_review` schema
- **Acceptance:**
  - The `llm-prompt`, `llm-images` and `llm-output` rows of §16.1 pass.
  - The prompt and fixtures contain only placeholder gamertags.
  - `loadLlmReviewConfig` rejects a `modelId` without prices and a `teamNames` list that differs from spec 3's.

#### P0.3 LLM review spike script (S)

- **Blocked by:** P0.2
- **Spec:** §9.5, §14, §16.2, §18.2
- **Files:** `applications/ocr-quality/scripts/llm-review-spike.ts`, `scripts/lib/account-guard.mjs` (§9.6), `applications/ocr-quality/TESTING.md`
- **Provides:** a reproducible measurement of LLM review on capture files
- **Acceptance:**
  - The script takes capture files from `scripts/capture-textract.ts` with their images, a truth file and an output directory, all outside a Git working tree, and refuses any path inside one.
  - It runs the account check before any call, for `dev` only.
  - For each candidate model (`anthropic.claude-sonnet-5-5`, then `anthropic.claude-opus-5-5`), each capture, both prompt modes and 3 repeats, it calls `Converse` in the configured Region with the P0.2 prompt and prints image sizes, image and text token estimates, billed input and output tokens, latency, computed cost, the validation result, and agreement with the truth per item kind as counts.
  - It prints whether the model is invocable on demand in the Region, and whether a `LINE` above the table contains `TEAM` and `SLAYER`, as booleans.
  - Prompts and responses are written only to the output directory; nothing it prints contains a gamertag. Tests use a mocked Bedrock client.

#### P0.4 Measure LLM review on the #91 captures (XS)

- **Blocked by:** P0.3
- **Spec:** §4.1, §9.5, §13.1, §18.1 to §18.3
- **Files:** `specs/7-ocr-risk-model.md` (§4.1, §9.5, §13.1, §18), `applications/ocr-quality/config/llm-review-config-v2.json`
- **Provides:** measured cost, the chosen model and the profile predicate outcome
- **Acceptance:**
  - The maintainer runs P0.3 on both #91 captures and posts the printed counts, tokens, latencies and costs on the issue.
  - The chosen model is the first candidate that is invocable on demand in the Region, returns valid output in at least 11 of its 12 calls, agrees with the truth on all 128 stat cells and 16 gamertags in every valid call, and costs at most 0.15 USD per screenshot on average. With none, the issue records a no-go and Phases 2 to 4 are not filed.
  - The Bedrock on-demand price for the chosen model is taken from the Bedrock pricing page and compared with the computed cost of the calls.
  - §9.5 is updated with the measured values beside the estimate, §4.1 with the game variant outcome, and `llm-review-config-v2.json` with the chosen model, prices and request fields.

### Phase 1: Deterministic constraints

**Goal:** every profiled run is checked against the scoreboard constraints, and the results are spec 2 signals and features.
**Exit criteria:** `ScoreRun` in dev records constraint results and `features-v2` for every run, and the offline evaluation runs on the #91 captures.

#### P1.1 Profiles and constraint library (M)

- **Blocked by:** P0.1; spec 2 P2.1, spec 2 P0.3
- **Spec:** §4.1, §4.2, §4.4, §4.5, §4.7
- **Files:** `src/lib/constraints/{profiles,checks,reviewed-table}.ts`, `config/constraints-config-v1.json`
- **Provides:** `classifyProfile`, `evaluateConstraints` for `K001` to `K005`, `buildReviewedTable`, `checkReviewedTable`
- **Acceptance:**
  - The `constraints` and `profiles` rows of §16.1 pass for `K001` to `K005`, including every value in §4.4.
  - Every constraint is `PROVISIONAL` in `constraints-config-v1`.
  - The library performs no I/O.

#### P1.2 Constraint signals, results and features-v2 in scoring (M)

- **Blocked by:** P1.1; spec 2 P2.4, spec 2 P2.5, spec 2 P3.1
- **Spec:** §4.6, §5.4, §9.6
- **Files:** `src/lib/rules/constraints.ts`, `src/lib/{scoring,features}.ts`, `src/lambdas/score-run.ts`, `packages/contracts/src/index.ts`, `specs/2-ocr-quality.md`
- **Provides:** the `CONSTRAINT` group, constraint signals, `QualityResult.tables[].constraints`, `features-v2`
- **Acceptance:**
  - A failed hard constraint yields a `HIGH` signal and a soft one a `MEDIUM` signal, on the table and its involved cells; `NOT_EVALUATED` yields none.
  - The `features-v2` row of §16.1 passes, and `qualityVersion`, `rulesetVersion`, `scoringVersion` and `featureSchemaVersion` are bumped.
  - Spec 2's §5.4, §7, §8.4, §9.2 and §10.1 describe the change in the same PR.

#### P1.3 Offline constraint evaluation (S)

- **Blocked by:** P1.1
- **Spec:** §4.5, §14, §16.2
- **Files:** `applications/ocr-quality/scripts/evaluate-constraints.ts`, `applications/ocr-quality/TESTING.md`
- **Provides:** the evidence for promoting constraints
- **Acceptance:**
  - The script takes capture files and a truth file outside a Git working tree, refuses paths inside one, and prints per constraint and profile the counts of truth tables that pass, fail and are not evaluated, and the number of captures and sessions.
  - Its output contains no gamertag.
  - A test runs it on capture files built from the two #91 fixtures, with a synthetic game variant `LINE` and their `expectedRows` as truth, and it reports every `K001` to `K005` check passing.

#### P1.4 Page and submission agreement (M)

- **Blocked by:** P1.2, P1.5; spec 2 P3.2; spec 6 P0.2
- **Spec:** §4.2, §4.3, §9.6, §13.3, §13.4
- **Files:** `src/lib/constraints/peers.ts`, `src/lambdas/score-run.ts`, `cdk/lib/ocr-quality-stack.ts`, `specs/2-ocr-quality.md`
- **Provides:** `K006`, `K007`, the `GameIndex` table, `gameKey`
- **Acceptance:**
  - The `peers` row of §16.1 passes, and `K006` and `K007` record `NO_PEER` when no earlier peer exists.
  - `ScoreRun` writes one `GameIndex` item per profiled run and queries only its own `gameKey`.
  - `ocr-quality` depends on `@mcc/roster`, and spec 2 records the dependency and the new reads.

#### P1.5 Ephemeral permissions for ocr-quality tables and Bedrock (S)

- **Blocked by:** none
- **Spec:** §13.3, §13.4
- **Files:** `scripts/local-cdk-bootstrap.mjs` and its tests
- **Provides:** ephemeral `ocr-quality-e-*` stacks with `GameIndex` and `LlmReviewState` tables and the LLM reviewer's Bedrock and `LlmReviewWrite` calls
- **Acceptance:**
  - The local execution role can create, update and delete DynamoDB tables only when they are named `ocr-quality-e-*`.
  - The local workload boundary allows the table actions in §13.4 on `ocr-quality-e-*` tables, `bedrock:InvokeModel` on foundation models in the deployment Region and no inference profile, and `lambda:InvokeFunction` on `admin-e-*` functions.
  - Existing bootstrap tests pass, and new tests cover each added statement.

### Phase 2: LLM reviewer

**Goal:** every scored run is reviewed by the LLM, with spec 3 adjudications, escalations and holds.
**Exit criteria:** §17 criteria 1 to 7 and 12 hold in dev, and prod deploys with the reviewer enabled.

#### P2.1 Budget and hold state (S)

- **Blocked by:** P0.1
- **Spec:** §6.5, §13.3
- **Files:** `src/lib/llm-budget.ts`
- **Provides:** `estimateCost`, `reserve`, `settle`, `release`, `putHold`, `listHolds`
- **Acceptance:**
  - The `llm-budget` row of §16.1 passes.
  - A reservation that would exceed the ceiling is refused by the conditional update, never by a read followed by a write.

#### P2.2 Bedrock adapter and invoke Lambda (M)

- **Blocked by:** P0.2, P0.4, P2.1
- **Spec:** §5.2, §6.3, §6.6, §14
- **Files:** `src/lib/bedrock-reviewer.ts`, `src/lambdas/invoke-llm-reviewer.ts`
- **Provides:** `invokeLlmReviewer`, invocation evidence
- **Acceptance:**
  - The `invoke-llm-reviewer` row of §16.1 passes.
  - The request record is written before the call, and the invocation record holds the request with image references, the full response, usage and cost.
  - Each Bedrock exception in §6.6 maps to its error name; rejected calls are not retried.

#### P2.3 Prepare Lambda (M)

- **Blocked by:** P0.2, P1.1, P2.1
- **Spec:** §6.1, §6.2, §7.1 to §7.3
- **Files:** `src/lambdas/prepare-llm-review.ts`
- **Provides:** `prepareLlmReview`
- **Acceptance:**
  - The `prepare-llm-review` row of §16.1 passes, including `NO_REQUIRED_ITEMS` and `RUN_TOO_LARGE`.
  - The prompt mode follows the plan's display mode, and runs without a roster reference get no candidates.
  - Required items match spec 3 §7.1 on fixtures with an out-of-scope table.

#### P2.4 Apply Lambda and escalations (M)

- **Blocked by:** P1.1, P2.2, P2.3; spec 3 P3.5
- **Spec:** §6.4, §7.5, §7.6, §9.6
- **Files:** `src/lib/llm-escalation.ts`, `src/lambdas/apply-llm-review.ts`, `specs/3-cell-labeling.md`
- **Provides:** `applyLlmReview`, `decideEscalations`
- **Acceptance:**
  - The `llm-escalation` and `apply-llm-review` rows of §16.1 pass against a stubbed `LlmReviewWrite` that returns spec 3's codes.
  - Writes are ordered tables, rows, cells, then one escalation, and a replayed Apply writes nothing new.
  - Spec 3 lists the reason codes and the roster-candidates gap from §9.6 in the same PR.

#### P2.5 Workflow, trigger, schedules and IAM (M)

- **Blocked by:** P1.5, P2.2, P2.3, P2.4; spec 3 P3.4; spec 2 P3.2, spec 2 P1.1
- **Spec:** §3, §6.1, §6.5, §6.6, §13.3 to §13.5, §15
- **Files:** `cdk/lib/ocr-quality-stack.ts`, `src/lambdas/llm-review-maintenance.ts`, `specs/3-cell-labeling.md`, `applications/admin/cdk/lib/admin-stack.ts`
- **Provides:** the deployable LLM review workflow and the `LlmReviewWrite` ARN parameter
- **Acceptance:**
  - The `app.test.ts` and `llm-review-maintenance` rows of §16.1 pass for stable and ephemeral stacks.
  - The admin stack publishes the ARN parameter in §9.6, and spec 3 §13.3 records it.
  - The deploy preflight fails without the parameter, and the PR states that enabling Bedrock model access and checking invocation logging need a person (§13.5).

#### P2.6 Live validation, backfill and enablement (S)

- **Blocked by:** P2.5
- **Spec:** §6.1, §16.4, §17
- **Files:** `applications/ocr-quality/TESTING.md`
- **Provides:** the operator steps, and LLM review of runs enqueued before deployment
- **Acceptance:**
  - `TESTING.md` lists the §16.4 steps, and they pass in dev.
  - A `BACKFILL` in dev and prod reviews every plan without a claim.
  - Spec 3 P4.4 is unblocked.

### Phase 3: Audit and autonomy reporting

**Goal:** the autonomy rate and the error bounds are reported monthly, and failures alarm.
**Exit criteria:** a dev report exists for a full month with every §9.4 field, and the alarms in §15 exist in dev and prod.

#### P3.1 Audit bounds and autonomy report (M)

- **Blocked by:** P2.5; spec 3 P3.1
- **Spec:** §4.5, §9.1 to §9.4
- **Files:** `src/lib/{audit-bounds,adjudications}.ts`, `src/lambdas/report-autonomy.ts`, `cdk/lib/ocr-quality-stack.ts`
- **Provides:** `risk-autonomy-report/v1`, the monthly schedule
- **Acceptance:**
  - The `audit-bounds` and `report-autonomy` rows of §16.1 pass.
  - The report lists validated tables that fail a constraint, and recommends `SHRINK`, `HOLD` or `RESTORE` by §9.3.

#### P3.2 Metrics and alarms (S)

- **Blocked by:** P2.5, P3.1
- **Spec:** §15
- **Files:** `src/lib/metrics.ts`, `cdk/lib/ocr-quality-stack.ts`
- **Provides:** the metrics and alarms in §15
- **Acceptance:**
  - Stable stacks emit each metric with the `Stage` dimension only, and ephemeral stacks emit none.
  - Each alarm in §15 exists with its threshold, and a synthesis test checks them.

### Phase 4: Risk model in shadow

**Goal:** a calibrated cell risk model trained from labels and evaluated in production without routing.
**Exit criteria:** a model version runs in `SHADOW` in prod, and a `GATE` result exists for it.

#### P4.1 Training dataset builder (M)

- **Blocked by:** P1.2, P3.1; spec 2 P4.1
- **Spec:** §8.1, §8.2, §9.6
- **Files:** `src/lambdas/build-risk-dataset.ts`, `specs/2-ocr-quality.md`
- **Provides:** `risk-dataset/v1`
- **Acceptance:**
  - The `build-risk-dataset` row of §16.1 passes.
  - Spec 2 §8.5 records the `UNREADABLE` policy and `gameKey` grouping, and spec 2's P5.8 is unblocked.

#### P4.2 Training image (M)

- **Blocked by:** P4.1
- **Spec:** §8.2 to §8.5, §8.7, §16.3
- **Files:** `training/`, `.github/workflows/`, `scripts/ci-scope.mjs`, `cdk/lib/ocr-quality-stack.ts`
- **Provides:** `TrainRiskModel` with `TRAIN`, the export and parity rows
- **Acceptance:**
  - The `training/tests` row of §16.1 passes in CI on changes under `training/`.
  - Two `TRAIN` runs on the same dataset produce identical `model.json` bytes.
  - The model manifest records the dataset, configuration, seed, library versions and image digest.

#### P4.3 Exported-tree inference in ScoreRun (M)

- **Blocked by:** P4.2
- **Spec:** §8.7, §5.4, §9.6
- **Files:** `src/lib/risk-model.ts`, `src/lambdas/score-run.ts`, `config/risk-model-config-v1.json`, `specs/2-ocr-quality.md`
- **Provides:** `loadRiskModel`, `assessCell`, `SHADOW` mode
- **Acceptance:**
  - The `risk-model` row of §16.1 passes with the fixture model from P4.2's tests.
  - With `mode: OFF` no result changes; with `SHADOW` every cell has a `riskModel` assessment.
  - Spec 2 §5.4 and §9.6 record `riskModelConfigVersion` and the filled fields.

#### P4.4 Release gate (S)

- **Blocked by:** P4.2, P4.3
- **Spec:** §8.6, §9.1, §9.2
- **Files:** `training/src/risk_training/gate.py`
- **Provides:** `GATE` and `risk-gate/v1`
- **Acceptance:**
  - Each check in §8.6 passes and fails on seeded inputs, and the result is `PASS` only when all pass.
  - G5 uses only audit-file cells with human truth.

#### P4.5 Training workflow, schedule and first shadow model (S)

- **Blocked by:** P4.3, P4.4
- **Spec:** §3, §8.3, §13.3
- **Files:** `cdk/lib/ocr-quality-stack.ts`, `config/risk-model-config-v2.json`, `applications/ocr-quality/TESTING.md`
- **Provides:** `<stack>-risk-training`, the weekly schedule, the first `SHADOW` configuration
- **Acceptance:**
  - The workflow builds a dataset and trains a model in dev from real labels.
  - `risk-model-config-v2` puts the first model with `G1` met in `SHADOW` in dev and prod.
  - `TESTING.md` has the training, gate and promotion steps.

### Phase 5: Routing

**Goal:** well-read runs of validated profiles skip the LLM, with an audit of auto-accepted cells.
**Exit criteria:** a model in `ROUTING` in prod auto-finalizes runs, and the report includes `U_AUTO`.

#### P5.1 Validate the constraints (XS)

- **Blocked by:** P1.3, P1.4
- **Spec:** §4.5
- **Files:** `config/constraints-config-v2.json`, `specs/7-ocr-risk-model.md`
- **Provides:** `VALIDATED` constraints
- **Acceptance:**
  - The maintainer runs P1.3 on at least 30 captures from at least 5 sessions and posts the counts on the issue.
  - Only constraints with no failing correct table, and for `K006` and `K007` at least 10 pairs, become `VALIDATED`.

#### P5.2 Routing in ScoreRun and LLM item selection (M)

- **Blocked by:** P4.4, P5.1; spec 3 P5.2
- **Spec:** §8.8, §10.1, §9.6
- **Files:** `src/lambdas/{score-run,prepare-llm-review}.ts`, `src/lib/llm-prompt.ts`, `packages/contracts/src/index.ts`, `specs/2-ocr-quality.md`
- **Provides:** `QualityResult.routing`, selection reasons `MODEL_FLAGGED` and `CONSTRAINT_FAILED`
- **Acceptance:**
  - A fixture run that meets every routing condition gets `autoFinalize: true`, and one that fails any condition lists the reason and its selected items.
  - The LLM reviews only selected items, with their selection reasons.
  - `ROUTING` loads only with a `PASS` gate (§8.7).

#### P5.3 Auto-accepted audit in the report (S)

- **Blocked by:** P5.2
- **Spec:** §9.1, §9.2, §9.4
- **Files:** `src/lambdas/report-autonomy.ts`
- **Provides:** `U_AUTO` and its share in `U_ACCEPTED`
- **Acceptance:**
  - The report computes `U_AUTO` from audits of auto-accepted cells and includes it in `U_ACCEPTED`.
  - A report with `U_ACCEPTED` above the target has status `BOUND_EXCEEDED` and raises the alarm.

### Phase 6: Backlog (not filed with v1)

| ID | Slice | Size | Note |
| --- | --- | --- | --- |
| P6.1 | Escalate both runs on a `K007` disagreement | S | §18.10; needs a `NOT_CALLED` invocation record under the peer run's prefix. |
| P6.2 | A second `ASSISTED` call with the failing constraints after a rejected correction, before escalating | S | Fewer escalations; only for `PRIORITY_SHOWN` runs. |
| P6.3 | Profiles for Halo 3 free-for-all Slayer and other MCC titles | M | §18.9; each needs its own captures and P1.3 evidence. |
| P6.4 | Bedrock batch inference for `BACKFILL` and `REREVIEW` | S | Half the price for work that can wait. |
| P6.5 | Compare computed LLM cost with billed Bedrock cost in the report | S | §18.16. |
| P6.6 | Prompt caching of the system prompt and tool schema | XS | Saves input cost when reviews cluster within the cache lifetime. |
| P6.7 | SageMaker training jobs | M | Only when §8.9's trigger is met. |

### 20.4 Dependency order and parallel lanes

P0.1 can start once spec 2 P0.2 and spec 3 P0.2 merge, P0.2 and P0.3 follow it, and P1.5 can start at any time. P0.4 is the go or no-go for Phase 2 and needs only P0.3, so the cost is measured before anything is deployed. P1.1 runs beside P0.2 to P0.4, and P2.1 starts after the go decision. The LLM reviewer comes before the learned model: the critical path is P0.1 -> P0.2 -> P0.3 -> P0.4 -> P2.2 -> P2.4 -> P2.5 -> P2.6, gated by spec 3 P3.5 at P2.4 and spec 3 P3.4 at P2.5. Spec 3 P4.4 waits for P2.6. Phase 4 needs labels from Phase 2 running in prod and spec 2's baseline resolver, and Phase 5 needs months of audits (§8.6 G5), validated constraints and spec 3 P5.2. The first real feedback is P0.4, which measures the reviewer's cost and accuracy on the two real captures; the first autonomous runs are P2.6 in dev.
