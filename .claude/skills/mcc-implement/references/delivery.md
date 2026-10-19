# MCC leaf delivery

This file is the one source for delivering a leaf issue or reworking one of its PRs in `samlevin/mcc-stats-suite`. The delivery owner follows it: the main thread running mcc-implement by default, or an isolated mcc-implementer when the owner delegated the leaf. The owner creates and owns the worktree, claims the issue, implements it, runs the checks, gets the pre-PR review, runs stack operations, and opens the ready-for-review PR. No other agent does any of that for it. Run autonomously within the assignment; ask only for a material missing decision or authority.

Read `.agents/evidence.md` and `.agents/worktree-isolation.md` once before you start, and follow them throughout.

## Inputs

You start from the target (issue URL, or PR URL for rework), trunk `main`, and a fresh `origin/main` SHA. A request or handoff may also supply acceptance criteria, accepted decisions, verified prerequisites with their SHAs, the base to build on, validation requirements, and `reviewer` overrides. Reuse what was supplied. Retrieve only what is missing or may be stale, and stop with BLOCKED when you cannot establish the issue or its acceptance criteria.

## Read

- The loaded `AGENTS.md` may come from a stale checkout. When it may, read `git show origin/main:AGENTS.md` and follow that copy: its checks table, PR title rules, and hard rules.
- Read through REST what the inputs did not supply: `gh api repos/samlevin/mcc-stats-suite/issues/<N>` for the body, plus `/comments`, `/parent` (404 when there is none), `/dependencies/blocked_by`, and `/sub_issues`. An issue with native sub-issues is a container: follow [queue.md](queue.md) instead of this file, or return `BLOCKED: container` when you are an isolated implementer.
- Read the code you will change with its callers and tests. Read each file you will edit before you edit it, not just the lines around a search hit.
- Open `WORKFLOW.md`, `CONTRIBUTING.md`, or `TESTING.md` only when the loaded instructions lack a check command or rule you need, or when the task changes them. Read `.github/pull_request_template.md` when you open the PR.

## Gate

Before claiming, check for one logical outcome, testable acceptance criteria, a validation plan, satisfied dependencies, and size XS, S, or M. Metadata `Ready` alone does not pass the gate. Independent outcomes become native sub-issues through the mcc-create-github-issue skill and the original becomes a container; never invent scope or epics. You may build on an unmerged blocker only if its PR is open and ready for review, passes its checks, and has a pre-PR APPROVE: base your branch on its pushed head and record that SHA in the claim. Anything that needs merged, deployed, or applied-infrastructure behavior stays blocked; infrastructure that CI applies only from pull requests targeting `main` counts as unapplied until the blocker merges.

## Worktree

Run `git fetch origin`, then print the branch name with `node scripts/branch-name.mjs <issue> --actor agent` (add `--layer <n>` for layer 2 and up).

In the main thread, create the worktree from the checkout root with `git worktree add -b <branch> .claude/worktrees/<branch-slug> <base-SHA>`, where `<branch-slug>` is the branch name with `/` replaced by `-`. Run every later command from that worktree (change into it, or use absolute paths and `git -C <worktree>`), never in the human checkout. An isolated implementer starts in the linked worktree the Agent tool created under `.claude/worktrees/`: run `git switch -c <branch> <base-SHA>` there.

Run `npm ci` inside the worktree when the checks need Node dependencies. For rework, use a detached worktree at `origin/<branch>` instead (an isolated implementer that starts in a worktree runs `git switch --detach origin/<branch>` there) and push `HEAD:<branch>`.

## Claim

Check for existing claims, PRs, and branches first. Post one claim comment (agent, branch, worktree, approach, likely files, planned checks) with `gh api repos/samlevin/mcc-stats-suite/issues/<N>/comments -F body=@<file>`. Move the project item to In progress through REST: discover the Status field and option IDs with `gh api users/samlevin/projectsV2/1/fields`, find the item ID by paging `gh api -X GET users/samlevin/projectsV2/1/items -f per_page=100 --paginate` for the item whose `content.number` is the issue and whose `content.repository_url` ends in `/repos/samlevin/mcc-stats-suite`, then run `gh api -X PATCH users/samlevin/projectsV2/1/items/<item> --input <file>` with `{"fields":[{"id":<field>,"value":"<option>"}]}` in the file. In progress is the only project status you ever set.

## Build

Write code plus meaningful tests for changed behavior, and update the nearest docs for contract or operator changes. Docs and code comments describe the current state, never what changed or how a problem was fixed; that history goes in the PR body and commit message. A comment may keep prior context only to explain an established regression the code must not reintroduce.

While iterating, run only the focused tests for what you touched. Run the scope-appropriate local gates from the `AGENTS.md` checks table once before the first push and fix failures; after later fixes, rerun only the affected gates. Before the first push, and again after each rework before you push it, re-read each edited region of every file you edited, with enough surrounding text to check it, and for each edited canonical source of generated output, the same regions in one file generated from it. This read is for meaning, not to confirm that an edit applied: check that the unchanged text around each edit still holds, such as other lines that state the rule you changed, references to what you renamed or moved, and qualifiers a rewritten sentence dropped. Search for other statements of a changed rule and for the old names of anything you renamed or moved, so lines outside the edited regions get the same check. Never skip tests or weaken assertions; report pre-existing failures as such. If the same command or blocker fails twice without new evidence, stop and return BLOCKED instead of repeating it. Keep a terse log of commands, results, and the tested SHA.

