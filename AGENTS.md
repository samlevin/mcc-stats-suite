# Agent rules

These repository instructions apply to all coding agents, including Claude and Codex. Keep tool-specific settings and runtime instructions in each tool's personal configuration.

TypeScript NPM/Turbo monorepo that turns Halo MCC screenshots, received by email, into OCR evidence. Only `applications/match-to-csv` is implemented; `admin`, `ocr-quality`, `data-pipeline`, and `player` are placeholder stacks, and `specs/` are plans. Shared code lives in `packages/contracts` and `packages/cdk-config`; OpenTofu lives in `infrastructure/`. Do not read CONTRIBUTING.md, README.md, or other guides unless the task changes them.

## Checks

Run the narrowest set that covers your change, once before pushing. While iterating, run only the focused test.

| Changed | Run |
| --- | --- |
| Docs only | `npm run format:check` |
| `scripts/` only | `npm run format:check`, `npx eslint scripts/ci-scope.mjs scripts/issue-*.mjs scripts/branch-name.mjs --max-warnings 0`, `node --test scripts/issue-*.test.mjs scripts/branch-name.test.mjs` |
| A workspace | iterate with `npm test --workspace @samlevin/<pkg>`; before push `npm run check` |
| `infrastructure/` | `npm run tofu:fmt:check` |
| CDK or bundling | also `npm run app:synth -- <app> --environment dev`; `npm run verify:bundle --workspace @samlevin/match-to-csv` |

Pipe long output through `tail -n 60`. Tests never call AWS.

## Autonomous delivery

- A delivery request authorizes issue claims, project moves, commits, pushes, and ready-for-review PRs. Merges, deployments, infrastructure applies, destructive operations, and settings changes require explicit user authorization.
- Each writer owns an isolated worktree created from fresh `origin/main` under `/private/tmp/agent-mcc-stats-suite-<task>`. Never edit, install, build, or switch branches in the human checkout. Install dependencies in the owned worktree; never symlink the human checkout's `node_modules`. Preserve other agents' edits.
- Infer missing Size or Priority from the requested outcome. Missing tracker metadata alone does not block delivery. Stop for a concrete unmet prerequisite or missing acceptance criteria.
- Use stacked PRs for prerequisite dependencies or independently reviewable layers. Line count alone does not require a stack. An explicitly authorized stack may create a worktree from fresh trunk and then base its branch on the prerequisite ref; record that SHA for review.
- Include acceptance criteria, verified prerequisites, repo, branch, exact base/head SHAs, and worktree path in concise handoffs. Reviewers use supplied criteria and inspect the diff and relevant callers; rework reviews include the existing PR URL.
- Use independent code review for changes across components, shared contracts, security boundaries, and other substantial behavior changes. Skip independent review for localized low-risk changes, documentation, and mechanical edits. Reviewers remain read-only and never edit or execute project code.
- Report what changed, the PR URL, checks and results, and any concrete blocker. Report current CI status without waiting for, polling, or rerunning remote CI.

## Hard rules

- Public repo: never commit credentials, account IDs, emails, domains, state, plans, or populated env files.
- Never deploy, apply infrastructure, or weaken account checks in `scripts/cdk-app.mjs` or `packages/cdk-config`. Local CDK diff/deploy needs `--environment dev --ephemeral <name>`.
- OpenTofu owns persistent shared resources; CDK owns application compute. Never manage a resource from both.
- Evidence is immutable: never overwrite raw MIME, screenshots, provider responses, or runs; events are append-only. Replay creates a new run. Unknown layouts stay `UNKNOWN`.
- Shared-package changes include every consumer update. Keep `package.json`, `package-lock.json`, `.release-please-manifest.json`, and `release-please-config.json` in sync (`npm run release:check`).

## Delivery binding

Issue tracker: GitHub Issues. This marker turns on the GitHub issue flows (`implement #N`, GitHub issue filing); without it, agents use Jira.

Repo `samlevin/mcc-stats-suite`, trunk `main`, project [MCC delivery](https://github.com/users/samlevin/projects/1). Discover project field IDs with `gh`.

- PR titles use Conventional Commits with a component scope, e.g. `fix(contracts): ...`. Body: `Closes #N`, plus `Parent issue or epic: #P` when one exists.
- Issue states: claim and move to `In progress` before coding. `pr-issue-status.yml` moves the closing issue to `In review` when the PR opens; move it yourself only if its run logs a skip. Never mark issues `Done`.
- Issue titles are plain, with no `[Type]:` prefix. For issue filing, follow `.agents/issue-creation.md`.

## Branch names

Every branch an agent pushes is named `agent/<issue>-<slug>`, and stacked layers after the first end in `-part-<n>`:

- `<issue>` is the number of the leaf issue the PR closes, without `#`.
- `<slug>` is that issue's title in lowercase, with accents dropped and every run of other characters turned into `-`. "Part N" in the title becomes `partN`. The slug is cut to 40 characters at a word boundary, and is `issue` when the title has no ASCII letters or digits.
- Examples: `agent/48-generate-and-enforce-branch-names-from` for #48, and `agent/48-generate-and-enforce-branch-names-from-part-2` for its second stacked layer.

Never type a branch name by hand. Print it with `node scripts/branch-name.mjs <issue>`, adding `--layer <n>` for layer 2 and up. Create the branch with that name, or run `git branch -m <name>` when your tool created the worktree branch under another name. Do this before the first commit. Once a branch is pushed, keep its name, even if the issue title changes later. Nothing in CI checks branch names, so following this rule is up to you.
