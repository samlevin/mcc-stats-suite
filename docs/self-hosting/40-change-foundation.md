# Change the foundation

The foundation roots, `infrastructure/dev/foundation` and `infrastructure/prod/foundation`, hold KMS keys, durable storage, and the SSM parameters that applications read. Terrateam manages them, and every apply happens from the pull request. Nothing applies from `main`. The merged commit is the foundation version; there is no separate release ID.

## Plan

1. Put reusable behavior in `infrastructure/modules/foundation` and environment-only values in the environment root.
2. Run the full infrastructure formatting, validation, and module-test loop in [TESTING.md](../../TESTING.md), along with `npm run check`.
3. Open a pull request. Terrateam plans nothing until someone asks. Comment `terrateam plan` to start. A module change or a `.terrateam/config.yml` change affects dev and prod, and a change to one environment root affects only that root. When dev is affected, the comment plans dev only, and prod plans after the dev apply. A change confined to `infrastructure/prod/foundation` plans prod at once. After pushing a new commit, comment `terrateam plan` again.
4. Read every planned action. Reject unexpected replacements, deletions, policy changes, a plan for the wrong account, or creation of a named resource that already exists.

## Apply dev, then prod

1. Comment `terrateam apply dev and foundation`. Terrateam locks the dev root for this pull request. No other pull request can apply it until this one merges.
2. Validate dev. If the change needs fixing, push a new commit, comment `terrateam plan`, review the new plan, and apply dev again.
3. After the dev apply succeeds, Terrateam plans prod. If no prod plan appears, comment `terrateam plan prod and foundation`. Compare the prod plan with the applied dev plan, allowing for environment names, account IDs, and values. Prod cannot plan or apply until dev has applied.
4. Comment `terrateam apply prod and foundation`. Terrateam locks the prod root until the pull request merges. Only repository administrators can apply prod. Terrateam runs in the `infra/foundation-dev` and `infra/foundation-prod` environments, which have no required reviewers, so neither apply waits for an Actions approval.

When every planned root has applied without error, Terrateam squash-merges the pull request using its title. It never merges after a failed apply. Because prod waits for dev whenever dev is in the run, a pull request ends after a dev-only, prod-only, or dev-then-prod sequence; a change confined to `infrastructure/prod/foundation` has no dev layer. The merge releases the locks, and nothing else runs. If the merge is blocked, for example by a pending required check, merge the pull request yourself once the checks pass.

Terrateam takes a lock only when it applies a root, and the merge releases it. Merging a pull request that Terrateam never applied, such as one applied outside Terrateam, takes no lock and does not block later foundation pull requests. Never force-unlock a pull request that has applied part of a change.

If initialization reports a missing backend or a plan proposes recreating the foundation, stop and follow [Recover and troubleshoot](60-recover-and-troubleshoot.md#a-plan-wants-to-create-resources-that-already-exist).

Never apply the foundation from a local shell. Bootstrap changes do not go through Terrateam; see [Update bootstrap later](10-bootstrap-accounts.md#update-bootstrap-later).

Next: [Deploy, release, and roll back applications](50-deploy-and-release-applications.md).