## Stack

Split into stacked layers only when each layer is reviewable on its own; line count alone does not require a stack. Roughly 400 changed production lines against the immediate parent (tests, docs, generated files, and lockfiles excluded; infrastructure counts) is the point to consider one. Early layers reference the issue; only the final layer closes it. Infrastructure that CI applies only from pull requests targeting `main` is never a stacked layer unless no layer needs the apply before it is retargeted to `main`; say so in the PR body. Run every stack operation yourself with the mcc-stack skill, in the worktree you created: building or adopting layers, stacking on a prerequisite, linking PRs, cascading rebases, and syncing after a merge. Resolve semantic conflicts yourself.

Load it with the Skill tool (`mcc-stack`).

## Pre-PR review

This gate applies to the initial submission only. Commit, push, and confirm no PR exists for the branch (`gh api 'repos/samlevin/mcc-stats-suite/pulls?state=all&head=<owner>:<branch>'` returns none).

Independent review is required for changes across components, shared contracts, security boundaries, and other substantial behavior changes. It is always required, however small the diff, for changes to agent instructions (`.agents/`, `.claude/`, `.codex/`, `AGENTS.md`, and `scripts/agent-policy*`), `infrastructure/`, `.terrateam/`, `.github/workflows/`, CDK account or environment checks, or anything else that changes how prod or shared resources are planned, applied, locked, deployed, or gated. Outside those paths, a localized low-risk change, documentation, or a mechanical edit may skip it, and the PR body then says `Pre-PR review: skipped (<reason>)`.

Resolve the reviewer settings with `node scripts/agent-policy.mjs resolve --tool <tool> --role code-reviewer`, adding `--model` or `--effort` only for a `reviewer` override; if it exits non-zero, return BLOCKED with its message. Spawn a fresh mcc-code-reviewer with the resolved model and effort and a packet containing: repo, issue URL, acceptance criteria, accepted decisions, remote branch, immediate base SHA, pushed head SHA, your worktree path, `review_mode=pre_pr`, and its resolved `Policy:` line (`Policy: tool=<tool> role=code-reviewer model=<model> effort=<effort> (model: <source>, effort: <source>)`). Leave out your self-assessment; the reviewer reads the diff, the issue, and the callers itself.

Spawn with the Agent tool: `subagent_type` from the resolver's `spawn.subagent_type`, and pass its `model` and `effort` explicitly so the dispatch never inherits a session default.

You need APPROVE for that exact base/head pair. On REQUEST CHANGES: fix, rerun the affected gates, push, and re-review. The re-review packet adds the previous round's base and head SHAs and its findings, copied unedited from its report, so the reviewer confirms those fixes instead of starting over. After two rejected rounds, return BLOCKED with the open findings instead of looping. Any base/head change before the PR opens invalidates the approval. Never self-approve, and never review your own diff in place of the reviewer.

## PR

Only the delivery owner opens PRs. Load the mcc-plain-language skill, write the body to a file, and open the PR through REST: `gh api repos/samlevin/mcc-stats-suite/pulls -f title='<title>' -f head=<branch> -f base=<base branch> -F body=@<file>`. Give it a Conventional Commits title that has a component scope, the repository template, the immediate base, `Closes #N` on the final layer only, `Parent issue or epic: #P` when one exists, and validation evidence including the pre-PR approval base/head SHAs and the settings lines from your result. Open it ready for review, then link stacked PRs bottom-to-top with the mcc-stack skill. Leave the issue's status alone: repository automation moves it to In review when the PR opens, and if that automation skips or fails, you report the state you read instead of correcting it. Once a PR exists, never invoke mcc-code-reviewer for that branch again; rework goes through your checks plus formal review. Replies to review comments go on the PR.

## Rework

For a PR URL, read the PR's state, head and base, review comments, and the issue it closes, then work in a detached worktree at `origin/<branch>`. The existing claim stands; post no second claim and move no project status. Fix what the review asks within the issue's scope, rerun the affected gates, and re-read your edits as [Build](#build) describes. Push with `git push --force-with-lease=<branch>:<head you started from> origin HEAD:<branch>`, or a plain push when the history did not change, and stop when the lease rejects it. A stacked branch whose parent moved is rebased with the mcc-stack skill. The PR exists, so no pre-PR review runs; reply to review comments on the PR, and report the approval SHAs from the initial submission as historical.

## Never

Never: merge, enable auto-merge, set an issue's status to In review or Done, deploy, apply infrastructure, change repository or workstation settings, invoke mcc-security-reviewer, or wait for, poll, or rerun remote CI. Report CI status as-is and hand off. If you stop early, release the claim with a comment.

## Result

Return READY FOR REVIEW or BLOCKED: issue, branch, worktree, base and head SHAs, PR URL(s), stack id, check results, approval base/head SHAs (mark historical if rework moved the head), the issue's project state as read (not as corrected), your own settings line (`Advisory policy: ...` in the main thread, `Requested settings: Policy: <as dispatched>` in an isolated implementer), then one `Requested settings: Policy: <as sent>` line per mcc-code-reviewer spawn in spawn order, blocker. No narrative.
