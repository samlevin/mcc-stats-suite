# Agent rules

These instructions apply to every coding agent, including Claude and Codex. Tool runtime details live in the repository's own agents and skills ([Repository agent workflows](#repository-agent-workflows)), never in a contributor's personal configuration.

TypeScript NPM/Turbo monorepo that turns Halo MCC screenshots, received by email, into OCR evidence. Only `applications/match-to-csv` is implemented; `admin`, `ocr-quality`, `data-pipeline`, and `player` are placeholder stacks, and `specs/` are plans. Shared code lives in `packages/contracts` and `packages/cdk-config`; OpenTofu lives in `infrastructure/`. Do not read CONTRIBUTING.md, README.md, or other guides unless the task changes them or a rule below names a section to read.

<!-- agenticool-agents sync: begin checks -->

## Checks

While editing, run only the focused tests for what you touched. Before the first push, run the narrowest set of this repository's checks that covers your change, once. After a fix, rerun the checks that cover what the fix touched, and run more when the fix or a failure shows the change reaches further. Never skip a required check, weaken an assertion, or drop a meaningful behavior test; report pre-existing failures as such. After changing `.agents/policy.json` or a source under `.agents/local/`, run `npx agenticool-agents generate`, then `npx agenticool-agents check`. [Evidence and waiting](.agents/evidence.md) governs retrieval, bounded output, edit inspection, and reuse of successful results.

<!-- agenticool-agents sync: end checks -->

Tests never call AWS. Run the required checks for the changed scope before pushing:

| Changed | Run |
| --- | --- |
| Docs only | `npm run format:check`, `npx eslint '**/*.md' --max-warnings 0` |
| `scripts/` only | `npm run format:check`, `npx eslint scripts/ --max-warnings 0`, `node --test 'scripts/*.test.mjs'` |
| `.agents/policy.json`, `.agents/local/`, or generated or synced agent files | `npx agenticool-agents generate` after editing the policy or a local source, then `npm run agents:check`, `npm run format:check`, `npx eslint '**/*.md' --max-warnings 0` |
| `.github/workflows/` | `npm run workflows:lint`, `npm run format:check` |
| A workspace | iterate with `npm test --workspace @mcc/<pkg>`; before push `npm run check` |
| `infrastructure/` | `npm run tofu:check` (formatting, backend-disabled validation of every root, module tests) |
| CDK or bundling | also `npm run app:synth -- <app> --environment dev`; `npm run verify:bundle --workspace @mcc/match-to-csv` |

<!-- agenticool-agents sync: begin delivery -->

## Autonomous delivery

- Authority: a delivery request authorizes issue claims, project moves, commits, pushes, ready-for-review PRs, stack links, and retargeting the base of the delivery owner's own stacked PRs after a merge, as the sync in [stack operations](.agents/skills/mcc-stack/SKILL.md) does. Filing authorizes issue publication. A manual review of a pull request authorizes one posted review on that PR and nothing else: no edits, no approval, and a change request only for a `REQUEST CHANGES` verdict from a GitHub account other than the PR author. Automatic pre-PR reviews and branch reviews write nothing to GitHub. Merges, deployments, infrastructure applies, destructive operations, and changes to GitHub repository settings, CI secrets, or agent tool settings require explicit user authorization.
- Before creating or using a worktree, read and follow [Agent worktree isolation](.agents/worktree-isolation.md).
- When a leaf lacks Priority or Size, set Priority to P2 and Size from the scope, as `ISSUE_TRIAGE.md` defines. Missing tracker metadata alone does not block delivery.
- [Leaf delivery](.agents/skills/mcc-implement/references/delivery.md) owns the delivery gate, stacking on unmerged prerequisites, review thresholds, exact-SHA approval, reviewer packets, PRs, and handoff results. A review handoff after the final push sends the review packet that leaf delivery defines, taking the base SHA from `git merge-base <base> HEAD`, and a rework handoff adds the existing PR URL. Reviewers follow [Independent code review](.agents/review.md) and stay read-only. Load those procedures for delivery or review rather than copying them into assignments.
- Make your own GitHub calls through REST with `gh api`: issues, PRs, comments, labels, assignees, sub-issues (`repos/<repo>/issues/<n>/sub_issues` and `/parent`), issue dependencies (`/dependencies/blocked_by` and `/dependencies/blocking`), and Projects v2 (`users/<owner>/projectsV2/<n>` or `orgs/<owner>/projectsV2/<n>`, with `/fields` and `/items`). `gh issue`, `gh pr`, `gh project`, and `gh api graphql` use GraphQL, whose hourly limit agents share with Actions tokens. Use GraphQL only when REST lacks the operation, such as reading a PR's closing issues, and switch to REST when it is rate-limited. The tracker workflows and `npx agenticool-tracker` keep their GraphQL calls, even when you run them.

<!-- agenticool-agents sync: end delivery -->

Repository files such as `package.json`, `turbo.json`, and release-please config are ordinary code changes.

<!-- agenticool-agents sync: begin code -->

## Code and comments

