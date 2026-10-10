# Self-hosting

These guides set up and operate your own MCC Stats Suite deployment: two AWS accounts, OpenTofu foundation managed by Terrateam, and application stacks deployed by GitHub Actions. The maintainer's deployment uses the same procedures.

You do not need any of this to contribute. Contributors only need the local checks in [CONTRIBUTING.md](../../CONTRIBUTING.md). A merged pull request deploys to the maintainer's environments automatically.

Set up a new deployment in this order:

1. [Check prerequisites](00-prerequisites.md)
2. [Bootstrap the dev and prod accounts](10-bootstrap-accounts.md)
3. [Bootstrap CDK and grant local deploy access](20-bootstrap-cdk.md)
4. [Configure GitHub, Terrateam, and Release Please](30-configure-github.md)

Then operate it:

- [Change the foundation](40-change-foundation.md)
- [Deploy, release, and roll back applications](50-deploy-and-release-applications.md)
- [Recover and troubleshoot](60-recover-and-troubleshoot.md)

To build the AWS organization itself (Control Tower, Identity Center, account vending), follow [samlevin/aws-bootstrap](https://github.com/samlevin/aws-bootstrap) first.
