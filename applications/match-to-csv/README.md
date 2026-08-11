# Match-to-CSV

`match-to-csv` receives email attachments, preserves each screenshot as immutable evidence, and runs Amazon Textract table extraction. One email can contain many screenshots. Each accepted image becomes one `SCREENSHOT` source and one independent processing run.

The package does not create matches, associate screenshots with matches, adjudicate OCR, or train models. It creates the evidence those later features require.

## Pipeline

```text
submit@<domain>
  -> SES receipt rule
  -> raw MIME email in S3
  -> EventBridge and Step Functions
  -> one SourceScreenshot per image attachment
  -> one ProcessingRun per screenshot
  -> raw Textract + normalized observations + extracted CSV
```

The original screenshot is never transformed or replaced. The evidence bucket stores the source metadata and hash, processing manifest, append-only events, Textract request and full response, normalized blocks/tables/cells/tokens, and extracted CSV.

## Deployment

Apply the matching environment foundation before deploying this application. Foundation creates the versioned, KMS-encrypted evidence bucket and publishes its name through SSM.

GitHub Actions deploys the stable environments:

```text
dev:  submit@dev.hhheroes.club
prod: submit@hhheroes.club
```

Local developer stacks are explicit and receive `submit+<name>@dev.hhheroes.club`:

```console
npm run app:deploy -- match-to-csv --environment dev --ephemeral sam
```

`MCC_EMAIL_DOMAIN` must be set locally for a deploy. Production and plain dev deployment are restricted to GitHub Actions.

## Evidence layout

```text
submissions/{submissionId}/
  ingestion.json
  screenshots/{screenshotId}/
    source/original
    source/metadata.json
    runs/{runId}/
      manifest.json
      events/
      textract/request.json
      textract/raw-response.json
      normalized/observations.json
      export/extracted-table.json
      export/extracted.csv
      completion.json
```

The normalized artifact includes generic OCR blocks, tables, cells, tokens, geometry, confidence, provider relationships, parser output, and validation. It maps recognized scoreboard headers to `PLAYER`, `SCORE`, `KILLS`, `ASSISTS`, and `DEATHS`. Unknown layouts remain `UNKNOWN`; no OCR text is silently corrected.

## Replay and comparison

The main state machine processes incoming email. The separate replay state machine accepts one existing source object and creates a new run without changing prior evidence. Start it with this input in Step Functions:

```json
{
  "source": {
    "submissionId": "...",
    "screenshotId": "...",
    "bucket": "<evidence bucket>",
    "key": "submissions/.../screenshots/.../source/original",
    "attachmentName": "scoreboard.png",
    "contentType": "image/png",
    "sha256": "...",
    "acquisitionType": "SCREENSHOT",
    "widthPx": 1920,
    "heightPx": 1080
  }
}
```

The stack output `ReplayStateMachineArn` identifies that workflow. The `RunComparisonFunctionName` output identifies the comparison Lambda. Invoke it with two normalized-artifact keys and a new output key. It writes a cell-level comparison of text and confidence; it does not alter either run.

## Development and tests

```console
npm test --workspace @mcc/match-to-csv
npm run typecheck --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv --environment dev
```

Tests cover parser behavior, fixture extraction, S3 key namespace handling, semantic header mapping, and run comparison. Unit tests do not call AWS. CDK synthesis requires Docker because the package includes native Sharp assets for Linux ARM Lambda.