- Match the surrounding code. Add no single-use helper and no check, option, or parameter that no acceptance criterion or caller needs, and keep comments short: explain why, never restate the next line.
- Every doc, README, guide, spec, agent instruction, and code comment describes the current state: what exists and how to set it up and run it, never a log of problems and fixes or a timeline. Change history belongs in PR bodies and commit messages. A code comment may keep prior context only to explain an established regression the code must not reintroduce.

<!-- agenticool-agents sync: end code -->

<!-- agenticool-agents sync: begin workflows -->

## Repository agent workflows

Version-controlled agents and skills under `.claude/agents/` and `.claude/skills/` (Claude Code) and `.codex/agents/` and `.agents/skills/` (Codex) encapsulate MCC delivery. Every identifier starts with `mcc-`, and routing always names the `mcc-` definition. Both tools get the same roles, handoffs, and checks; only the packaging differs. The definitions are generated from the shared sources in `@agenticool/agents`, the repository's own sources under `.agents/local/`, and `.agents/policy.json`: edit a local source or the policy, run `npx agenticool-agents generate`, and commit the output, or ask `mcc-agents` to do all three. The `@agenticool/agents` README has the parity matrix, trust and discovery requirements, known runtime limits, and how to check effective settings.

| Request | Claude Code | Codex | Role it dispatches |
| --- | --- | --- | --- |
| `implement #N`, an issue URL, or a PR URL | `/mcc-implement` | `$mcc-implement` | `mcc-implementer` per leaf or rework (`inline` keeps a small one here); `mcc-code-reviewer` for the pre-PR gate |
| Build, link, rebase, or sync stacked branches during delivery | `/mcc-stack` | `$mcc-stack` | none; the agent that created the worktree runs it |
| File or draft issues | `/mcc-create-github-issue` | `$mcc-create-github-issue` | none by default; `mcc-issue-triager` (read-only) when a batch needs independent judgment |
| File a specification's delivery plan as a root container, epics, and leaves | `/mcc-spec-to-issues` | `$mcc-spec-to-issues` | `mcc-issue-triager` (read-only) for independence groups only |
| Review a pushed branch or PR | `/mcc-review-code` | `$mcc-review-code` | `mcc-code-reviewer` (read-only, reports to you; the skill posts the report to a target PR) |
| Security review, only when a person asks | `/mcc-review-security` | `$mcc-review-security` | `mcc-security-reviewer` (read-only) |
| Write a PR body, issue body, comment, or doc | `/mcc-plain-language` | `$mcc-plain-language` | none |
| Change, add, or regenerate these agents and skills | `/mcc-agents` | `$mcc-agents` | none; edits sources, regenerates both tools, verifies |

- Delivery and handoffs: [the implement workflow](.agents/skills/mcc-implement/SKILL.md) owns dispatch, its [dependency queue](.agents/skills/mcc-implement/references/queue.md) owns containers and the parallel exception, and [leaf delivery](.agents/skills/mcc-implement/references/delivery.md) owns the pre-PR reviewer spawn. Only `mcc-issue-triager` forms independence groups, under `.agents/independence-groups.md`. No automatic flow spawns `mcc-security-reviewer`.
- Model and effort: `.agents/policy.json` names the model and effort for each role, per tool, and owns the implementation effort rubric. Every dispatcher runs `npx agenticool-agents resolve --tool <claude|codex> --role <role>` and passes the result explicitly when it spawns; it never inherits a session or contributor default. An explicit `model <name>` or `effort <level>` in the request overrides only that setting, for that task and the handoffs it names (`reviewer effort max`), and changes nothing on disk; unsupported values fail. Each agent labels the dispatched `Policy:` line `Requested settings:`, including overrides, and omits model self-identification and runtime-verification commentary. `CLAUDE_CODE_EFFORT_LEVEL` and Codex agent file fields can silently override requested settings.

<!-- agenticool-agents sync: end workflows -->

Repository-only skills, generated from `.agents/local/workflows/`:

| Request | Claude Code | Codex | Role it dispatches |
| --- | --- | --- | --- |
| Apply a PR's foundation roots while Terrateam cannot run, only when a person asks | `/mcc-apply-foundation` | `$mcc-apply-foundation` | none; the agent runs each command itself, one approved step at a time |
| Apply the bootstrap roots and CDK bootstraps at `origin/main`, only when a person asks | `/mcc-apply-bootstrap` | `$mcc-apply-bootstrap` | none; the agent runs each command itself, one approved step at a time |

## Hard rules

