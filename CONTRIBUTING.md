# Contributing

MCC Stats Suite is an NPM and Turbo monorepo. Each application owns a CDK stack and can be released or deployed independently. Shared packages use exact versions so a change to a common contract produces explicit releases for every affected application.

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

Workspaces use the `@samlevin` scope. `.npmrc` routes that scope to GitHub Packages; third-party dependencies use npmjs.org. Matching workspace versions install locally. If an install needs a published shared version, authenticate with `npm login --scope=@samlevin --auth-type=legacy --registry=https://npm.pkg.github.com` using a classic token with `read:packages`. Keep credentials in your user npm configuration.

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

## Work with AWS safely

Copy `.envrc.example` to the ignored `.envrc`, fill its placeholders, and run `direnv allow`. Authenticate through IAM Identity Center and verify the account before any diff or deployment:

```console
aws sso login
aws sts get-caller-identity
```

The deployment harness also checks the active account against the selected profile. Do not bypass that check or pass raw CDK context. Use `--environment` and, for local stacks, `--ephemeral`.

Never commit credentials, account IDs, email addresses, domain names, populated `backend.hcl`, `*.auto.tfvars`, state, plans, or local environment files. This is a public repository.

## Submit a change

Classify issues using [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md). Start from a `Ready` GitHub issue, then verify executable scope, acceptance, validation, dependencies, parent relationships, and size planning before claiming. Ready means metadata triaged; implement only executable leaves. Any parent with sub-issues is a container with no branch or PR. Follow the claim, implementation, review, and completion rules in [`WORKFLOW.md`](WORKFLOW.md). Create a focused branch and keep changes inside the smallest useful component boundary. A shared-package change should include every necessary contract migration and consumer update.

Pull-request titles must follow Conventional Commits because Release Please derives versions and release notes from them. Common forms are:

```text
feat(match-to-csv): retain attachment rejection reasons
fix(contracts): require screenshot source hashes
docs: explain the production promotion path
chore: update development tooling
```

Link the pull request to its task or bug with `Closes #<number>`. Reference the immediate parent issue or epic separately using `Parent issue or epic: #<number>`. A pull request closes executable leaf work; container completion follows its children.

The [linked issue metadata workflow](.github/workflows/pr-issue-metadata.yml) copies labels, a milestone, and active GitHub Projects membership when a PR is opened, its description is edited, it is reopened, or it becomes ready for review. It reads same-repository references such as `#123`, `owner/repository#123`, and GitHub issue URLs from the description. Parent issue or epic lines, code examples, and HTML comments are excluded. References to pull requests are ignored. With several linked issues, it copies the union of their labels and projects. It fills an empty PR milestone only when the linked issues have one distinct milestone; conflicts leave the milestone unchanged. Existing PR labels, milestones, project membership, and project fields are preserved. Removing a link does not remove metadata previously copied. Later issue metadata changes can be copied by rerunning the workflow with the PR number; the manual run defaults to a dry run.

