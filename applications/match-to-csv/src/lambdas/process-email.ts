import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type {
  ProcessEmailInput,
  ProcessEmailOutput,
  SourceScreenshot,
} from '@mcc/contracts';
import { simpleParser } from 'mailparser';
import sharp from 'sharp';
import {
  bodyToBuffer,
  namespacedObjectKey,
  safeObjectName,
} from '../lib/s3';
import { log } from '../lib/log';
import { evidenceId, now, putJson, sha256 } from '../lib/evidence';

const s3 = new S3Client({});

export async function handler(
  event: ProcessEmailInput,
): Promise<ProcessEmailOutput> {
  const evidenceBucket = requiredEnvironment('EVIDENCE_BUCKET');
  log('INFO', 'Processing raw email', {
    bucket: event.bucket,
    key: event.key,
  });

  const object = await s3.send(
    new GetObjectCommand({ Bucket: event.bucket, Key: event.key }),
  );
  const parsed = await simpleParser(await bodyToBuffer(object.Body));
  const submissionId = evidenceId();
  const screenshots: SourceScreenshot[] = [];

  await putJson(
    evidenceBucket,
    `submissions/${submissionId}/ingestion.json`,
    {
      schemaVersion: 'email-submission/v1',
      submissionId,
      rawEmail: event,
      messageId: parsed.messageId,
      subject: parsed.subject,
      receivedAt: now(),
    },
  );

  for (const [index, attachment] of parsed.attachments.entries()) {
    if (!attachment.contentType.startsWith('image/')) {
      continue;
    }

    const attachmentName = safeObjectName(
      attachment.filename ?? `screenshot-${index + 1}`,
    );
    const screenshotId = evidenceId();
    const content = Buffer.from(attachment.content);
    const metadata = await sharp(content, { failOn: 'none' }).metadata();
    const key = namespacedObjectKey(
      `submissions/${submissionId}/screenshots/${screenshotId}/source/original`,
    );

    await s3.send(
      new PutObjectCommand({
        Bucket: evidenceBucket,
        Key: key,
        Body: content,
        ContentType: attachment.contentType,
      }),
    );

    const screenshot: SourceScreenshot = {
      screenshotId,
      submissionId,
      bucket: evidenceBucket,
      key,
      attachmentName,
      contentType: attachment.contentType,
      sha256: sha256(content),
      acquisitionType: 'SCREENSHOT',
      widthPx: metadata.width ?? 0,
      heightPx: metadata.height ?? 0,
    };
    await putJson(
      evidenceBucket,
      `submissions/${submissionId}/screenshots/${screenshotId}/source/metadata.json`,
      {
        schemaVersion: 'source-screenshot/v1',
        ...screenshot,
        fileSizeBytes: content.byteLength,
        originalFilename: attachment.filename,
        uploadedAt: now(),
        metadata: {
          format: metadata.format,
          width: metadata.width,
          height: metadata.height,
          space: metadata.space,
          hasAlpha: metadata.hasAlpha,
          orientation: metadata.orientation,
          depth: metadata.depth,
        },
      },
    );
    screenshots.push(screenshot);
  }

  log('INFO', 'Raw email processed', {
    submissionId,
    screenshotCount: screenshots.length,
  });
  return { submissionId, screenshots };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
