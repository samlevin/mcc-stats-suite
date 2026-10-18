# Local CDK bootstrap design

The `mcclocal1` bootstrap limits local developers to ephemeral application stacks in dev. `scripts/local-cdk-bootstrap.mjs` generates its template from the pinned CDK bootstrap template, and the OpenTofu root `infrastructure/dev/local-cdk` deploys that committed template as the `CDKToolkitLocal` stack. For setup, changes, upgrades, removal, and local access, follow [Bootstrap CDK and grant local deploy access](self-hosting/20-bootstrap-cdk.md).

## What the local bootstrap allows

Ephemeral synthesis selects this bootstrap, its runtime boundary, and the IAM role path `/mcc-local/` automatically.

- **Deployment role.** It changes only stacks named `<application>-e-<name>`; shared stacks are outside its grants. Stack creates and updates must pass the local execution role, and it executes only change sets named `mcclocal1-deploy`. It reads only the bootstrap version and `/mcc/dev/*` application parameters.
- **Execution role.** Its scoped grants are split across three identity policies, and a boundary caps it at those services while denying CloudFormation, STS, and identity administration. It manages Lambda functions, state machines, queues, log groups, and EventBridge rules only by name under the `<application>-e-` prefixes. Rules may match only S3 events and may target only ephemeral compute. It creates roles only under `/mcc-local/` and only with the local runtime boundary, and it changes or passes only roles under that path. A role's path cannot change, so roles outside `/mcc-local/`, such as roles made by hand, stay out of reach.
- **Runtime boundary.** It denies deployment and identity administration. It allows S3 writes and listing only under `ephemeral/<name>/`, and reads only under `ephemeral/<name>/` and `incoming/<name>/`, in buckets of this account. `<name>` is the `Ephemeral` tag CDK applies to the stack's roles. It allows `GetItem` and `Query` on the dev gamertag roster table only in the `ROSTER#ephemeral/<name>` partition, never `ROSTER#stable` ([spec 1.2 §13.4](../specs/1.2-gamertag-roster.md#134-permissions)). It also allows invoking or starting only ephemeral application compute, using KMS keys only through S3, decrypting through DynamoDB, and reading single `/mcc/dev/*` parameters, such as the sender allowlist and submission address that `process-email` checks. It allows `ses:SendEmail` only from a `noreply@` address, on any SES identity in this account and Region, for the `process-email` reply. Everything under `/mcc/<environment>/` is application config, so CI parameters such as the Turbo cache contract live under `/mcc-ci/` instead ([SSM parameter namespaces](../infrastructure/README.md#ssm-parameter-namespaces)).
- **Lookup role.** It has no AWS managed policy and reads only stack metadata and the bootstrap version, because this repository makes no context lookups.
- **Trust.** Only principals of this account can assume the local roles, even if the stack's `TrustedAccounts` or `TrustedAccountsForLookup` parameters are set.

For ephemeral deploys, `scripts/cdk-app.mjs` passes `--change-set-name mcclocal1-deploy` and `--toolkit-stack-name CDKToolkitLocal` and rejects options that would bypass them ([details](self-hosting/50-deploy-and-release-applications.md)). Those checks only fail early; IAM refuses each option anyway.

This policy covers the currently implemented resources. Review and extend it when an application introduces a new AWS resource type, and never replace it with `AdministratorAccess`.

## Known limits

- SES receipt-rule APIs do not support IAM resource scoping, so the execution role creates, updates, deletes, and describes receipt rules on `*` for ephemeral email routes. It cannot change or activate receipt rule sets, but it does not isolate rule contents from arbitrary local templates.
- The per-developer S3 prefixes and roster partitions rely on the `Ephemeral` role tag. The execution role can tag any ephemeral role, so a deliberately crafted template can claim another developer's tag and reach their `ephemeral/<name>/` and `incoming/<name>/` objects and their roster partition.
- The file-publishing role is left as CDK ships it and can overwrite any object in the local staging bucket. CDK skips uploading an asset whose content hash already exists, so one developer can replace an asset that another developer's next deploy reuses.
- The SES send allowance accepts `noreply@` at any domain. SES still sends only from identities verified in this account, and while dev is in the SES sandbox, only to verified recipients.
- An ephemeral S3 rule can match object-created events for any bucket, so object keys and sizes in the shared buckets are visible to it. Object contents are not.

These limits keep developers from accidentally affecting each other and from changing shared dev; they do not isolate developers from each other. The bootstrap's IAM policy names are account-wide, matching the shared workload boundary, so bootstrap one Region per account.

## Validate the boundary

Use a disposable dev account with the dev foundation applied, and never run destructive denial probes against shared dev. Sign in with the local permission set and verify the identity, then:

1. Deploy, diff, and destroy `match-to-csv-e-<name>` through the wrapper, once with a 20-character name so generated resource names keep the application prefix. Send a message to `<alias>+<name>@<domain>` and confirm the workflow runs.
2. Run `cdk deploy` and `cdk destroy` targeting `admin-dev`, and `aws cloudformation update-stack` and `delete-stack` targeting every `<application>-dev`. Each write must return `AccessDenied`.
3. In policy simulation, check that `ExecuteChangeSet` for `cdk-deploy-change-set` is denied. Also check the execution role: it must be denied passing the default execution role, removing a runtime boundary, creating a role outside `/mcc-local/` or without the local boundary, and putting an EventBridge target on a `*-dev*` resource. For a runtime role, check that `dynamodb:GetItem` on the roster table is allowed with the leading key `ROSTER#ephemeral/<name>` and denied with `ROSTER#stable`.
4. Run a stock `cdk bootstrap --qualifier mcclocal1 --toolkit-stack-name CDKToolkitLocal`, without the generated template, and confirm the stack policy rejects the update.

After setting up local access, verify that a merge to `main` still deploys shared dev through GitHub Actions. The AWS-free tests in `scripts/local-cdk-bootstrap.test.mjs` evaluate the generated policies, check that the committed template matches a fresh generation and fits an inline template body, and synthesize every application; they do not replace this live validation.
