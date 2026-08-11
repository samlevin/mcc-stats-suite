# Match-to-CSV

`match-to-csv` receives MIME email through a configured SES receipt rule, preserves screenshot evidence, and runs Amazon Textract table extraction. One message can contain several attachments. Each accepted image becomes one `SCREENSHOT` source and one independent processing run.

The package does not create matches, associate screenshots with matches, adjudicate OCR, or train models. It preserves the observations and metadata required by those later features.

## Pipeline

```text
configured SES recipient
  -> raw MIME email in S3
  -> EventBridge and Step Functions
  -> attachment validation
  -> one SourceScreenshot per accepted image
  -> one ProcessingRun per screenshot
  -> raw Textract response, normalized observations, and extracted CSV
```

The original image is never transformed or replaced. Rejected image attachments are preserved with rejection metadata. Non-image attachments remain available in the retained MIME message.

V1 processing accepts PNG and JPEG images up to 10 MiB with dimensions of at least 640 by 360 pixels. It rejects unreadable images, unsupported formats, oversized images, and small images. A message without a processable screenshot records a rejected submission and fails its workflow execution instead of succeeding without output.

## Deployment

Apply the matching environment foundation before deploying the application. The foundation creates the raw-message bucket, immutable evidence bucket, KMS key, and required SSM parameters.

GitHub Actions deploys stable environments. Its preflight checks verify the target account, CDK bootstrap parameter, foundation parameters, SES identity status, and inbound MX target. The workflow builds native dependencies for Linux ARM64 and inspects both Sharp-using Lambda assets before deployment.

Local developer stacks are explicit:

```console
npm run app:deploy -- match-to-csv --environment dev --ephemeral <name>
```

`MCC_EMAIL_DOMAIN` must be set in ignored local configuration or the selected GitHub Environment. Never put its value in source files or documentation. Production and plain dev deployments are restricted to GitHub Actions on `main`.

## Evidence layout

Stable stacks start at `submissions/`. Ephemeral stacks place the entire tree under `ephemeral/<name>/`.

```text
submissions/{submissionId}/
  ingestion.json
  completion.json
  events/
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

Submission and processing events are append-only. Successful runs record `RUN_STARTED` and `RUN_SUCCEEDED`. Failed runs record `RUN_STARTED`, `RUN_FAILED`, and a failed completion object. The Textract request is written before the provider call so failed invocations retain an unambiguous attempt record.

Processing manifests include the deployed Git commit, deployment environment, source hash, and version of every pipeline stage. Normalized observations retain provider blocks, tables, cells, tokens, geometry, confidence, relationships, parser output, and validation results.

The semantic mapper evaluates each detected table independently. Recognized columns map to `PLAYER`, `SCORE`, `KILLS`, `ASSISTS`, and `DEATHS`, while each cell is identified as a header or data cell. Numeric validation applies only to data cells. Invalid integers and low-confidence values require review. Unknown layouts remain `UNKNOWN`; the pipeline does not silently correct OCR text.

## Replay and comparison

The main state machine handles new messages. The replay state machine accepts an existing `SourceScreenshot` and creates a new processing run without changing prior evidence:

```json
{
  "source": {
    "submissionId": "...",
    "screenshotId": "...",
    "bucket": "...",
    "key": ".../source/original",
    "attachmentName": "scoreboard.png",
    "contentType": "image/png",
    "sha256": "...",
    "acquisitionType": "SCREENSHOT",
    "widthPx": 1920,
    "heightPx": 1080
  }
}
```

The `ReplayStateMachineArn` stack output identifies the replay workflow. The `RunComparisonFunctionName` output identifies the comparison Lambda. Comparison uses table index, row, and column. It reports added cells, removed cells, text changes, and confidence changes without altering either run.

## Training-data materialization

The `TrainingDataMaterializerFunctionName` stack output identifies the materializer Lambda. Invoke it with normalized artifact keys from completed runs:

```json
{
  "bucket": "...",
  "normalizedKeys": [
    ".../normalized/observations.json"
  ],
  "splitSeed": "ocr-cells-v1"
}
```

The materializer writes an immutable dataset under `datasets/{datasetId}/`:

```text
manifest.json
train.jsonl
validation.jsonl
test.jsonl
```

Each JSONL record joins the cell observation, related tokens, validation result, processing versions, build metadata, source artifact, and normalized artifact reference. Records are marked `UNLABELED` until the separate labeling workflow produces ground truth.

The split algorithm hashes the seed and `screenshotId`. Eighty percent of screenshots go to training, ten percent to validation, and ten percent to testing. All cells and all replayed runs for one screenshot always use the same split.

## Development and tests

```console
npm test --workspace @mcc/match-to-csv
npm run typecheck --workspace @mcc/match-to-csv
npm run app:synth -- match-to-csv --environment dev
npm run verify:bundle --workspace @mcc/match-to-csv
```

The test suite enforces minimum statement, branch, line, and function coverage. It covers MIME intake behavior, multiple attachments, rejections, submission events, processing success and failure records, parser behavior, semantic mapping, multiple tables, CSV escaping, comparison behavior, ephemeral paths, materialization joins, and deterministic dataset splits. Tests do not call AWS.

CDK synthesis requires Docker because Sharp is packaged for the Lambda Linux ARM64 runtime. Run the bundle verification after synthesis; it checks the actual generated assets for the native binary.
