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

- Stable environments are `dev` and `prod`.
- GitHub Actions alone deploys stable application stacks.
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

`npm run check` includes Prettier, ESLint, release metadata checks, TypeScript, tests, and builds. CDK synthesis for native Lambda assets needs Docker and QEMU in CI. Tests must not call AWS.

## Release and deployment rules

Pull requests run checks only. On `main`, Turbo finds affected applications and CI deploys them to stable dev at the exact merge SHA. Production promotes an immutable application tag through `.github/workflows/deploy-aws.yml` after the same app and SHA succeed in dev.

Release Please versions all applications and both shared packages. Internal dependencies use exact versions. The Node workspace plugin patch-bumps consumers when a shared package changes. Keep `package.json`, `package-lock.json`, `.release-please-manifest.json`, and `release-please-config.json` synchronized; `npm run release:check` enforces this.

Use Conventional Commit pull-request titles. Do not commit, push, open a pull request, change GitHub settings, apply infrastructure, or deploy unless the user requests that action.

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
