---
name: mcc-create-github-issue
description: "Plan and file MCC GitHub issues, native sub-issues, and explicitly requested epics using the repository's issue forms, labels, and MCC delivery project fields, with independent mcc-issue-triager metadata. Use for create/file/open/draft issue requests in samlevin/mcc-stats-suite. Does not implement or open PRs."
---
<!-- Generated from .agents/workflows/create-github-issue.md by scripts/agent-policy.mjs. Edit the source and run `npm run agents:generate`. -->

# MCC create GitHub issues

## Resolve

Repository `samlevin/mcc-stats-suite`, project [MCC delivery](https://github.com/users/samlevin/projects/1) (number 1, owner `samlevin`). Read `.agents/issue-creation.md` and the matching `.github/ISSUE_TEMPLATE/*.yml`; `AGENTS.md` is already loaded. Read `ISSUE_TRIAGE.md` only for a classification question. Discover labels (`gh api repos/samlevin/mcc-stats-suite/labels --paginate`), project fields and options (`gh api users/samlevin/projectsV2/1/fields --paginate`), and native issue types (`gh api orgs/<owner>/issue-types` when the repository owner is an organization; a user-owned repository has none) once per batch, and reuse the results. Every GitHub call you make in this skill is REST through `gh api`; the repository scripts it runs keep their own calls. Repository commands run read-only against the human checkout; do not modify it.

Codex skills cannot set the session model. The repository policy for `issue-creation` is `node scripts/agent-policy.mjs resolve --tool codex --capability issue-creation`; state its model and effort in your first message as `Advisory policy: ...`, not as requested settings, because nothing dispatched this session and it runs whatever model Codex started with. Start Codex with `codex -m <model> -c model_reasoning_effort=<effort>` to run the session at that policy, or at an explicit override.

## Plan

Search for duplicates first (`gh api -X GET search/issues -f q='repo:samlevin/mcc-stats-suite is:issue <terms>'`). Well-scoped requests go straight to drafting. For broad ones, plan only outcomes, boundaries, acceptance criteria, and prerequisites, and ask only about material unknowns. Keep supplied decisions. Never invent impact, repro steps, tests, or architecture.

- Leaf = one logical feature, bug, or change. It uses `task.yml` or `bug.yml` with acceptance criteria and validation.
- Multiple independent outcomes become native sub-issues under a `container.yml` parent: What/Why/How, no acceptance criteria, no branch or PR. It closes when its children close. Containers may nest.
- Epic only when explicitly requested, with `epic.yml`. `epic` is its sole work-category label; severity, package, area, and risk labels may stay. Use `Parent epic` in a child body only when the immediate parent is an epic; otherwise `Parent issue`.
- Size never creates an epic. Titles are plain, with no `[Type]:` prefix; strip one if a template adds it.

## Triage

Resolve the triager settings with `node scripts/agent-policy.mjs resolve --tool <tool> --role issue-triager`, adding `--model` or `--effort` only for a `triager` override in the request. If it exits non-zero, stop and report its message. Spawn one `mcc-issue-triager` for the batch with the resolved model and effort. Send only the drafts (ref, title, body, parent ref, and planned blocked-by refs), accepted decisions, the discovered label and option lists, and the `Policy:` line (`Policy: tool=<tool> role=issue-triager model=<model> effort=<effort> (model: <source>, effort: <source>)`). Do not send the transcript or your intended verdict. Apply its severity, Priority, Size, labels, and independence groups. On SPLIT_REQUIRED, split and re-triage only the affected drafts, plus their sibling leaves when the split changes a new container's leaves. There is no second pass otherwise. Never triage yourself in place of the triager.

Spawn with `spawn_agent`: `agent_type: mcc-issue-triager`, `model` and `reasoning_effort` from the resolver's `spawn` object, `fork_turns: "none"`. Always pass both values; the agent file carries neither. An unknown `agent_type` means the project is not trusted in Codex yet; say so and stop.

## Publish

"Draft", "suggest", or "plan" means show the drafts and write nothing. "Create", "file", or "open" authorizes publishing the requested issues and necessary sub-issues, nothing more: no implementation, credentials, or tracker configuration. Load the mcc-plain-language skill before writing bodies. Preflight template fields, labels, options, and project access. A missing item is a blocker; do not create configuration as a side effect.

Order: parents, then children, then native parent links, then blocked-by edges (the waiting issue's `dependencies/blocked_by` gets the blocker's `id`; reject cycles), then the independence record in each new container or epic body for which the triager returned groups (format in `.agents/issue-creation.md`; leave the rest of the body unchanged), then Priority, Size, and Status on each issue's project item, then the adapter's post-create commands (`node scripts/issue-triage.mjs --apply --issue N` per new issue and `node scripts/issue-containers.mjs --apply --issue N` per new top-level container, after the batch's relationships are complete). Never add an issue to the project yourself: a repository workflow adds every new issue, so wait for that item to appear before setting its fields. If it never appears, keep the issue, skip its fields and post-create commands, and report it as unfinished. Milestone and assignee only when requested or required by policy. Record each URL as it succeeds. On an ambiguous failure, search before retrying and repair rather than duplicate. REST mechanics: [references/github-operations.md](references/github-operations.md), read only when needed.

## Verify and return

Read back bodies, independence records, labels, parent and dependency direction, project membership, and fields. Return URLs, the hierarchy, dependencies, independence groups, the triager's `Requested settings: Policy: <as dispatched>` line, and any partial result or uncertainty, compactly.
