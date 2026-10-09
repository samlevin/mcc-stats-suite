# Work lifecycle

GitHub Issues is the source of truth for planned work in MCC Stats Suite. Each durable unit of work has an issue before implementation starts. Prompts, chat transcripts, branches, pull requests, project cards, and specifications may add context, but none of them replaces the issue.

The repository uses two kinds of work issue:

- An epic states a product or operator outcome that needs several independently verifiable changes. The epic is the parent issue.
- A task or bug is an executable unit that one agent can implement and one reviewer can verify. It is a sub-issue when it contributes to an epic.

Specifications describe possible future systems. An issue selects work from a specification and makes it actionable. Do not treat unchecked specification sections as backlog items.

## Issues and Projects have different jobs

Issues own the work record. Put the problem, accepted scope, decisions, acceptance criteria, dependencies, and completion evidence there. Parent and sub-issue relationships represent functional decomposition.

The [`MCC delivery`](https://github.com/users/samlevin/projects/1) GitHub Project is an index over those issues. It owns scheduling metadata and saved views. A project item must point to a repository issue or pull request. Do not use draft project items because agents cannot rely on them as durable, searchable work records. The repository issue forms add new work to this project for contributors who have project write access.

Milestones group work for a dated release or outcome. They do not represent epics. Labels classify type, area, and exceptional risk. Project fields represent workflow state, priority, and size.

## Workflow states

`Inbox` means the issue needs triage. Anyone may record an idea here. Do not implement it.

`Ready` means the issue has one outcome, testable acceptance criteria, a validation plan, known dependencies, and a size small enough for one pull request. A child issue also has its parent relationship set, unless it is explicitly standalone.

`In progress` means one assignee owns the issue and implementation has started. The assignee posts a short comment before changing code. That comment records the intended approach, likely files, and planned checks. This claim prevents two agents from taking the same task.

`In review` means a pull request links the issue and CI has started. New decisions and scope changes go on the issue or pull request. If review exposes missing requirements, move the issue back to `Ready` and update its acceptance criteria before resuming implementation.

`Done` means the change is merged, required checks pass, and the issue contains enough evidence to verify its acceptance criteria. Close child issues through their pull requests. Close an epic only after all required children are done and the epic-level acceptance criteria have been checked.

Use GitHub's blocked-by and blocking relationships for execution order. A blocked issue stays in `Ready` while its blocker remains open, unless the dependency can be satisfied by a reviewed implementation in the same native PR stack. That exception requires the blocker to have passing required checks, an independent pre-PR `APPROVE` at its initial submission, and an open PR ready for formal review. Base the dependent branch on the blocker's current pushed head and record the dependency and SHA in the claim. Later changes require renewed validation of affected branches. Keep the issue dependency open until merge. A dependency that requires deployment or merged behavior remains blocked.

## Priority and size

Priority describes urgency:

- `P0` requires immediate work because supported production behavior, security, or durable evidence is at risk.
- `P1` is the next committed work.
- `P2` is normal planned work.
- `P3` is useful but uncommitted.

Size limits the amount of work assigned to one task or bug:

- `XS` is a narrow change with one obvious verification path.
- `S` is a small change within one component.
- `M` may cross a few files or require a focused design decision.
- `L` needs decomposition before an agent claims it.

Epics do not need a size. Split an executable issue if it reaches `L`, has several independently useful outcomes, or cannot be reviewed as one coherent pull request.

For Codex delivery, approximately 400 changed production-code lines per PR is also a decomposition trigger. Count additions and deletions against the PR's immediate parent branch. Exclude tests, docs, generated files, lockfiles, and non-code artifacts; executable infrastructure definitions count as production code. Split into coherent layers with independently verifiable acceptance criteria. Record any justified small overage instead of making fragments that cannot be reviewed usefully.

When one assigned issue needs several PRs, retain it as the coordinating parent and create executable child issues for the layers before publishing them. Each PR closes its own child and references the original assignment and epic. Add native parent and dependency relationships and project metadata. Record this decomposition on the original issue; it remains open until all required layers merge and its acceptance criteria are verified.

## Agent protocol

An agent starts from the highest-priority unblocked task or bug in `Ready` that it is authorized to handle. The issue body and current comments are the task brief. Repository instructions and linked specifications remain binding. A dispatch prompt names the repository and issue number. It may narrow the assignment, but it does not redefine the issue or replace missing acceptance criteria.

Before editing, the agent:

1. checks for an active claim, then assigns itself or records its agent and session identity in a claim comment;
2. moves the issue to `In progress`;
3. checks that the working tree is safe to edit;
4. posts its approach and validation plan.

One dispatcher should allocate work when several agents share the same GitHub identity. GitHub assignment alone cannot distinguish those agents. The claim comment must name the agent, branch or worktree, intended files, and planned checks. An agent releases the claim in a comment if it stops before opening a pull request.

During implementation, the agent keeps durable decisions in the issue or pull request. It creates a new sub-issue for newly discovered work that is independently useful, outside scope, or too large for the current pull request. It does not silently widen the task.

The pull request must close one task or bug and may reference one parent epic. Its title follows the Conventional Commits rules in `CONTRIBUTING.md`. The author moves the issue to `In review`. After merge, the issue closes and moves to `Done`. Follow-up work remains open as separate issues.

Agents may investigate an `Inbox` item, but they may not implement it until a maintainer or authorized planning agent makes it `Ready`. Agents do not close epics merely because all known children are closed. They verify the epic acceptance criteria first.

## Codex delivery and review

An explicit issue or epic delivery invocation requests the full workflow through open PRs ready for formal review. It authorizes the agents to claim accepted work, update its project state, decompose its accepted scope, commit and push implementation branches, create PRs, and link them into native GitHub stacks. Honor narrower instructions in the dispatch prompt. Merges, auto-merge, deployments, infrastructure applies, and repository settings changes require separate authorization.

The `task-orchestrator` fetches the epic, all executable children, current comments, project metadata, and dependencies. It dispatches issues sequentially unless their requirements, contracts, and touched files are independent. Parallel implementers use separate worktrees and leave capacity for review and stack operations. The `issue-implementer` owns code, tests, checks, PR creation and descriptions, CI follow-up, and requested rework.

After initial implementation and passing local checks, the implementer pushes each candidate branch and confirms that its PR does not yet exist. It asks `code-reviewer` for a static review against the linked issue and exact immediate-base/head SHAs. The reviewer reads code, tests, diffs, and history, runs no tests, and never reads or interacts with PRs. It returns `APPROVE`, `REQUEST CHANGES`, or `BLOCKED`. The implementer resolves changes and repeats checks, push, and review until approval. A changed base or head before PR creation invalidates approval.

Only the implementer opens the PR after approval. For a stack, it opens each layer against its immediate parent, with the appropriate issue closing link and validation evidence. It delegates native linking to `stacked-pr-manager` using existing PR URLs. The stack manager uses the official `gh stack` extension for branch construction, cascading changes, native linking, and post-merge synchronization; it never creates PRs. Avoid `gh stack submit` and branch arguments to `gh stack link` because they can create PRs outside the implementer's gate.

Once a PR exists, the implementer owns rework, required checks, and responses to formal review. The pre-PR `code-reviewer` is not invoked for that branch again. New stack layers still need their own pre-PR gate. After a stack rebase, the implementer reruns checks for affected branches and records the new revisions; formal review governs existing PRs. Historical pre-PR approval is not approval of a later revision.

The `security-reviewer` runs only on an explicit human request for a pushed branch and returns `PASS`, `REQUEST CHANGES`, or `BLOCKED`. It is separate from automatic delivery.

Agent delivery completes when all required PRs are open and ready for review, required checks pass, and issue links and native stack relationships are verified. Record the PR URLs, current branch/base SHAs, validation evidence, and initial pre-PR approval SHAs at handoff. The issues remain `In review`; `Done` and epic closure still require merge and acceptance evidence.

## Triage checklist

During triage, a maintainer or planning agent:

1. confirms that the request belongs in this repository;
2. chooses `type: epic`, `type: task`, or `type: bug`;
3. sets one `area:` label;
4. adds parent and dependency relationships;
5. makes the acceptance criteria and validation plan testable;
6. sets priority and size in the project;
7. moves executable work to `Ready` only when another agent can act without guessing about product intent.

Reject duplicates and requests that conflict with the repository's data guarantees. Keep uncertain product choices in `Inbox` until the decision is recorded.
