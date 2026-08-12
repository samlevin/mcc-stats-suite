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
