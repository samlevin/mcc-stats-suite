# Agent rules

These repository instructions apply to all coding agents, including Claude and Codex. The repository ships its own namespaced agents and skills for both tools (see [Repository agent workflows](#repository-agent-workflows)); tool runtime details live in those definitions, never in a contributor's personal configuration.

TypeScript NPM/Turbo monorepo that turns Halo MCC screenshots, received by email, into OCR evidence. Only `applications/match-to-csv` is implemented; `admin`, `ocr-quality`, `data-pipeline`, and `player` are placeholder stacks, and `specs/` are plans. Shared code lives in `packages/contracts` and `packages/cdk-config`; OpenTofu lives in `infrastructure/`. Do not read CONTRIBUTING.md, README.md, or other guides unless the task changes them.

## Checks

Run the narrowest set that covers your change, once before pushing. While iterating, run only the focused test.

| Changed | Run |
| --- | --- |
| Docs only | `npm run format:check` |
| `scripts/` only | `npm run format:check`, `npx eslint scripts/ci-scope.mjs scripts/issue-*.mjs scripts/branch-name.mjs --max-warnings 0`, `node --test scripts/issue-*.test.mjs scripts/branch-name.test.mjs` |
| `.agents/`, `.claude/`, `.codex/`, or `scripts/agent-policy*` | `npm run agents:generate` after editing a source, then `npm run agents:check`, `npm run format:check`, `npx eslint scripts/agent-policy.mjs scripts/agent-policy.test.mjs --max-warnings 0`, `node --test scripts/agent-policy.test.mjs` |
| A workspace | iterate with `npm test --workspace @mcc/<pkg>`; before push `npm run check` |
| `infrastructure/` | `npm run tofu:check` (pinned OpenTofu formatting, backend-disabled init and validation for every environment root, plus module tests) |
| CDK or bundling | also `npm run app:synth -- <app> --environment dev`; `npm run verify:bundle --workspace @mcc/match-to-csv` |

Pipe long output through `tail -n 60`. Tests never call AWS.

## Autonomous delivery

- A delivery request authorizes issue claims, project moves, commits, pushes, and ready-for-review PRs. Merges, deployments, infrastructure applies, destructive operations, and changes to GitHub repository settings, CI secrets, or agent tool settings require explicit user authorization. Repository files such as `package.json`, `tsconfig.json`, `turbo.json`, and release-please config are ordinary code changes.
- Each writer works in its own git worktree based on fresh `origin/main`. Use the worktree your tool creates (Claude Code: `.claude/worktrees/`); otherwise run `git worktree add` under the ignored `.codex/worktrees/` directory, which stays inside the sandboxed workspace and outside temporary directories, so a reboot cannot remove unpushed work. Never edit, install, build, or switch branches in the human checkout, and never symlink its `node_modules`. Never modify a worktree you did not create. If your worktree holds changes you did not make, stop and report them instead of committing or discarding them.
- When a leaf lacks Priority or Size, set Priority to P2 and Size from the scope, as `.agents/issue-creation.md` does. Missing tracker metadata alone does not block delivery. Stop for a concrete unmet prerequisite or missing acceptance criteria.
- When a leaf depends on an unmerged prerequisite PR, stack on it without asking: create the worktree from fresh `origin/main`, then base the branch on the prerequisite branch. Split one leaf into stacked layers only when each layer is reviewable on its own; line count alone does not require a stack. Name branches as described in [Branch names](#branch-names).
- Hand off after the final push. Include acceptance criteria, verified prerequisites, repo, branch, worktree path, the head SHA, and the base SHA from `git merge-base <base> HEAD`, where `<base>` is `origin/main` or the prerequisite branch. Rework handoffs include the existing PR URL.
- Use independent code review for changes across components, shared contracts, security boundaries, and other substantial behavior changes. Always use it, however small the diff, for changes to agent instructions (`.agents/`, `.claude/`, `.codex/`, `AGENTS.md`, and `scripts/agent-policy*`), `infrastructure/`, `.terrateam/`, `.github/workflows/`, CDK account or environment checks, or anything else that changes how prod or shared resources are planned, applied, locked, deployed, or gated. Otherwise skip it for localized low-risk changes, documentation, and mechanical edits. Reviewers check the diff and relevant callers against the supplied criteria. They may run read-only `git` and `gh` commands, but never edit files or run project code.
- Report what changed, the PR URL, checks and results, and any concrete blocker. Report current CI status without waiting for, polling, or rerunning remote CI.

## Repository agent workflows

Version-controlled agents and skills under `.claude/agents/` and `.claude/skills/` (Claude Code) and `.codex/agents/` and `.agents/skills/` (Codex) encapsulate MCC delivery. Every identifier starts with `mcc-`, so a contributor's own `code-reviewer` or `issue-implementer` keeps working, and routing always names the `mcc-` definition. Both tools get the same roles, handoffs, and checks; only the packaging differs. The definitions are generated from `.agents/roles/`, `.agents/workflows/`, and `.agents/policy.json`: edit the source, run `npm run agents:generate`, and commit the output, or ask `mcc-agents` to do all three. `.agents/README.md` has the parity matrix, trust and discovery requirements, and known runtime limits.

| Request | Claude Code | Codex | Role it dispatches |
| --- | --- | --- | --- |
| `implement #N`, an issue URL, or a PR URL | `/mcc-implement` | `$mcc-implement` | `mcc-orchestrator` for an issue with native sub-issues, else `mcc-implementer` |
| File or draft issues | `/mcc-create-github-issue` | `$mcc-create-github-issue` | `mcc-issue-triager` (read-only metadata) |
| Review a pushed branch or PR | `/mcc-review-code` | `$mcc-review-code` | `mcc-code-reviewer` (read-only, reports to you) |
| Security review, only when a person asks | `/mcc-review-security` | `$mcc-review-security` | `mcc-security-reviewer` (read-only) |
| Write a PR body, issue body, comment, or doc | `/mcc-write-prose` | `$mcc-write-prose` | none |
| Change, add, or regenerate these agents and skills | `/mcc-agents` | `$mcc-agents` | none; edits sources, regenerates both tools, verifies |
| Plan and apply a PR's foundation roots while Terrateam cannot run, only when a person asks | `/mcc-apply-foundation` | `$mcc-apply-foundation` | none; the agent runs `gh`, `git`, `aws`, `tofu`, `direnv`, `jq`, and `shasum` itself, one approved step at a time |
| Plan and apply the bootstrap roots at `origin/main`, dev then prod, only when a person asks | `/mcc-apply-bootstrap` | `$mcc-apply-bootstrap` | none; the agent runs `git`, `aws`, `tofu`, `direnv`, `jq`, and `shasum` itself, one approved step at a time |

- Serial delivery: `mcc-orchestrator` dispatches one executable leaf at a time in dependency order and starts the next only after the previous leaf's PR is open or its blocker is recorded. Sibling leaves never run concurrently, even on request.
- Handoffs: `mcc-implementer` spawns `mcc-code-reviewer` before opening a PR when the review threshold above applies, and `mcc-stack-manager` for stacked branches. Nothing else spawns a reviewer, and no automatic flow spawns `mcc-security-reviewer`.
- Authority: filing authorizes issue publication; implementation authorizes claims, project moves, commits, pushes, and ready-for-review PRs; review authorizes no edits or PR writes. Merges, deployments, infrastructure applies, and settings changes keep their separate approval. A person who invokes an infrastructure apply skill authorizes its plans and applies for one pull request or `main` commit, plus the foundation skill's merge, and still approves each step.
- Model and effort: `.agents/policy.json` names the model and effort for issue creation, triage, orchestration, implementation, stack management, code review, and security review, per tool. Every dispatcher runs `node scripts/agent-policy.mjs resolve --tool <claude|codex> --role <role>` and passes the result explicitly when it spawns; it never inherits a session or contributor default. An explicit `model <name>` or `effort <level>` in the request overrides only that setting, for that task and the handoffs it names (`reviewer effort max`), and changes nothing on disk. Unsupported values fail with a message instead of substituting another model or effort. Each agent labels the dispatched `Policy:` line `Requested settings:`, including overrides. Routine reports state the requested model and effort and omit model self-identification and runtime verification commentary. Requested settings are not verified: `CLAUDE_CODE_EFFORT_LEVEL` and Codex agent file fields can override them silently, and `.agents/README.md` shows how to check.

## Hard rules

- Public repo: never commit credentials, account IDs, emails, domains, state, plans, or populated env files.
- Never deploy, apply infrastructure, or weaken account checks in `scripts/cdk-app.mjs` or `packages/cdk-config`. Local CDK diff/deploy needs `--environment dev --ephemeral <name>`.
- The one exception: a person may invoke an infrastructure apply skill (`mcc-apply-foundation` or `mcc-apply-bootstrap`). It plans and applies only the roots it names, for the pull request or `main` commit that person chose, and the foundation skill merges only that pull request, each step after that person's explicit approval. No agent starts one, no agent runs its plans or applies outside it, and no step skips its account check.
- OpenTofu owns persistent shared resources; CDK owns application compute. Never manage a resource from both.
- Evidence is immutable: never overwrite raw MIME, screenshots, provider responses, or runs; events are append-only. Replay creates a new run. Unknown layouts stay `UNKNOWN`.
- Shared-package changes include every consumer update. Keep `package.json`, `package-lock.json`, `.release-please-manifest.json`, and `release-please-config.json` in sync (`npm run release:check`).
- GitHub Actions file, workflow, job, and step names follow the naming convention in `CONTRIBUTING.md`, which `scripts/workflow-names.test.mjs` enforces. Read it before adding or renaming a workflow. Renaming a deployment workflow needs bootstrap trust applied first, and renaming a required check needs a ruleset change at merge.

## Terrateam module mapping

The Terrateam indexer is disabled, so Terrateam plans a root only when a changed file matches that root's `file_patterns` in `.terrateam/config.yml`. Module calls are not discovered. Map them by hand in the same PR that changes them:

- When a root calls a local module (`source = "../../modules/<name>"`), add `'infrastructure/modules/<name>/*.tf'` to that root's `file_patterns`. Follow module calls inside that module too, and add a pattern for every local module the root reaches.
- `*` does not match `/`, so `*.tf` covers only that directory. Add one pattern per module directory. Leave out `tests/`, which never affects a plan.
- Every Terrateam-managed root has a `dirs` entry with its environment tags (`dev` or `prod` selects the workflow), `'${DIR}/*.tf'`, `'${DIR}/*.tfvars'`, `'${DIR}/*.hcl'`, its module patterns, and `'.terrateam/config.yml'`. Roots Terrateam must not run, such as bootstrap, get an entry with `autoplan: false`, `autoapply: false`, and `file_patterns: ['!**/*']`. Terrateam treats every directory holding `.tf` files as a root and runs one without an entry with its default workflow, so every new root and every new `infrastructure/modules/<name>` directory needs one.
- When a module call is removed, remove its pattern from every root that no longer reaches the module.
- Registry and Git modules need no pattern. The root pins their version, and a version change edits the root's own files.

## Delivery binding

Issue tracker: GitHub Issues. This marker turns on the GitHub issue flows (`implement #N`, GitHub issue filing), which run through the `mcc-` skills and agents above.

Repo `samlevin/mcc-stats-suite`, trunk `main`, project [MCC delivery](https://github.com/users/samlevin/projects/1). Discover project field IDs with `gh`.

- PR titles use Conventional Commits with a component scope, e.g. `fix(contracts): ...`. Body: `Closes #N`, plus `Parent issue or epic: #P` when one exists.
- Issue states: claim and move to `In progress` before coding. `tracker-pr-issue-status.yml` moves the closing issue to `In review` when the PR opens; move it yourself only if its run logs a skip. Never mark issues `Done`.
- Every request needs an issue before work starts. Search for an existing one first; if none exists, file it with `mcc-create-github-issue` (`$mcc-create-github-issue` in Codex), then claim it and do the work.
- Issue titles are plain, with no `[Type]:` prefix. For issue filing, follow `.agents/issue-creation.md`.

## Branch names

Every branch an agent pushes for an issue is named `agent/<issue>-<slug>`. When one leaf is split into stacked layers, layers after the first end in `-part-<n>`. A branch stacked on another issue's PR uses its own issue's name:

- `<issue>` is the number of the leaf issue the PR closes, without `#`.
- `<slug>` is that issue's title in lowercase, with accents dropped and every run of other characters turned into `-`. "Part N" in the title becomes `partN`. The slug is cut to 40 characters at a word boundary, and is `issue` when the title has no ASCII letters or digits.
- Examples: `agent/48-generate-and-enforce-branch-names-from` for #48, and `agent/48-generate-and-enforce-branch-names-from-part-2` for its second stacked layer.

For issue work, never type a branch name by hand. Print it with `node scripts/branch-name.mjs <issue>`, adding `--layer <n>` for layer 2 and up. Create the branch with that name, or run `git branch -m <name>` when your tool created the worktree branch under another name. Do this before the first commit. Once a branch is pushed, keep its name, even if the issue title changes later. Nothing in CI checks branch names, so following this rule is up to you.
