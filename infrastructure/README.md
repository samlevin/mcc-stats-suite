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

Foundation code is not packaged or assigned a separate release ID. The exact pull-request Git commit is its version, and Terrateam saves the plan for that revision. Apply `dev and foundation`, validate it, then apply `prod and foundation` from the same unchanged pull request when the change is intended for both environments. Adding a commit invalidates the promotion candidate and requires another dev plan, apply, and validation.

Changes to `modules/foundation` trigger both environment roots. Changes confined to one environment root trigger only that environment. Terrateam checks foundation roots for drift weekly, opens an issue for a non-empty drift plan, and never reconciles automatically.

Do not run OpenTofu from this directory. Use the bootstrap procedure for initial account setup and the Terrateam runbooks for stable foundation changes.
