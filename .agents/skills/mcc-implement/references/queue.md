# MCC container queue

The main thread running mcc-implement follows this file for a container, single leaf, or PR rework in `samlevin/mcc-stats-suite`. It runs the queue script, dispatches one mcc-implementer per leaf sequentially, and records fixed results. No separate orchestrator agent exists. Read `.agents/evidence.md` once before starting.

## Build the queue

Run `node scripts/delivery-queue.mjs <issue>` and `--next`. The read-only script refetches recursive native sub-issues, blocked-by edges, project fields and items, PRs, `agent/*` branches, and claim comments over REST on every run. It caches field and option IDs only within that run. Detect cycles in the blocked-by edges and record inaccessible children as BLOCKED. Order blockers before dependents, with ties by issue number. A nested container has no delivery branch or PR; its leaves join the ledger.

The script prints one ledger line per leaf with state, effort, rule, evidence, reason, branch/head, PR, project state, size, and claim. Each line also has a `dispatch` JSON object: the exact base branch/SHA, dependency edges, prerequisite PR branches/SHAs and stacking eligibility, validated independence group, declared file/contract ownership, and compatible parallel candidates with their ownership. Use only those candidates for an explicitly requested parallel run; missing ownership notes or invalid groups keep delivery sequential. `Files:` uses backticked paths in Implementation notes; `Contracts:` or `Provides:` names comma-separated shared contracts, or `none`. A cross-repository child or blocker is explicitly BLOCKED before its number can be interpreted in this repository. Multiple unmerged prerequisite branches need a stacking decision. Its states follow these rules in order:

- `done`: closed, or its closing PR merged.
- `in review`: an open PR closes it. Record and skip it.
- `owned elsewhere`: an unreleased claim this delivery did not create. This includes a claim whose worktree is missing here, because it may live elsewhere. Ask the person before taking it over. `--next` reports the earliest owned leaf and its claim instead of skipping to later ready work.
- `resume`: explicitly requested with `--resume <issue>`, or the claim names this delivery's agent (`--actor <delivery-agent>`) and a worktree this delivery created that `git worktree list` shows here. Do not pass another delivery's identity. Reuse its pushed branch and keep its name under mcc-stack. Use the old worktree when it exists; if explicitly resuming after it disappeared, check out the existing branch with `git worktree add <path> <branch>`, or `git worktree add --track -b <branch> <path> origin/<branch>` when only the remote exists. Never create a replacement branch name. Any other claim is `owned elsewhere`.
- `waiting`: a blocker is unmet. Closed blockers count as met. An open blocker PR must be ready for review, pass checks, and carry exact-SHA pre-PR approval under [delivery.md](delivery.md#gate). Cycles and inaccessible dependencies stay BLOCKED.
- `ready`: no unmet blocker. The implementer still runs [delivery.md](delivery.md)'s gate before claiming.

`--next` selects a `resume` leaf before `ready` leaves. Claim records use `<!-- mcc-claim {"agent":"<delivery-agent>","branch":"<branch>","worktree":"<path>"} -->`; release uses the same agent with `"released":true`. Legacy claim comments are recognized too. Effort records follow the rubric and format in mcc-implement. Missing or nonqualifying decisions select medium; metadata never escalates effort. PRs record approval as `Pre-PR review: APPROVE; base=<full SHA>; head=<full SHA>`. Existing `Pre-PR review: APPROVE for base..head` records are also accepted, with optional Markdown around the pair. Passing checks with an absent or stale approval do not permit stacking.

## Deliver

Delivery is sequential by default. Dispatch the `--next` resume or ready leaf to one mcc-implementer, record its result before you start the next leaf, and rerun the script after each result and when resuming. An L leaf or failed gate gets planning or decomposition through mcc-create-github-issue within accepted scope, or a recorded blocker. Never invent epics or relax gates. An explicit `inline` small leaf or rework follows the exception in mcc-implement; it does not make a container inline.

The main thread reads only the ledger and fixed result fields during normal delivery. Limit it to the queue script, spawning, recording results, and assessing compact escalation requests against the rubric. Do not read source, diffs, or detailed review reports. Read blocker details only when needed to explain a person's decision. The implementer reads the issue, verifies prerequisites, handles review findings, and owns stack operations. A person's correction continues in that same implementer at its existing effort. Replacement and later escalation follow mcc-implement, preserving explicit constraints and existing retry and two-round limits.

## Parallel exception

Leaves run at the same time only when all of these hold:

- The person explicitly asked for parallel delivery.
- Each leaf is `ready` and passes the gate.
- Each leaf is a substantial task, sized M, not a narrow edit.
- The container records independence groups, the record is valid under the rules in `.agents/independence-groups.md`, and the leaves sit in different groups. Never infer, form, extend, or merge groups yourself.
- The leaves' implementation notes name no overlapping files or shared contracts.

Then each concurrent leaf goes to its own isolated mcc-implementer, in its own worktree and branch, based on trunk or its own prerequisite and never on a leaf from another group. Each concurrent assignment carries an `Owned by other running leaves:` field: the issue numbers of the other leaves running at the same time, and the files and shared contracts their implementation notes name. At most one leaf per group runs at a time, and you dispatch no other leaf while they run. A leaf that no group names, including every leaf under a container without a valid record, runs alone. An implementer that finds it must change a file or shared contract that another running leaf owns returns BLOCKED, and you deliver that leaf after the other leaf's PR opens. When any condition fails, deliver sequentially and say why.

`spawn_agent` returns at once, so spawn each concurrent leaf's implementer, then wait for their results with the agent tools before you start another leaf in any of their groups.

## Report

Return one fresh ledger row per leaf with the fixed result from [delivery.md](delivery.md#result), effort decision, and every `Requested settings:` line verbatim. Record results before advancing. Details belong in each PR body. No narrative.
