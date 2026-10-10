# Change the foundation

The foundation roots, `infrastructure/dev/foundation` and `infrastructure/prod/foundation`, hold KMS keys, durable storage, and the SSM parameters that applications read. Terrateam manages them. The merged commit is the foundation version; there is no separate release ID.

## Review and merge

1. Put reusable behavior in `infrastructure/modules/foundation` and environment-only values in the environment root.
2. Run `npm run tofu:fmt:check` and `npm run check`.
3. Open a pull request. Terrateam plans each affected root. A module change plans dev and prod. If a plan is missing or stale, comment `terrateam plan dev and foundation` or `terrateam plan prod and foundation`.
4. Read every planned action. Reject unexpected replacements, deletions, policy changes, a plan for the wrong account, or creation of a named resource that already exists.
5. Merge after the required checks pass.

Terrateam then applies dev. If dev succeeds, it plans and applies prod from the same commit without pausing. A prod-only change skips dev, and a dev-only change skips prod. A failed or stale dev apply blocks prod.

Do not comment `terrateam apply` on the normal path. Explicit apply commands are for recovery and must name the environment.

## Watch the applies

Compare the prod apply with the reviewed dev plan, allowing for environment names, account IDs, and values. Treat any replacement, deletion, wrong-account operation, or attempt to create an existing named resource as an incident and stop further foundation merges until it is understood.

Terrateam locks each root during apply. If another foundation change reaches `main` while an apply runs, Terrateam may mark the older run stale. Let the newer revision finish both layers, or re-plan it if Terrateam asks. Never force-unlock an active run.

Never apply the foundation from a local shell. If initialization reports a missing backend or a plan proposes recreating the foundation, stop and follow [Recover and troubleshoot](60-recover-and-troubleshoot.md#a-plan-wants-to-create-resources-that-already-exist).

Bootstrap changes do not go through Terrateam. See [Update bootstrap later](10-bootstrap-accounts.md#update-bootstrap-later).

Next: [Deploy, release, and roll back applications](50-deploy-and-release-applications.md).
