# Agent rules

These instructions apply to every coding agent, including Claude and Codex. Tool runtime details live in the repository's own agents and skills ([Repository agent workflows](#repository-agent-workflows)), never in a contributor's personal configuration.

TypeScript NPM/Turbo monorepo that turns Halo MCC screenshots, received by email, into OCR evidence. Only `applications/match-to-csv` is implemented; `admin`, `ocr-quality`, `data-pipeline`, and `player` are placeholder stacks, and `specs/` are plans. Shared code lives in `packages/contracts` and `packages/cdk-config`; OpenTofu lives in `infrastructure/`. Do not read CONTRIBUTING.md, README.md, or other guides unless the task changes them or a rule below names a section to read.

## Checks

Run the required checks for the changed scope before pushing. Tests never call AWS. [Evidence and waiting](.agents/evidence.md) governs retrieval, bounded output, edit inspection, and reuse of successful results.

| Changed | Run |
| --- | --- |
| Docs only | `npm run format:check`, `npx eslint '**/*.md' --max-warnings 0` |
| `scripts/` only | `npm run format:check`, `npx eslint scripts/ci-scope.mjs scripts/issue-*.mjs scripts/branch-name.mjs --max-warnings 0`, `node --test scripts/issue-*.test.mjs scripts/branch-name.test.mjs` |
| `.agents/`, `.claude/`, `.codex/`, or `scripts/agent-policy*` | `npm run agents:generate` after editing a source, then `npm run agents:check`, `npm run format:check`, `npx eslint scripts/agent-policy.mjs scripts/agent-policy.test.mjs '**/*.md' --max-warnings 0`, `node --test scripts/agent-policy.test.mjs` |
| A workspace | iterate with `npm test --workspace @mcc/<pkg>`; before push `npm run check` |
| `infrastructure/` | `npm run tofu:check` (formatting, backend-disabled validation of every root, module tests) |
| CDK or bundling | also `npm run app:synth -- <app> --environment dev`; `npm run verify:bundle --workspace @mcc/match-to-csv` |

## Autonomous delivery

- Authority: a delivery request authorizes issue claims, project moves, commits, pushes, ready-for-review PRs, and stack links. Filing authorizes issue publication. A manual review of a pull request authorizes one posted review on that PR and nothing else: no edits, no approval, and a change request only for a `REQUEST CHANGES` verdict from a GitHub account other than the PR author. Automatic pre-PR reviews and branch reviews write nothing to GitHub. Merges, deployments, infrastructure applies, destructive operations, and changes to GitHub repository settings, CI secrets, or agent tool settings require explicit user authorization. Repository files such as `package.json`, `turbo.json`, and release-please config are ordinary code changes.
- Before creating or using a worktree, read and follow [Agent worktree isolation](.agents/worktree-isolation.md).
- When a leaf lacks Priority or Size, set Priority to P2 and Size from the scope, as `ISSUE_TRIAGE.md` defines. Missing tracker metadata alone does not block delivery.
- [Leaf delivery](.agents/workflows/implement/references/delivery.md) owns the delivery gate, stacking on unmerged prerequisites, review thresholds, exact-SHA approval, reviewer packets, PRs, and handoff results. Reviewers follow [Independent code review](.agents/review.md) and stay read-only. Load those procedures for delivery or review rather than copying them into assignments.
- Make your own GitHub calls through REST with `gh api`: issues, PRs, comments, labels, assignees, sub-issues (`repos/<repo>/issues/<n>/sub_issues` and `/parent`), issue dependencies (`/dependencies/blocked_by` and `/dependencies/blocking`), and Projects v2 (`users/<owner>/projectsV2/<n>/fields` and `/items`). `gh issue`, `gh pr`, `gh project`, and `gh api graphql` use GraphQL, whose hourly limit agents share with Actions tokens. Use GraphQL only when REST lacks the operation, such as reading a PR's closing issues, and switch to REST when it is rate-limited. Workflows and repository scripts such as `scripts/issue-triage.mjs` keep their GraphQL calls, even when you run them.

## Repository agent workflows

