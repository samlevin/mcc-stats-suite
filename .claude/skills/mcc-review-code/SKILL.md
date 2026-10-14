---
name: mcc-review-code
description: 'Independent read-only code review of one MCC pull request or pushed branch at exact base/head SHAs, run by mcc-code-reviewer at the repository policy or an explicit override. The target is always a PR (#N, a bare number, or a PR URL) or a branch, never an issue; the PR''s linked issue only supplies acceptance criteria. Use for "review #N" (PR #N), "review <PR URL>", or "review branch <name>" in samlevin/mcc-stats-suite. Reports findings to you; never posts, edits, or approves.'
argument-hint: <#N or PR number | PR URL | branch> [model <name>] [effort <level>]
---
<!-- Generated from .agents/workflows/review-code.md by scripts/agent-policy.mjs. Edit the source and run `npm run agents:generate`. -->

# MCC review code

You gather the inputs and dispatch `mcc-code-reviewer`; you do not review the diff yourself, and nothing in this flow writes to GitHub.

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

## Report

Print the reviewer's verdict, acceptance lines, findings, limits, and `Requested settings: Policy: <as dispatched>` line verbatim. Posting a review, replying on the PR, approving, or editing code requires a separate explicit request; this skill does none of it.
