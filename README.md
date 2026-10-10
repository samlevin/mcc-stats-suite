# MCC Stats Suite

[![CI](https://github.com/samlevin/mcc-stats-suite/actions/workflows/ci.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/ci.yml)
[![Secret scan](https://github.com/samlevin/mcc-stats-suite/actions/workflows/secret-scan.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/secret-scan.yml)
[![Semantic PR](https://github.com/samlevin/mcc-stats-suite/actions/workflows/semantic.pr.yaml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/semantic.pr.yaml)
[![Release Please](https://github.com/samlevin/mcc-stats-suite/actions/workflows/release-please.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/release-please.yml)
[![application delivery](https://github.com/samlevin/mcc-stats-suite/actions/workflows/deploy-dev.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/deploy-dev.yml)
[![Production rollback](https://github.com/samlevin/mcc-stats-suite/actions/workflows/deploy-aws.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/deploy-aws.yml)
[![Terrateam](https://github.com/samlevin/mcc-stats-suite/actions/workflows/terrateam.yml/badge.svg)](https://github.com/samlevin/mcc-stats-suite/actions/workflows/terrateam.yml)

MCC Stats Suite turns Halo: The Master Chief Collection post-game screenshots into structured, traceable data. The first intake path is email. A submitted message can contain several screenshots, and the system processes each attachment independently while preserving the original evidence.

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

OpenTofu owns resources that survive application releases: encrypted storage, KMS keys, state, GitHub OIDC roles, permissions boundaries, the Glue catalog, and SSM parameters that publish resource names and ARNs. After a reviewed pull request merges, Terrateam applies foundation changes to dev and then prod from that revision. It also checks foundation drift weekly and opens an issue instead of applying a repair unattended.

CDK owns application compute and orchestration: Lambda functions, Step Functions, EventBridge rules, SES receipt rules, IAM grants, and logs. CDK reads the OpenTofu outputs from SSM Parameter Store. A resource has one owner; do not describe the same AWS resource in both systems.

There are `dev` and `prod` environments. GitHub Actions deploys application stacks to them. Local developers may create named ephemeral stacks in the dev account.

```text
match-to-csv-dev         dev integration stack
match-to-csv-<name>      local ephemeral stack in dev
match-to-csv-prod        live stack
```

## Start locally

Local work needs Git, Node.js 22.16.0, and npm. Docker is needed for CDK synthesis and OpenTofu 1.12.1 for the infrastructure format check. [`.tool-versions`](.tool-versions) pins Node and OpenTofu. With `asdf` installed:

```console
asdf plugin add nodejs https://github.com/asdf-vm/asdf-nodejs.git
asdf plugin add opentofu https://github.com/virtualstaticvoid/asdf-opentofu.git
asdf install
```

Run the repository checks. None of them call AWS:

```console
npm ci
npm run check
npm run tofu:fmt:check
```

`npm run check` covers Prettier, ESLint, release metadata, TypeScript, tests, and builds. See [TESTING.md](TESTING.md) for focused commands and the difference between unit, synthesis, and deployed integration checks.

Never commit `.envrc`, AWS credentials, account IDs, email addresses, domain names, populated backend files, variable files, state, or plans.

## Develop and deploy

Target a workspace without running every package:

```console
npm test --workspace @samlevin/match-to-csv
npm run typecheck --workspace @samlevin/match-to-csv
npm run app:synth -- match-to-csv --environment dev
```

With access to a dev AWS account, you can deploy a named ephemeral stack there. [Self-hosting](docs/self-hosting/README.md) covers the account setup:

```console
npm run app:diff -- match-to-csv --environment dev --ephemeral <name>
npm run app:deploy -- match-to-csv --environment dev --ephemeral <name>
```

Pull requests run CI without deploying and need no AWS access. A merge to `main` deploys affected applications to the maintainer's `dev` environment at the merged commit. Each application then goes to `prod` after the maintainer approves it. Release Please versions applications and shared packages.

See [WORKFLOW.md](WORKFLOW.md) for issue planning, epics, task states, and the agent protocol. [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) defines classification, required metadata, and Inbox reconciliation. See [CONTRIBUTING.md](CONTRIBUTING.md) for the monorepo workflow, component ownership, conventional pull-request titles, and what happens after a merge. To run your own deployment, follow [Self-hosting](docs/self-hosting/README.md).
