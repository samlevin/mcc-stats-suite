# Fixture Format

Each `*.fixture.json` file should have:

```json
{
  "name": "short fixture name",
  "blocks": [],
  "rowColors": [],
  "expectedRows": []
}
```

Guidelines:
- Keep fixtures minimal but realistic.
- One fixture should cover one behavior/regression.
- Prefer real OCR outputs that were reduced to the smallest failing case.
- Write `expectedRows` from the screenshot, never by copying parser output.

Run fixtures:

```bash
npm test --workspace @mcc/match-to-csv
```

## Known mismatches

A fixture whose parser output disagrees with its screenshot for a tracked reason has a `knownIssue`:

```json
"knownIssue": { "issue": "#<issue>", "fields": ["player"] }
```

The suite then checks every field except the listed ones, and runs the full comparison as a `todo` test that reports without failing. Remove `knownIssue` when the issue is fixed.

## Flagged misreads

When the parser keeps an OCR misread as read and flags its row for review, the fixture lists it in `misreads`. `expectedRows` still holds the value from the screenshot, plus the row's `reviewFlags`:

```json
"misreads": [{ "field": "player", "expected": "Player05", "read": "PIayer05" }]
```

The suite checks that one expected row holds `expected` and carries a review flag on `field`, replaces the value with `read`, and then compares the parser output with every expected row. A parser flag that `expectedRows` does not list, or a listed flag the parser does not produce, fails the test.

## Placeholder roster

`roster.fixture.json` is not a scoreboard fixture, and the scoreboard suite skips it as one. It holds `name` and `entries`, the roster entries (`gamertagId`, `gamertag`) of the 14 placeholder gamertags in the `halo3-two-team-capture-*` fixtures. The suite runs every scoreboard fixture through `runExtraction` with this roster, checks that names, review flags, and cell text stay as read, and checks the resolutions of both captures against spec 1.2 §9.1.

## Capturing a real screenshot

The `halo3-two-team-capture-*` fixtures come from real Textract responses. Screenshots and raw responses contain real gamertags, so they, and the file that maps real names to placeholders, stay outside the repository. Both scripts refuse paths inside a Git working tree.

1. Capture with dev credentials. The script sends the same `AnalyzeDocument` request as the `ExtractText` Lambda (`FeatureTypes: ['TABLES']`, raw image bytes), computes row colors with the Lambda's `computeRowColors`, and writes `<image name>.capture.json` to the output directory. It deploys nothing and never overwrites a capture.

   ```bash
   cd applications/match-to-csv
   AWS_PROFILE=<dev profile> AWS_REGION=<region> \
     npx tsx scripts/capture-textract.ts <output dir> <image>...
   ```

2. Write a mapping file outside the repository. List every spelling Textract read, which may differ from the real gamertag. Each real gamertag and clan tag gets one placeholder across all fixtures, with the same number of words. Give an OCR misread a placeholder that varies the same way, such as `PIayer05` for a misread of `Player05`.

   ```json
   {
     "names": { "<gamertag as read>": "Player01" },
     "clanTags": { "<clan tag as read, without brackets>": "CLAN1" }
   }
   ```

3. Reduce the capture to a fixture.

   ```bash
   npx tsx scripts/reduce-capture.ts --capture <capture.json> \
     --mapping <mapping.json> --name "<fixture name>" \
     --output test/fixtures/<name>.fixture.json
   ```

   The reducer changes only the text of WORD blocks in each table's player-column data cells. Characters Textract read around a name stay as read, so `IUNSC]` becomes `ICLAN1]`. It keeps the blocks reachable from each `TABLE`, drops `PAGE` and `LINE` blocks and polygons, and copies block IDs, bounding boxes, row and column indexes, relationships, header and numeric text, and row colors unchanged. It fails when a player cell holds text the mapping does not cover, or when a mapped real name remains in the output. Rerunning it keeps the output file's `expectedRows`, `knownIssue`, and `misreads`.

4. Transcribe `expectedRows` from the screenshot, using the placeholders, then run the suite and compare each row with the screenshot. Add `reviewFlags` to each row the parser flags, and list each flagged misread in `misreads`.
