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
| `packages/roster` | `@mcc/roster` | Pure gamertag matcher, roster fold, and roster hash |
| `packages/recipients` | `@mcc/recipients` | Pure CSV recipient list fold, hash, and change check |
| `infrastructure/modules` | n/a | Reusable OpenTofu bootstrap, foundation, and data-platform modules |
| `infrastructure/dev` and `infrastructure/prod` | n/a | Environment roots |

Only `match-to-csv` contains a working product pipeline today. The other application workspaces establish stack and release boundaries for planned features. Keep specifications honest about that distinction.

## Set up the repository

Follow [Getting started](docs/getting-started.md) to install the tools and dependencies and to find the checks for each kind of change. Run the complete local gate, `npm run check`, before opening a pull request for application, package, dependency, build configuration, or unclassified changes.

Workspaces use the `@mcc` scope, are never published, and install from the local workspaces. Third-party dependencies come from npmjs.org.

CI picks its checks from the files your pull request changes. [How CI selects checks](TESTING.md#how-ci-selects-checks) explains which gates run for each kind of change and which job is required.

Use `npm run format` and `npm run lint:fix` for automatic corrections. Add or update tests with every behavior change. Preserve immutable evidence semantics in `match-to-csv`: never overwrite source screenshots, provider responses, processing runs, or append-only events.

## Submit a change

Classify issues using [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) and follow [WORKFLOW.md](WORKFLOW.md) to claim one. To run this workflow with Claude Code or Codex, see [.agents/README.md](.agents/README.md). Implement only executable leaf issues; a parent with sub-issues is a container with no branch or PR. Create a focused branch and keep changes inside the smallest useful component boundary. A shared-package change should include every necessary contract migration and consumer update.

Pull-request titles must follow Conventional Commits because Release Please derives versions and release notes from them. Common forms are:

```text
feat(match-to-csv): retain attachment rejection reasons
fix(contracts): require screenshot source hashes
docs: explain the production promotion path
chore: update development tooling
```

Link the pull request to its task or bug with `Closes #<number>`. Reference the immediate parent issue or epic separately using `Parent issue or epic: #<number>`. A pull request closes executable leaf work; container completion follows its children. Labels, assignees, and milestone are copied from the linked issue automatically; nothing assigns people to issues. The Release Please pull request takes no labels from the issues its changelog links; it gets one `package:` label for each package whose version changes in `.release-please-manifest.json`. The `tracker-project-membership.yml` workflow adds every new issue to the MCC delivery project when it opens, however it was created, and an hourly sweep adds any open issue still missing. Pull requests are not added to the project.

Use `feat` for a minor version, `fix` for a patch, and a documented breaking change for a major version.

## What happens after merge

Merging a release pull request deploys each released application to `dev` at its release commit and then, after a required reviewer approves, to `prod`. Ordinary merges and shared-package-only releases deploy nothing. You can follow releases in the Actions run and the repository's Deployments page. [Merge to production](docs/self-hosting/50-deploy-and-release-applications.md#merge-to-production) describes each step.

Foundation changes under `infrastructure/` are applied before they merge. Someone with Terrateam apply access applies them to dev and then prod from your pull request, as [Change the foundation with Terrateam](docs/self-hosting/70-optional-terrateam.md#change-the-foundation-with-terrateam) describes.

Release Please collects merged Conventional Commits into a release pull request. Merging it creates component tags such as `match-to-csv-v1.2.3`, `contracts-v1.1.0`, and `cdk-config-v1.0.4`. Applications pin internal packages at exact versions, and the release pull request patch-bumps consumers when a shared package changes:

- a `cdk-config` release affects `admin`, `data-pipeline`, `match-to-csv`, `ocr-quality`, and `player`;
- a `contracts` release affects `match-to-csv`.

The release pull request updates package versions, changelogs, the root lockfile, and `.release-please-manifest.json` together. `npm run release:check` rejects drift between those files.

## Test against your own AWS account

To deploy an ephemeral stack to your own dev account, send it a test email, and check the result, follow [tier 2 of Getting started](docs/getting-started.md#tier-2-deploy-your-own-ephemeral-stack). It lists the [Self-hosting](docs/self-hosting/README.md) steps your account needs first.

Never commit credentials, account IDs, email addresses, domain names, populated `.envrc` files, `*.auto.tfvars`, state, plans, or local environment files. This is a public repository.

## Change shared infrastructure

Before you add an AWS resource, check which system owns it in [How AWS is divided](README.md#how-aws-is-divided). Check that the Terrateam plan on your foundation pull request matches your intent. See [Change the foundation](docs/self-hosting/40-change-foundation.md) for how foundation pull requests are applied.

When you add or remove a root, a module directory, or a local module call, update `.terrateam/config.yml` in the same pull request, following [Map module calls to roots](docs/self-hosting/70-optional-terrateam.md#map-module-calls-to-roots).

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

- The CDK entry role trusts `_delivery-deploy-environment.yml` by its path, which GitHub puts in the OIDC `job_workflow_ref` claim, so renaming `delivery-deploy-releases.yml` or `delivery-rollback.yml`, changing their `name:`, or adding another caller needs no bootstrap change. To move or rename `_delivery-deploy-environment.yml`, set `cdk_deploy_workflow_path` to the new path in the same pull request and apply bootstrap from that branch in dev and then prod before it merges. [Trusted deployment workflows](docs/self-hosting/10-bootstrap-accounts.md#trusted-deployment-workflows) has the steps.
- The `main` ruleset requires three checks by job name: `Require every check selected for the changed files`, `Scan commits for secrets`, and `Check PR title follows Conventional Commits`. The Terrateam setup also requires the `Require applicable Terrateam applies` commit status from GitHub Actions, which the infrastructure merge gate publishes independently of its evaluator job name. Renaming a required job or status needs a ruleset change when the pull request merges, or later pull requests wait on a check that no longer runs.

## Keep documentation with the code

Update the closest durable document:

- product behavior and operator-facing package details belong in an application README;
- the path from a fresh clone to passing checks and a dev stack, including which checks to run for each kind of change, belongs in `docs/getting-started.md`;
- local and CI test commands belong in `TESTING.md` or a package testing guide;
- setting up and operating a deployment belongs in `docs/self-hosting/`;
- future behavior and acceptance criteria belong in `specs/`;
- repository-wide orientation belongs in this file or the root README;
- instructions that only coding agents follow belong in `AGENTS.md` or `.agents/`.

Documentation and code comments describe the current state: what exists and how to set it up, bootstrap, deploy, and run it. They are not a log of problems and fixes, and they are not ordered by when things happened. This applies to the self-hosting guides, READMEs, these guides, specs, agent instructions, code comments, and any future documentation such as wiki pages. Write how something works, not what it used to do or which change made it so. Change history belongs in pull request descriptions, commit messages, and changelogs. A code comment may keep prior context only to explain an established regression that the code must not reintroduce.

Do not put personal account structure, domain names, email addresses, or maintainer-specific setup in public documentation.
