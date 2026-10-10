# Bootstrap OpenTofu

Bootstrap each account once from an administrator SSO session. This creates the state bucket, OIDC provider, Terrateam role, CDK deploy role, and workload boundary. It is intentionally local; Terrateam manages foundation changes only after this step.

1. Copy the repository template and replace its placeholders:

   ```console
   cp .envrc.example .envrc
   direnv allow
   ```

2. Configure and allow the environment-specific template. Start with dev:

   ```console
   cd infrastructure/dev/bootstrap
   cp .envrc.example .envrc
   direnv allow
   aws sso login --profile "$AWS_PROFILE"
   aws sts get-caller-identity
   ```

   Confirm the returned account is dev. For prod, use `infrastructure/prod/bootstrap` and confirm prod before applying.

3. Create the bootstrap resources with local state:

   ```console
   tofu init -reconfigure
   tofu plan
   tofu apply
   ```

4. Move that state into the new bucket. Create the ignored backend
   configuration, then replace its values with `tofu output
   bootstrap_backend_config` while the state is still local:

   ```console
   cp backend.hcl.example backend.hcl
   tofu output bootstrap_backend_config
   cp backend.tf.example backend.tf
   tofu init -migrate-state -backend-config=backend.hcl
   tofu plan
   ```

   Approve the migration. The final plan must report no changes.

Repeat for prod only when its inputs and administrator profile are ready. Keep
each bootstrap root local; do not connect it to Terrateam. The repository configuration explicitly excludes both bootstrap roots, including indexer-discovered changes to their shared module, and disables their automatic plans and applies.

Next: [`10-configure-terrateam-and-github.md`](10-configure-terrateam-and-github.md).


## Update cache workload permissions

Before applying the cache foundation in PR #14, apply this reviewed bootstrap update separately in each account from the administrator SSO session described above. The Terrateam inline policy permits management of only the exact `mcc-stats-suite-<environment>-github-turbo-cache` role and requires the existing workload boundary at creation. PowerUserAccess alone cannot create IAM roles. The grant does not permit changing/removing the boundary, attaching managed policies, or managing other roles. Bootstrap creates no cache workload role or bucket.

Run the AWS-free dev/prod permission contract tests from the repository root:

```console
tofu -chdir=infrastructure/dev/bootstrap init -backend=false -lockfile=readonly -test-directory=../../modules/bootstrap/tests
tofu -chdir=infrastructure/dev/bootstrap test -test-directory=../../modules/bootstrap/tests
```
