# Connect GitHub and Terrateam

Do this only after the stable account bootstraps have succeeded. Do not run
Terrateam's generic AWS bootstrap in addition to this repository's bootstrap.

## Install Terrateam

1. Sign up for Terrateam Cloud and choose the existing GitHub repository.
2. Install the GitHub App for only the intended repository.
3. Accept and commit Terrateam's generated
   `.github/workflows/terrateam.yml` on `main`.
4. Commit `.terrateam/config.yml` from the supplied example.
5. Never add either `bootstrap` directory to Terrateam.

Terrateam and GitHub Actions authenticate with short-lived GitHub OIDC tokens.
There are no AWS access keys to create or store.

## Configure Terrateam runtime variables

In **GitHub repository → Settings → Secrets and variables → Actions →
Variables**, add:

```text
DEV_TERRATEAM_ROLE_ARN
DEV_TOFU_STATE_BUCKET
DEV_AWS_REGION
PROD_TERRATEAM_ROLE_ARN
PROD_TOFU_STATE_BUCKET
PROD_AWS_REGION
```

Copy values from the matching bootstrap outputs. Never swap dev and prod
buckets or role ARNs.

The committed Terrateam configuration restricts dev apply to repository writers
and prod apply to repository administrators. It auto-plans, but never
auto-applies. A dev promotion PR changes the module and dev `release_id`; after
validation, a separate prod promotion PR advances prod to the same release ID.

## Configure GitHub CDK environments

Create GitHub Environments named `dev` and `prod`. Add these environment
variables to each using its own bootstrap outputs:

```text
AWS_ACCOUNT_ID
AWS_CDK_DEPLOY_ROLE_ARN
AWS_REGION
```

Add `STATS_RECIPIENT_EMAIL` as an environment **secret**, because it can expose
a personal address or inbound domain. No AWS credential is stored in GitHub.

For `prod`:

- restrict deployment to `main`;
- require a reviewer when the repository plan supports it;
- prevent self-review when another maintainer exists; and
- disable administrator bypass when practical.

For a newly created GitHub repository, GitHub's OIDC subject may contain
immutable owner and repository IDs. If so, populate
`github_oidc_subject_repository` as `OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID`
before the AWS bootstrap. A repository rename or transfer can require a trust
update.

References:

- [Terrateam AWS OIDC setup](https://docs.terrateam.io/integrations/cloud-providers/aws/oidc-setup/)
- [Harden Terrateam AWS OIDC](https://docs.terrateam.io/security/hardening-aws-oidc)
- [Terrateam secrets and variables](https://docs.terrateam.io/configuration/variables/)
- [GitHub OIDC subject reference](https://docs.github.com/en/actions/reference/security/oidc)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)

Next: [Operate the account lifecycle](90-operate-account-lifecycle.md).
