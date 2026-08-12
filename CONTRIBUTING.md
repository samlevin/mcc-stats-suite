# Contributing

MCC Stats Suite is an NPM and Turbo monorepo. Each application owns a CDK stack and can be released or deployed independently. Shared packages use exact versions so a change to a common contract produces explicit releases for every affected application.

## Find the right component

| Path | Package | Responsibility |
|---|---|---|
| `applications/match-to-csv` | `@mcc/match-to-csv` | Working email intake and OCR evidence pipeline |
| `applications/ocr-quality` | `@mcc/ocr-quality` | Planned OCR scoring, anomaly detection, and labeling services |
| `applications/admin` | `@mcc/admin` | Planned reviewer API and interface |
| `applications/data-pipeline` | `@mcc/data-pipeline` | Planned Glue and DuckDB lakehouse transformations |
| `applications/player` | `@mcc/player` | Planned read-only statistics API and interface |
| `packages/contracts` | `@mcc/contracts` | Types shared across application boundaries |
| `packages/cdk-config` | `@mcc/cdk-config` | Account checks, environment rules, stack names, and resource prefixes |
| `infrastructure/modules` | n/a | Reusable OpenTofu bootstrap, foundation, and data-platform modules |
| `infrastructure/dev` and `infrastructure/prod` | n/a | Stable environment roots |

Only `match-to-csv` contains a working product pipeline today. The other application workspaces establish stack and release boundaries for planned features. Keep specifications honest about that distinction.

## Set up the repository

Install the versions pinned in `.tool-versions`, then install dependencies from the repository root:

```console
asdf install
npm ci
```

Run the complete local gate before opening a pull request:

```console
npm run check
npm run tofu:fmt:check
```

The first command checks formatting, lint rules, release metadata, types, tests, and builds. Neither command calls AWS. CDK synthesis may use Docker to package Linux ARM64 assets.

Useful focused commands follow the workspace dependency graph:

```console
npm test --workspace @mcc/match-to-csv
npm run typecheck --workspace @mcc/contracts
npm run app:synth -- match-to-csv --environment dev
npm run verify:bundle --workspace @mcc/match-to-csv
```

Use `npm run format` and `npm run lint:fix` for automatic corrections. Add or update tests with every behavior change. Preserve immutable evidence semantics in `match-to-csv`: never overwrite source screenshots, provider responses, processing runs, or append-only events.

## Work with AWS safely

Copy `.envrc.example` to the ignored `.envrc`, fill its placeholders, and run `direnv allow`. Authenticate through IAM Identity Center and verify the account before any diff or deployment:

```console
aws sso login
aws sts get-caller-identity
```

The deployment harness also checks the active account against the selected profile. Do not bypass that check or pass raw CDK context. Use `--environment` and, for local stacks, `--ephemeral`.

Never commit credentials, account IDs, email addresses, domain names, populated `backend.hcl`, `*.auto.tfvars`, state, plans, or local environment files. This is a public repository.

## Submit a change

Create a focused branch and keep changes inside the smallest useful component boundary. A shared-package change should include every necessary contract migration and consumer update.

Pull-request titles must follow Conventional Commits because Release Please derives versions and release notes from them. Common forms are:

```text
feat(match-to-csv): retain attachment rejection reasons
fix(contracts): require screenshot source hashes
docs: explain the production promotion path
chore: update development tooling
```

Use `feat` for a minor version, `fix` for a patch, and a documented breaking change for a major version. CI runs the repository quality gate, CDK synthesis, native bundle verification, and OpenTofu formatting. Pull requests do not deploy applications.

## Understand release versioning

Release Please manages every application plus `@mcc/cdk-config` and `@mcc/contracts`. It creates component tags such as `match-to-csv-v1.2.3`, `contracts-v1.1.0`, and `cdk-config-v1.0.4`.

Applications pin internal packages at exact versions. The Node workspace release plugin updates those pins and patch-bumps consumers when a shared package changes:

- a `cdk-config` release affects `admin`, `data-pipeline`, `match-to-csv`, `ocr-quality`, and `player`;
- a `contracts` release affects `match-to-csv`.

The release pull request updates package versions, changelogs, the root lockfile, and `.release-please-manifest.json` together. `npm run release:check` rejects drift between those files. Shared packages stay private and are not published to npm.

## Deploy one application to dev

There are two dev deployment paths.

### Local ephemeral dev

Use an ephemeral stack for development. Replace `<application>` with `admin`, `data-pipeline`, `match-to-csv`, `ocr-quality`, or `player`.

```console
npm run app:synth -- <application> --environment dev --ephemeral <name>
npm run app:diff -- <application> --environment dev --ephemeral <name>
npm run app:deploy -- <application> --environment dev --ephemeral <name>
```

Only `match-to-csv` needs `MCC_EMAIL_DOMAIN` during deployment. Ephemeral stacks do not enable shared email ingress, so invoke their workflows directly when testing them. Follow [`runbooks/21-deploy-ephemeral-match-to-csv.md`](runbooks/21-deploy-ephemeral-match-to-csv.md) for setup and cleanup.

### Stable dev

Stable dev deploys only from GitHub Actions. Merge the reviewed change to `main`. The `ci` workflow asks Turbo which applications are affected and calls the reusable deployment workflow once for each result. A change confined to one application deploys that application. A shared-package change deploys all consumers.

Open the `ci` run for the merge SHA and verify the application-specific `deploy-dev` job. GitHub records the exact SHA, application version, shared-package versions, and final status in Deployments. Re-run that GitHub Actions job to repeat the same deployment. Do not deploy the plain `dev` stack from a local shell.

## Deploy one application to prod

Production accepts a published application release that already succeeded in stable dev.

1. Merge the application change to `main` and wait for its stable dev deployment.
2. Complete the application’s integration or smoke test. Use [`runbooks/22-validate-match-to-csv-in-dev.md`](runbooks/22-validate-match-to-csv-in-dev.md) for `match-to-csv`.
3. Review and merge the Release Please pull request containing the application release.
4. Wait for Release Please to publish `<application>-v<version>` and for CI to deploy the release commit successfully to dev.
5. Open **GitHub Actions -> promote-aws-application -> Run workflow** from `main`.
6. Select `promote`, select the application, enter its release tag, and run the workflow.
7. Review the production CDK diff and verify the stack health checks and application smoke test.

The workflow rejects draft or prerelease tags, mismatched application versions, commits outside `main`, and revisions without a successful dev deployment for the same application. To restore an older production version, choose `rollback`, supply a release previously deployed successfully to prod, and record the reason. Read [`runbooks/31-release-promote-and-recover-applications.md`](runbooks/31-release-promote-and-recover-applications.md) before operating the prod workflow.

## Change shared infrastructure

OpenTofu owns bootstrap, long-lived storage, encryption keys, SSM contracts, and the lakehouse foundation. CDK owns application compute and orchestration. Do not create a resource in one system if the other already manages it.

Bootstrap is a local administrative procedure. Terrateam plans and applies stable foundation changes from pull requests. Infrastructure changes can affect several applications even when no application source file changed, so follow the ordered procedures in [`runbooks/README.md`](runbooks/README.md).

## Keep documentation with the code

Update the closest durable document:

- product behavior and operator-facing package details belong in an application README;
- local and CI test commands belong in `TESTING.md` or a package testing guide;
- repeatable AWS operations belong in `runbooks/`;
- future behavior and acceptance criteria belong in `specs/`;
- repository-wide orientation belongs in this file or the root README.

Do not put personal account structure, domain names, email addresses, or maintainer-specific setup in public documentation.
