# Contributing

MCC Stats Suite is an NPM and Turbo monorepo. Each application owns a CDK stack and can be released or deployed independently. Shared packages use exact versions so a change to a common contract produces explicit releases for every affected application.

You do not need AWS access, secrets, or package registry credentials to contribute. Pull requests run CI without touching AWS.

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
| `infrastructure/dev` and `infrastructure/prod` | n/a | Environment roots |

Only `match-to-csv` contains a working product pipeline today. The other application workspaces establish stack and release boundaries for planned features. Keep specifications honest about that distinction.

## Set up the repository

Follow [Getting started](docs/getting-started.md) to install the tools and dependencies and to find the checks for each kind of change. Run the complete local gate, `npm run check`, before opening a pull request for application, package, dependency, build configuration, or unclassified changes.

Workspaces use the `@mcc` scope, are never published, and install from the local workspaces. Third-party dependencies come from npmjs.org.

OpenTofu source and configuration files under `infrastructure/` select the separate AWS-free `check-infrastructure` job on PRs and main pushes. Unknown paths and `.terrateam/config.yml` run it alongside the application gate; application and package changes do not run it. It checks OpenTofu formatting, validates every dev/prod root without backends or inputs (including the inactive data-platform roots), and runs every module test suite. Infrastructure-only changes skip `check-workspaces`. The required `require-scoped-checks` job aggregates the selected gates. Run the infrastructure commands in [TESTING.md](TESTING.md) locally.