- Public repo: never commit credentials, account IDs, emails, domains, state, plans, or populated env files.
- Never deploy, apply infrastructure, or weaken account checks in `scripts/cdk-app.mjs` or `packages/cdk-config`. Local CDK diff/deploy needs `--environment dev --ephemeral <name>`.
- The one exception: a person may invoke an infrastructure apply skill (`mcc-apply-foundation` or `mcc-apply-bootstrap`) for one pull request or `main` commit. It plans and applies only the roots it names, the bootstrap skill bootstraps only the CDK stacks it names, and the foundation skill merges only that pull request, each step after that person's explicit approval. No agent starts one or runs its plans or applies outside it, and no step skips its account check.
- OpenTofu owns persistent shared resources; CDK owns application compute. Never manage a resource from both.
- Evidence is immutable: never overwrite raw MIME, screenshots, provider responses, or runs; events are append-only. Replay creates a new run. Unknown layouts stay `UNKNOWN`.
- Shared-package changes include every consumer update. Keep `package.json`, `package-lock.json`, `.release-please-manifest.json`, and `release-please-config.json` in sync (`npm run release:check`).
- Moving or renaming the reusable deploy workflow `_delivery-deploy-environment.yml` needs bootstrap trust applied first, and renaming a required check needs a ruleset change at merge.

## Terrateam module mapping

The Terrateam indexer is disabled, so Terrateam plans a root only when a changed file matches that root's `file_patterns` in `.terrateam/config.yml`. Before you add, change, or remove an OpenTofu root, an `infrastructure/modules/<name>` directory, or a local module call, read and follow [Map module calls to roots](docs/self-hosting/70-optional-terrateam.md#map-module-calls-to-roots), and update `.terrateam/config.yml` in the same PR.

<!-- agenticool-agents sync: begin binding -->

## Delivery binding

Issue tracker: GitHub Issues. This marker turns on the GitHub issue flows (`implement #N`, GitHub issue filing), which run through the `mcc-` skills and agents.

Repo `samlevin/mcc-stats-suite`, trunk `main`, project [MCC delivery](https://github.com/users/samlevin/projects/1).

- PR titles use Conventional Commits with a component scope, e.g. `fix(<component>): ...`. Body: `Closes #N`, plus `Parent issue or epic: #P` when one exists.
- Issue states: an agent sets only `In progress`, when it claims the issue before coding, as [leaf delivery](.agents/skills/mcc-implement/references/delivery.md#claim) describes. `tracker-pr-issue-status.yml` moves the closing issue to `In review` when the PR opens. Tracker automation moves a closed issue to `Done` and a reopened issue in `Done` back to `Ready`. An agent never sets `In review` or `Done`.
- Every request needs an issue before work starts. Search for an existing one first; if none exists, file it with `mcc-create-github-issue` (`$mcc-create-github-issue` in Codex), then claim it and do the work.
- Issue titles follow `ISSUE_TRIAGE.md`. For issue filing, follow `.agents/issue-creation.md`.

<!-- agenticool-agents sync: end binding -->

<!-- agenticool-agents sync: begin branches -->

## Branch names

Every branch an agent pushes for an issue is named `agent/<issue>-<slug>`. When one leaf is split into stacked layers, layers after the first end in `-part-<n>`. A branch stacked on another issue's PR uses its own issue's name:

- `<issue>` is the number of the leaf issue the PR closes, without `#`.
- `<slug>` is that issue's title in lowercase, with accents dropped and every run of other characters turned into `-`. "Part N" in the title becomes `partN`. The slug is cut to 40 characters at a word boundary, and is `issue` when the title has no ASCII letters or digits.
- Examples: `agent/5-generate-and-enforce-branch-names-from` for #5, and `agent/5-generate-and-enforce-branch-names-from-part-2` for its second stacked layer.

For issue work, never type a branch name by hand. Print it with `npx agenticool-delivery branch-name <issue>`, adding `--layer <n>` for layer 2 and up. Create the branch with that name, or run `git branch -m <name>` when your tool created the worktree branch under another name. Do this before the first commit. Once a branch is pushed, keep its name, even if the issue title changes later. Nothing in CI checks branch names, so following this rule is up to you.

<!-- agenticool-agents sync: end branches -->

[Branch names](WORKFLOW.md#branch-names) gives people the same rules. Change both together.

<!-- agenticool-agents sync: begin workflow-names -->

## GitHub Actions workflow names

- Workflow files are named `<area>-<purpose>.yml` in lowercase kebab-case, and each workflow's `name` starts with the area's prefix and `: `, as in `tracker-issue-states.yml`, named `Tracker: reconcile issue states`. `workflowLint.areas` in `.agents/policy.json` maps each area to its prefix; add an area there before you use it.
- A reusable workflow, one that runs on `workflow_call`, has a file name that starts with `_` and a `name` that ends in ` (reusable)`, as in `_tracker-issue-states.yml`, named `Tracker: reconcile issue states (reusable)`. A workflow that runs only on `workflow_call` must follow this rule; no workflow without `workflow_call` starts with `_` or ends its name with ` (reusable)`.
- Job IDs are kebab-case. Every job and every step has a name that says what it does and starts with a capital letter; a job name may start with an expression instead.
- A workflow that `pull_request`, `push`, or `workflow_call` does not start sets a `run-name` with an expression that names its subject. A `workflow_run` trigger names an existing workflow by its `name`.
- Vendor workflows listed in `workflowLint.exclude` keep the vendor's names. `npx agenticool-workflow-lint` checks these rules.

<!-- agenticool-agents sync: end workflow-names -->
