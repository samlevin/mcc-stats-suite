# Roster matcher testing

Run from the repository root:

```console
npm test --workspace @mcc/roster
npm run typecheck --workspace @mcc/roster
```

The tests cover the matching key, distance, per-row rule, one-entry-per-game rule and error types of [spec 1.2 §7](../../specs/1.2-gamertag-roster.md#7-matching), the roster fold, hash and change checks of §5.1 and §4.3, and the §9.1 results for the player names read in the `halo3-two-team-capture-*` fixtures. They use the 14 placeholder gamertags and synthetic names, never a real gamertag. Coverage thresholds match `match-to-csv`: the test command fails below 80 percent of lines, 65 percent of branches, or 60 percent of functions.

The package is pure, so the tests need no fakes and never call AWS. Any change to matching behavior also bumps `ROSTER_MATCHER_VERSION`.
