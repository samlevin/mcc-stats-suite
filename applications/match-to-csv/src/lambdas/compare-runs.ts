import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { bodyToBuffer } from '../lib/s3';

const s3 = new S3Client({});

interface CompareRunsInput {
  bucket: string;
  baselineKey: string;
  candidateKey: string;
  outputKey: string;
}

interface ComparisonCell {
  tableLocation?: {
    tableIndex?: number;
    rowIndex?: number;
    columnIndex?: number;
  };
  observedText?: string;
  confidence?: number;
}

interface NormalizedRun {
  runId?: string;
  screenshotId?: string;
  cells?: ComparisonCell[];
}

export async function handler(event: CompareRunsInput) {
  validateInput(event);
  const [baseline, candidate] = await Promise.all(
    [event.baselineKey, event.candidateKey].map(async (key) => {
      const object = await s3.send(
        new GetObjectCommand({ Bucket: event.bucket, Key: key }),
      );
      return JSON.parse(
        (await bodyToBuffer(object.Body)).toString('utf8'),
      ) as NormalizedRun;
    }),
  );
  if (
    baseline.screenshotId &&
    candidate.screenshotId &&
    baseline.screenshotId !== candidate.screenshotId
  ) {
    throw new Error('Run comparison requires the same screenshot');
  }

  const result = compareNormalizedRuns(baseline, candidate);
  await s3.send(
    new PutObjectCommand({
      Bucket: event.bucket,
      Key: event.outputKey,
      Body: JSON.stringify(result),
      ContentType: 'application/json',
      IfNoneMatch: '*',
    }),
  );
  return result;
}

export function compareNormalizedRuns(
  baseline: NormalizedRun,
  candidate: NormalizedRun,
) {
  const byCell = (value: NormalizedRun): Map<string, ComparisonCell> =>
    new Map((value.cells ?? []).map((cell) => [cellCoordinate(cell), cell]));
  const before = byCell(baseline);
  const after = byCell(candidate);
  const keys = new Set([...before.keys(), ...after.keys()]);
  const changes = [...keys].flatMap((coordinate) => {
    const left = before.get(coordinate);
    const right = after.get(coordinate);
    const unchanged =
      left?.observedText === right?.observedText &&
      left?.confidence === right?.confidence;
    return unchanged
      ? []
      : [
          {
            coordinate,
            before: left?.observedText,
            after: right?.observedText,
            beforeConfidence: left?.confidence,
            afterConfidence: right?.confidence,
          },
        ];
  });
  return {
    schemaVersion: 'run-comparison/v1',
    screenshotId: baseline.screenshotId ?? candidate.screenshotId,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    comparedAt: new Date().toISOString(),
    summary: {
      baselineCellCount: before.size,
      candidateCellCount: after.size,
      changedCellCount: changes.length,
    },
    changes,
  };
}

function cellCoordinate(cell: ComparisonCell): string {
  return [
    cell.tableLocation?.tableIndex ?? 0,
    cell.tableLocation?.rowIndex ?? 'unknown',
    cell.tableLocation?.columnIndex ?? 'unknown',
  ].join(':');
}

function validateInput(event: CompareRunsInput): void {
  if (!event.bucket) throw new Error('bucket is required');
  for (const [name, key] of [
    ['baselineKey', event.baselineKey],
    ['candidateKey', event.candidateKey],
  ]) {
    if (!key?.endsWith('/normalized/observations.json')) {
      throw new Error(
        `${name} must identify a normalized observation artifact`,
      );
    }
  }
  if (!event.outputKey?.endsWith('.json')) {
    throw new Error('outputKey must identify a JSON object');
  }
  if (
    event.outputKey === event.baselineKey ||
    event.outputKey === event.candidateKey
  ) {
    throw new Error('outputKey cannot overwrite an input artifact');
  }
}
