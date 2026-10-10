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

These tests use metadata mocks and never call GitHub. To preview PR metadata with authenticated local `gh`, run `PR_NUMBER=<number> node scripts/issue-pr-metadata.mjs`; it defaults to a dry run. A live read-only check uses `node scripts/issue-triage.mjs --issue <number> --dry-run` with authenticated local `gh`; see [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) for workflow credentials and activation.

The full local quality gate is:

```console
npm run check
npm run tofu:fmt:check
```

`npm run check` verifies Prettier formatting and ESLint rules before typechecking, tests, and builds. Use `npm run format` and `npm run lint:fix` to apply safe automatic fixes. CI selects checks from changed files using `scripts/ci-scope.mjs` from the committed baseline. Markdown-only changes run formatting; recognized repository-only changes also run repository lint and issue-automation tests. They skip workspace tests/builds, CDK synthesis, bundle validation, and OpenTofu checks. Application/package/infrastructure code, dependencies, CI selection, and unknown paths run the full gate. Titles and labels never control selection. Renames inspect both removed and added paths. The required `check` job always runs, alongside existing secret and PR-title checks.

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

The ARM64 `check` job installs dependencies once, prepares shared declarations for lint, and runs repository checks alongside one Turbo task graph. Turbo orders workspace builds before tests and shared builds before consumers. `ci:synth` always synthesizes dev ephemeral stacks; `verify:bundle` waits for the `match-to-csv` synthesis and checks the Linux ARM64 Sharp assets. Synthesis and native verification are never cached.

For a PR confined to known workspaces, Turbo `--affected` checks changed workspaces and downstream consumers. A `contracts` change checks `match-to-csv`; a `cdk-config` change checks all five applications. Root configuration, infrastructure, CI selection, dependencies at the root, unknown paths, and every full-scope push to `main` check all workspaces. The existing baseline classifier still controls documentation and recognized repository checks. Deployment requires the successful `check` job and remains limited to pushes to `main`.

Run the selection, concurrency, failure propagation, cache policy, and deployment guard tests with:

```console
node --test scripts/ci-checks.test.mjs
```

Npm downloads use the GitHub ref-scoped setup-node cache. Turbo outputs use GitHub cache with separate `trusted-main` and per-PR namespaces, OS/architecture, Node version, lockfile, and Turbo configuration in the key. PRs can restore trusted baseline outputs and their own outputs; main restores only trusted main outputs. GitHub also confines PR writes to their merge ref, preventing reuse by main or other PRs. No credentials or synthesis artifacts enter the Turbo cache. The explicit `.turbo/cache` directory also prevents local linked worktrees from writing into another checkout.

Only superseded PR runs are cancelled. Main uses a unique run group and never cancels earlier validation or deployment jobs. Compare the `ci` run start with the last job completion for wall time, sum job start-to-completion intervals for runner time, and retain Turbo summaries and cache restore logs when benchmarking. Include cold and warm runs, record synthesis/bundle results, and compare full-scope PRs with full-scope baselines before claiming a performance improvement.
