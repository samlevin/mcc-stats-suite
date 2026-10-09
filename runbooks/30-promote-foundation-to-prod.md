# Verify foundation promotion to prod

Terrateam promotes the merged revision to prod after its dev layer succeeds. The Git commit and saved plans are the promotion record. Do not create or edit a manual foundation release ID.

1. Confirm that the dev apply succeeded for the merged revision.
2. Monitor the automatically generated prod plan and apply. Autoapply does not pause between them. Compare the output with the reviewed dev plan while accounting for environment-specific names, account IDs, and values.
3. Confirm that Terrateam reports no replacement, deletion, wrong-account operation, or attempt to create an existing named resource. Treat any such operation as an incident and stop later promotions.
4. Validate the production resources.

If the dev layer fails or becomes stale, prod waits. If another foundation change reaches `main`, require the newest revision to complete both layers. Do not force-unlock the earlier run.

Do not apply production foundation changes locally.

If initialization reports a missing backend or a plan proposes recreating the foundation, stop. Follow [`41-recover-foundation-state.md`](41-recover-foundation-state.md) instead of applying.

Next: [`31-release-promote-and-recover-applications.md`](31-release-promote-and-recover-applications.md).
