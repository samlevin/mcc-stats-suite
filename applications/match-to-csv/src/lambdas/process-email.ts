import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type {
  MatchAttachment,
  ProcessEmailInput,
  ProcessEmailOutput,
} from '@mcc/contracts';
import { simpleParser } from 'mailparser';
import {
  bodyToBuffer,
  namespacedObjectKey,
  safeObjectName,
} from '../lib/s3';
import { log } from '../lib/log';

const s3 = new S3Client({});

export async function handler(
  event: ProcessEmailInput,
): Promise<ProcessEmailOutput> {
  const attachmentsBucket = requiredEnvironment('ATTACHMENTS_BUCKET');
  log('INFO', 'Processing raw email', {
    bucket: event.bucket,
    key: event.key,
  });

  const object = await s3.send(
    new GetObjectCommand({ Bucket: event.bucket, Key: event.key }),
  );
  const parsed = await simpleParser(await bodyToBuffer(object.Body));
  const matchId = safeObjectName(parsed.messageId ?? object.ETag ?? event.key);
  const attachments: MatchAttachment[] = [];

  for (const [index, attachment] of parsed.attachments.entries()) {
    if (!attachment.contentType.startsWith('image/')) {
      continue;
    }

    const attachmentName = safeObjectName(
      attachment.filename ?? `screenshot-${index + 1}`,
    );
    const key = namespacedObjectKey(
      `matches/${matchId}/attachments/${index + 1}-${attachmentName}`,
    );

    await s3.send(
      new PutObjectCommand({
        Bucket: attachmentsBucket,
        Key: key,
        Body: attachment.content,
        ContentType: attachment.contentType,
      }),
    );

    attachments.push({
      bucket: attachmentsBucket,
      key,
      attachmentName,
      contentType: attachment.contentType,
    });
  }

  log('INFO', 'Raw email processed', {
    matchId,
    attachmentCount: attachments.length,
  });
  return { matchId, attachments };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
