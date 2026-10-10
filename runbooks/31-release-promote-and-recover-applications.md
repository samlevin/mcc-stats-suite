# Release, promote, and recover applications

Application releases and deployments are separate. Successful CI for a trusted main push starts `deploy-applications` at that exact merge SHA. Each affected application deploys and verifies in dev, then queues production for human approval. Routine delivery needs no release tag or manual dispatch. Release Please continues versioning independently.

The `@samlevin/cdk-config` and `@samlevin/contracts` shared packages have independent semantic versions and GitHub releases. Applications use exact local dependency versions. Release Please updates those pins and patch-bumps every affected application in the same release commit. A `cdk-config` change therefore creates releases for all dependent applications. A `contracts` change creates a new `match-to-csv` release. After successful main CI, the `publish-shared-packages` workflow publishes built shared package versions to GitHub Packages and skips existing immutable versions. See [package publication and recovery](../CONTRIBUTING.md#understand-release-versioning) for authentication and retry instructions.

## Release an application

1. Test application and business-logic changes in a local ephemeral dev environment before opening the PR.
2. Merge the reviewed change to `main` after PR checks pass.
3. Confirm the `ci` run succeeds, then open its `deploy-applications` run. It downloads the affected selection from that CI run and preserves the CI run's exact SHA.
4. Confirm the application's dev deployment and stack verification succeed. Shared package changes select dependent applications; an empty selection deploys nothing.
5. Complete the application smoke test before approving production. For `match-to-csv`, follow [`22-validate-match-to-csv-in-dev.md`](22-validate-match-to-csv-in-dev.md).
6. Follow the production approval procedure below. One application's failed or cancelled dev job cannot qualify it or prevent another successful application's promotion.
7. Review and merge Release Please PRs for versioning and changelogs. Their published component tags remain available for recovery; tag publication is independent of routine production delivery.

## Recover release pull request creation

Release Please authenticates as a dedicated GitHub App. Its first step exchanges the `RELEASE_PLEASE_APP_ID` repository variable and the `RELEASE_PLEASE_APP_PRIVATE_KEY` secret for a short-lived installation token. Pull requests opened with that token start the `check`, `gitleaks`, and `semantic_pr` workflows. Pull requests opened with `GITHUB_TOKEN` start none of them, and the `main` ruleset will not merge a pull request without those checks.

If the **Create release token** step fails, check these in order:

1. The variable and secret exist. Use authenticated `gh` for this read-only check:

   ```console
   gh variable list --repo samlevin/mcc-stats-suite
   gh secret list --repo samlevin/mcc-stats-suite
   ```

2. The app is still installed on this repository. Look under the account's **Settings -> Applications -> Installed GitHub Apps**.
3. The private key is still active on the app's settings page. To rotate it, generate a new key, replace the secret with `gh secret set RELEASE_PLEASE_APP_PRIVATE_KEY --repo samlevin/mcc-stats-suite < <key-file>`, delete the local key file, and then revoke the old key.

If the token step succeeds but Release Please fails with `Resource not accessible by integration` or another 403, the app is missing a repository permission. It needs read and write access to contents, pull requests, and issues. After changing app permissions, accept the new permissions on the installation. Do not replace the app with a personal token or broaden the workflow's `GITHUB_TOKEN` permissions.

After a fix, verify release pull request creation:

1. Use the next authorized push to `main` containing releasable Conventional Commits. Alternatively, with separate authorization, run **Actions -> release-please -> Run workflow** on `main` when releasable commits are already pending. This run can create release branches, pull requests, tags, or published releases. It is not a dry run.
2. Inspect that run's logs and conclusion. A successful run with no releasable changes does not verify pull request creation.
3. List the open release pull requests with the command below. Confirm the release pull request targets `main`, was opened or updated by the app, and shows `check`, `gitleaks`, and `semantic_pr` results. Compare its changed files with `release-please-config.json`, including intentional shared-package consumer bumps.
4. Record the run URL, source commit SHA, release pull request URL, and affected components on the issue. Keep the issue open until a release pull request has run the required checks.

```console
gh pr list --repo samlevin/mcc-stats-suite --state open --base main \
  --json number,url,headRefName,title,author \
  --jq '.[] | select(.headRefName | startswith("release-please--"))'
```

## Approve production delivery

The `prod` GitHub Environment must have a nonempty required-reviewer rule and administrator bypass disabled. The reusable deployment harness checks this before queueing its protected job and fails closed if protection is missing. A workflow Environment declaration alone does not require approval. At issue #12 implementation, the API reported no protection rules; enabling protection needs separate repository-settings authorization.

1. Open **GitHub Actions -> deploy-applications** for the merge SHA.
2. Check the selected application's dev job succeeded, including stack verification, and complete its smoke test.
3. Select **Review deployments**, inspect the application and exact SHA, and approve `prod`. Rejecting prevents that production job from running.
4. After approval, review the recorded production CDK diff and confirm deployment and stack verification succeed.
5. Run the application-specific production health check.

Each application's production job depends only on its own successful dev job at the same SHA. Failure, cancellation, skipped dev jobs, unsuccessful CI, and PR runs cannot qualify stable production delivery.

Under separate deployment-validation authorization, record a successful dev run, the pending approval prompt, the approved deployment's application/SHA, and a rejected approval that leaves production unchanged. AWS-free regression tests cover qualification and workflow wiring; they cannot demonstrate the live approval prompt.

## Roll back during an incident

Rollback restores a complete prior application release. It does not reset `main` or change another application stack. Later changes within the selected application disappear from production until a corrected release is promoted.

1. Identify the most recent known-good release tag for the affected application.
2. Confirm that release appears in the application's production deployment history.
3. Open **GitHub Actions -> rollback-aws-application -> Run workflow** from `main`.
4. Select `rollback` and the affected application.
5. Enter the known-good release tag and a short incident reason.
6. Run the workflow.
7. Confirm qualification finds a successful prior `prod` deployment for the same application and SHA.
8. Approve the protected production job, review the CDK diff, complete the deployment, and check production health.
9. Record the incident and begin the roll-forward repair.

The rollback path cannot deploy arbitrary historical code. It accepts only a published application release that this workflow previously deployed successfully to production.

## Preserve later work with a roll-forward repair

Create a normal pull request from current `main`. Revert the offending commit or add a corrective change, then pass through CI, `dev`, and production approval again. Do not reset `main`, force-move a release tag, or construct an unreviewed production-only commit.

Use rollback to restore service quickly. Use a roll-forward release to remove the defect while retaining later good changes. Schema and data changes must remain backward-compatible throughout the rollback window.

Next: [`40-recover-and-troubleshoot.md`](40-recover-and-troubleshoot.md).
