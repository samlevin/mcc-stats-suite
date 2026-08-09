# Promote match-to-csv to production

Promote a commit already tested in dev.

1. Require root workspace tests and CDK synthesis to pass.
2. Confirm the production foundation promotion is complete.
3. Merge the tested application change to `main`.
4. Open **GitHub Actions → deploy-aws-application → Run workflow**.
5. Select `match-to-csv` and `prod` from `main`.
6. Approve the protected `prod` Environment deployment.
7. Review CloudFormation events and smoke-test a non-sensitive email.

The local wrapper refuses production deployment and destruction. Production is
GitOps-only.

Use a new dev promotion cycle for any correction; do not patch the production
CloudFormation resources manually.

Next: [`40-recover-and-troubleshoot.md`](40-recover-and-troubleshoot.md).
