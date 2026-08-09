# Project runbooks

These runbooks assume you provide a `dev` account and a `prod` account with the
access and deployment setup your organization requires. They do not prescribe
AWS account, identity, state, or CI architecture.

1. [Verify your workstation](00-verify-local-workstation.md)
2. [Verify dev and prod access](01-verify-project-access.md)
3. [Bootstrap OpenTofu](02-bootstrap-opentofu.md)
4. [Configure CI](10-configure-terrateam-and-github.md)
5. [Apply foundation changes to dev](20-promote-foundation-to-dev.md)
6. [Deploy a personal dev stack](21-deploy-personal-match-to-csv.md)
7. [Validate the shared dev application](22-validate-match-to-csv-in-dev.md)
8. [Promote foundation changes to prod](30-promote-foundation-to-prod.md)
9. [Promote the application to prod](31-promote-match-to-csv-to-prod.md)
10. [Recover and troubleshoot](40-recover-and-troubleshoot.md)
