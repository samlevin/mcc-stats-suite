---
name: mcc-review-code
description: 'Independent code review of one MCC pull request or pushed branch at exact base/head SHAs, run by the read-only mcc-code-reviewer at the repository policy or an explicit override. The target is always a PR (#N, a bare number, or a PR URL) or a branch, never an issue; the PR''s linked issue only supplies acceptance criteria. Use for "review #N" (PR #N), "review <PR URL>", or "review branch <name>" in samlevin/mcc-stats-suite. Reports findings to you and posts them to the PR as one review: a change request only for a REQUEST CHANGES verdict from a GitHub account other than the PR author, otherwise a comment. Never edits or approves.'
argument-hint: <#N or PR number | PR URL | branch> [model <name>] [effort <level>]
---
<!-- Generated from .agents/workflows/review-code.md by scripts/agent-policy.mjs. Edit the source and run `npm run agents:generate`. -->

# MCC review code

You gather the inputs and dispatch `mcc-code-reviewer`; you do not review the diff yourself. The reviewer stays read-only. Your only GitHub write is the one review that [Publish](#publish) posts to a target pull request after the reviewer returns. A branch review writes nothing.

## Gather

1. Resolve the review target in `samlevin/mcc-stats-suite`. The target is a pull request or a pushed branch, never an issue.
   - `#N`, a bare number `N`, or a PR URL always names pull request N. Run `gh pr view N --json number,state,headRefName,headRefOid,baseRefName,baseRefOid,closingIssuesReferences,url`. Open, merged, and closed PRs are all valid targets; review the reported head against the reported base.
   - If `gh pr view N` fails, stop and report that no pull request #N exists in the repository. Do not treat N as an issue number, and do not search for pull requests linked to issue N.
   - A branch name resolves with `git ls-remote origin <branch>` for the head; the base is the merge base with `origin/main` unless the request names one.
2. Fetch on the human checkout (read-only; fetching does not change a checkout) so the objects exist locally: `git fetch origin pull/N/head <base branch>` for a PR, which still works after a merged or closed PR's branch is deleted, or `git fetch origin <branch>` for a branch. The reviewer reads through `git diff` and `git show` in that worktree path.
3. Take the acceptance criteria from the issue the PR closes, found in `closingIssuesReferences` (`gh issue view <issue> --json body,comments`). That issue only supplies criteria; it never changes the review target. For a branch, or a PR that closes no issue, use the request text as the criteria and say so in the packet.
4. Parse overrides: `model <name>` and `effort <level>` apply to the reviewer. A partial override changes only the named setting.

## Dispatch

Run `node scripts/agent-policy.mjs resolve --tool <tool> --role code-reviewer`, adding `--model` or `--effort` only for an override. If it exits non-zero, stop and report its message verbatim. Compose `Policy: tool=<tool> role=code-reviewer model=<model> effort=<effort> (model: <source>, effort: <source>)`.

Packet: `review_mode=requested`, repo, PR URL (for a PR target), issue URL (or `none` when the criteria come from the request), acceptance criteria, remote branch, base SHA, head SHA, the worktree path, and the `Policy:` line. Leave out your own opinion of the change.

Use the Agent tool with `subagent_type: mcc-code-reviewer` and the resolver's `model` and `effort` passed explicitly.

## Publish

For a pull request target, publish every verdict, whoever opened the PR. For a branch target, skip this section.

1. Write the reviewer's complete output, unedited, to a temporary file outside the repository.
2. Run `node scripts/agent-policy.mjs publish-review --pr <N> --base <base SHA> --head <head SHA> --report <file>` with the full SHAs from the packet. It is the only way this skill posts. It posts nothing when the report has no `Base/Head:` pair or names a different one, and it reads the pull request again and posts nothing when either SHA has moved, because the review is valid only for the commits it read. It compares the login from `gh api user` with the login of the PR creator, so agent names and models that share one GitHub account count as one identity. It submits one review pinned to the reviewed head commit with the `REQUEST_CHANGES` event only for a `REQUEST CHANGES` verdict from a different account, and with the `COMMENT` event in every other case. The posted body carries the verdict, acceptance lines, findings, limits, base/head SHAs, and a note when the event differs from the verdict: a shared account, an unknown identity, or an `APPROVE` verdict, which is never submitted as an approval.
3. Exit 0 prints the posted review's `url` and `event`. Any other exit posted nothing: report what it printed, normally `Review not posted: <reason>`, as the reason. When the SHAs moved, say that a fresh review is needed for the new commits. Never retry with another event, post the feedback another way, or say a review was posted without the printed `url`.

## Report

Print the reviewer's verdict, acceptance lines, findings, limits, and `Requested settings: Policy: <as dispatched>` line verbatim, whether or not publication succeeded. For a pull request, then print `Posted: <event> <url>` or `Not posted: <reason>` from the publish step. For a branch, print `Posted: none (branch review)`. Replying on the PR, approving, or editing code requires a separate explicit request; this skill does none of it.
