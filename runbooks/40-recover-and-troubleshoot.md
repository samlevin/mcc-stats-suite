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

## Stale personal development stack

Confirm the instance owner, then remove only that application stack:

```console
aws sso login --profile <dev-profile>
aws sts get-caller-identity --profile <dev-profile>
npm run app:destroy -- <application> --profile <dev-profile>
```
