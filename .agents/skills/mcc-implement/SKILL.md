---
name: mcc-implement
description: "Deliver an MCC GitHub issue or rework an MCC PR through an isolated mcc-implementer by default. Use for \"implement #N\", \"implement <issue URL>\", \"rework <PR URL>\", or \"deliver this epic\" in samlevin/mcc-stats-suite. The main thread runs the queue script, dispatches one leaf at a time, and records fixed results. An explicit inline keyword keeps a small leaf or rework in the main thread."
---
<!-- Generated from .agents/workflows/implement.md by scripts/agent-policy.mjs. Edit the source and run `npm run agents:generate`. -->

# MCC implement

You are the dispatcher in this thread. The mcc-implementer is the delivery owner: it creates and owns the worktree, claims the issue, implements, validates, handles its review findings, runs mcc-stack, and opens the ready-for-review PR. No separate orchestrator agent exists.

## Resolve the target

1. Parse `#N`, an issue URL, or a PR URL in `samlevin/mcc-stats-suite`. Another repository is BLOCKED here. For a PR, read its number, branch, base/head, and closing issue through REST; the implementer reads the review findings. For an explicit PR rework, dispatch that PR using its closing leaf ledger row even when it says `in review`; do not select a different leaf with `--next`.
2. Parse `inline`, `parallel`, and overrides. `reviewer model <name>` and `reviewer effort <level>` target only mcc-code-reviewer. Unprefixed `model <name>` or `effort <level>`, and `implementer` prefixes, target only mcc-implementer. Preserve explicit constraints in every continuation and recovery handoff. Overrides never change files or workstation settings.
3. Run `git fetch origin` and record the fresh `origin/main` SHA. Read the current queue procedure from trunk if the checkout may be stale.
4. Run `node scripts/delivery-queue.mjs <issue>` and `--next`. It accepts a single leaf or container and reads native children, dependencies, claims, branches, PRs, and project metadata through REST. It refetches on every run. For an explicit resume pass `--resume <issue>`; pass `--actor <delivery-agent>` only for claims and registered worktrees this delivery created.

## Pick the mode

| Target | Default mode | Procedure |
| --- | --- | --- |
| Leaf issue | isolated mcc-implementer | [references/delivery.md](references/delivery.md) |
| PR rework | isolated mcc-implementer | [references/delivery.md](references/delivery.md), Rework section |
| Container or epic | sequential dependency queue in this thread | [references/queue.md](references/queue.md) |

In isolated and queue mode the main thread reads the queue ledger and fixed result fields only. Limit work to running the queue script, spawning, recording results, and assessing compact escalation requests against the rubric. Do not read source or diffs, perform implementation exploration, or read detailed review reports during normal delivery. When BLOCKED or a decision is needed, read only the detail needed to explain the blocker and ask the person. The implementer reads its own issue for acceptance criteria and accepted decisions and owns the delivery gate.

The explicit `inline` keyword keeps a small leaf or PR rework here through [references/delivery.md](references/delivery.md). It does not make a container inline. Inline work runs at the session settings, which this skill cannot change, and reports `Advisory policy: tool=<tool> capability=implementation model=<model> effort=<effort> (session settings apply)`. Resolve that advisory value with `node scripts/agent-policy.mjs resolve --tool <tool> --capability implementation`. Say when a requested override cannot change the inline runtime.

## Settings

Most leaves use medium because tickets and specs supply acceptance criteria, boundaries, decisions, and validation. A clear plan spanning several files still uses medium. `.agents/policy.json` owns the medium-first effort rubric and stable IDs `H1-boundary`, `H2-coupled-design`, and `H3-demonstrated-limit`. Labels and Size flag candidates for assessment but never choose high. Risk, severity, area, infrastructure, shared packages, Size L, file count, multiple consumers, and unfamiliar code do not independently justify high.

Assess in order: reuse ticket/spec decisions; identify a concrete unresolved correctness question; inspect only relevant evidence if needed; check whether an existing pattern, focused test, or smaller reviewable step resolves it; then apply the rubric. Do not investigate broadly merely to choose effort. Missing acceptance criteria, product decisions, credentials, prerequisites, or reproducible evidence are blockers, never reasons to increase effort. When no rule is established, choose medium. Automatic escalation stops at high.

- `H1-boundary`: design or prove a new security, immutable-evidence, persistent-data, or compatibility guarantee across components, with its mechanism unresolved by the ticket/spec. Name the guarantee and concrete failure scenario. Applying an established specified pattern does not qualify.
- `H2-coupled-design`: an algorithm, state machine, concurrency protocol, or migration has interacting correctness constraints unresolved by the supplied design. Name the competing constraints and why existing patterns, focused tests, and reviewable decomposition do not resolve them.
- `H3-demonstrated-limit`: a medium attempt produced a reproducible correctness failure or substantive review finding requiring an underlying design revision. Cite the case or finding, attempted approach, and unresolved reasoning problem. Routine tests, formatting, environment failures, a first unsuccessful attempt, and review counts do not qualify. Existing retry and two-round review limits still apply.

An explicit `effort <level>` or `implementer effort <level>` overrides the rubric for this task. Explicit medium prevents automatic escalation. If that prevents delivery, return the concrete blocker. Reviewer settings remain independent.

