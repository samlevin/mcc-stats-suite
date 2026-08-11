import type { WriteExtractedCsvOutput, ExtractTextOutput } from '@mcc/contracts';
import { putJson } from '../lib/evidence';
import { rowsToCsv } from '../lib/csv';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

export async function handler(event: ExtractTextOutput): Promise<WriteExtractedCsvOutput> {
  const prefix = `submissions/${event.source.submissionId}/screenshots/${event.source.screenshotId}/runs/${event.runId}`;
  const key = `${prefix}/export/extracted.csv`;
  await s3.send(new PutObjectCommand({ Bucket: event.source.bucket, Key: key, Body: rowsToCsv(event.rows), ContentType: 'text/csv' }));
  await putJson(event.source.bucket, `${prefix}/export/extracted-table.json`, { schemaVersion: 'extracted-table/v1', runId: event.runId, rows: event.rows, normalizedArtifact: event.normalizedArtifact });
  return { runId: event.runId, rowCount: event.rows.length, bucket: event.source.bucket, key };
}
