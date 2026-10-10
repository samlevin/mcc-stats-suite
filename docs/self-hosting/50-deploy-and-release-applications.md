# Deploy, release, and roll back applications

Each application owns a CDK stack per environment:

```text
<application>-dev       shared dev stack, deployed by GitHub Actions
<application>-<name>    ephemeral stack in dev, deployed from a local shell
<application>-prod      production stack, deployed by GitHub Actions
```

`scripts/cdk-app.mjs` refuses plain `dev` and `prod` deploys outside GitHub Actions on `main`, refuses ephemeral deploys inside GitHub Actions, and refuses to destroy a stable stack. Before a stable deploy it compares the deployed template with the new one and refuses to remove a stateful resource, or a custom resource with a delete call, that the deployed template does not retain; see [Recover and troubleshoot](60-recover-and-troubleshoot.md#cdk-deployment-failure).

## Ephemeral stacks

Test application changes in an ephemeral stack before opening a pull request. Use the `mcc-dev` profile and a lowercase name of up to 20 characters:

```console
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity
npm run app:synth -- <application> --environment dev --ephemeral <name>
npm run app:diff -- <application> --environment dev --ephemeral <name>
npm run app:deploy -- <application> --environment dev --ephemeral <name>
```

For `match-to-csv`, set `MCC_EMAIL_DOMAIN` in your ignored `.envrc` and run `npm run verify:bundle --workspace @samlevin/match-to-csv` after synthesis. The shared `match-to-csv-dev` stack owns the SES receipt rule set, so it must exist before any ephemeral stack. Ephemeral stacks have no email ingress and keep their evidence under `ephemeral/<name>/`; start their workflows directly when testing.

Remove the stack when you are done:

```console
npm run app:destroy -- <application> --environment dev --ephemeral <name>
```

## Merge to production

1. Merge the pull request after its checks pass.
2. `ci` validates the merge commit and records which applications it affects. A shared-package change affects every consumer, and an empty selection deploys nothing.
3. `deploy-applications` starts at that exact commit and runs one sequence per affected application. Each sequence deploys and verifies the application's `-dev` stack, then queues its `-prod` job.
4. The production job waits for approval on the `prod` environment. Finish the application's smoke test in dev first; for `match-to-csv`, see [Validate match-to-csv](#validate-match-to-csv).
5. Follow the **Review deployments** link in the merged pull request’s approval comment or the run summary. The comment names the application and short commit SHA and mentions the users or teams configured as required reviewers on the `prod` environment. In the run, choose **Review deployments**, check the application and commit, and approve or reject with your GitHub account. The waiting job is named `Approve production: <application>`. Rejecting leaves production unchanged.
6. Review the production CDK diff, confirm the deployment and stack verification succeed, and run the application's production health check.

The workflow posts one approval comment per application and run using its `GITHUB_TOKEN`. Repeating the prompt within the same run updates that comment; a new run posts a fresh comment to notify reviewers again. Invalid production protection skips the prompt, and notification failures produce warnings without failing deployment. Direct pushes without a merged pull request still show the prompt in the run summary and skip the comment. Approval remains a manual GitHub environment review.

Each application's production job depends only on its own successful dev job. A failed, cancelled, or skipped dev job blocks that application and nothing else. GitHub records every deployment, with its commit, application version, and shared-package versions, on the repository's Deployments page.

## Validate match-to-csv

After a `match-to-csv` change reaches dev, and before approving prod:

1. Send a representative PNG or JPEG screenshot to your configured inbound recipient.
2. Open the new `match-to-csv-dev` Step Functions execution and confirm every state succeeds.
3. In the evidence bucket, confirm the run contains the source image, metadata, run manifest, start and success events, Textract request and response, normalized observations, extracted table, CSV, and completion object.
4. Compare the CSV with the screenshot. OCR differences are observations to label, not corruption.

For a failure test, send an unsupported or undersized image. The submission records a rejection and the workflow does not report an empty success. For a provider failure, the run contains `RUN_STARTED`, `RUN_FAILED`, the provider request, and a failed completion object.

Never commit test messages, recipient addresses, or domains.

## Releases

Release Please versions each application and the shared `@samlevin/cdk-config` and `@samlevin/contracts` packages from Conventional Commit titles. It keeps one release pull request open. Merging it creates tags such as `match-to-csv-v1.2.3` and published GitHub Releases. Review the changelogs before merging; a shared-package change bumps every dependent application in the same pull request.

A release does not gate deployment. The release commit deploys like any other merge. The tags exist so you can roll back to a known version.

## Roll back

Rollback redeploys a previous release of one application to prod. It does not reset `main` or touch other applications.

1. Find the most recent known-good release tag for the application and confirm it appears in its production deployment history.
2. Run **Actions -> rollback-aws-application -> Run workflow** from `main`.
3. Select the application, enter the tag and the incident reason, and run it.
4. Approve the production job, review the CDK diff, and check production health.

The workflow accepts only a published, non-prerelease release tag for that application, on `main`, whose version matches the package, and with a previous successful prod deployment of the same commit.

Then fix forward. Open a normal pull request from current `main` that reverts or corrects the change, and let it go through CI, dev, and production approval. Do not reset `main` or move a release tag. Keep schema and data changes backward-compatible so a rollback stays safe.

Next: [Recover and troubleshoot](60-recover-and-troubleshoot.md).