Version-controlled agents and skills under `.claude/agents/` and `.claude/skills/` (Claude Code) and `.codex/agents/` and `.agents/skills/` (Codex) encapsulate MCC delivery. Every identifier starts with `mcc-`, and routing always names the `mcc-` definition. Both tools get the same roles, handoffs, and checks; only the packaging differs. The definitions are generated from `.agents/roles/`, `.agents/workflows/`, and `.agents/policy.json`: edit the source, run `npm run agents:generate`, and commit the output, or ask `mcc-agents` to do all three. `.agents/README.md` has the parity matrix, trust and discovery requirements, known runtime limits, and how to check effective settings.

| Request | Claude Code | Codex | Role it dispatches |
| --- | --- | --- | --- |
| `implement #N`, an issue URL, or a PR URL | `/mcc-implement` | `$mcc-implement` | `mcc-implementer` per leaf or rework (`inline` keeps a small one here); `mcc-code-reviewer` for the pre-PR gate |
| Build, link, rebase, or sync stacked branches during delivery | `/mcc-stack` | `$mcc-stack` | none; the agent that created the worktree runs it |
| File or draft issues | `/mcc-create-github-issue` | `$mcc-create-github-issue` | none by default; `mcc-issue-triager` (read-only) when a batch needs independent judgment |
| File a spec delivery plan | `/mcc-spec-to-issues` | `$mcc-spec-to-issues` | `mcc-issue-triager` for the whole plan after offline pre-flight; confirmation before filing |
| Review a pushed branch or PR | `/mcc-review-code` | `$mcc-review-code` | `mcc-code-reviewer` (read-only, reports to you; the skill posts the report to a target PR) |
| Security review, only when a person asks | `/mcc-review-security` | `$mcc-review-security` | `mcc-security-reviewer` (read-only) |
| Write a PR body, issue body, comment, or doc | `/mcc-plain-language` | `$mcc-plain-language` | none |
| Change, add, or regenerate these agents and skills | `/mcc-agents` | `$mcc-agents` | none; edits sources, regenerates both tools, verifies |
| Apply a PR's foundation roots while Terrateam cannot run, only when a person asks | `/mcc-apply-foundation` | `$mcc-apply-foundation` | none; the agent runs each command itself, one approved step at a time |
| Apply the bootstrap roots and CDK bootstraps at `origin/main`, only when a person asks | `/mcc-apply-bootstrap` | `$mcc-apply-bootstrap` | none; the agent runs each command itself, one approved step at a time |

- Delivery and handoffs: [the implement workflow](.agents/workflows/implement.md) owns dispatch, its [dependency queue](.agents/workflows/implement/references/queue.md) owns containers and the parallel exception, and [leaf delivery](.agents/workflows/implement/references/delivery.md) owns the pre-PR reviewer spawn. Only `mcc-issue-triager` forms independence groups, under `.agents/independence-groups.md`. No automatic flow spawns `mcc-security-reviewer`.
- Model and effort: `.agents/policy.json` names the model and effort for each role, per tool, and owns the implementation effort rubric. Every dispatcher runs `node scripts/agent-policy.mjs resolve --tool <claude|codex> --role <role>` and passes the result explicitly when it spawns; it never inherits a session or contributor default. An explicit `model <name>` or `effort <level>` in the request overrides only that setting, for that task and the handoffs it names (`reviewer effort max`), and changes nothing on disk; unsupported values fail. Each agent labels the dispatched `Policy:` line `Requested settings:`, including overrides, and omits model self-identification and runtime-verification commentary. `CLAUDE_CODE_EFFORT_LEVEL` and Codex agent file fields can silently override requested settings.

## Hard rules

