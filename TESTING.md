# Repository testing

Install once and run every workspace from the repository root:

```console
npm ci
npm test
```

The AWS-free issue triage tests cover eligibility, pagination, idempotency, and metadata changes before mutation:

```console
node --test scripts/issue-triage.test.mjs
```

These tests use metadata mocks and never call GitHub. A live read-only check uses `node scripts/issue-triage.mjs --issue <number> --dry-run` with authenticated local `gh`; see [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) for workflow credentials and activation.

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