Resolve each role separately with `node scripts/agent-policy.mjs resolve --tool <tool> --role <role>` (`<tool>` is `claude` or `codex`), adding `--model` or `--effort` only for a role's explicit override or qualifying automatic high decision. The resolver stays offline; if it fails, report its message verbatim and stop. Do not substitute values or inherit parent settings.

Before ordinary dispatch print `Implementation effort: medium (default)`. Before every dispatch or redispatch above medium print `Implementation effort: medium -> <selected effort>; issue: #N; rule: <H1/H2/H3 or user override>; evidence: <specific reference and unresolved problem>; reason: <why medium is insufficient>`. Use the full stable rule ID when known. This is an announcement, not an approval request, and reporting never changes runtime effort. The implementer confirms its dispatched effort and the same rule/reason in its first progress message.

Retain effort, rule (`default` or `user override` when applicable), evidence, and reason in the ledger, assignment, fixed result, PR body, and `Requested settings:` provenance. Record a decision with the claim as `<!-- mcc-effort {"effort":"medium","rule":"default","evidence":"ticket/spec","reason":"The written plan resolves the design."} -->`. A qualifying high record also has `question` and a `criteria` object whose true keys are the matching policy rule's `requires`. A user override record preserves its actual effort and the explicit constraint. The queue reads these records without source or diffs; it never infers a qualifying rule from labels.

## Dispatch and continuation

Send one bounded assignment: issue number and URL (or PR URL), trunk `main` and fresh SHA, actual base branch and SHA, the leaf's ledger line and its `dispatch` metadata (including prerequisite branches/SHAs and validated group/ownership), any verified prerequisite SHAs, `Owned by other running leaves: none` or the queue's ownership value, effort decision and explicit constraints, project 1 owner `samlevin`, the fixed result format in [references/delivery.md](references/delivery.md#result), and `Policy: tool=<tool> role=implementer model=<model> effort=<effort> (model: <source>, effort: <source>); decision: <rule>; evidence: <reference>; reason: <reason>; handoff overrides: <reviewer overrides or none>`. The implementer reads its own issue for acceptance criteria and decisions. Reference repository instructions by path rather than copying them or this conversation.

Use `spawn_agent` with `agent_type`, `model`, and `reasoning_effort` explicitly copied from the implementer's resolver `spawn` object and `fork_turns: "none"`. Always pass both settings; agent files omit them to allow overrides. An unknown `agent_type` means the project is not trusted in Codex yet; report it and stop. Send a person's correction through the tool's continue mechanism (`followup_task` for an idle agent) to the same implementer at its existing effort.

The implementer never spawns another implementer. Ordinary corrections continue in the same agent. Replace only when it is unavailable, with a bounded recovery handoff carrying branch, head SHA, PR URL, open findings, explicit constraints, and the same effort, or under the escalation procedure below. Never create duplicate or parallel ownership. Wait as `.agents/evidence.md` describes. Relay the fixed result and every `Requested settings:` line verbatim and record the result before dependent work.

When an implementer returns `BLOCKED: gh stack not installed`, its claim, branch, and worktree stay in place; dispatch no replacement. Relay its `gh --version` output and ask the person to run `! gh extension install github/gh-stack`, since installing an extension changes their workstation and you never run it yourself. When they confirm, run `gh stack --help >/dev/null`. If it passes, continue the same implementer at its existing effort, as above, with that result as new evidence, so it resumes from the stack step with its claim and worktree. If it fails, show the output and ask again.

## Later escalation

A medium implementer discovering a qualifying problem sends an escalation request with rule, evidence, reason, branch/head, completed checks, and open work. The parent validates the rubric using that compact request, preserves explicit medium constraints, and prints the announcement before changing runtime settings. After approval and before redispatch, the parent posts exactly one later-escalation `mcc-effort` comment through REST using the record format in [references/queue.md](references/queue.md#effort-records), including `later:true`, `question`, and the matching rule's `criteria`. This decision record is exempt from the no-repeat-claim rule; it does not repeat the claim. Reruns and recovery reuse that comment and never post it again. Allow at most one automatic medium-to-high transition per leaf delivery. Reuse the same agent only if the runtime supports an explicit effort change on continuation. Otherwise end the old agent's ownership and create one replacement at high, passing `--effort high` through the resolver and explicit spawn settings plus the bounded recovery handoff. This is the sole additional replacement exception, never permission for another implementer beneath an implementer, parallel ownership, duplicate work, or extra review rounds. If high cannot be applied by the runtime, report that limitation and never claim an upgrade occurred.

## Review depth fallback

An implementer normally spawns its reviewer with the reviewer's own resolved settings. If Codex refuses main -> implementer -> reviewer depth, the implementer sends the factual review packet path to the main thread. The main thread spawns the reviewer with its own resolved `model`, `reasoning_effort`, and `fork_turns: "none"`, reads only the verdict and blocker lines, saves the complete report outside tracked paths, and passes its file path to the implementer. The implementer handles findings and preserves exact-SHA approval and the two-round limit. The main thread reads a detailed report only to explain a blocker requiring a person's decision.

## Report

Relay the fixed result fields, including every `Requested settings:` line verbatim. Rerun the queue script after each result and on resume instead of keeping queue state in conversation. Details and usage metrics actually exposed by the tool go in the PR body, split by parent, implementer, and reviewer; name unavailable input, cached input, output, and reasoning metrics. Claim no savings or comparison with inline delivery.
