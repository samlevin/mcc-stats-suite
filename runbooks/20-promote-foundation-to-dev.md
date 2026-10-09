# Apply foundation changes to dev

The pull-request commit is the foundation version. There is no release ID, foundation tag, or second version field to manage. Terrateam saves a plan for that exact commit and refuses to apply a stale plan after the branch changes.

1. Make the foundation change. Put reusable behavior in `infrastructure/modules/foundation`; put a dev-only value in `infrastructure/dev/foundation`.
2. Run the local checks:

   ```console
   npm run tofu:fmt:check
   npm run check
   ```

3. Push the branch and open a pull request.
4. Confirm that Terrateam plans `infrastructure/dev/foundation`. If the automatic plan is missing or stale, comment:

   ```text
   terrateam plan dev and foundation
   ```

5. Review the entire dev plan. Reject unexpected replacements, deletions, policy changes, a plan for the wrong account, or creation of a named foundation resource that already exists. A shared module change may also produce a prod plan; do not apply it yet.
6. Apply only the dev foundation from the pull request:

   ```text
   terrateam apply dev and foundation
   ```

7. Validate the dev resources and any affected application behavior.

Do not add commits after validating dev if this change will continue to prod. A new commit creates a new revision. If the branch changes, plan and apply dev again before promoting that new revision.

If initialization reports a missing backend or a plan proposes recreating the foundation, stop. Follow [`41-recover-foundation-state.md`](41-recover-foundation-state.md) instead of applying.

Next: [`21-deploy-ephemeral-match-to-csv.md`](21-deploy-ephemeral-match-to-csv.md).
