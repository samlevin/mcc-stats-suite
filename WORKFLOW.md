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

Use GitHub's blocked-by relationships for ordering. A blocked issue stays Ready until its blocker merges. You may build on an unmerged blocker if its PR is open, ready for review, passing required checks, and approved by a reviewer. For a coding agent's PR, the pre-PR review that [AGENTS.md](AGENTS.md#repository-agent-workflows) describes counts as that approval. Base your branch on its pushed head and record that SHA in your claim. Anything that needs merged or deployed behavior stays blocked.

## Claiming work

Before changing code, assign yourself, move the issue to In progress, and post one comment with your approach, branch, likely files, and planned checks. If you stop before opening a PR, say so in a comment.

Without write access to the repository, you cannot assign yourself or change project status. Comment on the issue with your approach instead, and a maintainer will assign it and move it to In progress.

Keep decisions on the issue or PR. Newly found work that is out of scope becomes a new issue rather than a wider PR.

## Branch names

Name your branch `<login>/<issue>-<slug>`, with your GitHub login as the actor. `node scripts/branch-name.mjs <issue> --actor <login>` prints the name from the issue title:

- `<issue>` is the number of the leaf issue the PR closes, without `#`.
- `<slug>` is that issue's title in lowercase, with accents dropped and every run of other characters turned into `-`. "Part N" in the title becomes `partN`. The slug is cut to 40 characters at a word boundary, and is `issue` when the title has no ASCII letters or digits.
- When one leaf is split into stacked layers, layers after the first end in `-part-<n>`; add `--layer <n>` to print them. A branch stacked on another issue's PR uses its own issue's number and title.

For example, `octocat/48-generate-and-enforce-branch-names-from` is the first branch for #48, and `octocat/48-generate-and-enforce-branch-names-from-part-2` is its second stacked layer. Once a branch is pushed, keep its name, even if the issue title changes later. Nothing in CI checks branch names.

## Pull requests and review

Open your PR directly, and formal review happens on it. Coding agents follow extra review rules before they open one, which [AGENTS.md](AGENTS.md) describes.

The final PR for a leaf closes it with `Closes #N` and references its parent. Titles follow the Conventional Commits rules in [CONTRIBUTING.md](CONTRIBUTING.md). When the PR opens, automation moves each closing issue to In review, as [Automation](ISSUE_TRIAGE.md#automation) describes. If its run logs a skip for your issue, move the issue yourself. Issues reach Done on merge.

## Size and stacks

Past roughly 400 changed production lines against the immediate parent branch, split the PR into stacked layers. Tests, docs, generated files, and lockfiles don't count; executable infrastructure does. Early layers reference the issue and only the last one closes it. If the layers turn out to be independent outcomes, split the issue into sub-issues first.
