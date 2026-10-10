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

The foundation module defines a cache bucket named `<project>-<environment>-<account>-turbo-cache` in each stable account. It blocks public access, requires TLS, and encrypts objects with the existing foundation KMS key and S3 Bucket Keys. Objects expire after 30 days; incomplete multipart uploads are aborted after seven days. Versioning and Object Lock are disabled because cache artifacts are reproducible.

Both foundation roots publish `foundation.turbo_cache_bucket_name` and `foundation.turbo_cache_key_arn`. The matching SSM parameters are `/mcc/<environment>/turbo-cache/bucket-name` and `/mcc/<environment>/turbo-cache/data-key-arn`.

`cache_service_role_arns` defaults to an empty set. The bucket denies all object operations and cache listing to principals outside that set, including GitHub Actions deployment roles with broad identity permissions. Bucket administration remains available to foundation automation. Lifecycle expiry still works. Before configuring a future service, select its runtime and authentication contract, review its trust policy separately, and add only explicit same-account workload role ARNs. Never add GitHub Actions roles. The allowlist removes a denial; it does not grant permissions.

The `turbo_cache_service_policy_json` output describes an identity policy for that future role. It permits only `s3:GetObject` and `s3:PutObject` on cache objects, plus `kms:Decrypt` and `kms:GenerateDataKey` on the foundation key through the regional S3 service with this bucket's encryption context. The KMS condition relies on S3 Bucket Keys remaining enabled. It grants no bucket listing, deletion, IAM administration, or direct key use. No service role, trust policy, HTTP remote-cache API, or workflow cache configuration is created here.

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
