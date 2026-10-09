# Work lifecycle

GitHub Issues is the source of truth for planned work in MCC Stats Suite. Each durable unit of work has an issue before implementation starts. Prompts, chat transcripts, branches, pull requests, project cards, and specifications may add context, but none of them replaces the issue.

The repository uses two issue levels:

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

Use GitHub's blocked-by and blocking relationships for execution order. A blocked issue stays in `Ready`; do not move it to `In progress` while its blocker remains open.

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
