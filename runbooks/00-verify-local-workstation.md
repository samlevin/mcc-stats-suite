# Verify the local workstation

Run from the repository root:

```console
direnv version
node --version
tofu version
aws --version
npm ci
npm run check
tofu fmt -check -recursive infrastructure
git status --short
```

Expected:

- Node reports 22.x.
- OpenTofu reports 1.12.1.
- direnv is installed and its shell hook is active.
- Workspace tests, type checks, and builds pass.
- You understand every existing worktree change before continuing.

Next: [`01-verify-project-access.md`](01-verify-project-access.md).