Documentation-only and repository-only changes recognized by `scripts/ci-scope.mjs` run only the checks the [Getting started table](docs/getting-started.md#choose-the-checks-for-your-change) lists for them. They do not run workspace tests, builds, CDK synthesis, or OpenTofu checks. CI uses committed changed files and the baseline classifier, never PR titles or labels, to select checks. Changes to CI selection, dependencies, build configuration, and unknown paths always run the full gate. The classifier is read from the PR base or previous main commit; its first introduction runs the full gate.

Use `npm run format` and `npm run lint:fix` for automatic corrections. Add or update tests with every behavior change. Preserve immutable evidence semantics in `match-to-csv`: never overwrite source screenshots, provider responses, processing runs, or append-only events.

## Submit a change

Classify issues using [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) and follow [WORKFLOW.md](WORKFLOW.md) to claim one. If you work with Claude Code or Codex, the repository's own `mcc-` agents and skills run this workflow for you without touching your personal agent configuration; [.agents/README.md](.agents/README.md) explains how to invoke them and what each tool needs. Implement only executable leaf issues; a parent with sub-issues is a container with no branch or PR. Create a focused branch and keep changes inside the smallest useful component boundary. A shared-package change should include every necessary contract migration and consumer update.

Pull-request titles must follow Conventional Commits because Release Please derives versions and release notes from them. Common forms are:

```text
feat(match-to-csv): retain attachment rejection reasons
fix(contracts): require screenshot source hashes
docs: explain the production promotion path
chore: update development tooling
```

Link the pull request to its task or bug with `Closes #<number>`. Reference the immediate parent issue or epic separately using `Parent issue or epic: #<number>`. A pull request closes executable leaf work; container completion follows its children. Labels, assignees, milestone, and project membership are copied from the linked issue automatically; nothing assigns people to issues.

Use `feat` for a minor version, `fix` for a patch, and a documented breaking change for a major version. The ARM64 `check-workspaces` job runs repository checks, `build`, and `ci:test` concurrently, while the parallel `check-bundles` job runs `ci:synth` and `verify:bundle`; the required `require-scoped-checks` job aggregates selected results. Narrow workspace PRs use Turbo affected selection, including downstream consumers; full-scope main pushes validate every workspace before deployment. The bundles job retains CDK synthesis and native bundle verification. Infrastructure-only main pushes save an empty deployment selection and deploy no applications. See `TESTING.md` for cache boundaries and selection tests. Pull requests do not deploy applications.

## What happens after merge

A merge to `main` deploys every affected application to the project's `dev` environment at the merged commit. Each application then goes to `prod` after a required reviewer approves its `prod` deployment. You can follow it in the repository's Deployments page, but you do not run it.

Foundation changes under `infrastructure/` work differently. Someone with Terrateam apply access applies them to dev and then prod from your pull request, and Terrateam merges the pull request when both have applied. Terrateam runs in the `infra/foundation-dev` and `infra/foundation-prod` GitHub Environments, which have no required reviewers; Terrateam's access control, not the `prod` deployment approval, gates the prod apply.

Release Please collects merged Conventional Commits into a release pull request. Merging it creates component tags such as `match-to-csv-v1.2.3`, `contracts-v1.1.0`, and `cdk-config-v1.0.4`. Applications pin internal packages at exact versions, and the release pull request patch-bumps consumers when a shared package changes:

- a `cdk-config` release affects `admin`, `data-pipeline`, `match-to-csv`, `ocr-quality`, and `player`;
- a `contracts` release affects `match-to-csv`.

The release pull request updates package versions, changelogs, the root lockfile, and `.release-please-manifest.json` together. `npm run release:check` rejects drift between those files.

## Test against your own AWS account

To deploy an ephemeral stack to your own dev account, send it a test email, and check the result, follow [tier 2 of Getting started](docs/getting-started.md#tier-2-deploy-your-own-ephemeral-stack). It lists the [Self-hosting](docs/self-hosting/README.md) steps your account needs first.

Never commit credentials, account IDs, email addresses, domain names, populated `.envrc` files, `*.auto.tfvars`, state, plans, or local environment files. This is a public repository.

## Change shared infrastructure

OpenTofu owns bootstrap, long-lived storage, encryption keys, SSM contracts, and the lakehouse foundation. CDK owns application compute and orchestration. Do not create a resource in one system if the other already manages it. Terrateam posts a plan on pull requests that change the foundation; check that it matches your intent. See [Change the foundation](docs/self-hosting/40-change-foundation.md) for how foundation pull requests are applied.

## Name GitHub Actions workflows

Workflow names show up in the Actions sidebar and in every pull request's check list, so a reader should be able to tell what a run does without opening the YAML. `scripts/workflow-names.test.mjs` enforces the parts of this convention that a test can check.

1. Name files `<area>-<purpose>.yml` in kebab-case. The areas are `ci`, `release`, `delivery`, and `tracker`. Reusable workflows start with `_`, for example `_delivery-deploy-environment.yml`.
2. Write the workflow `name:` as `<Area>: <purpose>` in sentence case, such as `CI: checks`. Reusable workflow names end with ` (reusable)`.
3. Make job IDs kebab-case and start them with a verb, such as `check-workspaces`.
4. Give every job a sentence-case `name:` that starts with a verb and names what it acts on. Matrix and reusable jobs put the application and environment in the name, such as `Deploy match-to-csv to prod`. A check then reads `CI: checks / Build and test affected workspaces`.
5. Give every step a `name:`, including `uses:` steps (`Check out repository`, `Set up Node.js`, `Install dependencies`).
6. Write the environments as `dev` and `prod`, never `production`.
7. A workflow not started by a pull request or push sets a `run-name` that names its subject, such as the commit, application, or release.

`.github/workflows/terrateam.yml` keeps the vendor's names. Terrateam marks the file DO NOT MODIFY and reports its own `terrateam apply` check.

Two kinds of rename need more than a code change:

- The CDK entry role trusts the deployment workflows by their `name:`, which GitHub puts in the OIDC `workflow` claim. To rename `delivery-deploy.yml` or `delivery-rollback.yml`, or to add another caller of `_delivery-deploy-environment.yml`, add the new name to `cdk_workflow_names` and apply bootstrap in dev and then prod before the rename merges. [Trusted deployment workflows](docs/self-hosting/10-bootstrap-accounts.md#trusted-deployment-workflows) has the steps.
- The `main` ruleset requires three checks by job name: `Require every check selected for the changed files`, `Scan commits for secrets`, and `Check PR title follows Conventional Commits`. Renaming one of those jobs needs a ruleset change when the pull request merges, or later pull requests wait on a check that no longer runs.

## Keep documentation with the code

Update the closest durable document:

- product behavior and operator-facing package details belong in an application README;
- the path from a fresh clone to passing checks and a dev stack, including which checks to run for each kind of change, belongs in `docs/getting-started.md`;
- local and CI test commands belong in `TESTING.md` or a package testing guide;
- setting up and operating a deployment belongs in `docs/self-hosting/`;
- future behavior and acceptance criteria belong in `specs/`;
- repository-wide orientation belongs in this file or the root README.

Do not put personal account structure, domain names, email addresses, or maintainer-specific setup in public documentation.
