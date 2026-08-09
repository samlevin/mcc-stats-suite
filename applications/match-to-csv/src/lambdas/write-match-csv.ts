import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type {
  WriteMatchCsvInput,
  WriteMatchCsvOutput,
} from '@mcc/contracts';
import { rowsToCsv } from '../lib/csv';
import { log } from '../lib/log';
import { namespacedObjectKey, safeObjectName } from '../lib/s3';

const s3 = new S3Client({});

export async function handler(
  event: WriteMatchCsvInput,
): Promise<WriteMatchCsvOutput> {
  const outputBucket = requiredEnvironment('OUTPUT_BUCKET');
  const rows = event.results.flatMap((result) => result.rows);
  const key = namespacedObjectKey(
    `matches/${safeObjectName(event.matchId)}/summary.csv`,
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: outputBucket,
      Key: key,
      Body: rowsToCsv(rows),
      ContentType: 'text/csv',
    }),
  );

  log('INFO', 'Match CSV written', {
    matchId: event.matchId,
    rowCount: rows.length,
    bucket: outputBucket,
    key,
  });
  return {
    matchId: event.matchId,
    rowCount: rows.length,
    bucket: outputBucket,
    key,
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
