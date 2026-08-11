# MCC Stats Suite

Converts MCC post-game summaries to structured data through OCR and ML.
Includes a data lakehouse and full stack application for data analytics.

AWS serverless monorepo powered by NPM workspaces, TurboRepo, CDK, and TypeScript.

## At a glance

| Boundary | Tool | Owns |
|---|---|---|
| Bootstrap | Manual: OpenTofu via SSO | State, OIDC, deployment roles, workload boundary |
| Foundation | Automated: OpenTofu via GitOps (Terrateam) | S3, KMS, event notification, SSM contracts |
| Analytics | Both: Local and GitOps (Actions) CDK | Lambda, Step Functions, SES, IAM, logs |

OpenTofu owns resources and data that transcend business logic.
CDK owns deployable compute and orchestration for applications and data engineering.
OpenTofu publishes resource names and ARNs through SSM Parameter Store. CDK consumes them.

No resource is managed by both tools.

`match-to-csv` processes each image attachment in an inbound email independently:

```text
email stored in S3
  -> create immutable source screenshots
  -> for each screenshot: create a processing run -> Textract -> normalized OCR
  -> write an extracted CSV
```

Each stage is a standalone Lambda. Step Functions passes S3 references rather
than image bytes.

## Environment model

GitHub Actions deploys one integration stack in dev and one live stack in
prod. Local developers can create explicitly named ephemeral stacks in dev.

```text
match-to-csv-dev         integration and smoke-test stack (dev account)
match-to-csv-sam         explicit ephemeral stack (dev account)
match-to-csv-prod        live application stack (prod account)
```

dev and prod each have a foundation state plus a separate bootstrap
state. Application and data lakehouse are intentionally separate.

## Repository map

```text
applications/match-to-csv/       Post-match summary conversion
applications/*/                  Future application boundaries
packages/cdk-config/             Shared account checks and stack naming
packages/contracts/              Shared TypeScript contracts
infrastructure/                  Dev/prod roots and reusable OpenTofu modules
runbooks/                        Project setup, deployment, and validation
```

## Prerequisites

Install:

- Git
- Node.js 22.16.0 and npm
- OpenTofu 1.12.1
- AWS CLI v2
- direnv
- Docker for Linux/ARM Lambda assets containing Sharp

You also need:

- AWS accounts named or treated as `dev` and `prod`;
- SSO-backed local profiles with access to those accounts;
- Post-matchroject state buckets and repository-scoped deployment roles;
- DNS access for an SES inbound domain or recipient.

Optional but encouraged:
- Terrateam for GitOps (free plan)
- asdf for node.js and OpenTofu

The repository pins Node and OpenTofu in `.tool-versions`. With asdf:

```console
asdf plugin add nodejs https://github.com/asdf-vm/asdf-nodejs.git
asdf plugin add opentofu https://github.com/virtualstaticvoid/asdf-opentofu.git
asdf install
npm ci
```

Create your local environment file from the provided template, replace every
placeholder, and authorize it:

```console
cp .envrc.example .envrc
direnv allow
```

It selects the dev SSO profile and supplies its account ID, Region,
GitHub identity, and OpenTofu bootstrap inputs. The dev and prod bootstrap
directories have their own `.envrc.example` files; copy and allow those
immediately before bootstrapping the corresponding account.

Verify:

```console
node --version
tofu version
aws --version
npm run check
npm run tofu:fmt:check
```

## Local development

At the repository root, direnv selects the dev profile. Verify:

```console
aws sso login
aws sts get-caller-identity
```

The CDK harness verifies the active account against the profile's
`sso_account_id` and infers the environment from the profile name. It passes
CDK's `environment`, `ephemeral`, and expected-account context dynamically;
do not set CDK context in `.envrc`:

```console
npm run app:synth -- match-to-csv
npm run app:diff -- match-to-csv
npm run app:deploy -- match-to-csv --ephemeral sam
```

GitHub Actions deploys the plain dev and prod environments from `main`.
Local deployment requires `--ephemeral <name>` and is only allowed in dev.

Populated `backend.hcl`, `*.auto.tfvars`, state, plan, token, and environment
files are ignored. **Never store AWS access keys in GitHub, Terrateam, or this
repository.**

After validating the prerequisites, follow the [project runbooks](runbooks/README.md).
See [TESTING.md](TESTING.md) for automated tests.
