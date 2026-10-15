import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type {
  ExtractTextOutput,
  WriteExtractedCsvOutput,
} from '@mcc/contracts';
import { rowsToCsv } from '../lib/csv';
import { processingRunPrefix } from '../lib/s3';

const s3 = new S3Client({});

export interface WriteExtractedCsvDependencies {
  putObject(
    bucket: string,
    key: string,
    body: string,
    contentType: string,
  ): Promise<void>;
}

const defaultDependencies: WriteExtractedCsvDependencies = {
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

export async function writeExtractedCsv(
  event: ExtractTextOutput,
  dependencies: WriteExtractedCsvDependencies,
): Promise<WriteExtractedCsvOutput> {
  const prefix = processingRunPrefix(event.source, event.runId);
  const key = `${prefix}/export/extracted.csv`;
  await Promise.all([
    putOnce(
      dependencies,
      event.source.bucket,
      key,
      rowsToCsv(event.rows),
      'text/csv',
    ),
    putOnce(
      dependencies,
      event.source.bucket,
      `${prefix}/export/extracted-table.json`,
      JSON.stringify({
        schemaVersion: 'extracted-table/v1',
        runId: event.runId,
        rows: event.rows,
        normalizedArtifact: event.normalizedArtifact,
      }),
      'application/json',
    ),
  ]);
  return {
    runId: event.runId,
    rowCount: event.rows.length,
    bucket: event.source.bucket,
    key,
  };
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