- Public repo: never commit credentials, account IDs, emails, domains, state, plans, or populated env files.
- Never deploy, apply infrastructure, or weaken account checks in `scripts/cdk-app.mjs` or `packages/cdk-config`. Local CDK diff/deploy needs `--environment dev --ephemeral <name>`.
- The one exception: a person may invoke an infrastructure apply skill (`mcc-apply-foundation` or `mcc-apply-bootstrap`) for one pull request or `main` commit. It plans and applies only the roots it names, the bootstrap skill bootstraps only the CDK stacks it names, and the foundation skill merges only that pull request, each step after that person's explicit approval. No agent starts one or runs its plans or applies outside it, and no step skips its account check.
- OpenTofu owns persistent shared resources; CDK owns application compute. Never manage a resource from both.
- Evidence is immutable: never overwrite raw MIME, screenshots, provider responses, or runs; events are append-only. Replay creates a new run. Unknown layouts stay `UNKNOWN`.
- Shared-package changes include every consumer update. Keep `package.json`, `package-lock.json`, `.release-please-manifest.json`, and `release-please-config.json` in sync (`npm run release:check`).
- Every doc, README, guide, spec, agent instruction, and code comment describes the current state: what exists and how to set it up, bootstrap, deploy, and run it, never a log of problems and fixes or a timeline. Change history belongs in PR bodies, commit messages, and changelogs. A code comment may keep prior context only to explain an established regression the code must not reintroduce.
- Match the surrounding code. Add no single-use helper and no check, option, or parameter that no acceptance criterion or caller needs, and keep comments short: explain why, never restate the next line.
- GitHub Actions file, workflow, job, and step names follow the naming convention in [Name GitHub Actions workflows](CONTRIBUTING.md#name-github-actions-workflows), which `scripts/workflow-names.test.mjs` enforces. Read that section before adding or renaming a workflow. Moving or renaming the reusable deploy workflow `_delivery-deploy-environment.yml` needs bootstrap trust applied first, and renaming a required check needs a ruleset change at merge.

## Terrateam module mapping

The Terrateam indexer is disabled, so Terrateam plans a root only when a changed file matches that root's `file_patterns` in `.terrateam/config.yml`. Before you add, change, or remove an OpenTofu root, an `infrastructure/modules/<name>` directory, or a local module call, read and follow [Map module calls to roots](docs/self-hosting/70-optional-terrateam.md#map-module-calls-to-roots), and update `.terrateam/config.yml` in the same PR.

## Delivery binding

Issue tracker: GitHub Issues. This marker turns on the GitHub issue flows (`implement #N`, GitHub issue filing), which run through the `mcc-` skills and agents above.

Repo `samlevin/mcc-stats-suite`, trunk `main`, project [MCC delivery](https://github.com/users/samlevin/projects/1).

- PR titles use Conventional Commits with a component scope, e.g. `fix(contracts): ...`. Body: `Closes #N`, plus `Parent issue or epic: #P` when one exists.
- Issue states: an agent sets only `In progress`, when it claims the issue before coding, as [leaf delivery](.agents/workflows/implement/references/delivery.md#claim) describes. `tracker-pr-issue-status.yml` moves the closing issue to `In review` when the PR opens, and only a person marks an issue `Done`.
- Every request needs an issue before work starts. Search for an existing one first; if none exists, file it with `mcc-create-github-issue` (`$mcc-create-github-issue` in Codex), then claim it and do the work.
- Issue titles follow `ISSUE_TRIAGE.md`. For issue filing, follow `.agents/issue-creation.md`.

## Branch names

Every branch an agent pushes for an issue is named `agent/<issue>-<slug>`. When one leaf is split into stacked layers, layers after the first end in `-part-<n>`. A branch stacked on another issue's PR uses its own issue's name:

- `<issue>` is the number of the leaf issue the PR closes, without `#`.
- `<slug>` is that issue's title in lowercase, with accents dropped and every run of other characters turned into `-`. "Part N" in the title becomes `partN`. The slug is cut to 40 characters at a word boundary, and is `issue` when the title has no ASCII letters or digits.
- Examples: `agent/48-generate-and-enforce-branch-names-from` for #48, and `agent/48-generate-and-enforce-branch-names-from-part-2` for its second stacked layer.

For issue work, never type a branch name by hand. Print it with `node scripts/branch-name.mjs <issue>`, adding `--layer <n>` for layer 2 and up. Create the branch with that name, or run `git branch -m <name>` when your tool created the worktree branch under another name. Do this before the first commit. Once a branch is pushed, keep its name, even if the issue title changes later. Nothing in CI checks branch names, so following this rule is up to you.

[Branch names](WORKFLOW.md#branch-names) gives people the same rules. Change both together.
