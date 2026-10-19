---
name: mcc-implement
description: 'Deliver an MCC GitHub issue or rework an MCC PR with the repository''s namespaced agents. Use for "implement #N", "implement <issue URL>", "rework <PR URL>", or "deliver this epic" in samlevin/mcc-stats-suite. Routes a container to mcc-orchestrator (dependency order, concurrent only across recorded independence groups) and a leaf or PR to mcc-implementer, applying the repository model/effort policy or an explicit prompt override.'
argument-hint: <#N | issue URL | PR URL> [model <name>] [effort <level>] [reviewer|stack ...]
---
<!-- Generated from .agents/workflows/implement.md by scripts/agent-policy.mjs. Edit the source and run `npm run agents:generate`. -->

# MCC implement

You are the dispatcher. You never implement, review, or fix code yourself in this flow; the namespaced agents do. You dispatch one agent per request.

Read and follow `.agents/evidence-and-waiting.md` before gathering evidence or waiting for another agent. Its per-result and combined output budgets, read reuse, truncation recovery, and idle coordination rules apply throughout this workflow.

## Resolve the target

1. Parse the target: `#N`, an issue URL, or a PR URL in `samlevin/mcc-stats-suite`. Another repository is BLOCKED here.
2. Parse overrides from the request. `model <name>` and `effort <level>` apply to the role this skill dispatches. A role prefix targets a handoff instead: `reviewer model opus`, `reviewer effort max`, `implementer effort xhigh` (for a container), `stack model sonnet`. A partial override changes only the named setting; the other stays at the repository policy. Overrides never modify `.agents/policy.json` or workstation configuration, and they end with this task.
3. `git fetch origin` (read-only on the human checkout) and record the `origin/main` SHA.
4. For an issue, read its title, body, state, and labels with `gh api repos/samlevin/mcc-stats-suite/issues/<N>`, its native sub-issues with `gh api repos/samlevin/mcc-stats-suite/issues/<N>/sub_issues --paginate`, and its project item by paging `gh api -X GET users/samlevin/projectsV2/1/items -f per_page=100 --paginate` for the item whose `content.number` is N and whose `content.repository_url` ends in `/repos/samlevin/mcc-stats-suite`. Any sub-issue means container; none means leaf. A PR URL means rework of that PR's branch.

## Route and resolve the policy

| Target | Role | Resolver |
| --- | --- | --- |
| Container or epic | `mcc-orchestrator` | `node scripts/agent-policy.mjs resolve --tool <tool> --role orchestrator` |
| Leaf issue or PR rework | `mcc-implementer` | `node scripts/agent-policy.mjs resolve --tool <tool> --role implementer` |

Run the resolver with `--model` or `--effort` only for an override that targets that role (`<tool>` is `claude` or `codex`). It prints JSON with the final `model`, `effort`, their `source`, and a `spawn` object. If it exits non-zero, stop and report its message verbatim; it refuses models and efforts the repository does not list, and nothing substitutes another value. Compose the `Policy:` line: `Policy: tool=<tool> role=<role> model=<model> effort=<effort> (model: <source>, effort: <source>); handoff overrides: <role-prefixed overrides or none>`.

## Dispatch one agent

Send a compact packet: target URL, trunk `main` and the fresh `origin/main` SHA, accepted decisions from the request and issue comments, validation requirements, the project binding (project 1, owner `samlevin`), and the `Policy:` line. Reference repository docs by path; do not paste them. Pre-PR review happens inside the implementer; it needs no instruction from you.

Use the Agent tool with `subagent_type` set to the role name and `model` and `effort` copied from the resolver output, so the dispatch never inherits the session defaults. Wait for the result; do not spawn a second agent while one is running. Continue the same agent with SendMessage for one concrete correction.

Never: merge, enable auto-merge, deploy, apply infrastructure, change settings, invoke mcc-security-reviewer, mark issues Done, or wait for or poll remote CI.

## Report

Relay the agent's READY FOR REVIEW or BLOCKED result verbatim, including every `Requested settings:` line. Then list what still depends on merge, deploy, or human verification.
