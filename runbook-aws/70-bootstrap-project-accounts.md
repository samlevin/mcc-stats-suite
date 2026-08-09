# Bootstrap project deployment access

AWS Organizations and human Identity Center assignments remain manually
managed. This repository bootstraps only project-owned state and deployment
identities inside workload accounts.

## Stable dev and prod

With the matching Platform Administrator SSO profile, run each account's local
OpenTofu bootstrap exactly once. It creates:

- an encrypted, versioned, deletion-protected S3 state bucket;
- the GitHub Actions OIDC provider when the account does not already have one;
- a repository-scoped Terrateam role;
- a GitHub Environment-scoped CDK entry role; and
- the workload-role permissions boundary.

Immediately migrate bootstrap state from temporary local state into the new S3
bucket. The bootstrap remains human-operated so CI identities cannot rewrite
their own trust.

Use the project procedures:

- [Bootstrap stable dev](71-bootstrap-stable-dev.md)
- [Bootstrap stable prod](72-bootstrap-stable-prod.md)

## Disposable developer account

Use a separate checkout or worktree so its ignored backend files and `.terraform`
metadata can never be confused with stable dev. Reuse the dev bootstrap root,
but set these local inputs before applying:

```hcl
create_terrateam_role  = false
create_cdk_deploy_role = false
```

This creates state and the workload boundary without trusting GitHub. Apply the
dev foundation against that account's new state bucket, then bootstrap CDK from
the developer's SSO session. Run a local plan before every apply and verify STS
after every profile change. Destroy CDK stacks and the foundation before
recycling the account.

## Local configuration policy

The following files are ignored and must stay untracked:

```text
**/backend.hcl
**/*.auto.tfvars
*.tfstate*
*.tfplan
.env*
```

Use only `.example` files in commits. Role ARNs and account IDs are not secret
credentials, but keeping them in GitHub runtime variables makes a public fork
portable and avoids publishing account topology.

Next: [Bootstrap stable dev](71-bootstrap-stable-dev.md).
