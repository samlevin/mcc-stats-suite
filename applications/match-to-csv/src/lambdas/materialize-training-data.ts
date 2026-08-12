import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  DatasetSplit,
  MaterializeTrainingDataInput,
  MaterializeTrainingDataOutput,
  S3ObjectReference,
} from '@mcc/contracts';
import { createHash } from 'node:crypto';
import { bodyToBuffer, namespacedObjectKey } from '../lib/s3';
import { evidenceId, now, putJson } from '../lib/evidence';

const s3 = new S3Client({});
const DEFAULT_SPLIT_SEED = 'ocr-cells-v1';
const MAX_NORMALIZED_ARTIFACTS = 1_000;

interface NormalizedCell {
  cellObservationId: string;
  screenshotId: string;
  tokenObservationIds?: string[];
  [key: string]: unknown;
}

interface NormalizedToken {
  tokenObservationId: string;
  [key: string]: unknown;
}

interface NormalizedArtifact {
  schemaVersion: string;
  runId: string;
  screenshotId: string;
  cells?: NormalizedCell[];
  tokens?: NormalizedToken[];
  validation?: Array<Record<string, unknown> & { cellObservationId: string }>;
}

interface RunManifest {
  schemaVersion?: string;
  versions?: Record<string, string>;
  build?: Record<string, string>;
  inputArtifact?: Record<string, unknown>;
}

interface MaterializedExample {
  schemaVersion: 'ocr-cell-example/v1';
  datasetId: string;
  split: DatasetSplit;
  labelStatus: 'UNLABELED';
  screenshotId: string;
  runId: string;
  cell: NormalizedCell;
  tokens: NormalizedToken[];
  validation?: Record<string, unknown>;
  processingVersions?: Record<string, string>;
  build?: Record<string, string>;
  sourceArtifact?: Record<string, unknown>;
  normalizedArtifact: S3ObjectReference;
}

export async function handler(
  event: MaterializeTrainingDataInput,
): Promise<MaterializeTrainingDataOutput> {
  validateInput(event);
  const datasetId = evidenceId();
  const splitSeed = event.splitSeed?.trim() || DEFAULT_SPLIT_SEED;
  const prefix = namespacedObjectKey(`datasets/${datasetId}`);
  const examples: Record<Lowercase<DatasetSplit>, MaterializedExample[]> = {
    train: [],
    validation: [],
    test: [],
  };
  const sources: Array<{
    normalizedArtifact: S3ObjectReference;
    manifest: S3ObjectReference;
    screenshotId: string;
    runId: string;
    split: DatasetSplit;
    cellCount: number;
  }> = [];

  for (const normalizedKey of [...new Set(event.normalizedKeys)].sort()) {
    const normalizedReference = { bucket: event.bucket, key: normalizedKey };
    const manifestReference = {
      bucket: event.bucket,
      key: manifestKeyForNormalized(normalizedKey),
    };
    const [normalized, manifest] = await Promise.all([
      readJson<NormalizedArtifact>(normalizedReference),
      readJson<RunManifest>(manifestReference),
    ]);
    const split = splitForScreenshot(normalized.screenshotId, splitSeed);
    const materialized = materializeExamples(
      datasetId,
      split,
      normalizedReference,
      normalized,
      manifest,
    );
    examples[split.toLowerCase() as Lowercase<DatasetSplit>].push(
      ...materialized,
    );
    sources.push({
      normalizedArtifact: normalizedReference,
      manifest: manifestReference,
      screenshotId: normalized.screenshotId,
      runId: normalized.runId,
      split,
      cellCount: materialized.length,
    });
  }

  const files = {
    train: { bucket: event.bucket, key: `${prefix}/train.jsonl` },
    validation: { bucket: event.bucket, key: `${prefix}/validation.jsonl` },
    test: { bucket: event.bucket, key: `${prefix}/test.jsonl` },
  };
  await Promise.all(
    (Object.keys(files) as Array<keyof typeof files>).map((split) =>
      writeJsonLines(files[split], examples[split]),
    ),
  );

  const counts = {
    train: examples.train.length,
    validation: examples.validation.length,
    test: examples.test.length,
  };
  const screenshotsBySplit: Record<Lowercase<DatasetSplit>, Set<string>> = {
    train: new Set(),
    validation: new Set(),
    test: new Set(),
  };
  for (const source of sources) {
    screenshotsBySplit[
      source.split.toLowerCase() as Lowercase<DatasetSplit>
    ].add(source.screenshotId);
  }
  const screenshotCounts = {
    train: screenshotsBySplit.train.size,
    validation: screenshotsBySplit.validation.size,
    test: screenshotsBySplit.test.size,
  };
  const manifest = await putJson(event.bucket, `${prefix}/manifest.json`, {
    schemaVersion: 'ocr-cell-dataset/v1',
    datasetId,
    createdAt: now(),
    splitAlgorithm: 'sha256-screenshot-80-10-10-v1',
    splitSeed,
    labelStatus: 'UNLABELED',
    counts,
    screenshotCounts,
    files,
    sources,
  });

  return {
    datasetId,
    bucket: event.bucket,
    prefix,
    manifest,
    files,
    counts,
  };
}

