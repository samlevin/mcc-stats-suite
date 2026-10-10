# OpenTofu infrastructure

OpenTofu owns account bootstrap and persistent resources shared by application releases. Environment roots live under `dev` and `prod`; reusable implementations live under `modules`.

| Root | Owner | Purpose |
|---|---|---|
| `<environment>/bootstrap` | Local administrator | State, GitHub OIDC, CI roles, and workload permissions boundary |
| `<environment>/foundation` | Terrateam | KMS, durable evidence storage, and SSM resource contracts |
| `<environment>/data-platform` | Terrateam when activated | Shared analytics and lakehouse resources |

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
- a Terrateam role restricted to the repository's Terrateam workflow
- a protected-environment CDK role restricted to the deployment workflow on
  `main`
- a permissions boundary for application runtime roles

For a disposable, locally managed dev account, set
`create_terrateam_role = false` and `create_cdk_deploy_role = false`. The root
then omits GitHub OIDC and CI roles while retaining state and the workload
boundary.

The state bucket uses deletion protection, requires TLS, and retains noncurrent
versions for 90 days. Both CI roles receive `PowerUserAccess`; the CDK entry
role may assume only this account's `cdk-*` bootstrap roles. Terrateam cannot
administer IAM, and neither CI role operates this bootstrap state.

Apply bootstrap changes locally through an authorized IAM Identity Center
session. Terrateam manages only stable operational roots.

## Foundation promotion

Foundation code is not packaged or assigned a separate release ID. Terrateam plans pull-request revisions. After merge, it applies the merged revision to dev before planning and applying prod. A failed or stale dev layer blocks prod. Follow the [dev review](../runbooks/20-promote-foundation-to-dev.md) and [prod verification](../runbooks/30-promote-foundation-to-prod.md) procedures.

Changes to `modules/foundation` trigger both environment roots. Changes confined to one environment root trigger only that environment. Terrateam checks foundation roots for drift weekly, opens an issue for a non-empty drift plan, and never reconciles automatically.

Do not run OpenTofu from this directory. Use the bootstrap procedure for initial account setup and the Terrateam runbooks for stable foundation changes.

## Turborepo cache storage contract

The foundation module defines a cache bucket named `<project>-<environment>-<account>-turbo-cache` in each stable account. It blocks public access, requires TLS, and encrypts objects with the existing foundation KMS key and S3 Bucket Keys. Objects expire after seven days in both dev and prod; incomplete multipart uploads are aborted after seven days. Versioning and Object Lock are disabled because cache artifacts are reproducible.

Both foundation roots publish `foundation.turbo_cache_bucket_name` and `foundation.turbo_cache_key_arn`. The matching SSM parameters are `/mcc/<environment>/turbo-cache/bucket-name` and `/mcc/<environment>/turbo-cache/data-key-arn`.

Before the foundation update, apply the separate bootstrap permission change in each account. Follow [the bootstrap update procedure](../runbooks/02-bootstrap-opentofu.md#update-cache-workload-permissions).

Both stable roots create a dedicated `mcc-stats-suite-<environment>-github-turbo-cache` OIDC role. It uses the existing bootstrap GitHub provider and workload permissions boundary; foundation never creates a second provider. The role trusts this repository at `refs/heads/main`. Dev accepts the main branch subject for CI and the protected dev environment subject for deployment builds. Prod accepts only the protected prod environment subject. When GitHub immutable repository subjects are enabled, set the `MCC_GITHUB_OIDC_SUBJECT_REPOSITORY` repository variable to `OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID`, matching bootstrap. Terrateam passes it to both foundation roots as `github_oidc_subject_repository`; without it, the role trusts the mutable `OWNER/REPOSITORY` subject that GitHub no longer sends. No pull request subject is trusted.

The dedicated role can read the two environment-specific SSM cache contracts, list hash candidates only under `turbogha/<environment>/`, and read/write/abort multipart uploads only in that prefix. KMS decrypt/data-key permissions require the regional S3 service and this bucket's encryption context with S3 Bucket Keys. It cannot delete cache objects, administer IAM, read evidence, use another environment's cache, or use the key directly. `github_turbo_cache_role_arn` publishes the role ARN. Configure repository `DEV_AWS_ACCOUNT_ID` and `DEV_AWS_REGION` for trusted CI; deployments use the existing protected environment account/region variables.

`cache_service_role_arns` remains an additional explicit same-account workload allowlist and defaults empty. The managed CI cache role is included automatically in both stable roots. Bucket policy denies data/listing access to other principals, including broadly privileged CDK deployment roles. The allowlist removes a denial and grants no permissions itself. Lifecycle expiration still works. OpenTofu `HeadBucket` refreshes remain possible because the listing denial applies to positive `s3:max-keys`, which object-list requests supply; metadata-only refreshes expose no cache names.

The `turbo_cache_service_policy_json` output preserves the minimal object/KMS policy for additional approved workload roles. The managed CI role adds prefix-scoped listing because the selected v2 S3 provider calls `ListObjectsV2` before `GetObject`. Cleanup options are omitted and deletion is denied; S3 lifecycle owns seven-day expiry. Cache integration in PR #13 uses an explicit temporary cache session, including its session token, independently of later deployment credentials.

To empty a populated cache bucket manually, use an approved service workload role with a separately reviewed deletion grant, or wait for lifecycle expiry. A deployment role cannot bypass the data denial with `force_destroy`.

Run the AWS-free contract tests with fake provider credentials and local-plan overrides:

```console
tofu -chdir=infrastructure/dev/foundation init -backend=false -lockfile=readonly -test-directory=../../modules/foundation/tests
tofu -chdir=infrastructure/dev/foundation validate
tofu -chdir=infrastructure/dev/foundation test -test-directory=../../modules/foundation/tests
tofu -chdir=infrastructure/prod/foundation init -backend=false -lockfile=readonly -test-directory=../../modules/foundation/tests
tofu -chdir=infrastructure/prod/foundation validate
```

These tests check dev/prod naming and SSM contracts, retention, encryption, IAM policy statements, and invalid service-role inputs. They do not inspect deployed resources. Review real environment plans through Terrateam before accepting the infrastructure change; expected changes are the cache bucket's controls, its SSM parameters, and outputs, with no evidence bucket, KMS key, or deployment-role replacement.
