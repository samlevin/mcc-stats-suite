# MCC Stats Suite

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
runbooks/            AWS setup, foundation, validation, and recovery procedures
```

NPM workspaces provide package boundaries. Turbo follows their dependency graph so root checks run in order and CI can identify affected applications.

## How AWS is divided

OpenTofu owns resources that survive application releases: encrypted storage, KMS keys, state, GitHub OIDC roles, permissions boundaries, the Glue catalog, and SSM parameters that publish resource names and ARNs. Terrateam applies stable foundation changes from pull requests.

CDK owns application compute and orchestration: Lambda functions, Step Functions, EventBridge rules, SES receipt rules, IAM grants, and logs. CDK reads the OpenTofu outputs from SSM Parameter Store. A resource has one owner; do not describe the same AWS resource in both systems.

There are stable `dev` and `prod` environments. GitHub Actions deploys stable application stacks. Local developers may create named ephemeral stacks in the dev account.

```text
match-to-csv-dev         stable integration stack
match-to-csv-<name>      local ephemeral stack in dev
match-to-csv-prod        live stack
```

## Prerequisites

Local TypeScript work requires Git, Node.js 22.16.0, and npm. The repository pins Node and OpenTofu versions in [`.tool-versions`](.tool-versions).

AWS and infrastructure work also requires:

- OpenTofu 1.12.1
- AWS CLI v2 with IAM Identity Center profiles
- `direnv`
- Docker for CDK assets containing Linux ARM64 native dependencies
- access to the project dev or prod AWS account for the task being performed

Stable infrastructure automation also depends on GitHub Actions, GitHub Environments named `dev` and `prod`, and Terrateam. DNS and a verified SES identity are required before `match-to-csv` can receive email.

With `asdf` installed:

```console
asdf plugin add nodejs https://github.com/asdf-vm/asdf-nodejs.git
asdf plugin add opentofu https://github.com/virtualstaticvoid/asdf-opentofu.git
asdf install
npm ci
```

## Start locally

Run the AWS-free repository checks first:

```console
npm ci
npm run check
npm run tofu:fmt:check
```

`npm run check` covers Prettier, ESLint, release metadata, TypeScript, tests, and builds. See [TESTING.md](TESTING.md) for focused commands and the difference between unit, synthesis, and deployed integration checks.

For AWS work, copy the ignored environment template and replace its placeholders:

```console
cp .envrc.example .envrc
direnv allow
aws sso login
aws sts get-caller-identity
```

Never commit `.envrc`, AWS credentials, account IDs, email addresses, domain names, populated backend files, variable files, state, or plans.

## Develop and deploy

Target a workspace without running every package:

```console
npm test --workspace @mcc/match-to-csv
npm run typecheck --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv --environment dev
```

Local deployments must be named ephemeral stacks in dev:

```console
npm run app:diff -- match-to-csv --environment dev --ephemeral <name>
npm run app:deploy -- match-to-csv --environment dev --ephemeral <name>
```

Pull requests run the full CI gate without deploying. A merge to `main` deploys affected applications to stable `dev` at the merged commit SHA. Release Please versions applications and private shared packages. Production promotion is manual and accepts an immutable application release tag after that exact revision succeeds in dev.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the monorepo workflow, component ownership, conventional pull-request titles, and exact dev and prod deployment paths. Use the [runbooks](runbooks/README.md) for account bootstrap, foundation changes, end-to-end validation, and incident recovery.
