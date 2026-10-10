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

These tests use metadata mocks and never call GitHub. When a non-draft PR opens or becomes ready for review, the separate `pr-issue-status` workflow moves open issues named by closing keywords from `In progress` to `In review` in MCC delivery. Other statuses and ordinary issue mentions are skipped. Status lookup failures do not block the metadata workflow. Preview with `PR_NUMBER=<number> node scripts/issue-pr-status.mjs` or `PR_NUMBER=<number> node scripts/issue-pr-metadata.mjs`; both default to a dry run. A live read-only check uses `node scripts/issue-triage.mjs --issue <number> --dry-run` with authenticated local `gh`; see [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) for workflow credentials and activation.

The full local quality gate is:

```console
npm run check
npm run tofu:fmt:check
```

`npm run check` verifies Prettier formatting and ESLint rules before typechecking, tests, and builds. Use `npm run format` and `npm run lint:fix` to apply safe automatic fixes. CI selects checks from changed files using `scripts/ci-scope.mjs` from the committed baseline. Markdown-only changes run formatting; recognized repository-only changes also run repository lint and issue-automation tests. They skip workspace tests/builds, CDK synthesis, bundle validation, and OpenTofu checks. Application/package code, dependencies, CI selection, and unknown paths run the full application gate. Non-Markdown files under `infrastructure/` and `.terrateam/config.yml` select the separate `infrastructure` job. Infrastructure-only changes skip `check`; application-only changes skip `infrastructure`; mixed changes run both. Titles and labels never control selection. Renames inspect both removed and added paths. Both jobs remain present in the workflow so skipped jobs can satisfy required checks. Adding `infrastructure` to the main ruleset requires a separately authorized settings change.

Target one logical application with npm's workspace flag:

```console
npm test --workspace @samlevin/match-to-csv
npm run app:synth -- match-to-csv
```

Current application guidance:

- [`applications/match-to-csv/TESTING.md`](applications/match-to-csv/TESTING.md)
- [`packages/cdk-config/TESTING.md`](packages/cdk-config/TESTING.md)

Every application workspace participates in the root checks and can be targeted independently by the deployment workflow.

`npm test` is AWS-free. CDK synth verifies infrastructure structure. After a merge to `main`, CI deploys affected applications to `dev` and verifies the resulting CloudFormation stack. The `match-to-csv` check also requires its Lambda functions and Step Functions state machines to be active. Run the full email integration test before promoting a material ingestion or processing change.

## Concurrent CI checks

The scope job reads the baseline classifier before either gate runs. The ARM64 `check` job installs dependencies once, prepares shared declarations for lint, and runs repository checks alongside one Turbo task graph. Turbo orders workspace builds before read-only `ci:test` tasks and shared builds before consumers. The focused `npm test --workspace @samlevin/cdk-config` command still builds its own declarations; concurrent CI tests reuse the tracked build and never invoke a second compiler. `ci:synth` always synthesizes dev ephemeral stacks; `verify:bundle` waits for the `match-to-csv` synthesis and checks the Linux ARM64 Sharp assets. Synthesis and native verification are never cached.

For a PR confined to known workspaces, Turbo `--affected` checks changed workspaces and downstream consumers. A `contracts` change checks `match-to-csv`; a `cdk-config` change checks all five applications. Root configuration, mixed infrastructure/application changes, CI selection, dependencies at the root, unknown paths, and every full-scope push to `main` check all workspaces. The existing baseline classifier still controls documentation and recognized repository checks. Deployment requires successful CI and remains limited to pushes to `main`. Infrastructure-only pushes save an empty application selection from the scope job, so `deploy-applications` completes without deploying.

The AWS-free `infrastructure` job runs `tofu fmt -check -recursive infrastructure`, then backend-disabled initialization and validation for bootstrap, foundation, and data-platform roots in dev and prod. The inactive data-platform roots are included because they validate without inputs. It initializes the bootstrap and foundation test modules through the dev roots and runs `infrastructure/modules/bootstrap/tests` and `infrastructure/modules/foundation/tests`. Those suites use fake credentials and overrides; CI never assumes an AWS role for this job.

Run the same infrastructure checks locally with OpenTofu 1.12.1:

```sh
tofu fmt -check -recursive infrastructure
for environment in dev prod; do
  for module in bootstrap foundation data-platform; do
    root="infrastructure/$environment/$module"
    tofu -chdir="$root" init -backend=false -input=false
    tofu -chdir="$root" validate
  done
done
for module in bootstrap foundation; do
  root="infrastructure/dev/$module"
  tofu -chdir="$root" init -backend=false -input=false -test-directory="../../modules/$module/tests"
  tofu -chdir="$root" test -test-directory="../../modules/$module/tests"
done
```

Run the selection, concurrency, failure propagation, cache policy, and deployment guard tests with:

```console
node --test scripts/ci-checks.test.mjs
```

Npm downloads use the setup-node cache. Trusted main validation uses the dev S3 Turbo bucket through `rharkor/caching-for-turbo@v2.5.1`. Dev deployments use that bucket; production promotion and rollback builds use the prod bucket. A dedicated OIDC cache role resolves and validates the environment's bucket and KMS SSM contracts. OS, architecture, and Node version isolate object prefixes. `MCC_BUILD_ENVIRONMENT` participates in Turbo task hashes, and the explicitly worktree-local cache prevents another checkout from supplying outputs. Each deployment job has a fresh runner and exactly one environment, including historical releases whose Turbo configuration predates this hash input.

Pull requests use only their ephemeral local Turbo cache and never assume a cache role. The main-only role trust policy rejects PR subjects and refs. The remote API credentials are passed explicitly from the cache role to the action, including its session token; later CDK credentials cannot replace that session. AWS credentials are removed from the build environment after the server starts. Synthesis and native verification remain uncached. The action performs prefix-scoped bucket listing for hash lookup, but has no deletion grant or action cleanup settings. Both buckets expire objects after seven days through S3 lifecycle.

The trusted main path needs the dev foundation's cache role and the repository variables `DEV_AWS_ACCOUNT_ID` and `DEV_AWS_REGION`, set to the dev account and Region. See [Configure GitHub](docs/self-hosting/30-configure-github.md#variables-and-secrets). Deployment jobs continue using their protected environment's `AWS_ACCOUNT_ID` and `AWS_REGION`. Configure `github_oidc_subject_repository` in both foundation roots to match bootstrap if immutable OIDC repository subjects are enabled. The foundation creates `mcc-stats-suite-<environment>-github-turbo-cache` with the existing bootstrap OIDC provider and workload boundary. No long-lived AWS key or public HTTP cache service is required. The reusable deployment workflow checks out its cache action from the calling workflow SHA so a historical release can use the current cache integration.

The prior five-run CI comparison used the GitHub Turbo-output backend and is historical evidence for concurrency and affected selection. It does not establish S3 cache effectiveness. After foundation activation, record new cold and warm trusted-main and production build runs, including cache server logs, before claiming an S3 performance improvement.

Only superseded PR runs are cancelled. Main uses a unique run group and never cancels earlier validation or deployment jobs. Compare the `ci` run start with the last job completion for wall time, sum job start-to-completion intervals for runner time, and retain Turbo summaries and cache restore logs when benchmarking. Include cold and warm runs, record synthesis/bundle results, and compare full-scope PRs with full-scope baselines before claiming a performance improvement.

Application delivery regression checks run with `node --test scripts/deployment-workflows.test.mjs`. They use workflow definitions and mocked GitHub responses to verify trusted CI qualification, exact-SHA handoff, independent dev-success gating, and required production approval protection without AWS calls.
