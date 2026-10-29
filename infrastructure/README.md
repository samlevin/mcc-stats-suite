# OpenTofu infrastructure

This directory holds the OpenTofu side of the split that [How AWS is divided](../README.md#how-aws-is-divided) describes. Environment roots live under `dev` and `prod`; reusable implementations live under `modules`.

| Root | Owner | Purpose |
|---|---|---|
| `<environment>/bootstrap` | Local administrator | State, GitHub OIDC, CI roles, and workload permissions boundary |
| `<environment>/foundation` | OpenTofu, by hand or from CI/CD | KMS, durable evidence storage, the gamertag roster and CSV recipient tables, the SES receipt rule set, and SSM resource contracts |
| `<environment>/data-platform` | OpenTofu, when activated | Shared analytics and lakehouse resources |
| `dev/local-cdk` | OpenTofu, from Terrateam or by hand | The `CDKToolkitLocal` stack, the restricted CDK bootstrap for ephemeral stacks |

## Bootstrap

The shared module is in `modules/bootstrap`. Its environment roots are:

```text
dev/bootstrap
prod/bootstrap
```

See [Bootstrap the dev and prod accounts](../docs/self-hosting/10-bootstrap-accounts.md) for the resource list and configuration. Apply bootstrap changes locally through an authorized IAM Identity Center session. CI/CD manages only stable operational roots.

## Local CDK bootstrap

`dev/local-cdk` has no prod counterpart. It deploys the `mcclocal1` CDK bootstrap as the `CDKToolkitLocal` CloudFormation stack from two committed files in the root: `bootstrap-template.json`, which `npm run cdk:local-template` regenerates through `scripts/local-cdk-bootstrap.mjs` from the pinned CDK, and `stack-policy.json`. A change to the local permissions or a CDK upgrade is a regenerated template in a pull request, planned and applied like any other dev root. See [Bootstrap local deployments separately](../docs/self-hosting/20-bootstrap-cdk.md#bootstrap-local-deployments-separately).

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

## SSM parameter namespaces

Everything under `/mcc/<environment>/` is application config: values that applications read, such as `/mcc/<environment>/match-to-csv/` and the data platform's `/mcc/<environment>/data-platform/`. Any application may read any of it, and the local workload boundary lets every ephemeral runtime role read any single parameter under `/mcc/dev/`. Parameters for CI or other shared infrastructure that applications must not read live under their own prefix, such as `/mcc-ci/<environment>/` for the Turbo cache contract. Never publish such a parameter under `/mcc/<environment>/`.

## Inbound email contract

Each foundation root owns the SES receipt rule set `mcc-inbound-<environment>`, its activation, and the `<alias>@<domain>` rule, which stores mail under `incoming/<environment>/` in the raw-email bucket. The domain and alias are the sensitive `email_domain` and `email_alias` inputs; keep them out of version control and out of plain CI variables. Terrateam reads them from the `DEV_MCC_EMAIL_DOMAIN` and `DEV_MCC_EMAIL_ALIAS` or `PROD_MCC_EMAIL_DOMAIN` and `PROD_MCC_EMAIL_ALIAS` repository secrets. A local apply, including one through `apply-foundation`, reads the applied values back from the SSM parameters through the root's ignored `.envrc`. After changing a secret, bump `<environment>/foundation/external-inputs.revision` in a pull request so Terrateam plans the root. The rule set name, domain, and alias are published at `/mcc/<environment>/match-to-csv/receipt-rule-set-name`, `/mcc/<environment>/match-to-csv/email-domain`, and `/mcc/<environment>/match-to-csv/email-alias`. The domain identity and MX record are manual prerequisites.

## Gamertag roster table

Each foundation root owns the DynamoDB table `<project>-<environment>-gamertag-roster`, the roster change log described in [spec 1.2](../specs/1.2-gamertag-roster.md#51-roster-table). It uses on-demand billing, string keys `pk` and `sk`, and the foundation application data key, and it has point-in-time recovery, deletion protection, and `prevent_destroy` in both environments, whatever `force_destroy` says. The table name and ARN are published at `/mcc/<environment>/roster/table-name` and `/mcc/<environment>/roster/table-arn`. OpenTofu manages no roster items, so roster contents never appear in state or plan output. CDK stacks read the parameters to grant their Lambdas access.

## CSV recipient table

Each foundation root owns the DynamoDB table `<project>-<environment>-csv-recipients`, the change log of the addresses that receive each submission's per-gamertag CSVs, described in [spec 1.1](../specs/1.1-mcc-analytics-engine.md#45-csv-recipient-list). It is configured like the roster table: on-demand billing, string keys `pk` and `sk`, the foundation application data key, point-in-time recovery, deletion protection, and `prevent_destroy` in both environments, whatever `force_destroy` says. The table name and ARN are published at `/mcc/<environment>/recipients/table-name` and `/mcc/<environment>/recipients/table-arn`. OpenTofu manages no items, so addresses never appear in state or plan output. Administrators maintain the list with `npm run recipients` ([Maintain the CSV recipient list](../docs/self-hosting/50-deploy-and-release-applications.md#maintain-the-csv-recipient-list)).

## Turborepo cache storage contract

The foundation module defines a cache bucket named `<project>-<environment>-<account>-turbo-cache` in each stable account. It blocks public access, requires TLS, and encrypts objects with the existing foundation KMS key and S3 Bucket Keys. Objects expire after seven days in both dev and prod; incomplete multipart uploads are aborted after seven days. Versioning and Object Lock are disabled because cache artifacts are reproducible.

Both foundation roots publish `foundation.turbo_cache_bucket_name` and `foundation.turbo_cache_key_arn`. The matching SSM parameters are `/mcc-ci/<environment>/turbo-cache/bucket-name` and `/mcc-ci/<environment>/turbo-cache/data-key-arn`, outside the application namespace described in [SSM parameter namespaces](#ssm-parameter-namespaces).

Both stable roots create a dedicated `mcc-stats-suite-<environment>-github-turbo-cache` OIDC role when `github_oidc_subject_repository` is set. `github_turbo_cache_role_arn` publishes its ARN. The dev root also creates `mcc-stats-suite-dev-github-turbo-cache-read`, a read-only role for pull requests. See [Turbo cache](../docs/self-hosting/30-configure-github.md#turbo-cache) for activation and repository settings, and [Update bootstrap later](../docs/self-hosting/10-bootstrap-accounts.md#update-bootstrap-later) for the prerequisite bootstrap grant when using Terrateam.

### How CI uses the cache

`main` validation writes the dev bucket, and same-repo pull requests read it, through `rharkor/caching-for-turbo@v2.5.1`. Dev deployments use that bucket; production promotion and rollback builds use the prod bucket. The cache role resolves and validates the environment's bucket and KMS SSM contracts. OS, architecture, and Node version isolate object prefixes.

`MCC_BUILD_ENVIRONMENT` participates in Turbo task hashes, and the explicitly worktree-local cache prevents another checkout from supplying outputs. Each deployment job has a fresh runner and exactly one environment, so a rollback to a release whose Turbo configuration lacks this hash input still cannot reuse another environment's outputs.

The write role's main-only trust policy rejects pull request subjects and refs. Same-repo pull requests assume the dev read-only role instead, which trusts only this repository's `pull_request` subject. It can list, read, and decrypt the dev cache prefix but cannot write it, so pull request code cannot poison the cache that `main` builds. Those runs also set `TURBO_CACHE=local:rw,remote:r`, so Turbo never tries to upload. Fork pull requests get no OIDC token, skip the cache step, and use only their ephemeral local cache. The remote API credentials are passed explicitly from the cache role to the action, including its session token, so later CDK credentials cannot replace that session. AWS credentials are removed from the build environment after the server starts.

The action performs prefix-scoped bucket listing for hash lookup, but has no deletion grant or action cleanup settings; lifecycle expiry removes old objects.

To empty a populated cache bucket manually, use an approved service workload role with a separately reviewed deletion grant, or wait for lifecycle expiry.

Run the AWS-free contract tests with fake provider credentials and local-plan overrides:

```console
tofu -chdir=infrastructure/dev/foundation init -backend=false -lockfile=readonly -test-directory=../../modules/foundation/tests
tofu -chdir=infrastructure/dev/foundation validate
tofu -chdir=infrastructure/dev/foundation test -test-directory=../../modules/foundation/tests
tofu -chdir=infrastructure/prod/foundation init -backend=false -lockfile=readonly -test-directory=../../modules/foundation/tests
tofu -chdir=infrastructure/prod/foundation validate
```

These tests check dev/prod naming and SSM contracts, retention, encryption, IAM policy statements, and invalid service-role inputs. `dev-root.tftest.hcl` also plans the dev foundation root itself as on a fresh account, so a root-level `import` block, which needs its resource to exist, fails it. None of these tests inspect deployed resources. Review real environment plans before accepting infrastructure changes.
