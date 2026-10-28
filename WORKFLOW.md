# Work lifecycle

Every durable piece of work in MCC Stats Suite starts as a GitHub issue. Chats, branches, PRs, project cards, and specs add context but never replace the issue. Specs in `specs/` describe possible future systems; an issue picks work out of a spec and makes it actionable.

## Issues, containers, and epics

A leaf issue holds one logical feature, bug, or change, with acceptance criteria. When work has several independent outcomes, each one becomes a native sub-issue and the parent becomes a container. Containers can nest. They use What/Why/How instead of acceptance criteria and never get a branch or PR. Automation closes a container once all its children close.

An epic is a container someone explicitly asked for, usually tied to a milestone. Size alone never makes an epic. Use `Parent epic` for an immediate epic parent and `Parent issue` otherwise.

The issue owns the problem, scope, decisions, acceptance criteria, dependencies, and completion evidence. The [MCC delivery](https://github.com/users/samlevin/projects/1) project indexes issues and owns status, Priority, and Size. Don't use draft project items. [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) owns labels, severity, Priority, and Size.

## States

| Status | Meaning |
| --- | --- |
| Empty or Inbox | Needs triage. Don't implement it. |
| Ready | Metadata triaged. Set automatically once Priority, one severity, and Size are valid. |
| In progress | One owner has claimed it and started. |
| In review | A PR links the issue. |
| Done | Merged, checks passed, and the issue holds enough evidence to verify its acceptance criteria. |

Ready only means the metadata is complete. Before claiming, check that the issue is a leaf, has testable acceptance criteria and a validation plan, has its dependencies satisfied, and is size XS, S, or M. Plan L issues before anyone claims them.

## Dependencies

Use GitHub's blocked-by relationships for ordering. A blocked issue stays Ready until its blocker merges. You may build on an unmerged blocker if its PR is open, ready for review, passing required checks, and approved by a reviewer. A coding agent may build only on a blocker whose PR has an APPROVE from the pre-PR review that [AGENTS.md](AGENTS.md#repository-agent-workflows) describes; a formal GitHub approval alone does not count. Base your branch on its pushed head and record that SHA in your claim. Anything that needs merged or deployed behavior stays blocked.

## Claiming work

Before changing code, assign yourself, move the issue to In progress, and post one comment with your approach, branch, likely files, and planned checks. If you stop before opening a PR, say so in a comment.

Without write access to the repository, you cannot assign yourself or change project status. Comment on the issue with your approach instead, and a maintainer will assign it and move it to In progress.

Keep decisions on the issue or PR. Newly found work that is out of scope becomes a new issue rather than a wider PR.

Coding agents follow [Agent worktree isolation](.agents/worktree-isolation.md) for checkout ownership and setup.

## Branch names

Name your branch `<login>/<issue>-<slug>`, with your GitHub login as the actor. `npx agenticool-delivery branch-name <issue> --actor <login>` prints the name from the issue title:

- `<issue>` is the number of the leaf issue the PR closes, without `#`.
- `<slug>` is that issue's title in lowercase, with accents dropped and every run of other characters turned into `-`. "Part N" in the title becomes `partN`. The slug is cut to 40 characters at a word boundary, and is `issue` when the title has no ASCII letters or digits.
- When one leaf is split into stacked layers, layers after the first end in `-part-<n>`; add `--layer <n>` to print them. A branch stacked on another issue's PR uses its own issue's number and title.

Run `npx agenticool-delivery branch-name --help` for its options.

For example, `octocat/48-generate-and-enforce-branch-names-from` is the first branch for #48, and `octocat/48-generate-and-enforce-branch-names-from-part-2` is its second stacked layer. Once a branch is pushed, keep its name, even if the issue title changes later. Nothing in CI checks branch names.

## Pull requests and review

Open your PR directly, and formal review happens on it. Coding agents follow extra review rules before they open one, which [AGENTS.md](AGENTS.md) describes.

The final PR for a leaf closes it with `Closes #N` and references its parent. Titles follow the Conventional Commits rules in [CONTRIBUTING.md](CONTRIBUTING.md). When the PR opens, automation moves each closing issue to In review, as [Automation](#automation) describes. If its run logs a skip for your issue, move the issue yourself. Issues reach Done on merge.

## Size and stacks

Past roughly 400 changed production lines against the immediate parent branch, split the PR into stacked layers. Tests, docs, generated files, and lockfiles don't count; executable infrastructure does. Early layers reference the issue and only the last one closes it. If the layers turn out to be independent outcomes, split the issue into sub-issues first.

## Automation

Three workflows keep the project in step with the work.

The [project membership workflow](.github/workflows/tracker-project-membership.yml) adds every new issue to MCC delivery when it opens, however it was created, and then runs that issue's first triage. GitHub sometimes starts no run for an issue's `opened` event, so the hourly sweep described below adds any open issue that is missing from the project. An issue archived in the project counts as present. An `opened` run that hits the GraphQL rate limit logs a warning and succeeds, and the next sweep adds the issue. A membership sweep logs an issue it cannot add, continues with the rest, and fails at the end. Run a membership sweep alone by hand from this workflow in the Actions tab; a manual run is a dry run that lists the missing issues unless you clear `dry_run`. Pull requests are not added to the project. Adding an item that is already in the project changes nothing. It runs trusted default-branch code only and uses `MCC_PROJECT_TOKEN`.

The [issue states workflow](.github/workflows/tracker-issue-states.yml) uses deterministic GitHub API calls, with no model usage. It moves an open issue whose Status is empty or Inbox to Ready when Priority, exactly one supported severity, and Size are present. Other statuses are left alone by metadata triage. A sweep asks the project only for open issues whose Status is not Ready, In progress, In review, or Done, so it never reads items that cannot qualify. Ready means triaged; implementation still requires clear scope, acceptance criteria, validation, and satisfied dependencies.

It also removes conflicting standard labels and any `type:` label from issues labeled `epic`, preserving severity/package/area/risk metadata. It closes any container when all direct children are closed and updates its project status to Done. Nested completion rolls up in the same run. If an unfinished child appears, it reopens only containers carrying the automation's `automation: container-closed` marker and sets their status to Ready. Manually closed containers are left alone. An empty issue is never auto-closed. Closed children count as complete regardless of close reason; a cancelled child should have its scope removed or reassigned before closure.

An issue event reconciles only that issue: triage reads its own project item, and container reconciliation reads its sub-issue subtree and its ancestors. Reopening and closing an issue start a run. Adding or removing a label starts one only for a `severity:` label, `epic`, or `automation: container-closed`, or for any label on an issue labeled `epic`. Opening an issue and editing its title or body start no run. One hourly job in the issue states workflow runs three sweeps in order on one runner: it adds open issues missing from the project, triages every issue, and reconciles every container. It catches project field and hierarchy edits that lack an Actions trigger. Each sweep runs even when an earlier one failed, and the job fails at the end if any sweep failed. A manual run of the issue states workflow runs the same three sweeps and is a dry run unless you clear `dry_run`. Each run logs the GraphQL budget before and after. A sweep skips with a warning when fewer than 1,000 points remain. An issue event that hits the rate limit logs a warning and succeeds, because the next sweep repeats its work.

Right after a batch's metadata and relationships are complete, the filing skills run `npx agenticool-tracker triage --issue N` on each new issue and `npx agenticool-tracker containers --issue N` on each new top-level container. `containers --issue N` reconciles the named issue's container subtree and ancestors, never unrelated issues. Both commands default to dry-run; `--apply` writes. Actions uses `MCC_PROJECT_TOKEN`, a token with write access to the MCC delivery project. Creating or changing it requires explicit authorization. Local use relies on existing `gh` authentication. Do not print credentials or copy them during ordinary issue filing. Workflow activation requires publication on `main`; runtime field IDs are discovered. Concurrent human edits can race API writes, so avoid competing reconciliation sessions.

When a non-draft PR is opened, reopened, marked ready for review, or has its body edited, the [PR issue status workflow](.github/workflows/tracker-pr-issue-status.yml) moves open issues named by closing keywords to `In review`: from `In progress` for any author, and also from `Ready` for the owner and collaborators. It skips other statuses and ordinary issue mentions, and its run logs each skip with the reason. It runs separately from `tracker-pr-metadata.yml`, so a status lookup failure does not block PR metadata. Both workflows read linked issues from the PR body only, so an edit to the title or base branch starts no job in either. It also uses `MCC_PROJECT_TOKEN`.
