# Work lifecycle

Every durable piece of work in MCC Stats Suite starts as a GitHub issue. Chats, branches, PRs, project cards, and specs add context but never replace the issue. Specs in `specs/` describe possible future systems; an issue picks work out of a spec and makes it actionable.

## Issues, containers, and epics

A leaf issue holds one logical feature, bug, or change, with acceptance criteria. When work has several independent outcomes, each one becomes a native sub-issue and the parent becomes a container. Containers can nest. They use What/Why/How instead of acceptance criteria and never get a branch or PR. Automation closes a container once all its children close.

An epic is a container someone explicitly asked for, usually tied to a milestone. Size alone never makes an epic. Use `Parent epic` for an immediate epic parent and `Parent issue` otherwise.

The issue owns the problem, scope, decisions, acceptance criteria, dependencies, and completion evidence. The [MCC delivery](https://github.com/users/samlevin/projects/1) project indexes issues and owns status, Priority, and Size. Don't use draft project items. [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) owns labels, severity, Priority, and Size.

## States

| Status | Meaning |
| --- | --- |
| Inbox | Needs triage. Don't implement it. |
| Ready | Metadata triaged. Set automatically once Priority, one severity, and Size are valid. |
| In progress | One owner has claimed it and started. |
| In review | A PR links the issue. |
| Done | Merged, checks passed, and the issue holds enough evidence to verify its acceptance criteria. |

Ready only means the metadata is complete. Before claiming, check that the issue is a leaf, has testable acceptance criteria and a validation plan, has its dependencies satisfied, and is size XS, S, or M. Plan L issues before anyone claims them.

## Dependencies

Use GitHub's blocked-by relationships for ordering. A blocked issue stays Ready until its blocker merges. You may build on an unmerged blocker if its PR is open, ready for review, passing required checks, and approved by the pre-PR review. Base your branch on its pushed head and record that SHA in your claim. Anything that needs merged or deployed behavior stays blocked.

## Claiming work

Before changing code, assign yourself, move the issue to In progress, and post one comment with your approach, branch, likely files, and planned checks. When several agents share one GitHub identity, the comment must also name the agent. If you stop before opening a PR, say so in a comment.

Keep decisions on the issue or PR. Newly found work that is out of scope becomes a new issue rather than a wider PR.

## Pull requests and review

Agents push the branch and get an `APPROVE` from `code-reviewer` before opening the PR. The reviewer reads the diff against the issue and the exact base and head SHAs, without running anything. Any change to the base or head before the PR opens means review again. Once the PR exists, formal review takes over.

The final PR for a leaf closes it with `Closes #N` and references its parent. Titles follow the Conventional Commits rules in [CONTRIBUTING.md](CONTRIBUTING.md). Move the issue to In review when the PR opens. Issues reach Done on merge, not when an agent hands off.

Security review by `security-reviewer` happens only when a person asks for it.

## Size and stacks

Past roughly 400 changed production lines against the immediate parent branch, split the PR into stacked layers. Tests, docs, generated files, and lockfiles don't count; executable infrastructure does. Early layers reference the issue and only the last one closes it. If the layers turn out to be independent outcomes, split the issue into sub-issues first.

An explicit delivery request lets agents claim issues, move project status, commit, push, open ready-for-review PRs, and link stacks. Merges, deploys, infrastructure applies, and settings changes always need separate approval.
