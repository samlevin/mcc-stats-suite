# Agent rules

TypeScript NPM/Turbo monorepo that turns Halo MCC screenshots, received by email, into OCR evidence. Only `applications/match-to-csv` is implemented; `admin`, `ocr-quality`, `data-pipeline`, and `player` are placeholder stacks, and `specs/` are plans. Shared code lives in `packages/contracts` and `packages/cdk-config`; OpenTofu lives in `infrastructure/`. Do not read CONTRIBUTING.md, README.md, or other guides unless the task changes them.

## Checks

Run the narrowest set that covers your change, once before pushing. While iterating, run only the focused test.

| Changed | Run |
| --- | --- |
| Docs only | `npm run format:check` |
| `scripts/` only | `npm run format:check`, `npx eslint scripts/ci-scope.mjs scripts/issue-*.mjs --max-warnings 0`, `node --test scripts/issue-*.test.mjs` |
| A workspace | iterate with `npm test --workspace @samlevin/<pkg>`; before push `npm run check` |
| `infrastructure/` | `npm run tofu:check` (OpenTofu 1.12.1 formatting, backend-disabled init and validation for all six roots, plus dev bootstrap and foundation tests) |
| CDK or bundling | also `npm run app:synth -- <app> --environment dev`; `npm run verify:bundle --workspace @samlevin/match-to-csv` |

Pipe long output through `tail -n 60`. Tests never call AWS.

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
