# Verify project access

Verify the profiles you use for dev and prod:

```console
aws sso login --profile <dev-profile>
aws sts get-caller-identity --profile <dev-profile>
aws sso login --profile <prod-profile>
aws sts get-caller-identity --profile <prod-profile>
```

Confirm the account IDs differ. Use a dev profile for local development. Use an
administrator profile only for the one-time bootstrap; normal production
changes use the protected deployment process, not local commands.

Next: [`02-bootstrap-opentofu.md`](02-bootstrap-opentofu.md).
