# Review foundation changes for dev

The merged commit is the foundation version. There is no release ID, foundation tag, or second version field to manage. Terrateam saves a plan for the pull-request commit and refuses to use it after relevant files change.

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

5. Review the entire dev plan. Reject unexpected replacements, deletions, policy changes, a plan for the wrong account, or creation of a named foundation resource that already exists.
6. Merge the pull request after its required checks pass. Terrateam automatically applies the merged revision to dev.
7. Monitor the dev apply. A failed or stale dev layer blocks prod. Follow the recovery output instead of forcing the prod layer.

Do not comment `terrateam apply` during the normal promotion path. Explicit apply commands remain available for recovery and must name the intended environment.

If initialization reports a missing backend or a plan proposes recreating the foundation, stop. Follow [`41-recover-foundation-state.md`](41-recover-foundation-state.md) instead of applying.

Next: [`30-promote-foundation-to-prod.md`](30-promote-foundation-to-prod.md).
