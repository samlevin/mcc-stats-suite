# Repository guidance for agents

## Purpose and current state

MCC Stats Suite is a public TypeScript monorepo for turning Halo MCC post-game screenshots into durable OCR evidence and structured data. Email is the only supported intake path. One MIME message may contain several images; process every accepted attachment independently.

`applications/match-to-csv` is the only implemented product application. It preserves raw MIME, immutable source screenshots, Textract requests and responses, normalized observations, append-only events, JSON exports, and CSV exports. Replay creates a new processing run. It never mutates an older run. Matches, maps, adjudication, user history, and model training do not exist yet.

`admin`, `ocr-quality`, `data-pipeline`, and `player` are deployable CDK boundaries with placeholder stacks. Treat files in `specs/` as plans, not implemented behavior.

## Boundaries

- `applications/*`: independently deployable NPM workspaces and CDK stacks.
- `packages/contracts`: versioned TypeScript evidence and processing contracts.
- `packages/cdk-config`: versioned environment validation, account checks, stack names, and prefixes.
- `infrastructure/`: OpenTofu bootstrap, foundation, and data-platform modules with separate dev and prod roots.
- `scripts/cdk-app.mjs`: required CDK entry point for application synth, diff, deploy, and destroy.
- `runbooks/`: operator procedures. `CONTRIBUTING.md` owns contributor and release workflow details.

OpenTofu owns persistent shared resources, state, OIDC roles, permissions boundaries, KMS, S3, Glue, Athena, and SSM contracts. CDK owns application Lambda, Step Functions, EventBridge, SES rules, IAM grants, and logs. Never manage one resource from both tools.

## Environment rules

- Environments are `dev` and `prod`.
- GitHub Actions alone deploys application stacks to `dev` and `prod`.
- Local deployments require `--environment dev --ephemeral <name>`.
- Production does not support ephemeral stacks or local deploys.
- Verify the AWS identity before any stateful command. Do not weaken account checks in `scripts/cdk-app.mjs` or `packages/cdk-config`.
- `match-to-csv` stable ingress depends on a verified SES domain supplied outside source control.

## Commands

Run from the repository root:

```console
npm ci
npm run check
npm run tofu:fmt:check
npm test --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv --environment dev
npm run app:diff -- match-to-csv --environment dev --ephemeral <name>
```

`npm run check` includes Prettier, ESLint, release metadata checks, TypeScript, tests, and builds. For documentation or recognized repository-only work, follow the shorter checks in CONTRIBUTING.md; do not run package or infrastructure tests. CI selects scope from files using the baseline classifier, never PR titles or labels. CDK synthesis for native Lambda assets needs Docker and QEMU in CI. Tests must not call AWS.

## Release and deployment rules

Pull requests run checks only. On `main`, Turbo finds affected applications; `.github/workflows/deploy-dev.yml` deploys them after CI succeeds. `.github/workflows/deploy-prod.yml` deploys the same revision after dev succeeds and a reviewer approves the GitHub `prod` environment.

Foundation promotion is different from application release promotion. Terrateam plans foundation changes on pull requests. After merge, its layered run applies the merged revision to dev before prod. There is no foundation release ID or release tag. A failed or stale dev layer blocks prod. Scheduled foundation drift opens an issue and must never auto-apply.

Release Please versions all applications and both shared packages. Internal dependencies use exact versions. The Node workspace plugin patch-bumps consumers when a shared package changes. Keep `package.json`, `package-lock.json`, `.release-please-manifest.json`, and `release-please-config.json` synchronized; `npm run release:check` enforces this.

Use Conventional Commit pull-request titles. Do not commit, push, open a pull request, change GitHub settings, apply infrastructure, or deploy unless the user requests that action. Invoking an issue or epic delivery agent requests the issue-to-PR workflow described below; ordinary local editing does not.

## Codex delivery binding

Issue titles must be plain descriptions with no `[Type]:` prefix; labels carry classification.

Use the reusable personal Codex agents for GitHub work in `samlevin/mcc-stats-suite`, with `main` as trunk and the [MCC delivery project](https://github.com/users/samlevin/projects/1) as the default project. Read `WORKFLOW.md` for readiness, claims, dependencies, and project states. [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) owns issue classification and required metadata; use its [label catalog](.github/labels.json) and [.agents/issue-creation.md](.agents/issue-creation.md) adapter for issue creation. Ready means metadata triaged; before claiming, verify executable scope, acceptance, validation, dependencies, parent relationships, and XS/S/M. Any issue with sub-issues is a container with no branch or PR and no acceptance criteria; use What/Why/How. Only deliverable leaves have acceptance criteria. Explicit epics use the epic label without other work-category labels. Implement executable leaves; plan L items before implementation. Discover project field IDs and options from GitHub instead of hard-coding them.

For `implement #number`, inspect native sub-issues first. Delegate any container or epic delivery to `task-orchestrator`, and leaf implementation or existing-PR rework to `issue-implementer`. The orchestrator traverses nested containers, orders leaves by native blocking relationships, and parallelizes only independent files, contracts, and dependencies. Use stacks mainly for reviewable layers within M or larger leaf issues. Epics require an explicit creation request; use Issue/Sub-issue otherwise. The implementer delegates pushed-branch review to `code-reviewer` strictly before the candidate PR exists, and branch/stack maintenance to `stacked-pr-manager`. Invoke `security-reviewer` only for an explicit human security-review request. The implementer owns PR creation and formal-review follow-up.

A delivery invocation authorizes issue claims, project transitions, accepted-scope decomposition, commits, pushes, PR creation, and native stack linking through ready-for-review handoff. It does not authorize merges, auto-merge, repository settings changes, infrastructure applies, or deployments. Run the local gates in `CONTRIBUTING.md` and satisfy required PR checks. Keep executable issues in `In review` until merge; agent handoff is not issue completion.

## Data guarantees

- Preserve raw MIME and every original screenshot.
- `SourceScreenshot.acquisitionType` is `SCREENSHOT` in v1; valid contract values are `SCREENSHOT`, `PHOTO`, and `OTHER`.
- Keep source, provider, normalized, and run artifacts immutable.
- Keep submission and run events append-only.
- Store large payloads in S3 and pass references through Step Functions.
- Split training data by `screenshotId`, never by cell or processing run.
- Unknown layouts remain `UNKNOWN`; do not invent semantic labels or silently correct OCR.
- Adjudication is a separate future feature.

## Editing rules

This repository may contain unrelated work in progress. Inspect `git status`, preserve existing changes, and edit only the requested scope. Never add personal email addresses, domain names, AWS account IDs, secrets, populated environment files, state, or plans. Use placeholders in public documentation and fixtures.

Add tests for behavior changes. Update the nearest README, testing guide, runbook, or specification when a public contract or operator workflow changes. Start with `README.md`, `CONTRIBUTING.md`, and `TESTING.md`; open deeper documents only when the task requires them.
