# Promote foundation changes to prod

Promote the same unchanged pull-request commit that was applied and validated in dev. The Git commit and Terrateam plan are the immutable promotion artifacts. Do not create or edit a manual foundation release ID.

1. Confirm that the pull request head SHA has not changed since the successful dev apply.
2. Confirm that Terrateam has a successful plan for `infrastructure/prod/foundation` at that SHA. If it does not, comment:

   ```text
   terrateam plan prod and foundation
   ```

3. Review the entire prod plan. Compare its intent with the validated dev plan, while accounting for expected environment-specific names, account IDs, and values.
4. Apply only the prod foundation:

   ```text
   terrateam apply prod and foundation
   ```

5. Validate the production resources, then merge the pull request.

If any commit is added after the dev apply, stop. Re-plan and re-apply dev, validate the new revision, and only then apply prod. If the change is intentionally dev-only, do not manufacture a prod edit; merge after the dev validation.

Do not apply production foundation changes locally.

Next: [`31-release-promote-and-recover-applications.md`](31-release-promote-and-recover-applications.md).
