# Release, promote, and recover applications

Application releases and deployments are separate. Release Please creates a named, immutable candidate. The production workflow promotes that candidate after the same application and commit pass in `dev`.

The private `@mcc/cdk-config` and `@mcc/contracts` workspaces have independent semantic versions and GitHub releases. Applications use exact local dependency versions. Release Please updates those pins and patch-bumps every affected application in the same release commit. A `cdk-config` change therefore creates releases for all dependent applications. A `contracts` change creates a new `match-to-csv` release. The packages remain private and are not published to npm.

## Release an application

1. Merge the application change to `main` after its pull request checks pass.
2. Open the `ci` workflow run for the merge commit.
3. Confirm CI identifies the application as affected and deploys that exact SHA successfully to `dev`.
4. Complete the application-specific integration test. For `match-to-csv`, follow [`22-validate-match-to-csv-in-dev.md`](22-validate-match-to-csv-in-dev.md).
5. Review the Release Please pull request. Its changelogs must describe the application and shared-package changes intended for production. A shared-package change may group several dependent releases into one pull request.
6. Merge the release pull request.
7. Wait for Release Please to create a published GitHub Release with a tag in the form `<application>-v<version>`.
8. Wait for CI to deploy the release commit to `dev`. Release Please changes the application version and changelog, so the release commit requires its own successful qualification.

## Recover release pull request creation

If Release Please writes release branches but fails with `GitHub Actions is not permitted to create or approve pull requests.`, check the repository permission separately from the workflow token permissions. A generated branch does not prove that a release pull request was created.

Use authenticated `gh` for this read-only preflight:

```console
gh api repos/samlevin/mcc-stats-suite/actions/permissions/workflow \
  --jq '{default_workflow_permissions, can_approve_pull_request_reviews}'
```

The expected values are `default_workflow_permissions: "read"` and `can_approve_pull_request_reviews: true`. The API field controls both pull request creation and approval, despite its name. If it is `false`, stop and obtain separate authorization for a repository settings change. After authorization, a repository administrator can open **Settings -> Actions -> General -> Workflow permissions**, enable **Allow GitHub Actions to create and approve pull requests**, and save. Keep the default token permission set to **Read repository contents and packages permissions**. See [GitHub's repository Actions settings documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository).

Confirm `.github/workflows/release-please.yml` grants `contents: write` for release branches, tags, and GitHub releases, and `pull-requests: write` for release pull requests. Keep these existing workflow permissions. The [Release Please action documentation](https://github.com/googleapis/release-please-action#workflow-permissions) also identifies the repository setting as a prerequisite. Do not broaden default workflow permissions or introduce a personal token to bypass this setting.

After the setting is enabled, verify release pull request creation:

1. Repeat the preflight and record its output with the incident or issue.
2. Use the next authorized push to `main` containing releasable Conventional Commits. Alternatively, with separate authorization, run **Actions -> release-please -> Run workflow** on `main` when releasable commits are already pending. This run can create release branches, pull requests, tags, or published releases; it is not a dry run.
3. Inspect that run's logs and conclusion. Confirm the permission error is absent and the job succeeds. A successful run with no releasable changes does not verify pull request creation.
4. Inspect the open release pull requests using the read-only command below. Confirm each expected component has a pull request targeting `main`, or that its existing pull request was updated by the run. Compare the changed files with `release-please-config.json`, including intentional shared-package consumer bumps. Check that unrelated components were not changed.
5. Record the run URL, source commit SHA, release pull request URLs, and affected components on the issue. Keep the issue open if the setting remains disabled or no release pull request was created or updated.

```console
gh pr list --repo samlevin/mcc-stats-suite --state open --base main \
  --json number,url,headRefName,title \
  --jq '.[] | select(.headRefName | startswith("release-please--"))'
```

Release Please uses `GITHUB_TOKEN`, so its generated pull request events do not start other Actions workflows. Verify pull request creation independently of CI status. Follow the normal review and required-check process before merging a release pull request; see the [action's token guidance](https://github.com/googleapis/release-please-action#other-actions-on-release-please-prs).

## Promote a release to production

1. Open **GitHub Actions -> promote-aws-application -> Run workflow**.
2. Keep the workflow branch set to `main`.
3. Select `promote`.
4. Select the application.
5. Enter its published release tag.
6. Optionally record why the release is being promoted.
7. Run the workflow.
8. Confirm the qualification job resolves the release to a full commit SHA and finds a successful `dev` deployment for the same application and SHA.
9. Inspect the recorded CDK diff in the production deployment job.
10. Confirm the CDK deployment and deployed-stack verification succeed.
11. Run the application-specific production health check.

The workflow rejects draft releases, prereleases, tags belonging to another application, commits outside `main`, and revisions without successful `dev` qualification.

## Roll back during an incident

Rollback restores a complete prior application release. It does not reset `main` or change another application stack. Later changes within the selected application disappear from production until a corrected release is promoted.

1. Identify the most recent known-good release tag for the affected application.
2. Confirm that release appears in the application's production deployment history.
3. Open **GitHub Actions -> promote-aws-application -> Run workflow** from `main`.
4. Select `rollback` and the affected application.
5. Enter the known-good release tag and a short incident reason.
6. Run the workflow.
7. Confirm qualification finds a successful prior `prod` deployment for the same application and SHA.
8. Review the CDK diff, complete the deployment, and check production health.
9. Record the incident and begin the roll-forward repair.

The rollback path cannot deploy arbitrary historical code. It accepts only a published application release that this workflow previously deployed successfully to production.

## Preserve later work with a roll-forward repair

Create a normal pull request from current `main`. Revert the offending commit or add a corrective change, then pass through CI, `dev`, Release Please, and production promotion again. Do not reset `main`, force-move a release tag, or construct an unreviewed production-only commit.

Use rollback to restore service quickly. Use a roll-forward release to remove the defect while retaining later good changes. Schema and data changes must remain backward-compatible throughout the rollback window.

Next: [`40-recover-and-troubleshoot.md`](40-recover-and-troubleshoot.md).
