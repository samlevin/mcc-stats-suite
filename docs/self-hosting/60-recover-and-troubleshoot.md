# Recover and troubleshoot

## Wrong AWS account

Stop immediately. Do not apply. Clear or change `AWS_PROFILE`, sign in again, and verify:

```console
aws sts get-caller-identity
```

## Unexpected replacement or deletion

Reject the plan. Check the selected account and configuration before trying again.

## A plan wants to create resources that already exist

This usually means OpenTofu ran without its S3 backend, so the resources exist in AWS but not in state. Do not retry the apply.

1. Read the complete apply logs and list every resource that was created.
2. Confirm the state bucket and Region variables point at the intended environment, and check whether the environment's state object already holds those resources. Never import one AWS object to two addresses.
3. Add declarative `import` blocks for the existing resources in a pull request. Confirm the new dev plan initializes the S3 backend and imports the resources instead of creating them.
4. Apply dev with `terrateam apply dev and foundation`, then require an empty dev plan.
5. Repeat for prod from the same commit with `terrateam plan prod and foundation` and `terrateam apply prod and foundation`, and require an empty prod plan.

A failed apply can leave unmanaged duplicates, such as a KMS key created before its alias failed. Before scheduling deletion of a duplicate key, confirm no alias, SSM parameter, bucket encryption setting, application configuration, or stored object references it. Keep the full KMS waiting period, and do not add the duplicate to state.

## Foundation drift issue

Terrateam checks the dev and prod foundation roots weekly and opens a GitHub issue when its plan finds drift. It does not reconcile drift automatically.

1. Identify the affected root and inspect every planned action in the issue.
2. Decide whether AWS changed outside OpenTofu or the repository no longer describes the intended state.
3. If the external change is intended, open a pull request that records it in OpenTofu.
4. If it is not intended, open a pull request to get a fresh plan for that root, and apply it from the pull request only after confirming the plan restores repository state without touching unrelated resources.
5. Close the drift issue after a later plan is empty.

Do not enable unattended reconciliation to silence drift, and do not edit state by hand.

## CDK deployment failure

Inspect the CloudFormation stack events, fix the application or configuration, and redeploy. Do not recreate stack-owned resources by hand.

If the deploy stops with `Refusing deploy: <stack> would lose resources that its deployed template does not retain`, the new release removes a stateful resource (a bucket, table, key, SES receipt rule set or rule, or SSM parameter) or a custom resource with a delete call, and the deployed template would delete it or run that call. CloudFormation applies the deployed template's policy, not the new one. Retain the resource, or drop its delete call, in a release that keeps its logical ID, deploy that release, and remove the resource in the next one.

## Application incident after a production deployment

If an older release is known safe and compatible with current data, [roll back](50-deploy-and-release-applications.md#roll-back). After service recovers, revert or correct the change on current `main`. Prefer fixing forward when the current release changed persistent schemas or wrote data an older version cannot read.

## Stale personal development stack

Confirm the instance owner, then remove only that ephemeral application stack. The shared `-dev` and `-prod` stacks deploy only from `main` through GitHub Actions, have termination protection, and cannot be destroyed with this command:

```console
aws sso login --profile <dev-profile>
aws sts get-caller-identity --profile <dev-profile>
npm run app:destroy -- <application> --environment dev --ephemeral <name> --profile <dev-profile>
```

## Release Please cannot open a release pull request

If the **Create release token** step fails:

1. Confirm the `RELEASE_PLEASE_APP_ID` repository variable and `RELEASE_PLEASE_APP_PRIVATE_KEY` secret exist, for example with `gh variable list` and `gh secret list`.
2. Confirm the app is still installed on the repository.
3. Confirm the private key is still active on the app's settings page. To rotate it, generate a new key, replace the secret with `gh secret set RELEASE_PLEASE_APP_PRIVATE_KEY < <key-file>`, delete the local key file, and then revoke the old key.

If the token step succeeds but Release Please fails with `Resource not accessible by integration` or another 403, the app is missing a permission. It needs read and write access to contents, pull requests, and issues. After changing permissions, accept them on the installation.

To verify a fix, wait for the next push to `main` with releasable commits, or run **Actions -> release-please -> Run workflow** on `main`. A manual run is not a dry run; it can create release branches, pull requests, tags, and releases. A successful run with nothing to release proves nothing. The release pull request must target `main`, be opened by the app, and show `check`, `gitleaks`, and `semantic_pr` results.