export function splitForScreenshot(
  screenshotId: string,
  splitSeed = DEFAULT_SPLIT_SEED,
): DatasetSplit {
  if (!screenshotId) throw new Error('screenshotId is required');
  const digest = createHash('sha256')
    .update(`${splitSeed}\0${screenshotId}`)
    .digest();
  const bucket = digest.readUInt32BE(0) % 10_000;
  if (bucket < 8_000) return 'TRAIN';
  if (bucket < 9_000) return 'VALIDATION';
  return 'TEST';
}

export function materializeExamples(
  datasetId: string,
  split: DatasetSplit,
  normalizedArtifact: S3ObjectReference,
  normalized: NormalizedArtifact,
  manifest: RunManifest,
): MaterializedExample[] {
  const tokens = new Map(
    (normalized.tokens ?? []).map((token) => [token.tokenObservationId, token]),
  );
  const validations = new Map(
    (normalized.validation ?? []).map((validation) => [
      validation.cellObservationId,
      validation,
    ]),
  );
  return (normalized.cells ?? []).map((cell) => ({
    schemaVersion: 'ocr-cell-example/v1',
    datasetId,
    split,
    labelStatus: 'UNLABELED',
    screenshotId: normalized.screenshotId,
    runId: normalized.runId,
    cell,
    tokens: (cell.tokenObservationIds ?? []).flatMap((id) => {
      const token = tokens.get(id);
      return token ? [token] : [];
    }),
    validation: validations.get(cell.cellObservationId),
    processingVersions: manifest.versions,
    build: manifest.build,
    sourceArtifact: manifest.inputArtifact,
    normalizedArtifact,
  }));
}

export function manifestKeyForNormalized(normalizedKey: string): string {
  const suffix = '/normalized/observations.json';
  if (!normalizedKey.endsWith(suffix)) {
    throw new Error(
      `Normalized artifact key must end with ${suffix}: ${normalizedKey}`,
    );
  }
  return `${normalizedKey.slice(0, -suffix.length)}/manifest.json`;
}

function validateInput(event: MaterializeTrainingDataInput): void {
  if (!event.bucket) throw new Error('bucket is required');
  if (
    !Array.isArray(event.normalizedKeys) ||
    event.normalizedKeys.length === 0
  ) {
    throw new Error('normalizedKeys must contain at least one artifact key');
  }
  if (event.normalizedKeys.length > MAX_NORMALIZED_ARTIFACTS) {
    throw new Error(
      `normalizedKeys cannot contain more than ${MAX_NORMALIZED_ARTIFACTS} keys`,
    );
  }
}

async function readJson<T>(reference: S3ObjectReference): Promise<T> {
  const object = await s3.send(
    new GetObjectCommand({ Bucket: reference.bucket, Key: reference.key }),
  );
  return JSON.parse((await bodyToBuffer(object.Body)).toString('utf8')) as T;
}

async function writeJsonLines(
  reference: S3ObjectReference,
  records: MaterializedExample[],
): Promise<void> {
  const body = records.map((record) => JSON.stringify(record)).join('\n');
  await s3.send(
    new PutObjectCommand({
      Bucket: reference.bucket,
      Key: reference.key,
      Body: body ? `${body}\n` : '',
      ContentType: 'application/x-ndjson',
      IfNoneMatch: '*',
    }),
  );
}
