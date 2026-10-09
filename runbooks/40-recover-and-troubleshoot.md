# Recover and troubleshoot

## Wrong AWS account

Stop immediately. Do not apply. Clear or change `AWS_PROFILE`, authenticate
again, and verify:

```console
aws sts get-caller-identity
```

## Unexpected replacement or deletion

Reject the plan. Check the selected account and configuration before trying
again.

## Foundation drift issue

Terrateam checks the dev and prod foundation roots weekly and opens a GitHub issue when its plan finds drift. It does not reconcile drift automatically.

1. Identify the affected root and inspect every planned action in the issue.
2. Determine whether AWS changed outside OpenTofu or the repository no longer describes the intended state.
3. If the external change is intended, open a focused pull request that records it in OpenTofu. Apply and validate dev before prod when the shared module changes.
4. If the external change is not intended, use a focused infrastructure pull request to obtain a fresh Terrateam plan for the affected root. Apply only after confirming the plan restores repository state without replacing or deleting unrelated resources.
5. Close the drift issue only after a later plan is empty.

Do not enable unattended reconciliation to silence drift. Do not edit state by hand unless a separate, reviewed state-recovery procedure requires it.

## CDK deployment failure

Inspect the CloudFormation stack events, fix the application or configuration,
and redeploy. Do not manually recreate stack-owned resources.

## Application incident after production promotion

If an older release is known safe and remains compatible with current data, use the `rollback` operation in the `promote-aws-application` workflow. The selected tag must have a prior successful production deployment for the same application.

After service recovers, revert or correct the offending change on current `main` and create a new release. Do not reset the branch or move a release tag. Prefer a roll-forward repair when the current release changed persistent schemas, wrote data an older version cannot read, or contains later work that production must retain.

## Stale personal development stack

Confirm the instance owner, then remove only that application stack:

```console
aws sso login --profile <dev-profile>
aws sts get-caller-identity --profile <dev-profile>
npm run app:destroy -- <application> --profile <dev-profile>
```
