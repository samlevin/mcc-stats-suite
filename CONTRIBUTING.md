# Contributing

MCC Stats Suite is an NPM and Turbo monorepo. Each application owns a CDK stack and can be released or deployed independently. Shared packages use exact versions so a change to a common contract produces explicit releases for every affected application.

You do not need AWS access, secrets, or package registry credentials to contribute. Pull requests run CI without touching AWS.

## Find the right component

| Path | Package | Responsibility |
|---|---|---|
| `applications/match-to-csv` | `@samlevin/match-to-csv` | Working email intake and OCR evidence pipeline |
| `applications/ocr-quality` | `@samlevin/ocr-quality` | Planned OCR scoring, anomaly detection, and labeling services |
| `applications/admin` | `@samlevin/admin` | Planned reviewer API and interface |
| `applications/data-pipeline` | `@samlevin/data-pipeline` | Planned Glue and DuckDB lakehouse transformations |
| `applications/player` | `@samlevin/player` | Planned read-only statistics API and interface |
| `packages/contracts` | `@samlevin/contracts` | Types shared across application boundaries |
| `packages/cdk-config` | `@samlevin/cdk-config` | Account checks, environment rules, stack names, and resource prefixes |
| `infrastructure/modules` | n/a | Reusable OpenTofu bootstrap, foundation, and data-platform modules |
| `infrastructure/dev` and `infrastructure/prod` | n/a | Environment roots |

Only `match-to-csv` contains a working product pipeline today. The other application workspaces establish stack and release boundaries for planned features. Keep specifications honest about that distinction.

## Set up the repository

Install the versions pinned in `.tool-versions`, then install dependencies from the repository root:

```console
asdf install
npm ci
```

Workspaces use the `@samlevin` scope and install from the local workspaces. Third-party dependencies come from npmjs.org.

For application, package, infrastructure, dependency, build configuration, or unclassified changes, run the complete local gate before opening a pull request:

```console
npm run check
npm run tofu:fmt:check
```

For documentation-only changes, run `npm run format:check`. For repository-only changes recognized by `scripts/ci-scope.mjs`, also run `npx eslint scripts/ci-scope.mjs scripts/issue-*.mjs --max-warnings 0` and `node --test scripts/issue-*.test.mjs`. These paths do not run workspace tests, builds, CDK synthesis, or OpenTofu checks. CI uses committed changed files and the baseline classifier, never PR titles or labels, to select checks. Changes to CI selection, dependencies, build configuration, and unknown paths always run the full gate. The classifier is read from the PR base or previous main commit; its first introduction runs the full gate.

The first command checks formatting, lint rules, release metadata, types, tests, and builds. Neither command calls AWS. CDK synthesis may use Docker to package Linux ARM64 assets.

Useful focused commands follow the workspace dependency graph:

```console
npm test --workspace @samlevin/match-to-csv
npm run typecheck --workspace @samlevin/contracts
npm run app:synth -- match-to-csv --environment dev
npm run verify:bundle --workspace @samlevin/match-to-csv
```

Use `npm run format` and `npm run lint:fix` for automatic corrections. Add or update tests with every behavior change. Preserve immutable evidence semantics in `match-to-csv`: never overwrite source screenshots, provider responses, processing runs, or append-only events.

## Submit a change

Classify issues using [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) and follow [WORKFLOW.md](WORKFLOW.md) to claim one. Implement only executable leaf issues; a parent with sub-issues is a container with no branch or PR. Create a focused branch and keep changes inside the smallest useful component boundary. A shared-package change should include every necessary contract migration and consumer update.

Pull-request titles must follow Conventional Commits because Release Please derives versions and release notes from them. Common forms are:

```text
feat(match-to-csv): retain attachment rejection reasons
fix(contracts): require screenshot source hashes
docs: explain the production promotion path
chore: update development tooling
```

Link the pull request to its task or bug with `Closes #<number>`. Reference the immediate parent issue or epic separately using `Parent issue or epic: #<number>`. A pull request closes executable leaf work; container completion follows its children. Labels, milestone, and project membership are copied from the linked issue automatically.

Use `feat` for a minor version, `fix` for a patch, and a documented breaking change for a major version. CI runs independent repository checks and workspace tasks concurrently in one ARM64 job. Narrow workspace PRs use Turbo affected selection, including downstream consumers; full-scope main pushes validate every workspace before deployment. CI retains CDK synthesis, native bundle verification, and OpenTofu formatting. See `TESTING.md` for cache boundaries and selection tests. Pull requests do not deploy applications.

## What happens after merge

A merge to `main` deploys every affected application to the maintainer's `dev` environment at the merged commit. Each application then goes to `prod` after the maintainer approves it. You can follow it in the repository's Deployments page, but you do not run it.

Foundation changes under `infrastructure/` work differently. The maintainer applies them to dev and then prod from your pull request, and Terrateam merges the pull request when both have applied.

Release Please collects merged Conventional Commits into a release pull request. Merging it creates component tags such as `match-to-csv-v1.2.3`, `contracts-v1.1.0`, and `cdk-config-v1.0.4`. Applications pin internal packages at exact versions, and the release pull request patch-bumps consumers when a shared package changes:

- a `cdk-config` release affects `admin`, `data-pipeline`, `match-to-csv`, `ocr-quality`, and `player`;
- a `contracts` release affects `match-to-csv`.

The release pull request updates package versions, changelogs, the root lockfile, and `.release-please-manifest.json` together. `npm run release:check` rejects drift between those files.

## Test against your own AWS account

To deploy an ephemeral stack, you need your own dev account set up with [Self-hosting](docs/self-hosting/README.md). Copy `.envrc.example` to the ignored `.envrc`, fill its placeholders, run `direnv allow`, and verify the account before any diff or deployment:

```console
aws sso login
aws sts get-caller-identity
npm run app:deploy -- <application> --environment dev --ephemeral <name>
```

The deployment harness checks the active account against the selected profile. Do not bypass that check or pass raw CDK context. Use `--environment` and `--ephemeral`.

Never commit credentials, account IDs, email addresses, domain names, populated `backend.hcl`, `*.auto.tfvars`, state, plans, or local environment files. This is a public repository.

## Change shared infrastructure

OpenTofu owns bootstrap, long-lived storage, encryption keys, SSM contracts, and the lakehouse foundation. CDK owns application compute and orchestration. Do not create a resource in one system if the other already manages it. Terrateam posts a plan on pull requests that change the foundation; check that it matches your intent. See [Change the foundation](docs/self-hosting/40-change-foundation.md) for how foundation pull requests are applied.

## Keep documentation with the code

Update the closest durable document:

- product behavior and operator-facing package details belong in an application README;
- local and CI test commands belong in `TESTING.md` or a package testing guide;
- setting up and operating a deployment belongs in `docs/self-hosting/`;
- future behavior and acceptance criteria belong in `specs/`;
- repository-wide orientation belongs in this file or the root README.

Do not put personal account structure, domain names, email addresses, or maintainer-specific setup in public documentation.
