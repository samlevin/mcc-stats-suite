# Configure CI

Connect your CI system to dev and prod. This repository supports Terrateam for
OpenTofu and GitHub Actions for CDK, but you may use an equivalent process.

If using Terrateam, copy `.terrateam/config.yml.example` to
`.terrateam/config.yml`, install the GitHub App, and commit its generated
workflow. Configure GitHub Environments named `dev` and `prod`; protect `prod`
so only reviewed changes from `main` can deploy.

Do not store long-lived AWS access keys in the repository or GitHub.

Next: [`20-promote-foundation-to-dev.md`](20-promote-foundation-to-dev.md).
