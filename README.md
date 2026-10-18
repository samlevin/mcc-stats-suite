# MCC Stats Suite

MCC Stats Suite turns post-game screenshots from Halo: The Master Chief Collection into match stats. Players email screenshots of the post-game scoreboard to the project's address. The system reads each one with OCR and writes its stats as a CSV, so nobody has to copy a scoreboard by hand. This documentation is for developers who contribute to the project or run their own copy of it. Only `match-to-csv`, the application that receives the email and produces the CSV, is built today. The other applications are placeholder stacks, and the specifications describe planned work.

To work on the code, start with [Getting started](docs/getting-started.md). It takes you from a fresh clone to passing checks without AWS access, and then to your own stack in a dev account. [Glossary](#glossary) defines the project's terms.

[![CI: checks](https://github.com/samlevin/mcc-stats-suite/actions/workflows/ci-checks.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/ci-checks.yml)
[![CI: secret scan](https://github.com/samlevin/mcc-stats-suite/actions/workflows/ci-secret-scan.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/ci-secret-scan.yml)
[![CI: PR title](https://github.com/samlevin/mcc-stats-suite/actions/workflows/ci-pr-title.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/ci-pr-title.yml)
[![Release: release PR](https://github.com/samlevin/mcc-stats-suite/actions/workflows/release-pr.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/release-pr.yml)
[![Delivery: deploy to dev then prod](https://github.com/samlevin/mcc-stats-suite/actions/workflows/delivery-deploy.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/delivery-deploy.yml)
[![Delivery: roll back prod](https://github.com/samlevin/mcc-stats-suite/actions/workflows/delivery-rollback.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/delivery-rollback.yml)
[![Terrateam](https://github.com/samlevin/mcc-stats-suite/actions/workflows/terrateam.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/terrateam.yml)

Every value the system extracts can be traced back to the screenshot it came from. Email is the first intake path. A submitted message can contain several screenshots, and the system processes each attachment independently while preserving the original evidence.

The project starts with OCR, but the stored evidence is meant to outlive the first parser. Every processing run retains source hashes, provider output, normalized cells, confidence, geometry, validation results, and code versions. That record supports replaying old screenshots through new pipelines, comparing results, labeling cells, and eventually training OCR quality models.

## What works today

`match-to-csv` is the active application. Amazon SES stores the raw MIME message in S3, then EventBridge and Step Functions coordinate attachment validation and Textract processing.

```text
email with one or more screenshots
  -> retain the raw MIME message
  -> preserve each accepted image as immutable source evidence
  -> run Textract and normalize tables, cells, and tokens
  -> record validation and processing provenance
  -> write structured JSON and CSV exports
```

Each screenshot has its own processing run. Replays create new runs and never replace earlier evidence. The package can also compare two runs and materialize screenshot-safe training, validation, and test datasets. It does not create matches, associate maps, adjudicate OCR, or train models yet.

Read the [`match-to-csv` documentation](applications/match-to-csv/README.md) for its evidence layout, replay input, comparison behavior, and training-data output.

## Components

The monorepo separates product areas so they can be tested, versioned, and deployed without moving the entire system at once.

| Component | Role | Current state |
|---|---|---|
| `applications/match-to-csv` | Email intake, screenshot evidence, OCR, replay, comparison, and dataset materialization | Implemented |
| `applications/ocr-quality` | OCR scoring, anomaly detection, and cell-labeling workflow | Deployable boundary; feature work remains |
| `applications/admin` | Reviewer API and mobile-first review interface | Deployable boundary; feature work remains |
| `applications/data-pipeline` | Lakehouse transformation jobs | Deployable boundary; feature work remains |
| `applications/player` | Read-only statistics API and interface | Deployable boundary; feature work remains |
| `packages/contracts` | Shared TypeScript evidence and processing contracts | Implemented and independently versioned |
| `packages/cdk-config` | Shared environment validation, names, and deployment rules | Implemented and independently versioned |
| `packages/roster` | Gamertag matching against the roster, roster fold, and roster hash | Implemented and independently versioned; used by the roster script and by `match-to-csv`, which uses the fold and hash to read the roster |
| `packages/recipients` | CSV recipient list fold, hash, and change check | Implemented and independently versioned; used by the recipient script |

## Specifications

The plans under [`specs/`](specs/) describe product work. They are design inputs, not proof that a feature is deployed. Release 1 is the beta and release 2 is v1, and the number after the dot is the spec's place in its release's delivery order.

### 1. Beta

- [1.1 Match-to-CSV](specs/1.1-mcc-analytics-engine.md): built and running. It describes `match-to-csv`, the one application built so far.
- [1.2 Gamertag Roster](specs/1.2-gamertag-roster.md): partly built. It matches each player name OCR reads against a roster of known gamertags and writes the roster gamertag into the CSV. The roster contracts in `packages/contracts`, the matcher package `packages/roster`, and the roster table in the foundation are merged. Resolution in `match-to-csv` is filed as [#199](https://github.com/samlevin/mcc-stats-suite/issues/199) to [#201](https://github.com/samlevin/mcc-stats-suite/issues/201).
- [1.3 Match-to-CSV observability](specs/1.3-match-to-csv-observability.md): draft, not implemented. It adds one structured log record per pipeline stage, plus metrics and alarms.

### 2. v1

- [2.1 OCR Quality](specs/2.1-ocr-quality.md): draft, not implemented. It scores each OCR cell for how likely it is to be wrong.
- [2.2 HH.H Design System](specs/2.2-design-system.md): draft, not implemented. It defines the visual identity, tokens, CSS and React components that the `admin` and `player` applications share.
- [2.3 Cell Labeling](specs/2.3-cell-labeling.md): draft, not implemented. Reviewers confirm or correct every OCR cell in the `admin` application.
- [2.4 Matches from Admin Uploads](specs/2.4-match-uploads.md): draft, not implemented. An admin creates a match by uploading its scoreboard screenshots in the `admin` application.
- [2.5 OCR Risk Model and Autonomous Review](specs/2.5-ocr-risk-model.md): draft, not implemented. Scoreboard rules, an LLM reviewer, and a trained risk model decide which runs need a person.
- [2.6 Stats Lakehouse](specs/2.6-stats-lakehouse.md): draft, not implemented. It turns reviewed scoreboards into the statistics the `player` application shows.

[Template](specs/TEMPLATE.md) gives the structure a new specification follows.

## Repository layout

```text
applications/        Independently deployable TypeScript and CDK workspaces
packages/            Private, versioned packages shared by applications
infrastructure/      OpenTofu modules and dev/prod roots
scripts/             Repository-level deployment and release checks
specs/               Product and implementation specifications
docs/self-hosting/    Running your own deployment: AWS, CI, releases, and recovery
```

NPM workspaces provide package boundaries. Turbo follows their dependency graph so root checks run in order and CI can identify affected applications.

## How AWS is divided

OpenTofu owns resources that survive application releases: encrypted storage, KMS keys, state, GitHub OIDC roles, permissions boundaries, the Glue catalog, the SES receipt rule set, and SSM parameters that publish resource names and ARNs. This repository applies foundation changes to dev and then prod from their pull request, before it merges, as [Change the foundation with Terrateam](docs/self-hosting/70-optional-terrateam.md#change-the-foundation-with-terrateam) describes.

CDK owns application compute and orchestration: Lambda functions, Step Functions, EventBridge rules, IAM grants, and logs. The foundation owns the account-wide SES receipt rule set and the shared `<alias>@<domain>` rule; an ephemeral stack adds only its own `<alias>+<name>@<domain>` rule. The alias and domain are repository secrets that the foundation publishes to SSM. CDK reads the OpenTofu outputs from SSM Parameter Store. A resource has one owner; do not describe the same AWS resource in both systems.

There are `dev` and `prod` environments. GitHub Actions deploys application stacks to them. Local developers may create named ephemeral stacks in the dev account.

```text
match-to-csv-dev         dev integration stack
match-to-csv-e-<name>    local ephemeral stack in dev
match-to-csv-prod        live stack
```

## Start locally

[Getting started](docs/getting-started.md) is the one setup path. Its first tier needs no AWS access and ends with a passing `npm run check`. The second takes you through deploying your own ephemeral stack and sending it a test email. It also lists the checks to run for each kind of change.

Never commit `.envrc`, AWS credentials, account IDs, email addresses, domain names, populated backend files, variable files, state, or plans.

## Develop and deploy

Pull requests run CI without deploying and need no AWS access; [How CI selects checks](TESTING.md#how-ci-selects-checks) explains which checks run. [What happens after merge](CONTRIBUTING.md#what-happens-after-merge) covers deployment and releases.

See [WORKFLOW.md](WORKFLOW.md) for issue planning, epics, and task states. Coding agents follow [AGENTS.md](AGENTS.md). [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) defines classification, required metadata, and Inbox reconciliation. See [CONTRIBUTING.md](CONTRIBUTING.md) for the monorepo workflow, component ownership, conventional pull-request titles, and what happens after a merge. To run your own deployment, follow [Self-hosting](docs/self-hosting/README.md).

## Glossary

- **Bootstrap (OpenTofu):** the root `infrastructure/<environment>/bootstrap`, which an administrator applies once per account. It creates the OpenTofu state bucket, the GitHub OIDC provider, the CI roles, and the permissions boundary for application roles. CI never applies it. See [Bootstrap the dev and prod accounts](docs/self-hosting/10-bootstrap-accounts.md).
- **Bootstrap (CDK):** `cdk bootstrap`, which creates the toolkit stack, asset storage, and roles that CDK needs to deploy into an account and Region. Each account has the default CDK bootstrap for GitHub Actions deploys. The dev account also has `mcclocal1`, a restricted bootstrap that ephemeral stacks use. See [Bootstrap CDK and grant local deploy access](docs/self-hosting/20-bootstrap-cdk.md).
- **Foundation:** the OpenTofu roots `infrastructure/<environment>/foundation`. They hold the resources that outlive application releases: KMS keys, durable storage such as the evidence and raw-email buckets, the SES receipt rule set, the Turbo cache bucket and role, and the SSM parameters that applications read. See [Apply and change the foundation](docs/self-hosting/40-change-foundation.md).
- **Ephemeral stack:** a developer's own copy of an application in the dev account, named `<application>-e-<name>` and deployed from a workstation with `--ephemeral <name>`. Tier 2 of [Getting started](docs/getting-started.md#tier-2-deploy-your-own-ephemeral-stack) creates one.
- **Terrateam:** a service that runs OpenTofu plans and applies in GitHub Actions when someone comments on a pull request. This repository uses it to apply the foundation to dev and then prod. A self-hosted copy can apply the foundation another way. See [Apply the foundation with Terrateam](docs/self-hosting/70-optional-terrateam.md).
- **Turbo:** [Turborepo](https://turborepo.dev/), which runs npm workspace scripts in dependency order, caches their results, and picks the workspaces a change affects.
- **Leaf, container, and epic issues:** a leaf issue holds one logical change with acceptance criteria, and a pull request closes it. An issue with native sub-issues is a container. It never gets its own branch or pull request, and it closes when all its sub-issues close. An epic is a container someone explicitly asked for, usually tied to a milestone. See [Issues, containers, and epics](WORKFLOW.md#issues-containers-and-epics).
