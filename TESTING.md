# Repository testing

[Getting started](docs/getting-started.md) covers installing the repository and lists the checks to run for each kind of change. This guide explains what those checks cover and how CI selects them. From the repository root, `npm test` runs the repository script tests and then every workspace's tests.

`npm run check`, the full local quality gate, verifies Prettier formatting and ESLint rules before typechecking, tests, and builds. Prettier ignores Markdown, so ESLint's Markdown rules are the only check on `.md` files. Use `npm run format` and `npm run lint:fix` to apply safe automatic fixes. `lint:fix` fixes code only, so fix Markdown problems by hand.

## Workspace tests

Target one logical application with npm's workspace flag:

```console
npm test --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv
```

Current application guidance:

- [`applications/match-to-csv/TESTING.md`](applications/match-to-csv/TESTING.md)
- [`packages/cdk-config/TESTING.md`](packages/cdk-config/TESTING.md)
- [`packages/roster/TESTING.md`](packages/roster/TESTING.md)
- [`packages/recipients/TESTING.md`](packages/recipients/TESTING.md)

Every application workspace participates in the root checks and can be targeted independently by the deployment workflow.

`npm test` is AWS-free. CDK synth verifies infrastructure structure. After a release PR merges, delivery verifies each released application's dev stack, as [Merge to production](docs/self-hosting/50-deploy-and-release-applications.md#merge-to-production) describes. Run the full email integration test before promoting a material ingestion or processing change.

## Issue automation tests

The AWS-free issue automation tests cover triage eligibility, pagination, idempotency, and metadata changes before mutation. PR metadata tests cover description links, multiple issues, milestone conflicts, existing metadata, and dry runs. Project membership tests cover adding new issues, rejecting pull requests before API calls, items already in the project, sweeps that add only missing open issues, dry-run sweeps, a sweep that continues past one failing issue, and the workflow's triggers, schedule offset, dry-run default, and trusted checkout. The GitHub API tests cover how every script reads GitHub's responses and reports its errors, rate limits, and missing `gh`:

```console
node --test scripts/github-api.test.mjs scripts/issue-*.test.mjs
```

