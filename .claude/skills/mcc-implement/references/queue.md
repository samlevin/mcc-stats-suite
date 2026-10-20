# MCC container queue

The main thread running mcc-implement follows this file for a container issue or epic, meaning any issue with native sub-issues, in `samlevin/mcc-stats-suite` and the [MCC delivery](https://github.com/users/samlevin/projects/1) project. The owner builds an explicit dependency queue and delivers its leaves itself, one at a time, each through [delivery.md](delivery.md). No separate orchestrator agent exists. Read `.agents/evidence.md` once before you start.

## Build the queue

1. Fetch the container's body and comments, every native sub-issue recursively (`gh api repos/samlevin/mcc-stats-suite/issues/<n>/sub_issues --paginate`), and each issue's native blocked-by edges (`/dependencies/blocked_by --paginate`). Read project fields with `gh api -X GET users/samlevin/projectsV2/1/items -f per_page=100 -f fields=<field IDs> --paginate`, with the field IDs from `/fields`; without `-X GET`, `-f` turns the call into a POST that adds an item. Read PRs with `gh api 'repos/samlevin/mcc-stats-suite/pulls?state=all' --paginate`, branches with `git ls-remote origin 'refs/heads/agent/*'`, and claims from each leaf's comments.
2. A nested issue with children is a container too: it gets no branch, no PR, and no acceptance criteria, and its own leaves join the queue. Record an inaccessible child as BLOCKED; never drop it silently.
3. Detect cycles in the blocked-by edges. Every leaf on a cycle is BLOCKED with the cycle named; leaves outside it still run.
4. Order the leaves so that every blocker comes before the leaves it blocks, breaking ties by issue number.
5. Give each leaf one state and record it in the queue ledger, a table you keep in the thread and return at the end:
   - `done`: closed, or its closing PR merged.
   - `in review`: an open PR already closes it. Record the PR and skip the leaf.
   - `owned elsewhere`: another agent or person claimed it and its claim was not released. Record the claim and skip the leaf.
   - `resume`: an earlier run of this delivery claimed it, and no PR exists yet. Only two cases qualify: the request says to resume that leaf, or the claim names a worktree that `git worktree list` shows in this checkout and that this delivery created. Reuse its pushed branch and keep that branch's name, under the rework and resume rule of the mcc-stack skill. Work in the old worktree when it still exists. When the request says to resume and the old worktree is gone, check out the existing branch in a new worktree instead of creating one with `-b`: `git worktree add <path> <branch>` when the local branch exists and no worktree has it checked out, or `git worktree add --track -b <branch> <path> origin/<branch>` when only the remote branch exists. Any other unreleased claim is `owned elsewhere`, including one whose worktree is missing here, because it may live on another machine or in the other tool. Ask the person before taking such a leaf over.
   - `waiting`: a blocker is unmet. A blocker counts as met when it is closed, or when its PR qualifies for stacking under the [Gate](delivery.md#gate) rules.
   - `ready`: no unmet blocker. It still has to pass the gate in [delivery.md](delivery.md) before you claim it.

## Deliver

Delivery is sequential by default. Take the first `ready` leaf, deliver it through [delivery.md](delivery.md), and record its result (an open PR or a recorded blocker) in the ledger before you start the next leaf. After each result, recompute the `waiting` leaves, because a new ready-for-review PR can let a dependent leaf stack on it. An L leaf, or one that fails the gate, gets planning or decomposition through the mcc-create-github-issue skill within the accepted scope, or a recorded blocker. Never create an epic implicitly, and never relax a gate.

When one leaf is large enough that its exploration would crowd out the rest of the queue, you may hand that leaf to one isolated mcc-implementer, as the mcc-implement skill describes, and wait for its result before you continue.

## Parallel exception

Leaves run at the same time only when all of these hold:

- The person explicitly asked for parallel delivery.
- Each leaf is `ready` and passes the gate.
- Each leaf is a substantial task, sized M, not a narrow edit.
- The container records independence groups, the record is valid under the rules in `.agents/issue-creation.md`, and the leaves sit in different groups. Never infer, form, extend, or merge groups yourself.
- The leaves' implementation notes name no overlapping files or shared contracts.

Then each concurrent leaf goes to its own isolated mcc-implementer, in its own worktree and branch, based on trunk or its own prerequisite and never on a leaf from another group. Each concurrent assignment carries an `Owned by other running leaves:` field: the issue numbers of the other leaves running at the same time, and the files and shared contracts their implementation notes name. At most one leaf per group runs at a time, and you deliver no other leaf yourself while they run. A leaf that no group names, including every leaf under a container without a valid record, runs alone. An implementer that finds it must change a file or shared contract that another running leaf owns returns BLOCKED, and you deliver that leaf after the other leaf's PR opens. When any condition fails, deliver sequentially and say why.

An Agent call blocks until it returns, so start the concurrent leaves by sending their Agent calls together in one message, then wait for all of them before you start another leaf in any of their groups.

## Report

Return READY FOR REVIEW or BLOCKED with one ledger row per leaf: issue, independence group or `none`, state, branch/base, PR URL(s), local checks, pre-PR approval base/head SHAs, stack id, project state as read, its settings lines, and blocker. Relay an isolated implementer's `Requested settings:` lines verbatim in its row. Add your own `Advisory policy:` line, and list acceptance criteria that still depend on merge, deploy, or human verification. No narrative.
