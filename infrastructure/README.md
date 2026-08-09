# OpenTofu bootstrap implementation

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

Do not run OpenTofu from this directory. Use the dev or prod environment root
with the account access and deployment process your organization provides.
