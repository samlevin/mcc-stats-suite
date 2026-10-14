# OpenTofu infrastructure

OpenTofu owns account bootstrap and persistent resources shared by application releases. Environment roots live under `dev` and `prod`; reusable implementations live under `modules`.

| Root | Owner | Purpose |
|---|---|---|
| `<environment>/bootstrap` | Local administrator | State, GitHub OIDC, CI roles, and workload permissions boundary |
| `<environment>/foundation` | OpenTofu, by hand or from CI/CD | KMS, durable evidence storage, the SES receipt rule set, and SSM resource contracts |
| `<environment>/data-platform` | OpenTofu, when activated | Shared analytics and lakehouse resources |

## Bootstrap

The shared module is in `modules/bootstrap`. Its environment roots are:

```text
dev/bootstrap
prod/bootstrap
```

For stable accounts, each root creates:

- a private, encrypted, versioned S3 state bucket
- native S3 state locking
- the GitHub Actions OIDC provider, or reuse of an existing provider
- optionally, a Terrateam role restricted to the repository's Terrateam workflow
- a protected-environment CDK role restricted to the deployment workflow on
  `main`
- a permissions boundary for application runtime roles

Set `create_terrateam_role = false` unless you apply the foundation with
Terrateam. For a disposable, locally managed dev account, also set
`create_cdk_deploy_role = false`. The root then omits GitHub OIDC and CI roles
while retaining state and the workload boundary.

The state bucket uses deletion protection, requires TLS, and retains noncurrent
versions for 90 days. Both CI roles receive `PowerUserAccess`; the CDK entry
role may assume only this account's `cdk-*` bootstrap roles. The Terrateam role
cannot administer IAM beyond the Turbo cache role, and neither CI role operates
this bootstrap state.

Apply bootstrap changes locally through an authorized IAM Identity Center
session. CI/CD manages only stable operational roots.

## Local inputs

