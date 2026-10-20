---
name: implement
description: "Deliver an {{label}} GitHub issue or rework an {{label}} PR in the current thread. Use for \"implement #N\", \"implement <issue URL>\", \"rework <PR URL>\", or \"deliver this epic\" in {{repository}}. The thread that invokes it owns the work: it creates the worktree, claims the issue, implements, runs the checks, gets the independent pre-PR review, runs stack operations through {{prefix}}stack, and opens the ready-for-review PR. A container runs as a sequential dependency queue in the same thread. One isolated {{prefix}}implementer is an explicit exception, never the default."
argument-hint: "<#N | issue URL | PR URL> [isolated] [parallel] [model <name>] [effort <level>] [reviewer ...]"
codex:
  display_name: "{{label}}: Implement"
  short_description: "Deliver an {{label}} issue or rework a PR in this thread"
  default_prompt: "Use ${{prefix}}implement to deliver this {{label}} issue."
---
# {{label}} implement

You are the delivery owner. You run the delivery in this thread: you create and own the worktree, claim the issue, implement, validate, get the independent pre-PR review, run stack operations, and open the PR. You spawn only the agents named below, and only for the reasons given.

## Resolve the target

1. Parse the target: `#N`, an issue URL, or a PR URL in `{{repository}}`. Another repository is BLOCKED here.
2. Parse the request for `isolated`, `parallel`, and overrides. `reviewer model <name>` and `reviewer effort <level>` apply to {{prefix}}code-reviewer. An unprefixed `model <name>` or `effort <level>`, or an `implementer` prefix, applies to an isolated {{prefix}}implementer when you spawn one. A partial override changes only the named setting. Overrides never modify `.agents/policy.json` or workstation configuration, and they end with this task.
3. Run `git fetch origin` (read-only on the human checkout) and record the `origin/main` SHA.
4. For an issue, read its title, body, state, and labels with `gh api repos/{{repository}}/issues/<N>`, and its native sub-issues with `gh api repos/{{repository}}/issues/<N>/sub_issues --paginate`. Any sub-issue means container; none means leaf. A PR URL means rework of that PR's branch.

## Pick the mode

| Target | Default mode | Procedure |
| --- | --- | --- |
| Leaf issue | inline in this thread | [references/delivery.md](references/delivery.md) |
| PR rework | inline in this thread | [references/delivery.md](references/delivery.md), including its Rework section |
| Container or epic | sequential dependency queue in this thread | [references/queue.md](references/queue.md) |

Read the procedure for the mode and follow it. It owns every gate, safety rule, and result field.

## Settings

This skill runs at the session model and effort in both tools; it cannot change them, and it spawns no agent to enforce a model choice. Resolve the advisory policy with `node scripts/agent-policy.mjs resolve --tool <tool> --capability implementation` (`<tool>` is `claude` or `codex`) and state it in your first message and your result as `Advisory policy: tool=<tool> capability=implementation model=<model> effort=<effort> (session settings apply)`. An unprefixed `model` or `effort` override for inline work cannot be applied by this skill: say so, and name the tool's own control for the session.

<!-- claude-only -->
In Claude Code, set the session with `/model`, or start it with `claude --model <model> --effort <effort>`. Leave `CLAUDE_CODE_EFFORT_LEVEL` unset when the policy effort should apply.
<!-- /claude-only -->
<!-- codex-only -->
In Codex, start the session with `codex -m <model> -c model_reasoning_effort=<effort>`.
<!-- /codex-only -->

Delegated roles keep their own policy: resolve each one with `node scripts/agent-policy.mjs resolve --tool <tool> --role <role>`, adding `--model` or `--effort` only for an override that targets it. If the resolver exits non-zero, stop and report its message verbatim; nothing substitutes another value.

## Isolated implementer exception

By default you deliver the work yourself. You may hand one leaf or one rework to one isolated {{prefix}}implementer when the request says `isolated`, or when you can name a concrete benefit, such as isolating exploration that would crowd this conversation. State the benefit or explicit request before dispatch. Task size alone does not justify delegation. The queue's parallel exception in [references/queue.md](references/queue.md) is the only case where more than one runs at a time. An isolated implementer never spawns another implementer, adds no dispatcher or orchestrator, and returns a compact result.

Resolve its settings with `--role implementer`, then send a bounded assignment: target URL, trunk `main` and the fresh `origin/main` SHA, the base to build on, acceptance criteria, accepted decisions, verified prerequisites and their SHAs, validation requirements, the project binding (project {{project.number}}, owner `{{project.owner}}`), for a leaf in the queue's parallel exception the `Owned by other running leaves:` field that [references/queue.md](references/queue.md) defines, the expected result fields from [references/delivery.md](references/delivery.md#result), and the `Policy:` line `Policy: tool=<tool> role=implementer model=<model> effort=<effort> (model: <source>, effort: <source>); handoff overrides: <reviewer overrides or none>`. Reference repository docs by path; do not paste them or this conversation.

<!-- claude-only -->
Use the Agent tool with `subagent_type: {{prefix}}implementer` and `model` and `effort` copied from the resolver output, so the dispatch never inherits the session defaults. The agent file sets `isolation: worktree`, so it starts in its own linked worktree. Continue the same agent with SendMessage for one concrete correction.
<!-- /claude-only -->
<!-- codex-only -->
Use `spawn_agent` with `agent_type`, `model`, and `reasoning_effort` copied from the resolver's `spawn` object and `fork_turns: "none"`, so the child gets only the assignment and none of this conversation. Always pass `model` and `reasoning_effort`: the repository agent files deliberately omit them, so an omitted value would silently fall back to the contributor's `[agents]` defaults or the session model, and the built-in guidance to leave `model` unset does not apply here. If `spawn_agent` reports an unknown `agent_type`, the project is not trusted in Codex yet; say so and stop (see `.agents/README.md`). Send one concrete correction to the same agent rather than spawning another.
<!-- /codex-only -->

Wait as `.agents/evidence.md` describes. Relay the implementer's READY FOR REVIEW or BLOCKED result verbatim, including every `Requested settings:` line, and record it before any dependent work.

## Report

Return the result that the procedure defines, with your `Advisory policy:` line and every `Requested settings:` line verbatim. Then list what still depends on merge, deploy, or human verification.