The workflow reuses `MCC_PROJECT_TOKEN` from issue triage. Its credential needs repository issue and pull-request write access and read/write access to the source projects. The workflow runs trusted default-branch scripts with `pull_request_target`, including for fork PRs, and never executes PR code. It becomes active after publication on the default branch. See [GitHub's project authentication guidance](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions).

Use `feat` for a minor version, `fix` for a patch, and a documented breaking change for a major version. CI runs independent repository checks and workspace tasks concurrently in one ARM64 job. Narrow workspace PRs use Turbo affected selection, including downstream consumers; full-scope main pushes validate every workspace before deployment. CI retains CDK synthesis, native bundle verification, and OpenTofu formatting. See `TESTING.md` for cache boundaries and selection tests. Pull requests do not deploy applications.

## Use personal Codex delivery agents

With the reusable agents installed under `~/.codex/agents/`, start a fresh Codex session in this repository. `AGENTS.md` supplies the repository and project binding; the agents discover the remaining workflow and commands from these contributor guides.

Example prompts:

```text
Build me this feature <GitHub epic URL>.
Implement <GitHub task or bug URL>.
Rework <GitHub issue URL> to address the feedback on its existing PR.
Use code-reviewer to review pushed branch <branch> against <issue URL> before its PR exists.
Use security-reviewer to review pushed branch <branch> against <base>.
Use stacked-pr-manager to sync the stack for <existing PR URL> after its parent merges.
```

Delivery prompts request implementation through ready-for-review PRs. The implementer owns PRs and runs checks; the code reviewer performs only the initial static review before PR creation. Security review requires an explicit request. See `WORKFLOW.md` for the review gate, stack decomposition, and issue states.

## Understand release versioning

Release Please manages every application plus `@samlevin/cdk-config` and `@samlevin/contracts`. It creates component tags such as `match-to-csv-v1.2.3`, `contracts-v1.1.0`, and `cdk-config-v1.0.4`.

Release Please authenticates as a dedicated GitHub App instead of `GITHUB_TOKEN`, so its release pull requests start the checks that the `main` ruleset requires. The workflow reads the app ID from the `RELEASE_PLEASE_APP_ID` repository variable and the private key from the `RELEASE_PLEASE_APP_PRIVATE_KEY` secret. The app is installed on this repository only, with read and write access to contents, pull requests, and issues. The workflow's own `GITHUB_TOKEN` is read-only. See the [release pull request recovery procedure](runbooks/31-release-promote-and-recover-applications.md#recover-release-pull-request-creation) for token failures and end-to-end verification. Repository settings changes require separate authorization.

Applications pin internal packages at exact versions. The Node workspace release plugin updates those pins and patch-bumps consumers when a shared package changes:

- a `cdk-config` release affects `admin`, `data-pipeline`, `match-to-csv`, `ocr-quality`, and `player`;
- a `contracts` release affects `match-to-csv`.

The release pull request updates package versions, changelogs, the root lockfile, and `.release-please-manifest.json` together. `npm run release:check` rejects drift between those files. Release Please opens one coordinated release pull request so shared versions and exact consumer pins change together. Component versions and tags remain independent. After successful `main` CI, the `publish-packages` job builds and publishes `@samlevin/contracts` and `@samlevin/cdk-config` to GitHub Packages using `GITHUB_TOKEN`. The first successful run publishes the current versions; later runs skip versions already present. Registry or publication errors fail the job. Packages inherit access from this repository; registry downloads require authentication even for public packages. Applications remain private workspaces.

Existing separate Release Please pull requests predate this configuration and should be closed when the coordinated replacement opens. Re-run the failed main CI run to retry package publication; immutable existing versions are skipped.

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

### dev

dev deploys only from GitHub Actions. Merge the reviewed change to `main`. After the `ci` workflow succeeds, `deploy-dev` downloads the affected-application list from that exact CI run and calls the reusable deployment workflow for each result. A change confined to one application deploys that application. A shared-package change deploys all consumers.

Open the `deploy-dev` run for the merge SHA to verify deployments. GitHub records the exact SHA, application version, shared-package versions, and final status in Deployments. Do not deploy the plain `dev` stack from a local shell.

## Deploy one application to prod

After every affected application deploys successfully to dev, `deploy-prod` starts for the same commit and waits for approval through the protected GitHub `prod` environment. A required reviewer must approve the pending deployment in the Actions run before it can assume production credentials. Configure required reviewers on the `prod` environment in repository settings.

Review and approve the pending production deployment in **GitHub Actions -> deploy-prod -> Review deployments** after completing any application smoke test. Use [`runbooks/22-validate-match-to-csv-in-dev.md`](runbooks/22-validate-match-to-csv-in-dev.md) for `match-to-csv`. Then review the production CDK diff and verify the stack health checks and application smoke test. The workflow deploys the exact commit that succeeded in dev. The manual `rollback-aws-application` workflow remains available to restore a prior production release; read [`runbooks/31-release-promote-and-recover-applications.md`](runbooks/31-release-promote-and-recover-applications.md) first.

To restore an older production version, use the manual `rollback-aws-application` workflow with a release previously deployed to prod, and record the reason. Read [`runbooks/31-release-promote-and-recover-applications.md`](runbooks/31-release-promote-and-recover-applications.md) before rolling back.

## Change shared infrastructure

OpenTofu owns bootstrap, long-lived storage, encryption keys, SSM contracts, and the lakehouse foundation. CDK owns application compute and orchestration. Do not create a resource in one system if the other already manages it.

Bootstrap is a local administrative procedure. Terrateam plans foundation changes on pull requests. After merge, it applies the merged revision to dev before it plans and applies prod. Foundation does not have a separate release ID. A failed or stale dev layer blocks prod. If another foundation change reaches `main` during a run, treat the newer revision as the promotion candidate and require its layered run to finish successfully.

Terrateam checks foundation roots for drift weekly and opens a GitHub issue when it finds a difference. Reconciliation remains reviewed and manual. Infrastructure changes can affect several applications even when no application source file changed, so follow the ordered procedures in [`runbooks/README.md`](runbooks/README.md).

## Keep documentation with the code

Update the closest durable document:

- product behavior and operator-facing package details belong in an application README;
- local and CI test commands belong in `TESTING.md` or a package testing guide;
- repeatable AWS operations belong in `runbooks/`;
- future behavior and acceptance criteria belong in `specs/`;
- repository-wide orientation belongs in this file or the root README.

Do not put personal account structure, domain names, email addresses, or maintainer-specific setup in public documentation.
