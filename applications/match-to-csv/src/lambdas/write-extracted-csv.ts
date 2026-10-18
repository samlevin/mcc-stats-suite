import { isDeepStrictEqual } from 'node:util';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  CsvRow,
  ExtractTextOutput,
  WriteExtractedCsvOutput,
} from '@mcc/contracts';
import { rowsToCsv } from '../lib/csv';
import { bodyToBuffer, processingRunPrefix } from '../lib/s3';

const s3 = new S3Client({});

export interface WriteExtractedCsvDependencies {
  /** Reads and parses one JSON object, the run's normalized observations. */
  getJson(bucket: string, key: string): Promise<unknown>;
  putObject(
    bucket: string,
    key: string,
    body: string,
    contentType: string,
  ): Promise<void>;
}

const defaultDependencies: WriteExtractedCsvDependencies = {
  async getJson(bucket, key) {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    return JSON.parse(
      (await bodyToBuffer(object.Body)).toString('utf8'),
    ) as unknown;
  },
  async putObject(bucket, key, body, contentType) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        IfNoneMatch: '*',
      }),
    );
  },
};

export async function handler(
  event: ExtractTextOutput,
): Promise<WriteExtractedCsvOutput> {
  return writeExtractedCsv(event, defaultDependencies);
}

/**
 * Writes the run's CSV and structured table. The rows come from `parser.rows`
 * of the run's normalized observations, which carry each row's
 * `playerResolution`; `ExtractTextOutput` rows never do (spec 1.2 §6.2).
 */
export async function writeExtractedCsv(
  event: ExtractTextOutput,
  dependencies: WriteExtractedCsvDependencies,
): Promise<WriteExtractedCsvOutput> {
  const rows = await readParserRows(event, dependencies);
  const prefix = processingRunPrefix(event.source, event.runId);
  const key = `${prefix}/export/extracted.csv`;
  await Promise.all([
    putOnce(
      dependencies,
      event.source.bucket,
      key,
      rowsToCsv(rows),
      'text/csv',
    ),
    putOnce(
      dependencies,
      event.source.bucket,
      `${prefix}/export/extracted-table.json`,
      JSON.stringify({
        schemaVersion: 'extracted-table/v1',
        runId: event.runId,
        roster: event.roster,
        rows,
        normalizedArtifact: event.normalizedArtifact,
      }),
      'application/json',
    ),
  ]);
  return {
    runId: event.runId,
    rowCount: rows.length,
    bucket: event.source.bucket,
    key,
  };
}

/**
 * Reads `parser.rows` from the normalized observations the input names, after
 * checking that they belong to the input's run and roster version.
 */
async function readParserRows(
  event: ExtractTextOutput,
  dependencies: WriteExtractedCsvDependencies,
): Promise<CsvRow[]> {
  const observations = (await dependencies.getJson(
    event.normalizedArtifact.bucket,
    event.normalizedArtifact.key,
  )) as {
    runId?: unknown;
    roster?: unknown;
    parser?: { rows?: unknown };
  } | null;
  if (observations?.runId !== event.runId) {
    throw mismatch('Normalized observations belong to a different run');
  }
  if (!isDeepStrictEqual(observations.roster, event.roster)) {
    throw mismatch(
      'Normalized observations record a different roster reference',
    );
  }
  const rows = observations.parser?.rows;
  if (!Array.isArray(rows)) {
    throw mismatch('Normalized observations hold no parser rows');
  }
  return rows as CsvRow[];
}

function mismatch(message: string): Error {
  const error = new Error(message);
  error.name = 'NormalizedObservationsMismatchError';
  return error;
}

async function putOnce(
  dependencies: WriteExtractedCsvDependencies,
  bucket: string,
  key: string,
  body: string,
  contentType: string,
): Promise<void> {
  try {
    await dependencies.putObject(bucket, key, body, contentType);
  } catch (error) {
    if (isPreconditionFailure(error)) return;
    throw error;
  }
}

function isPreconditionFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    '$metadata' in error &&
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode === 412
  );
}
