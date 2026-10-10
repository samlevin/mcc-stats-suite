# Work lifecycle

GitHub Issues is the source of truth for planned work in MCC Stats Suite. Each durable unit of work has an issue before implementation starts. Prompts, chat transcripts, branches, pull requests, project cards, and specifications may add context, but none of them replaces the issue.

An Issue records a logical change. Multiple independent outcomes become native Sub-issues. Any issue with children is a container and has no implementation branch or PR. Containers may be nested. A leaf has one logical feature, bug, or change.

An Epic is an explicitly requested, notable body of work, usually associated with a supplied milestone. Never infer an epic from size or multiple outcomes. Epics can contain ordinary issues with sub-issues and, when explicitly requested, other epics. Use `Parent epic` for an immediate epic parent and `Parent issue` otherwise.

Specifications describe possible future systems. An issue selects work from a specification and makes it actionable. Do not treat unchecked specification sections as backlog items.

## Issues and Projects have different jobs

Issues own the work record. Put the problem, accepted scope, decisions, acceptance criteria, dependencies, and completion evidence there. Parent and sub-issue relationships represent functional decomposition.

The [`MCC delivery`](https://github.com/users/samlevin/projects/1) GitHub Project is an index over those issues. It owns scheduling metadata and saved views. A project item must point to a repository issue or pull request. Do not use draft project items because agents cannot rely on them as durable, searchable work records. The repository issue forms add new work to this project for contributors who have project write access.

Milestones group work for a dated release or outcome and may be referenced by epics. Labels identify explicitly requested epics, severity, standard categories, directly affected packages, repository/infrastructure areas, and exceptional risk. [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) owns the classification matrices and required metadata for every published issue, including epics. Project fields represent workflow state, priority, and size.

## Workflow states

`Inbox` means the issue needs triage. Anyone may record an idea here. Do not implement it.

`Ready` means metadata triaged. An open repository issue in MCC delivery moves from Inbox to Ready when it has valid Priority, exactly one supported severity, and valid Size. Acceptance criteria and an executable size threshold are separate implementation checks. Containers can be Ready but cannot be implemented directly. L leaves need planning before claim. See [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) for the exact automation predicate.

`In progress` means one assignee owns the issue and implementation has started. The assignee posts a short comment before changing code. That comment records the intended approach, likely files, and planned checks. This claim prevents two agents from taking the same task.

`In review` means a pull request links the issue and CI has started. New decisions and scope changes go on the issue or pull request. If review exposes missing requirements, update the issue acceptance criteria and resolve them before resuming implementation. Metadata reconciliation leaves later statuses alone.

`Done` means the change is merged, required checks pass, and the issue contains enough evidence to verify its acceptance criteria. Close leaf issues through their pull requests. Automation closes any container when all direct children are closed and rolls completion up through ancestors. Containers have no acceptance criteria; executable leaves own acceptance criteria and any integration or verification work. Deployment is independent; an epic need not deploy at once.

Use GitHub's blocked-by and blocking relationships for execution order. A blocked issue stays in `Ready` while its blocker remains open, unless the dependency can be satisfied by a reviewed implementation in the same native PR stack. That exception requires the blocker to have passing required checks, an independent pre-PR `APPROVE` at its initial submission, and an open PR ready for formal review. Base the dependent branch on the blocker's current pushed head and record the dependency and SHA in the claim. Later changes require renewed validation of affected branches. Keep the issue dependency open until merge. A dependency that requires deployment or merged behavior remains blocked.

## Priority and size

Use the short [severity, priority, and size matrices](ISSUE_TRIAGE.md). Default Priority is P2. Logical boundaries determine sub-issues; size alone never creates an epic. Plan L leaves before claim. Use stacks mainly to split M or larger individual leaf issues into reviewable layers, keeping one accepted outcome.

Approximately 400 changed production-code lines per PR remains a review-size trigger. Count additions and deletions against the immediate parent branch. Exclude tests, docs, generated files, lockfiles, and non-code artifacts; executable infrastructure counts. Record justified small overages rather than meaningless fragments. A leaf can have multiple stacked PRs: early layers reference the issue; only the final required layer closes it. If the layers actually have independent outcomes, create native sub-issues and make the original issue a container before implementation. Containers never receive branches or PRs.

## Creation planning

Well-scoped requests need little planning. Broad requests require enough planning to establish logical boundaries, acceptance criteria, and dependencies; clarify only material unknowns. A create-issue request covering multiple logical changes authorizes sub-issues within that scope. Epic creation must be explicit. Creating an explicitly scoped epic alone does not authorize inventing an entire backlog.

Create parents first, then children, then native blocked-by relationships without cycles. Record prerequisite direction in GitHub, not just body links. Assign a supplied milestone where appropriate. Discover common project/label metadata once per batch. Each issue receives one short independent triager assessment; the description supplies context rather than a separate label-evidence report.

## Agent protocol

An agent starts from the highest-priority unblocked task or bug in `Ready` that it is authorized to handle. The issue body and current comments are the task brief. Repository instructions and linked specifications remain binding. A dispatch prompt names the repository and issue number. It may narrow the assignment, but it does not redefine the issue or replace missing acceptance criteria.

Before claiming, the agent verifies executable scope, testable acceptance criteria, a validation plan, accepted decisions, dependencies, the native parent relationship or explicit standalone status, and Size XS/S/M. Metadata readiness alone does not satisfy this gate. Resolve missing details before claiming. On `implement #number`, inspect its native children: route containers to the orchestrator and implement only leaves. A blocked prerequisite may need merge or deployment even when its PR is ready.

Before editing, the agent:

1. checks for an active claim, then assigns itself or records its agent and session identity in a claim comment;
2. moves the issue to `In progress`;
3. checks that the working tree is safe to edit;
4. posts its approach and validation plan.

One dispatcher should allocate work when several agents share the same GitHub identity. GitHub assignment alone cannot distinguish those agents. The claim comment must name the agent, branch or worktree, intended files, and planned checks. An agent releases the claim in a comment if it stops before opening a pull request.

During implementation, the agent keeps durable decisions in the issue or pull request. It creates a new sub-issue for newly discovered work that is independently useful, outside scope, or too large for the current pull request. It does not silently widen the task.

The final required pull request closes its executable leaf issue and references its immediate parent issue or epic. Earlier stack layers reference the leaf without closing it. No PR closes a container. Its title follows the Conventional Commits rules in `CONTRIBUTING.md`. The author moves the issue to `In review`. After merge, the issue closes and moves to `Done`. Follow-up work remains open as separate issues.

Agents may investigate an `Inbox` item, but they may not implement it until it is `Ready` and the separate implementation gate is satisfied within the authorized scope. Container bodies use What, Why, and How without acceptance criteria. Deliverable leaves retain the existing issue template and acceptance criteria. The deterministic automation owns container completion after native children close.

## Codex delivery and review

An explicit issue or epic delivery invocation requests the full workflow through open PRs ready for formal review. It authorizes the agents to claim accepted work, update its project state, decompose its accepted scope, commit and push implementation branches, create PRs, and link them into native GitHub stacks. Honor narrower instructions in the dispatch prompt. Merges, auto-merge, deployments, infrastructure applies, and repository settings changes require separate authorization.

The `task-orchestrator` fetches the assigned container, recursively nested native children, current comments, project metadata, and blocking dependencies. It dispatches only executable leaves and never creates a branch or PR for a container. It dispatches issues sequentially unless their requirements, contracts, and touched files are independent. Parallel implementers use separate worktrees and leave capacity for review and stack operations. The `issue-implementer` owns code, tests, checks, PR creation and descriptions, CI follow-up, and requested rework.

After initial implementation and passing local checks, the implementer pushes each candidate branch and confirms that its PR does not yet exist. It asks `code-reviewer` for a static review against the linked issue and exact immediate-base/head SHAs. The reviewer reads code, tests, diffs, and history, runs no tests, and never reads or interacts with PRs. It returns `APPROVE`, `REQUEST CHANGES`, or `BLOCKED`. The implementer resolves changes and repeats checks, push, and review until approval. A changed base or head before PR creation invalidates approval.

Only the implementer opens the PR after approval. For a stack, it opens each layer against its immediate parent, with the appropriate issue closing link and validation evidence. It delegates native linking to `stacked-pr-manager` using existing PR URLs. The stack manager uses the official `gh stack` extension for branch construction, cascading changes, native linking, and post-merge synchronization; it never creates PRs. Avoid `gh stack submit` and branch arguments to `gh stack link` because they can create PRs outside the implementer's gate.

Once a PR exists, the implementer owns rework, required checks, and responses to formal review. The pre-PR `code-reviewer` is not invoked for that branch again. New stack layers still need their own pre-PR gate. After a stack rebase, the implementer reruns checks for affected branches and records the new revisions; formal review governs existing PRs. Historical pre-PR approval is not approval of a later revision.

The `security-reviewer` runs only on an explicit human request for a pushed branch and returns `PASS`, `REQUEST CHANGES`, or `BLOCKED`. It is separate from automatic delivery.

Agent delivery completes when all required PRs are open and ready for review, required checks pass, and issue links and native stack relationships are verified. Record the PR URLs, current branch/base SHAs, validation evidence, and initial pre-PR approval SHAs at handoff. The issues remain `In review`; `Done` follows leaf closure and container rollup, rather than agent handoff. Releases can proceed independently.

## Triage checklist

Confirm scope and existing work; plan only missing boundaries. Set Priority, Size, one severity and useful labels using [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md). Create native parents and blocking dependencies, then reconcile metadata and verify publication. Drafts never write. Keep uncertainty in the issue rather than inventing facts. Claim readiness remains separate from metadata Ready.