These tests use metadata mocks and never call GitHub. [Automation](WORKFLOW.md#automation) describes what the tracker workflows do and which credentials they use.

Preview the tracker workflows with `PR_NUMBER=<number> node scripts/issue-pr-status.mjs`, `PR_NUMBER=<number> node scripts/issue-pr-metadata.mjs`, `CONTENT_TYPE=issue CONTENT_NUMBER=<number> node scripts/issue-project-membership.mjs`, or `SWEEP=true node scripts/issue-project-membership.mjs`; all of them default to a dry run. A live read-only check uses `node scripts/issue-triage.mjs --issue <number> --dry-run` with authenticated local `gh`.

## How CI selects checks

CI selects checks from the committed changed files, using the baseline classifier `scripts/ci-scope.mjs` and GitHub's commit comparison API. The `detect-changes` job reads the classifier from the PR base or the previous `main` commit before either gate runs, so the commit that first introduces it runs the full gate. PR titles and labels never control selection. Renames inspect both removed and added paths.

Pull requests and pushes to `main` select gates by these rules:

- Markdown-only changes run formatting and Markdown lint. Recognized repository-only changes also run repository lint and issue-automation tests. Neither runs workspace tests or builds, CDK synthesis, bundle validation, or OpenTofu checks. The [Getting started table](docs/getting-started.md#choose-the-checks-for-your-change) lists the same checks to run locally.
- Application and package code runs the full application gate.
- Dependencies, build configuration, CI selection, `.terrateam/config.yml`, and unknown paths run the full application gate and the infrastructure gate.
- OpenTofu source and configuration files (`*.tf`, `*.tfvars`, and `*.hcl`) under `infrastructure/` select only the infrastructure gate. Infrastructure-only changes skip the application checks, including `check-workspaces`.

The required `require-scoped-checks` job, shown as `Require every check selected for the changed files`, runs on `ubuntu-latest`. It waits for each selected gate and fails when one fails.

### Application gate

The ARM64 `check-workspaces` job installs dependencies once, prepares shared declarations for lint, and runs repository checks alongside one Turbo run of `build` and `ci:test`; it does no Docker work. CI skips `typecheck` because `build` already type-checks every source and test file; local `npm run check` keeps it.

`ci:test` depends on `^build` only, because application tests run the sources. `@mcc/cdk-config#ci:test` also waits for its own build because its tests load `dist`.

The parallel ARM64 `check-scripts` job runs only for full-scope changes, on its own runner so the root script tests do not compete with the workspace tests for CPUs. It runs the root Turbo task `//#test:scripts`, which runs every `scripts/*.test.mjs` file except the GitHub automation tests; those run in `check-workspaces`, only for repository-scope changes. The task waits for the four shared package builds, whose `dist` the tests load. Its `inputs` in `turbo.json` cover `scripts/`, `.github/`, `.terrateam/`, `infrastructure/`, every workspace, the local CDK deployer policy templates under `docs/self-hosting/policies/`, and the root configuration files, so Turbo replays it from cache only when none of those changed. Add a path to those inputs when a root test starts reading a file outside them.

The parallel ARM64 `check-bundles` job runs only for full-scope changes. It starts pulling the digest-pinned bundling image before `npm ci`, then runs `ci:synth` and `verify:bundle`. `ci:synth` always synthesizes dev ephemeral stacks; `verify:bundle` waits for the `match-to-csv` synthesis and checks the Linux ARM64 Sharp assets. The bundling image pin lives in `applications/match-to-csv/cdk/lib/bundling.ts`, which explains how to update it.

For a PR confined to known workspaces, Turbo checks changed workspaces and downstream consumers by filtering on the CI base and head (`--filter=...[<base>...<head>]`, which matches `--affected`). `check-scripts` filters on the root package alone, so `//#test:scripts` runs on every full-scope change. A `contracts` change checks `roster`, `recipients`, and `match-to-csv`; a `cdk-config` change checks all five applications. Root configuration, CI selection, root dependencies, unknown paths, and every full-scope push to `main` check all workspaces, so `main` validates every workspace. Release pull requests pass the required checks before merging.

### Infrastructure gate

The AWS-free `check-infrastructure` job runs `tofu fmt -check -recursive infrastructure`, then initializes and validates every root under `infrastructure/<environment>/` without backends or inputs. Those are currently bootstrap, foundation, and data-platform in dev and prod. The inactive data-platform roots are included because they validate without inputs.

It then runs each `infrastructure/modules/<module>/tests` suite through the already initialized dev root of the same name, and fails if a suite has no such root. Those suites use fake credentials and overrides; CI never assumes an AWS role for this job. CI caches provider downloads by runner OS, architecture, and the OpenTofu lock files.

Run the same infrastructure checks locally with the OpenTofu version pinned in `.tool-versions`. The script fails when that pin, `infrastructure/.tool-versions`, and `.terrateam/config.yml` disagree:

```sh
npm run tofu:check
```

### Deployment selection

The release workflow reads Release Please's per-path release outputs and selects only applications. Ordinary merges and shared-package-only releases deploy nothing. Each selected application's release commit deploys to dev and then waits for prod approval. Pull requests never deploy. [Merge to production](docs/self-hosting/50-deploy-and-release-applications.md#merge-to-production) describes the deployment that follows.

## Caches

Npm downloads use the setup-node cache. Trusted `main` validation and deployment builds can use a remote Turbo cache in S3. Same-repo pull requests read the dev cache through a read-only role and never write it; fork pull requests use only their ephemeral local Turbo cache. [Turborepo cache storage contract](infrastructure/README.md#turborepo-cache-storage-contract) describes its buckets, the cache role, and its trust policy, and [Turbo cache](docs/self-hosting/30-configure-github.md#turbo-cache) covers activation and account settings. Synthesis and native verification are never cached.

## Cancellation and benchmarks

Only superseded PR runs are cancelled. Main uses a unique run group and never cancels earlier validation or deployment jobs.

To measure wall time, compare the `CI: checks` run start with the last job completion. To measure runner time, sum the job start-to-completion intervals. Retain Turbo summaries and cache restore logs when benchmarking. Include cold and warm runs, record synthesis and bundle results, and compare full-scope PRs with full-scope baselines before claiming a performance improvement.

## CI and delivery tests

Run the selection, concurrency, failure propagation, cache policy, and deployment guard tests with:

```console
node --test scripts/ci-checks.test.mjs
```

Application delivery regression checks run with `node --test scripts/deployment-workflows.test.mjs`. They use workflow definitions and mocked GitHub responses to verify release selection, exact release commits, required production approval protection, and account checks without AWS calls. The same suite checks per-application dev-success gating, shared deployment queues, stale-version skips and the rollback exception with prior prod qualification. It also runs the Slack deploy message steps with a mocked webhook to check each message's text, that every caller passes `SLACK_DEPLOY_WEBHOOK_URL` explicitly, that each Slack step runs only when the secret is set, and that a failed post only warns.

`node --test scripts/workflow-names.test.mjs` checks workflow, job, and step names against the convention in [CONTRIBUTING.md](CONTRIBUTING.md#name-github-actions-workflows), including the three check names the `main` ruleset requires.

`node --test scripts/workflow-timeouts.test.mjs` checks that every workflow job sets `timeout-minutes`. A job that only calls a reusable workflow is exempt, because GitHub does not allow the key there; the called workflow's jobs set it instead. CI runs it in the full gate and for changes in the repository scope, such as the `tracker-*.yml` workflows. Pick a value above the job's longest recent successful run.
