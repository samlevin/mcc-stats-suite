import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import type { S3ObjectReference } from '@mcc/contracts';

const s3 = new S3Client({});

export function evidenceId(): string {
  return `${Date.now().toString(36)}-${randomUUID()}`;
}

export function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function putJson(
  bucket: string,
  key: string,
  value: unknown,
): Promise<S3ObjectReference> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(value),
    ContentType: 'application/json',
  }));
  return { bucket, key };
}

export function now(): string {
  return new Date().toISOString();
}
