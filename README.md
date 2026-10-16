# MCC Stats Suite

[![CI: checks](https://github.com/samlevin/mcc-stats-suite/actions/workflows/ci-checks.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/ci-checks.yml)
[![CI: secret scan](https://github.com/samlevin/mcc-stats-suite/actions/workflows/ci-secret-scan.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/ci-secret-scan.yml)
[![CI: PR title](https://github.com/samlevin/mcc-stats-suite/actions/workflows/ci-pr-title.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/ci-pr-title.yml)
[![Release: release PR](https://github.com/samlevin/mcc-stats-suite/actions/workflows/release-pr.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/release-pr.yml)
[![Delivery: deploy to dev then prod](https://github.com/samlevin/mcc-stats-suite/actions/workflows/delivery-deploy.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/delivery-deploy.yml)
[![Delivery: roll back prod](https://github.com/samlevin/mcc-stats-suite/actions/workflows/delivery-rollback.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/delivery-rollback.yml)
[![Terrateam](https://github.com/samlevin/mcc-stats-suite/actions/workflows/terrateam.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/terrateam.yml)

MCC Stats Suite turns Halo: The Master Chief Collection post-game screenshots into structured, traceable data. The first intake path is email. A submitted message can contain several screenshots, and the system processes each attachment independently while preserving the original evidence.

To work on the code, start with [Getting started](docs/getting-started.md). It takes you from a fresh clone to passing checks without AWS access, and then to your own stack in a dev account.

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

The plans under [`specs/`](specs/) describe future product work. They are design inputs, not proof that a feature is deployed.

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

OpenTofu owns resources that survive application releases: encrypted storage, KMS keys, state, GitHub OIDC roles, permissions boundaries, the Glue catalog, the SES receipt rule set, and SSM parameters that publish resource names and ARNs. Terrateam applies foundation changes to dev and then prod from the pull request, then merges it. Nothing applies from `main`. It also checks foundation drift weekly and opens an issue instead of applying a repair unattended.

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

Pull requests run CI without deploying and need no AWS access. A merge to `main` deploys affected applications to the maintainer's `dev` environment at the merged commit. Each application then goes to `prod` after the maintainer approves it. Release Please versions applications and shared packages.

See [WORKFLOW.md](WORKFLOW.md) for issue planning, epics, task states, and the agent protocol. [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) defines classification, required metadata, and Inbox reconciliation. See [CONTRIBUTING.md](CONTRIBUTING.md) for the monorepo workflow, component ownership, conventional pull-request titles, and what happens after a merge. To run your own deployment, follow [Self-hosting](docs/self-hosting/README.md).
