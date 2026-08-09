# AWS landing-zone runbook

This guide takes a new AWS customer from one account to a governed organization
that can run this project. It is optional for contributors who already have
stable `dev` and `prod` accounts and the required deployment roles.

If the landing zone is already healthy and only the management administrator
exists, use the consolidated
[post-landing-zone setup](35-complete-post-landing-zone-setup.md), then continue
with the project runbooks.

Follow the files in order:

1. [Plan accounts, names, email, and Regions](00-plan-account-layout.md)
2. [Create and secure the management account](10-secure-management-account.md)
3. [Create the Control Tower landing zone](20-create-control-tower-landing-zone.md)
4. [Configure initial Production controls](25-configure-production-controls.md)
5. [Configure Identity Center access](30-configure-identity-center-access.md)
6. [Provision stable and disposable accounts](40-provision-workload-accounts.md)
7. [Centralize member-account root access](50-centralize-member-root-access.md)
8. [Configure local SSO profiles](60-configure-local-sso.md)
9. [Bootstrap project deployment access](70-bootstrap-project-accounts.md)
10. [Bootstrap stable dev](71-bootstrap-stable-dev.md)
11. [Bootstrap stable prod](72-bootstrap-stable-prod.md)
12. [Bootstrap CDK](73-bootstrap-cdk.md)
13. [Grant local CDK deployer access](74-grant-local-cdk-deployer-access.md)
14. [Connect GitHub and Terrateam](80-connect-github-and-terrateam.md)
15. [Secure Terrateam in a public repository](81-secure-terrateam-in-a-public-repository.md)
16. [Operate and retire accounts](90-operate-account-lifecycle.md)

The intended result is:

```text
AWS organization
├── management account             organization administration only
├── Security OU
│   ├── Log Archive account        Control Tower managed
│   └── Audit account              Control Tower managed
├── Sandbox OU
│   ├── dev account                stable; Terrateam-managed OpenTofu
│   └── dev-<owner> accounts       disposable; locally managed
└── Production OU
    └── prod account               stable; Terrateam-managed OpenTofu
```

Personal CDK stacks live in the stable dev account and are named
`match-to-csv-<owner>`. The shared integration stack is `match-to-csv-dev`;
production is `match-to-csv-prod`.

Do not put root passwords, MFA recovery material, AWS access keys, account
request files, populated OpenTofu inputs, or backend configuration in Git.
