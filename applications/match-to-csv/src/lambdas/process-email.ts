import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  AttachmentRejectionCode,
  ProcessEmailInput,
  ProcessEmailOutput,
  RejectedAttachment,
  S3ObjectReference,
  SourceScreenshot,
} from '@mcc/contracts';
import { simpleParser } from 'mailparser';
import sharp from 'sharp';
import { bodyToBuffer, namespacedObjectKey, safeObjectName } from '../lib/s3';
import { log } from '../lib/log';
import { evidenceId, now, putJson, sha256 } from '../lib/evidence';

const s3 = new S3Client({});
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIN_IMAGE_WIDTH = 640;
const MIN_IMAGE_HEIGHT = 360;

interface ParsedAttachment {
  content: Uint8Array;
  contentType: string;
  filename?: string;
  contentDisposition?: string;
  cid?: string;
}

interface ParsedEmail {
  messageId?: string;
  subject?: string;
  attachments: ParsedAttachment[];
}

interface ImageMetadata {
  format?: string;
  width?: number;
  height?: number;
  space?: string;
  hasAlpha?: boolean;
  orientation?: number;
  depth?: string;
}

export interface ProcessEmailDependencies {
  getRawEmail(input: ProcessEmailInput): Promise<Buffer>;
  parseEmail(rawEmail: Buffer): Promise<ParsedEmail>;
  inspectImage(content: Buffer): Promise<ImageMetadata>;
  putObject(
    reference: S3ObjectReference,
    body: Buffer,
    contentType: string,
  ): Promise<void>;
  writeJson(
    bucket: string,
    key: string,
    value: unknown,
  ): Promise<S3ObjectReference>;
  id(): string;
  timestamp(): string;
}

const defaultDependencies: ProcessEmailDependencies = {
  async getRawEmail(input) {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );
    return bodyToBuffer(object.Body);
  },
  async parseEmail(rawEmail) {
    const parsed = await simpleParser(rawEmail);
    return {
      messageId: parsed.messageId,
      subject: parsed.subject,
      attachments: parsed.attachments,
    };
  },
  async inspectImage(content) {
    return sharp(content, { failOn: 'none' }).metadata();
  },
  async putObject(reference, body, contentType) {
    await s3.send(
      new PutObjectCommand({
        Bucket: reference.bucket,
        Key: reference.key,
        Body: body,
        ContentType: contentType,
        IfNoneMatch: '*',
      }),
    );
  },
  writeJson: putJson,
  id: evidenceId,
  timestamp: now,
};

export async function handler(
  event: ProcessEmailInput,
): Promise<ProcessEmailOutput> {
  return processEmail(event, defaultDependencies);
}

