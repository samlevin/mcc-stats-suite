# Repository testing

Install once and run every workspace from the repository root:

```console
npm ci
npm test
```

The AWS-free issue automation tests cover triage eligibility, pagination, idempotency, and metadata changes before mutation. PR metadata tests cover description links, multiple issues, milestone conflicts, existing metadata, and dry runs:

```console
node --test scripts/issue-*.test.mjs
```

These tests use metadata mocks and never call GitHub. When a non-draft PR is opened, edited, reopened, or marked ready for review, the separate `tracker-pr-issue-status.yml` workflow moves open issues named by closing keywords to `In review` in MCC delivery: from `In progress` for any author, and also from `Ready` for the owner and collaborators. Other statuses and ordinary issue mentions are skipped, and each skip is logged with its reason. Status lookup failures do not block the metadata workflow. Preview with `PR_NUMBER=<number> node scripts/issue-pr-status.mjs` or `PR_NUMBER=<number> node scripts/issue-pr-metadata.mjs`; both default to a dry run. A live read-only check uses `node scripts/issue-triage.mjs --issue <number> --dry-run` with authenticated local `gh`; see [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) for workflow credentials and activation.

The full local quality gate is:

```console
npm run check
```

`npm run check` verifies Prettier formatting and ESLint rules before typechecking, tests, and builds. Use `npm run format` and `npm run lint:fix` to apply safe automatic fixes. CI selects checks from changed files using the committed baseline `scripts/ci-scope.mjs` and GitHub's commit comparison API. Markdown-only changes run formatting; recognized repository-only changes also run repository lint and issue-automation tests. They skip workspace tests/builds, CDK synthesis, bundle validation, and OpenTofu checks. Application and package code runs the full application gate. Dependencies, CI selection, `.terrateam/config.yml`, and unknown paths run the full application gate and the infrastructure gate. OpenTofu source and configuration files (`*.tf`, `*.tfvars`, and `*.hcl`) under `infrastructure/` select the separate `check-infrastructure` job. Infrastructure-only changes skip application checks. The required `require-scoped-checks` job, shown as `Require every check selected for the changed files`, waits for each selected gate and fails when one fails. Titles and labels never control selection. Renames inspect both removed and added paths. A single selector job publishes the main push deployment artifact after the required gate succeeds.

Target one logical application with npm's workspace flag:

```console
npm test --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv
```

Current application guidance:

- [`applications/match-to-csv/TESTING.md`](applications/match-to-csv/TESTING.md)
- [`packages/cdk-config/TESTING.md`](packages/cdk-config/TESTING.md)

Every application workspace participates in the root checks and can be targeted independently by the deployment workflow.

`npm test` is AWS-free. CDK synth verifies infrastructure structure. After a merge to `main`, CI deploys affected applications to `dev` and verifies the resulting CloudFormation stack. The `match-to-csv` check also requires its Lambda functions and Step Functions state machines to be active. Run the full email integration test before promoting a material ingestion or processing change.

## Concurrent CI checks

The `detect-changes` job reads the baseline classifier before either gate runs. The required `require-scoped-checks` job aggregates the selected gates on `ubuntu-latest`. The ARM64 `check-workspaces` job installs dependencies once, prepares shared declarations for lint, and runs repository checks alongside Turbo `build` and `ci:test`; it does no Docker work. CI skips `typecheck` because `build` already type-checks every source and test file; local `npm run check` keeps it. `ci:test` depends on `^build` only, because application tests run the sources; `@mcc/cdk-config#ci:test` also waits for its own build because its tests load `dist`. The parallel ARM64 `check-bundles` job starts pulling the digest-pinned bundling image before `npm ci` and runs `ci:synth` and `verify:bundle`; it runs only for full-scope changes. `ci:synth` always synthesizes dev ephemeral stacks; `verify:bundle` waits for the `match-to-csv` synthesis and checks the Linux ARM64 Sharp assets. The bundling image pin lives in `applications/match-to-csv/cdk/lib/bundling.ts`, which explains how to update it. Synthesis and native verification are never cached.

For a PR confined to known workspaces, Turbo `--affected` checks changed workspaces and downstream consumers. A `contracts` change checks `match-to-csv`; a `cdk-config` change checks all five applications. Root configuration, mixed infrastructure/application changes, CI selection, dependencies at the root, unknown paths, and every full-scope push to `main` check all workspaces. Unknown paths also run OpenTofu checks; application and package changes do not. The baseline classifier controls documentation and recognized repository checks. Deployment requires successful CI and remains limited to pushes to `main`. Infrastructure-only pushes publish an empty application selection, so `Delivery: deploy to dev then prod` completes without deploying.

The AWS-free `check-infrastructure` job runs `tofu fmt -check -recursive infrastructure`, then initializes and validates every root under `infrastructure/<environment>/`, currently bootstrap, foundation, and data-platform in dev and prod. The inactive data-platform roots are included because they validate without inputs. It runs each `infrastructure/modules/<module>/tests` suite through the already initialized dev root of the same name, and fails if a suite has no such root. Those suites use fake credentials and overrides; CI never assumes an AWS role for this job. CI caches provider downloads by runner OS, architecture, and the OpenTofu lock files.

Run the same infrastructure checks locally with the OpenTofu version pinned in `.tool-versions`. The script fails when that pin, `infrastructure/.tool-versions`, and `.terrateam/config.yml` disagree:

```sh
npm run tofu:check
```

Run the selection, concurrency, failure propagation, cache policy, and deployment guard tests with:

```console
node --test scripts/ci-checks.test.mjs
```

Npm downloads use the setup-node cache. Trusted main validation uses the dev S3 Turbo bucket through `rharkor/caching-for-turbo@v2.5.1`. Dev deployments use that bucket; production promotion and rollback builds use the prod bucket. A dedicated OIDC cache role resolves and validates the environment's bucket and KMS SSM contracts. OS, architecture, and Node version isolate object prefixes. `MCC_BUILD_ENVIRONMENT` participates in Turbo task hashes, and the explicitly worktree-local cache prevents another checkout from supplying outputs. Each deployment job has a fresh runner and exactly one environment, including historical releases whose Turbo configuration predates this hash input.

Pull requests use only their ephemeral local Turbo cache and never assume a cache role. The main-only role trust policy rejects PR subjects and refs. The remote API credentials are passed explicitly from the cache role to the action, including its session token; later CDK credentials cannot replace that session. AWS credentials are removed from the build environment after the server starts. Synthesis and native verification remain uncached. The action performs prefix-scoped bucket listing for hash lookup, but has no deletion grant or action cleanup settings. Both buckets expire objects after seven days through S3 lifecycle.

For cache activation and account settings, see [Turbo cache](docs/self-hosting/30-configure-github.md#turbo-cache).

Only superseded PR runs are cancelled. Main uses a unique run group and never cancels earlier validation or deployment jobs. Compare the `CI: checks` run start with the last job completion for wall time, sum job start-to-completion intervals for runner time, and retain Turbo summaries and cache restore logs when benchmarking. Include cold and warm runs, record synthesis/bundle results, and compare full-scope PRs with full-scope baselines before claiming a performance improvement.

Application delivery regression checks run with `node --test scripts/deployment-workflows.test.mjs`. They use workflow definitions and mocked GitHub responses to verify trusted CI qualification, exact-SHA handoff, independent dev-success gating, and required production approval protection without AWS calls. `node --test scripts/workflow-names.test.mjs` checks workflow, job, and step names against the convention in [CONTRIBUTING.md](CONTRIBUTING.md#name-github-actions-workflows), including the three check names the `main` ruleset requires.