Every root under `dev` and `prod` reads its inputs from its own ignored,
self-contained `.envrc`, created from the committed `.envrc.example`. `AWS_*`
names are for the AWS CLI and SDKs, `TF_VAR_<name>` sets only the OpenTofu
input `<name>`, and `TF_CLI_ARGS_init` carries the backend bucket and Region.
The `.envrc` derives the account and Region from the AWS profile and builds the
state bucket `mcc-stats-suite-tofu-state-<account>-<region>`. Each root's
`backend "s3"` block holds its own key, `encrypt`, and `use_lockfile`; for
bootstrap, that block is in `backend.tf.example`, which you copy to
`backend.tf` after the first apply. See
[Configure local inputs](../docs/self-hosting/10-bootstrap-accounts.md#configure-local-inputs).

## Foundation promotion

Foundation code is not packaged or assigned a separate release ID. Plan and apply dev, then prod, from the same commit, by hand or from any infrastructure CI/CD. Follow [Apply and change the foundation](../docs/self-hosting/40-change-foundation.md). To use Terrateam, as the upstream repository does, see [Apply the foundation with Terrateam](../docs/self-hosting/70-optional-terrateam.md).

Do not run OpenTofu from this directory. Use [the bootstrap procedure](../docs/self-hosting/10-bootstrap-accounts.md) for account setup and run each environment root separately.

## Inbound email contract

Each foundation root owns the SES receipt rule set `mcc-inbound-<environment>`, its activation, and the `<alias>@<domain>` rule, which stores mail under `incoming/<environment>/` in the raw-email bucket. The domain and alias are the sensitive `email_domain` and `email_alias` inputs; keep them out of version control and out of plain CI variables. Terrateam reads them from the `DEV_MCC_EMAIL_DOMAIN` and `DEV_MCC_EMAIL_ALIAS` or `PROD_MCC_EMAIL_DOMAIN` and `PROD_MCC_EMAIL_ALIAS` repository secrets. A local apply, including one through `mcc-apply-foundation`, reads the applied values back from the SSM parameters through the root's ignored `.envrc`. After changing a secret, bump `<environment>/foundation/external-inputs.revision` in a pull request so Terrateam plans the root. The rule set name, domain, and alias are published at `/mcc/<environment>/match-to-csv/receipt-rule-set-name`, `/mcc/<environment>/match-to-csv/email-domain`, and `/mcc/<environment>/match-to-csv/email-alias`. The domain identity and MX record are manual prerequisites.

## Turborepo cache storage contract

The foundation module defines a cache bucket named `<project>-<environment>-<account>-turbo-cache` in each stable account. It blocks public access, requires TLS, and encrypts objects with the existing foundation KMS key and S3 Bucket Keys. Objects expire after seven days in both dev and prod; incomplete multipart uploads are aborted after seven days. Versioning and Object Lock are disabled because cache artifacts are reproducible.

Both foundation roots publish `foundation.turbo_cache_bucket_name` and `foundation.turbo_cache_key_arn`. The matching SSM parameters are `/mcc/<environment>/turbo-cache/bucket-name` and `/mcc/<environment>/turbo-cache/data-key-arn`.

When the Terrateam role applies the foundation, it can create this cache role only after the bootstrap grants it permission. Apply the bootstrap first, following [Update bootstrap later](../docs/self-hosting/10-bootstrap-accounts.md#update-bootstrap-later).

Both stable roots create a dedicated `mcc-stats-suite-<environment>-github-turbo-cache` OIDC role. It uses the existing bootstrap GitHub provider and workload permissions boundary; foundation never creates a second provider. The role trusts only the repository named by `github_oidc_subject_repository`, at `refs/heads/main`, so a fork's foundation creates a role for the fork and never trusts upstream. Dev accepts the main branch subject for CI and the protected dev environment subject for deployment builds. Prod accepts only the protected prod environment subject. When GitHub immutable repository subjects are enabled, pass `OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID`, matching bootstrap, to both foundation roots as `github_oidc_subject_repository` (each foundation root's `.envrc` exports it as `TF_VAR_github_oidc_subject_repository`, and Terrateam builds it from the runner's repository variables). Without immutable subjects, pass `OWNER/REPOSITORY`. A root without the value creates no cache role. No pull request subject is trusted.

The dedicated role can read the two environment-specific SSM cache contracts, list hash candidates only under `turbogha/<environment>/`, and read/write/abort multipart uploads only in that prefix. KMS decrypt/data-key permissions require the regional S3 service and this bucket's encryption context with S3 Bucket Keys. It cannot delete cache objects, administer IAM, read evidence, use another environment's cache, or use the key directly. `github_turbo_cache_role_arn` publishes the role ARN. `main` CI reads the repository `DEV_AWS_ACCOUNT_ID` secret and `DEV_AWS_REGION` variable, and deployments read the `DEV_` or `PROD_` pair of the environment they deploy. Every cache step in CI and deployments runs only when the repository variable `MCC_TURBO_CACHE` is `true`, so a repository that has not opted in builds uncached.

`cache_service_role_arns` remains an additional explicit same-account workload allowlist and defaults empty. The managed CI cache role is included automatically in both stable roots. Bucket policy denies data/listing access to other principals, including broadly privileged CDK deployment roles. The allowlist removes a denial and grants no permissions itself. Lifecycle expiration still works. OpenTofu `HeadBucket` refreshes remain possible because the listing denial applies to positive `s3:max-keys`, which object-list requests supply; metadata-only refreshes expose no cache names.

The `turbo_cache_service_policy_json` output preserves the minimal object/KMS policy for additional approved workload roles. The managed CI role adds prefix-scoped listing because the selected v2 S3 provider calls `ListObjectsV2` before `GetObject`. Cleanup options are omitted and deletion is denied; S3 lifecycle owns seven-day expiry. CI uses an explicit temporary cache session, including its session token, independently of later deployment credentials.

To empty a populated cache bucket manually, use an approved service workload role with a separately reviewed deletion grant, or wait for lifecycle expiry. A deployment role cannot bypass the data denial with `force_destroy`.

Run the AWS-free contract tests with fake provider credentials and local-plan overrides:

```console
tofu -chdir=infrastructure/dev/foundation init -backend=false -lockfile=readonly -test-directory=../../modules/foundation/tests
tofu -chdir=infrastructure/dev/foundation validate
tofu -chdir=infrastructure/dev/foundation test -test-directory=../../modules/foundation/tests
tofu -chdir=infrastructure/prod/foundation init -backend=false -lockfile=readonly -test-directory=../../modules/foundation/tests
tofu -chdir=infrastructure/prod/foundation validate
```

These tests check dev/prod naming and SSM contracts, retention, encryption, IAM policy statements, and invalid service-role inputs. They do not inspect deployed resources. Review real environment plans before accepting the infrastructure change; expected changes are the cache bucket's controls, its SSM parameters, and outputs, with no evidence bucket, KMS key, or deployment-role replacement.
