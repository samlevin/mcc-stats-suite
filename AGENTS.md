# Agent rules

TypeScript NPM/Turbo monorepo that turns Halo MCC screenshots, received by email, into OCR evidence. Only `applications/match-to-csv` is implemented; `admin`, `ocr-quality`, `data-pipeline`, and `player` are placeholder stacks, and `specs/` are plans. Shared code lives in `packages/contracts` and `packages/cdk-config`; OpenTofu lives in `infrastructure/`. Do not read CONTRIBUTING.md, README.md, or other guides unless the task changes them.

## Checks

Run the narrowest set that covers your change, once before pushing. While iterating, run only the focused test.

| Changed | Run |
| --- | --- |
| Docs only | `npm run format:check` |
| `scripts/` only | `npm run format:check`, `npx eslint scripts/ci-scope.mjs scripts/issue-*.mjs --max-warnings 0`, `node --test scripts/issue-*.test.mjs` |
| A workspace | iterate with `npm test --workspace @samlevin/<pkg>`; before push `npm run check` |
| `infrastructure/` | `npm run tofu:fmt:check` |
| CDK or bundling | also `npm run app:synth -- <app> --environment dev`; `npm run verify:bundle --workspace @samlevin/match-to-csv` |

Pipe long output through `tail -n 60`. Tests never call AWS.

## Autonomous delivery

- A delivery request authorizes issue claims, project moves, commits, pushes, and ready-for-review PRs. Merges, deployments, infrastructure applies, destructive operations, and settings changes require explicit user authorization.
- Create owned worktrees from fresh `origin/main` under `/private/tmp/codex-mcc-stats-suite-<task>`. Never edit, install, build, or switch branches in the human checkout. Use `exec_command.workdir` for commands.
- Run with default permissions first. Network access depends on the active parent session; escalate only after a concrete sandbox denial or for a known protected Git metadata write. Reuse existing command rules. Put `--repo` after the GitHub subcommand and prefer subcommands over reviewed `gh api` calls.
- Infer missing Size or Priority from the requested outcome. Missing tracker metadata alone does not block delivery. Stop for a concrete unmet prerequisite or missing acceptance criteria.
- Use stacked PRs for prerequisite dependencies or independently reviewable layers. Line count alone does not require a stack. An explicitly authorized stack may create a worktree from fresh trunk and then base its branch on the prerequisite ref; record that SHA for review.
- Pass `fork_turns: "none"`, acceptance criteria, verified prerequisites, repo, branch, exact base/head SHAs, and worktree path in concise handoffs. Reviewers use supplied criteria and inspect the diff and relevant callers; rework reviews include the existing PR URL.
- Use independent code review for shared contracts, security boundaries, and other substantial behavior changes. Reviewers never edit or execute project code, even when parent permission overrides grant write access.
- Keep the main thread idle between concise progress updates. Wait up to 60 seconds per call; never poll agent lists or remote CI. Report current CI status once and hand off.

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
- Issue states: claim and move to `In progress` before coding; move to `In review` when the PR opens. Never mark issues `Done`.
- Issue titles are plain, with no `[Type]:` prefix. For issue filing, follow `.agents/issue-creation.md`.
