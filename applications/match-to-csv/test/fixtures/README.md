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

Run fixtures:

```bash
npm test --workspace @mcc/match-to-csv
```