export async function processEmail(
  event: ProcessEmailInput,
  dependencies: ProcessEmailDependencies,
): Promise<ProcessEmailOutput> {
  const evidenceBucket = requiredEnvironment('EVIDENCE_BUCKET');
  log('INFO', 'Processing raw email', {
    bucket: event.bucket,
    key: event.key,
  });

  const parsed = await dependencies.parseEmail(
    await dependencies.getRawEmail(event),
  );
  const submissionId = dependencies.id();
  const submissionPrefix = namespacedObjectKey(`submissions/${submissionId}`);
  const screenshots: SourceScreenshot[] = [];
  const rejectedAttachments: RejectedAttachment[] = [];

  await dependencies.writeJson(
    evidenceBucket,
    `${submissionPrefix}/ingestion.json`,
    {
      schemaVersion: 'email-submission/v1',
      submissionId,
      rawEmail: event,
      messageId: parsed.messageId,
      subject: parsed.subject,
      receivedAt: dependencies.timestamp(),
      attachmentCount: parsed.attachments.length,
    },
  );

  try {
    for (const [index, attachment] of parsed.attachments.entries()) {
      const attachmentName = safeObjectName(
        attachment.filename ?? `attachment-${index + 1}`,
      );
      const content = Buffer.from(attachment.content);

      if (!attachment.contentType.toLowerCase().startsWith('image/')) {
        rejectedAttachments.push({
          attachmentIndex: index,
          attachmentName,
          contentType: attachment.contentType,
          fileSizeBytes: content.byteLength,
          rejectionCodes: ['NOT_AN_IMAGE'],
        });
        continue;
      }

      const screenshotId = dependencies.id();
      const screenshotPrefix = `${submissionPrefix}/screenshots/${screenshotId}`;
      const source: S3ObjectReference = {
        bucket: evidenceBucket,
        key: `${screenshotPrefix}/source/original`,
      };
      await dependencies.putObject(source, content, attachment.contentType);

      let metadata: ImageMetadata = {};
      let metadataError: unknown;
      try {
        metadata = await dependencies.inspectImage(content);
      } catch (error) {
        metadataError = error;
      }

      const rejectionCodes = attachmentRejectionCodes(
        content,
        metadata,
        metadataError,
      );
      const screenshot: SourceScreenshot = {
        screenshotId,
        submissionId,
        ...source,
        attachmentName,
        contentType: attachment.contentType,
        sha256: sha256(content),
        acquisitionType: 'SCREENSHOT',
        widthPx: metadata.width ?? 0,
        heightPx: metadata.height ?? 0,
      };

      await dependencies.writeJson(
        evidenceBucket,
        `${screenshotPrefix}/source/metadata.json`,
        {
          schemaVersion: 'source-screenshot/v1',
          ...screenshot,
          fileSizeBytes: content.byteLength,
          originalFilename: attachment.filename,
          contentDisposition: attachment.contentDisposition,
          contentId: attachment.cid,
          uploadedAt: dependencies.timestamp(),
          processingStatus:
            rejectionCodes.length === 0 ? 'ACCEPTED' : 'REJECTED',
          rejectionCodes,
          metadata,
          metadataError: metadataError
            ? errorSummary(metadataError)
            : undefined,
        },
      );

      if (rejectionCodes.length > 0) {
        rejectedAttachments.push({
          attachmentIndex: index,
          attachmentName,
          contentType: attachment.contentType,
          fileSizeBytes: content.byteLength,
          rejectionCodes,
          source,
        });
      } else {
        screenshots.push(screenshot);
      }
    }

    const completedAt = dependencies.timestamp();
    await dependencies.writeJson(
      evidenceBucket,
      `${submissionPrefix}/completion.json`,
      {
        schemaVersion: 'email-submission-completion/v1',
        submissionId,
        status: screenshots.length > 0 ? 'SUCCEEDED' : 'REJECTED',
        completedAt,
        acceptedScreenshotCount: screenshots.length,
        rejectedAttachments,
      },
    );
    await submissionEvent(
      dependencies,
      evidenceBucket,
      submissionPrefix,
      submissionId,
      screenshots.length > 0 ? 'SUBMISSION_ACCEPTED' : 'SUBMISSION_REJECTED',
      {
        acceptedScreenshotCount: screenshots.length,
        rejectedAttachmentCount: rejectedAttachments.length,
      },
    );

    if (screenshots.length === 0) {
      throw new NoProcessableScreenshotsError();
    }
  } catch (error) {
    if (!(error instanceof NoProcessableScreenshotsError)) {
      const failure = errorSummary(error);
      await Promise.all([
        dependencies.writeJson(
          evidenceBucket,
          `${submissionPrefix}/completion.json`,
          {
            schemaVersion: 'email-submission-completion/v1',
            submissionId,
            status: 'FAILED',
            completedAt: dependencies.timestamp(),
            acceptedScreenshotCount: screenshots.length,
            rejectedAttachments,
            error: failure,
          },
        ),
        submissionEvent(
          dependencies,
          evidenceBucket,
          submissionPrefix,
          submissionId,
          'SUBMISSION_FAILED',
          { error: failure },
        ),
      ]).catch((recordError) => {
        log('ERROR', 'Unable to record submission failure', {
          submissionId,
          error: errorSummary(recordError),
        });
      });
    }
    throw error;
  }

  log('INFO', 'Raw email processed', {
    submissionId,
    screenshotCount: screenshots.length,
    rejectedAttachmentCount: rejectedAttachments.length,
  });
  return { submissionId, screenshots, rejectedAttachments };
}

export function attachmentRejectionCodes(
  content: Buffer,
  metadata: ImageMetadata,
  metadataError?: unknown,
): AttachmentRejectionCode[] {
  const codes: AttachmentRejectionCode[] = [];
  if (metadataError) codes.push('UNREADABLE_IMAGE');
  if (metadata.format && !['png', 'jpeg', 'jpg'].includes(metadata.format)) {
    codes.push('UNSUPPORTED_IMAGE_FORMAT');
  }
  if (content.byteLength > MAX_IMAGE_BYTES) codes.push('IMAGE_TOO_LARGE');
  if (
    metadata.width != null &&
    metadata.height != null &&
    (metadata.width < MIN_IMAGE_WIDTH || metadata.height < MIN_IMAGE_HEIGHT)
  ) {
    codes.push('IMAGE_TOO_SMALL');
  }
  if (!metadataError && !metadata.format) codes.push('UNREADABLE_IMAGE');
  return codes;
}

async function submissionEvent(
  dependencies: ProcessEmailDependencies,
  bucket: string,
  prefix: string,
  submissionId: string,
  type: string,
  detail: unknown,
): Promise<S3ObjectReference> {
  const occurredAt = dependencies.timestamp();
  return dependencies.writeJson(
    bucket,
    `${prefix}/events/${occurredAt}-${dependencies.id()}.json`,
    {
      schemaVersion: 'submission-event/v1',
      submissionId,
      type,
      occurredAt,
      detail,
    },
  );
}

function errorSummary(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'UnknownError', message: String(error) };
}

class NoProcessableScreenshotsError extends Error {
  constructor() {
    super('Email contains no processable screenshot attachments');
    this.name = 'NoProcessableScreenshotsError';
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
